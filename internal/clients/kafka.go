// Package clients implements the data-infrastructure integrations behind
// the Kafka, Cassandra and Oracle tools. Connection details come from the
// UI per request; devtil keeps them only inside the user's local state file.
package clients

import (
	"context"
	"crypto/sha256"
	"crypto/tls"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net"
	"sort"
	"strings"
	"sync"
	"syscall"
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

func (c KafkaConn) newTransport() *kafka.Transport {
	// Producing has to complete a TLS + SASL handshake to the partition
	// leader. The connection timeout is tuned for "fail fast when the broker
	// is unreachable" (1s by default) and is far too tight for that, so give
	// the transport a floor — otherwise every dial attempt is abandoned and
	// the write burns its whole budget retrying.
	dial := c.timeout()
	if dial < 10*time.Second {
		dial = 10 * time.Second
	}
	t := &kafka.Transport{DialTimeout: dial}
	if c.TLS {
		t.TLS = &tls.Config{InsecureSkipVerify: c.Insecure}
	}
	if c.Username != "" {
		t.SASL = plain.Mechanism{Username: c.Username, Password: c.Password}
	}
	return t
}

// A kafka.Transport owns a pool of live broker connections and is designed to
// be long-lived. Building one per send was wrong twice over: every message
// paid a fresh TCP + TLS + SASL handshake, and the old pool was never
// released — kafka.Writer.Close() only closes a transport the writer created
// itself, so a directly-constructed Writer leaves it open. Sockets and their
// goroutines accumulated until sends started timing out, which is exactly the
// "worked for a while, then every produce times out" failure.
//
// Transports are keyed by everything that changes their behaviour, so two
// clusters (or two sets of credentials) never share a pool.
type cachedTransport struct {
	t    *kafka.Transport
	used time.Time
}

var (
	transportMu    sync.Mutex
	transportCache = map[string]*cachedTransport{}
)

// transportIdleTTL drops a pool nobody has produced through for a while, so
// leaving devtil open overnight doesn't hold connections to every cluster the
// developer touched.
const transportIdleTTL = 10 * time.Minute

func (c KafkaConn) transportKey() string {
	// the password is part of the identity but has no business sitting in a
	// map key, so the whole thing is hashed
	sum := sha256.Sum256([]byte(strings.Join([]string{
		strings.Join(c.brokerList(), ","),
		fmt.Sprint(c.TLS), fmt.Sprint(c.Insecure),
		c.Username, c.Password, fmt.Sprint(c.timeout()),
	}, "\x00")))
	return hex.EncodeToString(sum[:])
}

func sharedTransport(c KafkaConn) *kafka.Transport {
	transportMu.Lock()
	defer transportMu.Unlock()
	evictIdleTransportsLocked()
	key := c.transportKey()
	if e, ok := transportCache[key]; ok {
		e.used = time.Now()
		return e.t
	}
	t := c.newTransport()
	transportCache[key] = &cachedTransport{t: t, used: time.Now()}
	return t
}

func evictIdleTransportsLocked() {
	cutoff := time.Now().Add(-transportIdleTTL)
	for k, e := range transportCache {
		if e.used.Before(cutoff) {
			e.t.CloseIdleConnections()
			delete(transportCache, k)
		}
	}
}

// dropTransport closes a cluster's pooled connections and forgets the pool, so
// the next produce dials fresh. Used when a send fails on a connection the
// broker had already hung up on.
func dropTransport(c KafkaConn) {
	transportMu.Lock()
	defer transportMu.Unlock()
	key := c.transportKey()
	if e, ok := transportCache[key]; ok {
		e.t.CloseIdleConnections()
		delete(transportCache, key)
	}
}

// isStaleConn reports whether an error looks like a connection the broker
// closed under us rather than a real rejection. Brokers drop idle connections
// (connections.max.idle.ms, 10 minutes by default), and a pooled connection
// can be dead well before we try to use it — the first write is how we find
// out. These are worth one silent retry; anything else is a genuine failure
// and must be shown to the developer as-is.
func isStaleConn(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) ||
		errors.Is(err, syscall.EPIPE) || errors.Is(err, syscall.ECONNRESET) ||
		errors.Is(err, net.ErrClosed) {
		return true
	}
	s := strings.ToLower(err.Error())
	for _, frag := range []string{
		"broken pipe", "connection reset", "unexpected eof",
		"use of closed network connection", "connection refused",
	} {
		if strings.Contains(s, frag) {
			return true
		}
	}
	return false
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

	// How many messages a search looks through when the request does not say.
	// A search is a scan, so its window has to be about the topic, not about
	// how many results fit on screen: tying it to Last N (×20, so 1000 by
	// default) meant anything older than the newest thousand messages was
	// never even read, and the search reported zero matches.
	kafkaSearchScanDefault = 50000
	kafkaSearchScanMax     = 500000
	kafkaSearchTimeout     = 90 * time.Second
)

