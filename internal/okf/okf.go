// Package okf reads and writes knowledge bundles in the Open Knowledge
// Format — an open, vendor-neutral spec from Google Cloud for representing
// knowledge as plain markdown files with YAML frontmatter, so any agent can
// consume it without an SDK or query language.
//
// The shape of a bundle (OKF v0.2):
//
//	bundle/
//	  index.md              optional root listing; may declare okf_version
//	  log.md                optional chronological history
//	  <concept>.md          frontmatter + markdown body
//	  <dir>/<concept>.md    nesting is free-form
//
// The only required frontmatter field is `type`. Concepts reference each
// other with ordinary markdown links — `[customers](/tables/customers.md)` —
// and those links are what turn a directory into a graph. Devtil treats the
// bundle-relative path as a concept's identity, exactly as the spec does.
//
// Conformance note: a consumer must not reject a document for missing
// optional fields, unknown `type` values, unknown extra keys or broken
// links, so parsing here is deliberately forgiving and unknown frontmatter
// keys are preserved verbatim on write.
package okf

import (
	"errors"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

// Version is the OKF spec version Devtil writes and validates against.
const Version = "0.2"

// reserved filenames carry bundle structure rather than a concept.
const (
	IndexFile = "index.md"
	LogFile   = "log.md"
)

// Doc is one parsed OKF document.
type Doc struct {
	// Path is the concept's identity: a bundle-relative, slash-separated
	// path with a leading "/" (e.g. "/tables/orders.md").
	Path string `json:"path"`
	// Frontmatter holds every YAML key as parsed, including keys Devtil
	// does not model. Values are strings, []any or map[string]any.
	Frontmatter map[string]any `json:"frontmatter"`
	Body        string         `json:"body"`
	// Links are the outgoing markdown links, resolved to bundle-relative
	// paths where they point inside the bundle.
	Links    []Link `json:"links"`
	Reserved bool   `json:"reserved"` // index.md / log.md
	ModTime  string `json:"modTime"`
	Size     int    `json:"size"`
}

// Link is one markdown link found in a document body.
type Link struct {
	Text string `json:"text"`
	// Target is the raw link destination as written.
	Target string `json:"target"`
	// Resolved is the bundle-relative path when the link points at another
	// document in this bundle, otherwise empty (external URL, anchor, …).
	Resolved string `json:"resolved"`
}

// Type returns the required `type` field, or "" when absent.
func (d Doc) Type() string { return d.str("type") }

// Title falls back to the filename so a listing is always readable, which
// matters because `title` is only recommended, never required.
func (d Doc) Title() string {
	if t := d.str("title"); t != "" {
		return t
	}
	return strings.TrimSuffix(path.Base(d.Path), ".md")
}

func (d Doc) Description() string { return d.str("description") }

func (d Doc) str(key string) string {
	if d.Frontmatter == nil {
		return ""
	}
	if v, ok := d.Frontmatter[key].(string); ok {
		return v
	}
	return ""
}

// Tags returns the `tags` list as strings, tolerating a single string.
func (d Doc) Tags() []string {
	switch v := d.Frontmatter["tags"].(type) {
	case string:
		return []string{v}
	case []any:
		out := make([]string, 0, len(v))
		for _, t := range v {
			if s, ok := t.(string); ok {
				out = append(out, s)
			}
		}
		return out
	}
	return nil
}

// Bundle is a directory of OKF documents on disk.
type Bundle struct {
	root string
}

// Open returns a bundle rooted at dir, creating the directory if needed and
// seeding a root index.md the first time. An empty directory gives an agent
// nothing to orient by; the seeded index states the conventions so the first
// concept written lands in the right shape.
func Open(dir string) (*Bundle, error) {
	if strings.TrimSpace(dir) == "" {
		return nil, errors.New("okf: bundle directory is required")
	}
	abs, err := filepath.Abs(dir)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(abs, 0o755); err != nil {
		return nil, fmt.Errorf("okf: create bundle dir: %w", err)
	}
	b := &Bundle{root: abs}
	if _, err := os.Stat(filepath.Join(abs, IndexFile)); errors.Is(err, os.ErrNotExist) {
		if _, err := b.Write(WriteOptions{Path: "/" + IndexFile, Body: seedIndex}); err != nil {
			// A bundle that cannot be seeded is still perfectly usable.
			return b, nil
		}
	}
	return b, nil
}

const seedIndex = `# Knowledge bundle

This is an [Open Knowledge Format](https://github.com/GoogleCloudPlatform/knowledge-catalog/tree/main/okf)
bundle: one markdown file per concept, with YAML frontmatter. Devtil and any
AI agent connected to it read and write these files.

## Conventions

- Every concept needs a **` + "`type`" + `** — a short free-form string such as
  ` + "`Database Table`" + `, ` + "`Kafka Topic`" + `, ` + "`Runbook`" + `, ` + "`Service`" + ` or ` + "`Incident`" + `.
- The **file path is the concept's identity**. Group related concepts in
  folders: ` + "`/tables/orders.md`" + `, ` + "`/runbooks/checkout-latency.md`" + `.
- **Link concepts with ordinary markdown links** to their bundle paths —
  ` + "`[orders](/tables/orders.md)`" + `. Those links are the graph.
- Record what is **durable and non-obvious**: what a table means, why a topic
  is partitioned the way it is, how to recover a stuck consumer group. Not
  transient state, and not anything already obvious from the code.

## Suggested layout

	/services/<name>.md      what it does, who owns it, how to reach it
	/tables/<name>.md        schema, meaning, joins, gotchas
	/topics/<name>.md        payload shape, partitioning, consumers
	/runbooks/<name>.md      symptom → diagnosis → fix
	/decisions/<name>.md     why something is the way it is

Delete this file once the bundle has concepts of its own, or replace it with a
real index of what lives here.
`

func (b *Bundle) Root() string { return b.root }

// Normalize turns any user-supplied concept path into the canonical bundle
// path: leading slash, forward slashes, ".md" suffix, no escape upwards.
func Normalize(p string) (string, error) {
	p = strings.TrimSpace(strings.ReplaceAll(p, "\\", "/"))
	if p == "" {
		return "", errors.New("okf: path is required")
	}
	p = path.Clean("/" + strings.TrimPrefix(p, "/"))
	if !strings.HasSuffix(p, ".md") {
		p += ".md"
	}
	if p == "/.md" || strings.Contains(p, "/../") {
		return "", fmt.Errorf("okf: invalid path %q", p)
	}
	return p, nil
}

// file maps a bundle path to an on-disk path, refusing anything that would
// resolve outside the bundle root.
func (b *Bundle) file(bundlePath string) (string, error) {
	norm, err := Normalize(bundlePath)
	if err != nil {
		return "", err
	}
	full := filepath.Join(b.root, filepath.FromSlash(strings.TrimPrefix(norm, "/")))
	rel, err := filepath.Rel(b.root, full)
	if err != nil || strings.HasPrefix(rel, "..") {
		return "", fmt.Errorf("okf: %q escapes the bundle", bundlePath)
	}
	return full, nil
}

// Read loads and parses one document.
func (b *Bundle) Read(bundlePath string) (*Doc, error) {
	full, err := b.file(bundlePath)
	if err != nil {
		return nil, err
	}
	data, err := os.ReadFile(full)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			norm, _ := Normalize(bundlePath)
			return nil, fmt.Errorf("okf: no concept at %s", norm)
		}
		return nil, err
	}
	norm, _ := Normalize(bundlePath)
	doc := parseDoc(norm, string(data))
	if st, err := os.Stat(full); err == nil {
		doc.ModTime = st.ModTime().UTC().Format(time.RFC3339)
		doc.Size = int(st.Size())
	}
	return doc, nil
}

