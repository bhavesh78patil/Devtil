package mcp

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/bhavesh78patil/devtil/internal/store"
)

// stateWith writes a UI state file containing the given MCP settings and any
// saved connections, then returns a store pointed at it — the same file the
// running app autosaves.
func stateWith(t *testing.T, mcpSettings map[string]any, tabs []map[string]any) *store.Store {
	t.Helper()
	dir := t.TempDir()
	st, err := store.New(dir)
	if err != nil {
		t.Fatal(err)
	}
	state := map[string]any{
		"version":  1,
		"settings": map[string]any{"mcp": mcpSettings},
		"workspaces": []any{
			map[string]any{"name": "Default", "tabs": tabs},
		},
	}
	data, err := json.Marshal(state)
	if err != nil {
		t.Fatal(err)
	}
	if err := st.Save(data); err != nil {
		t.Fatal(err)
	}
	// sanity: the file really is where the store says it is
	if _, err := os.Stat(filepath.Clean(st.Path())); err != nil {
		t.Fatalf("state file missing: %v", err)
	}
	return st
}

func kafkaTab(names ...string) map[string]any {
	conns := make([]any, 0, len(names))
	for _, n := range names {
		conns = append(conns, map[string]any{"name": n, "brokers": n + ".internal:9092"})
	}
	return map[string]any{"type": "kafka", "title": "Kafka", "data": map[string]any{"connections": conns}}
}

func listedTools(t *testing.T, c *client) map[string]bool {
	t.Helper()
	res := c.send("tools/list", nil)["result"].(map[string]any)
	out := map[string]bool{}
	for _, item := range res["tools"].([]any) {
		out[item.(map[string]any)["name"].(string)] = true
	}
	return out
}

// An unconfigured install exposes everything — the feature ships on.
func TestPolicyDefaultsToEverythingOn(t *testing.T) {
	p := DefaultPolicy()
	if !p.IsEnabled() {
		t.Error("MCP should be enabled by default")
	}
	for _, name := range []string{"kafka_produce", "ssh_exec", "okf_write", "json_format"} {
		if !p.AllowsTool(name) {
			t.Errorf("%s should be allowed by default", name)
		}
	}
	if !p.AllowsConnection("kafka", "anything") {
		t.Error("all connections should be shared by default")
	}

	// A state file with no settings block at all behaves the same.
	c := newClient(t, Options{Store: stateWith(t, nil, nil)})
	if !listedTools(t, c)["kafka_produce"] {
		t.Error("an unconfigured state file should still list every tool")
	}
}

// Unticking a group hides its tools from the listing entirely.
func TestPolicyHidesDisabledGroups(t *testing.T) {
	st := stateWith(t, map[string]any{
		"groups": map[string]any{"kafka": false, "ssh": false},
	}, nil)
	tools := listedTools(t, newClient(t, Options{Store: st}))

	for _, gone := range []string{"kafka_topics", "kafka_consume", "kafka_produce", "ssh_exec", "sftp_list"} {
		if tools[gone] {
			t.Errorf("%s belongs to a disabled group and should not be listed", gone)
		}
	}
	for _, kept := range []string{"json_format", "db_query", "okf_write", "kube_logs"} {
		if !tools[kept] {
			t.Errorf("%s is in an enabled group and should still be listed", kept)
		}
	}
}

// A single tool can be pulled out of an otherwise enabled group — the common
// case being "let it read Kafka, but never produce".
func TestPolicyPerToolOverride(t *testing.T) {
	st := stateWith(t, map[string]any{
		"tools": map[string]any{"kafka_produce": false},
	}, nil)
	tools := listedTools(t, newClient(t, Options{Store: st}))
	if tools["kafka_produce"] {
		t.Error("kafka_produce was overridden off and should not be listed")
	}
	if !tools["kafka_consume"] {
		t.Error("the rest of the group should be unaffected")
	}

	// The inverse: one tool switched back on inside a disabled group.
	st = stateWith(t, map[string]any{
		"groups": map[string]any{"kafka": false},
		"tools":  map[string]any{"kafka_topics": true},
	}, nil)
	tools = listedTools(t, newClient(t, Options{Store: st}))
	if !tools["kafka_topics"] {
		t.Error("an explicit per-tool tick should win over its group")
	}
	if tools["kafka_produce"] {
		t.Error("the rest of the disabled group should stay hidden")
	}
}

// A client working from a cached tool list can still ask for something that
// has since been switched off; it must be refused, not quietly executed.
func TestPolicyRefusesDisabledToolOnCall(t *testing.T) {
	st := stateWith(t, map[string]any{"groups": map[string]any{"ssh": false}}, nil)
	c := newClient(t, Options{Store: st})

	text, isErr := c.call("ssh_exec", map[string]any{"host": "h", "command": "whoami"})
	if !isErr {
		t.Fatalf("a disabled tool must refuse, got %q", text)
	}
	if !strings.Contains(text, "turned off") {
		t.Errorf("the refusal should explain itself, got %q", text)
	}
}

