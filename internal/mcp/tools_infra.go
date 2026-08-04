package mcp

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/bhavesh78patil/devtil/internal/clients"
	"github.com/bhavesh78patil/devtil/internal/kube"
	"github.com/bhavesh78patil/devtil/internal/proxy"
	"github.com/bhavesh78patil/devtil/internal/sshx"
)

// Infrastructure tools reach real systems, so none of them are marked
// read-only except the ones that only observe. Credentials come either from
// the connection the user saved in the UI (resolved by name, never returned
// to the caller) or from inline arguments.

// connectionArg is offered by every tool that talks to saved infrastructure.
func connectionArg(what string) map[string]any {
	return map[string]any{
		"connection": str("Name of a saved " + what + " connection (call devtil_connections to list them). " +
			"Omit it only when you are certain which system is meant: devtil will use the developer's default, " +
			"or the single connection if there is only one, and will otherwise refuse and ask you to pick. " +
			"Inline fields below override individual values."),
	}
}

func (s *Server) registerInfra() {
	s.register(&Tool{
		Name:  "devtil_connections",
		Title: "List saved connections",
		Description: "List the systems the developer has configured — Kafka clusters, databases, Elasticsearch clusters, Kube and SSH hosts — " +
			"with each one's environment (production / staging / development) and which is the default. " +
			"Call this before any infrastructure work so you target the right system, and when several could match, " +
			"ask the developer which one they mean instead of guessing. Credentials are never returned.",
		ReadOnly: true,
		Schema: obj(map[string]any{
			"tool": enum("Filter to one tool: kafka, elastic, cassandra, oracle (relational databases), kube or putty (SSH).",
				"kafka", "elastic", "cassandra", "oracle", "kube", "putty"),
		}),
		Run: func(a Args) (any, error) {
			idx := loadConnections(s.store).filter(a.policy)
			filter := strings.TrimSpace(a.Str("tool"))
			out := map[string]any{}
			total, ambiguous := 0, false
			for toolType, list := range idx.byTool {
				if filter != "" && toolType != filter {
					continue
				}
				def := a.policy.DefaultConnection(toolType)
				entries := make([]any, 0, len(list))
				for _, c := range list {
					entry := map[string]any{
						"name":      c.Name,
						"workspace": c.Workspace,
						"summary":   summarizeConn(toolType, c.Fields),
					}
					if env := a.policy.EnvOf(toolType, c.Name); env != "" {
						entry["environment"] = env
					}
					if strings.EqualFold(c.Name, def) {
						entry["default"] = true
					}
					entries = append(entries, entry)
				}
				out[toolType] = entries
				total += len(entries)
				if len(entries) > 1 && def == "" {
					ambiguous = true
				}
			}
			if total == 0 {
				return map[string]any{
					"connections": out,
					"note":        "No saved connections found. Ask the developer to add one in the Devtil UI, or pass connection fields inline to each tool.",
				}, nil
			}
			res := map[string]any{"connections": out, "count": total}
			// Spell out the rule rather than relying on the model to infer
			// it: picking the wrong cluster is the costly mistake here.
			guidance := `Pass the chosen name as "connection" on each tool call. ` +
				`A connection marked "production" is never selected for you — name it explicitly, and only after the developer has confirmed they mean production.`
			if ambiguous {
				guidance += " Several connections exist for at least one tool with no default set: ask the developer which one they want before running anything."
			}
			res["guidance"] = guidance
			return res, nil
		},
	})

	s.register(&Tool{
		Name:  "http_request",
		Title: "Send an HTTP request",
		Description: "Send an HTTP request from the developer's machine and return the status, headers and body. " +
			"Runs server-side, so it reaches internal hosts and is not subject to browser CORS.",
		Schema: obj(map[string]any{
			"url":       str("Absolute URL, http:// or https://."),
			"method":    enum("HTTP method (default GET).", "GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"),
			"headers":   objArg("Request headers as a name/value object."),
			"body":      str("Request body (ignored for GET and HEAD)."),
			"timeoutMs": num("Timeout in milliseconds (default 30000, max 300000)."),
			"insecure":  boolean("Skip TLS certificate verification — for dev servers with self-signed certs."),
			"basicAuth": objArg(`Basic auth as {"username": "...", "password": "..."} — encoded into the Authorization header.`),
			"bearer":    str("Bearer token, sent as Authorization: Bearer <token>."),
		}, "url"),
		Run: func(a Args) (any, error) {
			target, err := a.Require("url")
			if err != nil {
				return nil, err
			}
			headers := a.StrMap("headers")
			if headers == nil {
				headers = map[string]string{}
			}
			if ba := a.Map("basicAuth"); ba != nil {
				u, _ := ba["username"].(string)
				p, _ := ba["password"].(string)
				headers["Authorization"] = "Basic " + base64.StdEncoding.EncodeToString([]byte(u+":"+p))
			}
			if tok := strings.TrimSpace(a.Str("bearer")); tok != "" {
				headers["Authorization"] = "Bearer " + tok
			}
			resp, err := proxy.Do(proxy.Request{
				Method:    a.Str("method"),
				URL:       target,
				Headers:   headers,
				Body:      a.Str("body"),
				TimeoutMs: a.Int("timeoutMs", 0),
				Insecure:  a.Bool("insecure", false),
			})
			if err != nil {
				return nil, err
			}
			return resp, nil
		},
	})

	s.registerKafka()
	s.registerDB()
	s.registerElastic()
	s.registerKube()
	s.registerSSH()
}

