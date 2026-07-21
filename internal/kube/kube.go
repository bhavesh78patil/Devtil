// Package kube wraps the kubectl CLI to discover pods and fetch/search
// container logs. It uses whatever kubeconfig and contexts the developer's
// machine already has — no credentials are stored by devtil.
package kube

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os/exec"
	"regexp"
	"sort"
	"strings"
	"time"

	"golang.org/x/crypto/ssh"

	"github.com/bhavesh78patil/devtil/internal/logging"
)

// Available reports whether kubectl is on PATH.
func Available() bool {
	_, err := exec.LookPath("kubectl")
	return err == nil
}

// SSHAvailable reports whether the ssh client is on PATH.
func SSHAvailable() bool {
	_, err := exec.LookPath("ssh")
	return err == nil
}

// Conn describes how to reach a cluster. Three ways, combinable:
//   - a kubeconfig context of the machine running kubectl
//   - a direct API server address (--server/--token)
//   - an SSH host (e.g. the kubemaster): kubectl is executed on that machine
//     over `ssh`, using the developer's own ssh config/keys/agent, for setups
//     where the cluster is only reachable from a jump/master host.
type Conn struct {
	Context  string `json:"context"`
	Server   string `json:"server"`
	Token    string `json:"token"`
	Insecure bool   `json:"insecure"`
	SSHHost     string `json:"sshHost"` // user@host — run kubectl here via ssh
	SSHPort     string `json:"sshPort"`
	SSHKey      string `json:"sshKey"`      // optional identity file path
	SSHPassword string `json:"sshPassword"` // password auth via built-in ssh client
}

// SSH reports whether kubectl should run on a remote host over ssh.
func (c Conn) SSH() bool { return strings.TrimSpace(c.SSHHost) != "" }

// sshOnly keeps just the transport part of the connection — used for
// commands like `kubectl config get-contexts` that must run on the right
// machine but shouldn't carry --context/--server flags.
func (c Conn) sshOnly() Conn {
	return Conn{SSHHost: c.SSHHost, SSHPort: c.SSHPort, SSHKey: c.SSHKey, SSHPassword: c.SSHPassword}
}

func (c Conn) flags() []string {
	var f []string
	if c.Context != "" {
		f = append(f, "--context", c.Context)
	}
	if s := strings.TrimSpace(c.Server); s != "" {
		if !strings.Contains(s, "://") {
			s = "https://" + s
		}
		f = append(f, "--server", s)
	}
	if c.Token != "" {
		f = append(f, "--token", c.Token)
	}
	if c.Insecure {
		f = append(f, "--insecure-skip-tls-verify=true")
	}
	return f
}

// redactArgs hides secret values (e.g. --token) in logged command lines.
func redactArgs(args []string) string {
	out := make([]string, len(args))
	for i, a := range args {
		out[i] = a
		if i > 0 && args[i-1] == "--token" {
			out[i] = "***"
		}
	}
	return strings.Join(out, " ")
}

// run executes kubectl and fails on any nonzero exit.
func run(ctx context.Context, conn Conn, args ...string) ([]byte, error) {
	return runOpt(ctx, conn, false, args...)
}

// runOpt executes kubectl over the configured transport. When tolerate is
// true a nonzero exit code is not treated as an error and the combined
// stdout+stderr is returned instead — for the interactive terminal, where
// commands like `grep` legitimately exit nonzero.
func runOpt(ctx context.Context, conn Conn, tolerate bool, args ...string) ([]byte, error) {
	args = append(conn.flags(), args...)

	// password auth can't be piped into the system ssh client from a
	// background process, so it uses the built-in Go SSH client instead
	if conn.SSH() && conn.SSHPassword != "" {
		return runSSHPassword(ctx, conn, tolerate, args)
	}

	var cmd *exec.Cmd
	if conn.SSH() {
		sshArgs := []string{"-o", "BatchMode=yes", "-o", "ConnectTimeout=10"}
		if p := strings.TrimSpace(conn.SSHPort); p != "" {
			sshArgs = append(sshArgs, "-p", p)
		}
		if k := strings.TrimSpace(conn.SSHKey); k != "" {
			sshArgs = append(sshArgs, "-i", k)
		}
		sshArgs = append(sshArgs, strings.TrimSpace(conn.SSHHost), "kubectl")
		// ssh joins the command words and hands them to the remote shell,
		// so every kubectl argument must be quoted for that shell
		for _, a := range args {
			sshArgs = append(sshArgs, shellQuote(a))
		}
		cmd = exec.CommandContext(ctx, "ssh", sshArgs...)
	} else {
		cmd = exec.CommandContext(ctx, "kubectl", args...)
	}

	tool := "kubectl"
	if conn.SSH() {
		tool = "ssh " + conn.SSHHost
	}
	logging.Logf("kube: run [%s] kubectl %s", tool, redactArgs(args))

	start := time.Now()
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	logging.Logf("kube: done in %dms, stdout=%dB, stderr=%q, err=%v",
		time.Since(start).Milliseconds(), stdout.Len(), logging.Snippet(stderr.String(), 400), err)
	if err != nil {
		var exitErr *exec.ExitError
		if tolerate && errors.As(err, &exitErr) {
			return append(stdout.Bytes(), stderr.Bytes()...), nil
		}
		msg := strings.TrimSpace(stderr.String())
		if msg == "" {
			msg = err.Error()
		}
		return nil, fmt.Errorf("%s: %s", tool, msg)
	}
	return stdout.Bytes(), nil
}

