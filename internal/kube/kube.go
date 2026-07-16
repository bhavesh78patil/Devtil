// Package kube wraps the kubectl CLI to discover pods and fetch/search
// container logs. It uses whatever kubeconfig and contexts the developer's
// machine already has — no credentials are stored by devtil.
package kube

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"regexp"
	"sort"
	"strings"
	"time"
)

// Available reports whether kubectl is on PATH.
func Available() bool {
	_, err := exec.LookPath("kubectl")
	return err == nil
}

func run(ctx context.Context, kubeContext string, args ...string) ([]byte, error) {
	if kubeContext != "" {
		args = append([]string{"--context", kubeContext}, args...)
	}
	cmd := exec.CommandContext(ctx, "kubectl", args...)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		msg := strings.TrimSpace(stderr.String())
		if msg == "" {
			msg = err.Error()
		}
		return nil, fmt.Errorf("kubectl: %s", msg)
	}
	return stdout.Bytes(), nil
}

// Contexts returns all kubeconfig context names plus the current one.
func Contexts() (names []string, current string, err error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	out, err := run(ctx, "", "config", "get-contexts", "-o", "name")
	if err != nil {
		return nil, "", err
	}
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		if line = strings.TrimSpace(line); line != "" {
			names = append(names, line)
		}
	}
	if cur, err := run(ctx, "", "config", "current-context"); err == nil {
		current = strings.TrimSpace(string(cur))
	}
	return names, current, nil
}

func Namespaces(kubeContext string) ([]string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	out, err := run(ctx, kubeContext, "get", "namespaces",
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
func Pods(kubeContext, namespace, query string) ([]Pod, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	out, err := run(ctx, kubeContext, "get", "pods", "-n", namespace, "-o", "json")
	if err != nil {
		return nil, err
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
		return nil, fmt.Errorf("parse kubectl output: %w", err)
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
	Context      string   `json:"context"`
	Namespace    string   `json:"namespace"`
	Pods         []string `json:"pods"`
	Container    string   `json:"container"`
	Tail         int      `json:"tail"`
	SinceMinutes int      `json:"sinceMinutes"`
	Previous     bool     `json:"previous"`
	Grep         string   `json:"grep"`
	GrepRegex    bool     `json:"grepRegex"`
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

	for _, pod := range req.Pods {
		args := []string{"logs", pod, "-n", req.Namespace, "--timestamps"}
		if req.Container != "" {
			args = append(args, "-c", req.Container)
		}
		tail := req.Tail
		if tail <= 0 || tail > maxLogLines {
			tail = 2000
		}
		args = append(args, fmt.Sprintf("--tail=%d", tail))
		if req.SinceMinutes > 0 {
			args = append(args, fmt.Sprintf("--since=%dm", req.SinceMinutes))
		}
		if req.Previous {
			args = append(args, "--previous")
		}

		ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
		out, err := run(ctx, req.Context, args...)
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