type KafkaConsumeRequest struct {
	Conn    KafkaConn `json:"conn"`
	Topic   string    `json:"topic"`
	Max     int       `json:"max"`
	From    string    `json:"from"` // "latest" (default), "beginning", "time"
	StartMs int64     `json:"startMs"`
	EndMs   int64     `json:"endMs"`
	// Search expressions (see kquery.go): a bare word is a substring, and
	// `field:value`, AND/OR/NOT and brackets are all understood.
	KeyQuery   string `json:"keyQuery"`
	ValueQuery string `json:"valueQuery"`
	// ScanMax caps how many messages a search reads across all partitions.
	// Zero means kafkaSearchScanDefault.
	ScanMax int `json:"scanMax"`
}

type KafkaConsumeResponse struct {
	Messages  []KafkaMessage `json:"messages"`
	Scanned   int            `json:"scanned"`
	Matched   int            `json:"matched"`
	Truncated bool           `json:"truncated"` // hit the scan/result cap
	ScanCap   int            `json:"scanCap"`   // how far this read was allowed to look
	// Warning is a partial failure: some partitions could not be read, so
	// the result may be missing messages even though others came back.
	Warning string `json:"warning,omitempty"`
}

// partRead is one partition's contribution to a consume.
type partRead struct {
	msgs      []KafkaMessage
	scanned   int
	matched   int // every match, including ones not kept
	truncated bool
	err       error
	elapsed   time.Duration
}

// readPartitionWindow dials a partition's leader, seeks to the requested
// window and reads up to limit messages, keeping the ones that match the
// key/value filters. It never waits for new messages: reading stops at the
// high watermark, or as soon as a fetch comes back empty.
//
// keep bounds the matches held: the final result is at most that many, so a
// partition never needs more — the newest keep for a "latest" read (older ones
// are dropped as newer arrive), the earliest keep otherwise (and the read stops
// there). Without it a broad search over a deep scan held every match.
func readPartitionWindow(ctx context.Context, dialer *kafka.Dialer, broker string, req KafkaConsumeRequest, partID, limit, keep int, budget time.Duration, keyQ, valQ *Query, emit func(KafkaMessage)) (out partRead) {
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
		// older history exists that this read will not look at; say so, or
		// "0 matches" reads as "not in the topic" when it means "not in the
		// part we searched"
		if start > first {
			out.truncated = true
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
	deadline := time.Now().Add(budget)
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
		var readErr error
		for read < limit {
			m, err := batch.ReadMessage()
			if err != nil {
				readErr = err // batch drained (io.EOF) or a real failure
				break
			}
			inBatch++
			read++
			if req.EndMs > 0 && m.Time.UnixMilli() > req.EndMs {
				done = true // partitions are time-ordered; past the range end
				break
			}
			out.scanned++
			key, value := string(m.Key), string(m.Value)
			var hdrs []KafkaHeader
			for _, h := range m.Headers {
				hdrs = append(hdrs, KafkaHeader{Key: h.Key, Value: string(h.Value)})
			}
			// one MsgFields per message: it caches the parsed JSON, so a query
			// with several field tests decodes the payload once
			fields := MsgFields{Key: key, Value: value, Headers: hdrs}
			if keyQ.Match(&fields) && valQ.Match(&fields) {
				km := KafkaMessage{
					Partition: partID,
					Offset:    m.Offset,
					Time:      m.Time.UTC().Format(time.RFC3339),
					Key:       key,
					Value:     value,
					Headers:   hdrs,
				}
				out.matched++
				if len(out.msgs) < keep && emit != nil {
					// hand it to the caller now, don't wait for the whole read;
					// past keep the final result settles the list instead
					emit(km)
				}
				out.msgs = append(out.msgs, km)
				if len(out.msgs) > keep {
					// latest: only the newest keep can make the cut
					out.msgs = append(out.msgs[:0], out.msgs[len(out.msgs)-keep:]...)
					out.truncated = true
				}
				if len(out.msgs) == keep && req.From != "latest" {
					// forward reads return the earliest matches, so this
					// partition has already contributed all it can
					out.truncated = true
					done = true
					break
				}
			}
			// offsets can be sparse (compaction, transaction markers), so stop
			// on reaching the high watermark rather than counting reads
			if m.Offset >= last-1 {
				done = true
				break
			}
		}
		closeErr := batch.Close()
		if done {
			return out
		}
		if inBatch == 0 {
			// An empty fetch normally means there is no more history here —
			// fetching again would only wait for messages that haven't been
			// produced yet. But a fetch can also come back empty because it
			// failed, and treating that as "end of partition" is how a read
			// returned nothing without a word. Below the high watermark there
			// is more to read, so an empty fetch there is a failure.
			if err := fetchError(readErr, closeErr); err != nil {
				if at, _ := c.Offset(); at < last {
					out.err = fmt.Errorf("partition %d at offset %d: %v", partID, at, err)
					out.truncated = true
				}
			}
			return out
		}
	}
	if read >= limit || ctx.Err() != nil || !time.Now().Before(deadline) {
		out.truncated = true // stopped on a budget, not at the log end
	}
	return out
}

