package okf

import (
	"archive/zip"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// A bundle is shared the way the spec describes one: as an archive of the
// markdown files themselves. Nothing is transformed on the way out, so what
// the recipient unpacks is a working bundle — readable in an editor,
// renderable on GitHub, committable next to the code it describes.

const (
	// maxImportBytes bounds an uploaded archive. Bundles are prose; anything
	// far past this is not a knowledge bundle.
	maxImportBytes = 64 << 20
	// maxDocBytes bounds a single document inside an archive.
	maxDocBytes = 8 << 20
)

// WriteZip streams the bundle to w as a zip archive.
func (b *Bundle) WriteZip(w io.Writer) error {
	docs, err := b.List()
	if err != nil {
		return err
	}
	zw := zip.NewWriter(w)
	for _, d := range docs {
		full, err := b.file(d.Path)
		if err != nil {
			continue
		}
		data, err := os.ReadFile(full)
		if err != nil {
			continue // a file that vanished mid-export is not worth failing over
		}
		hdr := &zip.FileHeader{
			Name:     strings.TrimPrefix(d.Path, "/"),
			Method:   zip.Deflate,
			Modified: time.Now(),
		}
		if st, err := os.Stat(full); err == nil {
			hdr.Modified = st.ModTime()
		}
		f, err := zw.Create(hdr.Name)
		if err != nil {
			return err
		}
		if _, err := f.Write(data); err != nil {
			return err
		}
	}
	return zw.Close()
}

// ImportOptions controls how an incoming archive is merged.
type ImportOptions struct {
	// Prefix nests everything under a bundle folder, e.g. "/vendor/acme".
	// Empty merges at the root.
	Prefix string
	// Overwrite replaces documents that already exist. Off by default: an
	// import should never silently destroy something the user wrote.
	Overwrite bool
}

// ImportResult reports what an import did, in enough detail that the user can
// tell whether anything of theirs was touched.
type ImportResult struct {
	Added    []string `json:"added"`
	Replaced []string `json:"replaced"`
	Skipped  []string `json:"skipped"` // already present, left alone
	Ignored  []string `json:"ignored"` // not markdown, or unsafe path
}

// ReadZip merges the documents in a zip archive into the bundle.
func (b *Bundle) ReadZip(r io.ReaderAt, size int64, opt ImportOptions) (*ImportResult, error) {
	if size <= 0 {
		return nil, fmt.Errorf("okf: the uploaded file is empty")
	}
	if size > maxImportBytes {
		return nil, fmt.Errorf("okf: archive is larger than %d MB", maxImportBytes>>20)
	}
	zr, err := zip.NewReader(r, size)
	if err != nil {
		return nil, fmt.Errorf("okf: not a readable zip archive: %w", err)
	}

	res := &ImportResult{}
	prefix := ""
	if p := strings.TrimSpace(opt.Prefix); p != "" {
		prefix = path.Clean("/" + strings.Trim(strings.ReplaceAll(p, "\\", "/"), "/"))
	}

	// Archives made by "zip -r bundle.zip mybundle/" carry a redundant top
	// directory. Strip it so the bundle does not gain a pointless level.
	strip := commonRoot(zr.File)

	for _, f := range zr.File {
		name := strings.ReplaceAll(f.Name, "\\", "/")
		if f.FileInfo().IsDir() {
			continue
		}
		if !strings.HasSuffix(strings.ToLower(name), ".md") {
			res.Ignored = append(res.Ignored, name)
			continue
		}
		// Skip macOS resource forks and dotfiles rather than importing junk.
		base := path.Base(name)
		if strings.HasPrefix(base, ".") || strings.HasPrefix(name, "__MACOSX/") {
			res.Ignored = append(res.Ignored, name)
			continue
		}
		// Zip-slip: an entry with a ".." segment is never legitimate. Normalize
		// would clamp it into the bundle, but a traversal attempt should be
		// refused outright rather than quietly filed at the root.
		if hasDotDot(name) {
			res.Ignored = append(res.Ignored, name)
			continue
		}
		rel := name
		if strip != "" {
			rel = strings.TrimPrefix(rel, strip)
		}
		target, err := Normalize(prefix + "/" + strings.TrimPrefix(rel, "/"))
		if err != nil {
			res.Ignored = append(res.Ignored, name)
			continue
		}
		// Normalize clamps to the bundle root, but be explicit: a zip entry
		// must never resolve outside it (zip-slip).
		if _, err := b.file(target); err != nil {
			res.Ignored = append(res.Ignored, name)
			continue
		}

		exists := false
		if _, err := b.Read(target); err == nil {
			exists = true
		}
		if exists && !opt.Overwrite {
			res.Skipped = append(res.Skipped, target)
			continue
		}

		rc, err := f.Open()
		if err != nil {
			res.Ignored = append(res.Ignored, name)
			continue
		}
		data, err := io.ReadAll(io.LimitReader(rc, maxDocBytes+1))
		rc.Close()
		if err != nil || len(data) > maxDocBytes {
			res.Ignored = append(res.Ignored, name)
			continue
		}

		// Write the file through as-is: the point of importing a bundle is to
		// get the author's documents, frontmatter and all, not devtil's
		// re-serialisation of them.
		full, err := b.file(target)
		if err != nil {
			res.Ignored = append(res.Ignored, name)
			continue
		}
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			return nil, err
		}
		if err := os.WriteFile(full, data, 0o644); err != nil {
			return nil, err
		}
		if exists {
			res.Replaced = append(res.Replaced, target)
		} else {
			res.Added = append(res.Added, target)
		}
	}

	if len(res.Added)+len(res.Replaced)+len(res.Skipped) == 0 {
		return res, fmt.Errorf("okf: no markdown documents found in that archive")
	}
	sort.Strings(res.Added)
	sort.Strings(res.Replaced)
	sort.Strings(res.Skipped)
	return res, nil
}

func hasDotDot(name string) bool {
	for _, seg := range strings.Split(name, "/") {
		if seg == ".." {
			return true
		}
	}
	return false
}

// commonRoot returns the wrapper directory to strip when someone zipped the
// bundle folder itself ("zip -r bundle.zip mybundle/") rather than its
// contents. Every entry has to sit under one directory *and* that directory
// has to hold the bundle's index.md — otherwise a bundle whose only folder is
// "tables/" would get its real structure flattened away.
func commonRoot(files []*zip.File) string {
	root := ""
	for _, f := range files {
		name := strings.ReplaceAll(f.Name, "\\", "/")
		if strings.HasPrefix(name, "__MACOSX/") {
			continue
		}
		i := strings.Index(name, "/")
		if i < 0 {
			return "" // something lives at the root, so there is no wrapper
		}
		dir := name[:i+1]
		if root == "" {
			root = dir
		} else if root != dir {
			return ""
		}
	}
	if root == "" {
		return ""
	}
	for _, f := range files {
		if strings.ReplaceAll(f.Name, "\\", "/") == root+IndexFile {
			return root
		}
	}
	return ""
}
