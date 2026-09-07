package proxy

import (
	"fmt"
	"strings"
)

// Every API you ever have to call arrives as a curl command — in a README, a
// Slack message, the "copy as cURL" button in a browser's network tab. Retyping
// one into a form is tedious and error-prone, so paste it instead.

// CurlRequest is a curl command turned into something the API client can save.
type CurlRequest struct {
	Method   string            `json:"method"`
	URL      string            `json:"url"`
	Headers  map[string]string `json:"headers"`
	Body     string            `json:"body"`
	Insecure bool              `json:"insecure"`
	// Username/Password come from -u and are turned into Basic auth by the
	// caller, so the credentials live in the request's auth block rather than
	// being baked into a header the developer cannot see.
	Username string `json:"username,omitempty"`
	Password string `json:"password,omitempty"`
	// Warnings names flags that were recognised but could not be represented.
	// Silently dropping them would produce a request that looks right and
	// behaves differently.
	Warnings []string `json:"warnings,omitempty"`
}

// ParseCurl reads a curl command line. It accepts what people actually paste:
// line continuations, single or double quotes, $'…' strings, and flags in
// either short or long form.
func ParseCurl(text string) (*CurlRequest, error) {
	args, err := splitCurl(text)
	if err != nil {
		return nil, err
	}
	if len(args) == 0 {
		return nil, fmt.Errorf("nothing to parse")
	}
	if strings.EqualFold(args[0], "curl") {
		args = args[1:]
	}

	out := &CurlRequest{Headers: map[string]string{}}
	var bodyParts []string
	methodSet := false
	seen := map[string]bool{}

	next := func(i *int, flag string) (string, error) {
		if *i+1 >= len(args) {
			return "", fmt.Errorf("%s needs a value", flag)
		}
		*i++
		return args[*i], nil
	}

	for i := 0; i < len(args); i++ {
		a := args[i]
		// --flag=value is the same as --flag value
		if strings.HasPrefix(a, "--") && strings.Contains(a, "=") {
			eq := strings.Index(a, "=")
			flag, val := a[:eq], a[eq+1:]
			args = append(args[:i], append([]string{flag, val}, args[i+1:]...)...)
			a = flag
		}
		switch a {
		case "-X", "--request":
			v, err := next(&i, a)
			if err != nil {
				return nil, err
			}
			out.Method = strings.ToUpper(v)
			methodSet = true
		case "-H", "--header":
			v, err := next(&i, a)
			if err != nil {
				return nil, err
			}
			if k, val, ok := strings.Cut(v, ":"); ok {
				k = strings.TrimSpace(k)
				if k != "" {
					out.Headers[k] = strings.TrimSpace(val)
				}
			}
		case "-d", "--data", "--data-raw", "--data-ascii", "--data-binary", "--data-urlencode":
			v, err := next(&i, a)
			if err != nil {
				return nil, err
			}
			if strings.HasPrefix(v, "@") {
				out.Warnings = append(out.Warnings, fmt.Sprintf("%s @file reads a local file — paste the body instead", a))
				continue
			}
			bodyParts = append(bodyParts, v)
		case "-u", "--user":
			v, err := next(&i, a)
			if err != nil {
				return nil, err
			}
			user, pass, _ := strings.Cut(v, ":")
			out.Username, out.Password = user, pass
		case "-b", "--cookie":
			v, err := next(&i, a)
			if err != nil {
				return nil, err
			}
			out.Headers["Cookie"] = v
		case "-A", "--user-agent":
			v, err := next(&i, a)
			if err != nil {
				return nil, err
			}
			out.Headers["User-Agent"] = v
		case "-e", "--referer":
			v, err := next(&i, a)
			if err != nil {
				return nil, err
			}
			out.Headers["Referer"] = v
		case "--url":
			v, err := next(&i, a)
			if err != nil {
				return nil, err
			}
			out.URL = v
		case "-k", "--insecure":
			out.Insecure = true
		case "-G", "--get":
			out.Method = "GET"
			methodSet = true
			out.Warnings = append(out.Warnings, "-G moves the data onto the query string; check the URL")
		case "-I", "--head":
			out.Method = "HEAD"
			methodSet = true
		// flags that change nothing we model — skipping them silently is right
		case "-s", "--silent", "-S", "--show-error", "-L", "--location", "--compressed",
			"-f", "--fail", "-v", "--verbose", "-i", "--include", "-#", "--progress-bar",
			"--no-progress-meter", "-q", "--disable", "--http1.1", "--http2":
			// no-op
		case "-o", "--output", "-w", "--write-out", "--max-time", "-m", "--connect-timeout",
			"--retry", "--cacert", "--cert", "--key", "--proxy", "-x":
			// consume the value so it is not mistaken for the URL
			if _, err := next(&i, a); err != nil {
				return nil, err
			}
			if !seen[a] {
				seen[a] = true
				out.Warnings = append(out.Warnings, a+" is not applied")
			}
		case "-F", "--form":
			v, err := next(&i, a)
			if err != nil {
				return nil, err
			}
			out.Warnings = append(out.Warnings, "multipart form field dropped: "+v)
		default:
			if strings.HasPrefix(a, "-") && a != "-" {
				out.Warnings = append(out.Warnings, "ignored flag "+a)
				continue
			}
			if out.URL == "" {
				out.URL = a
			}
		}
	}

	if out.URL == "" {
		return nil, fmt.Errorf("no URL found in the command")
	}
	// curl tolerates a bare host; the proxy requires a scheme
	if !strings.HasPrefix(strings.ToLower(out.URL), "http://") && !strings.HasPrefix(strings.ToLower(out.URL), "https://") {
		out.URL = "https://" + out.URL
	}
	out.Body = strings.Join(bodyParts, "&")
	if !methodSet {
		// curl's own rule: data implies POST
		if out.Body != "" {
			out.Method = "POST"
		} else {
			out.Method = "GET"
		}
	}
	return out, nil
}

