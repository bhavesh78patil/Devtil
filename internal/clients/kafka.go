// Package clients implements the data-infrastructure integrations behind
// the Kafka, Cassandra and Oracle tools. Connection details come from the
// UI per request; devtil keeps them only inside the user's local state file.
package clients

import (
	"context"
	"crypto/tls"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/segmentio/kafka-go"
	"github.com/segmentio/kafka-go/sasl/plain"

	"github.com/bhavesh78patil/devtil/internal/logging"
)

type KafkaConn struct {
	Brokers   string `json:"brokers"` // comma-separated host:port list
	TLS       bool   `json:"tls"`
	Insecure  bool   `json:"insecure"`
	Username  string `json:"username"` // SASL/PLAIN when set
	Password  string `json:"password"`
	TimeoutMs int    `json:"timeoutMs"` // dial/read timeout, default 1000
}

// timeout is the per-connection dial/read timeout (default 1000 ms).
func (c KafkaConn) timeout() time.Duration {
	ms := c.TimeoutMs
	if ms <= 0 {
		ms = 1000
	}
	if ms > 120000 {
		ms = 120000
	}
	return time.Duration(ms) * time.Millisecond
}

// opDeadline bounds a whole operation (metadata + reads across partitions).
func (c KafkaConn) opDeadline() time.Duration {
	d := c.timeout() * 5
	if d < 5*time.Second {
		d = 5 * time.Second
	}
	if d > 2*time.Minute {
		d = 2 * time.Minute
	}
	return d
}

func (c KafkaConn) brokerList() []string {
	var out []string
	for _, b := range strings.Split(c.Brokers, ",") {
		if b = strings.TrimSpace(b); b != "" {
			out = append(out, b)
		}
	}
	return out
}

func (c KafkaConn) dialer() *kafka.Dialer {
	d := &kafka.Dialer{Timeout: c.timeout(), DualStack: true}
	if c.TLS {
		d.TLS = &tls.Config{InsecureSkipVerify: c.Insecure}
	}
	if c.Username != "" {
		d.SASLMechanism = plain.Mechanism{Username: c.Username, Password: c.Password}
	}
	return d
}

func (c KafkaConn) transport() *kafka.Transport {
	t := &kafka.Transport{DialTimeout: c.timeout()}
	if c.TLS {
		t.TLS = &tls.Config{InsecureSkipVerify: c.Insecure}
	}
	if c.Username != "" {
		t.SASL = plain.Mechanism{Username: c.Username, Password: c.Password}
	}
	return t
}

type KafkaTopic struct {
	Name       string `json:"name"`
	Partitions int    `json:"partitions"`
}

func KafkaTopics(conn KafkaConn) ([]KafkaTopic, error) {
	brokers := conn.brokerList()
	if len(brokers) == 0 {
		return nil, fmt.Errorf("at least one broker (host:port) is required")
	}
	ctx, cancel := context.WithTimeout(context.Background(), conn.opDeadline())
	defer cancel()

	logging.Logf("kafka: list topics via %s (timeout %s)", brokers[0], conn.timeout())
	c, err := conn.dialer().DialContext(ctx, "tcp", brokers[0])
	if err != nil {
		logging.Logf("kafka: dial %s failed: %v", brokers[0], err)
		return nil, fmt.Errorf("kafka: %v", err)
	}
	defer c.Close()

	parts, err := c.ReadPartitions()
	if err != nil {
		return nil, fmt.Errorf("kafka: %v", err)
	}
	counts := map[string]int{}
	for _, p := range parts {
		if strings.HasPrefix(p.Topic, "__") {
			continue // internal topics
		}
		counts[p.Topic]++
	}
	topics := make([]KafkaTopic, 0, len(counts))
	for name, n := range counts {
		topics = append(topics, KafkaTopic{Name: name, Partitions: n})
	}
	sort.Slice(topics, func(i, j int) bool { return topics[i].Name < topics[j].Name })
	return topics, nil
}

type KafkaHeader struct {
	Key   string `json:"key"`
	Value string `json:"value"`
}

type KafkaMessage struct {
	Partition int           `json:"partition"`
	Offset    int64         `json:"offset"`
	Time      string        `json:"time"`
	Key       string        `json:"key"`
	Value     string        `json:"value"`
	Headers   []KafkaHeader `json:"headers,omitempty"`
}