func summarizeConn(toolType string, f map[string]any) string {
	get := func(k string) string {
		s, _ := f[k].(string)
		return s
	}
	switch toolType {
	case "kafka":
		return get("brokers")
	case "elastic":
		return get("baseUrl")
	case "cassandra":
		loc := get("hosts")
		if ks := get("keyspace"); ks != "" {
			loc += " · keyspace " + ks
		}
		return loc
	case "oracle":
		eng := get("engine")
		if eng == "" {
			eng = "oracle"
		}
		loc := get("url")
		if loc == "" {
			loc = get("hosts")
			if db := get("database"); db != "" {
				loc += "/" + db
			} else if sv := get("service"); sv != "" {
				loc += "/" + sv
			}
		}
		if sc := get("schema"); sc != "" {
			loc += " · schema " + sc
		}
		return eng + " · " + loc
	case "kube":
		return get("sshHost")
	default:
		h := get("host")
		if p := get("port"); p != "" && p != "22" {
			h += ":" + p
		}
		return h
	}
}

// ------------------------------------------------------------------ Kafka

var kafkaConnKeys = []string{"brokers", "tls", "insecure", "username", "password", "timeoutMs"}

var kafkaConnProps = map[string]any{
	"brokers":   str("Comma-separated broker list, e.g. broker1:9092,broker2:9092."),
	"tls":       boolean("Connect over TLS."),
	"insecure":  boolean("Skip TLS certificate verification."),
	"username":  str("SASL/PLAIN username."),
	"password":  str("SASL/PLAIN password."),
	"timeoutMs": num("Dial/read timeout in milliseconds (default 1000)."),
}

func (s *Server) kafkaConn(a Args) (clients.KafkaConn, resolved, error) {
	r, err := s.resolve("kafka", a, kafkaConnKeys)
	if err != nil {
		return clients.KafkaConn{}, r, err
	}
	var c clients.KafkaConn
	if err := decodeInto(r.Fields, &c); err != nil {
		return clients.KafkaConn{}, r, err
	}
	if strings.TrimSpace(c.Brokers) == "" {
		return clients.KafkaConn{}, r, fmt.Errorf("no brokers: set \"brokers\" or name a saved Kafka connection")
	}
	return c, r, nil
}

