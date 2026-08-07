package mcp

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/bhavesh78patil/devtil/internal/logging"
)

// The workspace tools read the same state file the UI autosaves, so the tests
// here seed that file and drive the tools the way an agent would.

func apiTab(cols ...map[string]any) map[string]any {
	return map[string]any{
		"type": "api", "title": "API Client",
		"data": map[string]any{"collections": cols},
	}
}

func notepadTab(pads ...map[string]any) map[string]any {
	return map[string]any{
		"type": "notepad", "title": "Scratch",
		"data": map[string]any{"pads": pads},
	}
}

func billingCollection(baseURL string) map[string]any {
	return map[string]any{
		"id": "c1", "name": "Billing API", "baseUrl": baseURL,
		"headers": []any{map[string]any{"k": "X-Team", "v": "payments"}},
		"auth":    map[string]any{"type": "basic", "username": "svc", "password": "s3cr3t"},
		"requests": []any{
			map[string]any{
				"id": "r1", "name": "List invoices", "method": "GET", "path": "/invoices",
				"headers": []any{map[string]any{"k": "Accept", "v": "application/json"}},
				"auth":    map[string]any{"type": "inherit"},
			},
			map[string]any{
				"id": "r2", "name": "Create invoice", "method": "POST", "path": "/invoices",
				"body":    `{"amount":100}`,
				"headers": []any{map[string]any{"k": "Content-Type", "v": "application/json"}},
				"auth":    map[string]any{"type": "bearer", "token": "tok-abc"},
			},
		},
	}
}

func ledgerCollection(baseURL string) map[string]any {
	return map[string]any{
		"id": "c2", "name": "Ledger API", "baseUrl": baseURL + "/ledger",
		"auth": map[string]any{"type": "none"},
		"requests": []any{
			map[string]any{"id": "r3", "name": "List invoices", "method": "GET", "path": "/entries",
				"auth": map[string]any{"type": "inherit"}},
		},
	}
}

// echoServer reports back exactly what it received, so a test can assert on
// the headers and URL the tool actually put on the wire.
func echoServer(t *testing.T) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hdr := map[string]string{}
		for k := range r.Header {
			hdr[strings.ToLower(k)] = r.Header.Get(k)
		}
		body := make([]byte, r.ContentLength)
		if r.ContentLength > 0 {
			_, _ = r.Body.Read(body)
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"method": r.Method, "uri": r.RequestURI, "headers": hdr, "body": string(body),
		})
	}))
	t.Cleanup(srv.Close)
	return srv
}

func TestAPICollectionsListsAndFilters(t *testing.T) {
	st := stateWith(t, nil, []map[string]any{apiTab(billingCollection("http://x"), ledgerCollection("http://x"))})
	c := newClient(t, Options{Store: st})

	all, isErr := c.call("api_collections", nil)
	if isErr {
		t.Fatalf("api_collections: %s", all)
	}
	for _, want := range []string{"Billing API", "Ledger API", "List invoices", "Create invoice"} {
		if !strings.Contains(all, want) {
			t.Errorf("listing missing %q:\n%s", want, all)
		}
	}
	// hasBody distinguishes the POST from the GET without dumping payloads
	if !strings.Contains(all, `"hasBody": true`) || !strings.Contains(all, `"hasBody": false`) {
		t.Errorf("expected both hasBody values:\n%s", all)
	}
	// credentials never leave the state file
	if strings.Contains(all, "s3cr3t") || strings.Contains(all, "tok-abc") {
		t.Errorf("credentials leaked into the listing:\n%s", all)
	}

	filtered, _ := c.call("api_collections", map[string]any{"query": "create"})
	if !strings.Contains(filtered, "Create invoice") || strings.Contains(filtered, "List invoices") {
		t.Errorf("query did not filter:\n%s", filtered)
	}

	// a query that matches nothing still says the collections exist, so an
	// agent retries rather than concluding the developer has saved nothing
	none, _ := c.call("api_collections", map[string]any{"query": "zzzz"})
	if !strings.Contains(none, "Nothing matched") || !strings.Contains(none, "2 collections") {
		t.Errorf("unhelpful empty-result note:\n%s", none)
	}
}

