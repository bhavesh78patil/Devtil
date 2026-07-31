package server

import (
	"bufio"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// The stream endpoint must speak newline-delimited JSON and flush as it goes,
// finishing with exactly one terminal line. With an unreachable broker that
// terminal line is the error.
func TestKafkaConsumeStreamEmitsNDJSON(t *testing.T) {
	srv := httptest.NewServer((&Server{}).Handler())
	defer srv.Close()

	body := `{"conn":{"brokers":"127.0.0.1:1","timeoutMs":300},"topic":"t","max":5}`
	res, err := http.Post(srv.URL+"/api/kafka/consume/stream", "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()

	if ct := res.Header.Get("Content-Type"); ct != "application/x-ndjson" {
		t.Errorf("Content-Type = %q, want application/x-ndjson", ct)
	}
	var lines []map[string]any
	sc := bufio.NewScanner(res.Body)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" {
			continue
		}
		var m map[string]any
		if err := json.Unmarshal([]byte(line), &m); err != nil {
			t.Fatalf("line is not JSON: %q", line)
		}
		lines = append(lines, m)
	}
	if len(lines) != 1 {
		t.Fatalf("got %d lines, want 1 terminal line: %v", len(lines), lines)
	}
	if lines[0]["type"] != "error" {
		t.Errorf("terminal line type = %v, want error", lines[0]["type"])
	}
	if _, ok := lines[0]["elapsedMs"]; !ok {
		t.Errorf("terminal line is missing elapsedMs: %v", lines[0])
	}
	t.Logf("terminal line: %v", lines[0])
}
