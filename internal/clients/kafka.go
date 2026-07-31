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
	"sync"
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

const (
	maxKafkaMessages = 500

	// Partitions are read concurrently. Each partition needs its own
	// connection to its leader (TCP + TLS + SASL handshake) plus offset
	// lookups; doing that one partition at a time against a remote broker
	// costs seconds each and is what made a 30-partition topic take minutes.
	kafkaPartWorkers = 12

	// Broker-side wait per fetch. A consume only ever reads history up to the
	// high watermark, so a fetch must never sit waiting for new messages.
	// Left at zero, kafka-go infers this from the read deadline (minutes).
	kafkaFetchMaxWait  = 500 * time.Millisecond
	kafkaFetchMaxBytes = 10 << 20

	// Per-partition budget, so one slow or idle partition can't eat the whole
	// request deadline.
	kafkaPartTimeout = 15 * time.Second
)

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

// partRead is one partition's contribution to a consume.
type partRead struct {
	msgs      []KafkaMessage
	scanned   int
	truncated bool
	err       error
	elapsed   time.Duration
}

// readPartitionWindow dials a partition's leader, seeks to the requested
// window and reads up to limit messages, keeping the ones that match the
// key/value filters. It never waits for new messages: reading stops at the
// high watermark, or as soon as a fetch comes back empty.
func readPartitionWindow(ctx context.Context, dialer *kafka.Dialer, broker string, req KafkaConsumeRequest, partID, limit int, keyQ, valQ string, emit func(KafkaMessage)) (out partRead) {
	started := time.Now()
	defer func() { out.elapsed = time.Since(started) }()

	c, err := dialer.DialLeader(ctx, "tcp", broker, req.Topic, partID)
	if err != nil {
		out.err = fmt.Errorf("partition %d: %v", partID, err)
		return out
	}
	defer c.Close()

	first, last, err := c.ReadOffsets()
	if err != nil {
		out.err = fmt.Errorf("partition %d: %v", partID, err)
		return out
	}

	var start int64
	switch req.From {
	case "beginning":
		start = first
	case "time":
		off, e := c.ReadOffset(time.UnixMilli(req.StartMs))
		if e != nil || off < first {
			off = first
		}
		start = off
	default: // latest: the newest `limit` messages of this partition
		start = last - int64(limit)
		if start < first {
			start = first
		}
	}
	if start >= last {
		return out // partition is empty, or the window starts past its end
	}
	if _, err := c.Seek(start, kafka.SeekAbsolute); err != nil {
		out.err = fmt.Errorf("partition %d: %v", partID, err)
		return out
	}

	// Bound this partition's own work instead of inheriting the whole request
	// budget, and keep the read deadline short so kafka-go can never derive a
	// multi-minute fetch wait from it.
	deadline := time.Now().Add(kafkaPartTimeout)
	if d, ok := ctx.Deadline(); ok && d.Before(deadline) {
		deadline = d
	}
	c.SetReadDeadline(deadline)

	read := 0
	for read < limit && ctx.Err() == nil && time.Now().Before(deadline) {
		batch := c.ReadBatchWith(kafka.ReadBatchConfig{
			MinBytes: 1,
			MaxBytes: kafkaFetchMaxBytes,
			MaxWait:  kafkaFetchMaxWait,
		})
		inBatch, done := 0, false
		for read < limit {
			m, err := batch.ReadMessage()
			if err != nil {
				break // batch drained (or a read error) — handled below
			}
			inBatch++
			read++
			if req.EndMs > 0 && m.Time.UnixMilli() > req.EndMs {
				done = true // partitions are time-ordered; past the range end
				break
			}
			out.scanned++
			key, value := string(m.Key), string(m.Value)
			if (keyQ == "" || strings.Contains(strings.ToLower(key), keyQ)) &&
				(valQ == "" || strings.Contains(strings.ToLower(value), valQ)) {
				var hdrs []KafkaHeader
				for _, h := range m.Headers {
					hdrs = append(hdrs, KafkaHeader{Key: h.Key, Value: string(h.Value)})
				}
				km := KafkaMessage{
					Partition: partID,
					Offset:    m.Offset,
					Time:      m.Time.UTC().Format(time.RFC3339),
					Key:       key,
					Value:     value,
					Headers:   hdrs,
				}
				out.msgs = append(out.msgs, km)
				if emit != nil {
					emit(km) // hand it to the caller now, don't wait for the whole read
				}
			}
			// offsets can be sparse (compaction, transaction markers), so stop
			// on reaching the high watermark rather than counting reads
			if m.Offset >= last-1 {
				done = true
				break
			}
		}
		batch.Close()
		// An empty fetch means there is no more history here — fetching again
		// would only wait for messages that haven't been produced yet.
		if done || inBatch == 0 {
			return out
		}
	}
	if read >= limit || ctx.Err() != nil || !time.Now().Before(deadline) {
		out.truncated = true // stopped on a budget, not at the log end
	}
	return out
}