func TestAPICollectionsWithoutStore(t *testing.T) {
	c := newClient(t, Options{})
	out, isErr := c.call("api_collections", nil)
	if isErr {
		t.Fatalf("should not error without a store: %s", out)
	}
	if !strings.Contains(out, "No saved API requests") {
		t.Errorf("expected a pointer to the API Client tool:\n%s", out)
	}
}

func TestAPIRequestAppliesCollectionAuthAndHeaders(t *testing.T) {
	echo := echoServer(t)
	st := stateWith(t, nil, []map[string]any{apiTab(billingCollection(echo.URL))})
	c := newClient(t, Options{Store: st})

	out, isErr := c.call("api_request", map[string]any{"request": "List invoices"})
	if isErr {
		t.Fatalf("api_request: %s", out)
	}
	// basic auth is built from the collection, base64 of "svc:s3cr3t"
	if !strings.Contains(out, "Basic c3ZjOnMzY3IzdA==") {
		t.Errorf("collection basic auth not applied:\n%s", out)
	}
	if !strings.Contains(out, `"x-team": "payments"`) {
		t.Errorf("collection global header not applied:\n%s", out)
	}
	if !strings.Contains(out, `"status": 200`) {
		t.Errorf("expected a 200:\n%s", out)
	}
	// the response says what was actually sent, since the saved request can change
	if !strings.Contains(out, `"request": "List invoices"`) || !strings.Contains(out, `"collection": "Billing API"`) {
		t.Errorf("missing the sent block:\n%s", out)
	}
}

func TestAPIRequestPerRequestAuthWinsOverInherited(t *testing.T) {
	echo := echoServer(t)
	st := stateWith(t, nil, []map[string]any{apiTab(billingCollection(echo.URL))})
	c := newClient(t, Options{Store: st})

	out, isErr := c.call("api_request", map[string]any{"request": "Create invoice"})
	if isErr {
		t.Fatalf("api_request: %s", out)
	}
	if !strings.Contains(out, "Bearer tok-abc") {
		t.Errorf("request-level bearer auth not applied:\n%s", out)
	}
	if strings.Contains(out, "Basic ") {
		t.Errorf("collection auth should have been replaced, not merged:\n%s", out)
	}
	if !strings.Contains(out, `{\"amount\":100}`) {
		t.Errorf("saved body not sent:\n%s", out)
	}
}

func TestAPIRequestOverridesDoNotChangeWhatIsSaved(t *testing.T) {
	echo := echoServer(t)
	st := stateWith(t, nil, []map[string]any{apiTab(billingCollection(echo.URL))})
	c := newClient(t, Options{Store: st})

	out, _ := c.call("api_request", map[string]any{
		"request": "Create invoice",
		"body":    `{"amount":999}`,
		"headers": map[string]any{"X-Team": "override"},
	})
	if !strings.Contains(out, `{\"amount\":999}`) {
		t.Errorf("body override not applied:\n%s", out)
	}
	if !strings.Contains(out, `"x-team": "override"`) {
		t.Errorf("header override did not win:\n%s", out)
	}

	// the state file is untouched: a later call sees the original again
	again, _ := c.call("api_request", map[string]any{"request": "Create invoice"})
	if !strings.Contains(again, `{\"amount\":100}`) {
		t.Errorf("override leaked into the saved request:\n%s", again)
	}
}

