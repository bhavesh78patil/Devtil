// Devtil is a local developer-utilities workbench: JSON tools, encoders,
// an API client, Kubernetes log search, notepads and more, organised into
// autosaved workspaces. It ships as a single binary that serves an embedded
// UI on localhost and opens it in the browser (or inside the Electron shell
// in desktop/).
//
// The same binary also speaks the Model Context Protocol on stdio
// (`devtil mcp`), which hands the whole toolbox to an AI agent.
package main

import (
	"embed"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"

	"github.com/bhavesh78patil/devtil/internal/logging"
	"github.com/bhavesh78patil/devtil/internal/mcp"
	"github.com/bhavesh78patil/devtil/internal/server"
	"github.com/bhavesh78patil/devtil/internal/store"
)

//go:embed web
var webFS embed.FS

func main() {
	// Subcommands come before flag parsing so `devtil mcp --data …` reaches
	// the MCP flag set rather than the server's.
	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "mcp":
			runMCP(os.Args[2:])
			return
		case "help", "-h", "--help":
			usage()
			return
		}
	}

	port := flag.Int("port", 8347, "port to listen on (0 picks a free port)")
	dataDir := flag.String("data", "", "data directory (default: <user config dir>/devtil)")
	noBrowser := flag.Bool("no-browser", false, "do not open the browser on startup")
	flag.Usage = usage
	flag.Parse()

	dir := *dataDir
	if dir == "" {
		dir = defaultDataDir()
	}
	st, err := store.New(dir)
	if err != nil {
		log.Fatalf("devtil: %v", err)
	}
	if err := logging.Init(dir); err != nil {
		log.Printf("devtil: file logging disabled: %v", err)
	}

	web, err := fs.Sub(webFS, "web")
	if err != nil {
		log.Fatalf("devtil: %v", err)
	}

	// localhost only — never expose state or the request proxy to the network
	ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", *port))
	if err != nil {
		log.Fatalf("devtil: %v", err)
	}
	url := fmt.Sprintf("http://%s", ln.Addr().String())

	log.Printf("devtil running at %s (state: %s, log: %s)", url, st.Path(), logging.Path())
	if !*noBrowser {
		openBrowser(url)
	}
	log.Fatal(http.Serve(ln, server.New(st, web).Handler()))
}

func usage() {
	fmt.Fprint(os.Stderr, `devtil — a local developer-utilities workbench.

Usage:
  devtil [flags]        start the workbench and open it in a browser
  devtil mcp [flags]    expose the tools to an AI agent over MCP on stdio

Flags for the workbench:
  -port int      port to listen on, 0 picks a free one (default 8347)
  -data string   data directory (default: <user config dir>/devtil)
  -no-browser    do not open a browser on startup

Flags for MCP:
  -data string   data directory, used to resolve saved connections by name
  -okf string    Open Knowledge Format bundle directory
                 (default: <data dir>/knowledge)

Point an agent at it with a stdio MCP server entry:
  {"command": "devtil", "args": ["mcp"]}
`)
}

// runMCP serves the Model Context Protocol on stdin/stdout. Nothing may be
// written to stdout except protocol messages, so the file logger is the only
// place diagnostics go — the usual startup banner would corrupt the stream.
func runMCP(argv []string) {
	fs := flag.NewFlagSet("devtil mcp", flag.ExitOnError)
	dataDir := fs.String("data", "", "data directory (default: <user config dir>/devtil)")
	okfDir := fs.String("okf", "", "Open Knowledge Format bundle directory (default: <data dir>/knowledge)")
	fs.Usage = usage
	_ = fs.Parse(argv)

	dir := *dataDir
	if dir == "" {
		dir = defaultDataDir()
	}
	st, err := store.New(dir)
	if err != nil {
		fmt.Fprintf(os.Stderr, "devtil mcp: %v\n", err)
		os.Exit(1)
	}
	if err := logging.Init(dir); err != nil {
		fmt.Fprintf(os.Stderr, "devtil mcp: file logging disabled: %v\n", err)
	}
	bundle := *okfDir
	if bundle == "" {
		bundle = filepath.Join(dir, "knowledge")
	}

	logging.Logf("mcp: serving on stdio (state: %s, knowledge: %s)", st.Path(), bundle)
	srv := mcp.NewServer(os.Stdin, os.Stdout, mcp.Options{Store: st, OKFDir: bundle})
	if err := srv.Serve(); err != nil {
		fmt.Fprintf(os.Stderr, "devtil mcp: %v\n", err)
		os.Exit(1)
	}
}

func defaultDataDir() string {
	base, err := os.UserConfigDir()
	if err != nil {
		base, _ = os.UserHomeDir()
	}
	return filepath.Join(base, "devtil")
}

func openBrowser(url string) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", url)
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	default:
		cmd = exec.Command("xdg-open", url)
	}
	if err := cmd.Start(); err != nil {
		log.Printf("open %s manually (%v)", url, err)
	}
}
