package mcp

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	neturl "net/url"
	"strings"

	"github.com/bhavesh78patil/devtil/internal/logging"
	"github.com/bhavesh78patil/devtil/internal/proxy"
	"github.com/bhavesh78patil/devtil/internal/sshx"
)

// The tools here close the gap between what a developer can do in the Devtil
// window and what an agent can do beside them: the saved API collections, the
// scratch pads, the app's own log, and a text diff.

// workspaceTab is one tab from the UI's state file, with its data left raw so
// each tool can decode the shape it cares about.
type workspaceTab struct {
	Workspace string
	Type      string
	Title     string
	Data      json.RawMessage
}

// tabsOfType returns every tab of a tool type across all workspaces.
func (s *Server) tabsOfType(toolType string) []workspaceTab {
	if s.store == nil {
		return nil
	}
	raw, err := s.store.Load()
	if err != nil {
		return nil
	}
	var st struct {
		Workspaces []struct {
			Name string `json:"name"`
			Tabs []struct {
				Type  string          `json:"type"`
				Title string          `json:"title"`
				Data  json.RawMessage `json:"data"`
			} `json:"tabs"`
		} `json:"workspaces"`
	}
	if json.Unmarshal(raw, &st) != nil {
		return nil
	}
	var out []workspaceTab
	for _, ws := range st.Workspaces {
		for _, t := range ws.Tabs {
			if t.Type == toolType {
				out = append(out, workspaceTab{Workspace: ws.Name, Type: t.Type, Title: t.Title, Data: t.Data})
			}
		}
	}
	return out
}

// ---------------------------------------------------------- API collections

type savedRequest struct {
	Name    string          `json:"name"`
	Method  string          `json:"method"`
	Path    string          `json:"path"`
	Headers []kv            `json:"headers"`
	Body    string          `json:"body"`
	Auth    json.RawMessage `json:"auth"`
}

type kv struct {
	K string `json:"k"`
	V string `json:"v"`
}

type apiCollection struct {
	Name     string          `json:"name"`
	BaseURL  string          `json:"baseUrl"`
	Headers  []kv            `json:"headers"`
	Auth     json.RawMessage `json:"auth"`
	Requests []savedRequest  `json:"requests"`
}

func (s *Server) apiCollections() []apiCollection {
	var out []apiCollection
	for _, tab := range s.tabsOfType("api") {
		var d struct {
			Collections []apiCollection `json:"collections"`
		}
		if json.Unmarshal(tab.Data, &d) != nil {
			continue
		}
		out = append(out, d.Collections...)
	}
	return out
}

// authHeaders turns a saved auth block into the headers and query parameters
// it contributes — the same rules the browser applies, so a request an agent
// sends is the request the developer sees when they press Send.
func authHeaders(raw json.RawMessage) (map[string]string, [][2]string) {
	headers := map[string]string{}
	var query [][2]string
	if len(raw) == 0 {
		return headers, query
	}
	var a struct {
		Type     string `json:"type"`
		Username string `json:"username"`
		Password string `json:"password"`
		Token    string `json:"token"`
		Key      string `json:"key"`
		Value    string `json:"value"`
		In       string `json:"in"`
	}
	if json.Unmarshal(raw, &a) != nil {
		return headers, query
	}
	switch a.Type {
	case "basic":
		if a.Username != "" || a.Password != "" {
			headers["Authorization"] = "Basic " + base64.StdEncoding.EncodeToString([]byte(a.Username+":"+a.Password))
		}
	case "bearer":
		if t := strings.TrimSpace(a.Token); t != "" {
			if strings.HasPrefix(strings.ToLower(t), "bearer ") {
				headers["Authorization"] = t
			} else {
				headers["Authorization"] = "Bearer " + t
			}
		}
	case "apikey":
		if k := strings.TrimSpace(a.Key); k != "" {
			if a.In == "query" {
				query = append(query, [2]string{k, a.Value})
			} else {
				headers[k] = a.Value
			}
		}
	}
	return headers, query
}

