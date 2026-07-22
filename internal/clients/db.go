package clients

import (
	"context"
	"database/sql"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/gocql/gocql"
	go_ora "github.com/sijms/go-ora/v2"

	"github.com/bhavesh78patil/devtil/internal/logging"
)

// DBConn covers both Cassandra and Oracle connections; unused fields are
// simply left empty by the respective tool.
type DBConn struct {
	Hosts    string `json:"hosts"` // comma-separated; Oracle uses the first
	Port     int    `json:"port"`
	Keyspace string `json:"keyspace"` // Cassandra
	Service  string `json:"service"`  // Oracle service name
	URL      string `json:"url"`      // Oracle JDBC/Easy-Connect URL (overrides host/port/service)
	Username string `json:"username"`
	Password string `json:"password"`
}

// parseOracleURL extracts host/port/service from an Oracle connect string —
// a JDBC thin URL (jdbc:oracle:thin:@host:1521/service or …:1521:SID),
// an Easy Connect string (host:1521/service), or a go-ora URL
// (oracle://host:1521/service). Credentials embedded in the URL are ignored;
// use the username/password fields.
func parseOracleURL(u string) (host string, port int, service string, err error) {
	s := strings.TrimSpace(u)
	if i := strings.LastIndex(s, "@"); i >= 0 { // strip jdbc:oracle:thin:@ or oracle://user:pass@
		s = s[i+1:]
	} else if i := strings.Index(s, "://"); i >= 0 {
		s = s[i+3:]
	}
	s = strings.TrimPrefix(s, "//")
	if q := strings.IndexAny(s, "?"); q >= 0 { // drop any query params
		s = s[:q]
	}

	port = 1521
	if slash := strings.Index(s, "/"); slash >= 0 { // host:port/service
		service = strings.Trim(s[slash+1:], "/ ")
		s = s[:slash]
	} else if parts := strings.Split(s, ":"); len(parts) >= 3 { // host:port:SID
		service = parts[2]
		s = parts[0] + ":" + parts[1]
	}
	hp := strings.Split(s, ":")
	host = strings.TrimSpace(hp[0])
	if len(hp) >= 2 {
		if p, e := strconv.Atoi(strings.TrimSpace(hp[1])); e == nil {
			port = p
		}
	}
	if host == "" || service == "" {
		return "", 0, "", fmt.Errorf("could not parse Oracle URL %q (expected …@host:1521/service)", u)
	}
	return host, port, service, nil
}

func (c DBConn) hostList() []string {
	var out []string
	for _, h := range strings.Split(c.Hosts, ",") {
		if h = strings.TrimSpace(h); h != "" {
			out = append(out, h)
		}
	}
	return out
}

type QueryResult struct {
	Columns      []string   `json:"columns"`
	Rows         [][]string `json:"rows"`
	RowsAffected int64      `json:"rowsAffected"`
	Truncated    bool       `json:"truncated"`
	DurationMs   int64      `json:"durationMs"`
}

const defaultMaxRows = 200

func clampRows(n int) int {
	if n <= 0 {
		return defaultMaxRows
	}
	if n > 5000 {
		return 5000
	}
	return n
}

func isReadQuery(q string) bool {
	first := strings.ToLower(strings.Fields(strings.TrimSpace(q))[0])
	switch first {
	case "select", "with", "show", "list", "desc", "describe":
		return true
	}
	return false
}

func stringify(v any) string {
	switch x := v.(type) {
	case nil:
		return "NULL"
	case []byte:
		return string(x)
	case time.Time:
		return x.UTC().Format(time.RFC3339)
	default:
		return fmt.Sprintf("%v", x)
	}
}

// ---------------------------------------------------------------- Cassandra

// cassandraConnectHint appends actionable guidance to network-level connect
// failures, which are almost always reachability problems rather than bad
// credentials or CQL.
func cassandraConnectHint(err error) string {
	s := strings.ToLower(err.Error())
	switch {
	case strings.Contains(s, "i/o timeout"),
		strings.Contains(s, "connection refused"),
		strings.Contains(s, "no route to host"),
		strings.Contains(s, "no such host"):
		return " — the contact point isn't reachable from this machine. Check the host and port" +
			" (Cassandra's native CQL port is usually 9042), plus any firewall or VPN. Note that" +
			" Kubernetes pod IPs (10.x / 172.16–31.x / 192.168.x) are only reachable inside the cluster:" +
			" expose Cassandra via a LoadBalancer/NodePort service, or run" +
			" `kubectl port-forward svc/<cassandra> 9042:9042` and connect to 127.0.0.1:9042."
	}
	return ""
}

