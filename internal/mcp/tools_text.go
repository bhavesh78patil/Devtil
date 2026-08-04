package mcp

import (
	"bytes"
	"crypto/md5"
	"crypto/rand"
	"crypto/sha1"
	"crypto/sha256"
	"crypto/sha512"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/bhavesh78patil/devtil/internal/jsonpath"
)

// The text tools run entirely in-process: no network, no credentials, no
// side effects. They are the ones an agent reaches for constantly while
// writing code, so they are all marked read-only and can be auto-approved.

func (s *Server) registerText() {
	s.register(&Tool{
		Name:        "json_format",
		Title:       "Format / validate JSON",
		Description: "Validate JSON and return it pretty-printed, minified, or with object keys sorted. Reports the line and column of a syntax error.",
		ReadOnly:    true,
		Schema: obj(map[string]any{
			"json":   str("The JSON text to process."),
			"mode":   enum("pretty (default), minify, sort_keys, or validate.", "pretty", "minify", "sort_keys", "validate"),
			"indent": num("Spaces per indent level for pretty output (default 2)."),
		}, "json"),
		Run: func(a Args) (any, error) {
			src, err := a.Require("json")
			if err != nil {
				return nil, err
			}
			var doc any
			if err := json.Unmarshal([]byte(src), &doc); err != nil {
				return nil, fmt.Errorf("invalid JSON: %s", describeJSONError(src, err))
			}
			indent := a.Int("indent", 2)
			switch a.Str("mode") {
			case "validate":
				return map[string]any{"valid": true, "bytes": len(src)}, nil
			case "minify":
				out, err := json.Marshal(doc)
				if err != nil {
					return nil, err
				}
				return string(out), nil
			case "sort_keys":
				// encoding/json marshals map keys in sorted order, so a
				// round-trip through `any` is the sort.
				out, err := json.MarshalIndent(doc, "", strings.Repeat(" ", indent))
				if err != nil {
					return nil, err
				}
				return string(out), nil
			default:
				var buf bytes.Buffer
				if err := json.Indent(&buf, []byte(src), "", strings.Repeat(" ", indent)); err != nil {
					return nil, err
				}
				return buf.String(), nil
			}
		},
	})

	s.register(&Tool{
		Name:  "jsonpath_query",
		Title: "Evaluate a JSONPath expression",
		Description: "Run a JSONPath expression over a JSON document. Supports $.a.b, [*], unions [0,2], " +
			"slices [1:3], recursive descent $..name, and filters like [?(@.price < 10 && @.category == 'fiction')] " +
			"including regex with =~ /pattern/i.",
		ReadOnly: true,
		Schema: obj(map[string]any{
			"json": str("The JSON document to query."),
			"path": str("The JSONPath expression, e.g. $..book[?(@.price < 10)].title"),
			"mode": enum("values (default), paths, or both.", "values", "paths", "both"),
		}, "json", "path"),
		Run: func(a Args) (any, error) {
			src, err := a.Require("json")
			if err != nil {
				return nil, err
			}
			expr, err := a.Require("path")
			if err != nil {
				return nil, err
			}
			var doc any
			if err := json.Unmarshal([]byte(src), &doc); err != nil {
				return nil, fmt.Errorf("invalid JSON: %s", describeJSONError(src, err))
			}
			hits, err := jsonpath.Eval(doc, expr)
			if err != nil {
				return nil, fmt.Errorf("invalid JSONPath: %w", err)
			}
			res := map[string]any{"matches": len(hits)}
			switch a.Str("mode") {
			case "paths":
				paths := make([]string, 0, len(hits))
				for _, h := range hits {
					paths = append(paths, h.Path)
				}
				res["paths"] = paths
			case "both":
				res["results"] = hits
			default:
				values := make([]any, 0, len(hits))
				for _, h := range hits {
					values = append(values, h.Value)
				}
				res["values"] = values
			}
			return res, nil
		},
	})

	s.register(&Tool{
		Name:        "xml_to_json",
		Title:       "Convert XML to JSON",
		Description: `Convert an XML document to JSON. Attributes become "@name" keys, element text becomes "#text", and repeated child tags become arrays.`,
		ReadOnly:    true,
		Schema: obj(map[string]any{
			"xml":    str("The XML document."),
			"indent": num("Spaces per indent level (default 2)."),
		}, "xml"),
		Run: func(a Args) (any, error) {
			src, err := a.Require("xml")
			if err != nil {
				return nil, err
			}
			return xmlToJSON(src, a.Int("indent", 2))
		},
	})

	s.register(&Tool{
		Name:        "json_to_xml",
		Title:       "Convert JSON to XML",
		Description: `Convert JSON to XML using the inverse convention: "@name" keys become attributes, "#text" becomes element text, arrays repeat their tag. The JSON must be an object.`,
		ReadOnly:    true,
		Schema: obj(map[string]any{
			"json":   str("The JSON object to convert."),
			"indent": num("Spaces per indent level (default 2)."),
		}, "json"),
		Run: func(a Args) (any, error) {
			src, err := a.Require("json")
			if err != nil {
				return nil, err
			}
			return jsonToXML(src, a.Int("indent", 2))
		},
	})

	s.register(&Tool{
		Name:        "base64",
		Title:       "Base64 encode / decode",
		Description: "Encode text to Base64 or decode Base64 back to text. Supports the URL-safe alphabet.",
		ReadOnly:    true,
		Schema: obj(map[string]any{
			"text":      str("The text to encode, or the Base64 to decode."),
			"mode":      enum("encode (default) or decode.", "encode", "decode"),
			"urlSafe":   boolean("Use the URL-safe alphabet (-_ instead of +/)."),
			"noPadding": boolean("Omit '=' padding when encoding."),
		}, "text"),
		Run: func(a Args) (any, error) {
			text, err := a.Require("text")
			if err != nil {
				return nil, err
			}
			enc := base64Encoding(a.Bool("urlSafe", false), a.Bool("noPadding", false))
			if a.Str("mode") == "decode" {
				out, err := decodeBase64Flexible(text)
				if err != nil {
					return nil, fmt.Errorf("not valid Base64: %w", err)
				}
				return string(out), nil
			}
			return enc.EncodeToString([]byte(text)), nil
		},
	})

	s.register(&Tool{
		Name:        "url_encode",
		Title:       "URL encode / decode",
		Description: "Percent-encode or decode text, or parse a URL into its parts and query parameters.",
		ReadOnly:    true,
		Schema: obj(map[string]any{
			"text": str("The text or URL."),
			"mode": enum("encode (default), decode, or parse (split a URL into scheme/host/path/query).", "encode", "decode", "parse"),
		}, "text"),
		Run: func(a Args) (any, error) {
			text, err := a.Require("text")
			if err != nil {
				return nil, err
			}
			switch a.Str("mode") {
			case "decode":
				out, err := url.QueryUnescape(text)
				if err != nil {
					return nil, err
				}
				return out, nil
			case "parse":
				u, err := url.Parse(text)
				if err != nil {
					return nil, err
				}
				q := map[string]any{}
				for k, v := range u.Query() {
					if len(v) == 1 {
						q[k] = v[0]
					} else {
						q[k] = v
					}
				}
				return map[string]any{
					"scheme": u.Scheme, "host": u.Host, "path": u.Path,
					"fragment": u.Fragment, "query": q,
				}, nil
			default:
				return url.QueryEscape(text), nil
			}
		},
	})

	s.register(&Tool{
		Name:        "jwt_decode",
		Title:       "Decode a JWT",
		Description: "Decode a JSON Web Token's header and payload and report expiry. The signature is NOT verified — this is for inspection only.",
		ReadOnly:    true,
		Schema:      obj(map[string]any{"token": str("The JWT, with or without a 'Bearer ' prefix.")}, "token"),
		Run: func(a Args) (any, error) {
			tok, err := a.Require("token")
			if err != nil {
				return nil, err
			}
			return decodeJWT(tok)
		},
	})

	s.register(&Tool{
		Name:        "hash_text",
		Title:       "Hash text",
		Description: "Compute MD5, SHA-1, SHA-256 or SHA-512 of a string. Use for checksums and fingerprints, not for storing passwords.",
		ReadOnly:    true,
		Schema: obj(map[string]any{
			"text":      str("The text to hash."),
			"algorithm": enum("sha256 (default), md5, sha1 or sha512.", "sha256", "md5", "sha1", "sha512"),
		}, "text"),
		Run: func(a Args) (any, error) {
			text, err := a.Require("text")
			if err != nil {
				return nil, err
			}
			algo := strings.ToLower(a.Str("algorithm"))
			if algo == "" {
				algo = "sha256"
			}
			var sum []byte
			switch algo {
			case "md5":
				h := md5.Sum([]byte(text))
				sum = h[:]
			case "sha1":
				h := sha1.Sum([]byte(text))
				sum = h[:]
			case "sha512":
				h := sha512.Sum512([]byte(text))
				sum = h[:]
			case "sha256":
				h := sha256.Sum256([]byte(text))
				sum = h[:]
			default:
				return nil, fmt.Errorf("unknown algorithm %q (md5, sha1, sha256, sha512)", algo)
			}
			return map[string]any{
				"algorithm": algo,
				"hex":       hex.EncodeToString(sum),
				"base64":    base64.StdEncoding.EncodeToString(sum),
			}, nil
		},
	})

	s.register(&Tool{
		Name:        "uuid_generate",
		Title:       "Generate UUIDs",
		Description: "Generate one or more random (version 4) UUIDs.",
		ReadOnly:    true,
		Schema: obj(map[string]any{
			"count":     num("How many to generate (default 1, max 100)."),
			"uppercase": boolean("Return uppercase hex."),
		}),
		Run: func(a Args) (any, error) {
			n := a.Int("count", 1)
			if n < 1 {
				n = 1
			}
			if n > 100 {
				n = 100
			}
			out := make([]string, 0, n)
			for i := 0; i < n; i++ {
				u, err := uuidV4()
				if err != nil {
					return nil, err
				}
				if a.Bool("uppercase", false) {
					u = strings.ToUpper(u)
				}
				out = append(out, u)
			}
			return map[string]any{"uuids": out}, nil
		},
	})

	s.register(&Tool{
		Name:        "timestamp_convert",
		Title:       "Convert timestamps",
		Description: "Convert between epoch seconds/milliseconds and human-readable dates. With no input, returns the current time in every format.",
		ReadOnly:    true,
		Schema: obj(map[string]any{
			"value":    str("An epoch (seconds or milliseconds) or a date string such as 2026-08-01T09:30:00Z. Omit for 'now'."),
			"timezone": str("IANA timezone for the local rendering, e.g. Europe/London (default UTC)."),
		}),
		Run: func(a Args) (any, error) {
			return convertTimestamp(strings.TrimSpace(a.Str("value")), a.Str("timezone"))
		},
	})

	s.register(&Tool{
		Name:        "regex_test",
		Title:       "Test a regular expression",
		Description: "Run a Go/RE2 regular expression against text and return every match with its capture groups and offsets.",
		ReadOnly:    true,
		Schema: obj(map[string]any{
			"pattern":    str("The regular expression."),
			"text":       str("The text to search."),
			"ignoreCase": boolean("Case-insensitive matching."),
			"multiline":  boolean("^ and $ match at line boundaries."),
			"limit":      num("Maximum matches to return (default 100)."),
		}, "pattern", "text"),
		Run: func(a Args) (any, error) {
			pat, err := a.Require("pattern")
			if err != nil {
				return nil, err
			}
			var flags string
			if a.Bool("ignoreCase", false) {
				flags += "i"
			}
			if a.Bool("multiline", false) {
				flags += "m"
			}
			if flags != "" {
				pat = "(?" + flags + ")" + pat
			}
			re, err := regexp.Compile(pat)
			if err != nil {
				return nil, fmt.Errorf("invalid regex: %w", err)
			}
			text := a.Str("text")
			limit := a.Int("limit", 100)
			if limit <= 0 {
				limit = 100
			}
			idx := re.FindAllStringSubmatchIndex(text, limit)
			matches := make([]any, 0, len(idx))
			for _, m := range idx {
				groups := make([]any, 0, len(m)/2-1)
				for g := 1; g < len(m)/2; g++ {
					if m[2*g] < 0 {
						groups = append(groups, nil)
						continue
					}
					groups = append(groups, text[m[2*g]:m[2*g+1]])
				}
				matches = append(matches, map[string]any{
					"match":  text[m[0]:m[1]],
					"start":  m[0],
					"end":    m[1],
					"groups": groups,
				})
			}
			return map[string]any{
				"matches":    matches,
				"count":      len(matches),
				"groupNames": re.SubexpNames()[1:],
			}, nil
		},
	})
}

