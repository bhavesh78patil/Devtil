package sshx

import (
	"crypto/ed25519"
	"crypto/rand"
	"errors"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"
)

// A real SSH server with an SFTP subsystem, in-process. Reading a remote file
// is the one thing an agent can do to a host without changing it, so it is
// worth exercising against a genuine SFTP conversation rather than a stub.
func startSFTPServer(t *testing.T) Conn {
	t.Helper()

	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	signer, err := ssh.NewSignerFromKey(priv)
	if err != nil {
		t.Fatal(err)
	}
	cfg := &ssh.ServerConfig{
		PasswordCallback: func(c ssh.ConnMetadata, pass []byte) (*ssh.Permissions, error) {
			if c.User() == "dev" && string(pass) == "hunter2" {
				return nil, nil
			}
			return nil, errors.New("auth failed")
		},
	}
	cfg.AddHostKey(signer)

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })

	go func() {
		for {
			nConn, err := ln.Accept()
			if err != nil {
				return
			}
			go serveOne(nConn, cfg)
		}
	}()

	_, port, _ := net.SplitHostPort(ln.Addr().String())
	if _, err := strconv.Atoi(port); err != nil {
		t.Fatalf("bad port %q", port)
	}
	return Conn{Host: "127.0.0.1", Port: port, Username: "dev", Password: "hunter2"}
}

func serveOne(nConn net.Conn, cfg *ssh.ServerConfig) {
	conn, chans, reqs, err := ssh.NewServerConn(nConn, cfg)
	if err != nil {
		nConn.Close()
		return
	}
	defer conn.Close()
	go ssh.DiscardRequests(reqs)

	for newCh := range chans {
		if newCh.ChannelType() != "session" {
			newCh.Reject(ssh.UnknownChannelType, "only sessions")
			continue
		}
		ch, chReqs, err := newCh.Accept()
		if err != nil {
			return
		}
		go func(ch ssh.Channel, reqs <-chan *ssh.Request) {
			for req := range reqs {
				ok := req.Type == "subsystem" && strings.Contains(string(req.Payload), "sftp")
				req.Reply(ok, nil)
				if !ok {
					continue
				}
				srv, err := sftp.NewServer(ch)
				if err != nil {
					ch.Close()
					return
				}
				srv.Serve()
				srv.Close()
				ch.Close()
				return
			}
		}(ch, chReqs)
	}
}

func TestSFTPReadText(t *testing.T) {
	root := t.TempDir()
	small := filepath.Join(root, "config.yaml")
	if err := os.WriteFile(small, []byte("retries: 3\ntimeout: 5s\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	big := filepath.Join(root, "app.log")
	if err := os.WriteFile(big, []byte(strings.Repeat("line of log output\n", 500)), 0o644); err != nil {
		t.Fatal(err)
	}

	conn := startSFTPServer(t)

	t.Run("reads a whole file", func(t *testing.T) {
		text, size, truncated, err := SFTPReadText(conn, small, 1_000_000)
		if err != nil {
			t.Fatal(err)
		}
		if truncated {
			t.Error("a small file should not be reported as truncated")
		}
		if text != "retries: 3\ntimeout: 5s\n" {
			t.Errorf("text = %q", text)
		}
		if size != len(text) {
			t.Errorf("size = %d, want %d", size, len(text))
		}
	})

	t.Run("truncates and says so", func(t *testing.T) {
		text, size, truncated, err := SFTPReadText(conn, big, 100)
		if err != nil {
			t.Fatal(err)
		}
		if !truncated {
			t.Fatal("a file past the limit must be reported as truncated")
		}
		if size != 100 || len(text) != 100 {
			t.Errorf("size = %d, len = %d, want 100", size, len(text))
		}
	})

	t.Run("a file exactly at the limit is not truncated", func(t *testing.T) {
		exact := filepath.Join(root, "exact.txt")
		if err := os.WriteFile(exact, []byte(strings.Repeat("z", 64)), 0o644); err != nil {
			t.Fatal(err)
		}
		_, size, truncated, err := SFTPReadText(conn, exact, 64)
		if err != nil {
			t.Fatal(err)
		}
		if truncated || size != 64 {
			t.Errorf("truncated = %v, size = %d; want false, 64", truncated, size)
		}
	})

	t.Run("a missing file is an error, not empty text", func(t *testing.T) {
		if _, _, _, err := SFTPReadText(conn, filepath.Join(root, "nope"), 1000); err == nil {
			t.Fatal("expected an error for a missing file")
		}
	})

	t.Run("bad credentials do not connect", func(t *testing.T) {
		bad := conn
		bad.Password = "wrong"
		if _, _, _, err := SFTPReadText(bad, small, 1000); err == nil {
			t.Fatal("expected an auth failure")
		}
	})
}
