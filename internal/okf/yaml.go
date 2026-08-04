package okf

import (
	"sort"
	"strings"

	"gopkg.in/yaml.v3"
)

// parseYAML decodes a frontmatter block into a generic map. Parsing is
// forgiving on purpose: the spec tells consumers not to reject a document
// for unknown keys, so anything that fails to decode yields an empty map
// and lets the caller treat the document as untyped rather than erroring.
func parseYAML(src string) map[string]any {
	var raw map[string]any
	if err := yaml.Unmarshal([]byte(src), &raw); err != nil || raw == nil {
		return map[string]any{}
	}
	return normalize(raw).(map[string]any)
}

// normalize converts yaml.v3's map[string]any / []any tree into values that
// round-trip through encoding/json unchanged, so frontmatter can be handed
// straight to an HTTP or MCP client.
func normalize(v any) any {
	switch x := v.(type) {
	case map[string]any:
		out := make(map[string]any, len(x))
		for k, val := range x {
			out[k] = normalize(val)
		}
		return out
	case map[any]any: // older-style keys
		out := make(map[string]any, len(x))
		for k, val := range x {
			out[toString(k)] = normalize(val)
		}
		return out
	case []any:
		out := make([]any, len(x))
		for i, val := range x {
			out[i] = normalize(val)
		}
		return out
	case int:
		return float64(x)
	case int64:
		return float64(x)
	case uint64:
		return float64(x)
	}
	return v
}

func toString(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	b, _ := yaml.Marshal(v)
	return strings.TrimSpace(string(b))
}

// fieldOrder puts the spec's own fields first and in the order the
// specification introduces them, so hand-written and generated documents
// look the same in a diff. Unknown producer keys follow, sorted.
var fieldOrder = []string{
	"okf_version",
	"type", "title", "description", "resource", "tags",
	"sources", "usage_window",
	"generated", "verified",
	"status", "stale_after",
	"runtime", "parameters", "computation", "executor", "attester",
}

func marshalFrontmatter(fm map[string]any) string {
	if len(fm) == 0 {
		return ""
	}
	rank := make(map[string]int, len(fieldOrder))
	for i, k := range fieldOrder {
		rank[k] = i
	}
	keys := make([]string, 0, len(fm))
	for k := range fm {
		keys = append(keys, k)
	}
	sort.Slice(keys, func(i, j int) bool {
		ri, oki := rank[keys[i]]
		rj, okj := rank[keys[j]]
		switch {
		case oki && okj:
			return ri < rj
		case oki:
			return true
		case okj:
			return false
		}
		return keys[i] < keys[j]
	})

	var b strings.Builder
	enc := yaml.NewEncoder(&b)
	enc.SetIndent(2)
	node := &yaml.Node{Kind: yaml.MappingNode}
	for _, k := range keys {
		kn := &yaml.Node{Kind: yaml.ScalarNode, Value: k}
		vn := &yaml.Node{}
		if err := vn.Encode(fm[k]); err != nil {
			continue
		}
		node.Content = append(node.Content, kn, vn)
	}
	if err := enc.Encode(node); err != nil {
		return ""
	}
	enc.Close()
	out := b.String()
	if !strings.HasSuffix(out, "\n") {
		out += "\n"
	}
	return out
}
