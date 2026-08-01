package mcp

import (
	"fmt"
	"strings"

	"github.com/bhavesh78patil/devtil/internal/okf"
)

// The okf_* tools give an agent somewhere durable to put what it learns.
// Instead of rediscovering a table's meaning or a topic's schema on every
// session, it writes a concept document and links it to related ones; the
// bundle is plain markdown the developer can read, diff and commit.

const okfActor = "devtil/mcp" // the spec's actor convention: <producer>/<version>

func (s *Server) bundle() (*okf.Bundle, error) {
	if strings.TrimSpace(s.okfDir) == "" {
		return nil, fmt.Errorf("no knowledge bundle is configured — start devtil with `devtil mcp --okf <dir>`")
	}
	return okf.Open(s.okfDir)
}

func (s *Server) registerOKF() {
	s.register(&Tool{
		Name:  "okf_search",
		Title: "Search the knowledge bundle",
		Description: "Search the Open Knowledge Format bundle for concepts — by free text, concept type, or tags. " +
			"Check here before investigating something from scratch: a previous session may already have written it down.",
		ReadOnly: true,
		Schema: obj(map[string]any{
			"query": str("Case-insensitive text to match against title, description, path and body. Omit to list everything."),
			"type":  str(`Only return concepts of this type, e.g. "Runbook" or "Kafka Topic".`),
			"tags":  strArray("Only return concepts carrying all of these tags."),
			"limit": num("Maximum concepts to return (default 50)."),
			"body":  boolean("Include each concept's full markdown body (default false — titles and descriptions only)."),
		}),
		Run: func(a Args) (any, error) {
			b, err := s.bundle()
			if err != nil {
				return nil, err
			}
			limit := a.Int("limit", 50)
			docs, err := b.Search(okf.SearchOptions{
				Query: a.Str("query"),
				Type:  a.Str("type"),
				Tags:  a.StrSlice("tags"),
				Limit: limit,
			})
			if err != nil {
				return nil, err
			}
			withBody := a.Bool("body", false)
			out := make([]any, 0, len(docs))
			for _, d := range docs {
				entry := map[string]any{
					"path": d.Path, "title": d.Title(), "type": d.Type(),
					"description": d.Description(), "tags": d.Tags(),
				}
				if withBody {
					entry["body"] = d.Body
				}
				out = append(out, entry)
			}
			return map[string]any{"concepts": out, "count": len(out), "bundle": b.Root()}, nil
		},
	})

	s.register(&Tool{
		Name:        "okf_read",
		Title:       "Read a concept",
		Description: "Read one concept document from the knowledge bundle: its frontmatter, markdown body and outgoing links.",
		ReadOnly:    true,
		Schema: obj(map[string]any{
			"path": str(`Bundle path of the concept, e.g. /tables/orders.md — the ".md" suffix is optional.`),
		}, "path"),
		Run: func(a Args) (any, error) {
			b, err := s.bundle()
			if err != nil {
				return nil, err
			}
			path, err := a.Require("path")
			if err != nil {
				return nil, err
			}
			doc, err := b.Read(path)
			if err != nil {
				return nil, err
			}
			return doc, nil
		},
	})

	s.register(&Tool{
		Name:  "okf_write",
		Title: "Write a concept",
		Description: `Create or update a concept in the knowledge bundle. Frontmatter must include "type" — a short string ` +
			`naming the kind of concept ("Runbook", "Kafka Topic", "Database Table"). Link to related concepts from the body ` +
			"with ordinary markdown links to their bundle paths, e.g. [orders](/tables/orders.md); those links are what form the graph.",
		Schema: obj(map[string]any{
			"path":        str(`Bundle path to write, e.g. /tables/orders.md. Directories are created as needed.`),
			"type":        str(`Required concept type — the one field the OKF spec mandates. Free-form, e.g. "Runbook".`),
			"title":       str("Human-readable name."),
			"description": str("One-sentence summary."),
			"body":        str("The markdown body. Use markdown links to reference other concepts."),
			"tags":        strArray("Cross-cutting categorisation tags."),
			"resource":    str("Canonical URI of the underlying asset this concept describes, if any."),
			"status":      enum("Lifecycle status: draft, stable (default) or deprecated.", "draft", "stable", "deprecated"),
			"frontmatter": objArg("Any additional frontmatter keys. Producers may add their own fields freely."),
			"merge":       boolean("Keep existing frontmatter keys not supplied here (default true), so you do not drop curation you never saw."),
		}, "path", "body"),
		Run: func(a Args) (any, error) {
			b, err := s.bundle()
			if err != nil {
				return nil, err
			}
			path, err := a.Require("path")
			if err != nil {
				return nil, err
			}
			fm := map[string]any{}
			for k, v := range a.Map("frontmatter") {
				fm[k] = v
			}
			for _, k := range []string{"type", "title", "description", "resource", "status"} {
				if v := strings.TrimSpace(a.Str(k)); v != "" {
					fm[k] = v
				}
			}
			if tags := a.StrSlice("tags"); len(tags) > 0 {
				list := make([]any, len(tags))
				for i, t := range tags {
					list[i] = t
				}
				fm["tags"] = list
			}
			doc, err := b.Write(okf.WriteOptions{
				Path:        path,
				Frontmatter: fm,
				Body:        a.Str("body"),
				GeneratedBy: okfActor,
				Merge:       a.Bool("merge", true),
			})
			if err != nil {
				return nil, err
			}
			return map[string]any{
				"path": doc.Path, "type": doc.Type(), "title": doc.Title(),
				"links": doc.Links, "bytes": doc.Size,
			}, nil
		},
	})

	s.register(&Tool{
		Name:        "okf_delete",
		Title:       "Delete a concept",
		Description: "Remove a concept document from the knowledge bundle. Other concepts linking to it will show as broken links rather than being rewritten.",
		Schema:      obj(map[string]any{"path": str("Bundle path of the concept to delete.")}, "path"),
		Run: func(a Args) (any, error) {
			b, err := s.bundle()
			if err != nil {
				return nil, err
			}
			path, err := a.Require("path")
			if err != nil {
				return nil, err
			}
			if err := b.Delete(path); err != nil {
				return nil, err
			}
			norm, _ := okf.Normalize(path)
			return map[string]any{"deleted": norm}, nil
		},
	})

	s.register(&Tool{
		Name:  "okf_graph",
		Title: "Read the knowledge graph",
		Description: "Return the knowledge bundle as a graph: every concept as a node, every markdown link between concepts as an edge, " +
			"plus broken links and orphaned concepts. Use it to see how a domain hangs together.",
		ReadOnly: true,
		Schema:   obj(nil),
		Run: func(a Args) (any, error) {
			b, err := s.bundle()
			if err != nil {
				return nil, err
			}
			return b.Graph()
		},
	})

	s.register(&Tool{
		Name:        "okf_neighbors",
		Title:       "Find related concepts",
		Description: "Return the concepts within N link hops of a starting concept, following links in both directions — the fastest way to pull in the context around something.",
		ReadOnly:    true,
		Schema: obj(map[string]any{
			"path":  str("Bundle path of the starting concept."),
			"depth": num("How many hops to follow (default 1)."),
		}, "path"),
		Run: func(a Args) (any, error) {
			b, err := s.bundle()
			if err != nil {
				return nil, err
			}
			path, err := a.Require("path")
			if err != nil {
				return nil, err
			}
			nodes, edges, err := b.Neighbors(path, a.Int("depth", 1))
			if err != nil {
				return nil, err
			}
			return map[string]any{"nodes": nodes, "edges": edges}, nil
		},
	})

	s.register(&Tool{
		Name:        "okf_log",
		Title:       "Append to the bundle log",
		Description: "Append a dated entry to the bundle's log.md — the reserved file for chronological history. Use it to record what changed and why.",
		Schema: obj(map[string]any{
			"entry": str("What happened, in one line."),
			"by":    str(`Who did it, using the spec's actor convention: "human:alice", "process:nightly-sync", or a producer/version string. Defaults to devtil/mcp.`),
		}, "entry"),
		Run: func(a Args) (any, error) {
			b, err := s.bundle()
			if err != nil {
				return nil, err
			}
			entry, err := a.Require("entry")
			if err != nil {
				return nil, err
			}
			by := strings.TrimSpace(a.Str("by"))
			if by == "" {
				by = okfActor
			}
			if err := b.AppendLog(entry, by); err != nil {
				return nil, err
			}
			return map[string]any{"ok": true, "log": "/" + okf.LogFile}, nil
		},
	})

	s.register(&Tool{
		Name:        "okf_validate",
		Title:       "Validate the bundle",
		Description: "Check the knowledge bundle for conformance: every concept has parseable frontmatter with a non-empty type, and every internal link resolves.",
		ReadOnly:    true,
		Schema:      obj(nil),
		Run: func(a Args) (any, error) {
			b, err := s.bundle()
			if err != nil {
				return nil, err
			}
			problems, err := b.Validate()
			if err != nil {
				return nil, err
			}
			return map[string]any{
				"conformant": len(problems) == 0,
				"problems":   problems,
				"okfVersion": okf.Version,
				"bundle":     b.Root(),
			}, nil
		},
	})
}

// registerAll wires up the whole tool set.
func (s *Server) registerAll() {
	s.registerText()
	s.registerInfra()
	s.registerOKF()
}