func (s *Server) registerKafka() {
	s.register(&Tool{
		Name:        "kafka_topics",
		Title:       "List Kafka topics",
		Description: "List the topics on a Kafka cluster with their partition counts.",
		ReadOnly:    true,
		Schema:      obj(merge(connectionArg("Kafka"), kafkaConnProps)),
		Run: func(a Args) (any, error) {
			conn, chosen, err := s.kafkaConn(a)
			if err != nil {
				return nil, err
			}
			topics, err := clients.KafkaTopics(conn)
			if err != nil {
				return nil, err
			}
			return withConnection(map[string]any{"topics": topics, "count": len(topics)}, chosen), nil
		},
	})

	s.register(&Tool{
		Name:  "kafka_consume",
		Title: "Read Kafka messages",
		Description: "Read messages from a Kafka topic — the latest N, from the beginning, or within a time window — " +
			"with optional case-insensitive key and value filters. Reads history only; it never waits for new messages.",
		ReadOnly: true,
		Schema: obj(merge(connectionArg("Kafka"), kafkaConnProps, map[string]any{
			"topic":      str("Topic to read."),
			"max":        num("Maximum messages to return (default 50, capped at 500)."),
			"from":       enum("latest (default), beginning, or time (use startMs/endMs).", "latest", "beginning", "time"),
			"startMs":    num("Window start as epoch milliseconds, when from=time."),
			"endMs":      num("Window end as epoch milliseconds, when from=time."),
			"keyQuery":   str("Only return messages whose key contains this (case-insensitive)."),
			"valueQuery": str("Only return messages whose value contains this (case-insensitive)."),
		}), "topic"),
		Run: func(a Args) (any, error) {
			conn, chosen, err := s.kafkaConn(a)
			if err != nil {
				return nil, err
			}
			topic, err := a.Require("topic")
			if err != nil {
				return nil, err
			}
			resp, err := clients.KafkaConsume(clients.KafkaConsumeRequest{
				Conn:       conn,
				Topic:      topic,
				Max:        a.Int("max", 50),
				From:       a.Str("from"),
				StartMs:    a.Int64("startMs", 0),
				EndMs:      a.Int64("endMs", 0),
				KeyQuery:   a.Str("keyQuery"),
				ValueQuery: a.Str("valueQuery"),
			})
			if err != nil {
				return nil, err
			}
			return withConnection(resp, chosen), nil
		},
	})

	s.register(&Tool{
		Name:        "kafka_produce",
		Title:       "Produce a Kafka message",
		Description: "Publish a message to a Kafka topic. This writes to a real topic — confirm the target with the developer before producing to anything shared.",
		Schema: obj(merge(connectionArg("Kafka"), kafkaConnProps, map[string]any{
			"topic":   str("Topic to publish to."),
			"key":     str("Message key (optional)."),
			"value":   str("Message value."),
			"headers": objArg("Message headers as a name/value object."),
		}), "topic", "value"),
		Run: func(a Args) (any, error) {
			conn, chosen, err := s.kafkaConn(a)
			if err != nil {
				return nil, err
			}
			topic, err := a.Require("topic")
			if err != nil {
				return nil, err
			}
			var headers []clients.KafkaHeader
			for k, v := range a.StrMap("headers") {
				headers = append(headers, clients.KafkaHeader{Key: k, Value: v})
			}
			if err := clients.KafkaProduce(conn, topic, a.Str("key"), a.Str("value"), headers); err != nil {
				return nil, err
			}
			return withConnection(map[string]any{"ok": true, "topic": topic}, chosen), nil
		},
	})
}

// -------------------------------------------------------------- databases

var dbConnKeys = []string{"engine", "hosts", "port", "keyspace", "service", "database", "schema", "url", "username", "password", "insecure"}

