// Package server wires the embedded web UI and the JSON API together.
// The server binds to localhost only: devtil is a personal tool and its
// state/proxy endpoints must not be reachable from the network.
package server

import (
	"encoding/json"
	"io"
	"io/fs"
	"net/http"

	"github.com/bhavesh78patil/devtil/internal/kube"
	"github.com/bhavesh78patil/devtil/internal/proxy"
	"github.com/bhavesh78patil/devtil/internal/store"
)

const maxStateBytes = 50 << 20 // 50 MiB of workspace state is plenty

type Server struct {
	store *store.Store
	web   fs.FS
}

func New(st *store.Store, web fs.FS) *Server {
	return &Server{store: st, web: web}
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, map[string]any{"ok": true, "kubectl": kube.Available()})
	})

	mux.HandleFunc("GET /api/state", s.getState)
	mux.HandleFunc("PUT /api/state", s.putState)
	mux.HandleFunc("POST /api/proxy", s.doProxy)

	mux.HandleFunc("GET /api/kube/contexts", s.kubeContexts)
	mux.HandleFunc("GET /api/kube/namespaces", s.kubeNamespaces)
	mux.HandleFunc("GET /api/kube/pods", s.kubePods)
	mux.HandleFunc("POST /api/kube/logs", s.kubeLogs)

	mux.Handle("/", http.FileServer(http.FS(s.web)))
	return mux
}

func (s *Server) getState(w http.ResponseWriter, r *http.Request) {
	data, err := s.store.Load()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Write(data)
}

func (s *Server) putState(w http.ResponseWriter, r *http.Request) {
	data, err := io.ReadAll(io.LimitReader(r.Body, maxStateBytes))
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	if err := s.store.Save(data); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	writeJSON(w, map[string]any{"ok": true})
}

func (s *Server) doProxy(w http.ResponseWriter, r *http.Request) {
	var req proxy.Request
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	resp, err := proxy.Do(req)
	if err != nil {
		writeError(w, http.StatusBadGateway, err)
		return
	}
	writeJSON(w, resp)
}

func (s *Server) kubeContexts(w http.ResponseWriter, r *http.Request) {
	if !requireKubectl(w) {
		return
	}
	names, current, err := kube.Contexts()
	if err != nil {
		writeError(w, http.StatusBadGateway, err)
		return
	}
	writeJSON(w, map[string]any{"contexts": names, "current": current})
}

func (s *Server) kubeNamespaces(w http.ResponseWriter, r *http.Request) {
	if !requireKubectl(w) {
		return
	}
	names, err := kube.Namespaces(r.URL.Query().Get("context"))
	if err != nil {
		writeError(w, http.StatusBadGateway, err)
		return
	}
	writeJSON(w, map[string]any{"namespaces": names})
}

func (s *Server) kubePods(w http.ResponseWriter, r *http.Request) {
	if !requireKubectl(w) {
		return
	}
	q := r.URL.Query()
	if q.Get("namespace") == "" {
		writeError(w, http.StatusBadRequest, errString("namespace is required"))
		return
	}
	pods, err := kube.Pods(q.Get("context"), q.Get("namespace"), q.Get("query"))
	if err != nil {
		writeError(w, http.StatusBadGateway, err)
		return
	}
	writeJSON(w, map[string]any{"pods": pods})
}

func (s *Server) kubeLogs(w http.ResponseWriter, r *http.Request) {
	if !requireKubectl(w) {
		return
	}
	var req kube.LogsRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	resp, err := kube.Logs(req)
	if err != nil {
		writeError(w, http.StatusBadGateway, err)
		return
	}
	writeJSON(w, resp)
}

func requireKubectl(w http.ResponseWriter) bool {
	if !kube.Available() {
		writeError(w, http.StatusServiceUnavailable,
			errString("kubectl not found on PATH — install kubectl to use Kube Logs"))
		return false
	}
	return true
}

type errString string

func (e errString) Error() string { return string(e) }

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, code int, err error) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
}