// WriteOptions describes a concept being written.
type WriteOptions struct {
	Path        string
	Frontmatter map[string]any
	Body        string
	// GeneratedBy records provenance using the spec's actor convention
	// (`<producer>/<version>`, `human:<id>` or `process:<id>`). When set and
	// the caller has not supplied `generated`, it is stamped automatically.
	GeneratedBy string
	// Merge keeps existing frontmatter keys that the caller did not supply,
	// so an agent can update a body without dropping curation it never saw.
	Merge bool
}

// Write creates or replaces a concept document. It enforces the one hard
// conformance rule — a non-reserved document must declare a non-empty
// `type` — and leaves every other field to the producer.
func (b *Bundle) Write(opt WriteOptions) (*Doc, error) {
	norm, err := Normalize(opt.Path)
	if err != nil {
		return nil, err
	}
	full, err := b.file(norm)
	if err != nil {
		return nil, err
	}

	fm := map[string]any{}
	if opt.Merge {
		if prev, err := b.Read(norm); err == nil {
			for k, v := range prev.Frontmatter {
				fm[k] = v
			}
		}
	}
	for k, v := range opt.Frontmatter {
		if v == nil {
			delete(fm, k)
			continue
		}
		fm[k] = v
	}

	reserved := isReserved(norm)
	if !reserved {
		if t, _ := fm["type"].(string); strings.TrimSpace(t) == "" {
			return nil, errors.New(`okf: "type" is required — it is the one field the spec mandates (e.g. type: Runbook)`)
		}
	}
	if _, ok := fm["generated"]; !ok && opt.GeneratedBy != "" {
		fm["generated"] = map[string]any{
			"by": opt.GeneratedBy,
			"at": time.Now().UTC().Format(time.RFC3339),
		}
	}
	if norm == "/"+IndexFile {
		if _, ok := fm["okf_version"]; !ok {
			// only the bundle-root index may declare the target version
			fm["okf_version"] = Version
		}
	}

	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		return nil, err
	}
	body := strings.TrimRight(opt.Body, "\n")
	out := "---\n" + marshalFrontmatter(fm) + "---\n"
	if body != "" {
		out += "\n" + body + "\n"
	}
	if err := os.WriteFile(full, []byte(out), 0o644); err != nil {
		return nil, err
	}
	return b.Read(norm)
}

