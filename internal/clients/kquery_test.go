package clients

import (
	"strings"
	"testing"
	"time"
)

// The payload a developer would actually be searching.
func orderMsg() MsgFields {
	return MsgFields{
		Key: "ORD-8837",
		Value: `{"orderId":"ORD-8837","status":"held","amount":142.5,
		         "customer":{"name":"Ada Lovelace","city":"Pune"},
		         "items":[{"sku":"x-1","qty":2},{"sku":"y-9","qty":1}],
		         "note":"awaiting stock"}`,
		Headers: []KafkaHeader{
			{Key: "traceId", Value: "abc-123"},
			{Key: "source", Value: "web"},
		},
	}
}

func match(t *testing.T, q string, target MatchTarget, m MsgFields) bool {
	t.Helper()
	parsed, err := ParseQuery(q, target)
	if err != nil {
		t.Fatalf("ParseQuery(%q): %v", q, err)
	}
	return parsed.Match(&m)
}

func TestQueryMatching(t *testing.T) {
	tests := []struct {
		q    string
		want bool
		why  string
	}{
		// bare terms stay a plain substring, so old searches keep working
		{"held", true, "substring of the value"},
		{"HELD", true, "case-insensitive"},
		{"shipped", false, "absent"},
		{`"awaiting stock"`, true, "quoted phrase with a space"},
		{`"awaiting  stock"`, false, "the phrase is exact"},

		// field lookups
		{"status:held", true, "top-level field"},
		{"status:hel", true, "field match is a substring by default"},
		{"status=held", true, "exact match with ="},
		{"status=hel", false, "= is not a substring"},
		{"status:shipped", false, "wrong value"},
		{"nosuchfield:held", false, "a missing field never matches"},

		// dotted paths, and bare names found at any depth
		{"customer.city:Pune", true, "dotted path"},
		{"city:Pune", true, "bare name resolved at any depth"},
		{"customer.city:London", false, "wrong value on a real path"},
		{"items.sku:y-9", true, "arrays are searched element-wise"},
		{"items.sku:z-0", false, "no such element"},

		// numeric comparisons
		{"amount:>100", true, "greater than"},
		{"amount:>200", false, "not greater than"},
		{"amount:<200", true, "less than"},
		{"amount:>=142.5", true, "inclusive"},
		{"amount:<=142.5", true, "inclusive"},
		{"status:>1", false, "a non-numeric field never satisfies a comparison"},

		// the record itself, not the payload
		{"key:ORD-8837", true, "the message key"},
		{"key:nope", false, "wrong key"},
		{"header.traceId:abc-123", true, "a header"},
		{"header.traceid:ABC", true, "headers are case-insensitive both ways"},
		{"header.missing:x", false, "no such header"},
		{"value:awaiting", true, "value: searches the raw payload"},

		// boolean combinations
		{"status:held amount:>100", true, "bare terms are ANDed"},
		{"status:held AND amount:>100", true, "explicit AND"},
		{"status:held AND amount:>200", false, "AND needs both"},
		{"status:shipped OR status:held", true, "OR"},
		{"status:shipped OR status:cancelled", false, "neither side"},
		{"NOT status:shipped", true, "NOT"},
		{"NOT status:held", false, "NOT of a match"},
		{"-status:shipped", true, "leading hyphen negates"},
		{"held -shipped", true, "a negated bare term"},
		{"held -Pune", false, "negation of something present"},
		{"(status:shipped OR status:held) AND city:Pune", true, "brackets"},
		{"(status:shipped OR status:cancelled) AND city:Pune", false, "brackets, left side fails"},
		{"status:held AND NOT city:London", true, "AND NOT"},

		// precedence: AND binds tighter than OR
		{"status:cancelled AND city:Pune OR status:held", true, "(a AND b) OR c"},
		{"status:held OR status:cancelled AND city:London", true, "a OR (b AND c)"},

		{`status:"held"`, true, "a quoted field value"},
		{`note:"awaiting stock"`, true, "a quoted field value with a space"},
	}
	for _, tt := range tests {
		t.Run(tt.q, func(t *testing.T) {
			if got := match(t, tt.q, MatchValue, orderMsg()); got != tt.want {
				t.Errorf("%q = %v, want %v — %s", tt.q, got, tt.want, tt.why)
			}
		})
	}
}

func TestQueryAgainstTheKeyBox(t *testing.T) {
	m := orderMsg()
	// a bare term in the key box searches the key, not the payload
	if !match(t, "8837", MatchKey, m) {
		t.Error("a bare term should search the key")
	}
	if match(t, "Pune", MatchKey, m) {
		t.Error("the key box must not match on the payload")
	}
	// field lookups still reach the payload, so one box can express everything
	if !match(t, "status:held", MatchKey, m) {
		t.Error("a field lookup should still read the payload")
	}
	if !match(t, "ORD AND status:held", MatchKey, m) {
		t.Error("key substring combined with a payload field")
	}
}

func TestQueryOnNonJSONPayload(t *testing.T) {
	m := MsgFields{Key: "k1", Value: "plain text, not json at all"}
	if !match(t, "plain", MatchValue, m) {
		t.Error("bare terms must still work on a non-JSON payload")
	}
	if match(t, "status:held", MatchValue, m) {
		t.Error("a field lookup on a non-JSON payload must not match")
	}
	// and NOT of an unmatchable field is true, which is the useful reading of
	// "everything that isn't held"
	if !match(t, "NOT status:held", MatchValue, m) {
		t.Error("NOT of a field that cannot resolve should be true")
	}
}

