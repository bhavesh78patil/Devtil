package mcp

import (
	"encoding/json"
	"encoding/xml"
	"fmt"
	"io"
	"sort"
	"strings"
)

// XML ⇄ JSON conversion using the same convention as the browser tool, so a
// document converted in the UI and one converted by an agent come out
// identical:
//
//	<a x="1">hi</a>          → { "a": { "@x": "1", "#text": "hi" } }
//	<a><b>1</b><b>2</b></a>  → { "a": { "b": ["1", "2"] } }
//	<a>hi</a>                → { "a": "hi" }

type xmlNode struct {
	name     string
	attrs    []xml.Attr
	text     strings.Builder
	children []*xmlNode
}

func xmlToJSON(src string, indent int) (string, error) {
	dec := xml.NewDecoder(strings.NewReader(strings.TrimSpace(src)))
	dec.Strict = false // tolerate the unescaped entities real documents carry

	var root *xmlNode
	var stack []*xmlNode
	for {
		tok, err := dec.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			return "", fmt.Errorf("invalid XML: %w", err)
		}
		switch t := tok.(type) {
		case xml.StartElement:
			n := &xmlNode{name: elemName(t.Name), attrs: t.Attr}
			if len(stack) == 0 {
				if root != nil {
					return "", fmt.Errorf("invalid XML: more than one root element")
				}
				root = n
			} else {
				parent := stack[len(stack)-1]
				parent.children = append(parent.children, n)
			}
			stack = append(stack, n)
		case xml.EndElement:
			if len(stack) == 0 {
				return "", fmt.Errorf("invalid XML: unexpected </%s>", elemName(t.Name))
			}
			stack = stack[:len(stack)-1]
		case xml.CharData:
			if len(stack) > 0 {
				stack[len(stack)-1].text.Write(t)
			}
		}
	}
	if root == nil {
		return "", fmt.Errorf("invalid XML: no root element found")
	}

	out := map[string]any{root.name: nodeValue(root)}
	var data []byte
	var err error
	if indent > 0 {
		data, err = json.MarshalIndent(out, "", strings.Repeat(" ", indent))
	} else {
		data, err = json.Marshal(out)
	}
	if err != nil {
		return "", err
	}
	return string(data), nil
}

func elemName(n xml.Name) string {
	// Namespace prefixes are lost by encoding/xml's resolution, so use the
	// local name — the same thing the browser's DOMParser path reports for
	// an unprefixed document.
	return n.Local
}

func nodeValue(n *xmlNode) any {
	attrs := map[string]any{}
	for _, a := range n.attrs {
		if a.Name.Local == "xmlns" || a.Name.Space == "xmlns" {
			continue
		}
		attrs["@"+a.Name.Local] = a.Value
	}
	text := strings.TrimSpace(n.text.String())
	if len(n.children) == 0 && len(attrs) == 0 {
		return text
	}

	obj := map[string]any{}
	for k, v := range attrs {
		obj[k] = v
	}
	for _, ch := range n.children {
		val := nodeValue(ch)
		existing, seen := obj[ch.name]
		switch {
		case !seen:
			obj[ch.name] = val
		default:
			// a repeated tag becomes an array, growing as more arrive
			if arr, isArr := existing.([]any); isArr {
				obj[ch.name] = append(arr, val)
			} else {
				obj[ch.name] = []any{existing, val}
			}
		}
	}
	if text != "" {
		obj["#text"] = text
	}
	return obj
}

func jsonToXML(src string, indent int) (string, error) {
	var doc any
	if err := json.Unmarshal([]byte(src), &doc); err != nil {
		return "", fmt.Errorf("invalid JSON: %s", describeJSONError(src, err))
	}
	obj, ok := doc.(map[string]any)
	if !ok {
		return "", fmt.Errorf("JSON must be an object with a single root element")
	}
	step := strings.Repeat(" ", max(indent, 0))

	var roots []string
	for _, k := range sortedKeys(obj) {
		if !strings.HasPrefix(k, "@") && k != "#text" {
			roots = append(roots, k)
		}
	}
	var body string
	if len(roots) == 1 {
		body = valueToXML(roots[0], obj[roots[0]], "", step)
	} else {
		// multiple top-level keys have no single root to become; wrap them
		body = valueToXML("root", obj, "", step)
	}
	return `<?xml version="1.0" encoding="UTF-8"?>` + "\n" + body, nil
}

func valueToXML(key string, val any, pad, step string) string {
	if arr, ok := val.([]any); ok {
		parts := make([]string, 0, len(arr))
		for _, item := range arr {
			parts = append(parts, valueToXML(key, item, pad, step))
		}
		return strings.Join(parts, "\n")
	}
	obj, isObj := val.(map[string]any)
	if !isObj {
		t := ""
		if val != nil {
			t = xmlEscape(scalarString(val))
		}
		if t == "" {
			return fmt.Sprintf("%s<%s/>", pad, key)
		}
		return fmt.Sprintf("%s<%s>%s</%s>", pad, key, t, key)
	}

	var attrs []string
	var text string
	var children [][2]any
	for _, k := range sortedKeys(obj) {
		switch {
		case strings.HasPrefix(k, "@"):
			attrs = append(attrs, fmt.Sprintf(`%s="%s"`, k[1:], xmlAttrEscape(scalarString(obj[k]))))
		case k == "#text":
			text = xmlEscape(scalarString(obj[k]))
		default:
			children = append(children, [2]any{k, obj[k]})
		}
	}
	sort.SliceStable(attrs, func(i, j int) bool { return attrs[i] < attrs[j] })
	a := ""
	if len(attrs) > 0 {
		a = " " + strings.Join(attrs, " ")
	}
	if len(children) == 0 {
		if text == "" {
			return fmt.Sprintf("%s<%s%s/>", pad, key, a)
		}
		return fmt.Sprintf("%s<%s%s>%s</%s>", pad, key, a, text, key)
	}
	inner := make([]string, 0, len(children))
	for _, c := range children {
		inner = append(inner, valueToXML(c[0].(string), c[1], pad+step, step))
	}
	textLine := ""
	if text != "" {
		textLine = "\n" + pad + step + text
	}
	return fmt.Sprintf("%s<%s%s>%s\n%s\n%s</%s>", pad, key, a, textLine, strings.Join(inner, "\n"), pad, key)
}

func scalarString(v any) string {
	switch x := v.(type) {
	case nil:
		return ""
	case string:
		return x
	case bool:
		if x {
			return "true"
		}
		return "false"
	case float64:
		if x == float64(int64(x)) {
			return fmt.Sprintf("%d", int64(x))
		}
		return fmt.Sprintf("%g", x)
	}
	b, _ := json.Marshal(v)
	return string(b)
}

var xmlEscaper = strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;")
var xmlAttrEscaper = strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", `"`, "&quot;")

func xmlEscape(s string) string     { return xmlEscaper.Replace(s) }
func xmlAttrEscape(s string) string { return xmlAttrEscaper.Replace(s) }
