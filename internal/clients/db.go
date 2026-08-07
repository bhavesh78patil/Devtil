package clients

import (
	"context"
	"database/sql"
	"fmt"
	"net/url"
	"strconv"
	"strings"
	"time"

	_ "github.com/go-sql-driver/mysql"
	"github.com/gocql/gocql"
	_ "github.com/lib/pq"
	go_ora "github.com/sijms/go-ora/v2"

	"github.com/bhavesh78patil/devtil/internal/logging"
)

// DBConn covers Cassandra and the relational engines (Oracle, MySQL,
// PostgreSQL); unused fields are simply left empty by the respective tool.
type DBConn struct {
	Engine   string `json:"engine"` // relational engine: oracle | mysql | postgres
	Hosts    string `json:"hosts"`  // comma-separated; relational engines use the first
	Port     int    `json:"port"`
	Keyspace string `json:"keyspace"` // Cassandra
	Service  string `json:"service"`  // Oracle service name
	Database string `json:"database"` // MySQL / PostgreSQL database name
	Schema   string `json:"schema"`   // Oracle owner / PostgreSQL schema (search_path)
	URL      string `json:"url"`      // JDBC / connect URL (overrides the separate host/port fields)
	Username string `json:"username"`
	Password string `json:"password"`
	Insecure bool   `json:"insecure"` // MySQL/PostgreSQL: skip TLS (sslmode=disable / tls=false)
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
	if n > 10000 { // ceiling matches the UI's max export size
		return 10000
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

// ---------------------------------------------- Relational engines (SQL)
//
// One code path for Oracle, MySQL and PostgreSQL over database/sql. Each
// engine differs only in its driver name and how the connection string is
// built (from separate host/port fields or a single URL) and in how the
// browsing schema is applied.

// normalizeEngine maps a few common aliases to the canonical engine id.
func normalizeEngine(e string) string {
	switch strings.ToLower(strings.TrimSpace(e)) {
	case "mysql", "mariadb":
		return "mysql"
	case "postgres", "postgresql", "pg":
		return "postgres"
	case "", "oracle":
		return "oracle"
	}
	return strings.ToLower(strings.TrimSpace(e))
}

// buildDSN returns the database/sql driver name and connection string for the
// given engine, honouring a full URL when one is supplied.
func buildDSN(engine string, conn DBConn) (driver, dsn string, err error) {
	switch engine {
	case "oracle":
		host, service := "", conn.Service
		port := conn.Port
		if port <= 0 {
			port = 1521
		}
		if strings.TrimSpace(conn.URL) != "" {
			h, p, svc, e := parseOracleURL(conn.URL)
			if e != nil {
				return "", "", e
			}
			host, port, service = h, p, svc
		} else {
			hosts := conn.hostList()
			if len(hosts) == 0 || service == "" {
				return "", "", fmt.Errorf("host and service name (or a connect URL) are required")
			}
			host = hosts[0]
		}
		return "oracle", go_ora.BuildUrl(host, port, service, conn.Username, conn.Password, nil), nil

	case "mysql":
		d, e := buildMySQLDSN(conn)
		return "mysql", d, e

	case "postgres":
		d, e := buildPostgresDSN(conn)
		return "postgres", d, e
	}
	return "", "", fmt.Errorf("unsupported engine %q", engine)
}

// buildMySQLDSN produces a go-sql-driver/mysql DSN
// (user:pass@tcp(host:port)/db?params). It accepts a native DSN, a
// mysql:// URL, or a jdbc:mysql:// URL in conn.URL.
func buildMySQLDSN(conn DBConn) (string, error) {
	params := "parseTime=true&timeout=10s"
	if !conn.Insecure {
		params += "&tls=preferred"
	}
	if u := strings.TrimSpace(conn.URL); u != "" {
		if strings.Contains(u, "@tcp(") || strings.Contains(u, "@unix(") {
			return u, nil // already a native Go DSN
		}
		u = strings.TrimPrefix(u, "jdbc:")
		pu, err := url.Parse(u)
		if err != nil {
			return "", fmt.Errorf("could not parse MySQL URL %q: %v", conn.URL, err)
		}
		user, pass := conn.Username, conn.Password
		if pu.User != nil {
			if user == "" {
				user = pu.User.Username()
			}
			if pass == "" {
				if p, ok := pu.User.Password(); ok {
					pass = p
				}
			}
		}
		if q := pu.Query(); user == "" && q.Get("user") != "" {
			user, pass = q.Get("user"), q.Get("password")
		}
		host := pu.Host
		if host == "" {
			host = "127.0.0.1:3306"
		}
		db := strings.TrimPrefix(pu.Path, "/")
		return fmt.Sprintf("%s:%s@tcp(%s)/%s?%s", user, pass, host, db, params), nil
	}
	hosts := conn.hostList()
	if len(hosts) == 0 {
		return "", fmt.Errorf("host (or a connect URL) is required")
	}
	port := conn.Port
	if port <= 0 {
		port = 3306
	}
	return fmt.Sprintf("%s:%s@tcp(%s:%d)/%s?%s", conn.Username, conn.Password, hosts[0], port, conn.Database, params), nil
}

// buildPostgresDSN produces a lib/pq connection URL. It accepts a
// postgres://, postgresql:// or jdbc:postgresql:// URL in conn.URL.
func buildPostgresDSN(conn DBConn) (string, error) {
	sslmode := "require"
	if conn.Insecure {
		sslmode = "disable"
	}
	if u := strings.TrimSpace(conn.URL); u != "" {
		u = strings.TrimPrefix(u, "jdbc:")
		u = strings.Replace(u, "postgresql://", "postgres://", 1)
		pu, err := url.Parse(u)
		if err != nil {
			return "", fmt.Errorf("could not parse PostgreSQL URL %q: %v", conn.URL, err)
		}
		q := pu.Query()
		if q.Get("sslmode") == "" {
			q.Set("sslmode", sslmode)
		}
		if conn.Username != "" && pu.User == nil {
			pu.User = url.UserPassword(conn.Username, conn.Password)
		}
		pu.RawQuery = q.Encode()
		return pu.String(), nil
	}
	hosts := conn.hostList()
	if len(hosts) == 0 {
		return "", fmt.Errorf("host (or a connect URL) is required")
	}
	port := conn.Port
	if port <= 0 {
		port = 5432
	}
	pu := &url.URL{
		Scheme:   "postgres",
		User:     url.UserPassword(conn.Username, conn.Password),
		Host:     fmt.Sprintf("%s:%d", hosts[0], port),
		Path:     "/" + conn.Database,
		RawQuery: "sslmode=" + sslmode + "&connect_timeout=10",
	}
	return pu.String(), nil
}

// applySchema points a fresh session at the requested schema so the user's
// own unqualified queries resolve there. Best-effort — a failure is ignored.
func applySchema(ctx context.Context, db *sql.DB, engine, schema string) {
	schema = strings.TrimSpace(schema)
	if schema == "" {
		return
	}
	switch engine {
	case "oracle":
		db.ExecContext(ctx, `ALTER SESSION SET CURRENT_SCHEMA = `+quoteIdent(schema))
	case "postgres":
		db.ExecContext(ctx, `SET search_path TO `+quoteIdent(schema))
	}
}

// quoteIdent conservatively quotes an identifier used in a SET statement.
func quoteIdent(s string) string {
	if strings.IndexFunc(s, func(r rune) bool {
		return !(r == '_' || r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9')
	}) >= 0 {
		return `"` + strings.ReplaceAll(s, `"`, `""`) + `"`
	}
	return s
}

// RelationalQuery runs SQL against Oracle, MySQL or PostgreSQL.
func RelationalQuery(engine string, conn DBConn, query string, maxRows int) (*QueryResult, error) {
	engine = normalizeEngine(engine)
	if strings.TrimSpace(query) == "" {
		return nil, fmt.Errorf("query is empty")
	}
	maxRows = clampRows(maxRows)

	driver, dsn, err := buildDSN(engine, conn)
	if err != nil {
		return nil, fmt.Errorf("%s: %v", engine, err)
	}
	db, err := sql.Open(driver, dsn)
	if err != nil {
		return nil, fmt.Errorf("%s: %v", engine, err)
	}
	defer db.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	logging.Logf("%s: connect (schema %q), query %q", engine, conn.Schema, logging.Snippet(query, 200))
	if err := db.PingContext(ctx); err != nil {
		logging.Logf("%s: connect failed: %v", engine, err)
		return nil, fmt.Errorf("%s: %v", engine, err)
	}
	applySchema(ctx, db, engine, conn.Schema)

	start := time.Now()
	stmt := strings.TrimSpace(query)
	if engine == "oracle" {
		stmt = strings.TrimSuffix(stmt, ";") // go-ora rejects a trailing semicolon
	}

	if !isReadQuery(stmt) {
		r, err := db.ExecContext(ctx, stmt)
		if err != nil {
			return nil, fmt.Errorf("%s: %v", engine, err)
		}
		affected, _ := r.RowsAffected()
		return &QueryResult{Columns: []string{}, Rows: [][]string{}, RowsAffected: affected, DurationMs: time.Since(start).Milliseconds()}, nil
	}

	rows, err := db.QueryContext(ctx, stmt)
	if err != nil {
		return nil, fmt.Errorf("%s: %v", engine, err)
	}
	defer rows.Close()

	names, err := rows.Columns()
	if err != nil {
		return nil, fmt.Errorf("%s: %v", engine, err)
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
			return nil, fmt.Errorf("%s: %v", engine, err)
		}
		out := make([]string, len(names))
		for i, v := range vals {
			out[i] = stringify(v)
		}
		res.Rows = append(res.Rows, out)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("%s: %v", engine, err)
	}
	res.DurationMs = time.Since(start).Milliseconds()
	return res, nil
}
