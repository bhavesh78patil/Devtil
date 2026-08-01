// Package server wires the embedded web UI and the JSON API together.
// The server binds to localhost only: devtil is a personal tool and its
// state/proxy endpoints must not be reachable from the network.
package server

import (
	"bufio"
	"encoding/json"
	"io"
	"io/fs"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"golang.org/x/crypto/ssh"

	"github.com/bhavesh78patil/devtil/internal/clients"
	"github.com/bhavesh78patil/devtil/internal/kube"
	"github.com/bhavesh78patil/devtil/internal/logging"
	"github.com/bhavesh78patil/devtil/internal/proxy"
	"github.com/bhavesh78patil/devtil/internal/sshx"
	"github.com/bhavesh78patil/devtil/internal/store"
)

const maxStateBytes = 50 << 20 // 50 MiB of workspace state is plenty

type Server struct {
	store *store.Store
	web   fs.FS
	// okfDir is the Open Knowledge Format bundle the Knowledge Graph tool
	// reads and writes — the same bundle `devtil mcp` gives agents.
	okfDir string
}

func New(st *store.Store, web fs.FS, okfDir string) *Server {
	return &Server{store: st, web: web, okfDir: okfDir}
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, map[string]any{"ok": true, "kubectl": kube.Available(), "ssh": kube.SSHAvailable()})
	})

	mux.HandleFunc("GET /api/state", s.getState)
	mux.HandleFunc("PUT /api/state", s.putState)
	mux.HandleFunc("POST /api/proxy", s.doProxy)

	mux.HandleFunc("POST /api/kafka/topics", s.kafkaTopics)
	mux.HandleFunc("POST /api/kafka/consume", s.kafkaConsume)
	mux.HandleFunc("POST /api/kafka/consume/stream", s.kafkaConsumeStream)
	mux.HandleFunc("POST /api/kafka/produce", s.kafkaProduce)
	mux.HandleFunc("POST /api/db/query", s.dbQuery)
	mux.HandleFunc("POST /api/ssh/exec", s.sshExec)
	mux.HandleFunc("GET /api/ssh/pty", s.sshPTY)
	mux.HandleFunc("POST /api/sftp/list", s.sftpList)
	mux.HandleFunc("POST /api/sftp/download", s.sftpDownload)

	mux.HandleFunc("GET /api/kube/contexts", s.kubeContexts)
	mux.HandleFunc("GET /api/kube/namespaces", s.kubeNamespaces)
	mux.HandleFunc("GET /api/kube/pods", s.kubePods)
	mux.HandleFunc("POST /api/kube/logs", s.kubeLogs)
	mux.HandleFunc("POST /api/kube/exec", s.kubeExec)

	mux.HandleFunc("GET /api/okf/list", s.okfList)
	mux.HandleFunc("GET /api/okf/doc", s.okfRead)
	mux.HandleFunc("PUT /api/okf/doc", s.okfWrite)
	mux.HandleFunc("DELETE /api/okf/doc", s.okfDelete)
	mux.HandleFunc("GET /api/okf/graph", s.okfGraph)

	mux.HandleFunc("GET /api/logs", s.getLogs)
	mux.HandleFunc("POST /api/logs/client", s.clientLog)

	mux.Handle("/", http.FileServer(http.FS(s.web)))
	return logRequests(mux)
}

// statusRecorder captures the response code for the request log.
type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (r *statusRecorder) WriteHeader(code int) {
	r.status = code
	r.ResponseWriter.WriteHeader(code)
}

// Hijack lets the WebSocket (PTY) endpoint take over the connection even
// though the response is wrapped for request logging.
func (r *statusRecorder) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	h, ok := r.ResponseWriter.(http.Hijacker)
	if !ok {
		return nil, nil, errString("underlying ResponseWriter is not a http.Hijacker")
	}
	return h.Hijack()
}

// Flush keeps streaming endpoints (NDJSON) working through the log wrapper —
// without it the handler can't push partial responses to the client.
func (r *statusRecorder) Flush() {
	if f, ok := r.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

// logRequests logs every /api call (except the log viewer's own polling)
// with method, path, status and duration. Query strings are dropped —
// they can carry tokens.
func logRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.URL.Path, "/api/") || strings.HasPrefix(r.URL.Path, "/api/logs") {
			next.ServeHTTP(w, r)
			return
		}
		rec := &statusRecorder{ResponseWriter: w, status: 200}
		start := time.Now()
		next.ServeHTTP(rec, r)
		logging.Logf("http: %s %s -> %d (%dms)", r.Method, r.URL.Path, rec.status, time.Since(start).Milliseconds())
	})
}