// splitCurl tokenises a shell-ish command line. It is not a shell — it
// understands quoting, escapes and line continuations, which is all a pasted
// curl command needs.
func splitCurl(text string) ([]string, error) {
	var args []string
	var cur strings.Builder
	started := false
	runes := []rune(text)

	flush := func() {
		if started {
			args = append(args, cur.String())
			cur.Reset()
			started = false
		}
	}

	for i := 0; i < len(runes); i++ {
		c := runes[i]
		switch c {
		case '\\':
			// a backslash at end of line is a continuation, not an escape
			j := i + 1
			for j < len(runes) && (runes[j] == ' ' || runes[j] == '\t' || runes[j] == '\r') {
				j++
			}
			if j < len(runes) && runes[j] == '\n' {
				i = j
				continue
			}
			if i+1 < len(runes) {
				i++
				cur.WriteRune(runes[i])
				started = true
			}
		case ' ', '\t', '\n', '\r':
			flush()
		case '\'':
			started = true
			// $'…' allows escapes; a plain '…' is literal
			ansiC := cur.Len() > 0 && strings.HasSuffix(cur.String(), "$")
			if ansiC {
				s := cur.String()
				cur.Reset()
				cur.WriteString(s[:len(s)-1])
			}
			i++
			for i < len(runes) && runes[i] != '\'' {
				if ansiC && runes[i] == '\\' && i+1 < len(runes) {
					i++
					switch runes[i] {
					case 'n':
						cur.WriteRune('\n')
					case 't':
						cur.WriteRune('\t')
					case 'r':
						cur.WriteRune('\r')
					default:
						cur.WriteRune(runes[i])
					}
					i++
					continue
				}
				cur.WriteRune(runes[i])
				i++
			}
			if i >= len(runes) {
				return nil, fmt.Errorf("unclosed single quote")
			}
		case '"':
			started = true
			i++
			for i < len(runes) && runes[i] != '"' {
				if runes[i] == '\\' && i+1 < len(runes) {
					i++
					// inside double quotes a backslash only escapes a few things
					switch runes[i] {
					case '"', '\\', '$', '`':
						cur.WriteRune(runes[i])
					case '\n':
						// continuation
					case 'n':
						cur.WriteRune('\n')
					default:
						cur.WriteRune('\\')
						cur.WriteRune(runes[i])
					}
					i++
					continue
				}
				cur.WriteRune(runes[i])
				i++
			}
			if i >= len(runes) {
				return nil, fmt.Errorf("unclosed double quote")
			}
		default:
			cur.WriteRune(c)
			started = true
		}
	}
	flush()
	return args, nil
}