// fetchError picks the error worth reporting from a drained batch: the end of
// a batch (io.EOF) is not one.
func fetchError(errs ...error) error {
	for _, e := range errs {
		if e != nil && !errors.Is(e, io.EOF) {
			return e
		}
	}
	return nil
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
	if req.From == "" {
		req.From = "latest" // the default everywhere, so trim to the newest too
	}
	// The time range belongs to time-range reads only. A tab keeps its end
	// time after switching back to "latest", and applying it there stopped
	// every partition at its first (newer) message: scanned 0, matched 0.
	if req.From != "time" {
		req.StartMs, req.EndMs = 0, 0
	}

	consumeStart := time.Now()
	keyQ, err := ParseQuery(req.KeyQuery, MatchKey)
	if err != nil {
		return nil, fmt.Errorf("key %v", err)
	}
	valQ, err := ParseQuery(req.ValueQuery, MatchValue)
	if err != nil {
		return nil, fmt.Errorf("value %v", err)
	}
	searching := !keyQ.IsEmpty() || !valQ.IsEmpty()
	// A plain read wants Last N messages; a search wants to look through as
	// much of the topic as it reasonably can, and only keep Last N matches.
	scanCap := max
	switch {
	case searching:
		scanCap = req.ScanMax
		if scanCap <= 0 {
			scanCap = kafkaSearchScanDefault
		}
		if scanCap > kafkaSearchScanMax {
			scanCap = kafkaSearchScanMax
		}
		if scanCap < max {
			scanCap = max
		}
	case req.From == "beginning" || req.From == "time":
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
	partBudget := kafkaPartTimeout
	if scanCap > max && opTimeout < 30*time.Second {
		opTimeout = 30 * time.Second
	}
	if searching {
		// a deep scan is mostly reading, not waiting: give each partition
		// the whole budget rather than the 15s meant for slow handshakes
		if opTimeout < kafkaSearchTimeout {
			opTimeout = kafkaSearchTimeout
		}
		partBudget = opTimeout
	}
	ctx, cancel := context.WithTimeout(context.Background(), opTimeout)
	defer cancel()

	logging.Logf("kafka: consume topic=%s from=%s max=%d scanCap=%d keyQ=%q valQ=%q startMs=%d endMs=%d timeout=%s opTimeout=%s",
		req.Topic, req.From, max, scanCap, req.KeyQuery, req.ValueQuery, req.StartMs, req.EndMs, conn.timeout(), opTimeout)

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
			results[idx] = readPartitionWindow(ctx, dialer, brokers[0], req, partID, perPart, max, partBudget, keyQ, valQ, emit)
		}(i, p.ID)
	}
	wg.Wait()

	resp := &KafkaConsumeResponse{Messages: []KafkaMessage{}, ScanCap: scanCap}
	var firstErr error
	var slowest time.Duration
	for _, r := range results {
		if r.elapsed > slowest {
			slowest = r.elapsed
		}
		if r.err != nil && firstErr == nil {
			firstErr = r.err
		}
		// a partition that failed part-way still contributes what it read
		resp.Scanned += r.scanned
		resp.Matched += r.matched
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
		resp.Warning = "some partitions could not be fully read: " + firstErr.Error()
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
	logging.Logf("kafka: consume done — partitions=%d scanned=%d matched=%d returned=%d truncated=%v · lookup=%dms slowestPartition=%dms total=%dms",
		len(parts), resp.Scanned, resp.Matched, len(resp.Messages), resp.Truncated,
		lookupMs, slowest.Milliseconds(), time.Since(consumeStart).Milliseconds())
	return resp, nil
}