const maxKafkaMessages = 500

type KafkaConsumeRequest struct {
	Conn       KafkaConn `json:"conn"`
	Topic      string    `json:"topic"`
	Max        int       `json:"max"`
	From       string    `json:"from"` // "latest" (default), "beginning", "time"
	StartMs    int64     `json:"startMs"`
	EndMs      int64     `json:"endMs"`
	KeyQuery   string    `json:"keyQuery"`   // case-insensitive substring
	ValueQuery string    `json:"valueQuery"` // case-insensitive substring
}

type KafkaConsumeResponse struct {
	Messages  []KafkaMessage `json:"messages"`
	Scanned   int            `json:"scanned"`
	Matched   int            `json:"matched"`
	Truncated bool           `json:"truncated"` // hit the scan/result cap
}

// KafkaConsume reads messages from a topic — from the tail, the beginning,
// or a time range — optionally filtering by key/value substrings, and
// returns up to Max matches merged in chronological order.
func KafkaConsume(req KafkaConsumeRequest) (*KafkaConsumeResponse, error) {
	conn := req.Conn
	brokers := conn.brokerList()
	if len(brokers) == 0 || strings.TrimSpace(req.Topic) == "" {
		return nil, fmt.Errorf("brokers and a topic are required")
	}
	max := req.Max
	if max <= 0 || max > maxKafkaMessages {
		max = 50
	}
	if req.From == "time" && req.StartMs <= 0 {
		return nil, fmt.Errorf("a start time is required for time-range reads")
	}

	keyQ := strings.ToLower(strings.TrimSpace(req.KeyQuery))
	valQ := strings.ToLower(strings.TrimSpace(req.ValueQuery))
	// searching or reading forward needs a wider scan window than the
	// result size, so matches aren't limited to the newest few messages
	scanCap := max
	if keyQ != "" || valQ != "" || req.From == "beginning" || req.From == "time" {
		scanCap = max * 20
		if scanCap > 10000 {
			scanCap = 10000
		}
	}

	dialer := conn.dialer()
	// A search (or forward read) scans up to scanCap messages, which takes far
	// longer than a plain tail read — with the short default timeout the old
	// deadline expired mid-scan and searches silently came back empty. Scale
	// the operation deadline with the scan window instead.
	opTimeout := conn.opDeadline()
	if scanCap > max && opTimeout < 30*time.Second {
		opTimeout = 30 * time.Second
	}
	ctx, cancel := context.WithTimeout(context.Background(), opTimeout)
	defer cancel()

	logging.Logf("kafka: consume topic=%s from=%s max=%d scanCap=%d keyQ=%q valQ=%q startMs=%d endMs=%d timeout=%s opTimeout=%s",
		req.Topic, req.From, max, scanCap, keyQ, valQ, req.StartMs, req.EndMs, conn.timeout(), opTimeout)

	parts, err := dialer.LookupPartitions(ctx, "tcp", brokers[0], req.Topic)
	if err != nil {
		return nil, fmt.Errorf("kafka: %v", err)
	}

	// Split the scan budget across partitions so a search covers every
	// partition instead of the first one exhausting the whole global cap.
	perPart := scanCap
	if len(parts) > 1 {
		perPart = scanCap/len(parts) + 1
	}

	resp := &KafkaConsumeResponse{Messages: []KafkaMessage{}}
	for _, p := range parts {
		if resp.Scanned >= scanCap || ctx.Err() != nil {
			resp.Truncated = true
			break
		}
		c, err := dialer.DialLeader(ctx, "tcp", brokers[0], req.Topic, p.ID)
		if err != nil {
			return nil, fmt.Errorf("kafka partition %d: %v", p.ID, err)
		}
		first, last, err := c.ReadOffsets()
		if err != nil {
			c.Close()
			return nil, fmt.Errorf("kafka partition %d: %v", p.ID, err)
		}

		var start int64
		switch req.From {
		case "beginning":
			start = first
		case "time":
			off, err := c.ReadOffset(time.UnixMilli(req.StartMs))
			if err != nil || off < first {
				off = first
			}
			start = off
		default: // latest: window of the newest messages per partition
			start = last - int64(perPart)
			if start < first {
				start = first
			}
		}
		if start >= last {
			c.Close()
			continue
		}
		if _, err := c.Seek(start, kafka.SeekAbsolute); err != nil {
			c.Close()
			return nil, fmt.Errorf("kafka partition %d: %v", p.ID, err)
		}
		if dl, ok := ctx.Deadline(); ok {
			c.SetReadDeadline(dl)
		}

		// Fetch whole batches and filter in memory. Conn.ReadMessage issues a
		// full fetch round-trip per message AND discards the rest of each
		// batch, which made scans (especially searches) painfully slow — one
		// batch fetch here yields hundreds/thousands of messages at once.
		read := 0
	scan:
		for {
			if read >= perPart || resp.Scanned >= scanCap {
				resp.Truncated = true
				break
			}
			batch := c.ReadBatchWith(kafka.ReadBatchConfig{
				MinBytes: 1,
				MaxBytes: 10 << 20,
				MaxWait:  2 * time.Second, // don't hang on the op deadline at the log end
			})
			inBatch := 0
			for {
				if read >= perPart || resp.Scanned >= scanCap {
					resp.Truncated = true
					batch.Close()
					break scan
				}
				m, err := batch.ReadMessage()
				if err != nil {
					batch.Close()
					if ctx.Err() != nil {
						// deadline mid-scan: the search didn't cover everything —
						// surface that instead of silently returning less
						resp.Truncated = true
						break scan
					}
					if inBatch == 0 {
						break scan // no progress: log end (or a real error) — stop this partition
					}
					continue scan // batch exhausted; fetch the next one
				}
				inBatch++
				read++
				if req.EndMs > 0 && m.Time.UnixMilli() > req.EndMs {
					batch.Close()
					break scan // partitions are time-ordered; past the range end
				}
				resp.Scanned++
				key, value := string(m.Key), string(m.Value)
				match := (keyQ == "" || strings.Contains(strings.ToLower(key), keyQ)) &&
					(valQ == "" || strings.Contains(strings.ToLower(value), valQ))
				if match {
					resp.Matched++
					var hdrs []KafkaHeader
					for _, h := range m.Headers {
						hdrs = append(hdrs, KafkaHeader{Key: h.Key, Value: string(h.Value)})
					}
					resp.Messages = append(resp.Messages, KafkaMessage{
						Partition: p.ID,
						Offset:    m.Offset,
						Time:      m.Time.UTC().Format(time.RFC3339),
						Key:       key,
						Value:     value,
						Headers:   hdrs,
					})
				}
				// stop at the log end — offsets can be sparse (compacted
				// topics), so counting on `last-start` reads would block
				if m.Offset >= last-1 {
					batch.Close()
					break scan
				}
			}
		}
		c.Close()
	}

	sort.Slice(resp.Messages, func(i, j int) bool {
		if resp.Messages[i].Time != resp.Messages[j].Time {
			return resp.Messages[i].Time < resp.Messages[j].Time
		}
		return resp.Messages[i].Offset < resp.Messages[j].Offset
	})
	if len(resp.Messages) > max {
		resp.Truncated = true
		if req.From == "latest" {
			resp.Messages = resp.Messages[len(resp.Messages)-max:] // newest
		} else {
			resp.Messages = resp.Messages[:max] // from the range start
		}
	}
	logging.Logf("kafka: consume done — scanned=%d matched=%d returned=%d truncated=%v",
		resp.Scanned, resp.Matched, len(resp.Messages), resp.Truncated)
	return resp, nil
}

func KafkaProduce(conn KafkaConn, topic, key, value string, headers []KafkaHeader) error {
	brokers := conn.brokerList()
	if len(brokers) == 0 || strings.TrimSpace(topic) == "" {
		return fmt.Errorf("brokers and a topic are required")
	}
	w := &kafka.Writer{
		Addr:      kafka.TCP(brokers...),
		Topic:     topic,
		Balancer:  &kafka.Hash{},
		Transport: conn.transport(),
	}
	defer w.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	msg := kafka.Message{Value: []byte(value)}
	if key != "" {
		msg.Key = []byte(key)
	}
	for _, h := range headers {
		if strings.TrimSpace(h.Key) == "" {
			continue
		}
		msg.Headers = append(msg.Headers, kafka.Header{Key: h.Key, Value: []byte(h.Value)})
	}
	if err := w.WriteMessages(ctx, msg); err != nil {
		return fmt.Errorf("kafka: %v", err)
	}
	return nil
}