// Delete removes a concept document.
func (b *Bundle) Delete(bundlePath string) error {
	full, err := b.file(bundlePath)
	if err != nil {
		return err
	}
	if err := os.Remove(full); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			norm, _ := Normalize(bundlePath)
			return fmt.Errorf("okf: no concept at %s", norm)
		}
		return err
	}
	return nil
}

// List walks the bundle and returns every document, sorted by path. Bodies
// are included; callers that only need metadata can ignore them.
func (b *Bundle) List() ([]*Doc, error) {
	var docs []*Doc
	err := filepath.WalkDir(b.root, func(p string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			if strings.HasPrefix(d.Name(), ".") && p != b.root {
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(strings.ToLower(d.Name()), ".md") {
			return nil
		}
		rel, err := filepath.Rel(b.root, p)
		if err != nil {
			return nil
		}
		doc, err := b.Read("/" + filepath.ToSlash(rel))
		if err != nil {
			return nil // a single unreadable file must not fail the listing
		}
		docs = append(docs, doc)
		return nil
	})
	if err != nil {
		return nil, err
	}
	sort.Slice(docs, func(i, j int) bool { return docs[i].Path < docs[j].Path })
	return docs, nil
}

// SearchOptions filters a bundle listing.
type SearchOptions struct {
	Query string   // case-insensitive substring over title, description, path and body
	Type  string   // exact concept type
	Tags  []string // document must carry all of these
	Limit int
}

// Search returns the documents matching opt, most specific filters first.
func (b *Bundle) Search(opt SearchOptions) ([]*Doc, error) {
	all, err := b.List()
	if err != nil {
		return nil, err
	}
	q := strings.ToLower(strings.TrimSpace(opt.Query))
	var out []*Doc
	for _, d := range all {
		if opt.Type != "" && !strings.EqualFold(d.Type(), opt.Type) {
			continue
		}
		if !hasAllTags(d.Tags(), opt.Tags) {
			continue
		}
		if q != "" {
			hay := strings.ToLower(d.Path + "\n" + d.Title() + "\n" + d.Description() + "\n" + d.Body)
			if !strings.Contains(hay, q) {
				continue
			}
		}
		out = append(out, d)
		if opt.Limit > 0 && len(out) >= opt.Limit {
			break
		}
	}
	return out, nil
}

func hasAllTags(have, want []string) bool {
	for _, w := range want {
		found := false
		for _, h := range have {
			if strings.EqualFold(h, w) {
				found = true
				break
			}
		}
		if !found {
			return false
		}
	}
	return true
}

// Node is a concept in the knowledge graph.
type Node struct {
	Path        string   `json:"path"`
	Title       string   `json:"title"`
	Type        string   `json:"type"`
	Description string   `json:"description"`
	Tags        []string `json:"tags,omitempty"`
	Status      string   `json:"status,omitempty"`
	Reserved    bool     `json:"reserved,omitempty"`
	Missing     bool     `json:"missing,omitempty"` // referenced but not present
}

// Edge is one resolved markdown link between two concepts.
type Edge struct {
	From string `json:"from"`
	To   string `json:"to"`
	Text string `json:"text"`
}

// Graph is the whole bundle as nodes and edges.
type Graph struct {
	Nodes   []Node   `json:"nodes"`
	Edges   []Edge   `json:"edges"`
	Broken  []Edge   `json:"broken,omitempty"` // links to documents that do not exist
	Orphans []string `json:"orphans,omitempty"`
	Version string   `json:"okfVersion"`
	Root    string   `json:"root"`
}

// Graph builds the link graph. Broken links are reported rather than
// dropped — the spec tells consumers to tolerate them, and surfacing them is
// more useful than pretending the bundle is complete.
func (b *Bundle) Graph() (*Graph, error) {
	docs, err := b.List()
	if err != nil {
		return nil, err
	}
	g := &Graph{Version: Version, Root: b.root}
	present := make(map[string]bool, len(docs))
	linked := make(map[string]bool, len(docs))
	for _, d := range docs {
		present[d.Path] = true
	}
	for _, d := range docs {
		// index.md and log.md carry the bundle's structure and history, not
		// concepts, so they are not part of the knowledge graph.
		if d.Reserved {
			continue
		}
		g.Nodes = append(g.Nodes, Node{
			Path: d.Path, Title: d.Title(), Type: d.Type(),
			Description: d.Description(), Tags: d.Tags(),
			Status: d.str("status"), Reserved: d.Reserved,
		})
		for _, l := range d.Links {
			// self-links and links into the reserved files are not edges
			// between concepts
			if l.Resolved == "" || l.Resolved == d.Path || isReserved(l.Resolved) {
				continue
			}
			e := Edge{From: d.Path, To: l.Resolved, Text: l.Text}
			if !present[l.Resolved] {
				g.Broken = append(g.Broken, e)
				continue
			}
			g.Edges = append(g.Edges, e)
			linked[l.Resolved] = true
			linked[d.Path] = true
		}
	}
	for _, d := range docs {
		if !linked[d.Path] && !d.Reserved {
			g.Orphans = append(g.Orphans, d.Path)
		}
	}
	return g, nil
}

// Neighbors returns the concepts within depth hops of start, following links
// in both directions so "what relates to this?" has a complete answer.
func (b *Bundle) Neighbors(start string, depth int) ([]Node, []Edge, error) {
	norm, err := Normalize(start)
	if err != nil {
		return nil, nil, err
	}
	if depth <= 0 {
		depth = 1
	}
	g, err := b.Graph()
	if err != nil {
		return nil, nil, err
	}
	byPath := make(map[string]Node, len(g.Nodes))
	for _, n := range g.Nodes {
		byPath[n.Path] = n
	}
	if _, ok := byPath[norm]; !ok {
		return nil, nil, fmt.Errorf("okf: no concept at %s", norm)
	}

	seen := map[string]bool{norm: true}
	frontier := []string{norm}
	var edges []Edge
	edgeSeen := map[string]bool{}
	for hop := 0; hop < depth && len(frontier) > 0; hop++ {
		var nextFrontier []string
		for _, e := range g.Edges {
			var other string
			switch {
			case contains(frontier, e.From):
				other = e.To
			case contains(frontier, e.To):
				other = e.From
			default:
				continue
			}
			key := e.From + "\x00" + e.To + "\x00" + e.Text
			if !edgeSeen[key] {
				edgeSeen[key] = true
				edges = append(edges, e)
			}
			if !seen[other] {
				seen[other] = true
				nextFrontier = append(nextFrontier, other)
			}
		}
		frontier = nextFrontier
	}

	paths := make([]string, 0, len(seen))
	for p := range seen {
		paths = append(paths, p)
	}
	sort.Strings(paths)
	nodes := make([]Node, 0, len(paths))
	for _, p := range paths {
		if n, ok := byPath[p]; ok {
			nodes = append(nodes, n)
		} else {
			nodes = append(nodes, Node{Path: p, Title: path.Base(p), Missing: true})
		}
	}
	return nodes, edges, nil
}

func contains(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}

// AppendLog adds a dated entry to the bundle's reserved log.md, which the
// spec sets aside for chronological update history.
func (b *Bundle) AppendLog(entry, by string) error {
	full, err := b.file("/" + LogFile)
	if err != nil {
		return err
	}
	existing, err := os.ReadFile(full)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	text := string(existing)
	if strings.TrimSpace(text) == "" {
		text = "---\ntype: Log\ntitle: Change log\n---\n\n# Log\n"
	}
	line := fmt.Sprintf("\n- **%s**", time.Now().UTC().Format(time.RFC3339))
	if by != "" {
		line += fmt.Sprintf(" _(%s)_", by)
	}
	line += " — " + strings.TrimSpace(entry) + "\n"
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		return err
	}
	return os.WriteFile(full, []byte(strings.TrimRight(text, "\n")+"\n"+line), 0o644)
}

