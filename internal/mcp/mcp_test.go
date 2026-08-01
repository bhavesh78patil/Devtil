package mcp

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
)

// session drives a server the way an agent host does: newline-delimited
// JSON-RPC in, one response line out.
type session struct {
	t   *testing.T
	srv *Server
	out *bytes.Buffer
	id  int
}

func newSession(t *testing.T, opt Options) *session {
	t.Helper()
	out := &bytes.Buffer{}
	return &session{t: t, out: out, srv: NewServer(strings.NewReader(""), out, opt)}
}

// send runs one request through the dispatcher and returns the decoded reply.
func (s *session) send(method string, params any) map[string]any {
	s.t.Helper()
	s.id++
	msg := map[string]any{"jsonrpc": "2.0", "id": s.id, "method": method}
	if params != nil {
		msg["params"] = params
	}
	line, err := json.Marshal(msg)
	if err != nil {
		s.t.Fatal(err)
	}
	before := s.out.Len()
	s.srv.handleLine(line)
	raw := s.out.Bytes()[before:]
	if len(raw) == 0 {
		s.t.Fatalf("%s produced no response", method)
	}
	var reply map[string]any
	if err := json.Unmarshal(bytes.TrimSpace(raw), &reply); err != nil {
		s.t.Fatalf("%s produced invalid JSON %q: %v", method, raw, err)
	}
	return reply
}

// call invokes a tool and returns its text content plus whether it errored.
func (s *session) call(name string, args map[string]any) (string, bool) {
	s.t.Helper()
	reply := s.send("tools/call", map[string]any{"name": name, "arguments": args})
	if e, ok := reply["error"]; ok {
		s.t.Fatalf("%s returned a protocol error: %v", name, e)
	}
	res, ok := reply["result"].(map[string]any)
	if !ok {
		s.t.Fatalf("%s returned no result: %#v", name, reply)
	}
	var text strings.Builder
	for _, c := range res["content"].([]any) {
		text.WriteString(c.(map[string]any)["text"].(string))
	}
	isErr, _ := res["isError"].(bool)
	return text.String(), isErr
}

func (s *session) mustCall(name string, args map[string]any) string {
	s.t.Helper()
	text, isErr := s.call(name, args)
	if isErr {
		s.t.Fatalf("%s failed: %s", name, text)
	}
	return text
}

func TestInitializeHandshake(t *testing.T) {
	s := newSession(t, Options{})
	reply := s.send("initialize", map[string]any{
		"protocolVersion": ProtocolVersion,
		"clientInfo":      map[string]any{"name": "test", "version": "1"},
	})
	res := reply["result"].(map[string]any)
	if res["protocolVersion"] != ProtocolVersion {
		t.Errorf("protocolVersion = %v", res["protocolVersion"])
	}
	info := res["serverInfo"].(map[string]any)
	if info["name"] != ServerName {
		t.Errorf("serverInfo.name = %v", info["name"])
	}
	if _, ok := res["capabilities"].(map[string]any)["tools"]; !ok {
		t.Error("server must advertise the tools capability")
	}
	if _, ok := res["instructions"].(string); !ok {
		t.Error("server should send usage instructions")
	}
}

// A host that speaks an older revision must get that revision back, not ours.
func TestInitializeNegotiatesVersion(t *testing.T) {
	s := newSession(t, Options{})
	res := s.send("initialize", map[string]any{"protocolVersion": "2024-11-05"})["result"].(map[string]any)
	if res["protocolVersion"] != "2024-11-05" {
		t.Errorf("got %v, want the client's version echoed back", res["protocolVersion"])
	}
	// An unknown revision falls back to ours rather than agreeing to nonsense.
	res = s.send("initialize", map[string]any{"protocolVersion": "1999-01-01"})["result"].(map[string]any)
	if res["protocolVersion"] != ProtocolVersion {
		t.Errorf("got %v, want %s", res["protocolVersion"], ProtocolVersion)
	}
}