// kafkaCheckTopic fails fast when a topic can't be produced to. Auto topic
// creation is off by default, and an unknown topic makes the writer retry the
// metadata lookup until the context expires — which surfaces as a bare
// "context deadline exceeded" with no clue about the real problem.
func kafkaCheckTopic(ctx context.Context, conn KafkaConn, broker, topic string) error {
	c, err := conn.dialer().DialContext(ctx, "tcp", broker)
	if err != nil {
		return fmt.Errorf("kafka: cannot reach broker %s: %v", broker, err)
	}
	defer c.Close()
	parts, err := c.ReadPartitions(topic)
	if err != nil {
		return fmt.Errorf("kafka: topic %q is not available: %v — check the name, or create the topic first", topic, err)
	}
	if len(parts) == 0 {
		return fmt.Errorf("kafka: topic %q has no partitions", topic)
	}
	return nil
}

func KafkaProduce(conn KafkaConn, topic, key, value string, headers []KafkaHeader) error {
	brokers := conn.brokerList()
	if len(brokers) == 0 || strings.TrimSpace(topic) == "" {
		return fmt.Errorf("brokers and a topic are required")
	}

	// Scale the budget with the configured timeout instead of a fixed 15s: on
	// a remote cluster the metadata lookup and leader handshake dominate.
	timeout := conn.opDeadline()
	if timeout < 20*time.Second {
		timeout = 20 * time.Second
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	started := time.Now()
	logging.Logf("kafka: produce topic=%s key=%q bytes=%d headers=%d timeout=%s",
		topic, key, len(value), len(headers), timeout)

	if err := kafkaCheckTopic(ctx, conn, brokers[0], topic); err != nil {
		logging.Logf("kafka: produce pre-check failed: %v", err)
		return err
	}

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

	write := func() error {
		w := &kafka.Writer{
			Addr:  kafka.TCP(brokers...),
			Topic: topic,
			// Hash keeps same-key records on one partition and round-robins
			// keyless ones, which is what a developer sending by hand expects
			Balancer: &kafka.Hash{},
			// the pool is shared and outlives this send — Close() below does
			// not touch it, because the writer did not create it
			Transport: sharedTransport(conn),
			// wait for the leader to acknowledge, so a reported success means the
			// broker really took the record (the zero value acknowledges nothing)
			RequiredAcks: kafka.RequireOne,
			// this is an interactive single-message send: don't sit in the batch
			// window, and surface the real error instead of retrying it away
			BatchTimeout: 10 * time.Millisecond,
			BatchSize:    1,
			MaxAttempts:  3,
		}
		defer w.Close()
		return w.WriteMessages(ctx, msg)
	}

	err := write()
	if isStaleConn(err) {
		// the broker had already closed this pooled connection; drop the pool
		// and dial fresh rather than reporting a hang-up as a failure
		logging.Logf("kafka: produce hit a dead connection (%v) — reconnecting and retrying once", err)
		dropTransport(conn)
		err = write()
	}
	if err != nil {
		logging.Logf("kafka: produce failed after %s: %v", time.Since(started).Round(time.Millisecond), err)
		if errors.Is(err, context.DeadlineExceeded) {
			return fmt.Errorf("kafka: produce timed out after %s — the topic exists, but the write was never acknowledged. "+
				"Usually the broker's advertised listener points at a host this machine can't reach, the partition leader is "+
				"down, or the cluster is refusing writes. Raising the cluster's timeout gives it longer", timeout.Round(time.Second))
		}
		return fmt.Errorf("kafka: %v", err)
	}
	logging.Logf("kafka: produce ok in %s", time.Since(started).Round(time.Millisecond))
	return nil
}