func (s *Server) getLogs(w http.ResponseWriter, r *http.Request) {
	n, _ := strconv.Atoi(r.URL.Query().Get("lines"))
	if n <= 0 || n > 5000 {
		n = 500
	}
	lines, err := logging.Tail(n)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, map[string]any{"lines": lines, "path": logging.Path()})
}

// clientLog lets the frontend record its own errors into the same log.
func (s *Server) clientLog(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Message string `json:"message"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 16<<10)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	logging.Logf("ui: %s", logging.Snippet(req.Message, 2000))
	writeJSON(w, map[string]any{"ok": true})
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

func connFromQuery(q url.Values) kube.Conn {
	return kube.Conn{
		Context:     q.Get("context"),
		Server:      q.Get("server"),
		Token:       q.Get("token"),
		Insecure:    q.Get("insecure") == "true",
		SSHHost:     q.Get("sshHost"),
		SSHPort:     q.Get("sshPort"),
		SSHKey:      q.Get("sshKey"),
		SSHPassword: q.Get("sshPassword"),
	}
}

func (s *Server) kubeContexts(w http.ResponseWriter, r *http.Request) {
	conn := connFromQuery(r.URL.Query())
	if !requireTools(w, conn) {
		return
	}
	names, current, err := kube.Contexts(conn)
	if err != nil {
		writeError(w, http.StatusBadGateway, err)
		return
	}
	writeJSON(w, map[string]any{"contexts": names, "current": current})
}

func (s *Server) kubeNamespaces(w http.ResponseWriter, r *http.Request) {
	conn := connFromQuery(r.URL.Query())
	if !requireTools(w, conn) {
		return
	}
	names, err := kube.Namespaces(conn)
	if err != nil {
		writeError(w, http.StatusBadGateway, err)
		return
	}
	writeJSON(w, map[string]any{"namespaces": names})
}

func (s *Server) kubePods(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	conn := connFromQuery(q)
	if !requireTools(w, conn) {
		return
	}
	if q.Get("namespace") == "" {
		writeError(w, http.StatusBadRequest, errString("namespace is required"))
		return
	}
	pods, err := kube.Pods(conn, q.Get("namespace"), q.Get("query"))
	if err != nil {
		writeError(w, http.StatusBadGateway, err)
		return
	}
	writeJSON(w, map[string]any{"pods": pods})
}

func (s *Server) kubeLogs(w http.ResponseWriter, r *http.Request) {
	var req kube.LogsRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	if !requireTools(w, req.Conn) {
		return
	}
	resp, err := kube.Logs(req)
	if err != nil {
		writeError(w, http.StatusBadGateway, err)
		return
	}
	writeJSON(w, resp)
}

func (s *Server) kafkaTopics(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Conn clients.KafkaConn `json:"conn"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	topics, err := clients.KafkaTopics(req.Conn)
	if err != nil {
		writeError(w, http.StatusBadGateway, err)
		return
	}
	writeJSON(w, map[string]any{"topics": topics})
}

func (s *Server) kafkaConsume(w http.ResponseWriter, r *http.Request) {
	var req clients.KafkaConsumeRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	resp, err := clients.KafkaConsume(req)
	if err != nil {
		writeError(w, http.StatusBadGateway, err)
		return
	}
	writeJSON(w, resp)
}

