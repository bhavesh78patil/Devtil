package proxy

import (
	"strings"
	"testing"
)

func mustParse(t *testing.T, cmd string) *CurlRequest {
	t.Helper()
	r, err := ParseCurl(cmd)
	if err != nil {
		t.Fatalf("ParseCurl(%q): %v", cmd, err)
	}
	return r
}

func TestParseCurlBasics(t *testing.T) {
	r := mustParse(t, `curl https://api.example.com/orders`)
	if r.Method != "GET" || r.URL != "https://api.example.com/orders" {
		t.Errorf("got %s %s", r.Method, r.URL)
	}
}

// curl's own rule: a body without -X means POST.
func TestParseCurlDataImpliesPost(t *testing.T) {
	r := mustParse(t, `curl https://api.example.com/orders -d '{"amount":100}'`)
	if r.Method != "POST" {
		t.Errorf("method = %s, want POST", r.Method)
	}
	if r.Body != `{"amount":100}` {
		t.Errorf("body = %q", r.Body)
	}
	// an explicit method still wins
	r2 := mustParse(t, `curl -X PUT https://api.example.com/orders/1 -d 'x=1'`)
	if r2.Method != "PUT" {
		t.Errorf("method = %s, want PUT", r2.Method)
	}
}

func TestParseCurlHeaders(t *testing.T) {
	r := mustParse(t, `curl -H 'Content-Type: application/json' -H "X-Team: payments" https://x.test/v1`)
	if r.Headers["Content-Type"] != "application/json" {
		t.Errorf("Content-Type = %q", r.Headers["Content-Type"])
	}
	if r.Headers["X-Team"] != "payments" {
		t.Errorf("X-Team = %q", r.Headers["X-Team"])
	}
}

// The browser "copy as cURL" shape: continuations, many headers, a JSON body
// with escaped quotes.
func TestParseCurlMultilineFromABrowser(t *testing.T) {
	cmd := `curl 'https://api.example.com/v2/orders' \
  -X POST \
  -H 'accept: application/json' \
  -H 'authorization: Bearer tok-abc' \
  -H 'content-type: application/json' \
  --data-raw '{"orderId":"ORD-1","items":[{"sku":"x","qty":2}]}' \
  --compressed`
	r := mustParse(t, cmd)
	if r.Method != "POST" {
		t.Errorf("method = %s", r.Method)
	}
	if r.URL != "https://api.example.com/v2/orders" {
		t.Errorf("url = %q", r.URL)
	}
	if r.Headers["authorization"] != "Bearer tok-abc" {
		t.Errorf("authorization = %q", r.Headers["authorization"])
	}
	if !strings.Contains(r.Body, `"orderId":"ORD-1"`) {
		t.Errorf("body = %q", r.Body)
	}
	if len(r.Warnings) != 0 {
		t.Errorf("--compressed should be a silent no-op, got warnings %v", r.Warnings)
	}
}

// -u must not become an Authorization header behind the developer's back: it
// belongs in the request's auth block where they can see and edit it.
func TestParseCurlUserBecomesCredentials(t *testing.T) {
	r := mustParse(t, `curl -u svc:s3cr3t https://api.example.com/health`)
	if r.Username != "svc" || r.Password != "s3cr3t" {
		t.Errorf("got %q / %q", r.Username, r.Password)
	}
	if _, ok := r.Headers["Authorization"]; ok {
		t.Error("-u should not be baked into a header")
	}
	// a username with no password is legal
	r2 := mustParse(t, `curl -u onlyuser https://x.test/`)
	if r2.Username != "onlyuser" || r2.Password != "" {
		t.Errorf("got %q / %q", r2.Username, r2.Password)
	}
}

func TestParseCurlLongFlagsWithEquals(t *testing.T) {
	r := mustParse(t, `curl --request=DELETE --header='X-A: 1' --url=https://x.test/v1/thing`)
	if r.Method != "DELETE" {
		t.Errorf("method = %s", r.Method)
	}
	if r.URL != "https://x.test/v1/thing" {
		t.Errorf("url = %q", r.URL)
	}
	if r.Headers["X-A"] != "1" {
		t.Errorf("X-A = %q", r.Headers["X-A"])
	}
}