func TestAPIRequestQueryAuthIsEscaped(t *testing.T) {
	echo := echoServer(t)
	col := map[string]any{
		"id": "c1", "name": "Search API", "baseUrl": echo.URL,
		"requests": []any{map[string]any{
			"id": "r1", "name": "Search", "method": "GET", "path": "/search",
			"auth": map[string]any{"type": "apikey", "in": "query", "key": "api key", "value": "a b&c"},
		}},
	}
	c := newClient(t, Options{Store: stateWith(t, nil, []map[string]any{apiTab(col)})})

	out, isErr := c.call("api_request", map[string]any{"request": "Search"})
	if isErr {
		t.Fatalf("api_request: %s", out)
	}
	// a space must be %20, not "+": a server that does not form-decode the
	// query string hands "+" back as a literal plus
	if !strings.Contains(out, "/search?api%20key=a%20b%26c") {
		t.Errorf("query auth escaped wrongly:\n%s", out)
	}
}

func TestAPIRequestRefusesAmbiguousName(t *testing.T) {
	echo := echoServer(t)
	st := stateWith(t, nil, []map[string]any{apiTab(billingCollection(echo.URL), ledgerCollection(echo.URL))})
	c := newClient(t, Options{Store: st})

	out, isErr := c.call("api_request", map[string]any{"request": "List invoices"})
	if !isErr {
		t.Fatalf("expected a refusal, got: %s", out)
	}
	// the refusal has to name the candidates, or the agent cannot recover
	if !strings.Contains(out, "Billing API") || !strings.Contains(out, "Ledger API") {
		t.Errorf("refusal does not list the candidates: %s", out)
	}

	// naming the collection resolves it, and the right one is used
	resolved, isErr := c.call("api_request", map[string]any{
		"request": "List invoices", "collection": "Ledger API",
	})
	if isErr {
		t.Fatalf("naming the collection should have resolved the ambiguity: %s", resolved)
	}
	if !strings.Contains(resolved, `"uri": "/ledger/entries"`) {
		t.Errorf("wrong collection used:\n%s", resolved)
	}
}

func TestAPIRequestUnknownNamePointsAtTheListing(t *testing.T) {
	c := newClient(t, Options{Store: stateWith(t, nil, []map[string]any{apiTab(billingCollection("http://x"))})})
	out, isErr := c.call("api_request", map[string]any{"request": "nope"})
	if !isErr {
		t.Fatalf("expected an error, got: %s", out)
	}
	if !strings.Contains(out, "api_collections") {
		t.Errorf("error should point at the listing tool: %s", out)
	}
}

func TestAPIRequestAbsolutePathIgnoresBaseURL(t *testing.T) {
	echo := echoServer(t)
	col := map[string]any{
		"id": "c1", "name": "Mixed", "baseUrl": "http://never-used.invalid",
		"requests": []any{map[string]any{
			"id": "r1", "name": "Absolute", "method": "GET", "path": echo.URL + "/direct",
		}},
	}
	c := newClient(t, Options{Store: stateWith(t, nil, []map[string]any{apiTab(col)})})
	out, isErr := c.call("api_request", map[string]any{"request": "Absolute"})
	if isErr {
		t.Fatalf("api_request: %s", out)
	}
	if !strings.Contains(out, `"uri": "/direct"`) {
		t.Errorf("absolute path should bypass the base URL:\n%s", out)
	}
}

func TestNotepadListAndRead(t *testing.T) {
	pads := []map[string]any{
		{"id": "p1", "text": "Retry semantics\n\nThe worker retries 5xx but not 409."},
		{"id": "p2", "text": "todo: check partitions"},
	}
	c := newClient(t, Options{Store: stateWith(t, nil, []map[string]any{notepadTab(pads[0], pads[1])})})

	list, isErr := c.call("notepad_list", nil)
	if isErr {
		t.Fatalf("notepad_list: %s", list)
	}
	// the first line is the title, the way the UI names a pad
	if !strings.Contains(list, `"title": "Retry semantics"`) {
		t.Errorf("pad title not derived from the first line:\n%s", list)
	}
	// a preview is one readable line, not escaped newlines
	if strings.Contains(list, `\n`) {
		t.Errorf("preview should be flattened to one line:\n%s", list)
	}

	filtered, _ := c.call("notepad_list", map[string]any{"query": "409"})
	if !strings.Contains(filtered, "p1") || strings.Contains(filtered, "p2") {
		t.Errorf("query did not filter pads:\n%s", filtered)
	}

	read, isErr := c.call("notepad_read", map[string]any{"id": "p1"})
	if isErr {
		t.Fatalf("notepad_read: %s", read)
	}
	if !strings.Contains(read, "retries 5xx but not 409") {
		t.Errorf("full text not returned:\n%s", read)
	}

	missing, isErr := c.call("notepad_read", map[string]any{"id": "nope"})
	if !isErr || !strings.Contains(missing, "notepad_list") {
		t.Errorf("unknown id should error and point at notepad_list: %s", missing)
	}
}

