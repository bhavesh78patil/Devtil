package jsonpath

import (
	"encoding/json"
	"testing"
)

const doc = `{
  "store": {
    "book": [
      {"category": "reference", "author": "Nigel Rees", "title": "Sayings of the Century", "price": 8.95},
      {"category": "fiction", "author": "Evelyn Waugh", "title": "Sword of Honour", "price": 12.99},
      {"category": "fiction", "author": "Herman Melville", "title": "Moby Dick", "isbn": "0-553-21311-3", "price": 8.99},
      {"category": "fiction", "author": "J. R. R. Tolkien", "title": "The Lord of the Rings", "isbn": "0-395-19395-8", "price": 22.99}
    ],
    "bicycle": {"color": "red", "price": 19.95}
  },
  "expensive": 10
}`

func parseDoc(t *testing.T) any {
	t.Helper()
	var v any
	if err := json.Unmarshal([]byte(doc), &v); err != nil {
		t.Fatalf("fixture is not valid JSON: %v", err)
	}
	return v
}

func values(t *testing.T, expr string) []any {
	t.Helper()
	hits, err := Eval(parseDoc(t), expr)
	if err != nil {
		t.Fatalf("Eval(%q): %v", expr, err)
	}
	out := make([]any, 0, len(hits))
	for _, h := range hits {
		out = append(out, h.Value)
	}
	return out
}

func jsonOf(t *testing.T, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// The expressions here are the ones the UI advertises as examples, so a
// developer who tries one in the browser gets the same answer from an agent.
func TestEval(t *testing.T) {
	cases := []struct {
		expr string
		want string
	}{
		{"$.store.book[*].author", `["Nigel Rees","Evelyn Waugh","Herman Melville","J. R. R. Tolkien"]`},
		{"$..author", `["Nigel Rees","Evelyn Waugh","Herman Melville","J. R. R. Tolkien"]`},
		{"$..book[2].title", `["Moby Dick"]`},
		{"$..book[-1].title", `["The Lord of the Rings"]`},
		{"$..book[0,1].title", `["Sayings of the Century","Sword of Honour"]`},
		{"$..book[:2].title", `["Sayings of the Century","Sword of Honour"]`},
		{"$..book[1:3].title", `["Sword of Honour","Moby Dick"]`},
		{"$..book[?(@.isbn)].title", `["Moby Dick","The Lord of the Rings"]`},
		{"$..book[?(@.price < 10)].title", `["Sayings of the Century","Moby Dick"]`},
		{"$..book[?(@.category == 'fiction' && @.price > 10)].author", `["Evelyn Waugh","J. R. R. Tolkien"]`},
		{"$..book[?(@.category == 'reference' || @.price > 20)].author", `["Nigel Rees","J. R. R. Tolkien"]`},
		{"$..book[?(@.author =~ /tolkien/i)].author", `["J. R. R. Tolkien"]`},
		{"$..book[?(@.price != 8.99)].price", `[8.95,12.99,22.99]`},
		{"$..book.length", `[4]`},
		{"$.store.bicycle.color", `["red"]`},
		{"$['store']['bicycle']['price']", `[19.95]`},
		{"$.expensive", `[10]`},
		{"$..book[?(@.price >= 8.99 && @.price <= 12.99)].title", `["Sword of Honour","Moby Dick"]`},
		// no match is an empty result, not an error
		{"$.store.nothing", `[]`},
		{"$..book[99]", `[]`},
		// a path without the leading $ is tolerated, as in the browser tool
		{"store.bicycle.color", `["red"]`},
	}
	for _, c := range cases {
		got := jsonOf(t, values(t, c.expr))
		if got != c.want {
			t.Errorf("%s\n got: %s\nwant: %s", c.expr, got, c.want)
		}
	}
}

func TestEvalPaths(t *testing.T) {
	hits, err := Eval(parseDoc(t), "$..book[0].author")
	if err != nil {
		t.Fatal(err)
	}
	if len(hits) != 1 {
		t.Fatalf("want 1 hit, got %d", len(hits))
	}
	if want := "$['store']['book'][0]['author']"; hits[0].Path != want {
		t.Errorf("path = %q, want %q", hits[0].Path, want)
	}
}

func TestWildcardAndDescendOrderIsStable(t *testing.T) {
	// Object key order is undefined in a Go map, so the engine sorts; without
	// that, repeated calls would shuffle results.
	first := jsonOf(t, values(t, "$.store.bicycle.*"))
	for i := 0; i < 20; i++ {
		if got := jsonOf(t, values(t, "$.store.bicycle.*")); got != first {
			t.Fatalf("wildcard order is not stable: %s vs %s", got, first)
		}
	}
}

func TestEvalErrors(t *testing.T) {
	for _, expr := range []string{
		"",
		"$.[",
		"$..book[]",
		"$..book[?(@.price >)]",
		"$..book[?(@.price > 1]",
		"$..book[abc]",
	} {
		if _, err := Eval(parseDoc(t), expr); err == nil {
			t.Errorf("Eval(%q) should have failed", expr)
		}
	}
}

func TestFilterOnNonArray(t *testing.T) {
	// Filters apply to object values too, matching the browser engine.
	var v any
	if err := json.Unmarshal([]byte(`{"a":{"x":{"n":1},"y":{"n":5}}}`), &v); err != nil {
		t.Fatal(err)
	}
	hits, err := Eval(v, "$.a[?(@.n > 3)].n")
	if err != nil {
		t.Fatal(err)
	}
	if got := jsonOf(t, hits[0].Value); got != "5" {
		t.Errorf("got %s, want 5", got)
	}
}
