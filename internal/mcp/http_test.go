package mcp

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func httpServer(t *testing.T, opt Options) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(NewHTTPServer(opt).Handler())
	t.Cleanup(srv.Close)
	return srv
}

// post sends one JSON-RPC message the way a Streamable HTTP client does.
func post(t *testing.T, srv *httptest.Server, sessionID string, msg any) (*http.Response, map[string]any) {
	t.Helper()
	body, err := json.Marshal(msg)
	if err != nil {
		t.Fatal(err)
	}
	req, err := http.NewRequest("POST", srv.URL, bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	if sessionID != "" {
		req.Header.Set(sessionHeader, sessionID)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := io.ReadAll(res.Body)
	res.Body.Close()
	var decoded map[string]any
	if len(bytes.TrimSpace(raw)) > 0 {
		if err := json.Unmarshal(raw, &decoded); err != nil {
			t.Fatalf("response is not a JSON object: %q", raw)
		}
	}
	return res, decoded
}

func TestHTTPInitializeIssuesSession(t *testing.T) {
	srv := httpServer(t, Options{})
	res, reply := post(t, srv, "", map[string]any{
		"jsonrpc": "2.0", "id": 1, "method": "initialize",
		"params": map[string]any{"protocolVersion": ProtocolVersion},
	})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status = %d", res.StatusCode)
	}
	sid := res.Header.Get(sessionHeader)
	if sid == "" {
		t.Fatal("initialize must hand back a session id")
	}
	if got := res.Header.Get("Content-Type"); !strings.Contains(got, "application/json") {
		t.Errorf("Content-Type = %q", got)
	}
	result := reply["result"].(map[string]any)
	if result["protocolVersion"] != ProtocolVersion {
		t.Errorf("protocolVersion = %v", result["protocolVersion"])
	}

	// The issued session must be accepted on the next call.
	res, reply = post(t, srv, sid, map[string]any{"jsonrpc": "2.0", "id": 2, "method": "tools/list"})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("tools/list with a valid session: status = %d", res.StatusCode)
	}
	tools := reply["result"].(map[string]any)["tools"].([]any)
	if len(tools) < 20 {
		t.Errorf("got %d tools over HTTP", len(tools))
	}
}

// A session the server has forgotten must be reported so the client knows to
// start a new one rather than retrying against a dead handle.
func TestHTTPUnknownSessionIs404(t *testing.T) {
	srv := httpServer(t, Options{})
	res, _ := post(t, srv, "not-a-real-session", map[string]any{"jsonrpc": "2.0", "id": 1, "method": "ping"})
	if res.StatusCode != http.StatusNotFound {
		t.Errorf("status = %d, want 404", res.StatusCode)
	}
}

func TestHTTPToolCall(t *testing.T) {
	srv := httpServer(t, Options{OKFDir: t.TempDir()})
	_, reply := post(t, srv, "", map[string]any{
		"jsonrpc": "2.0", "id": 1, "method": "tools/call",
		"params": map[string]any{"name": "base64", "arguments": map[string]any{"text": "hi"}},
	})
	res := reply["result"].(map[string]any)
	text := res["content"].([]any)[0].(map[string]any)["text"].(string)
	if text != "aGk=" {
		t.Errorf("base64 over HTTP = %q", text)
	}
}

// Notifications carry no id and get an empty 202, never a JSON-RPC reply.
func TestHTTPNotificationIsAccepted(t *testing.T) {
	srv := httpServer(t, Options{})
	res, reply := post(t, srv, "", map[string]any{"jsonrpc": "2.0", "method": "notifications/initialized"})
	if res.StatusCode != http.StatusAccepted {
		t.Errorf("status = %d, want 202", res.StatusCode)
	}
	if len(reply) != 0 {
		t.Errorf("a notification must not produce a body, got %#v", reply)
	}
}

// Older clients still send JSON-RPC arrays; the reply shape has to match.
func TestHTTPBatch(t *testing.T) {
	srv := httpServer(t, Options{})
	body, _ := json.Marshal([]any{
		map[string]any{"jsonrpc": "2.0", "id": 1, "method": "ping"},
		map[string]any{"jsonrpc": "2.0", "method": "notifications/initialized"},
		map[string]any{"jsonrpc": "2.0", "id": 2, "method": "ping"},
	})
	req, _ := http.NewRequest("POST", srv.URL, bytes.NewReader(body))
	req.Header.Set("Accept", "application/json")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	var replies []map[string]any
	if err := json.NewDecoder(res.Body).Decode(&replies); err != nil {
		t.Fatalf("a batch must be answered with an array: %v", err)
	}
	if len(replies) != 2 {
		t.Errorf("got %d replies, want 2 (the notification answers nothing)", len(replies))
	}
}

// DNS-rebinding protection: a page on the internet must not be able to drive
// the developer's tools just because their browser can reach localhost.
func TestHTTPOriginIsChecked(t *testing.T) {
	srv := httpServer(t, Options{})
	send := func(origin string) int {
		body, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 1, "method": "ping"})
		req, _ := http.NewRequest("POST", srv.URL, bytes.NewReader(body))
		req.Header.Set("Accept", "application/json")
		if origin != "" {
			req.Header.Set("Origin", origin)
		}
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		return res.StatusCode
	}
	for _, ok := range []string{"", "http://localhost:8347", "http://127.0.0.1:8347", "file://"} {
		if got := send(ok); got != http.StatusOK {
			t.Errorf("origin %q was rejected (%d) but should be allowed", ok, got)
		}
	}
	for _, bad := range []string{"https://evil.example.com", "http://attacker.test", "null"} {
		if got := send(bad); got != http.StatusForbidden {
			t.Errorf("origin %q returned %d, want 403", bad, got)
		}
	}
}

func TestHTTPMethodsAndTermination(t *testing.T) {
	srv := httpServer(t, Options{})
	// GET without an SSE Accept is not a stream request.
	res, err := http.Get(srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusMethodNotAllowed {
		t.Errorf("plain GET = %d, want 405", res.StatusCode)
	}

	// DELETE terminates a session.
	_, reply := post(t, srv, "", map[string]any{"jsonrpc": "2.0", "id": 1, "method": "initialize"})
	_ = reply
	req, _ := http.NewRequest("DELETE", srv.URL, nil)
	res, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusNoContent {
		t.Errorf("DELETE = %d, want 204", res.StatusCode)
	}

	req, _ = http.NewRequest("PUT", srv.URL, nil)
	res, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusMethodNotAllowed {
		t.Errorf("PUT = %d, want 405", res.StatusCode)
	}
}

func TestHTTPMalformedBody(t *testing.T) {
	srv := httpServer(t, Options{})
	req, _ := http.NewRequest("POST", srv.URL, strings.NewReader("{not json"))
	req.Header.Set("Accept", "application/json")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", res.StatusCode)
	}
	var reply map[string]any
	if err := json.NewDecoder(res.Body).Decode(&reply); err != nil {
		t.Fatalf("the error reply is itself invalid JSON: %v", err)
	}
	if reply["error"].(map[string]any)["code"].(float64) != codeParse {
		t.Errorf("want a parse error, got %#v", reply)
	}
}
