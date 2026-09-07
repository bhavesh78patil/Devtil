// Package proxy executes HTTP requests on behalf of the API client tool.
// Running requests server-side avoids browser CORS restrictions and lets the
// UI talk to any endpoint the developer's machine can reach.
package proxy

import (
	"crypto/tls"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/http/httptrace"
	"strings"
	"sync"
	"time"

	"github.com/bhavesh78patil/devtil/internal/logging"
)

type Request struct {
	Method    string            `json:"method"`
	URL       string            `json:"url"`
	Headers   map[string]string `json:"headers"`
	Body      string            `json:"body"`
	TimeoutMs int               `json:"timeoutMs"`
	Insecure  bool              `json:"insecure"` // skip TLS verification (dev servers)
}

type Response struct {
	Status     int               `json:"status"`
	StatusText string            `json:"statusText"`
	Headers    map[string]string `json:"headers"`
	Body       string            `json:"body"`
	BodyBase64 bool              `json:"bodyBase64"`
	DurationMs int64             `json:"durationMs"`
	Size       int               `json:"size"`
	Truncated  bool              `json:"truncated"`
	Timing     *Timing           `json:"timing,omitempty"`
}

// Timing breaks a request into the phases people actually ask about when
// something is slow: "is it DNS, the handshake, the server thinking, or the
// download?" Every field is milliseconds spent *in that phase*, not a
// cumulative offset, so they sum to roughly Total.
//
// Phases that did not happen are zero and marked absent: a reused connection
// does no DNS, connect or TLS work, which is itself the answer to "why was
// the second call so much faster".
// Milliseconds are floating point on purpose. A localhost connect takes
// well under a millisecond, and rounding it to "0 ms" makes "too fast to
// measure" indistinguishable from "this phase never happened" — which is
// exactly the distinction someone reading a timing breakdown needs.
type Timing struct {
	DNSMs      float64 `json:"dnsMs"`
	ConnectMs  float64 `json:"connectMs"`
	TLSMs      float64 `json:"tlsMs"`
	SendMs     float64 `json:"sendMs"`     // writing the request
	WaitMs     float64 `json:"waitMs"`     // server thinking: to the first byte
	DownloadMs float64 `json:"downloadMs"` // reading the body
	TotalMs    float64 `json:"totalMs"`

	// Reused reports that an existing keep-alive connection was used, so the
	// setup phases are absent rather than instantaneous.
	Reused bool `json:"reused"`
	// RemoteAddr is the address actually dialled, which answers "did it
	// resolve to the host I expected?".
	RemoteAddr string `json:"remoteAddr,omitempty"`
}

// tracer collects httptrace callbacks. The callbacks fire on whichever
// goroutine the transport happens to be on, so it is mutex-guarded.
type tracer struct {
	mu sync.Mutex

	start                   time.Time
	dnsStart, dnsDone       time.Time
	connStart, connDone     time.Time
	tlsStart, tlsDone       time.Time
	wroteRequest, firstByte time.Time
	reused                  bool
	remoteAddr              string
}

func (t *tracer) trace() *httptrace.ClientTrace {
	return &httptrace.ClientTrace{
		DNSStart: func(httptrace.DNSStartInfo) {
			t.mu.Lock()
			defer t.mu.Unlock()
			t.dnsStart = time.Now()
		},
		DNSDone: func(httptrace.DNSDoneInfo) {
			t.mu.Lock()
			defer t.mu.Unlock()
			t.dnsDone = time.Now()
		},
		ConnectStart: func(string, string) {
			t.mu.Lock()
			defer t.mu.Unlock()
			if t.connStart.IsZero() {
				t.connStart = time.Now()
			}
		},
		ConnectDone: func(_, addr string, _ error) {
			t.mu.Lock()
			defer t.mu.Unlock()
			t.connDone = time.Now()
			t.remoteAddr = addr
		},
		TLSHandshakeStart: func() {
			t.mu.Lock()
			defer t.mu.Unlock()
			t.tlsStart = time.Now()
		},
		TLSHandshakeDone: func(tls.ConnectionState, error) {
			t.mu.Lock()
			defer t.mu.Unlock()
			t.tlsDone = time.Now()
		},
		GotConn: func(info httptrace.GotConnInfo) {
			t.mu.Lock()
			defer t.mu.Unlock()
			t.reused = info.Reused
			if info.Conn != nil && t.remoteAddr == "" {
				t.remoteAddr = info.Conn.RemoteAddr().String()
			}
		},
		WroteRequest: func(httptrace.WroteRequestInfo) {
			t.mu.Lock()
			defer t.mu.Unlock()
			t.wroteRequest = time.Now()
		},
		GotFirstResponseByte: func() {
			t.mu.Lock()
			defer t.mu.Unlock()
			t.firstByte = time.Now()
		},
	}
}