// ------------------------------------------------------------- helpers

func base64Encoding(urlSafe, noPad bool) *base64.Encoding {
	enc := base64.StdEncoding
	if urlSafe {
		enc = base64.URLEncoding
	}
	if noPad {
		enc = enc.WithPadding(base64.NoPadding)
	}
	return enc
}

// decodeBase64Flexible accepts padded or unpadded input in either alphabet,
// which is what real-world tokens and payloads look like.
func decodeBase64Flexible(s string) ([]byte, error) {
	s = strings.TrimSpace(s)
	s = strings.NewReplacer("\n", "", "\r", "", " ", "").Replace(s)
	candidates := []*base64.Encoding{
		base64.StdEncoding, base64.URLEncoding,
		base64.RawStdEncoding, base64.RawURLEncoding,
	}
	var lastErr error
	for _, enc := range candidates {
		if out, err := enc.DecodeString(s); err == nil {
			return out, nil
		} else {
			lastErr = err
		}
	}
	return nil, lastErr
}

func uuidV4() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	b[6] = (b[6] & 0x0f) | 0x40 // version 4
	b[8] = (b[8] & 0x3f) | 0x80 // variant 10
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16]), nil
}

func decodeJWT(tok string) (any, error) {
	tok = strings.TrimSpace(tok)
	tok = strings.TrimPrefix(tok, "Bearer ")
	tok = strings.TrimPrefix(tok, "bearer ")
	parts := strings.Split(strings.TrimSpace(tok), ".")
	if len(parts) < 2 {
		return nil, fmt.Errorf("not a JWT: expected at least header.payload")
	}
	decode := func(seg, what string) (map[string]any, error) {
		raw, err := decodeBase64Flexible(seg)
		if err != nil {
			return nil, fmt.Errorf("%s is not valid base64url: %w", what, err)
		}
		var m map[string]any
		if err := json.Unmarshal(raw, &m); err != nil {
			return nil, fmt.Errorf("%s is not JSON: %w", what, err)
		}
		return m, nil
	}
	header, err := decode(parts[0], "header")
	if err != nil {
		return nil, err
	}
	payload, err := decode(parts[1], "payload")
	if err != nil {
		return nil, err
	}

	out := map[string]any{
		"header":  header,
		"payload": payload,
		// Stated plainly so a model never reports a token as trustworthy:
		// devtil decodes, it does not verify.
		"signatureVerified": false,
		"note":              "The signature is not verified. Treat claims as unauthenticated input.",
	}
	if len(parts) > 2 {
		out["signature"] = parts[2]
	}
	if exp, ok := payload["exp"].(float64); ok {
		t := time.Unix(int64(exp), 0).UTC()
		out["expiresAt"] = t.Format(time.RFC3339)
		out["expired"] = time.Now().After(t)
	}
	if iat, ok := payload["iat"].(float64); ok {
		out["issuedAt"] = time.Unix(int64(iat), 0).UTC().Format(time.RFC3339)
	}
	return out, nil
}