var dbConnProps = map[string]any{
	"engine":   enum("Relational engine: oracle, mysql or postgres.", "oracle", "mysql", "postgres"),
	"url":      str("Connect URL, which fills in host/port/database: jdbc:oracle:thin:@host:1521/svc, mysql://user:pass@host:3306/db, postgres://user:pass@host:5432/db."),
	"hosts":    str("Host (relational) or comma-separated contact points (Cassandra)."),
	"port":     num("Port. Defaults per engine: 1521 Oracle, 3306 MySQL, 5432 PostgreSQL, 9042 Cassandra."),
	"database": str("Database name (MySQL / PostgreSQL)."),
	"service":  str("Service name (Oracle)."),
	"schema":   str("Schema to query in — Oracle owner or PostgreSQL search_path."),
	"keyspace": str("Keyspace (Cassandra)."),
	"username": str("Username."),
	"password": str("Password."),
	"insecure": boolean("Skip TLS (sslmode=disable / tls=false)."),
}

func (s *Server) dbConn(toolType string, a Args) (clients.DBConn, resolved, error) {
	r, err := s.resolve(toolType, a, dbConnKeys)
	if err != nil {
		return clients.DBConn{}, r, err
	}
	var c clients.DBConn
	if err := decodeInto(r.Fields, &c); err != nil {
		return clients.DBConn{}, r, err
	}
	return c, r, nil
}

func (s *Server) registerDB() {
	s.register(&Tool{
		Name:  "db_query",
		Title: "Run SQL",
		Description: "Run SQL against Oracle, MySQL or PostgreSQL and return the result grid. " +
			"Reads are safe to run freely; statements that modify data execute for real, so check with the developer first.",
		Schema: obj(merge(connectionArg("relational database"), dbConnProps, map[string]any{
			"query":   str("The SQL statement to run. One statement per call."),
			"maxRows": num("Maximum rows to return (default 200, max 10000)."),
		}), "query"),
		Run: func(a Args) (any, error) {
			conn, chosen, err := s.dbConn("oracle", a)
			if err != nil {
				return nil, err
			}
			query, err := a.Require("query")
			if err != nil {
				return nil, err
			}
			engine := strings.TrimSpace(a.Str("engine"))
			if engine == "" {
				engine = conn.Engine
			}
			res, err := clients.RelationalQuery(engine, conn, query, a.Int("maxRows", 200))
			if err != nil {
				return nil, err
			}
			return withConnection(res, chosen), nil
		},
	})

	s.register(&Tool{
		Name:        "cassandra_query",
		Title:       "Run CQL",
		Description: "Run a CQL statement against a Cassandra cluster and return the result grid.",
		Schema: obj(merge(connectionArg("Cassandra"), dbConnProps, map[string]any{
			"query":   str("The CQL statement to run."),
			"maxRows": num("Maximum rows to return (default 200, max 10000)."),
		}), "query"),
		Run: func(a Args) (any, error) {
			conn, chosen, err := s.dbConn("cassandra", a)
			if err != nil {
				return nil, err
			}
			query, err := a.Require("query")
			if err != nil {
				return nil, err
			}
			res, err := clients.CassandraQuery(conn, query, a.Int("maxRows", 200))
			if err != nil {
				return nil, err
			}
			return withConnection(res, chosen), nil
		},
	})
}

// ---------------------------------------------------------- Elasticsearch

