package proxy

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// "Why was that slow?" is the question the timing breakdown exists to answer,
// so the phases have to be attributed to the right place rather than merely
// summing to something plausible.

func TestTimingAttributesServerThinkingToWait(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(120 * time.Millisecond) // the server is thinking
		fmt.Fprint(w, "ok")
	}))
	defer srv.Close()

	resp, err := Do(Request{Method: "GET", URL: srv.URL})
	if err != nil {
		t.Fatal(err)
	}
	if resp.Timing == nil {
		t.Fatal("no timing returned")
	}
	if resp.Timing.WaitMs < 100 {
		t.Errorf("WaitMs = %v, want >= 100 — server delay was not attributed to the wait phase: %+v",
			resp.Timing.WaitMs, resp.Timing)
	}
	if resp.Timing.DownloadMs > 60 {
		t.Errorf("DownloadMs = %v for a 2-byte body — the delay leaked into download", resp.Timing.DownloadMs)
	}
	if resp.Timing.TotalMs < resp.Timing.WaitMs {
		t.Errorf("total %v is less than wait %v", resp.Timing.TotalMs, resp.Timing.WaitMs)
	}
}

func TestTimingAttributesASlowBodyToDownload(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(200)
		w.(http.Flusher).Flush() // first byte lands now
		time.Sleep(120 * time.Millisecond)
		fmt.Fprint(w, strings.Repeat("x", 1024))
	}))
	defer srv.Close()

	resp, err := Do(Request{Method: "GET", URL: srv.URL})
	if err != nil {
		t.Fatal(err)
	}
	if resp.Timing.DownloadMs < 100 {
		t.Errorf("DownloadMs = %v, want >= 100 — a slow body should land in download, not wait: %+v",
			resp.Timing.DownloadMs, resp.Timing)
	}
}

// A reused keep-alive connection does no DNS, connect or TLS work. Reporting
// that plainly is the point: it explains why the second call was faster.
func TestTimingReportsAReusedConnection(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, "ok")
	}))
	defer srv.Close()

	first, err := Do(Request{Method: "GET", URL: srv.URL})
	if err != nil {
		t.Fatal(err)
	}
	if first.Timing.Reused {
		t.Error("the first request cannot have reused a connection")
	}
	if first.Timing.ConnectMs < 0 {
		t.Error("negative connect time")
	}
	if first.Timing.RemoteAddr == "" {
		t.Error("the address actually dialled should be reported")
	}
	// Do builds a fresh transport per call, so connections are never pooled
	// across calls — which is worth stating, because it means every timing is
	// a cold one and nobody should read a fast second call as a warm cache.
	second, err := Do(Request{Method: "GET", URL: srv.URL})
	if err != nil {
		t.Fatal(err)
	}
	if second.Timing.Reused {
		t.Error("each Do gets its own transport, so nothing should be reused")
	}
}

func TestTimingOverHTTPSRecordsTheHandshake(t *testing.T) {
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, "ok")
	}))
	defer srv.Close()

	resp, err := Do(Request{Method: "GET", URL: srv.URL, Insecure: true})
	if err != nil {
		t.Fatal(err)
	}
	if resp.Timing.TLSMs <= 0 {
		t.Errorf("TLSMs = %v over https — the handshake should be measured: %+v", resp.Timing.TLSMs, resp.Timing)
	}
	if resp.Timing.ConnectMs <= 0 {
		t.Errorf("ConnectMs = %v — the TCP connect should be measured separately from TLS", resp.Timing.ConnectMs)
	}
}

// The phases must not double-count: TLS time is not also connect time, and
// the pieces should account for the total rather than overshooting it.
func TestTimingPhasesDoNotOverlap(t *testing.T) {
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(40 * time.Millisecond)
		fmt.Fprint(w, strings.Repeat("y", 4096))
	}))
	defer srv.Close()

	resp, err := Do(Request{Method: "GET", URL: srv.URL, Insecure: true})
	if err != nil {
		t.Fatal(err)
	}
	tm := resp.Timing
	sum := tm.DNSMs + tm.ConnectMs + tm.TLSMs + tm.SendMs + tm.WaitMs + tm.DownloadMs
	// rounding to whole milliseconds costs at most one per phase
	if sum > tm.TotalMs+8 {
		t.Errorf("phases sum to %v but total is %v — they overlap: %+v", sum, tm.TotalMs, tm)
	}
}

func TestDoRejectsBadInput(t *testing.T) {
	if _, err := Do(Request{Method: "TRACE", URL: "http://example.invalid"}); err == nil {
		t.Error("TRACE should be rejected")
	}
	if _, err := Do(Request{Method: "GET", URL: "ftp://example.invalid"}); err == nil {
		t.Error("a non-http scheme should be rejected")
	}
	if _, err := Do(Request{Method: "GET", URL: "/relative"}); err == nil {
		t.Error("a relative URL should be rejected")
	}
}
