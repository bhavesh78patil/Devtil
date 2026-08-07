package okf

import (
	"archive/zip"
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// newBundle returns an empty bundle. Open seeds a root index.md for real
// users; tests that are counting concepts start from nothing so the numbers
// mean what they say.
func newBundle(t *testing.T) *Bundle {
	t.Helper()
	b, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := b.Delete("/" + IndexFile); err != nil {
		t.Fatalf("removing the seeded index: %v", err)
	}
	return b
}

func write(t *testing.T, b *Bundle, path, typ, body string) *Doc {
	t.Helper()
	d, err := b.Write(WriteOptions{
		Path:        path,
		Frontmatter: map[string]any{"type": typ},
		Body:        body,
	})
	if err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
	return d
}

func TestNormalize(t *testing.T) {
	cases := []struct{ in, want string }{
		{"tables/orders", "/tables/orders.md"},
		{"/tables/orders.md", "/tables/orders.md"},
		{"tables\\orders.md", "/tables/orders.md"},
		{"  /a/b.md  ", "/a/b.md"},
		{"./a.md", "/a.md"},
		// path.Clean drops leading "..", so a traversal attempt is clamped
		// to the bundle root rather than escaping it
		{"../../etc/passwd.md", "/etc/passwd.md"},
		{"a/../../b.md", "/b.md"},
	}
	for _, c := range cases {
		got, err := Normalize(c.in)
		if err != nil {
			t.Errorf("Normalize(%q): %v", c.in, err)
			continue
		}
		if got != c.want {
			t.Errorf("Normalize(%q) = %q, want %q", c.in, got, c.want)
		}
	}
	if _, err := Normalize("   "); err == nil {
		t.Error("an empty path should be rejected")
	}
}

// A concept path must never resolve to a file outside the bundle, however it
// is spelled — this is the one hard security property of the store.
func TestWriteStaysInsideBundle(t *testing.T) {
	root := t.TempDir()
	b, err := Open(filepath.Join(root, "bundle"))
	if err != nil {
		t.Fatal(err)
	}
	sentinel := filepath.Join(root, "escaped.md")

	for _, p := range []string{
		"../escaped.md",
		"../../escaped.md",
		"a/../../../escaped.md",
		"/../escaped.md",
	} {
		if _, err := b.Write(WriteOptions{
			Path:        p,
			Frontmatter: map[string]any{"type": "Test"},
			Body:        "x",
		}); err != nil {
			continue // refusing outright is fine too
		}
		if _, err := os.Stat(sentinel); err == nil {
			t.Fatalf("writing %q escaped the bundle: %s exists", p, sentinel)
		}
	}
}

func TestWriteRequiresType(t *testing.T) {
	b := newBundle(t)
	_, err := b.Write(WriteOptions{Path: "/a.md", Body: "no type"})
	if err == nil {
		t.Fatal(`a concept without "type" should be rejected — it is the spec's only required field`)
	}
	if !strings.Contains(err.Error(), "type") {
		t.Errorf("error should name the missing field, got: %v", err)
	}
	// reserved filenames carry structure, not a concept, so they are exempt
	if _, err := b.Write(WriteOptions{Path: "/" + IndexFile, Body: "# Bundle"}); err != nil {
		t.Errorf("index.md should not require a type: %v", err)
	}
}

// A brand-new bundle is seeded with a root index so an agent opening it has
// the conventions in front of it instead of an empty directory.
func TestOpenSeedsAnIndex(t *testing.T) {
	dir := t.TempDir()
	b, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	doc, err := b.Read("/" + IndexFile)
	if err != nil {
		t.Fatalf("a new bundle should have a seeded index: %v", err)
	}
	if !strings.Contains(doc.Body, "type") || !strings.Contains(doc.Body, "markdown links") {
		t.Errorf("seed does not explain the conventions: %q", doc.Body)
	}
	// The seed documents the link syntax in code spans; that must not turn
	// into edges pointing at concepts nobody wrote.
	for _, l := range doc.Links {
		if l.Resolved != "" {
			t.Errorf("the seeded index created a link to %s", l.Resolved)
		}
	}
	g, err := b.Graph()
	if err != nil {
		t.Fatal(err)
	}
	if len(g.Nodes) != 0 || len(g.Broken) != 0 {
		t.Errorf("a freshly seeded bundle should have an empty graph: %#v", g)
	}

	// Re-opening must not overwrite an index the user has since edited.
	if _, err := b.Write(WriteOptions{Path: "/" + IndexFile, Body: "my own index"}); err != nil {
		t.Fatal(err)
	}
	b2, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	doc, _ = b2.Read("/" + IndexFile)
	if !strings.Contains(doc.Body, "my own index") {
		t.Errorf("re-opening clobbered the index: %q", doc.Body)
	}
}

// Links inside code spans and fenced blocks are examples, not edges.
func TestLinksInsideCodeAreIgnored(t *testing.T) {
	b := newBundle(t)
	doc := write(t, b, "/guide.md", "Note", strings.Join([]string{
		"Write links like `[orders](/tables/orders.md)` in the body.",
		"",
		"```markdown",
		"[customers](/tables/customers.md)",
		"```",
		"",
		"A real link to [products](/tables/products.md).",
	}, "\n"))

	if len(doc.Links) != 1 {
		t.Fatalf("want only the real link, got %#v", doc.Links)
	}
	if doc.Links[0].Resolved != "/tables/products.md" {
		t.Errorf("resolved %q", doc.Links[0].Resolved)
	}
}

// The reserved files describe the bundle; they are not concepts in the graph.
func TestReservedFilesAreNotGraphNodes(t *testing.T) {
	b := newBundle(t)
	write(t, b, "/a.md", "Note", "see the [index](/index.md) and [b](/b.md)")
	write(t, b, "/b.md", "Note", "leaf")
	if _, err := b.Write(WriteOptions{Path: "/" + IndexFile, Body: "root"}); err != nil {
		t.Fatal(err)
	}
	if err := b.AppendLog("something happened", "human:test"); err != nil {
		t.Fatal(err)
	}

	g, err := b.Graph()
	if err != nil {
		t.Fatal(err)
	}
	for _, n := range g.Nodes {
		if n.Path == "/"+IndexFile || n.Path == "/"+LogFile {
			t.Errorf("%s should not be a graph node", n.Path)
		}
	}
	if len(g.Nodes) != 2 {
		t.Errorf("nodes = %d, want 2", len(g.Nodes))
	}
	// The link to the index resolves, so it is not broken — it is simply not
	// an edge between concepts.
	if len(g.Edges) != 1 || g.Edges[0].To != "/b.md" {
		t.Errorf("edges = %#v", g.Edges)
	}
	if len(g.Broken) != 0 {
		t.Errorf("broken = %#v", g.Broken)
	}
}

func TestRootIndexDeclaresVersion(t *testing.T) {
	b := newBundle(t)
	doc, err := b.Write(WriteOptions{Path: "/" + IndexFile, Body: "# Bundle"})
	if err != nil {
		t.Fatal(err)
	}
	if got := doc.Frontmatter["okf_version"]; got != Version {
		t.Errorf("root index okf_version = %v, want %s", got, Version)
	}
	// only the bundle root may declare it
	nested, err := b.Write(WriteOptions{Path: "/tables/" + IndexFile, Body: "# Tables"})
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := nested.Frontmatter["okf_version"]; ok {
		t.Error("a nested index.md must not declare okf_version")
	}
}

func TestRoundTripPreservesUnknownFields(t *testing.T) {
	b := newBundle(t)
	_, err := b.Write(WriteOptions{
		Path: "/m.md",
		Frontmatter: map[string]any{
			"type":            "Metric",
			"title":           "Revenue",
			"owning_team":     "finance", // a producer-specific key
			"custom_nesting":  map[string]any{"a": []any{"x", "y"}},
			"usage_count_avg": 12.5,
		},
		Body: "Body text.",
	})
	if err != nil {
		t.Fatal(err)
	}
	doc, err := b.Read("/m.md")
	if err != nil {
		t.Fatal(err)
	}
	// Consumers must preserve unknown keys, so a read-modify-write cycle
	// cannot be allowed to drop them.
	if doc.Frontmatter["owning_team"] != "finance" {
		t.Errorf("unknown key was lost: %#v", doc.Frontmatter)
	}
	if doc.Frontmatter["usage_count_avg"] != 12.5 {
		t.Errorf("numeric key was lost or retyped: %#v", doc.Frontmatter["usage_count_avg"])
	}
	nested, ok := doc.Frontmatter["custom_nesting"].(map[string]any)
	if !ok || len(nested["a"].([]any)) != 2 {
		t.Errorf("nested key was lost: %#v", doc.Frontmatter["custom_nesting"])
	}
	if doc.Body != "Body text.\n" {
		t.Errorf("body = %q", doc.Body)
	}
}

func TestMergeKeepsExistingFrontmatter(t *testing.T) {
	b := newBundle(t)
	if _, err := b.Write(WriteOptions{
		Path:        "/m.md",
		Frontmatter: map[string]any{"type": "Metric", "title": "Revenue", "curated_by": "human:alice"},
		Body:        "first",
	}); err != nil {
		t.Fatal(err)
	}
	// An agent updating only the body must not wipe curation it never saw.
	doc, err := b.Write(WriteOptions{Path: "/m.md", Body: "second", Merge: true})
	if err != nil {
		t.Fatal(err)
	}
	if doc.Frontmatter["curated_by"] != "human:alice" || doc.Title() != "Revenue" {
		t.Errorf("merge dropped fields: %#v", doc.Frontmatter)
	}
	if doc.Body != "second\n" {
		t.Errorf("body = %q", doc.Body)
	}
	// Without merge, the caller's frontmatter is the whole story.
	if _, err := b.Write(WriteOptions{
		Path:        "/m.md",
		Frontmatter: map[string]any{"type": "Metric"},
		Body:        "third",
	}); err != nil {
		t.Fatal(err)
	}
	doc, _ = b.Read("/m.md")
	if _, ok := doc.Frontmatter["curated_by"]; ok {
		t.Error("a non-merge write should replace frontmatter wholesale")
	}
}

func TestGeneratedProvenance(t *testing.T) {
	b := newBundle(t)
	doc, err := b.Write(WriteOptions{
		Path:        "/a.md",
		Frontmatter: map[string]any{"type": "Note"},
		Body:        "x",
		GeneratedBy: "devtil/mcp",
	})
	if err != nil {
		t.Fatal(err)
	}
	gen, ok := doc.Frontmatter["generated"].(map[string]any)
	if !ok || gen["by"] != "devtil/mcp" || gen["at"] == "" {
		t.Errorf("generated provenance not stamped: %#v", doc.Frontmatter["generated"])
	}
}

func TestLinkResolution(t *testing.T) {
	b := newBundle(t)
	doc := write(t, b, "/tables/orders.md", "Table", strings.Join([]string{
		"Absolute [customers](/tables/customers.md).",
		"Relative [items](items.md).",
		"Up one [runbook](../runbooks/r.md).",
		"With anchor [x](/tables/customers.md#schema).",
		"External [docs](https://example.com/page.md).",
		"Anchor only [top](#top).",
		"Not markdown [img](/assets/a.png).",
	}, "\n"))

	want := map[string]string{
		"customers": "/tables/customers.md",
		"items":     "/tables/items.md",
		"runbook":   "/runbooks/r.md",
		"x":         "/tables/customers.md",
		"docs":      "",
		"top":       "",
		"img":       "",
	}
	if len(doc.Links) != len(want) {
		t.Fatalf("found %d links, want %d: %#v", len(doc.Links), len(want), doc.Links)
	}
	for _, l := range doc.Links {
		if got := want[l.Text]; got != l.Resolved {
			t.Errorf("link %q resolved to %q, want %q", l.Text, l.Resolved, got)
		}
	}
}

func TestGraphEdgesBrokenAndOrphans(t *testing.T) {
	b := newBundle(t)
	write(t, b, "/tables/orders.md", "Table", "See [customers](/tables/customers.md) and [gone](/tables/gone.md).")
	write(t, b, "/tables/customers.md", "Table", "Nothing here.")
	write(t, b, "/notes/loner.md", "Note", "No links at all.")

	g, err := b.Graph()
	if err != nil {
		t.Fatal(err)
	}
	if len(g.Nodes) != 3 {
		t.Errorf("nodes = %d, want 3", len(g.Nodes))
	}
	if len(g.Edges) != 1 || g.Edges[0].From != "/tables/orders.md" || g.Edges[0].To != "/tables/customers.md" {
		t.Errorf("edges = %#v", g.Edges)
	}
	// A broken link is reported, never silently dropped — the spec tells
	// consumers to tolerate them, and surfacing beats pretending.
	if len(g.Broken) != 1 || g.Broken[0].To != "/tables/gone.md" {
		t.Errorf("broken = %#v", g.Broken)
	}
	if len(g.Orphans) != 1 || g.Orphans[0] != "/notes/loner.md" {
		t.Errorf("orphans = %#v", g.Orphans)
	}
	if g.Version != Version {
		t.Errorf("version = %q, want %q", g.Version, Version)
	}
}

func TestNeighborsFollowsLinksBothWays(t *testing.T) {
	b := newBundle(t)
	write(t, b, "/a.md", "Note", "to [b](/b.md)")
	write(t, b, "/b.md", "Note", "to [c](/c.md)")
	write(t, b, "/c.md", "Note", "leaf")
	write(t, b, "/far.md", "Note", "unrelated")

	nodes, _, err := b.Neighbors("/b.md", 1)
	if err != nil {
		t.Fatal(err)
	}
	// b links to c and is linked from a: one hop reaches both.
	if got := paths(nodes); got != "/a.md,/b.md,/c.md" {
		t.Errorf("depth 1 = %s, want /a.md,/b.md,/c.md", got)
	}

	nodes, _, err = b.Neighbors("/a.md", 2)
	if err != nil {
		t.Fatal(err)
	}
	if got := paths(nodes); got != "/a.md,/b.md,/c.md" {
		t.Errorf("depth 2 from a = %s", got)
	}
	if _, _, err := b.Neighbors("/nope.md", 1); err == nil {
		t.Error("neighbors of a missing concept should error")
	}
}

func paths(nodes []Node) string {
	var out []string
	for _, n := range nodes {
		out = append(out, n.Path)
	}
	return strings.Join(out, ",")
}

func TestSearch(t *testing.T) {
	b := newBundle(t)
	if _, err := b.Write(WriteOptions{
		Path: "/tables/orders.md",
		Frontmatter: map[string]any{
			"type": "Table", "title": "Orders",
			"description": "One row per completed order.",
			"tags":        []any{"sales", "revenue"},
		},
		Body: "Joined with customers.",
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := b.Write(WriteOptions{
		Path:        "/runbooks/latency.md",
		Frontmatter: map[string]any{"type": "Runbook", "title": "Latency", "tags": []any{"oncall"}},
		Body:        "Page the on-call.",
	}); err != nil {
		t.Fatal(err)
	}

	cases := []struct {
		name string
		opt  SearchOptions
		want int
	}{
		{"everything", SearchOptions{}, 2},
		{"body text", SearchOptions{Query: "customers"}, 1},
		{"description text", SearchOptions{Query: "COMPLETED"}, 1},
		{"by type", SearchOptions{Type: "runbook"}, 1}, // type match is case-insensitive
		{"by tag", SearchOptions{Tags: []string{"sales"}}, 1},
		{"tags must all match", SearchOptions{Tags: []string{"sales", "oncall"}}, 0},
		{"limit", SearchOptions{Limit: 1}, 1},
		{"no hits", SearchOptions{Query: "zzz"}, 0},
	}
	for _, c := range cases {
		got, err := b.Search(c.opt)
		if err != nil {
			t.Fatalf("%s: %v", c.name, err)
		}
		if len(got) != c.want {
			t.Errorf("%s: got %d, want %d", c.name, len(got), c.want)
		}
	}
}

func TestValidate(t *testing.T) {
	b := newBundle(t)
	write(t, b, "/ok.md", "Note", "links to [ok](/ok.md)")
	problems, err := b.Validate()
	if err != nil {
		t.Fatal(err)
	}
	if len(problems) != 0 {
		t.Fatalf("a clean bundle reported problems: %v", problems)
	}

	// A file written outside the API — no frontmatter at all.
	if err := os.WriteFile(filepath.Join(b.Root(), "raw.md"), []byte("# Just markdown\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	write(t, b, "/dangling.md", "Note", "see [gone](/gone.md)")
	problems, err = b.Validate()
	if err != nil {
		t.Fatal(err)
	}
	if len(problems) != 2 {
		t.Fatalf("want 2 problems, got %v", problems)
	}
}

func TestParseTolerantOfMalformedFrontmatter(t *testing.T) {
	b := newBundle(t)
	// A consumer must not reject a document outright; an unparseable header
	// yields an untyped concept rather than an error.
	for name, content := range map[string]string{
		"no-fm.md":    "# Heading\n\nBody.",
		"unclosed.md": "---\ntype: Note\n\nBody with no closing fence.",
		"bad-yaml.md": "---\ntype: [unclosed\n---\n\nBody.",
		"empty-fm.md": "---\n---\n\nBody.",
		"windows.md":  "---\r\ntype: Note\r\ntitle: CRLF\r\n---\r\n\r\nBody.\r\n",
	} {
		if err := os.WriteFile(filepath.Join(b.Root(), name), []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
		doc, err := b.Read("/" + name)
		if err != nil {
			t.Errorf("%s: read failed: %v", name, err)
			continue
		}
		if !strings.Contains(doc.Body, "Body") {
			t.Errorf("%s: body = %q", name, doc.Body)
		}
	}
	doc, err := b.Read("/windows.md")
	if err != nil {
		t.Fatal(err)
	}
	if doc.Type() != "Note" || doc.Title() != "CRLF" {
		t.Errorf("CRLF frontmatter not parsed: %#v", doc.Frontmatter)
	}
	// Listing must survive files it cannot fully understand.
	docs, err := b.List()
	if err != nil {
		t.Fatalf("List failed on a messy bundle: %v", err)
	}
	if len(docs) != 5 {
		t.Errorf("List returned %d docs, want 5", len(docs))
	}
}

func TestTitleFallsBackToFilename(t *testing.T) {
	b := newBundle(t)
	doc := write(t, b, "/tables/order-items.md", "Table", "x")
	if doc.Title() != "order-items" {
		t.Errorf("title = %q, want the filename", doc.Title())
	}
}

func TestAppendLog(t *testing.T) {
	b := newBundle(t)
	if err := b.AppendLog("first entry", "human:alice"); err != nil {
		t.Fatal(err)
	}
	if err := b.AppendLog("second entry", ""); err != nil {
		t.Fatal(err)
	}
	doc, err := b.Read("/" + LogFile)
	if err != nil {
		t.Fatal(err)
	}
	if !doc.Reserved {
		t.Error("log.md should be marked reserved")
	}
	if !strings.Contains(doc.Body, "first entry") || !strings.Contains(doc.Body, "second entry") {
		t.Errorf("log lost an entry: %q", doc.Body)
	}
	if !strings.Contains(doc.Body, "human:alice") {
		t.Errorf("log lost the actor: %q", doc.Body)
	}
}

func TestDelete(t *testing.T) {
	b := newBundle(t)
	write(t, b, "/a.md", "Note", "x")
	if err := b.Delete("/a.md"); err != nil {
		t.Fatal(err)
	}
	if _, err := b.Read("/a.md"); err == nil {
		t.Error("read after delete should fail")
	}
	if err := b.Delete("/a.md"); err == nil {
		t.Error("deleting a missing concept should report it")
	}
}

// ---- sharing a bundle -------------------------------------------------

// A bundle round-trips through a zip unchanged: the recipient unpacks the
// author's markdown, not devtil's re-serialisation of it.
func TestZipRoundTrip(t *testing.T) {
	src := newBundle(t)
	if _, err := src.Write(WriteOptions{
		Path:        "/tables/orders.md",
		Frontmatter: map[string]any{"type": "Table", "title": "Orders", "tags": []any{"sales"}},
		Body:        "Joined with [customers](/tables/customers.md).",
	}); err != nil {
		t.Fatal(err)
	}
	write(t, src, "/tables/customers.md", "Table", "One row per customer.")
	write(t, src, "/runbooks/deep/nested.md", "Runbook", "Nested folders survive.")
	if err := src.AppendLog("exported", "human:test"); err != nil {
		t.Fatal(err)
	}
	original, err := src.Read("/tables/orders.md")
	if err != nil {
		t.Fatal(err)
	}

	var buf bytes.Buffer
	if err := src.WriteZip(&buf); err != nil {
		t.Fatal(err)
	}

	dst := newBundle(t)
	res, err := dst.ReadZip(bytes.NewReader(buf.Bytes()), int64(buf.Len()), ImportOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Added) != 4 {
		t.Errorf("added %v, want 4 documents", res.Added)
	}
	got, err := dst.Read("/tables/orders.md")
	if err != nil {
		t.Fatal(err)
	}
	if got.Body != original.Body || got.Title() != "Orders" || len(got.Tags()) != 1 {
		t.Errorf("document did not survive the round trip: %#v", got)
	}
	if _, err := dst.Read("/runbooks/deep/nested.md"); err != nil {
		t.Errorf("nested folders were lost: %v", err)
	}
	// the graph rebuilds on the other side
	g, err := dst.Graph()
	if err != nil {
		t.Fatal(err)
	}
	if len(g.Edges) != 1 {
		t.Errorf("links did not survive: %#v", g.Edges)
	}
}

// An import must not overwrite the user's own work unless they asked.
func TestImportDoesNotClobberByDefault(t *testing.T) {
	src := newBundle(t)
	write(t, src, "/a.md", "Note", "theirs")
	var buf bytes.Buffer
	if err := src.WriteZip(&buf); err != nil {
		t.Fatal(err)
	}

	dst := newBundle(t)
	write(t, dst, "/a.md", "Note", "mine")

	res, err := dst.ReadZip(bytes.NewReader(buf.Bytes()), int64(buf.Len()), ImportOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Skipped) != 1 || len(res.Replaced) != 0 {
		t.Errorf("want the existing doc skipped, got %#v", res)
	}
	doc, _ := dst.Read("/a.md")
	if !strings.Contains(doc.Body, "mine") {
		t.Errorf("import clobbered existing content: %q", doc.Body)
	}

	// ...and does overwrite when they do.
	res, err = dst.ReadZip(bytes.NewReader(buf.Bytes()), int64(buf.Len()), ImportOptions{Overwrite: true})
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Replaced) != 1 {
		t.Errorf("want 1 replaced, got %#v", res)
	}
	doc, _ = dst.Read("/a.md")
	if !strings.Contains(doc.Body, "theirs") {
		t.Errorf("overwrite did not take: %q", doc.Body)
	}
}

// Importing under a prefix keeps someone else's bundle in its own corner.
func TestImportUnderPrefix(t *testing.T) {
	src := newBundle(t)
	write(t, src, "/tables/orders.md", "Table", "x")
	var buf bytes.Buffer
	if err := src.WriteZip(&buf); err != nil {
		t.Fatal(err)
	}

	dst := newBundle(t)
	res, err := dst.ReadZip(bytes.NewReader(buf.Bytes()), int64(buf.Len()), ImportOptions{Prefix: "vendor/acme"})
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Added) != 1 || res.Added[0] != "/vendor/acme/tables/orders.md" {
		t.Errorf("added %v, want it nested under the prefix", res.Added)
	}
}

// A hand-made archive is the hostile case: traversal entries, non-markdown
// files and a redundant top-level directory.
func TestImportRejectsUnsafeEntries(t *testing.T) {
	root := t.TempDir()
	b, err := Open(filepath.Join(root, "bundle"))
	if err != nil {
		t.Fatal(err)
	}
	sentinel := filepath.Join(root, "escaped.md")

	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for _, name := range []string{
		// index.md at the wrapper root is what marks "mybundle/" as a
		// wrapper rather than a real bundle folder
		"mybundle/index.md",
		"mybundle/notes/real.md",
		"mybundle/../../escaped.md",
		"mybundle/assets/logo.png",
		"mybundle/.hidden.md",
		"__MACOSX/mybundle/._real.md",
	} {
		f, err := zw.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		f.Write([]byte("---\ntype: Note\n---\n\nbody\n"))
	}
	zw.Close()

	res, err := b.ReadZip(bytes.NewReader(buf.Bytes()), int64(buf.Len()), ImportOptions{})
	if err != nil {
		t.Fatal(err)
	}
	// the redundant "mybundle/" wrapper is stripped; the bundle Open seeded
	// an index.md already, so the incoming one is skipped rather than added
	if len(res.Added) != 1 || res.Added[0] != "/notes/real.md" {
		t.Errorf("added %v, want just /notes/real.md", res.Added)
	}
	if len(res.Skipped) != 1 || res.Skipped[0] != "/index.md" {
		t.Errorf("skipped %v, want the existing index left alone", res.Skipped)
	}
	if _, err := os.Stat(sentinel); err == nil {
		t.Fatalf("a zip entry escaped the bundle: %s exists", sentinel)
	}
	if len(res.Ignored) < 3 {
		t.Errorf("non-markdown, hidden and resource-fork entries should be ignored: %#v", res.Ignored)
	}
}

func TestImportRejectsRubbish(t *testing.T) {
	b := newBundle(t)
	if _, err := b.ReadZip(bytes.NewReader([]byte("not a zip")), 9, ImportOptions{}); err == nil {
		t.Error("a non-zip upload should be reported")
	}
	if _, err := b.ReadZip(bytes.NewReader(nil), 0, ImportOptions{}); err == nil {
		t.Error("an empty upload should be reported")
	}
	// a valid zip with nothing usable in it
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	f, _ := zw.Create("readme.txt")
	f.Write([]byte("hello"))
	zw.Close()
	if _, err := b.ReadZip(bytes.NewReader(buf.Bytes()), int64(buf.Len()), ImportOptions{}); err == nil {
		t.Error("an archive with no markdown should be reported")
	}
}

// A folder that merely happens to be the only one must not be mistaken for a
// wrapper and flattened away.
func TestImportKeepsRealTopLevelFolder(t *testing.T) {
	src := newBundle(t)
	write(t, src, "/tables/orders.md", "Table", "x")
	write(t, src, "/tables/customers.md", "Table", "y")
	var buf bytes.Buffer
	if err := src.WriteZip(&buf); err != nil {
		t.Fatal(err)
	}
	dst := newBundle(t)
	res, err := dst.ReadZip(bytes.NewReader(buf.Bytes()), int64(buf.Len()), ImportOptions{})
	if err != nil {
		t.Fatal(err)
	}
	for _, p := range res.Added {
		if !strings.HasPrefix(p, "/tables/") {
			t.Errorf("added %q — the tables/ folder was flattened", p)
		}
	}
}