func (s *Server) registerElastic() {
	s.register(&Tool{
		Name:  "elastic_request",
		Title: "Query Elasticsearch / OpenSearch",
		Description: "Send a request to an Elasticsearch or OpenSearch cluster — cluster health, index listings, searches. " +
			"Give the path relative to the cluster's base URL, e.g. _cluster/health or my-index/_search.",
		Schema: obj(merge(connectionArg("Elastic / OpenSearch"), map[string]any{
			"baseUrl":  str("Cluster base URL, e.g. http://es-host:9200."),
			"username": str("Basic auth username."),
			"password": str("Basic auth password."),
			"insecure": boolean("Skip TLS certificate verification."),
			"path":     str("Path relative to the base URL, e.g. _cluster/health or my-index/_search."),
			"method":   enum("HTTP method (default GET).", "GET", "POST", "PUT", "DELETE", "HEAD"),
			"body":     str("JSON request body, e.g. a query DSL document."),
		}), "path"),
		Run: func(a Args) (any, error) {
			chosen, err := s.resolve("elastic", a, []string{"baseUrl", "username", "password", "insecure"})
			if err != nil {
				return nil, err
			}
			var conn struct {
				BaseURL  string `json:"baseUrl"`
				Username string `json:"username"`
				Password string `json:"password"`
				Insecure bool   `json:"insecure"`
			}
			if err := decodeInto(chosen.Fields, &conn); err != nil {
				return nil, err
			}
			base := strings.TrimRight(strings.TrimSpace(conn.BaseURL), "/")
			if base == "" {
				return nil, fmt.Errorf(`no cluster: set "baseUrl" or name a saved Elastic connection`)
			}
			path, err := a.Require("path")
			if err != nil {
				return nil, err
			}
			headers := map[string]string{"Content-Type": "application/json"}
			if conn.Username != "" {
				headers["Authorization"] = "Basic " + base64.StdEncoding.EncodeToString([]byte(conn.Username+":"+conn.Password))
			}
			resp, err := proxy.Do(proxy.Request{
				Method:   a.Str("method"),
				URL:      base + "/" + strings.TrimLeft(path, "/"),
				Headers:  headers,
				Body:     a.Str("body"),
				Insecure: conn.Insecure,
			})
			if err != nil {
				return nil, err
			}
			out := map[string]any{"status": resp.Status, "durationMs": resp.DurationMs}
			// Hand back parsed JSON when the cluster returned JSON, so the
			// model can read fields instead of a quoted blob.
			var parsed any
			if json.Unmarshal([]byte(resp.Body), &parsed) == nil {
				out["body"] = parsed
			} else {
				out["body"] = resp.Body
			}
			return withConnection(out, chosen), nil
		},
	})
}

// ------------------------------------------------------------- Kubernetes

var kubeConnKeys = []string{"context", "server", "token", "insecure", "sshHost", "sshPort", "sshKey", "sshPassword"}

var kubeConnProps = map[string]any{
	"context":     str("kubectl context name."),
	"server":      str("API server URL, when not using a kubeconfig context."),
	"token":       str("Bearer token for the API server."),
	"insecure":    boolean("Skip TLS certificate verification."),
	"sshHost":     str("Run kubectl on this host over SSH, as user@host."),
	"sshPort":     str("SSH port (default 22)."),
	"sshPassword": str("SSH password."),
	"sshKey":      str("Path to an SSH identity file."),
}

func (s *Server) kubeConn(a Args) (kube.Conn, resolved, error) {
	r, err := s.resolve("kube", a, kubeConnKeys)
	if err != nil {
		// A local kubeconfig is a perfectly normal setup, so an absent saved
		// connection is not fatal here — fall through to plain kubectl, which
		// uses the current context.
		if !a.Has("connection") {
			return kube.Conn{}, resolved{SelectedBy: "the machine's current kubeconfig context"}, nil
		}
		return kube.Conn{}, r, err
	}
	var c kube.Conn
	if err := decodeInto(r.Fields, &c); err != nil {
		return kube.Conn{}, r, err
	}
	return c, r, nil
}

