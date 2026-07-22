package clients

import "testing"

func TestBuildDSN(t *testing.T) {
	cases := []struct {
		name   string
		engine string
		conn   DBConn
		driver string
		want   string
	}{
		{"oracle fields", "oracle", DBConn{Hosts: "ohost", Port: 1521, Service: "ORCLPDB1", Username: "u", Password: "p"}, "oracle", "oracle://u:p@ohost:1521/ORCLPDB1"},
		{"oracle url", "oracle", DBConn{URL: "jdbc:oracle:thin:@ohost:1521/ORCLPDB1", Username: "u", Password: "p"}, "oracle", "oracle://u:p@ohost:1521/ORCLPDB1"},
		{"mysql fields", "mysql", DBConn{Hosts: "mhost", Port: 3306, Database: "sales", Username: "root", Password: "pw", Insecure: true}, "mysql", "root:pw@tcp(mhost:3306)/sales?parseTime=true&timeout=10s"},
		{"mysql url", "mysql", DBConn{URL: "mysql://root:pw@mhost:3306/sales", Insecure: true}, "mysql", "root:pw@tcp(mhost:3306)/sales?parseTime=true&timeout=10s"},
		{"mysql jdbc url", "mysql", DBConn{URL: "jdbc:mysql://mhost:3306/sales", Username: "root", Password: "pw", Insecure: true}, "mysql", "root:pw@tcp(mhost:3306)/sales?parseTime=true&timeout=10s"},
		{"mysql native dsn passthrough", "mysql", DBConn{URL: "root:pw@tcp(mhost:3306)/sales?x=1"}, "mysql", "root:pw@tcp(mhost:3306)/sales?x=1"},
		{"postgres fields", "postgres", DBConn{Hosts: "phost", Port: 5432, Database: "sales", Username: "pg", Password: "pw", Insecure: true}, "postgres", "postgres://pg:pw@phost:5432/sales?sslmode=disable&connect_timeout=10"},
		{"postgres url", "postgres", DBConn{URL: "postgres://pg:pw@phost:5432/sales?sslmode=disable"}, "postgres", "postgres://pg:pw@phost:5432/sales?sslmode=disable"},
		{"postgres jdbc url", "postgres", DBConn{URL: "jdbc:postgresql://phost:5432/sales", Username: "pg", Password: "pw", Insecure: true}, "postgres", "postgres://pg:pw@phost:5432/sales?sslmode=disable"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			drv, dsn, err := buildDSN(normalizeEngine(c.engine), c.conn)
			if err != nil {
				t.Fatalf("err: %v", err)
			}
			if drv != c.driver {
				t.Errorf("driver = %q, want %q", drv, c.driver)
			}
			if dsn != c.want {
				t.Errorf("dsn  = %q\nwant = %q", dsn, c.want)
			}
		})
	}
}