func TestToolsListIsWellFormed(t *testing.T) {
	s := newSession(t, Options{})
	res := s.send("tools/list", nil)["result"].(map[string]any)
	tools := res["tools"].([]any)
	if len(tools) < 20 {
		t.Fatalf("only %d tools registered", len(tools))
	}
	seen := map[string]bool{}
	for _, item := range tools {
		tool := item.(map[string]any)
		name, _ := tool["name"].(string)
		if name == "" {
			t.Fatalf("a tool has no name: %#v", tool)
		}
		if seen[name] {
			t.Errorf("duplicate tool %q", name)
		}
		seen[name] = true
		if d, _ := tool["description"].(string); strings.TrimSpace(d) == "" {
			t.Errorf("%s has no description — a model cannot choose it", name)
		}
		schema, ok := tool["inputSchema"].(map[string]any)
		if !ok || schema["type"] != "object" {
			t.Errorf("%s has no object inputSchema: %#v", name, tool["inputSchema"])
			continue
		}
		// Every declared required argument must exist in properties,
		// otherwise a strict host rejects the call before it reaches us.
		props, _ := schema["properties"].(map[string]any)
		for _, r := range toStrings(schema["required"]) {
			if _, ok := props[r]; !ok {
				t.Errorf("%s requires %q but does not declare it", name, r)
			}
		}
	}
	for _, want := range []string{"json_format", "jsonpath_query", "http_request", "kafka_consume", "db_query", "okf_write", "okf_graph"} {
		if !seen[want] {
			t.Errorf("expected tool %q to be registered", want)
		}
	}
}

func toStrings(v any) []string {
	list, ok := v.([]any)
	if !ok {
		return nil
	}
	out := make([]string, 0, len(list))
	for _, item := range list {
		if s, ok := item.(string); ok {
			out = append(out, s)
		}
	}
	return out
}

// Read-only tools are the ones a host may auto-approve, so the annotation has
// to be right: nothing that writes to real infrastructure may claim it.
func TestReadOnlyAnnotations(t *testing.T) {
	s := newSession(t, Options{})
	res := s.send("tools/list", nil)["result"].(map[string]any)
	readOnly := map[string]bool{}
	for _, item := range res["tools"].([]any) {
		tool := item.(map[string]any)
		ann := tool["annotations"].(map[string]any)
		readOnly[tool["name"].(string)], _ = ann["readOnlyHint"].(bool)
	}
	for _, name := range []string{"kafka_produce", "db_query", "cassandra_query", "kube_exec", "ssh_exec", "okf_write", "okf_delete", "okf_log", "http_request"} {
		if readOnly[name] {
			t.Errorf("%s can change state and must not be marked read-only", name)
		}
	}
	for _, name := range []string{"json_format", "jsonpath_query", "base64", "kafka_topics", "kube_pods", "okf_read", "okf_search", "okf_graph"} {
		if !readOnly[name] {
			t.Errorf("%s only observes and should be marked read-only", name)
		}
	}
}

func TestUnknownMethodAndTool(t *testing.T) {
	s := newSession(t, Options{})
	reply := s.send("no/such/method", nil)
	e, ok := reply["error"].(map[string]any)
	if !ok || e["code"].(float64) != codeMethodNotFound {
		t.Errorf("want a method-not-found error, got %#v", reply)
	}
	reply = s.send("tools/call", map[string]any{"name": "nope"})
	if _, ok := reply["error"].(map[string]any); !ok {
		t.Errorf("calling an unknown tool should error, got %#v", reply)
	}
}

// A failing tool reports the problem in its result so the model can read and
// react to it; only protocol-level faults become JSON-RPC errors.
func TestToolFailureIsAResultNotAnError(t *testing.T) {
	s := newSession(t, Options{})
	text, isErr := s.call("json_format", map[string]any{"json": "{not json"})
	if !isErr {
		t.Fatalf("expected an error result, got %q", text)
	}
	if !strings.Contains(text, "line 1") {
		t.Errorf("the message should locate the syntax error, got %q", text)
	}
}

func TestMissingRequiredArgument(t *testing.T) {
	s := newSession(t, Options{})
	text, isErr := s.call("jsonpath_query", map[string]any{"json": "{}"})
	if !isErr || !strings.Contains(text, "path") {
		t.Errorf("want an error naming the missing argument, got %q (isErr=%v)", text, isErr)
	}
}

// A notification carries no id and must produce no reply — a stray response
// desynchronises the host's request/response pairing.
func TestNotificationProducesNoResponse(t *testing.T) {
	out := &bytes.Buffer{}
	srv := NewServer(strings.NewReader(""), out, Options{})
	srv.handleLine([]byte(`{"jsonrpc":"2.0","method":"notifications/initialized"}`))
	if out.Len() != 0 {
		t.Errorf("notification produced %q", out.String())
	}
}

func TestMalformedJSONGetsParseError(t *testing.T) {
	out := &bytes.Buffer{}
	srv := NewServer(strings.NewReader(""), out, Options{})
	srv.handleLine([]byte(`{"jsonrpc": broken`))
	var reply map[string]any
	if err := json.Unmarshal(bytes.TrimSpace(out.Bytes()), &reply); err != nil {
		t.Fatalf("parse-error reply is itself invalid JSON: %q", out.String())
	}
	if reply["error"].(map[string]any)["code"].(float64) != codeParse {
		t.Errorf("want a parse error, got %#v", reply)
	}
}