// A connection the developer did not share must be invisible, not merely
// unusable — an agent should not learn that a prod cluster exists.
func TestPolicyConnectionAllowlist(t *testing.T) {
	tabs := []map[string]any{kafkaTab("dev-cluster", "prod-payments")}
	st := stateWith(t, map[string]any{
		"connectionsAll": false,
		"connections":    map[string]any{"kafka/dev-cluster": true},
	}, tabs)
	c := newClient(t, Options{Store: st})

	listing := c.mustCall("devtil_connections", map[string]any{})
	if !strings.Contains(listing, "dev-cluster") {
		t.Errorf("the shared connection should be listed: %s", listing)
	}
	if strings.Contains(listing, "prod-payments") {
		t.Errorf("an unshared connection must not appear in the listing: %s", listing)
	}

	// Naming it directly is refused too.
	text, isErr := c.call("kafka_topics", map[string]any{"connection": "prod-payments"})
	if !isErr {
		t.Fatalf("using an unshared connection should fail, got %q", text)
	}
	if !strings.Contains(text, "not shared") {
		t.Errorf("the refusal should say why, got %q", text)
	}
}

// With sharing left on, every saved connection is available, including ones
// added after the setting was made.
func TestPolicyConnectionsAllByDefault(t *testing.T) {
	tabs := []map[string]any{kafkaTab("dev-cluster", "prod-payments")}
	c := newClient(t, Options{Store: stateWith(t, map[string]any{}, tabs)})
	listing := c.mustCall("devtil_connections", map[string]any{})
	for _, want := range []string{"dev-cluster", "prod-payments"} {
		if !strings.Contains(listing, want) {
			t.Errorf("%s should be listed by default: %s", want, listing)
		}
	}
	// Credentials are never part of the listing, whatever the policy.
	if strings.Contains(listing, "password") {
		t.Errorf("the listing must not carry credentials: %s", listing)
	}
}

// Switching the server off makes the HTTP endpoint refuse everything, which
// is the whole point of the toggle.
func TestPolicyDisabledServerRefusesHTTP(t *testing.T) {
	st := stateWith(t, map[string]any{"enabled": false}, nil)
	srv := httpServer(t, Options{Store: st})
	res, reply := post(t, srv, "", map[string]any{"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
	if res.StatusCode != 503 {
		t.Errorf("status = %d, want 503", res.StatusCode)
	}
	msg, _ := reply["error"].(map[string]any)["message"].(string)
	if !strings.Contains(msg, "Settings") {
		t.Errorf("the error should point at where to turn it back on, got %q", msg)
	}
}

// Every group in the Settings list must map to tools that actually exist, or
// the panel would offer toggles that control nothing.
func TestGroupsCoverEveryRegisteredTool(t *testing.T) {
	s := NewHTTPServer(Options{})
	covered := map[string]bool{}
	for _, g := range Groups {
		if len(g.Tools) == 0 {
			t.Errorf("group %q has no tools", g.ID)
		}
		for _, name := range g.Tools {
			if _, ok := s.tools[name]; !ok {
				t.Errorf("group %q lists unknown tool %q", g.ID, name)
			}
			if covered[name] {
				t.Errorf("tool %q appears in more than one group", name)
			}
			covered[name] = true
		}
	}
	for name := range s.tools {
		if !covered[name] {
			t.Errorf("tool %q is in no group, so Settings cannot gate it", name)
		}
	}

	// The UI payload must describe the same set.
	groups := s.GroupsForUI()
	if len(groups) != len(Groups) {
		t.Errorf("GroupsForUI returned %d groups, want %d", len(groups), len(Groups))
	}
	for _, g := range groups {
		if g["label"] == "" || g["desc"] == "" {
			t.Errorf("group %v needs a label and a description for the panel", g["id"])
		}
	}
}

// The Settings panel reads .length off these payloads, so a nil slice
// marshalled as JSON null crashes the panel — which is exactly the state a
// fresh install is in, before anything has been saved.
func TestUIPayloadsAreArraysNotNull(t *testing.T) {
	for _, tc := range []struct {
		name string
		srv  *Server
	}{
		{"no store at all", NewHTTPServer(Options{})},
		{"store with nothing saved", NewHTTPServer(Options{Store: stateWith(t, nil, nil)})},
	} {
		t.Run(tc.name, func(t *testing.T) {
			payload, err := json.Marshal(map[string]any{
				"groups":      tc.srv.GroupsForUI(),
				"connections": tc.srv.ConnectionsForUI(),
			})
			if err != nil {
				t.Fatal(err)
			}
			if strings.Contains(string(payload), "null") {
				t.Errorf("payload contains null, which the Settings panel cannot render: %s", payload)
			}
		})
	}
}
