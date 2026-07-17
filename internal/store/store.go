// Package store persists the application state (workspaces, tabs, tool data)
// as a single JSON document on disk. Writes are atomic and the previous
// version is kept as a .bak file so an interrupted write never loses data.
package store

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
)

type Store struct {
	mu   sync.Mutex
	path string
}

// New creates a store rooted at dir, creating the directory if needed.
func New(dir string) (*Store, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, fmt.Errorf("create data dir: %w", err)
	}
	return &Store{path: filepath.Join(dir, "state.json")}, nil
}

func (s *Store) Path() string { return s.path }

// Load returns the persisted state, or an empty JSON object if none exists.
// If the primary file is corrupt it falls back to the .bak copy.
func (s *Store) Load() (json.RawMessage, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	for _, p := range []string{s.path, s.path + ".bak"} {
		data, err := os.ReadFile(p)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return nil, err
		}
		if json.Valid(data) {
			return data, nil
		}
	}
	return json.RawMessage(`{}`), nil
}

// Save atomically replaces the persisted state, rotating the current file
// to .bak first.
func (s *Store) Save(data json.RawMessage) error {
	if !json.Valid(data) {
		return errors.New("state is not valid JSON")
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	// the data dir may have been removed while running; recreate it rather
	// than failing every autosave from here on
	if err := os.MkdirAll(filepath.Dir(s.path), 0o755); err != nil {
		return err
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	if _, err := os.Stat(s.path); err == nil {
		if err := os.Rename(s.path, s.path+".bak"); err != nil {
			return err
		}
	}
	return os.Rename(tmp, s.path)
}
