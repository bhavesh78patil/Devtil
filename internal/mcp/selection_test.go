package mcp

import (
	"encoding/json"
	"strings"
	"testing"
)

// A developer typically has dev, staging and prod side by side. Reading the
// wrong one wastes a minute; writing to the wrong one does not. These tests
// pin down the rule: devtil never picks between plausible clusters.

func kafkaConns(names ...string) []map[string]any {
	return []map[string]any{kafkaTab(names...)}
}

// callRaw returns a tool's decoded result object, plus whether it errored.
func callRaw(t *testing.T, c *client, name string, args map[string]any) (map[string]any, string, bool) {
	t.Helper()
	text, isErr := c.call(name, args)
	if isErr {
		return nil, text, true
	}
	var out map[string]any
	if err := json.Unmarshal([]byte(text), &out); err != nil {
		return nil, text, false // a plain-text result
	}
	return out, text, false
}

// With several clusters and no default, an unqualified request must stop and
// send the agent back to the human.
func TestSelectionRefusesWhenAmbiguous(t *testing.T) {
	st := stateWith(t, map[string]any{}, kafkaConns("dev-cluster", "staging-cluster", "prod-payments"))
	c := newClient(t, Options{Store: st})

	_, text, isErr := callRaw(t, c, "kafka_topics", map[string]any{})
	if !isErr {
		t.Fatalf("an ambiguous request must be refused, got: %s", text)
	}
	for _, want := range []string{"dev-cluster", "staging-cluster", "prod-payments"} {
		if !strings.Contains(text, want) {
			t.Errorf("the refusal should list %q so the agent can offer the choice: %s", want, text)
		}
	}
	if !strings.Contains(strings.ToLower(text), "ask the developer") {
		t.Errorf("the refusal should tell the agent to ask: %s", text)
	}
	if !strings.Contains(strings.ToLower(text), "do not guess") {
		t.Errorf("the refusal should forbid guessing outright: %s", text)
	}
}

// One connection is unambiguous, so devtil may use it — and must say it did.
func TestSelectionUsesTheOnlyConnection(t *testing.T) {
	st := stateWith(t, map[string]any{}, kafkaConns("only-cluster"))
	c := newClient(t, Options{Store: st})

	// The broker is unreachable, so the call fails at connect time — but it
	// must fail having *chosen* the cluster, not having refused to choose.
	_, text, isErr := callRaw(t, c, "kafka_topics", map[string]any{})
	if !isErr {
		t.Fatal("expected a connection failure against a fake broker")
	}
	if strings.Contains(strings.ToLower(text), "ask the developer") {
		t.Errorf("a single connection should not be treated as ambiguous: %s", text)
	}
	if !strings.Contains(text, "only-cluster.internal:9092") {
		t.Errorf("it should have dialled the saved cluster: %s", text)
	}
}

// A default the developer set is an explicit decision and settles ambiguity.
func TestSelectionHonoursDefault(t *testing.T) {
	st := stateWith(t, map[string]any{
		"defaults": map[string]any{"kafka": "dev-cluster"},
	}, kafkaConns("dev-cluster", "prod-payments"))
	c := newClient(t, Options{Store: st})

	_, text, isErr := callRaw(t, c, "kafka_topics", map[string]any{})
	if !isErr {
		t.Fatal("expected a connection failure against a fake broker")
	}
	if !strings.Contains(text, "dev-cluster.internal:9092") {
		t.Errorf("the default should have been used: %s", text)
	}
	if strings.Contains(text, "prod-payments") {
		t.Errorf("it must not have touched production: %s", text)
	}
}

// Production is never handed out automatically, even when it is the only
// candidate: "unambiguous" is not the same as "intended".
func TestSelectionNeverAutoSelectsProduction(t *testing.T) {
	st := stateWith(t, map[string]any{
		"env": map[string]any{"kafka/prod-payments": "production"},
	}, kafkaConns("prod-payments"))
	c := newClient(t, Options{Store: st})

	_, text, isErr := callRaw(t, c, "kafka_topics", map[string]any{})
	if !isErr {
		t.Fatalf("the sole production connection must not be auto-selected, got: %s", text)
	}
	if !strings.Contains(text, "production") {
		t.Errorf("the refusal should say why: %s", text)
	}
	if strings.Contains(text, "prod-payments.internal:9092") {
		t.Error("it must not have dialled production")
	}

	// Naming it explicitly is allowed — that is a human decision.
	_, text, _ = callRaw(t, c, "kafka_topics", map[string]any{"connection": "prod-payments"})
	if !strings.Contains(text, "prod-payments.internal:9092") {
		t.Errorf("an explicitly named production connection should be used: %s", text)
	}
}

