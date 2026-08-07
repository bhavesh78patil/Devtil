package server

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/bhavesh78patil/devtil/internal/logging"
	"github.com/bhavesh78patil/devtil/internal/okf"
)

func splitCSV(s string) []string {
	var out []string
	for _, part := range strings.Split(s, ",") {
		if part = strings.TrimSpace(part); part != "" {
			out = append(out, part)
		}
	}
	return out
}

// The Knowledge Graph tool reads and writes the same Open Knowledge Format
// bundle the MCP server exposes to agents, so what an agent records while it
// works shows up in the UI, and what a developer writes is there for the
// agent to find.

func (s *Server) bundle() (*okf.Bundle, error) { return okf.Open(s.okfDir) }

// mcpInfo tells the Settings panel what it can offer: the tool groups and
// their tools, and the saved connections that can be shared with agents.
// Keeping this server-side means Settings never holds a stale copy of the
// tool list.
func (s *Server) mcpInfo(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, map[string]any{
		"groups":      s.mcp.GroupsForUI(),
		"connections": s.mcp.ConnectionsForUI(),
		"bundle":      s.okfDir,
	})
}

func (s *Server) okfList(w http.ResponseWriter, r *http.Request) {
	b, err := s.bundle()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	q := r.URL.Query()
	docs, err := b.Search(okf.SearchOptions{
		Query: q.Get("q"),
		Type:  q.Get("type"),
		Tags:  splitCSV(q.Get("tags")),
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	// Listings drive the sidebar, so send metadata only; bodies come from
	// the read endpoint when a concept is actually opened.
	concepts := make([]any, 0, len(docs))
	types := map[string]int{}
	tags := map[string]int{}
	for _, d := range docs {
		concepts = append(concepts, map[string]any{
			"path": d.Path, "title": d.Title(), "type": d.Type(),
			"description": d.Description(), "tags": d.Tags(),
			"status": d.Frontmatter["status"], "reserved": d.Reserved,
			"modTime": d.ModTime, "links": len(d.Links),
		})
		if t := d.Type(); t != "" {
			types[t]++
		}
		for _, tag := range d.Tags() {
			tags[tag]++
		}
	}
	writeJSON(w, map[string]any{
		"concepts": concepts, "count": len(concepts),
		"types": types, "tags": tags,
		"root": b.Root(), "okfVersion": okf.Version,
	})
}

func (s *Server) okfRead(w http.ResponseWriter, r *http.Request) {
	b, err := s.bundle()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	doc, err := b.Read(r.URL.Query().Get("path"))
	if err != nil {
		writeError(w, http.StatusNotFound, err)
		return
	}
	writeJSON(w, doc)
}

func (s *Server) okfWrite(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Path        string         `json:"path"`
		Frontmatter map[string]any `json:"frontmatter"`
		Body        string         `json:"body"`
		Merge       bool           `json:"merge"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 8<<20)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	b, err := s.bundle()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	doc, err := b.Write(okf.WriteOptions{
		Path:        req.Path,
		Frontmatter: req.Frontmatter,
		Body:        req.Body,
		// Edits made in the UI are the developer's own, recorded with the
		// spec's actor convention for a human author.
		GeneratedBy: "human:devtil-ui",
		Merge:       req.Merge,
	})
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	writeJSON(w, doc)
}

func (s *Server) okfDelete(w http.ResponseWriter, r *http.Request) {
	b, err := s.bundle()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	if err := b.Delete(r.URL.Query().Get("path")); err != nil {
		writeError(w, http.StatusNotFound, err)
		return
	}
	writeJSON(w, map[string]any{"ok": true})
}

// okfExport streams the bundle as a zip. What comes out is the bundle itself
// — plain markdown — so the recipient can unpack it, read it in an editor, or
// commit it next to the code it describes.
func (s *Server) okfExport(w http.ResponseWriter, r *http.Request) {
	b, err := s.bundle()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	name := "okf-bundle-" + time.Now().Format("2006-01-02") + ".zip"
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", `attachment; filename="`+name+`"`)
	if err := b.WriteZip(w); err != nil {
		// The headers are already out, so the download will simply be short —
		// log it rather than pretending we can still send an error document.
		logging.Logf("okf: export failed: %v", err)
	}
}

// okfImport merges an uploaded bundle archive into this one.
func (s *Server) okfImport(w http.ResponseWriter, r *http.Request) {
	b, err := s.bundle()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	data, err := io.ReadAll(io.LimitReader(r.Body, 64<<20))
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	q := r.URL.Query()
	res, err := b.ReadZip(bytes.NewReader(data), int64(len(data)), okf.ImportOptions{
		Prefix:    q.Get("prefix"),
		Overwrite: q.Get("overwrite") == "true",
	})
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	writeJSON(w, res)
}

func (s *Server) okfGraph(w http.ResponseWriter, r *http.Request) {
	b, err := s.bundle()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	g, err := b.Graph()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	problems, err := b.Validate()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, map[string]any{
		"graph": g, "problems": problems, "conformant": len(problems) == 0,
	})
}
