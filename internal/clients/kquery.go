package clients

import (
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
)

// A search box that only does "substring of the whole payload" stops being
// useful the moment payloads are JSON: searching `8837` matches an order id,
// a customer id and a timestamp alike, and there is no way to say "status is
// held AND amount is over 100".
//
// So the key and value boxes take a small query language instead:
//
//	held                     substring
//	"order held"             phrase (spaces kept)
//	status:held              the JSON field `status` contains "held"
//	customer.city:Pune       a dotted path
//	amount:>100              numeric comparison (> >= < <= =)
//	status=held              exact match, not substring
//	status:held AND amount:>100
//	status:held OR status:cancelled
//	NOT status:shipped       also -status:shipped
//	(a OR b) AND NOT c
//
// Bare terms are ANDed, so `held urgent` means both. A field that is not
// present never matches — including under NOT, where "not present" makes the
// NOT true.
//
// Anything that is not valid JSON still works for bare terms and phrases;
// field lookups simply do not match, which is honest rather than surprising.

// MatchTarget is what a bare term searches when the query does not name a
// field: the message key or its value.
type MatchTarget int

const (
	MatchValue MatchTarget = iota
	MatchKey
)

// Query is a parsed search expression, ready to run against many messages.
type Query struct {
	root   node
	target MatchTarget
	empty  bool
}

// MsgFields is the part of a message a query can see.
type MsgFields struct {
	Key     string
	Value   string
	Headers []KafkaHeader

	// parsed lazily, once per message, and only if a field lookup needs it
	parsed   any
	parsedOK bool
	didParse bool
}

func (m *MsgFields) json() (any, bool) {
	if !m.didParse {
		m.didParse = true
		var v any
		if json.Unmarshal([]byte(m.Value), &v) == nil {
			m.parsed, m.parsedOK = v, true
		}
	}
	return m.parsed, m.parsedOK
}

type node interface {
	match(m *MsgFields, target MatchTarget) bool
}

type andNode struct{ kids []node }
type orNode struct{ kids []node }
type notNode struct{ kid node }

// termNode is a bare word or phrase: a substring of the key or the value,
// whichever the box is searching.
type termNode struct{ text string }

// fieldNode is `name:value`. name is a dotted path into the JSON payload, or
// one of the reserved names below.
type fieldNode struct {
	path  []string
	op    string // "contains" | "eq" | ">" | ">=" | "<" | "<="
	text  string
	num   float64
	isNum bool
}

func (n *andNode) match(m *MsgFields, t MatchTarget) bool {
	for _, k := range n.kids {
		if !k.match(m, t) {
			return false
		}
	}
	return true
}

func (n *orNode) match(m *MsgFields, t MatchTarget) bool {
	for _, k := range n.kids {
		if k.match(m, t) {
			return true
		}
	}
	return false
}

func (n *notNode) match(m *MsgFields, t MatchTarget) bool { return !n.kid.match(m, t) }

func (n *termNode) match(m *MsgFields, t MatchTarget) bool {
	hay := m.Value
	if t == MatchKey {
		hay = m.Key
	}
	return strings.Contains(strings.ToLower(hay), n.text)
}

// Reserved field names. `key:` and `header.x:` reach parts of the record that
// are not in the payload at all; to search a JSON field genuinely called
// "key", write `value.key:`.
const (
	fieldKey    = "key"
	fieldValue  = "value"
	fieldHeader = "header"
)

func (n *fieldNode) match(m *MsgFields, _ MatchTarget) bool {
	for _, cand := range n.candidates(m) {
		if n.compare(cand) {
			return true
		}
	}
	return false
}

// candidates returns every value the field name resolves to. A dotted path is
// tried first; failing that the name is looked up as a key at any depth, so
// `city:Pune` finds `customer.city` without the caller knowing the shape.
func (n *fieldNode) candidates(m *MsgFields) []string {
	switch strings.ToLower(n.path[0]) {
	case fieldKey:
		if len(n.path) == 1 {
			return []string{m.Key}
		}
	case fieldHeader:
		if len(n.path) == 2 {
			var out []string
			for _, h := range m.Headers {
				if strings.EqualFold(h.Key, n.path[1]) {
					out = append(out, h.Value)
				}
			}
			return out
		}
	case fieldValue:
		if len(n.path) == 1 {
			return []string{m.Value}
		}
		doc, ok := m.json()
		if !ok {
			return nil
		}
		return resolvePath(doc, n.path[1:])
	}
	doc, ok := m.json()
	if !ok {
		return nil
	}
	if hits := resolvePath(doc, n.path); len(hits) > 0 {
		return hits
	}
	if len(n.path) == 1 {
		return searchAnyDepth(doc, n.path[0])
	}
	return nil
}