func (s *Server) registerKube() {
	s.register(&Tool{
		Name:        "kube_contexts",
		Title:       "List Kubernetes contexts",
		Description: "List the kubectl contexts available, and which one is current.",
		ReadOnly:    true,
		Schema:      obj(merge(connectionArg("Kube Console"), kubeConnProps)),
		Run: func(a Args) (any, error) {
			conn, chosen, err := s.kubeConn(a)
			if err != nil {
				return nil, err
			}
			names, current, err := kube.Contexts(conn)
			if err != nil {
				return nil, err
			}
			return withConnection(map[string]any{"contexts": names, "current": current}, chosen), nil
		},
	})

	s.register(&Tool{
		Name:        "kube_namespaces",
		Title:       "List Kubernetes namespaces",
		Description: "List the namespaces in the selected cluster.",
		ReadOnly:    true,
		Schema:      obj(merge(connectionArg("Kube Console"), kubeConnProps)),
		Run: func(a Args) (any, error) {
			conn, chosen, err := s.kubeConn(a)
			if err != nil {
				return nil, err
			}
			names, err := kube.Namespaces(conn)
			if err != nil {
				return nil, err
			}
			return withConnection(map[string]any{"namespaces": names}, chosen), nil
		},
	})

	s.register(&Tool{
		Name:        "kube_pods",
		Title:       "Find pods",
		Description: "List pods in a namespace with their status and containers, optionally filtered by a substring matched against the pod name or its labels — so a service name finds its pods.",
		ReadOnly:    true,
		Schema: obj(merge(connectionArg("Kube Console"), kubeConnProps, map[string]any{
			"namespace": str("Namespace to list."),
			"query":     str("Case-insensitive substring to match against pod names and labels."),
		}), "namespace"),
		Run: func(a Args) (any, error) {
			conn, chosen, err := s.kubeConn(a)
			if err != nil {
				return nil, err
			}
			ns, err := a.Require("namespace")
			if err != nil {
				return nil, err
			}
			pods, err := kube.Pods(conn, ns, a.Str("query"))
			if err != nil {
				return nil, err
			}
			return withConnection(map[string]any{"pods": pods, "count": len(pods)}, chosen), nil
		},
	})

	s.register(&Tool{
		Name:  "kube_logs",
		Title: "Read pod logs",
		Description: "Fetch logs from one or more pods, with an optional grep filter. When several pods are selected each line is prefixed with its pod name. " +
			"Set source=file with filePath for services that write to a log file instead of stdout.",
		ReadOnly: true,
		Schema: obj(merge(connectionArg("Kube Console"), kubeConnProps, map[string]any{
			"namespace":    str("Namespace the pods are in."),
			"pods":         strArray("Pod names to read."),
			"container":    str("Container name, when a pod has more than one."),
			"tail":         num("Lines to read from the end of the log (default 500)."),
			"sinceMinutes": num("Only return lines from the last N minutes."),
			"previous":     boolean("Read the previous container instance's logs — use after a crash."),
			"grep":         str("Only return lines containing this."),
			"grepRegex":    boolean("Treat grep as a regular expression."),
			"source":       enum("stdout (default) reads container logs; file tails filePath inside the pod.", "stdout", "file"),
			"filePath":     str("Path to the log file inside the container, when source=file."),
		}), "namespace", "pods"),
		Run: func(a Args) (any, error) {
			conn, chosen, err := s.kubeConn(a)
			if err != nil {
				return nil, err
			}
			ns, err := a.Require("namespace")
			if err != nil {
				return nil, err
			}
			pods := a.StrSlice("pods")
			if len(pods) == 0 {
				return nil, fmt.Errorf(`"pods" is required — pass at least one pod name (see kube_pods)`)
			}
			res, err := kube.Logs(kube.LogsRequest{
				Conn:         conn,
				Namespace:    ns,
				Pods:         pods,
				Container:    a.Str("container"),
				Tail:         a.Int("tail", 500),
				SinceMinutes: a.Int("sinceMinutes", 0),
				Previous:     a.Bool("previous", false),
				Grep:         a.Str("grep"),
				GrepRegex:    a.Bool("grepRegex", false),
				Source:       a.Str("source"),
				FilePath:     a.Str("filePath"),
			})
			if err != nil {
				return nil, err
			}
			return withConnection(res, chosen), nil
		},
	})

	s.register(&Tool{
		Name:        "kube_exec",
		Title:       "Run a command in a pod",
		Description: "Run a shell command inside a pod's container and return its combined output. This executes on a live pod — keep commands read-only unless the developer asked for a change.",
		Schema: obj(merge(connectionArg("Kube Console"), kubeConnProps, map[string]any{
			"namespace": str("Namespace the pod is in."),
			"pod":       str("Pod name."),
			"container": str("Container name, when a pod has more than one."),
			"command":   str("Shell command to run, e.g. ls -la /var/log."),
			"timeoutMs": num("Timeout in milliseconds (default 60000)."),
		}), "namespace", "pod", "command"),
		Run: func(a Args) (any, error) {
			conn, chosen, err := s.kubeConn(a)
			if err != nil {
				return nil, err
			}
			ns, err := a.Require("namespace")
			if err != nil {
				return nil, err
			}
			pod, err := a.Require("pod")
			if err != nil {
				return nil, err
			}
			cmd, err := a.Require("command")
			if err != nil {
				return nil, err
			}
			res, err := kube.Exec(kube.ExecRequest{
				Conn:      conn,
				Namespace: ns,
				Pod:       pod,
				Container: a.Str("container"),
				Command:   cmd,
				TimeoutMs: a.Int("timeoutMs", 0),
			})
			if err != nil {
				return nil, err
			}
			return withConnection(res, chosen), nil
		},
	})
}