func convertTimestamp(value, tz string) (any, error) {
	loc := time.UTC
	if strings.TrimSpace(tz) != "" {
		l, err := time.LoadLocation(tz)
		if err != nil {
			return nil, fmt.Errorf("unknown timezone %q: %w", tz, err)
		}
		loc = l
	}

	var t time.Time
	switch {
	case value == "":
		t = time.Now()
	default:
		if n, err := strconv.ParseInt(value, 10, 64); err == nil {
			// 10 digits is seconds, 13 is milliseconds; anything longer is
			// micro/nanoseconds. Guess by magnitude rather than by length so
			// pre-2001 timestamps still work.
			switch {
			case n > 1e17:
				t = time.Unix(0, n)
			case n > 1e14:
				t = time.UnixMicro(n)
			case n > 1e11:
				t = time.UnixMilli(n)
			default:
				t = time.Unix(n, 0)
			}
		} else {
			layouts := []string{
				time.RFC3339Nano, time.RFC3339, "2006-01-02T15:04:05",
				"2006-01-02 15:04:05", "2006-01-02", time.RFC1123, time.RFC822,
			}
			var perr error
			for _, l := range layouts {
				if parsed, err := time.ParseInLocation(l, value, loc); err == nil {
					t = parsed
					perr = nil
					break
				} else {
					perr = err
				}
			}
			if t.IsZero() {
				return nil, fmt.Errorf("could not parse %q as an epoch or a date: %v", value, perr)
			}
		}
	}

	return map[string]any{
		"epochSeconds":      t.Unix(),
		"epochMilliseconds": t.UnixMilli(),
		"utc":               t.UTC().Format(time.RFC3339),
		"local":             t.In(loc).Format(time.RFC3339),
		"timezone":          loc.String(),
		"relative":          humanizeSince(t),
	}, nil
}