// The notepad tools are read-only on purpose: the UI autosaves the whole
// workspace every few hundred milliseconds, so a write from an agent would be
// lost to the developer's next keystroke. Durable agent notes go to OKF.
func TestNotepadToolsAreReadOnly(t *testing.T) {
	c := newClient(t, Options{Store: stateWith(t, nil, nil)})
	tools := listedTools(t, c)
	for _, name := range []string{"notepad_write", "notepad_delete", "notepad_append"} {
		if tools[name] {
			t.Errorf("%s should not exist — pads are read-only over MCP", name)
		}
	}
	for _, name := range []string{"notepad_list", "notepad_read", "api_collections", "devtil_logs", "text_diff"} {
		if !tools[name] {
			t.Fatalf("%s missing from tools/list", name)
		}
	}
}

func TestTextDiff(t *testing.T) {
	c := newClient(t, Options{})

	out, isErr := c.call("text_diff", map[string]any{"left": "a\nb\nc", "right": "a\nB\nc\nd"})
	if isErr {
		t.Fatalf("text_diff: %s", out)
	}
	if !strings.Contains(out, `"added": 2`) || !strings.Contains(out, `"removed": 1`) {
		t.Errorf("wrong counts:\n%s", out)
	}
	if strings.Contains(out, `"op": "same"`) {
		t.Errorf("unchanged lines should be dropped by default:\n%s", out)
	}

	same, _ := c.call("text_diff", map[string]any{"left": "x\ny", "right": "x\ny"})
	if !strings.Contains(same, `"identical": true`) {
		t.Errorf("identical texts not reported as such:\n%s", same)
	}

	ctxd, _ := c.call("text_diff", map[string]any{"left": "x\ny", "right": "x\ny", "contextual": true})
	if !strings.Contains(ctxd, `"op": "same"`) {
		t.Errorf("contextual should keep unchanged lines:\n%s", ctxd)
	}
}

func TestDiffLinesIsMinimal(t *testing.T) {
	// an insertion in the middle must not re-write the lines around it
	ops := diffLines([]string{"a", "b", "c"}, []string{"a", "x", "b", "c"})
	var adds, dels int
	for _, op := range ops {
		switch op.kind {
		case "add":
			adds++
		case "del":
			dels++
		}
	}
	if adds != 1 || dels != 0 {
		t.Fatalf("expected one pure insertion, got %d adds / %d dels: %+v", adds, dels, ops)
	}
}

func TestPadTitleAndPreview(t *testing.T) {
	if got := padTitle("   \n\nSecond line"); got != "(empty pad)" {
		t.Errorf("a pad whose first line is blank should say so, got %q", got)
	}
	long := strings.Repeat("x", 100)
	if got := padTitle(long); len([]rune(got)) > 61 {
		t.Errorf("title not truncated: %d runes", len([]rune(got)))
	}
	if got := padPreview("one\n\n  two   three ", 200); got != "one two three" {
		t.Errorf("preview should collapse whitespace, got %q", got)
	}
	if got := padPreview(strings.Repeat("y", 50), 10); !strings.HasSuffix(got, "…") {
		t.Errorf("long preview not truncated: %q", got)
	}
}