// Contexts returns kubeconfig context names plus the current one — from the
// SSH host's kubeconfig when an SSH connection is configured, otherwise from
// the local one.
func Contexts(conn Conn) (names []string, current string, err error) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	transport := conn.sshOnly()
	out, err := run(ctx, transport, "config", "get-contexts", "-o", "name")
	if err != nil {
		return nil, "", err
	}
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		if line = strings.TrimSpace(line); line != "" {
			names = append(names, line)
		}
	}
	if cur, err := run(ctx, transport, "config", "current-context"); err == nil {
		current = strings.TrimSpace(string(cur))
	}
	return names, current, nil
}

func Namespaces(conn Conn) ([]string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	out, err := run(ctx, conn, "get", "namespaces",
		"-o", "jsonpath={range .items[*]}{.metadata.name}{\"\\n\"}{end}")
	if err != nil {
		return nil, err
	}
	var names []string
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		if line = strings.TrimSpace(line); line != "" {
			names = append(names, line)
		}
	}
	sort.Strings(names)
	return names, nil
}

type Pod struct {
	Name       string   `json:"name"`
	Status     string   `json:"status"`
	Containers []string `json:"containers"`
	Labels     string   `json:"labels"`
	StartTime  string   `json:"startTime"`
}

// Pods lists pods in a namespace, optionally filtered by a case-insensitive
// substring match against the pod name or its labels — so searching for a
// service name like "checkout" finds its pods.
func Pods(conn Conn, namespace, query string) ([]Pod, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	out, err := run(ctx, conn, "get", "pods", "-n", namespace, "-o", "json")
	if err != nil {
		return nil, err
	}
	if len(bytes.TrimSpace(out)) == 0 {
		return nil, fmt.Errorf("kubectl produced no output for 'get pods -n %s' — open the App Logs tool to see the exact command and its stderr", namespace)
	}

	var list struct {
		Items []struct {
			Metadata struct {
				Name   string            `json:"name"`
				Labels map[string]string `json:"labels"`
			} `json:"metadata"`
			Spec struct {
				Containers []struct {
					Name string `json:"name"`
				} `json:"containers"`
			} `json:"spec"`
			Status struct {
				Phase     string `json:"phase"`
				StartTime string `json:"startTime"`
			} `json:"status"`
		} `json:"items"`
	}
	if err := json.Unmarshal(out, &list); err != nil {
		logging.Logf("kube: unparseable 'get pods' output (%dB): %s", len(out), logging.Snippet(string(out), 600))
		return nil, fmt.Errorf("kubectl returned %d bytes that are not valid JSON (%v) — the output starts with %q; see the App Logs tool for details", len(out), err, logging.Snippet(string(out), 80))
	}

	query = strings.ToLower(strings.TrimSpace(query))
	pods := []Pod{}
	for _, item := range list.Items {
		var labelPairs []string
		for k, v := range item.Metadata.Labels {
			labelPairs = append(labelPairs, k+"="+v)
		}
		sort.Strings(labelPairs)
		labels := strings.Join(labelPairs, ",")

		if query != "" &&
			!strings.Contains(strings.ToLower(item.Metadata.Name), query) &&
			!strings.Contains(strings.ToLower(labels), query) {
			continue
		}

		var containers []string
		for _, c := range item.Spec.Containers {
			containers = append(containers, c.Name)
		}
		pods = append(pods, Pod{
			Name:       item.Metadata.Name,
			Status:     item.Status.Phase,
			Containers: containers,
			Labels:     labels,
			StartTime:  item.Status.StartTime,
		})
	}
	return pods, nil
}

