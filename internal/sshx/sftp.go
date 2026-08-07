package sshx

import (
	"fmt"
	"io"
	"path"
	"sort"
	"strings"
	"time"

	"github.com/pkg/sftp"
)

type FileEntry struct {
	Name    string `json:"name"`
	Size    int64  `json:"size"`
	IsDir   bool   `json:"isDir"`
	Mode    string `json:"mode"`
	ModTime string `json:"modTime"`
}

// SFTPList lists a remote directory over SFTP. An empty path resolves to the
// login user's home/working directory. Directories are sorted first.
func SFTPList(conn Conn, p string) ([]FileEntry, string, error) {
	client, err := Dial(conn)
	if err != nil {
		return nil, "", err
	}
	defer client.Close()

	fs, err := sftp.NewClient(client)
	if err != nil {
		return nil, "", fmt.Errorf("sftp: %v", err)
	}
	defer fs.Close()

	if strings.TrimSpace(p) == "" {
		if wd, err := fs.Getwd(); err == nil && wd != "" {
			p = wd
		} else {
			p = "/"
		}
	}
	p = path.Clean(p)

	infos, err := fs.ReadDir(p)
	if err != nil {
		return nil, p, fmt.Errorf("sftp: %v", err)
	}
	entries := make([]FileEntry, 0, len(infos))
	for _, fi := range infos {
		entries = append(entries, FileEntry{
			Name:    fi.Name(),
			Size:    fi.Size(),
			IsDir:   fi.IsDir(),
			Mode:    fi.Mode().String(),
			ModTime: fi.ModTime().UTC().Format(time.RFC3339),
		})
	}
	sort.Slice(entries, func(i, j int) bool {
		if entries[i].IsDir != entries[j].IsDir {
			return entries[i].IsDir
		}
		return strings.ToLower(entries[i].Name) < strings.ToLower(entries[j].Name)
	})
	return entries, p, nil
}

// multiCloser closes several resources (file, sftp client, ssh client) when
// the streamed download finishes.
type multiCloser struct {
	io.Reader
	closers []io.Closer
}

func (m *multiCloser) Close() error {
	for i := len(m.closers) - 1; i >= 0; i-- {
		m.closers[i].Close()
	}
	return nil
}

// SFTPOpen opens a remote file for download. The caller must Close the
// returned reader, which tears down the file handle and both clients.
func SFTPOpen(conn Conn, p string) (rc io.ReadCloser, name string, size int64, err error) {
	if strings.TrimSpace(p) == "" {
		return nil, "", 0, fmt.Errorf("a file path is required")
	}
	client, err := Dial(conn)
	if err != nil {
		return nil, "", 0, err
	}
	fs, err := sftp.NewClient(client)
	if err != nil {
		client.Close()
		return nil, "", 0, fmt.Errorf("sftp: %v", err)
	}
	f, err := fs.Open(p)
	if err != nil {
		fs.Close()
		client.Close()
		return nil, "", 0, fmt.Errorf("sftp: %v", err)
	}
	if st, err := f.Stat(); err == nil {
		if st.IsDir() {
			f.Close()
			fs.Close()
			client.Close()
			return nil, "", 0, fmt.Errorf("%s is a directory", path.Base(p))
		}
		size = st.Size()
	}
	return &multiCloser{Reader: f, closers: []io.Closer{f, fs, client}}, path.Base(p), size, nil
}

// SFTPReadText reads a remote file as text, stopping at max bytes. It reports
// the size it read and whether more was left, so a caller never mistakes a
// truncated file for the whole thing.
func SFTPReadText(conn Conn, p string, max int) (text string, size int, truncated bool, err error) {
	rc, _, _, err := SFTPOpen(conn, p)
	if err != nil {
		return "", 0, false, err
	}
	defer rc.Close()
	buf, err := io.ReadAll(io.LimitReader(rc, int64(max)+1))
	if err != nil {
		return "", 0, false, err
	}
	if len(buf) > max {
		return string(buf[:max]), max, true, nil
	}
	return string(buf), len(buf), false, nil
}
