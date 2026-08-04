package mcp

import (
	"encoding/json"
	"sort"
	"strings"
)

// What an agent is allowed to reach is the developer's call, not the agent's.
// The Settings panel in the UI writes a policy into the same state file the
// rest of the app autosaves; every request reads it fresh, so unticking a
// group takes effect on the next tools/list without restarting anything.

// Group is a user-facing bundle of tools, the granularity the Settings panel
// toggles at. Individual tools can still be overridden inside a group.
type Group struct {
	ID    string
	Label string
	Desc  string
	Tools []string
}

// Groups is the display order in Settings, coarsest capability first.
var Groups = []Group{
	{
		ID: "text", Label: "Text & data utilities",
		Desc: "Offline only: no network, no credentials, no side effects.",
		Tools: []string{
			"json_format", "jsonpath_query", "xml_to_json", "json_to_xml",
			"base64", "url_encode", "jwt_decode", "hash_text",
			"uuid_generate", "timestamp_convert", "regex_test",
		},
	},
	{
		ID: "core", Label: "Saved connections",
		Desc:  "Lets an agent discover which connections it may reference by name. Names and hosts only — never credentials.",
		Tools: []string{"devtil_connections"},
	},
	{
		ID: "http", Label: "HTTP client",
		Desc:  "Sends requests from your machine, so it reaches internal hosts.",
		Tools: []string{"http_request"},
	},
	{
		ID: "kafka", Label: "Kafka",
		Desc:  "List topics and read messages; producing writes to a real topic.",
		Tools: []string{"kafka_topics", "kafka_consume", "kafka_produce"},
	},
	{
		ID: "db", Label: "Databases",
		Desc:  "Oracle, MySQL, PostgreSQL and Cassandra. Statements run for real.",
		Tools: []string{"db_query", "cassandra_query"},
	},
	{
		ID: "elastic", Label: "Elastic / OpenSearch",
		Desc:  "Any REST call against a configured cluster.",
		Tools: []string{"elastic_request"},
	},
	{
		ID: "kube", Label: "Kubernetes",
		Desc:  "Read pods and logs; exec runs commands inside a live pod.",
		Tools: []string{"kube_contexts", "kube_namespaces", "kube_pods", "kube_logs", "kube_exec"},
	},
	{
		ID: "ssh", Label: "SSH & SFTP",
		Desc:  "Runs commands on a remote host and lists remote directories.",
		Tools: []string{"ssh_exec", "sftp_list"},
	},
	{
		ID: "knowledge", Label: "Knowledge bundle (OKF)",
		Desc:  "Read and write the knowledge graph. This is what lets an agent remember across sessions.",
		Tools: []string{"okf_search", "okf_read", "okf_write", "okf_delete", "okf_graph", "okf_neighbors", "okf_log", "okf_validate"},
	},
}

// groupOfTool maps each tool to its group, built once from Groups.
var groupOfTool = func() map[string]string {
	m := map[string]string{}
	for _, g := range Groups {
		for _, t := range g.Tools {
			m[t] = g.ID
		}
	}
	return m
}()

// Policy is the developer's answer to "what may an agent do here?".
//
// Every field is a pointer or a map that distinguishes "not configured" from
// "configured off", because the defaults matter: a fresh install exposes
// everything, and only an explicit untick takes something away.
type Policy struct {
	// Enabled turns the HTTP endpoint on and off. Nil means "not configured",
	// which is on — the feature ships enabled.
	Enabled *bool `json:"enabled"`
	// Groups maps a group ID to whether it is exposed. A missing entry is on.
	Groups map[string]bool `json:"groups"`
	// Tools overrides individual tools inside an enabled group. A missing
	// entry follows the group.
	Tools map[string]bool `json:"tools"`
	// ConnectionsAll exposes every saved connection. Nil means on.
	ConnectionsAll *bool `json:"connectionsAll"`
	// Connections is the allowlist used when ConnectionsAll is false, keyed
	// "<toolType>/<connection name>".
	Connections map[string]bool `json:"connections"`
	// Defaults names the connection an agent gets when it does not say which
	// one it wants, keyed by tool type. Without one, an ambiguous request is
	// refused rather than guessed at.
	Defaults map[string]string `json:"defaults"`
	// Env labels a connection's environment, keyed like Connections. A
	// production connection is never selected automatically — an agent has
	// to name it, which means a human decided.
	Env map[string]string `json:"env"`
}

