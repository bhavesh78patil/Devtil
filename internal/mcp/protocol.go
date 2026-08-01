// Package mcp exposes Devtil's tools to AI agents over the Model Context
// Protocol, so an agent working alongside a developer can consume a Kafka
// topic, run a query, tail pod logs or evaluate a JSONPath with the same
// code paths the UI uses.
//
// The transport is JSON-RPC 2.0 over stdio — newline-delimited JSON on
// stdin/stdout — which is what agent hosts launch a local MCP server with.
// Nothing is written to stdout except protocol messages; diagnostics go to
// stderr so they can never corrupt the stream.
package mcp

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"sync"

	"github.com/bhavesh78patil/devtil/internal/store"
)

// ProtocolVersion is the MCP revision Devtil implements. When a client asks
// for a different revision we echo theirs back if we know it, since the
// negotiated version is the client's choice among versions both support.
const ProtocolVersion = "2025-06-18"

var knownVersions = map[string]bool{
	"2024-11-05": true,
	"2025-03-26": true,
	"2025-06-18": true,
}

// ServerName and ServerVersion identify Devtil in the initialize handshake.
const (
	ServerName    = "devtil"
	ServerVersion = "1.0.0"
)

type request struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

type response struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Result  any             `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
	Data    any    `json:"data,omitempty"`
}

// JSON-RPC 2.0 error codes.
const (
	codeParse          = -32700
	codeInvalidRequest = -32600
	codeMethodNotFound = -32601
	codeInvalidParams  = -32602
	codeInternal       = -32603
)

// Options configures what a server can reach on the local machine.
type Options struct {
	// Store is the UI's state file, used to resolve saved connections by
	// name. Optional — without it, callers must pass connection fields
	// inline.
	Store *store.Store
	// OKFDir is the Open Knowledge Format bundle the okf_* tools read and
	// write. Optional — without it those tools report that no bundle is
	// configured rather than disappearing from the list.
	OKFDir string
}

// Server speaks MCP over a reader/writer pair.
type Server struct {
	in  io.Reader
	out io.Writer

	store  *store.Store
	okfDir string

	mu    sync.Mutex // serialises writes; one JSON message per line
	tools map[string]*Tool
	order []string
}

// NewServer builds a server with the full Devtil tool set registered.
func NewServer(in io.Reader, out io.Writer, opt Options) *Server {
	s := &Server{in: in, out: out, store: opt.Store, okfDir: opt.OKFDir, tools: map[string]*Tool{}}
	s.registerAll()
	return s
}

// Serve reads requests until the input stream closes.
func (s *Server) Serve() error {
	sc := bufio.NewScanner(s.in)
	// Tool results can carry a large payload (a query result set, a log
	// window); the default 64 KiB line cap is far too small for the requests
	// that produce them.
	sc.Buffer(make([]byte, 0, 64*1024), 16<<20)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" {
			continue
		}
		s.handleLine([]byte(line))
	}
	if err := sc.Err(); err != nil && !errors.Is(err, io.EOF) {
		return err
	}
	return nil
}

func (s *Server) handleLine(line []byte) {
	var req request
	if err := json.Unmarshal(line, &req); err != nil {
		s.writeError(nil, codeParse, "invalid JSON: "+err.Error(), nil)
		return
	}
	if req.Method == "" {
		s.writeError(req.ID, codeInvalidRequest, "missing method", nil)
		return
	}
	// A request without an id is a notification: act on it, answer nothing.
	isNotification := len(req.ID) == 0 || string(req.ID) == "null"

	result, rpcErr := s.dispatch(req)
	if isNotification {
		return
	}
	if rpcErr != nil {
		s.writeError(req.ID, rpcErr.Code, rpcErr.Message, rpcErr.Data)
		return
	}
	s.write(response{JSONRPC: "2.0", ID: req.ID, Result: result})
}

func (s *Server) dispatch(req request) (any, *rpcError) {
	switch req.Method {
	case "initialize":
		return s.initialize(req.Params), nil

	case "notifications/initialized", "notifications/cancelled":
		return map[string]any{}, nil

	case "ping":
		return map[string]any{}, nil

	case "tools/list":
		return map[string]any{"tools": s.toolDescriptors()}, nil

	case "tools/call":
		return s.callTool(req.Params)

	case "resources/list":
		return map[string]any{"resources": []any{}}, nil

	case "resources/templates/list":
		return map[string]any{"resourceTemplates": []any{}}, nil

	case "prompts/list":
		return map[string]any{"prompts": []any{}}, nil

	default:
		return nil, &rpcError{Code: codeMethodNotFound, Message: "unknown method " + req.Method}
	}
}

func (s *Server) initialize(params json.RawMessage) any {
	version := ProtocolVersion
	var p struct {
		ProtocolVersion string `json:"protocolVersion"`
	}
	if len(params) > 0 && json.Unmarshal(params, &p) == nil {
		if knownVersions[p.ProtocolVersion] {
			version = p.ProtocolVersion
		}
	}
	return map[string]any{
		"protocolVersion": version,
		"capabilities": map[string]any{
			"tools": map[string]any{"listChanged": false},
		},
		"serverInfo": map[string]any{
			"name":    ServerName,
			"version": ServerVersion,
		},
		"instructions": instructions,
	}
}

const instructions = `Devtil exposes a developer's local toolbox: JSON/JSONPath/XML utilities,
encoders, an HTTP client, Kafka, relational and Cassandra databases,
Elasticsearch/OpenSearch, Kubernetes and SSH — plus an OKF knowledge bundle
for recording what you learn.

Connections: infrastructure tools take either inline connection fields or a
"connection" name that resolves against the connections the user has already
saved in the Devtil UI. Prefer the saved name — Devtil holds the credentials
locally and never returns them to you. Call devtil_connections first to see
what is available.

Knowledge: okf_* tools read and write an Open Knowledge Format bundle
(markdown + YAML frontmatter, linked into a graph). Record durable findings
there — a table's meaning, a topic's schema, a runbook — so later sessions
can look them up instead of rediscovering them. Every document needs a
"type"; link related concepts with ordinary markdown links.`

func (s *Server) write(v any) {
	s.mu.Lock()
	defer s.mu.Unlock()
	data, err := json.Marshal(v)
	if err != nil {
		fmt.Fprintf(os.Stderr, "mcp: marshal response: %v\n", err)
		return
	}
	data = append(data, '\n')
	if _, err := s.out.Write(data); err != nil {
		fmt.Fprintf(os.Stderr, "mcp: write: %v\n", err)
	}
	if f, ok := s.out.(interface{ Sync() error }); ok {
		_ = f.Sync()
	}
}

func (s *Server) writeError(id json.RawMessage, code int, msg string, data any) {
	if len(id) == 0 {
		id = json.RawMessage("null")
	}
	s.write(response{JSONRPC: "2.0", ID: id, Error: &rpcError{Code: code, Message: msg, Data: data}})
}
