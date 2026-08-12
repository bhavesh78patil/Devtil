package clients

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"syscall"
	"testing"
	"time"
)

// A consume against a broker that accepts connections but never answers must
// fail fast on the configured timeout instead of hanging until the whole
// operation deadline (which is minutes). This guards the regression where a
// fetch inherited a multi-minute wait from the read deadline.
func TestKafkaConsumeDoesNotHangOnDeadBroker(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	// accept and hold connections open, never replying
	done := make(chan struct{})
	defer close(done)
	go func() {
		var held []net.Conn
		defer func() {
			for _, c := range held {
				c.Close()
			}
		}()
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			held = append(held, c)
			select {
			case <-done:
				return
			default:
			}
		}
	}()

	req := KafkaConsumeRequest{
		Conn:  KafkaConn{Brokers: ln.Addr().String(), TimeoutMs: 1000},
		Topic: "some-topic",
		Max:   50,
	}
	start := time.Now()
	_, err = KafkaConsume(req)
	elapsed := time.Since(start)

	if err == nil {
		t.Fatal("expected an error from a broker that never replies")
	}
	// opDeadline for a 1s timeout is 5s; the metadata lookup must give up on
	// the dialer timeout well before that, and nowhere near the 2 minute cap.
	if elapsed > 15*time.Second {
		t.Fatalf("consume took %s — it should fail fast, not hang", elapsed)
	}
	t.Logf("failed fast in %s: %v", elapsed, err)
}

// Building a kafka.Transport per send leaked its connection pool: a Writer
// constructed directly (rather than by NewWriter) does not close a transport
// it was handed, so every produce left one behind. Sockets accumulated until
// sends started timing out.
func TestTransportIsSharedPerConnection(t *testing.T) {
	t.Cleanup(resetTransportCache)
	resetTransportCache()

	a := KafkaConn{Brokers: "b1:9092,b2:9092", TimeoutMs: 2000}
	first := sharedTransport(a)
	if first == nil {
		t.Fatal("no transport")
	}
	for i := 0; i < 50; i++ {
		if got := sharedTransport(a); got != first {
			t.Fatalf("produce %d built a new transport; the pool is being leaked", i)
		}
	}
	if n := transportCacheLen(); n != 1 {
		t.Errorf("cache holds %d transports, want 1", n)
	}
}

// Two clusters — or the same cluster with different credentials — must never
// share a pool, or one would authenticate as the other.
func TestTransportsAreKeyedByIdentity(t *testing.T) {
	t.Cleanup(resetTransportCache)
	resetTransportCache()

	base := KafkaConn{Brokers: "b1:9092", TimeoutMs: 2000}
	variants := []struct {
		name string
		conn KafkaConn
	}{
		{"different brokers", KafkaConn{Brokers: "b2:9092", TimeoutMs: 2000}},
		{"TLS on", KafkaConn{Brokers: "b1:9092", TimeoutMs: 2000, TLS: true}},
		{"insecure", KafkaConn{Brokers: "b1:9092", TimeoutMs: 2000, TLS: true, Insecure: true}},
		{"a username", KafkaConn{Brokers: "b1:9092", TimeoutMs: 2000, Username: "u"}},
		{"a different password", KafkaConn{Brokers: "b1:9092", TimeoutMs: 2000, Username: "u", Password: "p"}},
		{"a different timeout", KafkaConn{Brokers: "b1:9092", TimeoutMs: 9000}},
	}
	baseT := sharedTransport(base)
	for _, v := range variants {
		if got := sharedTransport(v.conn); got == baseT {
			t.Errorf("%s reused the base transport", v.name)
		}
	}
	// broker order and spacing are formatting, not identity
	same := KafkaConn{Brokers: " b1:9092 ", TimeoutMs: 2000}
	if sharedTransport(same) != baseT {
		t.Error("whitespace around a broker should not create a second pool")
	}
}

func TestDropTransportForcesAFreshPool(t *testing.T) {
	t.Cleanup(resetTransportCache)
	resetTransportCache()

	c := KafkaConn{Brokers: "b1:9092", TimeoutMs: 2000}
	first := sharedTransport(c)
	dropTransport(c)
	if transportCacheLen() != 0 {
		t.Fatal("dropTransport should have emptied the cache")
	}
	if sharedTransport(c) == first {
		t.Error("after a drop the next produce must dial a fresh pool")
	}
	// dropping something that was never cached is harmless
	dropTransport(KafkaConn{Brokers: "nope:9092"})
}

func TestIdleTransportsAreEvicted(t *testing.T) {
	t.Cleanup(resetTransportCache)
	resetTransportCache()

	c := KafkaConn{Brokers: "b1:9092", TimeoutMs: 2000}
	first := sharedTransport(c)
	// age the entry past the TTL, as leaving devtil open overnight would
	transportMu.Lock()
	for _, e := range transportCache {
		e.used = time.Now().Add(-transportIdleTTL - time.Minute)
	}
	transportMu.Unlock()

	if got := sharedTransport(c); got == first {
		t.Error("an idle pool should have been evicted and re-dialled")
	}
	if n := transportCacheLen(); n != 1 {
		t.Errorf("cache holds %d transports after eviction, want 1", n)
	}
}

// Only a hang-up is worth retrying. Retrying a genuine rejection would hide
// the real error behind a second identical failure.
func TestIsStaleConn(t *testing.T) {
	stale := []error{
		io.EOF,
		io.ErrUnexpectedEOF,
		syscall.EPIPE,
		syscall.ECONNRESET,
		net.ErrClosed,
		errors.New("write tcp 10.0.0.1:5 -> 10.0.0.2:9092: broken pipe"),
		errors.New("read: connection reset by peer"),
		fmt.Errorf("wrapped: %w", io.EOF),
	}
	for _, err := range stale {
		if !isStaleConn(err) {
			t.Errorf("isStaleConn(%v) = false, want true", err)
		}
	}
	fatal := []error{
		nil,
		context.DeadlineExceeded,
		errors.New("[3] Unknown Topic Or Partition"),
		errors.New("[58] Not Enough Replicas"),
		errors.New("SASL Authentication failed"),
		errors.New("Message Size Too Large"),
	}
	for _, err := range fatal {
		if isStaleConn(err) {
			t.Errorf("isStaleConn(%v) = true, want false", err)
		}
	}
}

func resetTransportCache() {
	transportMu.Lock()
	defer transportMu.Unlock()
	for k, e := range transportCache {
		e.t.CloseIdleConnections()
		delete(transportCache, k)
	}
}

func transportCacheLen() int {
	transportMu.Lock()
	defer transportMu.Unlock()
	return len(transportCache)
}