func CassandraQuery(conn DBConn, query string, maxRows int) (*QueryResult, error) {
	hosts := conn.hostList()
	if len(hosts) == 0 {
		return nil, fmt.Errorf("at least one contact point (host) is required")
	}
	if strings.TrimSpace(query) == "" {
		return nil, fmt.Errorf("query is empty")
	}
	maxRows = clampRows(maxRows)

	cluster := gocql.NewCluster(hosts...)
	if conn.Port > 0 {
		cluster.Port = conn.Port
	}
	if conn.Keyspace != "" {
		cluster.Keyspace = conn.Keyspace
	}
	if conn.Username != "" {
		cluster.Authenticator = gocql.PasswordAuthenticator{Username: conn.Username, Password: conn.Password}
	}
	cluster.ConnectTimeout = 10 * time.Second
	cluster.Timeout = 20 * time.Second
	// Only talk to the contact points we were given; don't auto-discover the
	// rest of the ring from system.peers. Discovered peers are usually internal
	// addresses (e.g. Kubernetes pod IPs like 10.x.x.x) that aren't reachable
	// from outside the cluster, which would otherwise cause connect timeouts
	// even after the control connection succeeds.
	cluster.DisableInitialHostLookup = true

	logging.Logf("cassandra: connect %v (port %d), query %q", hosts, cluster.Port, logging.Snippet(query, 200))
	session, err := cluster.CreateSession()
	if err != nil {
		logging.Logf("cassandra: connect failed: %v", err)
		return nil, fmt.Errorf("cassandra: %v%s", err, cassandraConnectHint(err))
	}
	defer session.Close()

	start := time.Now()
	q := session.Query(strings.TrimSuffix(strings.TrimSpace(query), ";"))
	defer q.Release()

	if !isReadQuery(query) {
		if err := q.Exec(); err != nil {
			return nil, fmt.Errorf("cassandra: %v", err)
		}
		return &QueryResult{Columns: []string{}, Rows: [][]string{}, DurationMs: time.Since(start).Milliseconds()}, nil
	}

	iter := q.Iter()
	cols := iter.Columns()
	names := make([]string, len(cols))
	for i, c := range cols {
		names[i] = c.Name
	}

	res := &QueryResult{Columns: names, Rows: [][]string{}}
	row := map[string]any{}
	for iter.MapScan(row) {
		if len(res.Rows) >= maxRows {
			res.Truncated = true
			break
		}
		out := make([]string, len(names))
		for i, n := range names {
			out[i] = stringify(row[n])
		}
		res.Rows = append(res.Rows, out)
		row = map[string]any{}
	}
	if err := iter.Close(); err != nil {
		return nil, fmt.Errorf("cassandra: %v", err)
	}
	res.DurationMs = time.Since(start).Milliseconds()
	return res, nil
}

// ------------------------------------------------------------------- Oracle

func OracleQuery(conn DBConn, query string, maxRows int) (*QueryResult, error) {
	if strings.TrimSpace(query) == "" {
		return nil, fmt.Errorf("query is empty")
	}
	maxRows = clampRows(maxRows)

	var host, service string
	port := conn.Port
	if port <= 0 {
		port = 1521
	}
	if strings.TrimSpace(conn.URL) != "" { // a JDBC/Easy-Connect URL wins over the separate fields
		h, p, svc, err := parseOracleURL(conn.URL)
		if err != nil {
			return nil, fmt.Errorf("oracle: %v", err)
		}
		host, port, service = h, p, svc
	} else {
		hosts := conn.hostList()
		if len(hosts) == 0 || conn.Service == "" {
			return nil, fmt.Errorf("host and service name (or a JDBC URL) are required")
		}
		host, service = hosts[0], conn.Service
	}

	url := go_ora.BuildUrl(host, port, service, conn.Username, conn.Password, nil)
	db, err := sql.Open("oracle", url)
	if err != nil {
		return nil, fmt.Errorf("oracle: %v", err)
	}
	defer db.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	logging.Logf("oracle: connect %s:%d/%s, query %q", host, port, service, logging.Snippet(query, 200))
	if err := db.PingContext(ctx); err != nil {
		logging.Logf("oracle: connect failed: %v", err)
		return nil, fmt.Errorf("oracle: %v", err)
	}

	start := time.Now()
	stmt := strings.TrimSuffix(strings.TrimSpace(query), ";") // go-ora rejects trailing semicolons

	if !isReadQuery(stmt) {
		res, err := db.ExecContext(ctx, stmt)
		if err != nil {
			return nil, fmt.Errorf("oracle: %v", err)
		}
		affected, _ := res.RowsAffected()
		return &QueryResult{Columns: []string{}, Rows: [][]string{}, RowsAffected: affected, DurationMs: time.Since(start).Milliseconds()}, nil
	}

	rows, err := db.QueryContext(ctx, stmt)
	if err != nil {
		return nil, fmt.Errorf("oracle: %v", err)
	}
	defer rows.Close()

	names, err := rows.Columns()
	if err != nil {
		return nil, fmt.Errorf("oracle: %v", err)
	}
	res := &QueryResult{Columns: names, Rows: [][]string{}}
	vals := make([]any, len(names))
	ptrs := make([]any, len(names))
	for i := range vals {
		ptrs[i] = &vals[i]
	}
	for rows.Next() {
		if len(res.Rows) >= maxRows {
			res.Truncated = true
			break
		}
		if err := rows.Scan(ptrs...); err != nil {
			return nil, fmt.Errorf("oracle: %v", err)
		}
		out := make([]string, len(names))
		for i, v := range vals {
			out[i] = stringify(v)
		}
		res.Rows = append(res.Rows, out)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("oracle: %v", err)
	}
	res.DurationMs = time.Since(start).Milliseconds()
	return res, nil
}
