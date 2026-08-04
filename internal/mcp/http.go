package mcp

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/bhavesh78patil/devtil/internal/logging"
)

// Streamable HTTP is MCP's network transport: one endpoint that takes
// JSON-RPC over POST and can answer with either a single JSON body or an SSE
// stream, plus an optional GET stream for server-initiated messages.
//
// Devtil answers every request with a single JSON body — none of its tools
// need to push anything unprompted — but it still implements the session
// header, the GET stream and DELETE termination so hosts that expect the full
// transport connect cleanly.

const (
	sessionHeader     = "Mcp-Session-Id"
	protocolHeader    = "MCP-Protocol-Version"
	maxRequestBytes   = 16 << 20
	sessionIdleExpiry = 2 * time.Hour
)

type session struct {
	id       string
	created  time.Time
	lastSeen time.Time
}

type sessions struct {
	mu sync.Mutex
	m  map[string]*session
}

func newSessions() *sessions { return &sessions{m: map[string]*session{}} }

func (s *sessions) create() *session {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		// A predictable session ID is not a security boundary here (the
		// endpoint is localhost-only and unauthenticated either way), but
		// falling back to a timestamp keeps the server working.
		return &session{id: fmt.Sprintf("devtil-%d", time.Now().UnixNano()), created: time.Now(), lastSeen: time.Now()}
	}
	sess := &session{id: hex.EncodeToString(b[:]), created: time.Now(), lastSeen: time.Now()}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sweepLocked()
	s.m[sess.id] = sess
	return sess
}

func (s *sessions) touch(id string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	sess, ok := s.m[id]
	if !ok {
		return false
	}
	sess.lastSeen = time.Now()
	return true
}

func (s *sessions) drop(id string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.m, id)
}

func (s *sessions) sweepLocked() {
	cutoff := time.Now().Add(-sessionIdleExpiry)
	for id, sess := range s.m {
		if sess.lastSeen.Before(cutoff) {
			delete(s.m, id)
		}
	}
}

// Handler serves the Streamable HTTP transport. Mount it at a single path
// (devtil uses /mcp); the transport multiplexes POST, GET and DELETE there.
func (s *Server) Handler() http.Handler {
	if s.sessions == nil {
		s.sessions = newSessions()
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// DNS-rebinding protection, which the spec requires for a local
		// server: a page on the internet must not be able to drive the
		// developer's tools just because their browser can reach localhost.
		if !originAllowed(r.Header.Get("Origin")) {
			http.Error(w, "forbidden origin", http.StatusForbidden)
			logging.Logf("mcp/http: rejected request from origin %q", r.Header.Get("Origin"))
			return
		}
		policy := s.loadPolicy()
		if !policy.IsEnabled() {
			writeRPCError(w, http.StatusServiceUnavailable, nil, codeInternal,
				"Devtil's MCP server is switched off. Turn it on in Settings → MCP server.")
			return
		}

		switch r.Method {
		case http.MethodPost:
			s.servePost(w, r, policy)
		case http.MethodGet:
			s.serveGet(w, r)
		case http.MethodDelete:
			if id := r.Header.Get(sessionHeader); id != "" {
				s.sessions.drop(id)
			}
			w.WriteHeader(http.StatusNoContent)
		default:
			w.Header().Set("Allow", "POST, GET, DELETE")
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		}
	})
}