// Serve must consume a whole stdio conversation, one message per line.
func TestServeReadsAStream(t *testing.T) {
	in := strings.Join([]string{
		`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}`,
		`{"jsonrpc":"2.0","method":"notifications/initialized"}`,
		``, // blank lines are skipped, not treated as parse errors
		`{"jsonrpc":"2.0","id":2,"method":"ping"}`,
		`{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"base64","arguments":{"text":"hi"}}}`,
	}, "\n") + "\n"

	out := &bytes.Buffer{}
	srv := NewServer(strings.NewReader(in), out, Options{})
	if err := srv.Serve(); err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(out.String()), "\n")
	if len(lines) != 3 {
		t.Fatalf("want 3 responses (the notification answers nothing), got %d:\n%s", len(lines), out.String())
	}
	for i, line := range lines {
		var reply map[string]any
		if err := json.Unmarshal([]byte(line), &reply); err != nil {
			t.Fatalf("response %d is not JSON: %q", i, line)
		}
		if reply["jsonrpc"] != "2.0" {
			t.Errorf("response %d is missing the jsonrpc version", i)
		}
	}
}

func TestTextTools(t *testing.T) {
	s := newSession(t, Options{})

	if got := s.mustCall("base64", map[string]any{"text": "hello devtil"}); got != "aGVsbG8gZGV2dGls" {
		t.Errorf("base64 encode = %q", got)
	}
	if got := s.mustCall("base64", map[string]any{"text": "aGVsbG8gZGV2dGls", "mode": "decode"}); got != "hello devtil" {
		t.Errorf("base64 decode = %q", got)
	}
	// Unpadded base64url is what JWT segments look like in the wild.
	if got := s.mustCall("base64", map[string]any{"text": "aGVsbG8-d29ybGQ", "mode": "decode"}); got != "hello>world" {
		t.Errorf("base64url decode = %q", got)
	}

	got := s.mustCall("jsonpath_query", map[string]any{
		"json": `{"book":[{"price":8.95},{"price":22.99}]}`,
		"path": "$..book[?(@.price > 10)].price",
	})
	if !strings.Contains(got, "22.99") || strings.Contains(got, "8.95") {
		t.Errorf("jsonpath filter = %s", got)
	}

	got = s.mustCall("xml_to_json", map[string]any{"xml": `<o id="7"><i>a</i><i>b</i></o>`})
	var decoded map[string]any
	if err := json.Unmarshal([]byte(got), &decoded); err != nil {
		t.Fatalf("xml_to_json did not return JSON: %q", got)
	}
	o := decoded["o"].(map[string]any)
	if o["@id"] != "7" {
		t.Errorf("attribute lost: %#v", o)
	}
	if items, ok := o["i"].([]any); !ok || len(items) != 2 {
		t.Errorf("repeated tag should become an array: %#v", o["i"])
	}

	// XML → JSON → XML must survive the trip.
	back := s.mustCall("json_to_xml", map[string]any{"json": got})
	if !strings.Contains(back, `id="7"`) || strings.Count(back, "<i>") != 2 {
		t.Errorf("round trip lost structure: %s", back)
	}

	got = s.mustCall("jwt_decode", map[string]any{
		"token": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
	})
	if !strings.Contains(got, "John Doe") {
		t.Errorf("jwt payload not decoded: %s", got)
	}
	// The model must never be led to believe the token was verified.
	if !strings.Contains(got, `"signatureVerified": false`) {
		t.Errorf("jwt_decode must state that the signature is unverified: %s", got)
	}

	got = s.mustCall("hash_text", map[string]any{"text": "abc", "algorithm": "sha256"})
	if !strings.Contains(got, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad") {
		t.Errorf("sha256 = %s", got)
	}

	got = s.mustCall("timestamp_convert", map[string]any{"value": "1700000000"})
	if !strings.Contains(got, "2023-11-14T22:13:20Z") {
		t.Errorf("timestamp = %s", got)
	}
	// Milliseconds are recognised by magnitude, not by string length.
	got = s.mustCall("timestamp_convert", map[string]any{"value": "1700000000000"})
	if !strings.Contains(got, "2023-11-14T22:13:20Z") {
		t.Errorf("epoch millis = %s", got)
	}

	got = s.mustCall("regex_test", map[string]any{"pattern": `(\d+)-(\d+)`, "text": "12-34 and 56-78"})
	if !strings.Contains(got, `"count": 2`) {
		t.Errorf("regex_test = %s", got)
	}
}

