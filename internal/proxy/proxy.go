// Package proxy executes HTTP requests on behalf of the API client tool.
// Running requests server-side avoids browser CORS restrictions and lets the
// UI talk to any endpoint the developer's machine can reach.
package proxy

import (
	"crypto/tls"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
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

	return &Response{
		Status:     resp.StatusCode,
		StatusText: http.StatusText(resp.StatusCode),
		Headers:    headers,
		Body:       string(data),
		DurationMs: time.Since(start).Milliseconds(),
		Size:       len(data),
		Truncated:  truncated,
	}, nil
}
