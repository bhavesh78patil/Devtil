// Package logging writes devtil's diagnostic log to both stderr and a file
// in the data directory, and serves the tail of that file to the in-app
// Logs viewer. Credentials are never logged — callers must redact.
package logging

import (
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

const maxLogBytes = 5 << 20 // rotate at 5 MiB

var (
	mu   sync.Mutex
	path string
	file *os.File
)

// Init opens (and if needed rotates) the log file in dir and routes the
// standard logger to stderr + file.
func Init(dir string) error {
	mu.Lock()
	defer mu.Unlock()

	path = filepath.Join(dir, "devtil.log")
	if st, err := os.Stat(path); err == nil && st.Size() > maxLogBytes {
		os.Rename(path, path+".old")
	}
	f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	file = f
	log.SetOutput(io.MultiWriter(os.Stderr, f))
	return nil
}

// Path returns the log file location ("" before Init).
func Path() string {
	mu.Lock()
	defer mu.Unlock()
	return path
}

// Logf writes one timestamped line to stderr and the log file.
func Logf(format string, args ...any) {
	log.Printf(format, args...)
}

// Snippet trims s to n bytes for safe inclusion in a log line.
func Snippet(s string, n int) string {
	s = strings.TrimSpace(s)
	if len(s) > n {
		s = s[:n] + "…"
	}
	return strings.ReplaceAll(s, "\n", "\\n")
}

// Tail returns up to n trailing lines of the log file.
func Tail(n int) ([]string, error) {
	mu.Lock()
	p := path
	mu.Unlock()
	if p == "" {
		return nil, fmt.Errorf("logging not initialised")
	}
	data, err := os.ReadFile(p)
	if err != nil {
		if os.IsNotExist(err) {
			return []string{}, nil
		}
		return nil, err
	}
	lines := strings.Split(strings.TrimRight(string(data), "\n"), "\n")
	if n > 0 && len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	return lines, nil
}
