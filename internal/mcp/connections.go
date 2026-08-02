package mcp

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"github.com/bhavesh78patil/devtil/internal/store"
)

// Saved connections live in the same state file the UI autosaves, so a
// connection the developer configured in Devtil is immediately usable by an
// agent — by name, without the agent ever seeing the credentials.
//
// The shape mirrors the UI: state.workspaces[].tabs[] where a tab of a given
// tool type carries data.connections[] (Kafka, Elastic, Cassandra, relational
// databases), or the tool's own saved-host fields (Kube Console, SSH).

// savedConn is one connection as stored by the UI, plus where it came from.
type savedConn struct {
	Tool      string         `json:"tool"`
	Name      string         `json:"name"`
	Workspace string         `json:"workspace"`
	Fields    map[string]any `json:"-"`
}

type uiState struct {
	Workspaces []struct {
		Name string `json:"name"`
		Tabs []struct {
			Type  string          `json:"type"`
			Title string          `json:"title"`
			Data  json.RawMessage `json:"data"`
		} `json:"tabs"`
	} `json:"workspaces"`
}

// connIndex is a snapshot of the user's saved connections.
type connIndex struct {
	byTool map[string][]savedConn
}

// loadConnections reads the state file. A missing or unreadable file is not
// an error — it just means the agent must pass connection fields inline.
func loadConnections(st *store.Store) *connIndex {
	idx := &connIndex{byTool: map[string][]savedConn{}}
	if st == nil {
		return idx
	}
	raw, err := st.Load()
	if err != nil {
		return idx
	}
	var s uiState
	if err := json.Unmarshal(raw, &s); err != nil {
		return idx
	}
	for _, ws := range s.Workspaces {
		for _, tab := range ws.Tabs {
			var d map[string]any
			if json.Unmarshal(tab.Data, &d) != nil {
				continue
			}
			for _, c := range extractConns(tab.Type, tab.Title, d) {
				c.Workspace = ws.Name
				idx.byTool[tab.Type] = append(idx.byTool[tab.Type], c)
			}
		}
	}
	return idx
}

// extractConns pulls the connections out of one tab's saved data. Tools built
// on the shared connections panel keep a `connections` array; the Kube and
// SSH tools predate it and store their hosts differently.
func extractConns(toolType, tabTitle string, d map[string]any) []savedConn {
	var out []savedConn
	if list, ok := d["connections"].([]any); ok {
		for _, item := range list {
			m, ok := item.(map[string]any)
			if !ok {
				continue
			}
			name, _ := m["name"].(string)
			if strings.TrimSpace(name) == "" {
				name = connFallbackName(toolType, m)
			}
			out = append(out, savedConn{Tool: toolType, Name: name, Fields: m})
		}
		return out
	}

	switch toolType {
	case "kube":
		if host, _ := d["sshHost"].(string); strings.TrimSpace(host) != "" {
			out = append(out, savedConn{Tool: toolType, Name: tabTitle, Fields: d})
		}
	case "putty":
		if hosts, ok := d["savedHosts"].([]any); ok {
			for _, item := range hosts {
				if m, ok := item.(map[string]any); ok {
					name, _ := m["name"].(string)
					if strings.TrimSpace(name) == "" {
						name = connFallbackName(toolType, m)
					}
					out = append(out, savedConn{Tool: toolType, Name: name, Fields: m})
				}
			}
		}
	}
	return out
}

func connFallbackName(toolType string, m map[string]any) string {
	pick := func(keys ...string) string {
		for _, k := range keys {
			if s, ok := m[k].(string); ok && strings.TrimSpace(s) != "" {
				return s
			}
		}
		return ""
	}
	switch toolType {
	case "kafka":
		return pick("brokers")
	case "elastic":
		return pick("baseUrl")
	case "cassandra":
		return pick("hosts")
	case "oracle":
		return pick("url", "hosts")
	default:
		return pick("host", "hosts", "name")
	}
}

// filter returns a view holding only the connections the policy shares, so a
// connection the developer kept private is invisible rather than merely
// unusable — an agent should not learn that a "prod-payments" cluster exists.
func (idx *connIndex) filter(p Policy) *connIndex {
	out := &connIndex{byTool: map[string][]savedConn{}}
	for toolType, list := range idx.byTool {
		for _, c := range list {
			if p.AllowsConnection(toolType, c.Name) {
				out.byTool[toolType] = append(out.byTool[toolType], c)
			}
		}
	}
	return out
}