type LogsRequest struct {
	Conn
	Namespace    string   `json:"namespace"`
	Pods         []string `json:"pods"`
	Container    string   `json:"container"`
	Tail         int      `json:"tail"`
	SinceMinutes int      `json:"sinceMinutes"`
	SinceSeconds int      `json:"sinceSeconds"` // finer window, used by follow/tail polling
	Previous     bool     `json:"previous"`
	Grep         string   `json:"grep"`
	GrepRegex    bool     `json:"grepRegex"`
	// Source "stdout" (default) reads container logs via `kubectl logs`;
	// "file" execs into the pod and tails FilePath — for services that
	// write log files instead of logging to stdout.
	Source   string `json:"source"`
	FilePath string `json:"filePath"`
}

// ExecRequest runs an arbitrary command inside a container via
// `kubectl exec … -- sh -c '<command>'`.
type ExecRequest struct {
	Conn
	Namespace string `json:"namespace"`
	Pod       string `json:"pod"`
	Container string `json:"container"`
	Command   string `json:"command"`
	TimeoutMs int    `json:"timeoutMs"`
}

type ExecResponse struct {
	Output     string `json:"output"`
	DurationMs int64  `json:"durationMs"`
}

// Exec runs a command inside a pod's container and returns the combined
// stdout+stderr, tolerating nonzero exit codes (so a grep with no matches,
// or a program that writes to stderr, still shows its output).
func Exec(req ExecRequest) (*ExecResponse, error) {
	if req.Namespace == "" || req.Pod == "" || strings.TrimSpace(req.Command) == "" {
		return nil, fmt.Errorf("namespace, pod and a command are required")
	}
	timeout := 60 * time.Second
	if req.TimeoutMs > 0 {
		timeout = time.Duration(req.TimeoutMs) * time.Millisecond
		if timeout > 10*time.Minute {
			timeout = 10 * time.Minute
		}
	}
	args := []string{"exec", req.Pod, "-n", req.Namespace}
	if req.Container != "" {
		args = append(args, "-c", req.Container)
	}
	args = append(args, "--", "sh", "-c", req.Command)

	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	start := time.Now()
	out, err := runOpt(ctx, req.Conn, true, args...)
	if err != nil {
		return nil, err
	}
	return &ExecResponse{Output: string(out), DurationMs: time.Since(start).Milliseconds()}, nil
}

// shellQuote makes s safe to embed in the `sh -c` command run inside the pod.
func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

// runSSHPassword runs kubectl on the remote host over the built-in SSH
// client using username/password auth (user taken from the user@host form).
func runSSHPassword(ctx context.Context, conn Conn, tolerate bool, args []string) ([]byte, error) {
	host := strings.TrimSpace(conn.SSHHost)
	user := ""
	if i := strings.Index(host, "@"); i >= 0 {
		user, host = host[:i], host[i+1:]
	}
	if user == "" || host == "" {
		return nil, fmt.Errorf("ssh host must be user@host when using password auth")
	}
	port := strings.TrimSpace(conn.SSHPort)
	if port == "" {
		port = "22"
	}
	addr := net.JoinHostPort(host, port)

	answerPassword := func(_, _ string, questions []string, _ []bool) ([]string, error) {
		answers := make([]string, len(questions))
		for i := range answers {
			answers[i] = conn.SSHPassword
		}
		return answers, nil
	}
	cfg := &ssh.ClientConfig{
		User:            user,
		Auth:            []ssh.AuthMethod{ssh.Password(conn.SSHPassword), ssh.KeyboardInteractive(answerPassword)},
		HostKeyCallback: ssh.InsecureIgnoreHostKey(), // dev tool: no known_hosts management
		Timeout:         10 * time.Second,
	}

	tcp, err := net.DialTimeout("tcp", addr, 10*time.Second)
	if err != nil {
		return nil, fmt.Errorf("ssh %s: %v", addr, err)
	}
	if dl, ok := ctx.Deadline(); ok {
		tcp.SetDeadline(dl)
	}
	cc, chans, reqs, err := ssh.NewClientConn(tcp, addr, cfg)
	if err != nil {
		tcp.Close()
		return nil, fmt.Errorf("ssh %s: %v", addr, err)
	}
	client := ssh.NewClient(cc, chans, reqs)
	defer client.Close()

	sess, err := client.NewSession()
	if err != nil {
		return nil, fmt.Errorf("ssh %s: %v", addr, err)
	}
	defer sess.Close()

	cmd := "kubectl"
	for _, a := range args {
		cmd += " " + shellQuote(a)
	}
	logging.Logf("kube: run [ssh-password %s@%s] kubectl %s", user, addr, redactArgs(args))

	start := time.Now()
	var stdout, stderr bytes.Buffer
	sess.Stdout, sess.Stderr = &stdout, &stderr
	err = sess.Run(cmd)
	logging.Logf("kube: done in %dms, stdout=%dB, stderr=%q, err=%v",
		time.Since(start).Milliseconds(), stdout.Len(), logging.Snippet(stderr.String(), 400), err)
	if err != nil {
		var exitErr *ssh.ExitError
		if tolerate && errors.As(err, &exitErr) {
			return append(stdout.Bytes(), stderr.Bytes()...), nil
		}
		msg := strings.TrimSpace(stderr.String())
		if msg == "" {
			msg = err.Error()
		}
		return nil, fmt.Errorf("ssh %s: %s", conn.SSHHost, msg)
	}
	return stdout.Bytes(), nil
}