// span is the gap between two trace points in milliseconds, to two decimals,
// or 0 when either end never happened.
func span(from, to time.Time) float64 {
	if from.IsZero() || to.IsZero() || !to.After(from) {
		return 0
	}
	return math.Round(float64(to.Sub(from).Microseconds())/10) / 100
}

// result assembles the phase breakdown. bodyDone is when the body finished
// being read, which the tracer cannot see for itself.
func (t *tracer) result(bodyDone time.Time) *Timing {
	t.mu.Lock()
	defer t.mu.Unlock()

	// the request starts being written once the connection is ready — which
	// is after TLS, after connect, or immediately when the connection was reused
	sendFrom := t.tlsDone
	if sendFrom.IsZero() {
		sendFrom = t.connDone
	}
	if sendFrom.IsZero() {
		sendFrom = t.start
	}
	return &Timing{
		DNSMs:      span(t.dnsStart, t.dnsDone),
		ConnectMs:  span(t.connStart, t.connDone),
		TLSMs:      span(t.tlsStart, t.tlsDone),
		SendMs:     span(sendFrom, t.wroteRequest),
		WaitMs:     span(t.wroteRequest, t.firstByte),
		DownloadMs: span(t.firstByte, bodyDone),
		TotalMs:    span(t.start, bodyDone),
		Reused:     t.reused,
		RemoteAddr: t.remoteAddr,
	}
}

const maxResponseBytes = 10 << 20 // 10 MiB

var allowedMethods = map[string]bool{
	"GET": true, "POST": true, "PUT": true, "PATCH": true,
	"DELETE": true, "HEAD": true, "OPTIONS": true,
}

// Do executes the described request and captures the response.
func Do(pr Request) (*Response, error) {
	method := strings.ToUpper(strings.TrimSpace(pr.Method))
	if method == "" {
		method = "GET"
	}
	if !allowedMethods[method] {
		return nil, fmt.Errorf("unsupported method %q", method)
	}
	if !strings.HasPrefix(pr.URL, "http://") && !strings.HasPrefix(pr.URL, "https://") {
		return nil, errors.New("url must start with http:// or https://")
	}

	timeout := 30 * time.Second
	if pr.TimeoutMs > 0 {
		timeout = time.Duration(pr.TimeoutMs) * time.Millisecond
		if timeout > 5*time.Minute {
			timeout = 5 * time.Minute
		}
	}

	var body io.Reader
	if pr.Body != "" && method != "GET" && method != "HEAD" {
		body = strings.NewReader(pr.Body)
	}
	req, err := http.NewRequest(method, pr.URL, body)
	if err != nil {
		return nil, err
	}
	for k, v := range pr.Headers {
		if k = strings.TrimSpace(k); k != "" {
			req.Header.Set(k, v)
		}
	}
	if req.Header.Get("User-Agent") == "" {
		req.Header.Set("User-Agent", "devtil/1.0")
	}

	transport := http.DefaultTransport.(*http.Transport).Clone()
	if pr.Insecure {
		transport.TLSClientConfig = &tls.Config{InsecureSkipVerify: true}
	}
	client := &http.Client{Timeout: timeout, Transport: transport}

	logURL := *req.URL
	logURL.RawQuery = "" // query strings can carry tokens
	start := time.Now()
	tr := &tracer{start: start}
	req = req.WithContext(httptrace.WithClientTrace(req.Context(), tr.trace()))
	resp, err := client.Do(req)
	if err != nil {
		logging.Logf("proxy: %s %s failed: %v", method, logURL.String(), err)
		return nil, err
	}
	defer resp.Body.Close()
	logging.Logf("proxy: %s %s -> %d (%dms)", method, logURL.String(), resp.StatusCode, time.Since(start).Milliseconds())

	data, err := io.ReadAll(io.LimitReader(resp.Body, maxResponseBytes+1))
	if err != nil {
		return nil, err
	}
	truncated := false
	if len(data) > maxResponseBytes {
		data = data[:maxResponseBytes]
		truncated = true
	}

	headers := make(map[string]string, len(resp.Header))
	for k, vals := range resp.Header {
		headers[k] = strings.Join(vals, ", ")
	}

	bodyDone := time.Now()
	return &Response{
		Status:     resp.StatusCode,
		StatusText: http.StatusText(resp.StatusCode),
		Headers:    headers,
		Body:       string(data),
		DurationMs: bodyDone.Sub(start).Milliseconds(),
		Size:       len(data),
		Truncated:  truncated,
		Timing:     tr.result(bodyDone),
	}, nil
}
