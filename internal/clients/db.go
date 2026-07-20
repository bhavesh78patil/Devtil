package clients

import (
	"context"
	"database/sql"
	"fmt"
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
	Username string `json:"username"`
	Password string `json:"password"`
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

	logging.Logf("cassandra: connect %v, query %q", hosts, logging.Snippet(query, 200))
	session, err := cluster.CreateSession()
	if err != nil {
		logging.Logf("cassandra: connect failed: %v", err)
		return nil, fmt.Errorf("cassandra: %v", err)
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
	hosts := conn.hostList()
	if len(hosts) == 0 || conn.Service == "" {
		return nil, fmt.Errorf("host and service name are required")
	}
	if strings.TrimSpace(query) == "" {
		return nil, fmt.Errorf("query is empty")
	}
	maxRows = clampRows(maxRows)

	port := conn.Port
	if port <= 0 {
		port = 1521
	}
	url := go_ora.BuildUrl(hosts[0], port, conn.Service, conn.Username, conn.Password, nil)
	db, err := sql.Open("oracle", url)
	if err != nil {
		return nil, fmt.Errorf("oracle: %v", err)
	}
	defer db.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	logging.Logf("oracle: connect %s:%d/%s, query %q", hosts[0], port, conn.Service, logging.Snippet(query, 200))
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
