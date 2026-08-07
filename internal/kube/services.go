package kube

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/bhavesh78patil/devtil/internal/logging"
)

// People reason about a cluster in services — "why is checkout erroring?" —
// while kubectl logs works in pods. Listing services and resolving one to its
// pods closes that gap, so a question about a service can be answered without
// first knowing which pods happen to back it today.

type Service struct {
	Name      string            `json:"name"`
	Type      string            `json:"type"`
	ClusterIP string            `json:"clusterIP"`
	Ports     []string          `json:"ports"`
	Selector  map[string]string `json:"selector,omitempty"`
	// Selects is the selector rendered as a kubectl -l argument, or "" for a
	// service with no selector (an ExternalName, or one with manual endpoints).
	Selects string `json:"selects,omitempty"`
}

// Services lists the services in a namespace, optionally filtered by a
// case-insensitive substring of the name or of its selector.
func Services(conn Conn, namespace, query string) ([]Service, error) {
	if strings.TrimSpace(namespace) == "" {
		return nil, fmt.Errorf("namespace is required")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	out, err := run(ctx, conn, "get", "services", "-n", namespace, "-o", "json")
	if err != nil {
		return nil, err
	}
	if len(bytes.TrimSpace(out)) == 0 {
		return nil, fmt.Errorf("kubectl produced no output for 'get services -n %s' — open the App Logs tool to see the exact command and its stderr", namespace)
	}

	var list struct {
		Items []struct {
			Metadata struct {
				Name string `json:"name"`
			} `json:"metadata"`
			Spec struct {
				Type      string            `json:"type"`
				ClusterIP string            `json:"clusterIP"`
				Selector  map[string]string `json:"selector"`
				Ports     []struct {
					Name       string `json:"name"`
					Port       int    `json:"port"`
					Protocol   string `json:"protocol"`
					TargetPort any    `json:"targetPort"`
				} `json:"ports"`
			} `json:"spec"`
		} `json:"items"`
	}
	if err := json.Unmarshal(out, &list); err != nil {
		logging.Logf("kube: unparseable 'get services' output (%dB): %s", len(out), logging.Snippet(string(out), 600))
		return nil, fmt.Errorf("kubectl returned %d bytes that are not valid JSON (%v) — see the App Logs tool", len(out), err)
	}

	q := strings.ToLower(strings.TrimSpace(query))
	svcs := []Service{}
	for _, item := range list.Items {
		sel := selectorString(item.Spec.Selector)
		if q != "" &&
			!strings.Contains(strings.ToLower(item.Metadata.Name), q) &&
			!strings.Contains(strings.ToLower(sel), q) {
			continue
		}
		var ports []string
		for _, p := range item.Spec.Ports {
			label := fmt.Sprintf("%d", p.Port)
			if p.TargetPort != nil {
				if tp := fmt.Sprintf("%v", p.TargetPort); tp != "" && tp != "0" && tp != label {
					label += "→" + tp
				}
			}
			if p.Protocol != "" && p.Protocol != "TCP" {
				label += "/" + p.Protocol
			}
			if p.Name != "" {
				label = p.Name + ":" + label
			}
			ports = append(ports, label)
		}
		svcs = append(svcs, Service{
			Name:      item.Metadata.Name,
			Type:      item.Spec.Type,
			ClusterIP: item.Spec.ClusterIP,
			Ports:     ports,
			Selector:  item.Spec.Selector,
			Selects:   sel,
		})
	}
	sort.Slice(svcs, func(i, j int) bool { return svcs[i].Name < svcs[j].Name })
	return svcs, nil
}

// selectorString renders a label map as kubectl's -l argument, with keys
// sorted so the same selector always produces the same string.
func selectorString(sel map[string]string) string {
	if len(sel) == 0 {
		return ""
	}
	keys := make([]string, 0, len(sel))
	for k := range sel {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	parts := make([]string, 0, len(keys))
	for _, k := range keys {
		parts = append(parts, k+"="+sel[k])
	}
	return strings.Join(parts, ",")
}

// PodsForService resolves a service to the pods it currently selects, and
// returns the selector it used so a caller can report how it got there.
func PodsForService(conn Conn, namespace, service string) ([]Pod, string, error) {
	svcs, err := Services(conn, namespace, "")
	if err != nil {
		return nil, "", err
	}
	var match *Service
	for i := range svcs {
		if strings.EqualFold(svcs[i].Name, service) {
			match = &svcs[i]
			break
		}
	}
	if match == nil {
		// A near-miss is far more useful than "not found" on its own.
		var names []string
		for _, s := range svcs {
			if strings.Contains(strings.ToLower(s.Name), strings.ToLower(service)) {
				names = append(names, s.Name)
			}
		}
		if len(names) > 0 {
			return nil, "", fmt.Errorf("no service named %q in %s — did you mean %s?", service, namespace, strings.Join(names, ", "))
		}
		return nil, "", fmt.Errorf("no service named %q in namespace %s (%d service(s) there)", service, namespace, len(svcs))
	}
	if match.Selects == "" {
		return nil, "", fmt.Errorf("service %q has no pod selector (type %s), so it does not front any pods", service, match.Type)
	}
	pods, err := PodsBySelector(conn, namespace, match.Selects)
	return pods, match.Selects, err
}

// PodsBySelector lists the pods matching a label selector.
func PodsBySelector(conn Conn, namespace, selector string) ([]Pod, error) {
	if strings.TrimSpace(selector) == "" {
		return nil, fmt.Errorf("a label selector is required")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	out, err := run(ctx, conn, "get", "pods", "-n", namespace, "-l", selector, "-o", "json")
	if err != nil {
		return nil, err
	}
	return parsePods(out, "")
}
