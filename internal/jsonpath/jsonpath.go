// Package jsonpath evaluates JSONPath expressions against decoded JSON
// documents. It mirrors the engine the browser tool uses (web/js/tools.js) so
// an expression tried in the UI behaves the same when an agent runs it over
// MCP: dot and bracket children, wildcards, unions, slices, recursive descent
// and filter expressions with ==, !=, <, <=, >, >=, =~ and && / ||.
package jsonpath

import (
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// Match is one result: the value found and the normalised path to it.
type Match struct {
	Path  string `json:"path"`
	Value any    `json:"value"`
}

type stepKind int

const (
	stepChild stepKind = iota
	stepWild
	stepIndex
	stepSlice
	stepFilter
	stepDescend
)

type step struct {
	kind  stepKind
	names []string
	idx   []int
	start *int
	end   *int
	step  int
	pred  predicate
}

type predicate func(node any) bool

// Eval parses expr and runs it over doc, which must be the result of
// json.Unmarshal into an `any` (map[string]any, []any, and scalars).
func Eval(doc any, expr string) ([]Match, error) {
	steps, err := parse(expr)
	if err != nil {
		return nil, err
	}
	return run(doc, steps), nil
}

// ---------------------------------------------------------------- parsing

func parse(expr string) ([]step, error) {
	s := strings.TrimSpace(expr)
	if s == "" {
		return nil, fmt.Errorf("empty expression")
	}
	p := &parser{s: s}
	// "$" is the document root and "@" the current node inside a filter;
	// both are just the starting point for the steps that follow.
	if p.peek() == '$' || p.peek() == '@' {
		p.i++
	}
	var steps []step
	for p.i < len(p.s) {
		switch {
		case strings.HasPrefix(p.s[p.i:], ".."):
			p.i += 2
			steps = append(steps, step{kind: stepDescend})
			// "$..name" is a descent followed by a child selector; "$..[0]"
			// and "$..*" let the next loop iteration handle the selector.
			if p.i < len(p.s) && p.peek() != '[' && p.peek() != '*' {
				name, err := p.readName()
				if err != nil {
					return nil, err
				}
				steps = append(steps, step{kind: stepChild, names: []string{name}})
			}
		case p.peek() == '.':
			p.i++
			if p.peek() == '*' {
				p.i++
				steps = append(steps, step{kind: stepWild})
				continue
			}
			name, err := p.readName()
			if err != nil {
				return nil, err
			}
			steps = append(steps, step{kind: stepChild, names: []string{name}})
		case p.peek() == '*':
			p.i++
			steps = append(steps, step{kind: stepWild})
		case p.peek() == '[':
			p.i++
			st, err := p.readBracket()
			if err != nil {
				return nil, err
			}
			steps = append(steps, st)
		case len(steps) == 0:
			// tolerate "store.book" without a leading $
			name, err := p.readName()
			if err != nil {
				return nil, err
			}
			steps = append(steps, step{kind: stepChild, names: []string{name}})
		default:
			return nil, fmt.Errorf("unexpected %q at position %d", p.peek(), p.i)
		}
	}
	return steps, nil
}

type parser struct {
	s string
	i int
}

func (p *parser) peek() byte {
	if p.i >= len(p.s) {
		return 0
	}
	return p.s[p.i]
}

func (p *parser) ws() {
	for p.i < len(p.s) && (p.s[p.i] == ' ' || p.s[p.i] == '\t' || p.s[p.i] == '\n' || p.s[p.i] == '\r') {
		p.i++
	}
}

func isNameByte(c byte) bool {
	return c == '_' || c == '-' || c == '$' ||
		(c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')
}

func (p *parser) readName() (string, error) {
	start := p.i
	for p.i < len(p.s) && isNameByte(p.s[p.i]) {
		p.i++
	}
	if p.i == start {
		return "", fmt.Errorf("expected a property name at position %d", start)
	}
	return p.s[start:p.i], nil
}

func (p *parser) readQuoted() (string, error) {
	q := p.s[p.i]
	p.i++
	var b strings.Builder
	for p.i < len(p.s) && p.s[p.i] != q {
		if p.s[p.i] == '\\' {
			p.i++
			if p.i >= len(p.s) {
				break
			}
		}
		b.WriteByte(p.s[p.i])
		p.i++
	}
	if p.i >= len(p.s) {
		return "", fmt.Errorf("unterminated quoted name")
	}
	p.i++ // closing quote
	return b.String(), nil
}

// readBracket consumes everything up to and including the matching ']'.
func (p *parser) readBracket() (step, error) {
	p.ws()
	switch {
	case p.peek() == '*':
		p.i++
		return p.closeBracket(step{kind: stepWild})

	case p.peek() == '?':
		p.i++
		if p.peek() != '(' {
			return step{}, fmt.Errorf("expected '(' after '?'")
		}
		p.i++
		start := p.i
		depth := 1
		for p.i < len(p.s) && depth > 0 {
			switch p.s[p.i] {
			case '(':
				depth++
			case ')':
				depth--
			}
			if depth > 0 {
				p.i++
			}
		}
		if depth != 0 {
			return step{}, fmt.Errorf("unterminated filter expression")
		}
		pred, err := compileFilter(p.s[start:p.i])
		if err != nil {
			return step{}, err
		}
		p.i++ // past ')'
		return p.closeBracket(step{kind: stepFilter, pred: pred})

	case p.peek() == '\'' || p.peek() == '"':
		var names []string
		n, err := p.readQuoted()
		if err != nil {
			return step{}, err
		}
		names = append(names, n)
		for {
			p.ws()
			if p.peek() != ',' {
				break
			}
			p.i++
			p.ws()
			if p.peek() != '\'' && p.peek() != '"' {
				return step{}, fmt.Errorf("expected a quoted name after ','")
			}
			n, err := p.readQuoted()
			if err != nil {
				return step{}, err
			}
			names = append(names, n)
		}
		return p.closeBracket(step{kind: stepChild, names: names})
	}

	// indices, unions and slices
	start := p.i
	for p.i < len(p.s) && p.s[p.i] != ']' {
		p.i++
	}
	body := strings.TrimSpace(p.s[start:p.i])
	if body == "" {
		return step{}, fmt.Errorf("empty []")
	}
	if strings.Contains(body, ":") {
		parts := strings.Split(body, ":")
		st := step{kind: stepSlice, step: 1}
		num := func(raw string) (*int, error) {
			raw = strings.TrimSpace(raw)
			if raw == "" {
				return nil, nil
			}
			n, err := strconv.Atoi(raw)
			if err != nil {
				return nil, fmt.Errorf("%q is not a slice bound", raw)
			}
			return &n, nil
		}
		a, err := num(parts[0])
		if err != nil {
			return step{}, err
		}
		st.start = a
		if len(parts) > 1 {
			b, err := num(parts[1])
			if err != nil {
				return step{}, err
			}
			st.end = b
		}
		if len(parts) > 2 {
			c, err := num(parts[2])
			if err != nil {
				return step{}, err
			}
			if c != nil && *c != 0 {
				st.step = *c
			}
		}
		return p.closeBracket(st)
	}
	st := step{kind: stepIndex}
	for _, raw := range strings.Split(body, ",") {
		n, err := strconv.Atoi(strings.TrimSpace(raw))
		if err != nil {
			return step{}, fmt.Errorf("%q is not an array index", strings.TrimSpace(raw))
		}
		st.idx = append(st.idx, n)
	}
	return p.closeBracket(st)
}

func (p *parser) closeBracket(st step) (step, error) {
	p.ws()
	if p.peek() != ']' {
		return step{}, fmt.Errorf("expected ']'")
	}
	p.i++
	return st, nil
}

// -------------------------------------------------------------- filters
//
// Recursive descent over: or := and ('||' and)*, and := cmp ('&&' cmp)*,
// cmp := '(' or ')' | operand [op operand]. No expression evaluation is
// delegated anywhere — the grammar below is the whole language.

type operand func(node any) any

type filterParser struct {
	s string
	i int
}

func compileFilter(src string) (predicate, error) {
	f := &filterParser{s: src}
	pred, err := f.parseOr()
	if err != nil {
		return nil, err
	}
	f.ws()
	if f.i < len(f.s) {
		return nil, fmt.Errorf("unexpected %q in filter", f.s[f.i])
	}
	return pred, nil
}

func (f *filterParser) ws() {
	for f.i < len(f.s) && (f.s[f.i] == ' ' || f.s[f.i] == '\t') {
		f.i++
	}
}

func (f *filterParser) peek() byte {
	if f.i >= len(f.s) {
		return 0
	}
	return f.s[f.i]
}

func (f *filterParser) parseOperand() (operand, error) {
	f.ws()
	switch c := f.peek(); {
	case c == '@' || c == '$':
		start := f.i
		f.i++
		for f.i < len(f.s) {
			ch := f.s[f.i]
			if ch == ']' {
				f.i++
				break
			}
			if ch == '.' || ch == '[' || ch == '\'' || ch == '"' || isNameByte(ch) {
				f.i++
				continue
			}
			break
		}
		steps, err := parse(f.s[start:f.i])
		if err != nil {
			return nil, err
		}
		return func(node any) any {
			hits := run(node, steps)
			if len(hits) == 0 {
				return nil
			}
			return hits[0].Value
		}, nil

	case c == '\'' || c == '"':
		q := c
		f.i++
		var b strings.Builder
		for f.i < len(f.s) && f.s[f.i] != q {
			if f.s[f.i] == '\\' {
				f.i++
				if f.i >= len(f.s) {
					break
				}
			}
			b.WriteByte(f.s[f.i])
			f.i++
		}
		f.i++
		lit := b.String()
		return func(any) any { return lit }, nil

	case c == '/': // regex literal, for =~
		f.i++
		start := f.i
		for f.i < len(f.s) && f.s[f.i] != '/' {
			if f.s[f.i] == '\\' {
				f.i++
			}
			f.i++
		}
		body := f.s[start:f.i]
		f.i++
		var flags string
		for f.i < len(f.s) && f.s[f.i] >= 'a' && f.s[f.i] <= 'z' {
			flags += string(f.s[f.i])
			f.i++
		}
		if strings.Contains(flags, "i") {
			body = "(?i)" + body
		}
		re, err := regexp.Compile(body)
		if err != nil {
			return nil, fmt.Errorf("bad regex in filter: %w", err)
		}
		return func(any) any { return re }, nil
	}

	start := f.i
	for f.i < len(f.s) && !strings.ContainsRune(" \t&|)=!<>~", rune(f.s[f.i])) {
		f.i++
	}
	lit := strings.TrimSpace(f.s[start:f.i])
	switch lit {
	case "true":
		return func(any) any { return true }, nil
	case "false":
		return func(any) any { return false }, nil
	case "null":
		return func(any) any { return nil }, nil
	}
	if lit == "" {
		return nil, fmt.Errorf("expected a value in filter")
	}
	if n, err := strconv.ParseFloat(lit, 64); err == nil {
		return func(any) any { return n }, nil
	}
	return func(any) any { return lit }, nil
}

var filterOps = []string{"==", "!=", "<=", ">=", "=~", "<", ">"}

func (f *filterParser) parseCmp() (predicate, error) {
	f.ws()
	if f.peek() == '(' {
		f.i++
		inner, err := f.parseOr()
		if err != nil {
			return nil, err
		}
		f.ws()
		if f.peek() != ')' {
			return nil, fmt.Errorf("expected ')' in filter")
		}
		f.i++
		return inner, nil
	}
	left, err := f.parseOperand()
	if err != nil {
		return nil, err
	}
	f.ws()
	op := ""
	for _, o := range filterOps {
		if strings.HasPrefix(f.s[f.i:], o) {
			op = o
			break
		}
	}
	if op == "" {
		// bare @.field — an existence test
		return func(node any) bool { return truthy(left(node)) }, nil
	}
	f.i += len(op)
	right, err := f.parseOperand()
	if err != nil {
		return nil, err
	}
	return func(node any) bool { return compare(op, left(node), right(node)) }, nil
}

func (f *filterParser) parseAnd() (predicate, error) {
	left, err := f.parseCmp()
	if err != nil {
		return nil, err
	}
	for {
		f.ws()
		if !strings.HasPrefix(f.s[f.i:], "&&") {
			return left, nil
		}
		f.i += 2
		right, err := f.parseCmp()
		if err != nil {
			return nil, err
		}
		l := left
		left = func(node any) bool { return l(node) && right(node) }
	}
}

func (f *filterParser) parseOr() (predicate, error) {
	left, err := f.parseAnd()
	if err != nil {
		return nil, err
	}
	for {
		f.ws()
		if !strings.HasPrefix(f.s[f.i:], "||") {
			return left, nil
		}
		f.i += 2
		right, err := f.parseAnd()
		if err != nil {
			return nil, err
		}
		l := left
		left = func(node any) bool { return l(node) || right(node) }
	}
}

func truthy(v any) bool {
	switch x := v.(type) {
	case nil:
		return false
	case bool:
		return x
	case float64:
		return x != 0
	case string:
		return x != ""
	}
	return true
}

func asNumber(v any) (float64, bool) {
	switch x := v.(type) {
	case float64:
		return x, true
	case int:
		return float64(x), true
	case string:
		n, err := strconv.ParseFloat(strings.TrimSpace(x), 64)
		return n, err == nil
	case bool:
		if x {
			return 1, true
		}
		return 0, true
	}
	return 0, false
}

// compare implements JSONPath's loose comparison: numbers and numeric
// strings compare numerically, everything else falls back to string form.
func compare(op string, a, b any) bool {
	if op == "=~" {
		re, ok := b.(*regexp.Regexp)
		s, isStr := a.(string)
		return ok && isStr && re.MatchString(s)
	}
	if op == "==" || op == "!=" {
		eq := looseEqual(a, b)
		if op == "==" {
			return eq
		}
		return !eq
	}
	an, aok := asNumber(a)
	bn, bok := asNumber(b)
	if !aok || !bok {
		as, bs := stringOf(a), stringOf(b)
		switch op {
		case "<":
			return as < bs
		case "<=":
			return as <= bs
		case ">":
			return as > bs
		case ">=":
			return as >= bs
		}
		return false
	}
	switch op {
	case "<":
		return an < bn
	case "<=":
		return an <= bn
	case ">":
		return an > bn
	case ">=":
		return an >= bn
	}
	return false
}

func looseEqual(a, b any) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	if an, ok := asNumber(a); ok {
		if bn, ok2 := asNumber(b); ok2 {
			return an == bn
		}
	}
	return stringOf(a) == stringOf(b)
}

func stringOf(v any) string {
	switch x := v.(type) {
	case nil:
		return ""
	case string:
		return x
	case float64:
		return strconv.FormatFloat(x, 'f', -1, 64)
	case bool:
		return strconv.FormatBool(x)
	}
	return fmt.Sprintf("%v", v)
}

// ------------------------------------------------------------ evaluation

func seg(key any) string {
	switch k := key.(type) {
	case int:
		return "[" + strconv.Itoa(k) + "]"
	default:
		return "['" + fmt.Sprintf("%v", k) + "']"
	}
}

// keysOf returns an object's keys in a stable order. JSON objects have no
// inherent ordering once decoded into a Go map, so sorting keeps results
// reproducible between runs rather than shuffling on every call.
func keysOf(m map[string]any) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func run(doc any, steps []step) []Match {
	cur := []Match{{Path: "$", Value: doc}}
	for _, st := range steps {
		var next []Match
		for _, node := range cur {
			next = applyStep(st, node, next)
		}
		cur = next
	}
	return cur
}

func applyStep(st step, node Match, next []Match) []Match {
	v := node.Value
	switch st.kind {
	case stepChild:
		for _, name := range st.names {
			if m, ok := v.(map[string]any); ok {
				if val, found := m[name]; found {
					next = append(next, Match{Path: node.Path + seg(name), Value: val})
					continue
				}
			}
			// .length on arrays and strings, matching the browser tool
			if name == "length" {
				switch x := v.(type) {
				case []any:
					next = append(next, Match{Path: node.Path + seg("length"), Value: float64(len(x))})
				case string:
					next = append(next, Match{Path: node.Path + seg("length"), Value: float64(len(x))})
				}
			}
		}

	case stepWild:
		switch x := v.(type) {
		case []any:
			for k, item := range x {
				next = append(next, Match{Path: node.Path + seg(k), Value: item})
			}
		case map[string]any:
			for _, k := range keysOf(x) {
				next = append(next, Match{Path: node.Path + seg(k), Value: x[k]})
			}
		}

	case stepIndex:
		if arr, ok := v.([]any); ok {
			for _, raw := range st.idx {
				k := raw
				if k < 0 {
					k += len(arr)
				}
				if k >= 0 && k < len(arr) {
					next = append(next, Match{Path: node.Path + seg(k), Value: arr[k]})
				}
			}
		}

	case stepSlice:
		if arr, ok := v.([]any); ok {
			next = append(next, sliceMatches(st, node, arr)...)
		}

	case stepFilter:
		test := func(val any, path string) []Match {
			if st.pred(val) {
				return []Match{{Path: path, Value: val}}
			}
			return nil
		}
		switch x := v.(type) {
		case []any:
			for k, item := range x {
				next = append(next, test(item, node.Path+seg(k))...)
			}
		case map[string]any:
			for _, k := range keysOf(x) {
				next = append(next, test(x[k], node.Path+seg(k))...)
			}
		}

	case stepDescend:
		next = append(next, descend(v, node.Path)...)
	}
	return next
}

func sliceMatches(st step, node Match, arr []any) []Match {
	var out []Match
	n := len(arr)
	stp := st.step
	if stp == 0 {
		stp = 1
	}
	bound := func(p *int, whenNil int) int {
		if p == nil {
			return whenNil
		}
		if *p < 0 {
			return n + *p
		}
		return *p
	}
	if stp > 0 {
		a, b := bound(st.start, 0), bound(st.end, n)
		for k := max(0, a); k < min(n, b); k += stp {
			out = append(out, Match{Path: node.Path + seg(k), Value: arr[k]})
		}
	} else {
		a, b := bound(st.start, n-1), bound(st.end, -1)
		for k := min(n-1, a); k > max(-1, b); k += stp {
			out = append(out, Match{Path: node.Path + seg(k), Value: arr[k]})
		}
	}
	return out
}

// descend yields the node itself and every descendant, in document order.
func descend(v any, path string) []Match {
	out := []Match{{Path: path, Value: v}}
	switch x := v.(type) {
	case []any:
		for k, item := range x {
			out = append(out, descend(item, path+seg(k))...)
		}
	case map[string]any:
		for _, k := range keysOf(x) {
			out = append(out, descend(x[k], path+seg(k))...)
		}
	}
	return out
}