func TestAuthHeaders(t *testing.T) {
	tests := []struct {
		name       string
		auth       string
		wantHeader map[string]string
		wantQuery  [][2]string
	}{
		{"none", `{"type":"none"}`, map[string]string{}, nil},
		{"empty basic contributes nothing", `{"type":"basic"}`, map[string]string{}, nil},
		{"basic", `{"type":"basic","username":"u","password":"p"}`,
			map[string]string{"Authorization": "Basic dTpw"}, nil},
		{"bearer", `{"type":"bearer","token":"abc"}`,
			map[string]string{"Authorization": "Bearer abc"}, nil},
		{"bearer keeps a pasted scheme", `{"type":"bearer","token":"Bearer abc"}`,
			map[string]string{"Authorization": "Bearer abc"}, nil},
		{"apikey header", `{"type":"apikey","key":"X-Key","value":"v","in":"header"}`,
			map[string]string{"X-Key": "v"}, nil},
		{"apikey query", `{"type":"apikey","key":"k","value":"v","in":"query"}`,
			map[string]string{}, [][2]string{{"k", "v"}}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			h, q := authHeaders(json.RawMessage(tt.auth))
			if len(h) != len(tt.wantHeader) {
				t.Fatalf("headers = %v, want %v", h, tt.wantHeader)
			}
			for k, v := range tt.wantHeader {
				if h[k] != v {
					t.Errorf("header %s = %q, want %q", k, h[k], v)
				}
			}
			if len(q) != len(tt.wantQuery) {
				t.Fatalf("query = %v, want %v", q, tt.wantQuery)
			}
			for i, pair := range tt.wantQuery {
				if q[i] != pair {
					t.Errorf("query[%d] = %v, want %v", i, q[i], pair)
				}
			}
		})
	}
}

func TestEscapeQueryUsesPercentTwenty(t *testing.T) {
	if got := escapeQuery("a b&c"); got != "a%20b%26c" {
		t.Errorf("escapeQuery = %q, want %q", got, "a%20b%26c")
	}
}

func TestDevtilLogsTailsAndFilters(t *testing.T) {
	if err := logging.Init(t.TempDir()); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 5; i++ {
		logging.Logf("kubectl: get pods run %d", i)
	}
	logging.Logf("proxy: GET http://example.invalid -> 200")

	c := newClient(t, Options{})
	// a nonsense count must not reach the tail
	out, isErr := c.call("devtil_logs", map[string]any{"lines": -5})
	if isErr {
		t.Fatalf("devtil_logs: %s", out)
	}
	if !strings.Contains(out, "kubectl: get pods run 4") {
		t.Errorf("recent lines missing:\n%s", out)
	}

	filtered, isErr := c.call("devtil_logs", map[string]any{"filter": "proxy"})
	if isErr {
		t.Fatalf("devtil_logs: %s", filtered)
	}
	if !strings.Contains(filtered, "example.invalid") || strings.Contains(filtered, "get pods") {
		t.Errorf("filter did not apply:\n%s", filtered)
	}

	few, _ := c.call("devtil_logs", map[string]any{"lines": 2})
	if !strings.Contains(few, `"count": 2`) {
		t.Errorf("line count not honoured:\n%s", few)
	}
}

func TestWorkspaceToolsAreGated(t *testing.T) {
	st := stateWith(t, map[string]any{"groups": map[string]any{"workspace": false}},
		[]map[string]any{apiTab(billingCollection("http://x"))})
	c := newClient(t, Options{Store: st})

	tools := listedTools(t, c)
	for _, name := range []string{"api_collections", "api_request", "notepad_list", "notepad_read", "devtil_logs"} {
		if tools[name] {
			t.Errorf("%s should be hidden when the workspace group is off", name)
		}
	}
	// and hidden is refused, not merely unlisted — an agent may be working
	// from a cached tool list
	out, isErr := c.call("api_collections", nil)
	if !isErr {
		t.Errorf("a hidden tool should be refused on call, got: %s", out)
	}
	// text_diff lives in the offline group, so it stays available
	if !tools["text_diff"] {
		t.Error("text_diff should not be affected by the workspace group")
	}
}