// Validate checks the three conformance rules a bundle must satisfy and
// reports every violation rather than stopping at the first.
func (b *Bundle) Validate() ([]string, error) {
	docs, err := b.List()
	if err != nil {
		return nil, err
	}
	var problems []string
	present := map[string]bool{}
	for _, d := range docs {
		present[d.Path] = true
	}
	for _, d := range docs {
		if d.Reserved {
			continue
		}
		if len(d.Frontmatter) == 0 {
			problems = append(problems, d.Path+": no YAML frontmatter")
			continue
		}
		if strings.TrimSpace(d.Type()) == "" {
			problems = append(problems, d.Path+`: missing the required "type" field`)
		}
		for _, l := range d.Links {
			if l.Resolved != "" && !present[l.Resolved] {
				problems = append(problems, fmt.Sprintf("%s: link to %s does not resolve", d.Path, l.Resolved))
			}
		}
	}
	return problems, nil
}

func isReserved(bundlePath string) bool {
	base := path.Base(bundlePath)
	return base == IndexFile || base == LogFile
}

// ------------------------------------------------------------- parsing

var linkRe = regexp.MustCompile(`\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)`)

var (
	fenceRe    = regexp.MustCompile("(?s)```.*?```|~~~.*?~~~")
	codeSpanRe = regexp.MustCompile("`[^`\n]*`")
)

