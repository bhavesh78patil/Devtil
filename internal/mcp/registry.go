package mcp

import (
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"
)

// Tool is one callable exposed over MCP.
type Tool struct {
	Name        string
	Title       string
	Description string
	// Schema is the JSON Schema for the tool's arguments.
	Schema map[string]any
	// ReadOnly marks a tool that never changes anything, so an agent host
	// can auto-approve it. Anything that writes — produce, insert, exec —
	// leaves this false.
	ReadOnly bool
	Run      func(a Args) (any, error)
}

func (s *Server) register(t *Tool) {
	if _, dup := s.tools[t.Name]; dup {
		panic("mcp: duplicate tool " + t.Name)
	}
	s.tools[t.Name] = t
	s.order = append(s.order, t.Name)
}

func (s *Server) toolDescriptors() []map[string]any {
	names := append([]string(nil), s.order...)
	sort.Strings(names)
	out := make([]map[string]any, 0, len(names))
	for _, n := range names {
		t := s.tools[n]
		schema := t.Schema
		if schema == nil {
			schema = obj(nil)
		}
		out = append(out, map[string]any{
			"name":        t.Name,
			"title":       t.Title,
			"description": t.Description,
			"inputSchema": schema,
			"annotations": map[string]any{
				"title":         t.Title,
				"readOnlyHint":  t.ReadOnly,
				"openWorldHint": !t.ReadOnly,
			},
		})
	}
	return out
}

func (s *Server) callTool(params json.RawMessage) (any, *rpcError) {
	var p struct {
		Name      string         `json:"name"`
		Arguments map[string]any `json:"arguments"`
	}
	if len(params) > 0 {
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, &rpcError{Code: codeInvalidParams, Message: "bad params: " + err.Error()}
		}
	}
	t, ok := s.tools[p.Name]
	if !ok {
		return nil, &rpcError{Code: codeInvalidParams, Message: "unknown tool " + p.Name}
	}
	if p.Arguments == nil {
		p.Arguments = map[string]any{}
	}

	result, err := t.Run(Args{m: p.Arguments})
	if err != nil {
		// A tool that fails reports it in the result, not as a protocol
		// error: the model needs to see the message and decide what to do.
		return map[string]any{
			"content": []any{textContent(err.Error())},
			"isError": true,
		}, nil
	}
	return toolResult(result), nil
}

// toolResult renders a tool's return value as MCP content. Text results stay
// text; anything structured is returned both as pretty JSON (for models that
// only read content) and as structuredContent (for hosts that parse it).
func toolResult(v any) map[string]any {
	if s, ok := v.(string); ok {
		return map[string]any{"content": []any{textContent(s)}, "isError": false}
	}
	data, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return map[string]any{"content": []any{textContent(fmt.Sprintf("%v", v))}, "isError": false}
	}
	res := map[string]any{"content": []any{textContent(string(data))}, "isError": false}
	// structuredContent must be an object; wrap anything else.
	switch v.(type) {
	case map[string]any:
		res["structuredContent"] = v
	default:
		res["structuredContent"] = map[string]any{"result": v}
	}
	return res
}

func textContent(s string) map[string]any {
	return map[string]any{"type": "text", "text": s}
}

// ------------------------------------------------------------ arguments

// Args wraps a tool's decoded arguments with typed accessors that coerce the
// way JSON-RPC clients actually send values — models routinely send "50" for
// a number and "true" for a boolean.
type Args struct{ m map[string]any }

func (a Args) Has(key string) bool {
	v, ok := a.m[key]
	return ok && v != nil
}

func (a Args) Raw(key string) any { return a.m[key] }

func (a Args) Str(key string) string {
	switch v := a.m[key].(type) {
	case nil:
		return ""
	case string:
		return v
	case float64:
		return strconv.FormatFloat(v, 'f', -1, 64)
	case bool:
		return strconv.FormatBool(v)
	default:
		b, _ := json.Marshal(v)
		return string(b)
	}
}

// Require returns a trimmed value or an error naming the missing argument.
func (a Args) Require(key string) (string, error) {
	s := strings.TrimSpace(a.Str(key))
	if s == "" {
		return "", fmt.Errorf("%q is required", key)
	}
	return s, nil
}

func (a Args) Int(key string, def int) int {
	switch v := a.m[key].(type) {
	case float64:
		return int(v)
	case int:
		return v
	case string:
		if n, err := strconv.Atoi(strings.TrimSpace(v)); err == nil {
			return n
		}
	}
	return def
}

func (a Args) Int64(key string, def int64) int64 {
	switch v := a.m[key].(type) {
	case float64:
		return int64(v)
	case string:
		if n, err := strconv.ParseInt(strings.TrimSpace(v), 10, 64); err == nil {
			return n
		}
	}
	return def
}

func (a Args) Bool(key string, def bool) bool {
	switch v := a.m[key].(type) {
	case bool:
		return v
	case string:
		if b, err := strconv.ParseBool(strings.TrimSpace(v)); err == nil {
			return b
		}
	case float64:
		return v != 0
	}
	return def
}

func (a Args) StrSlice(key string) []string {
	switch v := a.m[key].(type) {
	case nil:
		return nil
	case string:
		if strings.TrimSpace(v) == "" {
			return nil
		}
		parts := strings.Split(v, ",")
		out := make([]string, 0, len(parts))
		for _, p := range parts {
			if p = strings.TrimSpace(p); p != "" {
				out = append(out, p)
			}
		}
		return out
	case []any:
		out := make([]string, 0, len(v))
		for _, item := range v {
			if s, ok := item.(string); ok && strings.TrimSpace(s) != "" {
				out = append(out, s)
			}
		}
		return out
	}
	return nil
}

// Map returns an object-valued argument.
func (a Args) Map(key string) map[string]any {
	if m, ok := a.m[key].(map[string]any); ok {
		return m
	}
	return nil
}

// StrMap returns an object argument with every value stringified — used for
// header maps, where a model may send numbers.
func (a Args) StrMap(key string) map[string]string {
	m := a.Map(key)
	if m == nil {
		return nil
	}
	out := make(map[string]string, len(m))
	for k, v := range m {
		out[k] = Args{m: map[string]any{"v": v}}.Str("v")
	}
	return out
}

// ------------------------------------------------------- schema helpers

func obj(props map[string]any, required ...string) map[string]any {
	if props == nil {
		props = map[string]any{}
	}
	s := map[string]any{"type": "object", "properties": props}
	if len(required) > 0 {
		s["required"] = required
	}
	return s
}

func str(desc string) map[string]any { return map[string]any{"type": "string", "description": desc} }

func enum(desc string, values ...string) map[string]any {
	vals := make([]any, len(values))
	for i, v := range values {
		vals[i] = v
	}
	return map[string]any{"type": "string", "description": desc, "enum": vals}
}

func num(desc string) map[string]any { return map[string]any{"type": "number", "description": desc} }

func boolean(desc string) map[string]any {
	return map[string]any{"type": "boolean", "description": desc}
}

func strArray(desc string) map[string]any {
	return map[string]any{
		"type":        "array",
		"description": desc,
		"items":       map[string]any{"type": "string"},
	}
}

func objArg(desc string) map[string]any {
	return map[string]any{"type": "object", "description": desc}
}

// merge builds a property set from several groups, so connection fields can
// be shared across the tools that accept them.
func merge(groups ...map[string]any) map[string]any {
	out := map[string]any{}
	for _, g := range groups {
		for k, v := range g {
			out[k] = v
		}
	}
	return out
}