// -------------------------------------------------------------------- SSH

var sshConnKeys = []string{"host", "port", "username", "password"}

var sshConnProps = map[string]any{
	"host":     str("Host, or user@host."),
	"port":     str("Port (default 22)."),
	"username": str("Username, when not part of host."),
	"password": str("Password."),
}

func (s *Server) sshConn(a Args) (sshx.Conn, resolved, error) {
	r, err := s.resolve("putty", a, sshConnKeys)
	if err != nil {
		return sshx.Conn{}, r, err
	}
	var c sshx.Conn
	if err := decodeInto(r.Fields, &c); err != nil {
		return sshx.Conn{}, r, err
	}
	if strings.TrimSpace(c.Host) == "" {
		return sshx.Conn{}, r, fmt.Errorf(`no host: set "host" or name a saved SSH connection`)
	}
	return c, r, nil
}

func (s *Server) registerSSH() {
	s.register(&Tool{
		Name:        "ssh_exec",
		Title:       "Run a command over SSH",
		Description: "Run a command on a remote host over SSH and return its combined output. This runs on a real machine — keep commands read-only unless the developer asked for a change.",
		Schema: obj(merge(connectionArg("SSH"), sshConnProps, map[string]any{
			"command":   str("The command to run."),
			"timeoutMs": num("Timeout in milliseconds (default 60000)."),
		}), "command"),
		Run: func(a Args) (any, error) {
			conn, chosen, err := s.sshConn(a)
			if err != nil {
				return nil, err
			}
			cmd, err := a.Require("command")
			if err != nil {
				return nil, err
			}
			res, err := sshx.Exec(conn, cmd, a.Int("timeoutMs", 0))
			if err != nil {
				return nil, err
			}
			return withConnection(res, chosen), nil
		},
	})

	s.register(&Tool{
		Name:        "sftp_list",
		Title:       "List a remote directory",
		Description: "List a directory on a remote host over SFTP. An empty path resolves to the login user's home directory.",
		ReadOnly:    true,
		Schema: obj(merge(connectionArg("SSH"), sshConnProps, map[string]any{
			"path": str("Remote directory path. Empty means the login user's home."),
		})),
		Run: func(a Args) (any, error) {
			conn, chosen, err := s.sshConn(a)
			if err != nil {
				return nil, err
			}
			entries, dir, err := sshx.SFTPList(conn, a.Str("path"))
			if err != nil {
				return nil, err
			}
			return withConnection(map[string]any{"path": dir, "entries": entries, "count": len(entries)}, chosen), nil
		},
	})
}