type LogsResponse struct {
	Lines     []string `json:"lines"`
	Matched   int      `json:"matched"`
	Total     int      `json:"total"`
	Truncated bool     `json:"truncated"`
	Errors    []string `json:"errors,omitempty"`
}

const maxLogLines = 20000

// Logs fetches logs for one or more pods and applies an optional grep filter.
// When multiple pods are selected each line is prefixed with its pod name so
// interleaved service logs stay attributable.
func Logs(req LogsRequest) (*LogsResponse, error) {
	if req.Namespace == "" || len(req.Pods) == 0 {
		return nil, fmt.Errorf("namespace and at least one pod are required")
	}
	if req.Source == "file" && strings.TrimSpace(req.FilePath) == "" {
		return nil, fmt.Errorf("a file path is required when reading a log file inside the pod")
	}

	var matcher func(string) bool
	if q := strings.TrimSpace(req.Grep); q != "" {
		if req.GrepRegex {
			re, err := regexp.Compile("(?i)" + q)
			if err != nil {
				return nil, fmt.Errorf("invalid grep regex: %w", err)
			}
			matcher = re.MatchString
		} else {
			lower := strings.ToLower(q)
			matcher = func(line string) bool {
				return strings.Contains(strings.ToLower(line), lower)
			}
		}
	}

	resp := &LogsResponse{Lines: []string{}}
	multi := len(req.Pods) > 1

	tail := req.Tail
	if tail <= 0 || tail > maxLogLines {
		tail = 2000
	}

	for _, pod := range req.Pods {
		var args []string
		if req.Source == "file" {
			args = []string{"exec", pod, "-n", req.Namespace}
			if req.Container != "" {
				args = append(args, "-c", req.Container)
			}
			args = append(args, "--", "sh", "-c",
				fmt.Sprintf("tail -n %d -- %s", tail, shellQuote(strings.TrimSpace(req.FilePath))))
		} else {
			args = []string{"logs", pod, "-n", req.Namespace, "--timestamps"}
			if req.Container != "" {
				args = append(args, "-c", req.Container)
			}
			args = append(args, fmt.Sprintf("--tail=%d", tail))
			if req.SinceSeconds > 0 {
				args = append(args, fmt.Sprintf("--since=%ds", req.SinceSeconds))
			} else if req.SinceMinutes > 0 {
				args = append(args, fmt.Sprintf("--since=%dm", req.SinceMinutes))
			}
			if req.Previous {
				args = append(args, "--previous")
			}
		}

		ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
		out, err := run(ctx, req.Conn, args...)
		cancel()
		if err != nil {
			resp.Errors = append(resp.Errors, fmt.Sprintf("%s: %v", pod, err))
			continue
		}

		for _, line := range strings.Split(string(out), "\n") {
			if line == "" {
				continue
			}
			resp.Total++
			if matcher != nil && !matcher(line) {
				continue
			}
			resp.Matched++
			if len(resp.Lines) >= maxLogLines {
				resp.Truncated = true
				continue
			}
			if multi {
				line = "[" + pod + "] " + line
			}
			resp.Lines = append(resp.Lines, line)
		}
	}
	return resp, nil
}
