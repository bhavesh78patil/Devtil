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
	Brokers  string `json:"brokers"` // comma-separated host:port list
	TLS      bool   `json:"tls"`
	Insecure bool   `json:"insecure"`
	Username string `json:"username"` // SASL/PLAIN when set
	Password string `json:"password"`
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
	d := &kafka.Dialer{Timeout: 10 * time.Second, DualStack: true}
	if c.TLS {
		d.TLS = &tls.Config{InsecureSkipVerify: c.Insecure}
	}
	if c.Username != "" {
		d.SASLMechanism = plain.Mechanism{Username: c.Username, Password: c.Password}
	}
	return d
}

func (c KafkaConn) transport() *kafka.Transport {
	t := &kafka.Transport{DialTimeout: 10 * time.Second}
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
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	logging.Logf("kafka: list topics via %s", brokers[0])
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

type KafkaMessage struct {
	Partition int    `json:"partition"`
	Offset    int64  `json:"offset"`
	Time      string `json:"time"`
	Key       string `json:"key"`
	Value     string `json:"value"`
}

const maxKafkaMessages = 500

// KafkaTail reads up to max of the most recent messages from every partition
// of a topic and returns them merged in chronological order.
func KafkaTail(conn KafkaConn, topic string, max int) ([]KafkaMessage, error) {
	brokers := conn.brokerList()
	if len(brokers) == 0 || strings.TrimSpace(topic) == "" {
		return nil, fmt.Errorf("brokers and a topic are required")
	}
	if max <= 0 || max > maxKafkaMessages {
		max = 50
	}
	dialer := conn.dialer()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	parts, err := dialer.LookupPartitions(ctx, "tcp", brokers[0], topic)
	if err != nil {
		return nil, fmt.Errorf("kafka: %v", err)
	}

	msgs := []KafkaMessage{}
	for _, p := range parts {
		c, err := dialer.DialLeader(ctx, "tcp", brokers[0], topic, p.ID)
		if err != nil {
			return nil, fmt.Errorf("kafka partition %d: %v", p.ID, err)
		}
		first, last, err := c.ReadOffsets()
		if err != nil {
			c.Close()
			return nil, fmt.Errorf("kafka partition %d: %v", p.ID, err)
		}
		start := last - int64(max)
		if start < first {
			start = first
		}
		if start >= last {
			c.Close()
			continue
		}
		if _, err := c.Seek(start, kafka.SeekAbsolute); err != nil {
			c.Close()
			return nil, fmt.Errorf("kafka partition %d: %v", p.ID, err)
		}
		c.SetReadDeadline(time.Now().Add(15 * time.Second))
		for off := start; off < last; off++ {
			m, err := c.ReadMessage(10 << 20)
			if err != nil {
				break
			}
			msgs = append(msgs, KafkaMessage{
				Partition: p.ID,
				Offset:    m.Offset,
				Time:      m.Time.UTC().Format(time.RFC3339),
				Key:       string(m.Key),
				Value:     string(m.Value),
			})
		}
		c.Close()
	}

	sort.Slice(msgs, func(i, j int) bool {
		if msgs[i].Time != msgs[j].Time {
			return msgs[i].Time < msgs[j].Time
		}
		return msgs[i].Offset < msgs[j].Offset
	})
	if len(msgs) > max {
		msgs = msgs[len(msgs)-max:]
	}
	return msgs, nil
}

func KafkaProduce(conn KafkaConn, topic, key, value string) error {
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
	if err := w.WriteMessages(ctx, msg); err != nil {
		return fmt.Errorf("kafka: %v", err)
	}
	return nil
}