func (s *Server) registerWorkspace() {
	s.register(&Tool{
		Name:  "api_collections",
		Title: "List saved API requests",
		Description: "List the API collections the developer has saved in Devtil — each collection's base URL and the " +
			"requests in it. Use it to find a request by name, then send it with api_request instead of reconstructing " +
			"the URL, headers and auth yourself. Credentials are never returned.",
		ReadOnly: true,
		Schema: obj(map[string]any{
			"query": str("Case-insensitive substring to match against collection names, request names and paths."),
		}),
		Run: func(a Args) (any, error) {
			q := strings.ToLower(strings.TrimSpace(a.Str("query")))
			cols := s.apiCollections()
			out := make([]any, 0, len(cols))
			total := 0
			for _, c := range cols {
				reqs := make([]any, 0, len(c.Requests))
				for _, r := range c.Requests {
					if q != "" && !strings.Contains(strings.ToLower(c.Name+" "+r.Name+" "+r.Path), q) {
						continue
					}
					reqs = append(reqs, map[string]any{
						"name": r.Name, "method": r.Method, "path": r.Path,
						"hasBody": strings.TrimSpace(r.Body) != "",
					})
				}
				if q != "" && len(reqs) == 0 && !strings.Contains(strings.ToLower(c.Name), q) {
					continue
				}
				total += len(reqs)
				out = append(out, map[string]any{
					"collection": c.Name, "baseUrl": c.BaseURL, "requests": reqs,
				})
			}
			if total == 0 {
				note := "No saved API requests found. The developer saves them in the API Client tool."
				if len(cols) > 0 {
					note = fmt.Sprintf("Nothing matched %q. There are %d collections saved — call this again without a query to see them all.", a.Str("query"), len(cols))
				}
				return map[string]any{"collections": out, "note": note}, nil
			}
			return map[string]any{"collections": out, "count": total}, nil
		},
	})

	s.register(&Tool{
		Name:  "api_request",
		Title: "Send a saved API request",
		Description: "Send one of the developer's saved API requests by name. The collection's base URL, global headers " +
			"and auth are applied exactly as the UI applies them, so you never handle the credentials. " +
			"Override the body or add headers for this one call without changing what is saved. " +
			"This performs a real request — for anything other than a GET, say what you are about to do first.",
		Schema: obj(map[string]any{
			"request":    str("Saved request name, as listed by api_collections."),
			"collection": str("Collection to look in, when the same request name exists in more than one."),
			"body":       str("Replace the saved body for this call only."),
			"headers":    objArg("Extra headers for this call only; these win over the saved ones."),
			"timeoutMs":  num("Timeout in milliseconds (default 30000)."),
			"insecure":   boolean("Skip TLS certificate verification."),
		}, "request"),
		Run: func(a Args) (any, error) {
			name, err := a.Require("request")
			if err != nil {
				return nil, err
			}
			wantCol := strings.TrimSpace(a.Str("collection"))

			type hit struct {
				col apiCollection
				req savedRequest
			}
			var hits []hit
			for _, c := range s.apiCollections() {
				if wantCol != "" && !strings.EqualFold(c.Name, wantCol) {
					continue
				}
				for _, r := range c.Requests {
					if strings.EqualFold(strings.TrimSpace(r.Name), name) {
						hits = append(hits, hit{c, r})
					}
				}
			}
			if len(hits) == 0 {
				return nil, fmt.Errorf("no saved request named %q — call api_collections to see what is available", name)
			}
			if len(hits) > 1 {
				var where []string
				for _, h := range hits {
					where = append(where, h.col.Name)
				}
				return nil, fmt.Errorf("%q exists in several collections (%s) — pass \"collection\" to say which", name, strings.Join(where, ", "))
			}
			col, req := hits[0].col, hits[0].req

			target := req.Path
			if !strings.HasPrefix(strings.ToLower(target), "http://") && !strings.HasPrefix(strings.ToLower(target), "https://") {
				target = strings.TrimRight(strings.TrimSpace(col.BaseURL), "/") + req.Path
			}
			headers := map[string]string{}
			// collection globals, then its auth, then the request's own auth,
			// then request headers, then this call's overrides — each layer
			// beating the one before it, matching the UI
			for _, h := range col.Headers {
				if k := strings.TrimSpace(h.K); k != "" {
					headers[k] = h.V
				}
			}
			auth := col.Auth
			var reqAuthType struct {
				Type string `json:"type"`
			}
			if len(req.Auth) > 0 && json.Unmarshal(req.Auth, &reqAuthType) == nil &&
				reqAuthType.Type != "" && reqAuthType.Type != "inherit" {
				auth = req.Auth
			}
			ah, aq := authHeaders(auth)
			for k, v := range ah {
				headers[k] = v
			}
			for _, h := range req.Headers {
				if k := strings.TrimSpace(h.K); k != "" {
					headers[k] = h.V
				}
			}
			for k, v := range a.StrMap("headers") {
				headers[k] = v
			}
			// query-param auth is escaped the same way the browser escapes it
			if len(aq) > 0 {
				parts := make([]string, 0, len(aq))
				for _, pair := range aq {
					parts = append(parts, escapeQuery(pair[0])+"="+escapeQuery(pair[1]))
				}
				sep := "?"
				if strings.Contains(target, "?") {
					sep = "&"
				}
				target += sep + strings.Join(parts, "&")
			}

			body := req.Body
			if a.Has("body") {
				body = a.Str("body")
			}
			resp, err := proxy.Do(proxy.Request{
				Method:    req.Method,
				URL:       target,
				Headers:   headers,
				Body:      body,
				TimeoutMs: a.Int("timeoutMs", 0),
				Insecure:  a.Bool("insecure", false),
			})
			if err != nil {
				return nil, err
			}
			out := map[string]any{
				"status": resp.Status, "statusText": resp.StatusText,
				"durationMs": resp.DurationMs, "size": resp.Size,
				"truncated": resp.Truncated, "headers": resp.Headers,
				// say exactly what was sent — the saved request can change
				"sent": map[string]any{"method": req.Method, "url": target, "collection": col.Name, "request": req.Name},
			}
			var parsed any
			if json.Unmarshal([]byte(resp.Body), &parsed) == nil {
				out["body"] = parsed
			} else {
				out["body"] = resp.Body
			}
			return out, nil
		},
	})

	// ------------------------------------------------------------ notepads

	s.register(&Tool{
		Name:  "notepad_list",
		Title: "List the developer's scratch pads",
		Description: "List the Notepad pads in the developer's workspaces, with a preview of each. " +
			"Useful when they say \"the notes I made about X\". Read-only: record anything durable of your own " +
			"in the knowledge bundle with okf_write instead, which is file-backed and will not be overwritten " +
			"by the UI's autosave.",
		ReadOnly: true,
		Schema: obj(map[string]any{
			"query": str("Case-insensitive substring to match against pad contents."),
		}),
		Run: func(a Args) (any, error) {
			q := strings.ToLower(strings.TrimSpace(a.Str("query")))
			var pads []any
			for _, tab := range s.tabsOfType("notepad") {
				var d struct {
					Pads []struct {
						ID   string `json:"id"`
						Text string `json:"text"`
					} `json:"pads"`
				}
				if json.Unmarshal(tab.Data, &d) != nil {
					continue
				}
				for _, p := range d.Pads {
					if q != "" && !strings.Contains(strings.ToLower(p.Text), q) {
						continue
					}
					pads = append(pads, map[string]any{
						"id": p.ID, "tab": tab.Title, "workspace": tab.Workspace,
						"title":   padTitle(p.Text),
						"preview": padPreview(p.Text, 200),
						"chars":   len(p.Text),
					})
				}
			}
			return map[string]any{"pads": pads, "count": len(pads)}, nil
		},
	})

	s.register(&Tool{
		Name:        "notepad_read",
		Title:       "Read a scratch pad",
		Description: "Read the full text of one Notepad pad, by the id from notepad_list.",
		ReadOnly:    true,
		Schema:      obj(map[string]any{"id": str("Pad id, from notepad_list.")}, "id"),
		Run: func(a Args) (any, error) {
			id, err := a.Require("id")
			if err != nil {
				return nil, err
			}
			for _, tab := range s.tabsOfType("notepad") {
				var d struct {
					Pads []struct {
						ID   string `json:"id"`
						Text string `json:"text"`
					} `json:"pads"`
				}
				if json.Unmarshal(tab.Data, &d) != nil {
					continue
				}
				for _, p := range d.Pads {
					if p.ID == id {
						return map[string]any{
							"id": p.ID, "tab": tab.Title, "workspace": tab.Workspace,
							"title": padTitle(p.Text), "text": p.Text,
						}, nil
					}
				}
			}
			return nil, fmt.Errorf("no pad with id %q — call notepad_list for the current ids", id)
		},
	})

	// ---------------------------------------------------------- diagnostics

	s.register(&Tool{
		Name:  "devtil_logs",
		Title: "Read Devtil's own log",
		Description: "Read Devtil's diagnostic log: every kubectl and ssh command it ran (secrets redacted), " +
			"proxied HTTP calls, database and Kafka connections, and UI errors. " +
			"Read this when one of your own tool calls failed and the message was not enough to explain why.",
		ReadOnly: true,
		Schema: obj(map[string]any{
			"lines":  num("How many lines from the end (default 200, max 2000)."),
			"filter": str("Only return lines containing this (case-insensitive)."),
		}),
		Run: func(a Args) (any, error) {
			n := a.Int("lines", 200)
			if n <= 0 {
				n = 200
			}
			if n > 2000 {
				n = 2000
			}
			lines, err := logging.Tail(n)
			if err != nil {
				return nil, fmt.Errorf("cannot read the log: %w — the log only exists while the Devtil app is running", err)
			}
			if f := strings.ToLower(strings.TrimSpace(a.Str("filter"))); f != "" {
				kept := lines[:0:0]
				for _, l := range lines {
					if strings.Contains(strings.ToLower(l), f) {
						kept = append(kept, l)
					}
				}
				lines = kept
			}
			return map[string]any{"lines": lines, "count": len(lines), "path": logging.Path()}, nil
		},
	})

	// ---------------------------------------------------------- text diff

	s.register(&Tool{
		Name:  "text_diff",
		Title: "Diff two texts",
		Description: "Compare two texts line by line and return the added and removed lines with counts. " +
			"Useful for checking a config against another environment, or a response against an expected payload.",
		ReadOnly: true,
		Schema: obj(map[string]any{
			"left":       str("The original text."),
			"right":      str("The changed text."),
			"contextual": boolean("Include unchanged lines too (default false — only the differences)."),
		}, "left", "right"),
		Run: func(a Args) (any, error) {
			left := strings.Split(a.Str("left"), "\n")
			right := strings.Split(a.Str("right"), "\n")
			ops := diffLines(left, right)
			keepSame := a.Bool("contextual", false)
			out := make([]any, 0, len(ops))
			added, removed := 0, 0
			for _, op := range ops {
				switch op.kind {
				case "add":
					added++
				case "del":
					removed++
				}
				if op.kind == "same" && !keepSame {
					continue
				}
				out = append(out, map[string]any{"op": op.kind, "line": op.text})
			}
			return map[string]any{
				"added": added, "removed": removed,
				"identical": added == 0 && removed == 0,
				"diff":      out,
			}, nil
		},
	})

	// -------------------------------------------------------- remote files

	s.register(&Tool{
		Name:  "sftp_read",
		Title: "Read a remote file",
		Description: "Read a file from a remote host over SFTP and return its contents as text. " +
			"Use it for config files and log files that are not exposed any other way. Large files are truncated.",
		ReadOnly: true,
		Schema: obj(merge(connectionArg("SSH"), sshConnProps, map[string]any{
			"path":     str("Absolute path of the file on the remote host."),
			"maxBytes": num("Stop after this many bytes (default 1000000, max 10000000)."),
		}), "path"),
		Run: func(a Args) (any, error) {
			conn, chosen, err := s.sshConn(a)
			if err != nil {
				return nil, err
			}
			path, err := a.Require("path")
			if err != nil {
				return nil, err
			}
			max := a.Int("maxBytes", 1000000)
			if max <= 0 {
				max = 1000000
			}
			if max > 10000000 {
				max = 10000000
			}
			text, size, truncated, err := sshx.SFTPReadText(conn, path, max)
			if err != nil {
				return nil, err
			}
			return withConnection(map[string]any{
				"path": path, "bytes": size, "truncated": truncated, "text": text,
			}, chosen), nil
		},
	})
}