func TestParseCurlFlagShorthands(t *testing.T) {
	r := mustParse(t, `curl -k -s -L -A 'devtil/1' -b 'sid=42' -e https://ref.test https://x.test/`)
	if !r.Insecure {
		t.Error("-k should set Insecure")
	}
	if r.Headers["User-Agent"] != "devtil/1" {
		t.Errorf("User-Agent = %q", r.Headers["User-Agent"])
	}
	if r.Headers["Cookie"] != "sid=42" {
		t.Errorf("Cookie = %q", r.Headers["Cookie"])
	}
	if r.Headers["Referer"] != "https://ref.test" {
		t.Errorf("Referer = %q", r.Headers["Referer"])
	}
	if r.Method != "GET" {
		t.Errorf("method = %s", r.Method)
	}
	if r.URL != "https://x.test/" {
		t.Errorf("url = %q — a flag value was mistaken for the URL", r.URL)
	}
}

func TestParseCurlHeadIsHEAD(t *testing.T) {
	if m := mustParse(t, `curl -I https://x.test/`).Method; m != "HEAD" {
		t.Errorf("method = %s, want HEAD", m)
	}
}

// A flag that takes a value must consume it, or the value ends up being read
// as the URL — which produces a request that quietly points somewhere else.
func TestParseCurlValueFlagsDoNotSwallowTheURL(t *testing.T) {
	r := mustParse(t, `curl -o out.json --max-time 30 https://api.example.com/real`)
	if r.URL != "https://api.example.com/real" {
		t.Errorf("url = %q — a flag value was taken as the URL", r.URL)
	}
	if len(r.Warnings) == 0 {
		t.Error("dropping -o and --max-time should be reported, not silent")
	}
}

func TestParseCurlRepeatedDataIsJoined(t *testing.T) {
	r := mustParse(t, `curl https://x.test/form -d name=ada -d role=admin`)
	if r.Body != "name=ada&role=admin" {
		t.Errorf("body = %q, want the parts joined with &", r.Body)
	}
}

// Things we cannot honour have to be said out loud. A request that looks
// right and behaves differently is worse than one that refuses.
func TestParseCurlWarnsAboutWhatItCannotDo(t *testing.T) {
	r := mustParse(t, `curl -F file=@/tmp/x.png https://x.test/upload`)
	if len(r.Warnings) == 0 {
		t.Error("a multipart form should warn")
	}
	r2 := mustParse(t, `curl -d @payload.json https://x.test/v1`)
	if len(r2.Warnings) == 0 {
		t.Error("@file data should warn")
	}
	if r2.Body != "" {
		t.Errorf("@file should not become a literal body, got %q", r2.Body)
	}
}

func TestParseCurlQuotingAndEscapes(t *testing.T) {
	r := mustParse(t, `curl -H "X-Quote: say \"hi\"" https://x.test/`)
	if r.Headers["X-Quote"] != `say "hi"` {
		t.Errorf("X-Quote = %q", r.Headers["X-Quote"])
	}
	// $'…' honours escapes; '…' is literal
	r2 := mustParse(t, `curl -d $'line1\nline2' https://x.test/`)
	if r2.Body != "line1\nline2" {
		t.Errorf("body = %q, want a real newline", r2.Body)
	}
	r3 := mustParse(t, `curl -d 'line1\nline2' https://x.test/`)
	if r3.Body != `line1\nline2` {
		t.Errorf("body = %q, want the backslash-n left alone", r3.Body)
	}
}

func TestParseCurlAddsAMissingScheme(t *testing.T) {
	if u := mustParse(t, `curl api.example.com/v1`).URL; u != "https://api.example.com/v1" {
		t.Errorf("url = %q", u)
	}
	if u := mustParse(t, `curl http://api.example.com/v1`).URL; u != "http://api.example.com/v1" {
		t.Errorf("url = %q — an explicit scheme must be kept", u)
	}
}

func TestParseCurlErrors(t *testing.T) {
	for _, cmd := range []string{
		``,
		`curl`,                // no URL
		`curl -H`,             // flag with no value
		`curl -H 'unclosed`,   // unbalanced quote
		`curl "also unclosed`, //
		`curl -X`,             // method with no value
	} {
		if _, err := ParseCurl(cmd); err == nil {
			t.Errorf("ParseCurl(%q) should have failed", cmd)
		}
	}
}

// The command does not have to start with the word curl — people paste a
// fragment as often as the whole line.
func TestParseCurlWithoutTheWordCurl(t *testing.T) {
	r := mustParse(t, `-X POST https://x.test/v1 -d 'a=1'`)
	if r.Method != "POST" || r.URL != "https://x.test/v1" {
		t.Errorf("got %s %s", r.Method, r.URL)
	}
}