// stripCode blanks out fenced blocks and inline code spans before links are
// extracted. A document that *documents* the link syntax — a style guide, a
// runbook quoting a snippet — must not gain edges from its own examples.
// Runs are replaced with spaces so no other offsets shift.
func stripCode(body string) string {
	blank := func(s string) string {
		out := []rune(s)
		for i, r := range out {
			if r != '\n' {
				out[i] = ' '
			}
		}
		return string(out)
	}
	body = fenceRe.ReplaceAllStringFunc(body, blank)
	return codeSpanRe.ReplaceAllStringFunc(body, blank)
}

func parseDoc(bundlePath, raw string) *Doc {
	fm, body := splitFrontmatter(raw)
	d := &Doc{
		Path:        bundlePath,
		Frontmatter: fm,
		Body:        body,
		Reserved:    isReserved(bundlePath),
	}
	dir := path.Dir(bundlePath)
	for _, m := range linkRe.FindAllStringSubmatch(stripCode(body), -1) {
		text, target := m[1], m[2]
		d.Links = append(d.Links, Link{Text: text, Target: target, Resolved: resolveLink(dir, target)})
	}
	return d
}

// resolveLink turns a markdown target into a bundle path when it points at
// another document here. Both link forms in the spec are supported:
// bundle-absolute (leading "/") and ordinary relative paths.
func resolveLink(fromDir, target string) string {
	t := strings.TrimSpace(target)
	if t == "" || strings.HasPrefix(t, "#") || strings.HasPrefix(t, "mailto:") {
		return ""
	}
	if i := strings.IndexAny(t, "#?"); i >= 0 {
		t = t[:i]
	}
	if strings.Contains(t, "://") {
		return ""
	}
	if !strings.HasSuffix(strings.ToLower(t), ".md") {
		return ""
	}
	if strings.HasPrefix(t, "/") {
		return path.Clean(t)
	}
	return path.Clean(path.Join(fromDir, t))
}

// splitFrontmatter separates a leading `---` YAML block from the body.
func splitFrontmatter(raw string) (map[string]any, string) {
	s := strings.ReplaceAll(raw, "\r\n", "\n")
	s = strings.TrimPrefix(s, "\ufeff")
	if !strings.HasPrefix(s, "---\n") && s != "---" {
		return nil, strings.TrimLeft(s, "\n")
	}
	rest := strings.TrimPrefix(s, "---\n")
	end := strings.Index(rest, "\n---")
	if end < 0 {
		return nil, strings.TrimLeft(s, "\n")
	}
	head := rest[:end]
	body := rest[end+len("\n---"):]
	body = strings.TrimPrefix(body, "-")
	body = strings.TrimPrefix(body, "-")
	if i := strings.Index(body, "\n"); i >= 0 {
		body = body[i+1:]
	} else {
		body = ""
	}
	return parseYAML(head), strings.TrimLeft(body, "\n")
}