// Environment labels. The distinction that actually matters is
// "production or not"; the rest is for the developer's own orientation.
const (
	EnvProduction  = "production"
	EnvStaging     = "staging"
	EnvDevelopment = "development"
)

// DefaultConnection returns the connection an agent should use for a tool
// type when it did not name one, or "" if the developer has not chosen.
func (p Policy) DefaultConnection(toolType string) string {
	return strings.TrimSpace(p.Defaults[toolType])
}

// EnvOf returns the environment label for a connection, or "".
func (p Policy) EnvOf(toolType, name string) string {
	return strings.TrimSpace(p.Env[connKey(toolType, name)])
}

// IsProduction reports whether a connection is labelled production, which
// bars it from being picked automatically.
func (p Policy) IsProduction(toolType, name string) bool {
	return strings.EqualFold(p.EnvOf(toolType, name), EnvProduction)
}

// DefaultPolicy is what an unconfigured devtil uses: everything available.
func DefaultPolicy() Policy {
	on := true
	return Policy{Enabled: &on, ConnectionsAll: &on}
}

func (p Policy) IsEnabled() bool { return p.Enabled == nil || *p.Enabled }

func (p Policy) allConnections() bool { return p.ConnectionsAll == nil || *p.ConnectionsAll }

// AllowsTool reports whether a tool may be listed and called.
func (p Policy) AllowsTool(name string) bool {
	if explicit, ok := p.Tools[name]; ok {
		return explicit
	}
	group, known := groupOfTool[name]
	if !known {
		return true // a tool with no group is not something the UI can gate
	}
	if enabled, ok := p.Groups[group]; ok {
		return enabled
	}
	return true
}

// AllowsConnection reports whether a saved connection may be resolved by name.
func (p Policy) AllowsConnection(toolType, name string) bool {
	if p.allConnections() {
		return true
	}
	return p.Connections[connKey(toolType, name)]
}

func connKey(toolType, name string) string {
	return toolType + "/" + strings.TrimSpace(name)
}

// loadPolicy reads settings.mcp out of the UI's state file. Anything missing
// or unparseable falls back to the permissive default rather than locking the
// user out of their own tools.
func (s *Server) loadPolicy() Policy {
	if s.store == nil {
		return DefaultPolicy()
	}
	raw, err := s.store.Load()
	if err != nil {
		return DefaultPolicy()
	}
	var wrapper struct {
		Settings struct {
			MCP *Policy `json:"mcp"`
		} `json:"settings"`
	}
	if err := json.Unmarshal(raw, &wrapper); err != nil || wrapper.Settings.MCP == nil {
		return DefaultPolicy()
	}
	return *wrapper.Settings.MCP
}

// GroupsForUI describes the available groups and their tools so the Settings
// panel does not have to keep its own copy of the tool list in sync.
func (s *Server) GroupsForUI() []map[string]any {
	out := make([]map[string]any, 0, len(Groups))
	for _, g := range Groups {
		tools := make([]map[string]any, 0, len(g.Tools))
		for _, name := range g.Tools {
			t, ok := s.tools[name]
			if !ok {
				continue
			}
			tools = append(tools, map[string]any{
				"name":     t.Name,
				"title":    t.Title,
				"readOnly": t.ReadOnly,
			})
		}
		out = append(out, map[string]any{
			"id": g.ID, "label": g.Label, "desc": g.Desc, "tools": tools,
		})
	}
	return out
}

// ConnectionsForUI lists saved connections so Settings can offer an allowlist,
// an environment label and a per-tool default.
func (s *Server) ConnectionsForUI() []map[string]any {
	idx := loadConnections(s.store)
	var out []map[string]any
	for toolType, list := range idx.byTool {
		for _, c := range list {
			out = append(out, map[string]any{
				"key":       connKey(toolType, c.Name),
				"tool":      toolType,
				"toolLabel": toolLabel(toolType),
				"name":      c.Name,
				"workspace": c.Workspace,
				"summary":   summarizeConn(toolType, c.Fields),
			})
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i]["tool"] != out[j]["tool"] {
			return out[i]["tool"].(string) < out[j]["tool"].(string)
		}
		return out[i]["name"].(string) < out[j]["name"].(string)
	})
	return out
}