// escapeQuery escapes a query value the way the browser's encodeURIComponent
// does. Go's QueryEscape writes a space as "+", which servers that do not
// form-decode the query string hand back literally.
func escapeQuery(s string) string {
	return strings.ReplaceAll(neturl.QueryEscape(s), "+", "%20")
}

// padPreview keeps a pad's first couple of lines readable on one line.
func padPreview(text string, max int) string {
	s := strings.Join(strings.Fields(text), " ")
	if len(s) > max {
		return strings.TrimSpace(s[:max]) + "…"
	}
	return s
}

func padTitle(text string) string {
	first := strings.TrimSpace(strings.SplitN(text, "\n", 2)[0])
	if first == "" {
		return "(empty pad)"
	}
	if len(first) > 60 {
		first = first[:60] + "…"
	}
	return first
}

type diffOp struct {
	kind string // same | add | del
	text string
}

// diffLines is a line-level LCS diff, matching what the Text Diff tool shows.
func diffLines(a, b []string) []diffOp {
	n, m := len(a), len(b)
	// lengths[i][j] = LCS length of a[i:] and b[j:]
	lengths := make([][]int, n+1)
	for i := range lengths {
		lengths[i] = make([]int, m+1)
	}
	for i := n - 1; i >= 0; i-- {
		for j := m - 1; j >= 0; j-- {
			if a[i] == b[j] {
				lengths[i][j] = lengths[i+1][j+1] + 1
			} else if lengths[i+1][j] >= lengths[i][j+1] {
				lengths[i][j] = lengths[i+1][j]
			} else {
				lengths[i][j] = lengths[i][j+1]
			}
		}
	}
	var out []diffOp
	i, j := 0, 0
	for i < n && j < m {
		switch {
		case a[i] == b[j]:
			out = append(out, diffOp{"same", a[i]})
			i++
			j++
		case lengths[i+1][j] >= lengths[i][j+1]:
			out = append(out, diffOp{"del", a[i]})
			i++
		default:
			out = append(out, diffOp{"add", b[j]})
			j++
		}
	}
	for ; i < n; i++ {
		out = append(out, diffOp{"del", a[i]})
	}
	for ; j < m; j++ {
		out = append(out, diffOp{"add", b[j]})
	}
	return out
}