func (n *fieldNode) compare(got string) bool {
	switch n.op {
	case "eq":
		return strings.EqualFold(strings.TrimSpace(got), n.text)
	case ">", ">=", "<", "<=":
		if !n.isNum {
			return false
		}
		v, err := strconv.ParseFloat(strings.TrimSpace(got), 64)
		if err != nil {
			return false
		}
		switch n.op {
		case ">":
			return v > n.num
		case ">=":
			return v >= n.num
		case "<":
			return v < n.num
		default:
			return v <= n.num
		}
	default:
		return strings.Contains(strings.ToLower(got), n.text)
	}
}

// resolvePath walks a dotted path. An array in the middle of a path is
// searched element-wise, so `items.sku:x` matches any item.
func resolvePath(doc any, path []string) []string {
	if len(path) == 0 {
		return []string{leafString(doc)}
	}
	switch v := doc.(type) {
	case map[string]any:
		for k, child := range v {
			if strings.EqualFold(k, path[0]) {
				return resolvePath(child, path[1:])
			}
		}
	case []any:
		var out []string
		for _, item := range v {
			out = append(out, resolvePath(item, path)...)
		}
		return out
	}
	return nil
}

// searchAnyDepth finds every value under a key of this name, at any depth.
func searchAnyDepth(doc any, name string) []string {
	var out []string
	var walk func(any)
	walk = func(d any) {
		switch v := d.(type) {
		case map[string]any:
			for k, child := range v {
				if strings.EqualFold(k, name) {
					out = append(out, leafString(child))
				}
				walk(child)
			}
		case []any:
			for _, item := range v {
				walk(item)
			}
		}
	}
	walk(doc)
	return out
}

// leafString renders a JSON value for comparison. Objects and arrays are
// re-encoded so `customer:Pune` can still match a nested blob.
func leafString(v any) string {
	switch t := v.(type) {
	case nil:
		return "null"
	case string:
		return t
	case bool:
		return strconv.FormatBool(t)
	case float64:
		return strconv.FormatFloat(t, 'f', -1, 64)
	default:
		b, err := json.Marshal(t)
		if err != nil {
			return fmt.Sprint(t)
		}
		return string(b)
	}
}

// ---------------------------------------------------------------- parsing

type token struct {
	kind string // word | phrase | punct
	text string
}

func tokenize(s string) []token {
	var out []token
	runes := []rune(s)
	for i := 0; i < len(runes); {
		c := runes[i]
		switch {
		case c == ' ' || c == '\t' || c == '\n' || c == '\r':
			i++
		case c == '(' || c == ')':
			out = append(out, token{"punct", string(c)})
			i++
		case c == '"' || c == '\'':
			quote := c
			i++
			var b strings.Builder
			for i < len(runes) && runes[i] != quote {
				if runes[i] == '\\' && i+1 < len(runes) {
					i++
				}
				b.WriteRune(runes[i])
				i++
			}
			if i < len(runes) {
				i++ // closing quote
			}
			out = append(out, token{"phrase", b.String()})
		default:
			var b strings.Builder
			for i < len(runes) && !strings.ContainsRune(" \t\n\r()", runes[i]) {
				// a quote directly after a field separator starts a phrase
				// that belongs to this word: status:"on hold"
				if (runes[i] == '"' || runes[i] == '\'') && b.Len() > 0 {
					quote := runes[i]
					i++
					for i < len(runes) && runes[i] != quote {
						if runes[i] == '\\' && i+1 < len(runes) {
							i++
						}
						b.WriteRune(runes[i])
						i++
					}
					if i < len(runes) {
						i++
					}
					continue
				}
				b.WriteRune(runes[i])
				i++
			}
			out = append(out, token{"word", b.String()})
		}
	}
	return out
}

type parser struct {
	toks []token
	i    int
}

func (p *parser) peek() (token, bool) {
	if p.i < len(p.toks) {
		return p.toks[p.i], true
	}
	return token{}, false
}

func (p *parser) isKeyword(t token, words ...string) bool {
	if t.kind != "word" {
		return false
	}
	for _, w := range words {
		if strings.EqualFold(t.text, w) {
			return true
		}
	}
	return false
}

func (p *parser) parseOr() (node, error) {
	left, err := p.parseAnd()
	if err != nil {
		return nil, err
	}
	kids := []node{left}
	for {
		t, ok := p.peek()
		if !ok || !(p.isKeyword(t, "OR") || t.text == "||") {
			break
		}
		p.i++
		right, err := p.parseAnd()
		if err != nil {
			return nil, err
		}
		kids = append(kids, right)
	}
	if len(kids) == 1 {
		return kids[0], nil
	}
	return &orNode{kids}, nil
}