// kafkaConsumeStream runs a consume and writes newline-delimited JSON as the
// read progresses, so the UI can show messages while partitions are still
// being read instead of waiting for the whole result.
//
// Line kinds: {"type":"msg","message":{…}} per match, then exactly one
// {"type":"done",…} or {"type":"error","error":…}.
func (s *Server) kafkaConsumeStream(w http.ResponseWriter, r *http.Request) {
	var req clients.KafkaConsumeRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		// no streaming support — answer in one shot with the same shape as the
		// terminal line, using the request we already decoded
		resp, err := clients.KafkaConsume(req)
		if err != nil {
			writeError(w, http.StatusBadGateway, err)
			return
		}
		writeJSON(w, map[string]any{
			"type": "done", "messages": resp.Messages, "scanned": resp.Scanned,
			"matched": resp.Matched, "truncated": resp.Truncated,
		})
		return
	}
	w.Header().Set("Content-Type", "application/x-ndjson")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)

	enc := json.NewEncoder(w)
	var mu sync.Mutex
	started := time.Now()
	write := func(v any) {
		mu.Lock()
		defer mu.Unlock()
		enc.Encode(v)
		flusher.Flush()
	}

	sent := 0
	resp, err := clients.KafkaConsumeStream(req, func(m clients.KafkaMessage) {
		sent++
		write(map[string]any{"type": "msg", "message": m, "elapsedMs": time.Since(started).Milliseconds()})
	})
	if err != nil {
		write(map[string]any{"type": "error", "error": err.Error(), "elapsedMs": time.Since(started).Milliseconds()})
		return
	}
	// the streamed messages are in partition order; the final line carries the
	// sorted + trimmed result so the client can settle on the correct list
	write(map[string]any{
		"type": "done", "messages": resp.Messages, "scanned": resp.Scanned,
		"matched": resp.Matched, "truncated": resp.Truncated,
		"streamed": sent, "elapsedMs": time.Since(started).Milliseconds(),
	})
}

func (s *Server) kafkaProduce(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Conn    clients.KafkaConn     `json:"conn"`
		Topic   string                `json:"topic"`
		Key     string                `json:"key"`
		Value   string                `json:"value"`
		Headers []clients.KafkaHeader `json:"headers"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	if err := clients.KafkaProduce(req.Conn, req.Topic, req.Key, req.Value, req.Headers); err != nil {
		writeError(w, http.StatusBadGateway, err)
		return
	}
	writeJSON(w, map[string]any{"ok": true})
}

func (s *Server) dbQuery(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Type    string         `json:"type"`
		Conn    clients.DBConn `json:"conn"`
		Query   string         `json:"query"`
		MaxRows int            `json:"maxRows"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	var (
		res *clients.QueryResult
		err error
	)
	switch req.Type {
	case "cassandra":
		res, err = clients.CassandraQuery(req.Conn, req.Query, req.MaxRows)
	case "oracle", "mysql", "postgres", "postgresql":
		res, err = clients.RelationalQuery(req.Type, req.Conn, req.Query, req.MaxRows)
	default:
		writeError(w, http.StatusBadRequest, errString("unknown db type "+req.Type))
		return
	}
	if err != nil {
		writeError(w, http.StatusBadGateway, err)
		return
	}
	writeJSON(w, res)
}

// ptyUpgrader upgrades the interactive-terminal endpoint. The server binds
// to localhost only, so any local origin is acceptable.
var ptyUpgrader = websocket.Upgrader{
	ReadBufferSize:  4096,
	WriteBufferSize: 32 * 1024,
	CheckOrigin:     func(r *http.Request) bool { return true },
}