// Every result says which connection it came from, so the developer reading
// the transcript can see what the agent actually touched.
func TestResultsReportTheConnectionUsed(t *testing.T) {
	st := stateWith(t, map[string]any{}, kafkaConns("dev-cluster", "prod-payments"))
	c := newClient(t, Options{Store: st})

	res, text, isErr := callRaw(t, c, "devtil_connections", map[string]any{})
	if isErr {
		t.Fatalf("devtil_connections failed: %s", text)
	}
	guidance, _ := res["guidance"].(string)
	if !strings.Contains(guidance, "production") {
		t.Errorf("the listing should explain the production rule: %q", guidance)
	}
	if !strings.Contains(guidance, "ask the developer") {
		t.Errorf("with two connections and no default it should say to ask: %q", guidance)
	}

	// Environment and default show up in the listing.
	st = stateWith(t, map[string]any{
		"defaults": map[string]any{"kafka": "dev-cluster"},
		"env":      map[string]any{"kafka/prod-payments": "production", "kafka/dev-cluster": "development"},
	}, kafkaConns("dev-cluster", "prod-payments"))
	c = newClient(t, Options{Store: st})
	res, text, _ = callRaw(t, c, "devtil_connections", map[string]any{})
	entries := res["connections"].(map[string]any)["kafka"].([]any)
	var sawDefault, sawProd bool
	for _, e := range entries {
		m := e.(map[string]any)
		if m["name"] == "dev-cluster" && m["default"] == true && m["environment"] == "development" {
			sawDefault = true
		}
		if m["name"] == "prod-payments" && m["environment"] == "production" {
			sawProd = true
		}
	}
	if !sawDefault || !sawProd {
		t.Errorf("the listing should carry environment and default flags: %s", text)
	}
}

// The connection stamp rides along on a real tool result, not just on errors.
func TestConnectionStampOnResult(t *testing.T) {
	c := newClient(t, Options{Store: stateWith(t, map[string]any{}, nil)})
	// sftp_list against a bogus host fails, so use a tool whose result shape
	// we can produce without infrastructure: the stamp helper itself.
	got := withConnection(map[string]any{"rows": 3}, resolved{
		Name: "dev-cluster", Env: "development", SelectedBy: selectedByDefault,
	}).(map[string]any)
	conn := got["connection"].(map[string]any)
	if conn["name"] != "dev-cluster" || conn["environment"] != "development" {
		t.Errorf("stamp = %#v", conn)
	}
	if conn["selectedBy"] != selectedByDefault {
		t.Errorf("selectedBy = %v", conn["selectedBy"])
	}
	if got["rows"] != 3 {
		t.Error("the original result must survive the stamp")
	}

	// A typed struct result keeps its fields and gains the stamp.
	type grid struct {
		Columns []string `json:"columns"`
		Rows    int      `json:"rows"`
	}
	got = withConnection(grid{Columns: []string{"id"}, Rows: 2}, resolved{Name: "db", SelectedBy: selectedByAgent}).(map[string]any)
	if got["rows"].(float64) != 2 || len(got["columns"].([]any)) != 1 {
		t.Errorf("typed result lost fields: %#v", got)
	}
	if got["connection"].(map[string]any)["name"] != "db" {
		t.Errorf("typed result lost the stamp: %#v", got)
	}
	_ = c
}

// A prefix match should report the connection's real name, not what was typed.
func TestSelectionReportsCanonicalName(t *testing.T) {
	st := stateWith(t, map[string]any{}, kafkaConns("dev-cluster"))
	c := newClient(t, Options{Store: st})
	_, text, _ := callRaw(t, c, "kafka_topics", map[string]any{"connection": "dev"})
	if !strings.Contains(text, "dev-cluster.internal:9092") {
		t.Errorf("a unique prefix should resolve: %s", text)
	}
}

// With no connections at all, the message should send the agent to the
// developer rather than suggesting it invent broker addresses.
func TestSelectionWithNoConnections(t *testing.T) {
	c := newClient(t, Options{Store: stateWith(t, map[string]any{}, nil)})
	_, text, isErr := callRaw(t, c, "kafka_topics", map[string]any{})
	if !isErr {
		t.Fatalf("expected a refusal, got %s", text)
	}
	if !strings.Contains(strings.ToLower(text), "ask the developer") {
		t.Errorf("should point at the developer: %s", text)
	}
}
