// Devtil is a local developer-utilities workbench: JSON tools, encoders,
// an API client, Kubernetes log search, notepads and more, organised into
// autosaved workspaces. It ships as a single binary that serves an embedded
// UI on localhost and opens it in the browser (or inside the Electron shell
// in desktop/).
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

	"github.com/bhavesh78patil/devtil/internal/server"
	"github.com/bhavesh78patil/devtil/internal/store"
)

//go:embed web
var webFS embed.FS

func main() {
	port := flag.Int("port", 8347, "port to listen on (0 picks a free port)")
	dataDir := flag.String("data", "", "data directory (default: <user config dir>/devtil)")
	noBrowser := flag.Bool("no-browser", false, "do not open the browser on startup")
	flag.Parse()

	dir := *dataDir
	if dir == "" {
		base, err := os.UserConfigDir()
		if err != nil {
			base, _ = os.UserHomeDir()
		}
		dir = filepath.Join(base, "devtil")
	}
	st, err := store.New(dir)
	if err != nil {
		log.Fatalf("devtil: %v", err)
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

	log.Printf("devtil running at %s (state: %s)", url, st.Path())
	if !*noBrowser {
		openBrowser(url)
	}
	log.Fatal(http.Serve(ln, server.New(st, web).Handler()))
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