// KafkaConsume reads messages from a topic — from the tail, the beginning,
// or a time range — optionally filtering by key/value substrings, and
// returns up to Max matches merged in chronological order.
func KafkaConsume(req KafkaConsumeRequest) (*KafkaConsumeResponse, error) {
	return KafkaConsumeStream(req, nil)
}

// KafkaConsumeStream is KafkaConsume with an optional callback invoked for
// every matching message as soon as its partition yields it, so callers can
// render results while the read is still running. Partitions are read
// concurrently, so onMessage is called from several goroutines — it is
// serialised here and must not block for long.
//
// Streamed messages arrive in partition order, not globally sorted; the
// returned response still holds the properly sorted and trimmed result.
func KafkaConsumeStream(req KafkaConsumeRequest, onMessage func(KafkaMessage)) (*KafkaConsumeResponse, error) {
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

	consumeStart := time.Now()
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

	lookupStart := time.Now()
	parts, err := dialer.LookupPartitions(ctx, "tcp", brokers[0], req.Topic)
	if err != nil {
		return nil, fmt.Errorf("kafka: %v", err)
	}
	lookupMs := time.Since(lookupStart).Milliseconds()

	// Split the scan budget across partitions so a search covers every
	// partition instead of the first one exhausting the whole global cap.
	perPart := scanCap
	if len(parts) > 1 {
		perPart = scanCap/len(parts) + 1
	}

	// Read the partitions concurrently. The per-partition cost is dominated by
	// the leader handshake and offset lookups, not by reading messages, so
	// serialising them made the whole consume scale with partition count.
	results := make([]partRead, len(parts))
	sem := make(chan struct{}, kafkaPartWorkers)
	var wg sync.WaitGroup
	var emitMu sync.Mutex
	emit := onMessage
	if emit != nil {
		// serialise the callback: partitions run concurrently
		inner := onMessage
		emit = func(m KafkaMessage) {
			emitMu.Lock()
			defer emitMu.Unlock()
			inner(m)
		}
	}
	for i, p := range parts {
		wg.Add(1)
		go func(idx, partID int) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			if ctx.Err() != nil {
				results[idx] = partRead{truncated: true}
				return
			}
			results[idx] = readPartitionWindow(ctx, dialer, brokers[0], req, partID, perPart, keyQ, valQ, emit)
		}(i, p.ID)
	}
	wg.Wait()

	resp := &KafkaConsumeResponse{Messages: []KafkaMessage{}}
	var firstErr error
	var slowest time.Duration
	for _, r := range results {
		if r.elapsed > slowest {
			slowest = r.elapsed
		}
		if r.err != nil {
			if firstErr == nil {
				firstErr = r.err
			}
			continue
		}
		resp.Scanned += r.scanned
		resp.Messages = append(resp.Messages, r.msgs...)
		if r.truncated {
			resp.Truncated = true
		}
	}
	if firstErr != nil {
		// partial failures are worth surfacing, but only fail the whole read
		// when nothing at all came back
		logging.Logf("kafka: consume partition error: %v", firstErr)
		if len(resp.Messages) == 0 && resp.Scanned == 0 {
			return nil, fmt.Errorf("kafka: %v", firstErr)
		}
	}
	resp.Matched = len(resp.Messages)

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
	logging.Logf("kafka: consume done — partitions=%d scanned=%d matched=%d returned=%d truncated=%v · lookup=%dms slowestPartition=%dms total=%dms",
		len(parts), resp.Scanned, resp.Matched, len(resp.Messages), resp.Truncated,
		lookupMs, slowest.Milliseconds(), time.Since(consumeStart).Milliseconds())
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
