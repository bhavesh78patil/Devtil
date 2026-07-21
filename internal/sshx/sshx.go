// Package sshx runs commands on remote hosts over SSH using password
// authentication — the engine behind the PuTTY/SSH tool. It uses the
// built-in Go SSH client (no ssh binary needed) and, like the Kube console,
// runs each command as an independent session (no persistent shell state).
package sshx

import (
	"bytes"
	"context"
	"fmt"
	"net"
	"strings"
	"time"

	"golang.org/x/crypto/ssh"

	"github.com/bhavesh78patil/devtil/internal/logging"
)

type Conn struct {
	Host     string `json:"host"` // host or user@host
	Port     string `json:"port"`
	Username string `json:"username"`
	Password string `json:"password"`
}

type ExecResult struct {
	Output     string `json:"output"`
	DurationMs int64  `json:"durationMs"`
}

// Exec runs command on the remote host and returns its combined
// stdout+stderr, tolerating nonzero exit codes so a command that fails or
// writes to stderr still shows its output in the terminal.
func Exec(conn Conn, command string, timeoutMs int) (*ExecResult, error) {
	host := strings.TrimSpace(conn.Host)
	user := strings.TrimSpace(conn.Username)
	if i := strings.Index(host, "@"); i >= 0 { // allow user@host in the host field
		if user == "" {
			user = host[:i]
		}
		host = host[i+1:]
	}
	if user == "" || host == "" {
		return nil, fmt.Errorf("host and username are required")
	}
	if strings.TrimSpace(command) == "" {
		return nil, fmt.Errorf("command is empty")
	}
	port := strings.TrimSpace(conn.Port)
	if port == "" {
		port = "22"
	}

	timeout := 30 * time.Second
	if timeoutMs > 0 {
		timeout = time.Duration(timeoutMs) * time.Millisecond
		if timeout > 10*time.Minute {
			timeout = 10 * time.Minute
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	addr := net.JoinHostPort(host, port)
	answer := func(_, _ string, questions []string, _ []bool) ([]string, error) {
		a := make([]string, len(questions))
		for i := range a {
			a[i] = conn.Password
		}
		return a, nil
	}
	cfg := &ssh.ClientConfig{
		User:            user,
		Auth:            []ssh.AuthMethod{ssh.Password(conn.Password), ssh.KeyboardInteractive(answer)},
		HostKeyCallback: ssh.InsecureIgnoreHostKey(), // dev tool: no known_hosts management
		Timeout:         10 * time.Second,
	}

	logging.Logf("ssh: exec on %s@%s: %s", user, addr, logging.Snippet(command, 200))
	start := time.Now()

	dialer := net.Dialer{Timeout: 10 * time.Second}
	tcp, err := dialer.DialContext(ctx, "tcp", addr)
	if err != nil {
		logging.Logf("ssh: dial %s failed: %v", addr, err)
		return nil, fmt.Errorf("ssh %s: %v", addr, err)
	}
	if dl, ok := ctx.Deadline(); ok {
		tcp.SetDeadline(dl)
	}
	cc, chans, reqs, err := ssh.NewClientConn(tcp, addr, cfg)
	if err != nil {
		tcp.Close()
		logging.Logf("ssh: handshake %s failed: %v", addr, err)
		return nil, fmt.Errorf("ssh %s: %v", addr, err)
	}
	client := ssh.NewClient(cc, chans, reqs)
	defer client.Close()

	sess, err := client.NewSession()
	if err != nil {
		return nil, fmt.Errorf("ssh %s: %v", addr, err)
	}
	defer sess.Close()

	var stdout, stderr bytes.Buffer
	sess.Stdout, sess.Stderr = &stdout, &stderr
	runErr := sess.Run(command)

	combined := stdout.String()
	if stderr.Len() > 0 {
		if combined != "" && !strings.HasSuffix(combined, "\n") {
			combined += "\n"
		}
		combined += stderr.String()
	}
	// a nonzero exit is normal for a terminal; only surface real failures
	if runErr != nil {
		if _, ok := runErr.(*ssh.ExitError); !ok {
			return nil, fmt.Errorf("ssh %s: %v", addr, runErr)
		}
	}
	logging.Logf("ssh: exec done in %dms, %dB out", time.Since(start).Milliseconds(), len(combined))
	return &ExecResult{Output: combined, DurationMs: time.Since(start).Milliseconds()}, nil
}