// Models routinely send numbers and booleans as strings; coercion keeps a
// call from failing on a formatting detail.
func TestArgumentCoercion(t *testing.T) {
	s := newSession(t, Options{})
	got := s.mustCall("uuid_generate", map[string]any{"count": "3"})
	if strings.Count(got, "-") != 12 { // 4 hyphens per UUID
		t.Errorf("string count not coerced: %s", got)
	}
	got = s.mustCall("json_format", map[string]any{"json": `{"a":1}`, "indent": "4"})
	if !strings.Contains(got, `    "a"`) {
		t.Errorf("string indent not coerced: %q", got)
	}
	got = s.mustCall("base64", map[string]any{"text": "a?b", "urlSafe": "true"})
	if got != "YT9i" {
		t.Errorf("string bool not coerced: %q", got)
	}
}

// Without a configured bundle the okf tools must explain themselves rather
// than panicking or silently doing nothing.
func TestOKFToolsWithoutBundle(t *testing.T) {
	s := newSession(t, Options{})
	text, isErr := s.call("okf_search", map[string]any{})
	if !isErr || !strings.Contains(text, "knowledge bundle") {
		t.Errorf("want a clear 'no bundle configured' message, got %q", text)
	}
}

func TestOKFToolsRoundTrip(t *testing.T) {
	s := newSession(t, Options{OKFDir: t.TempDir()})

	if _, isErr := s.call("okf_write", map[string]any{"path": "/a.md", "body": "x"}); !isErr {
		t.Error(`okf_write without "type" should fail`)
	}
	s.mustCall("okf_write", map[string]any{
		"path": "/tables/orders.md", "type": "Database Table", "title": "Orders",
		"tags": []any{"sales"},
		"body": "Joined with [customers](/tables/customers.md).",
	})
	s.mustCall("okf_write", map[string]any{
		"path": "/tables/customers.md", "type": "Database Table", "title": "Customers",
		"body": "One row per customer.",
	})

	got := s.mustCall("okf_search", map[string]any{"query": "orders"})
	if !strings.Contains(got, "/tables/orders.md") {
		t.Errorf("search missed the concept: %s", got)
	}
	got = s.mustCall("okf_search", map[string]any{"tags": []any{"sales"}})
	if !strings.Contains(got, "Orders") {
		t.Errorf("tag search = %s", got)
	}

	got = s.mustCall("okf_graph", map[string]any{})
	if !strings.Contains(got, `"from": "/tables/orders.md"`) || !strings.Contains(got, `"to": "/tables/customers.md"`) {
		t.Errorf("markdown link did not become a graph edge: %s", got)
	}

	got = s.mustCall("okf_neighbors", map[string]any{"path": "/tables/customers.md", "depth": 1})
	if !strings.Contains(got, "/tables/orders.md") {
		t.Errorf("neighbors should follow the incoming link: %s", got)
	}

	s.mustCall("okf_log", map[string]any{"entry": "documented orders", "by": "human:test"})
	got = s.mustCall("okf_validate", map[string]any{})
	if !strings.Contains(got, `"conformant": true`) {
		t.Errorf("bundle should be conformant: %s", got)
	}

	s.mustCall("okf_delete", map[string]any{"path": "/tables/customers.md"})
	if _, isErr := s.call("okf_read", map[string]any{"path": "/tables/customers.md"}); !isErr {
		t.Error("reading a deleted concept should fail")
	}
	// The dangling link is now reported rather than hidden.
	got = s.mustCall("okf_validate", map[string]any{})
	if !strings.Contains(got, `"conformant": false`) {
		t.Errorf("a dangling link should be reported: %s", got)
	}
}

// Connection resolution reads the UI's state file; a missing or unusable one
// must degrade to "pass fields inline" rather than failing the server.
func TestConnectionsWithoutStore(t *testing.T) {
	s := newSession(t, Options{})
	got := s.mustCall("devtil_connections", map[string]any{})
	if !strings.Contains(got, "No saved connections") {
		t.Errorf("want a helpful empty listing, got %s", got)
	}
	text, isErr := s.call("kafka_topics", map[string]any{"connection": "prod"})
	if !isErr || !strings.Contains(text, "saved Kafka") {
		t.Errorf("want a clear message about the missing connection, got %q", text)
	}
	// With no connection at all, the error should say how to supply one.
	text, isErr = s.call("kafka_topics", map[string]any{})
	if !isErr || !strings.Contains(text, "connection") {
		t.Errorf("want guidance on supplying a connection, got %q", text)
	}
}