// sshPTY bridges a browser xterm.js terminal to a real interactive SSH shell.
// Protocol: the client sends JSON text frames — first {type:"start", host,
// port, username, password, cols, rows}, then {type:"input", data} and
// {type:"resize", cols, rows}. The server streams raw PTY output back as
// binary frames.
func (s *Server) sshPTY(w http.ResponseWriter, r *http.Request) {
	c, err := ptyUpgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer c.Close()

	var writeMu sync.Mutex
	send := func(b []byte) error {
		writeMu.Lock()
		defer writeMu.Unlock()
		return c.WriteMessage(websocket.BinaryMessage, b)
	}
	fail := func(msg string) { send([]byte("\r\n\x1b[31m" + msg + "\x1b[0m\r\n")) }

	_, msg, err := c.ReadMessage()
	if err != nil {
		return
	}
	var start struct {
		Host, Port, Username, Password string
		Cols, Rows                     int
	}
	if err := json.Unmarshal(msg, &start); err != nil {
		fail("bad start message")
		return
	}
	cols, rows := start.Cols, start.Rows
	if cols <= 0 {
		cols = 80
	}
	if rows <= 0 {
		rows = 24
	}

	client, err := sshx.Dial(sshx.Conn{Host: start.Host, Port: start.Port, Username: start.Username, Password: start.Password})
	if err != nil {
		fail(err.Error())
		return
	}
	defer client.Close()

	sess, err := client.NewSession()
	if err != nil {
		fail(err.Error())
		return
	}
	defer sess.Close()

	modes := ssh.TerminalModes{ssh.ECHO: 1, ssh.TTY_OP_ISPEED: 14400, ssh.TTY_OP_OSPEED: 14400}
	if err := sess.RequestPty("xterm-256color", rows, cols, modes); err != nil {
		fail("pty request failed: " + err.Error())
		return
	}
	stdin, err := sess.StdinPipe()
	if err != nil {
		fail(err.Error())
		return
	}
	stdout, err := sess.StdoutPipe()
	if err != nil {
		fail(err.Error())
		return
	}
	if err := sess.Shell(); err != nil {
		fail("shell failed: " + err.Error())
		return
	}
	logging.Logf("ssh: interactive pty opened to %s@%s (%dx%d)", start.Username, start.Host, cols, rows)

	// pump PTY output to the browser
	go func() {
		buf := make([]byte, 32*1024)
		for {
			n, err := stdout.Read(buf)
			if n > 0 {
				if send(buf[:n]) != nil {
					break
				}
			}
			if err != nil {
				break
			}
		}
		c.Close() // unblock the read loop below
	}()

	// browser input → PTY
	for {
		_, data, err := c.ReadMessage()
		if err != nil {
			break
		}
		var m struct {
			Type, Data string
			Cols, Rows int
		}
		if json.Unmarshal(data, &m) != nil {
			continue
		}
		switch m.Type {
		case "input":
			stdin.Write([]byte(m.Data))
		case "resize":
			if m.Cols > 0 && m.Rows > 0 {
				sess.WindowChange(m.Rows, m.Cols)
			}
		}
	}
	sess.Close()
	logging.Logf("ssh: interactive pty to %s@%s closed", start.Username, start.Host)
}

func (s *Server) sftpList(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Conn sshx.Conn `json:"conn"`
		Path string    `json:"path"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	entries, resolved, err := sshx.SFTPList(req.Conn, req.Path)
	if err != nil {
		writeError(w, http.StatusBadGateway, err)
		return
	}
	writeJSON(w, map[string]any{"entries": entries, "path": resolved})
}

func (s *Server) sftpDownload(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Conn sshx.Conn `json:"conn"`
		Path string    `json:"path"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	rc, name, size, err := sshx.SFTPOpen(req.Conn, req.Path)
	if err != nil {
		writeError(w, http.StatusBadGateway, err)
		return
	}
	defer rc.Close()

	// sanitize the filename for the Content-Disposition header
	safe := strings.NewReplacer("\"", "_", "\r", "", "\n", "", "\\", "_").Replace(name)
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Disposition", `attachment; filename="`+safe+`"`)
	if size > 0 {
		w.Header().Set("Content-Length", strconv.FormatInt(size, 10))
	}
	io.Copy(w, rc)
}

func (s *Server) sshExec(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Conn      sshx.Conn `json:"conn"`
		Command   string    `json:"command"`
		TimeoutMs int       `json:"timeoutMs"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	res, err := sshx.Exec(req.Conn, req.Command, req.TimeoutMs)
	if err != nil {
		writeError(w, http.StatusBadGateway, err)
		return
	}
	writeJSON(w, res)
}

func (s *Server) kubeExec(w http.ResponseWriter, r *http.Request) {
	var req kube.ExecRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	if !requireTools(w, req.Conn) {
		return
	}
	resp, err := kube.Exec(req)
	if err != nil {
		writeError(w, http.StatusBadGateway, err)
		return
	}
	writeJSON(w, resp)
}

// requireTools checks that the binary this connection depends on exists:
// the ssh client when kubectl runs on a remote host, local kubectl otherwise.
func requireTools(w http.ResponseWriter, conn kube.Conn) bool {
	if conn.SSH() {
		if conn.SSHPassword != "" {
			return true // password mode uses the built-in ssh client
		}
		if !kube.SSHAvailable() {
			writeError(w, http.StatusServiceUnavailable,
				errString("ssh not found on PATH — an ssh client is required to run kubectl on a remote host"))
			return false
		}
		return true
	}
	if !kube.Available() {
		writeError(w, http.StatusServiceUnavailable,
			errString("kubectl not found on PATH — install kubectl, or set an SSH host to run kubectl on a remote machine"))
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