// find resolves a connection by name for a tool type. Matching is
// case-insensitive and accepts a unique prefix, because model-supplied names
// are rarely byte-exact.
func (idx *connIndex) find(toolType, name string) (map[string]any, error) {
	list := idx.byTool[toolType]
	if len(list) == 0 {
		return nil, fmt.Errorf("no saved %s connections — add one in the Devtil UI, or pass the connection fields inline", toolLabel(toolType))
	}
	want := strings.ToLower(strings.TrimSpace(name))
	var exact, prefix []savedConn
	for _, c := range list {
		got := strings.ToLower(strings.TrimSpace(c.Name))
		if got == want {
			exact = append(exact, c)
		} else if want != "" && strings.HasPrefix(got, want) {
			prefix = append(prefix, c)
		}
	}
	hits := exact
	if len(hits) == 0 {
		hits = prefix
	}
	switch len(hits) {
	case 1:
		return hits[0].Fields, nil
	case 0:
		return nil, fmt.Errorf("no saved %s connection named %q (available: %s)",
			toolLabel(toolType), name, strings.Join(idx.names(toolType), ", "))
	default:
		var names []string
		for _, h := range hits {
			names = append(names, h.Name)
		}
		return nil, fmt.Errorf("%q matches several %s connections: %s — use the full name",
			name, toolLabel(toolType), strings.Join(names, ", "))
	}
}

func (idx *connIndex) names(toolType string) []string {
	var out []string
	for _, c := range idx.byTool[toolType] {
		out = append(out, c.Name)
	}
	sort.Strings(out)
	return out
}

var toolLabels = map[string]string{
	"kafka":     "Kafka",
	"elastic":   "Elastic / OpenSearch",
	"cassandra": "Cassandra",
	"oracle":    "relational database",
	"kube":      "Kube Console",
	"putty":     "SSH",
}

func toolLabel(t string) string {
	if l, ok := toolLabels[t]; ok {
		return l
	}
	return t
}

// resolve merges a saved connection (looked up by the "connection" argument)
// with any inline fields the caller supplied. Inline fields win, so an agent
// can point a saved cluster at a different topic or database without
// re-entering credentials.
func (s *Server) resolve(toolType string, a Args, inlineKeys []string) (map[string]any, error) {
	fields := map[string]any{}
	if name := strings.TrimSpace(a.Str("connection")); name != "" {
		if !a.policy.AllowsConnection(toolType, name) {
			return nil, fmt.Errorf("the %s connection %q is not shared with agents — the developer can enable it in Devtil's MCP settings", toolLabel(toolType), name)
		}
		saved, err := loadConnections(s.store).filter(a.policy).find(toolType, name)
		if err != nil {
			return nil, err
		}
		for k, v := range saved {
			fields[k] = v
		}
	}
	for _, k := range inlineKeys {
		if a.Has(k) {
			fields[k] = a.Raw(k)
		}
	}
	if len(fields) == 0 {
		return nil, fmt.Errorf(`no connection: pass "connection" with a saved %s connection name (see devtil_connections), or supply the fields inline`, toolLabel(toolType))
	}
	return fields, nil
}

// decodeInto re-encodes a resolved field map into a typed connection struct.
// Going through JSON keeps one definition of the field names — the struct
// tags the HTTP API already uses.
func decodeInto(fields map[string]any, target any) error {
	// The UI keeps every text field as a string, including numeric ones like
	// port and timeoutMs; coerce those so they land in int fields.
	clean := make(map[string]any, len(fields))
	for k, v := range fields {
		if s, ok := v.(string); ok {
			if n, err := parseIntStrict(s); err == nil && numericField[k] {
				clean[k] = n
				continue
			}
			if boolField[k] {
				clean[k] = strings.EqualFold(strings.TrimSpace(s), "true")
				continue
			}
		}
		clean[k] = v
	}
	data, err := json.Marshal(clean)
	if err != nil {
		return err
	}
	return json.Unmarshal(data, target)
}

var numericField = map[string]bool{"port": true, "timeoutMs": true, "maxRows": true, "max": true}
var boolField = map[string]bool{"tls": true, "insecure": true}

func parseIntStrict(s string) (int, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return 0, fmt.Errorf("empty")
	}
	var n int
	if _, err := fmt.Sscanf(s, "%d", &n); err != nil {
		return 0, err
	}
	return n, nil
}