func (s *Server) servePost(w http.ResponseWriter, r *http.Request, policy Policy) {
	body, err := io.ReadAll(io.LimitReader(r.Body, maxRequestBytes))
	if err != nil {
		writeRPCError(w, http.StatusBadRequest, nil, codeParse, "could not read request body: "+err.Error())
		return
	}
	trimmed := strings.TrimSpace(string(body))
	if trimmed == "" {
		writeRPCError(w, http.StatusBadRequest, nil, codeParse, "empty request body")
		return
	}

	// A known session ID that we have forgotten must be reported as 404 so
	// the client knows to start a new session rather than retrying forever.
	if id := r.Header.Get(sessionHeader); id != "" && !s.sessions.touch(id) {
		writeRPCError(w, http.StatusNotFound, nil, codeInvalidRequest,
			"unknown or expired session — start a new one by sending initialize without a session id")
		return
	}

	// JSON-RPC batching was dropped in the 2025-06-18 revision but earlier
	// clients still send arrays, so accept both shapes.
	var batch []request
	isBatch := trimmed[0] == '['
	if isBatch {
		if err := json.Unmarshal(body, &batch); err != nil {
			writeRPCError(w, http.StatusBadRequest, nil, codeParse, "invalid JSON: "+err.Error())
			return
		}
	} else {
		var single request
		if err := json.Unmarshal(body, &single); err != nil {
			writeRPCError(w, http.StatusBadRequest, nil, codeParse, "invalid JSON: "+err.Error())
			return
		}
		batch = []request{single}
	}

	var replies []response
	newSessionID := ""
	for _, req := range batch {
		if req.Method == "" {
			replies = append(replies, errorResponse(req.ID, codeInvalidRequest, "missing method"))
			continue
		}
		if req.Method == "initialize" {
			newSessionID = s.sessions.create().id
		}
		result, rpcErr := s.dispatch(req, policy)
		// No id means a notification: act on it, answer nothing.
		if len(req.ID) == 0 || string(req.ID) == "null" {
			continue
		}
		if rpcErr != nil {
			replies = append(replies, errorResponse(req.ID, rpcErr.Code, rpcErr.Message))
			continue
		}
		replies = append(replies, response{JSONRPC: "2.0", ID: req.ID, Result: result})
	}

	if newSessionID != "" {
		w.Header().Set(sessionHeader, newSessionID)
	}
	w.Header().Set(protocolHeader, ProtocolVersion)

	// Nothing to answer — every message was a notification or a response.
	if len(replies) == 0 {
		w.WriteHeader(http.StatusAccepted)
		return
	}

	var payload any = replies[0]
	if isBatch {
		payload = replies
	}
	// The client advertises what it can read. Devtil never needs a stream to
	// answer, but a client that asked for SSE and not JSON gets SSE anyway so
	// it is not forced to parse something it did not agree to.
	accept := r.Header.Get("Accept")
	if strings.Contains(accept, "text/event-stream") && !strings.Contains(accept, "application/json") {
		writeSSEMessage(w, payload)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(payload); err != nil {
		logging.Logf("mcp/http: write response: %v", err)
	}
}

// serveGet opens the optional server-to-client stream. Devtil has nothing to
// push, so the stream stays open with comment keepalives until the client
// goes away — which is what a host expects when it opens one.
func (s *Server) serveGet(w http.ResponseWriter, r *http.Request) {
	if !strings.Contains(r.Header.Get("Accept"), "text/event-stream") {
		w.Header().Set("Allow", "POST, DELETE")
		http.Error(w, "this endpoint streams only to clients that accept text/event-stream", http.StatusMethodNotAllowed)
		return
	}
	if id := r.Header.Get(sessionHeader); id != "" && !s.sessions.touch(id) {
		writeRPCError(w, http.StatusNotFound, nil, codeInvalidRequest,
			"unknown or expired session — start a new one by sending initialize without a session id")
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.WriteHeader(http.StatusOK)
	fmt.Fprint(w, ": devtil mcp stream open\n\n")
	flusher.Flush()

	ticker := time.NewTicker(25 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-ticker.C:
			if _, err := fmt.Fprint(w, ": keepalive\n\n"); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}

func writeSSEMessage(w http.ResponseWriter, payload any) {
	data, err := json.Marshal(payload)
	if err != nil {
		logging.Logf("mcp/http: marshal SSE payload: %v", err)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.WriteHeader(http.StatusOK)
	fmt.Fprintf(w, "event: message\ndata: %s\n\n", data)
	if f, ok := w.(http.Flusher); ok {
		f.Flush()
	}
}

func errorResponse(id json.RawMessage, code int, msg string) response {
	if len(id) == 0 {
		id = json.RawMessage("null")
	}
	return response{JSONRPC: "2.0", ID: id, Error: &rpcError{Code: code, Message: msg}}
}

func writeRPCError(w http.ResponseWriter, status int, id json.RawMessage, code int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(errorResponse(id, code, msg))
}

// originAllowed accepts requests with no Origin (ordinary MCP clients and
// curl send none) and browser requests that came from this machine. Anything
// else is a cross-site attempt at the developer's tools.
func originAllowed(origin string) bool {
	if strings.TrimSpace(origin) == "" {
		return true
	}
	if origin == "null" {
		return false
	}
	u, err := url.Parse(origin)
	if err != nil {
		return false
	}
	host := u.Hostname()
	if host == "localhost" || host == "127.0.0.1" || host == "::1" {
		return true
	}
	// Electron and some hosts use a file:// or app:// origin with no host.
	if host == "" && (u.Scheme == "file" || u.Scheme == "app") {
		return true
	}
	if ip := net.ParseIP(host); ip != nil && ip.IsLoopback() {
		return true
	}
	return false
}