func (p *parser) parseAnd() (node, error) {
	var kids []node
	for {
		t, ok := p.peek()
		if !ok || (t.kind == "punct" && t.text == ")") {
			break
		}
		if p.isKeyword(t, "OR") || t.text == "||" {
			break
		}
		if p.isKeyword(t, "AND") || t.text == "&&" {
			// terms are ANDed anyway, so an explicit AND only has to be
			// consumed — but a dangling one is a typo, not a no-op
			p.i++
			next, ok := p.peek()
			if !ok || next.text == ")" || p.isKeyword(next, "AND", "OR") {
				return nil, fmt.Errorf("%q needs a term after it", t.text)
			}
			continue
		}
		kid, err := p.parseUnary()
		if err != nil {
			return nil, err
		}
		kids = append(kids, kid)
	}
	if len(kids) == 0 {
		return nil, fmt.Errorf("expected a search term")
	}
	if len(kids) == 1 {
		return kids[0], nil
	}
	return &andNode{kids}, nil
}

func (p *parser) parseUnary() (node, error) {
	t, ok := p.peek()
	if !ok {
		return nil, fmt.Errorf("expected a search term")
	}
	if p.isKeyword(t, "NOT") || t.text == "!" {
		p.i++
		kid, err := p.parseUnary()
		if err != nil {
			return nil, err
		}
		return &notNode{kid}, nil
	}
	// a leading "-" negates, but only when something follows it — "-" alone,
	// or a term that merely starts with a hyphen, is just text
	if t.kind == "word" && strings.HasPrefix(t.text, "-") && len(t.text) > 1 {
		p.toks[p.i].text = strings.TrimPrefix(t.text, "-")
		kid, err := p.parseUnary()
		if err != nil {
			return nil, err
		}
		return &notNode{kid}, nil
	}
	return p.parseAtom()
}

func (p *parser) parseAtom() (node, error) {
	t, ok := p.peek()
	if !ok {
		return nil, fmt.Errorf("expected a search term")
	}
	if t.kind == "punct" {
		if t.text != "(" {
			return nil, fmt.Errorf("unexpected %q", t.text)
		}
		p.i++
		inner, err := p.parseOr()
		if err != nil {
			return nil, err
		}
		next, ok := p.peek()
		if !ok || next.text != ")" {
			return nil, fmt.Errorf("missing a closing bracket")
		}
		p.i++
		return inner, nil
	}
	p.i++
	if t.kind == "phrase" {
		return &termNode{strings.ToLower(t.text)}, nil
	}
	if n := parseFieldTerm(t.text); n != nil {
		return n, nil
	}
	return &termNode{strings.ToLower(t.text)}, nil
}

// parseFieldTerm turns `path:value`, `path=value` or `path:>value` into a
// field test, or returns nil when the word has no separator and is an
// ordinary term.
func parseFieldTerm(word string) node {
	sep := strings.IndexAny(word, ":=")
	// a leading separator ( ":foo" ) has no field name, so it is just text
	if sep <= 0 || sep == len(word)-1 {
		return nil
	}
	name, rest := word[:sep], word[sep+1:]
	op := "contains"
	if word[sep] == '=' {
		op = "eq"
	}
	for _, cmp := range []string{">=", "<=", ">", "<", "="} {
		if strings.HasPrefix(rest, cmp) {
			rest = strings.TrimPrefix(rest, cmp)
			if cmp == "=" {
				op = "eq"
			} else {
				op = cmp
			}
			break
		}
	}
	if rest == "" {
		return nil
	}
	n := &fieldNode{path: strings.Split(name, "."), op: op, text: strings.ToLower(rest)}
	if v, err := strconv.ParseFloat(rest, 64); err == nil {
		n.num, n.isNum = v, true
	}
	return n
}

// ParseQuery compiles a search expression. An empty string is a query that
// matches everything, so callers can pass an unfilled search box straight in.
func ParseQuery(s string, target MatchTarget) (*Query, error) {
	if strings.TrimSpace(s) == "" {
		return &Query{empty: true, target: target}, nil
	}
	toks := tokenize(s)
	if len(toks) == 0 {
		return &Query{empty: true, target: target}, nil
	}
	p := &parser{toks: toks}
	root, err := p.parseOr()
	if err != nil {
		return nil, fmt.Errorf("search: %v", err)
	}
	if p.i < len(p.toks) {
		return nil, fmt.Errorf("search: unexpected %q", p.toks[p.i].text)
	}
	return &Query{root: root, target: target}, nil
}

// Match reports whether a message satisfies the query.
func (q *Query) Match(m *MsgFields) bool {
	if q == nil || q.empty {
		return true
	}
	return q.root.match(m, q.target)
}

// IsEmpty reports whether the query filters nothing, so callers can skip the
// wider scan window a real search needs.
func (q *Query) IsEmpty() bool { return q == nil || q.empty }