func TestEmptyQueryMatchesEverything(t *testing.T) {
	for _, q := range []string{"", "   ", "\t"} {
		parsed, err := ParseQuery(q, MatchValue)
		if err != nil {
			t.Fatalf("ParseQuery(%q): %v", q, err)
		}
		if !parsed.IsEmpty() {
			t.Errorf("ParseQuery(%q) should be empty", q)
		}
		m := orderMsg()
		if !parsed.Match(&m) {
			t.Errorf("an empty query must match everything")
		}
	}
	var nilQ *Query
	if !nilQ.IsEmpty() {
		t.Error("a nil query is empty")
	}
	m := orderMsg()
	if !nilQ.Match(&m) {
		t.Error("a nil query matches everything")
	}
}

func TestQuerySyntaxErrors(t *testing.T) {
	for _, q := range []string{
		"(status:held",    // no closing bracket
		"status:held)",    // stray closing bracket
		"NOT",             // nothing to negate
		"status:held AND", // dangling operator
		"status:held OR",  // dangling operator
		"()",              // empty group
	} {
		if _, err := ParseQuery(q, MatchValue); err == nil {
			t.Errorf("ParseQuery(%q) should have failed", q)
		}
	}
}

// A term that merely contains a separator or a hyphen must stay a term —
// searching for a timestamp or a hyphenated id is completely ordinary.
func TestAmbiguousTermsAreNotOperators(t *testing.T) {
	m := MsgFields{Key: "k", Value: `{"at":"2026-08-09T10:00:00Z","note":"a-b","ratio":":"}`}
	for _, q := range []string{"2026-08-09", `"2026-08-09T10:00:00Z"`, "a-b", "-"} {
		if !match(t, q, MatchValue, m) {
			t.Errorf("%q should have matched as a plain term", q)
		}
	}
	// at: with a value is a field lookup, and resolves
	if !match(t, "at:2026-08-09", MatchValue, m) {
		t.Error("at:2026-08-09 should resolve as a field lookup")
	}
}

func TestFieldLookupReadsNestedObjectsWhole(t *testing.T) {
	m := orderMsg()
	// naming an object compares against its JSON, so a broad search still hits
	if !match(t, "customer:Lovelace", MatchValue, m) {
		t.Error("naming an object should search its encoded form")
	}
	if !match(t, "items:y-9", MatchValue, m) {
		t.Error("naming an array should search its encoded form")
	}
}

func TestBooleanAndNullLeaves(t *testing.T) {
	m := MsgFields{Key: "k", Value: `{"paid":true,"cancelledAt":null,"count":0}`}
	if !match(t, "paid=true", MatchValue, m) {
		t.Error("boolean leaf")
	}
	if match(t, "paid=false", MatchValue, m) {
		t.Error("boolean leaf, wrong value")
	}
	if !match(t, "cancelledAt=null", MatchValue, m) {
		t.Error("null leaf")
	}
	// 0 must not be confused with absent
	if !match(t, "count=0", MatchValue, m) {
		t.Error("zero is a value")
	}
	if !match(t, "count:<1", MatchValue, m) {
		t.Error("zero compares numerically")
	}
}

func TestJSONIsParsedOncePerMessage(t *testing.T) {
	m := orderMsg()
	q, err := ParseQuery("status:held AND city:Pune AND amount:>100", MatchValue)
	if err != nil {
		t.Fatal(err)
	}
	if !q.Match(&m) {
		t.Fatal("expected a match")
	}
	if !m.didParse || !m.parsedOK {
		t.Fatal("the payload should have been parsed and cached")
	}
	// a second run reuses the cached document rather than decoding again
	m.parsed = map[string]any{"status": "different"}
	if q.Match(&m) {
		t.Error("the cached document should have been reused, not re-parsed")
	}
}

// A malformed query must be reported as a query problem, immediately, rather
// than sending the developer off to a broker and timing out there.
func TestConsumeRejectsABadQueryBeforeDialling(t *testing.T) {
	// 203.0.113.0/24 is TEST-NET-3: reserved, and guaranteed not to answer.
	// If the query were parsed after the connection, this would hang.
	conn := KafkaConn{Brokers: "203.0.113.1:9092", TimeoutMs: 1000}
	start := time.Now()
	_, err := KafkaConsume(KafkaConsumeRequest{
		Conn: conn, Topic: "orders", ValueQuery: "(status:held",
	})
	if err == nil {
		t.Fatal("expected an error for an unclosed bracket")
	}
	if !strings.Contains(err.Error(), "value search") {
		t.Errorf("error should name the value box, got: %v", err)
	}
	if !strings.Contains(err.Error(), "bracket") {
		t.Errorf("error should say what is wrong, got: %v", err)
	}
	if elapsed := time.Since(start); elapsed > 2*time.Second {
		t.Errorf("took %s — the query was parsed after dialling", elapsed)
	}

	if _, err := KafkaConsume(KafkaConsumeRequest{
		Conn: conn, Topic: "orders", KeyQuery: "NOT",
	}); err == nil || !strings.Contains(err.Error(), "key search") {
		t.Errorf("a bad key query should name the key box, got: %v", err)
	}
}
