package clients

import (
	"net"
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