func humanizeSince(t time.Time) string {
	d := time.Since(t)
	suffix := "ago"
	if d < 0 {
		d, suffix = -d, "from now"
	}
	switch {
	case d < time.Minute:
		return fmt.Sprintf("%ds %s", int(d.Seconds()), suffix)
	case d < time.Hour:
		return fmt.Sprintf("%dm %s", int(d.Minutes()), suffix)
	case d < 24*time.Hour:
		return fmt.Sprintf("%dh %s", int(d.Hours()), suffix)
	default:
		return fmt.Sprintf("%dd %s", int(d.Hours()/24), suffix)
	}
}

// describeJSONError turns encoding/json's byte offset into a line and column,
// which is what a developer (or a model fixing the document) actually needs.
func describeJSONError(src string, err error) string {
	var offset int64 = -1
	switch e := err.(type) {
	case *json.SyntaxError:
		offset = e.Offset
	case *json.UnmarshalTypeError:
		offset = e.Offset
	}
	if offset < 0 || int(offset) > len(src) {
		return err.Error()
	}
	before := src[:offset]
	line := strings.Count(before, "\n") + 1
	col := int(offset) - strings.LastIndex(before, "\n")
	return fmt.Sprintf("%s (line %d, column %d)", err.Error(), line, col)
}

// sortedKeys is used by the XML writer to keep output stable.
func sortedKeys(m map[string]any) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}
