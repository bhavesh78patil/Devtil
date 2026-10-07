package clients

import (
	"context"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/segmentio/kafka-go"
)

// Runs only against a real broker:
//
//	DEVTIL_KAFKA_BROKERS=localhost:9092 go test ./internal/clients -run Integration
//
// It seeds a fresh multi-partition topic with the kind of payloads people
// actually search, then runs the searches they actually type through the same
// entry point the UI uses.
func TestKafkaSearchIntegration(t *testing.T) {
	brokers := os.Getenv("DEVTIL_KAFKA_BROKERS")
	if brokers == "" {
		t.Skip("set DEVTIL_KAFKA_BROKERS to run against a real broker")
	}
	conn := KafkaConn{Brokers: brokers, TimeoutMs: 5000}
	topic := fmt.Sprintf("devtil-search-%d", time.Now().UnixNano())

	c, err := kafka.Dial("tcp", strings.Split(brokers, ",")[0])
	if err != nil {
		t.Fatal(err)
	}
	ctrl, _ := c.Controller()
	c.Close()
	cc, err := kafka.Dial("tcp", fmt.Sprintf("%s:%d", ctrl.Host, ctrl.Port))
	if err != nil {
		t.Fatal(err)
	}
	if err := cc.CreateTopics(kafka.TopicConfig{Topic: topic, NumPartitions: 6, ReplicationFactor: 1}); err != nil {
		t.Fatal(err)
	}
	cc.Close()

	// 3000 messages; the needle is old, so a tail read alone would miss it
	const total = 3000
	// acknowledged writes, so every message is readable before searching
	w := &kafka.Writer{Addr: kafka.TCP(strings.Split(brokers, ",")...), Topic: topic,
		Balancer: &kafka.RoundRobin{}, BatchSize: 500, RequiredAcks: kafka.RequireAll}
	var msgs []kafka.Message
	for i := 0; i < total; i++ {
		status := "shipped"
		note := "ok"
		if i == 120 {
			status, note = "held", "payment not found"
		}
		msgs = append(msgs, kafka.Message{
			Key: []byte(fmt.Sprintf("order:%d", i)),
			Value: []byte(fmt.Sprintf(`{"orderId":%d,"traceId":1234567890123456%03d,"status":%q,"note":%q,"url":"https://shop/api/o/%d"}`,
				i, i, status, note, i)),
		})
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	for {
		err = w.WriteMessages(ctx, msgs...)
		if err == nil || ctx.Err() != nil {
			break
		}
		time.Sleep(500 * time.Millisecond) // leaders still being elected
	}
	w.Close()
	if err != nil {
		t.Fatal(err)
	}
	if n := topicSize(t, conn, topic); n != total {
		t.Fatalf("seeded %d messages, want %d", n, total)
	}

	run := func(req KafkaConsumeRequest) *KafkaConsumeResponse {
		t.Helper()
		req.Conn, req.Topic = conn, topic
		if req.Max == 0 {
			req.Max = 50
		}
		resp, err := KafkaConsume(req)
		if err != nil {
			t.Fatalf("consume %+v: %v", req, err)
		}
		return resp
	}

	// substring searches for "120" also find 1200-1209, hence 11
	searches := []struct {
		name string
		req  KafkaConsumeRequest
		want int
	}{
		{"value field", KafkaConsumeRequest{ValueQuery: "status:held"}, 1},
		{"pasted JSON fragment", KafkaConsumeRequest{ValueQuery: `"status":"held"`}, 1},
		{"lower-case not is a word, not an operator", KafkaConsumeRequest{ValueQuery: "not found"}, 1},
		{"colon-separated key", KafkaConsumeRequest{KeyQuery: "order:120"}, 11},
		{"exact key", KafkaConsumeRequest{KeyQuery: "key=order:120"}, 1},
		{"64-bit id, exact", KafkaConsumeRequest{ValueQuery: "traceId=1234567890123456120"}, 1},
		{"url with a colon", KafkaConsumeRequest{ValueQuery: "https://shop/api/o/120"}, 11},
		// an end time left behind from an earlier time-range read must not
		// apply once the tab is back on "latest"
		{"stale end time on latest", KafkaConsumeRequest{From: "latest", EndMs: time.Now().Add(-time.Hour).UnixMilli(), ValueQuery: "status:held"}, 1},
		{"from beginning", KafkaConsumeRequest{From: "beginning", ValueQuery: "status:held"}, 1},
	}
	for _, s := range searches {
		t.Run(s.name, func(t *testing.T) {
			resp := run(s.req)
			found := false
			for _, m := range resp.Messages {
				found = found || strings.Contains(m.Value, `"orderId":120,`)
			}
			if !found || len(resp.Messages) != s.want {
				t.Fatalf("want %d message(s) including order 120, got %d (found=%v) after scanning %d (truncated=%v)",
					s.want, len(resp.Messages), found, resp.Scanned, resp.Truncated)
			}
		})
	}

	t.Run("a capped search says it was capped", func(t *testing.T) {
		resp := run(KafkaConsumeRequest{ValueQuery: "status:held", ScanMax: 600})
		if !resp.Truncated || resp.Scanned > 620 {
			t.Fatalf("scanned %d with a 600 cap, truncated=%v", resp.Scanned, resp.Truncated)
		}
	})

	// A broad search holds Max matches, not every match: the newest for a
	// "latest" read (also the default when from is left out), the earliest
	// for a forward read, which can stop as soon as it has them.
	t.Run("a broad search keeps the right Max", func(t *testing.T) {
		for _, tc := range []struct {
			from      string
			wantOrder func(id int) bool
			allCount  bool
		}{
			{"latest", func(id int) bool { return id >= total-60 }, true},
			{"", func(id int) bool { return id >= total-60 }, true},
			{"beginning", func(id int) bool { return id < 60 }, false},
		} {
			resp := run(KafkaConsumeRequest{From: tc.from, ValueQuery: "shipped", Max: 20})
			if len(resp.Messages) != 20 || !resp.Truncated {
				t.Fatalf("from=%q: got %d messages, truncated=%v", tc.from, len(resp.Messages), resp.Truncated)
			}
			if tc.allCount && resp.Matched != total-1 {
				t.Fatalf("from=%q: matched %d, want every match (%d) counted", tc.from, resp.Matched, total-1)
			}
			for _, m := range resp.Messages {
				var id int
				fmt.Sscanf(m.Value, `{"orderId":%d,`, &id)
				if !tc.wantOrder(id) {
					t.Fatalf("from=%q returned orderId %d, from the wrong end of the topic", tc.from, id)
				}
			}
		}
	})

	t.Run("plain tail read", func(t *testing.T) {
		if resp := run(KafkaConsumeRequest{Max: 20}); len(resp.Messages) != 20 {
			t.Fatalf("want 20 messages, got %d", len(resp.Messages))
		}
	})
}

func topicSize(t *testing.T, conn KafkaConn, topic string) int64 {
	t.Helper()
	broker := conn.brokerList()[0]
	parts, err := conn.dialer().LookupPartitions(context.Background(), "tcp", broker, topic)
	if err != nil {
		t.Fatal(err)
	}
	var n int64
	for _, p := range parts {
		c, err := conn.dialer().DialLeader(context.Background(), "tcp", broker, topic, p.ID)
		if err != nil {
			t.Fatal(err)
		}
		first, last, err := c.ReadOffsets()
		c.Close()
		if err != nil {
			t.Fatal(err)
		}
		n += last - first
	}
	return n
}
