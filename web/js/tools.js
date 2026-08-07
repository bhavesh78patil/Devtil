/* Devtil tools. Each tool renders into a tab and stores everything it needs
   in tab.data, which is autosaved by the app shell via ctx.save(). */
"use strict";

(() => {
  const { registerTool, el, escapeHtml, debounce, uid, fmtBytes, copyBtn, setStatus, api, confirmDialog, promptDialog, onSessionSweep } = Devtil;

  // How long a tool keeps a tab's live sessions (SSH PTYs, Kube tail loops)
  // alive after that tab is closed, before tearing them down.
  const SESSION_TTL_MS = 5 * 60 * 1000;

  /** Full-screen overlay showing text JSON pretty-printed (falls back to raw). */
  function showJsonModal(title, raw) {
    let pretty = raw == null ? "" : String(raw);
    try { pretty = JSON.stringify(JSON.parse(raw), null, 2); } catch { /* not JSON */ }
    const overlay = el("div", { class: "json-modal-overlay" });
    const pre = el("pre", { class: "output", style: "flex:1;overflow:auto;margin:0" });
    pre.textContent = pretty;
    const close = () => overlay.remove();
    overlay.append(el("div", { class: "json-modal" }, [
      el("div", { class: "json-modal-head" }, [
        el("span", { class: "json-modal-title", text: title }),
        copyBtn(() => pretty, "Copy"),
        el("button", { class: "icon-btn", text: "×", title: "Close (Esc)", onclick: close }),
      ]),
      pre,
    ]));
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
    const onKey = (e) => { if (e.key === "Escape") { close(); document.removeEventListener("keydown", onKey); } };
    document.addEventListener("keydown", onKey);
    document.body.appendChild(overlay);
  }

  /** Full-screen modal with inner tabs. tabs: [{label, build: () => Node}]. */
  function showTabsModal(title, tabs) {
    const overlay = el("div", { class: "json-modal-overlay" });
    const bodyBox = el("div", { style: "flex:1;overflow:auto;display:flex;flex-direction:column;min-height:0;gap:6px" });
    let active = 0;
    const close = () => { overlay.remove(); document.removeEventListener("keydown", onKey); };
    const onKey = (e) => { if (e.key === "Escape") close(); };
    const tabBar = el("div", { class: "subtabs" }, tabs.map((t, i) =>
      el("button", { class: i === active ? "active" : "", text: t.label, onclick: () => { active = i; sync(); } })
    ));
    const sync = () => {
      [...tabBar.children].forEach((b, i) => { b.className = i === active ? "active" : ""; });
      bodyBox.replaceChildren(tabs[active].build());
    };
    overlay.append(el("div", { class: "json-modal" }, [
      el("div", { class: "json-modal-head" }, [
        el("span", { class: "json-modal-title", text: title }),
        el("button", { class: "icon-btn", text: "×", title: "Close (Esc)", onclick: close }),
      ]),
      tabBar,
      bodyBox,
    ]));
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
    document.addEventListener("keydown", onKey);
    document.body.appendChild(overlay);
    sync();
  }

  /** textarea bound to data[key]: saves on input, optional onInput hook */
  function boundArea(data, key, ctx, attrs = {}, onInput) {
    const area = el("textarea", { class: "grow", spellcheck: "false", ...attrs });
    area.value = data[key] || "";
    area.addEventListener("input", () => {
      data[key] = area.value;
      ctx.save();
      if (onInput) onInput();
    });
    return area;
  }

  /** input/select bound to data[key] */
  function bindField(field, data, key, ctx, onChange) {
    if (data[key] !== undefined) {
      if (field.type === "checkbox") field.checked = !!data[key];
      else field.value = data[key];
    }
    field.addEventListener(field.tagName === "SELECT" || field.type === "checkbox" ? "change" : "input", () => {
      data[key] = field.type === "checkbox" ? field.checked : field.value;
      ctx.save();
      if (onChange) onChange();
    });
    return field;
  }

  // ======================================================================
  // JSON Tools
  // ======================================================================
  registerTool({
    type: "json",
    icon: "{ }",
    name: "JSON Tools",
    desc: "Pretty-format, minify, validate, sort keys, escape & unescape JSON strings.",
    defaults: () => ({ input: "", output: "", indent: "2" }),
    render(root, tab, ctx) {
      const d = tab.data;
      const status = el("div", { class: "status-line dim" });
      const output = el("textarea", { class: "grow", spellcheck: "false", readonly: "" });
      output.value = d.output || "";
      const input = boundArea(d, "input", ctx);

      const indentSel = bindField(
        el("select", {}, [
          el("option", { value: "2", text: "2 spaces" }),
          el("option", { value: "4", text: "4 spaces" }),
          el("option", { value: "tab", text: "Tabs" }),
        ]),
        d, "indent", ctx
      );

      const setOut = (text) => {
        output.value = text;
        d.output = text;
        ctx.save();
      };

      const parse = () => {
        try {
          return { value: JSON.parse(d.input) };
        } catch (e) {
          const m = /position (\d+)/.exec(e.message);
          let where = "";
          if (m) {
            const pos = Number(m[1]);
            const before = d.input.slice(0, pos);
            where = ` (line ${before.split("\n").length}, col ${pos - before.lastIndexOf("\n")})`;
          }
          return { error: e.message + where };
        }
      };
      const indent = () => (d.indent === "tab" ? "\t" : Number(d.indent || 2));

      const act = (fn) => () => {
        const r = parse();
        if (r.error) return setStatus(status, "✗ " + r.error, "err");
        setStatus(status, "✓ Valid JSON", "ok");
        fn(r.value);
      };

      const sortKeys = (v) => {
        if (Array.isArray(v)) return v.map(sortKeys);
        if (v && typeof v === "object") {
          return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
        }
        return v;
      };

      const unescape = () => {
        // Accept either a quoted JSON string or raw text with \" style escapes.
        for (const candidate of [d.input, '"' + d.input + '"']) {
          try {
            const v = JSON.parse(candidate);
            if (typeof v === "string") {
              setStatus(status, "✓ Unescaped", "ok");
              return setOut(v);
            }
          } catch { /* try next */ }
        }
        setStatus(status, "✗ Input is not an escaped JSON string", "err");
      };

      root.append(
        el("div", { class: "toolbar" }, [
          el("button", { class: "btn primary", text: "Format", onclick: act((v) => setOut(JSON.stringify(v, null, indent()))) }),
          el("button", { class: "btn", text: "Minify", onclick: act((v) => setOut(JSON.stringify(v))) }),
          el("button", { class: "btn", text: "Validate", onclick: act(() => {}) }),
          el("button", { class: "btn", text: "Sort keys", onclick: act((v) => setOut(JSON.stringify(sortKeys(v), null, indent()))) }),
          el("button", { class: "btn", text: "Unescape string", onclick: unescape }),
          el("button", {
            class: "btn", text: "Escape as string",
            onclick: () => { setOut(JSON.stringify(d.input)); setStatus(status, "✓ Escaped", "ok"); },
          }),
          indentSel,
          copyBtn(() => output.value, "Copy output"),
          el("button", { class: "btn", text: "Output → Input", onclick: () => { input.value = output.value; d.input = output.value; ctx.save(); } }),
        ]),
        status,
        el("div", { class: "split" }, [
          el("div", {}, [el("span", { class: "pane-label", text: "Input" }), input]),
          el("div", {}, [el("span", { class: "pane-label", text: "Output" }), output]),
        ])
      );
    },
  });

  // ======================================================================
  // JSONPath
  // ======================================================================
  // A dependency-free evaluator for the common JSONPath subset:
  //   $  .key  ['key']  ..key  ..*  *  [*]  [n]  [-n]  [a,b]  [start:end:step]
  //   [?(@.k > 1 && (@.j == 'x' || @.z))]  filters with == != < <= > >= =~
  //   .length on arrays/strings
  // Evaluation returns both the matched values and their normalised paths.

  function jpParse(expr) {
    const s = String(expr).trim();
    if (!s) throw new Error("expression is empty");
    let i = 0;
    const steps = [];
    const isNameChar = (ch) => /[A-Za-z0-9_$\-À-￿]/.test(ch);
    const readName = () => {
      const start = i;
      while (i < s.length && isNameChar(s[i])) i++;
      if (i === start) throw new Error(`expected a property name at position ${start}`);
      return s.slice(start, i);
    };
    const readQuoted = () => {
      const q = s[i++];
      let out = "";
      while (i < s.length && s[i] !== q) {
        if (s[i] === "\\") i++;
        out += s[i++];
      }
      if (s[i] !== q) throw new Error("unterminated quoted name");
      i++;
      return out;
    };

    if (s[i] === "$") i++;
    else if (s[i] === "@") i++;

    while (i < s.length) {
      if (s[i] === ".") {
        if (s[i + 1] === ".") { // recursive descent
          i += 2;
          steps.push({ t: "descend" });
          if (s[i] === "[") continue;         // ..[...] — the bracket handles it
          if (s[i] === "*") { steps.push({ t: "wild" }); i++; continue; }
          steps.push({ t: "child", names: [readName()] });
          continue;
        }
        i++;
        if (s[i] === "*") { steps.push({ t: "wild" }); i++; continue; }
        steps.push({ t: "child", names: [readName()] });
        continue;
      }
      if (s[i] === "[") {
        i++;
        while (s[i] === " ") i++;
        if (s[i] === "*") {
          i++;
          steps.push({ t: "wild" });
        } else if (s[i] === "?") {
          i++;
          if (s[i] !== "(") throw new Error("expected '(' after '?'");
          const start = ++i;
          let depth = 1;
          while (i < s.length && depth > 0) {
            if (s[i] === "(") depth++;
            else if (s[i] === ")") depth--;
            if (depth > 0) i++;
          }
          if (depth !== 0) throw new Error("unterminated filter expression");
          steps.push({ t: "filter", pred: jpCompileFilter(s.slice(start, i)) });
          i++; // past ')'
        } else if (s[i] === "'" || s[i] === '"') {
          const names = [readQuoted()];
          while (s[i] === "," || s[i] === " ") {
            i++;
            while (s[i] === " ") i++;
            if (s[i] === "'" || s[i] === '"') names.push(readQuoted());
          }
          steps.push({ t: "child", names });
        } else {
          // indices, unions and slices
          const start = i;
          while (i < s.length && s[i] !== "]") i++;
          const body = s.slice(start, i).trim();
          if (body.includes(":")) {
            const [a, b, c] = body.split(":");
            steps.push({
              t: "slice",
              start: a.trim() === "" ? null : Number(a),
              end: b === undefined || b.trim() === "" ? null : Number(b),
              step: c === undefined || c.trim() === "" ? 1 : Number(c),
            });
          } else if (body === "") {
            throw new Error("empty []");
          } else {
            const idx = body.split(",").map((x) => {
              const n = Number(x.trim());
              if (!Number.isInteger(n)) throw new Error(`"${x.trim()}" is not an array index`);
              return n;
            });
            steps.push({ t: "index", idx });
          }
        }
        while (s[i] === " ") i++;
        if (s[i] !== "]") throw new Error("expected ']'");
        i++;
        continue;
      }
      if (i === 0 || steps.length === 0) { // tolerate "store.book" without a leading $
        steps.push({ t: "child", names: [readName()] });
        continue;
      }
      throw new Error(`unexpected "${s[i]}" at position ${i}`);
    }
    return steps;
  }

  // ---- filter expressions -------------------------------------------------
  // Recursive descent over: or := and ('||' and)*, and := cmp ('&&' cmp)*,
  // cmp := '(' or ')' | operand [op operand]. No eval() anywhere.
  function jpCompileFilter(src) {
    let i = 0;
    const s = src;
    const ws = () => { while (i < s.length && /\s/.test(s[i])) i++; };

    const parseOperand = () => {
      ws();
      if (s[i] === "@" || s[i] === "$") {
        const start = i;
        i++;
        while (i < s.length && /[.\[\]'"A-Za-z0-9_$\-]/.test(s[i])) {
          if (s[i] === "]" ) { i++; break; }
          i++;
        }
        const path = s.slice(start, i);
        const steps = jpParse(path);
        return (node) => {
          const hits = jpEval(node, steps);
          return hits.length ? hits[0].value : undefined;
        };
      }
      if (s[i] === "'" || s[i] === '"') {
        const q = s[i++];
        let out = "";
        while (i < s.length && s[i] !== q) { if (s[i] === "\\") i++; out += s[i++]; }
        i++;
        return () => out;
      }
      if (s[i] === "/") { // regex literal for =~
        const start = ++i;
        while (i < s.length && s[i] !== "/") { if (s[i] === "\\") i++; i++; }
        const body = s.slice(start, i);
        i++;
        let flags = "";
        while (i < s.length && /[a-z]/.test(s[i])) flags += s[i++];
        const re = new RegExp(body, flags);
        return () => re;
      }
      const start = i;
      while (i < s.length && /[^\s&|)=!<>~]/.test(s[i])) i++;
      const lit = s.slice(start, i).trim();
      if (lit === "true") return () => true;
      if (lit === "false") return () => false;
      if (lit === "null") return () => null;
      const n = Number(lit);
      if (lit !== "" && !isNaN(n)) return () => n;
      return () => lit;
    };

    const parseCmp = () => {
      ws();
      if (s[i] === "(") {
        i++;
        const inner = parseOr();
        ws();
        if (s[i] !== ")") throw new Error("expected ')' in filter");
        i++;
        return inner;
      }
      const left = parseOperand();
      ws();
      const ops = ["==", "!=", "<=", ">=", "=~", "<", ">"];
      const op = ops.find((o) => s.startsWith(o, i));
      if (!op) return (node) => { // bare @.field — an existence test
        const v = left(node);
        return v !== undefined && v !== false && v !== null;
      };
      i += op.length;
      const right = parseOperand();
      return (node) => {
        const a = left(node), b = right(node);
        switch (op) {
          case "==": return a == b; // eslint-disable-line eqeqeq — JSONPath is loose
          case "!=": return a != b; // eslint-disable-line eqeqeq
          case "<": return a < b;
          case "<=": return a <= b;
          case ">": return a > b;
          case ">=": return a >= b;
          case "=~": return b instanceof RegExp && typeof a === "string" && b.test(a);
        }
        return false;
      };
    };

    const parseAnd = () => {
      let left = parseCmp();
      for (;;) {
        ws();
        if (!s.startsWith("&&", i)) return left;
        i += 2;
        const right = parseCmp();
        const l = left;
        left = (node) => l(node) && right(node);
      }
    };
    const parseOr = () => {
      let left = parseAnd();
      for (;;) {
        ws();
        if (!s.startsWith("||", i)) return left;
        i += 2;
        const right = parseAnd();
        const l = left;
        left = (node) => l(node) || right(node);
      }
    };

    const pred = parseOr();
    ws();
    if (i < s.length) throw new Error(`unexpected "${s[i]}" in filter`);
    return pred;
  }

  const jpSeg = (key) => (typeof key === "number" ? `[${key}]` : `['${key}']`);

  /** Run parsed steps over a document; returns [{value, path}]. */
  function jpEval(doc, steps) {
    let cur = [{ value: doc, path: "$" }];
    for (const step of steps) {
      const next = [];
      for (const node of cur) {
        const v = node.value;
        switch (step.t) {
          case "child":
            for (const name of step.names) {
              if (v && typeof v === "object" && name in v) {
                next.push({ value: v[name], path: node.path + jpSeg(name) });
              } else if (name === "length" && (Array.isArray(v) || typeof v === "string")) {
                next.push({ value: v.length, path: node.path + jpSeg("length") });
              }
            }
            break;
          case "wild":
            if (Array.isArray(v)) v.forEach((x, k) => next.push({ value: x, path: node.path + jpSeg(k) }));
            else if (v && typeof v === "object") for (const k of Object.keys(v)) next.push({ value: v[k], path: node.path + jpSeg(k) });
            break;
          case "index":
            if (Array.isArray(v)) {
              for (const raw of step.idx) {
                const k = raw < 0 ? v.length + raw : raw;
                if (k >= 0 && k < v.length) next.push({ value: v[k], path: node.path + jpSeg(k) });
              }
            }
            break;
          case "slice":
            if (Array.isArray(v)) {
              const len = v.length;
              const stp = step.step || 1;
              let a = step.start == null ? (stp > 0 ? 0 : len - 1) : (step.start < 0 ? len + step.start : step.start);
              let b = step.end == null ? (stp > 0 ? len : -1) : (step.end < 0 ? len + step.end : step.end);
              if (stp > 0) for (let k = Math.max(0, a); k < Math.min(len, b); k += stp) next.push({ value: v[k], path: node.path + jpSeg(k) });
              else for (let k = Math.min(len - 1, a); k > Math.max(-1, b); k += stp) next.push({ value: v[k], path: node.path + jpSeg(k) });
            }
            break;
          case "filter": {
            const test = (val, path) => { try { if (step.pred(val)) next.push({ value: val, path }); } catch { /* skip */ } };
            if (Array.isArray(v)) v.forEach((x, k) => test(x, node.path + jpSeg(k)));
            else if (v && typeof v === "object") for (const k of Object.keys(v)) test(v[k], node.path + jpSeg(k));
            break;
          }
          case "descend": {
            // self and every descendant, document order
            const walk = (val, path) => {
              next.push({ value: val, path });
              if (Array.isArray(val)) val.forEach((x, k) => walk(x, path + jpSeg(k)));
              else if (val && typeof val === "object") for (const k of Object.keys(val)) walk(val[k], path + jpSeg(k));
            };
            walk(v, node.path);
            break;
          }
        }
      }
      cur = next;
    }
    return cur;
  }

  /** Evaluate a JSONPath against a parsed document. */
  function jsonPath(doc, expr) {
    return jpEval(doc, jpParse(expr));
  }
  Devtil.jsonPath = jsonPath; // exported for reuse and tests

  const JSONPATH_SAMPLE = JSON.stringify({
    store: {
      book: [
        { category: "reference", author: "Nigel Rees", title: "Sayings of the Century", price: 8.95 },
        { category: "fiction", author: "Evelyn Waugh", title: "Sword of Honour", price: 12.99 },
        { category: "fiction", author: "Herman Melville", title: "Moby Dick", isbn: "0-553-21311-3", price: 8.99 },
        { category: "fiction", author: "J. R. R. Tolkien", title: "The Lord of the Rings", isbn: "0-395-19395-8", price: 22.99 },
      ],
      bicycle: { color: "red", price: 19.95 },
    },
    expensive: 10,
  }, null, 2);

  const JSONPATH_EXAMPLES = [
    ["$.store.book[*].author", "authors of all books"],
    ["$..author", "all authors, at any depth"],
    ["$.store.*", "everything in the store"],
    ["$.store..price", "every price"],
    ["$..book[2]", "the third book"],
    ["$..book[-1]", "the last book"],
    ["$..book[0,1]", "the first two books"],
    ["$..book[:2]", "the first two books (slice)"],
    ["$..book[?(@.isbn)]", "books that have an ISBN"],
    ["$..book[?(@.price < 10)]", "books cheaper than 10"],
    ["$..book[?(@.category == 'fiction' && @.price > 10)]", "combined filter"],
    ["$..book[?(@.author =~ /tolkien/i)]", "regex on the author"],
    ["$..book.length", "how many books"],
  ];

  registerTool({
    type: "jsonpath",
    icon: "$·",
    name: "JSONPath",
    desc: "Evaluate JSONPath expressions against a JSON document — filters, slices, wildcards and recursive descent, with matched values or their paths.",
    // a new tab opens on the sample document with a filter already applied,
    // so the tool demonstrates itself
    defaults: () => ({ input: JSONPATH_SAMPLE, path: "$..book[?(@.price < 10)]", mode: "values", output: "" }),
    render(root, tab, ctx) {
      const d = tab.data;
      if (!d.input) d.input = JSONPATH_SAMPLE;
      if (!d.path) d.path = "$";

      const status = el("div", { class: "status-line dim" });
      const output = el("textarea", { class: "grow", spellcheck: "false", readonly: "" });
      const input = boundArea(d, "input", ctx, {}, () => run());

      const pathIn = el("input", { type: "text", class: "jp-path", placeholder: "$.store.book[?(@.price < 10)].title", value: d.path });
      const modeSel = el("select", {}, [
        el("option", { value: "values", text: "Matched values" }),
        el("option", { value: "paths", text: "Matched paths" }),
        el("option", { value: "both", text: "Paths + values" }),
      ]);
      modeSel.value = d.mode || "values";

      const run = () => {
        const src = d.input || "";
        if (!src.trim()) { output.value = ""; d.output = ""; return setStatus(status, "Paste some JSON to start", "dim"); }
        let doc;
        try {
          doc = JSON.parse(src);
        } catch (e) {
          output.value = "";
          d.output = "";
          return setStatus(status, "✗ Invalid JSON: " + e.message, "err");
        }
        let hits;
        try {
          hits = jsonPath(doc, d.path || "$");
        } catch (e) {
          output.value = "";
          d.output = "";
          return setStatus(status, "✗ Invalid JSONPath: " + e.message, "err");
        }
        let text;
        if (d.mode === "paths") text = hits.map((h) => h.path).join("\n");
        else if (d.mode === "both") text = hits.map((h) => h.path + "  →  " + JSON.stringify(h.value)).join("\n");
        else text = JSON.stringify(hits.map((h) => h.value), null, 2);
        output.value = text;
        d.output = text;
        ctx.save();
        setStatus(status, hits.length ? `✓ ${hits.length} match(es)` : "No matches", hits.length ? "ok" : "err");
      };

      pathIn.addEventListener("input", () => { d.path = pathIn.value; ctx.save(); run(); });
      pathIn.addEventListener("keydown", (e) => { if (e.key === "Enter") run(); });
      modeSel.addEventListener("change", () => { d.mode = modeSel.value; ctx.save(); run(); });

      const examples = el("details", { class: "section" }, [
        el("summary", { text: "Examples — click one to try it" }),
        el("div", { class: "jp-examples" }, JSONPATH_EXAMPLES.map(([ex, why]) =>
          el("button", {
            class: "btn chip", text: ex, title: why,
            onclick: () => { d.path = ex; pathIn.value = ex; ctx.save(); run(); },
          })
        )),
      ]);

      root.append(
        el("div", { class: "toolbar" }, [
          el("span", { class: "pane-label", text: "JSONPath" }),
          pathIn,
          el("button", { class: "btn primary", text: "Evaluate", onclick: run }),
          modeSel,
          copyBtn(() => output.value, "Copy result"),
          el("button", {
            class: "btn", text: "Load sample",
            onclick: () => { d.input = JSONPATH_SAMPLE; input.value = JSONPATH_SAMPLE; ctx.save(); run(); },
          }),
        ]),
        examples,
        status,
        el("div", { class: "split" }, [
          el("div", {}, [el("span", { class: "pane-label", text: "JSON" }), input]),
          el("div", {}, [el("span", { class: "pane-label", text: "Result" }), output]),
        ])
      );
      run();
    },
  });

  // ======================================================================
  // XML ⇄ JSON
  // ======================================================================
  // Dependency-free conversion using the browser's DOMParser. Convention:
  //   <a x="1">hi</a>            → { "a": { "@x": "1", "#text": "hi" } }
  //   <a><b>1</b><b>2</b></a>    → { "a": { "b": ["1", "2"] } }
  //   <a>hi</a>                  → { "a": "hi" }
  // and the reverse: keys starting with "@" become attributes, "#text" the
  // element's text, everything else a child element (arrays repeat the tag).
  const xmlEsc = (s) => String(s).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const xmlAttrEsc = (s) => xmlEsc(s).replaceAll('"', "&quot;");

  function xmlElemToValue(node) {
    const attrs = {};
    for (const a of Array.from(node.attributes || [])) attrs["@" + a.name] = a.value;
    const kids = {};
    let text = "", elems = 0;
    for (const ch of Array.from(node.childNodes)) {
      if (ch.nodeType === 1) { // element
        elems++;
        const key = ch.nodeName, val = xmlElemToValue(ch);
        if (kids[key] === undefined) kids[key] = val;
        else { if (!Array.isArray(kids[key])) kids[key] = [kids[key]]; kids[key].push(val); }
      } else if (ch.nodeType === 3 || ch.nodeType === 4) { // text / CDATA
        text += ch.nodeValue;
      }
    }
    const trimmed = text.trim();
    if (elems === 0 && Object.keys(attrs).length === 0) return trimmed;
    const obj = Object.assign({}, attrs, kids);
    if (trimmed !== "") obj["#text"] = trimmed;
    return obj;
  }

  function xmlToJson(xml, indent) {
    const doc = new DOMParser().parseFromString(String(xml).trim(), "application/xml");
    const perr = doc.querySelector("parsererror");
    if (perr) throw new Error(perr.textContent.replace(/\s+/g, " ").trim());
    const root = doc.documentElement;
    if (!root) throw new Error("no root element found");
    return JSON.stringify({ [root.nodeName]: xmlElemToValue(root) }, null, indent);
  }

  function valueToXml(key, val, pad, step) {
    if (Array.isArray(val)) return val.map((v) => valueToXml(key, v, pad, step)).join("\n");
    if (val === null || typeof val !== "object") {
      const t = val === null ? "" : xmlEsc(String(val));
      return t === "" ? `${pad}<${key}/>` : `${pad}<${key}>${t}</${key}>`;
    }
    const attrs = []; let text = ""; const children = [];
    for (const [k, v] of Object.entries(val)) {
      if (k[0] === "@") attrs.push(`${k.slice(1)}="${xmlAttrEsc(v)}"`);
      else if (k === "#text") text = xmlEsc(String(v));
      else children.push([k, v]);
    }
    const a = attrs.length ? " " + attrs.join(" ") : "";
    if (!children.length) return text === "" ? `${pad}<${key}${a}/>` : `${pad}<${key}${a}>${text}</${key}>`;
    const inner = children.map(([k, v]) => valueToXml(k, v, pad + step, step)).join("\n");
    const textLine = text ? `\n${pad + step}${text}` : "";
    return `${pad}<${key}${a}>${textLine}\n${inner}\n${pad}</${key}>`;
  }

  function jsonToXml(json, step) {
    const obj = JSON.parse(json);
    if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
      throw new Error("JSON must be an object with a single root element");
    }
    const keys = Object.keys(obj).filter((k) => k[0] !== "@" && k !== "#text");
    const body = keys.length === 1
      ? valueToXml(keys[0], obj[keys[0]], "", step)
      : valueToXml("root", obj, "", step); // wrap multiple roots in <root>
    return '<?xml version="1.0" encoding="UTF-8"?>\n' + body;
  }

  registerTool({
    type: "xmljson",
    icon: "</>",
    name: "XML ⇄ JSON",
    desc: "Convert XML to JSON and back — attributes, nested elements, repeated tags and text nodes preserved. Runs entirely in the browser.",
    defaults: () => ({ input: "", output: "", indent: "2" }),
    render(root, tab, ctx) {
      const d = tab.data;
      const status = el("div", { class: "status-line dim" });
      const output = el("textarea", { class: "grow", spellcheck: "false", readonly: "" });
      output.value = d.output || "";
      const input = boundArea(d, "input", ctx);

      const indentSel = bindField(
        el("select", {}, [
          el("option", { value: "2", text: "2 spaces" }),
          el("option", { value: "4", text: "4 spaces" }),
          el("option", { value: "tab", text: "Tabs" }),
        ]),
        d, "indent", ctx
      );
      const jsonIndent = () => (d.indent === "tab" ? "\t" : Number(d.indent || 2));
      const xmlStep = () => (d.indent === "tab" ? "\t" : " ".repeat(Number(d.indent || 2)));

      const setOut = (text) => { output.value = text; d.output = text; ctx.save(); };

      const toJson = () => {
        if (!(d.input || "").trim()) return setStatus(status, "✗ Paste some XML first", "err");
        try {
          setOut(xmlToJson(d.input, jsonIndent()));
          setStatus(status, "✓ Converted XML → JSON", "ok");
        } catch (e) {
          setStatus(status, "✗ Invalid XML: " + e.message, "err");
        }
      };
      const toXml = () => {
        if (!(d.input || "").trim()) return setStatus(status, "✗ Paste some JSON first", "err");
        try {
          setOut(jsonToXml(d.input, xmlStep()));
          setStatus(status, "✓ Converted JSON → XML", "ok");
        } catch (e) {
          setStatus(status, "✗ Invalid JSON: " + e.message, "err");
        }
      };

      root.append(
        el("div", { class: "toolbar" }, [
          el("button", { class: "btn primary", text: "XML → JSON", onclick: toJson }),
          el("button", { class: "btn primary", text: "JSON → XML", onclick: toXml }),
          indentSel,
          copyBtn(() => output.value, "Copy output"),
          el("button", { class: "btn", text: "Output → Input", onclick: () => { input.value = output.value; d.input = output.value; ctx.save(); } }),
        ]),
        status,
        el("div", { class: "split" }, [
          el("div", {}, [el("span", { class: "pane-label", text: "Input (XML or JSON)" }), input]),
          el("div", {}, [el("span", { class: "pane-label", text: "Output" }), output]),
        ])
      );
    },
  });

  // ======================================================================
  // Base64
  // ======================================================================
  const te = new TextEncoder(), td = new TextDecoder();
  function b64encode(s, urlSafe) {
    const bytes = te.encode(s);
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    let out = btoa(bin);
    if (urlSafe) out = out.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
    return out;
  }
  function b64decode(s) {
    const normalized = s.trim().replaceAll("-", "+").replaceAll("_", "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    const bin = atob(padded);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return td.decode(bytes);
  }

  registerTool({
    type: "base64",
    icon: "64",
    name: "Base64",
    desc: "Encode and decode Base64 (unicode-safe, URL-safe variant supported). Converts live as you type.",
    defaults: () => ({ input: "", mode: "encode", urlSafe: false }),
    render(root, tab, ctx) {
      const d = tab.data;
      const status = el("div", { class: "status-line dim" });
      const output = el("textarea", { class: "grow", readonly: "", spellcheck: "false" });

      const convert = () => {
        try {
          output.value = d.mode === "encode" ? b64encode(d.input, d.urlSafe) : b64decode(d.input);
          setStatus(status, d.input ? `✓ ${d.mode}d ${fmtBytes(te.encode(d.input).length)}` : "", "ok");
        } catch {
          output.value = "";
          setStatus(status, "✗ Invalid Base64 input", "err");
        }
      };

      const input = boundArea(d, "input", ctx, {}, convert);
      const modeSel = bindField(
        el("select", {}, [
          el("option", { value: "encode", text: "Encode" }),
          el("option", { value: "decode", text: "Decode" }),
        ]),
        d, "mode", ctx, convert
      );
      const urlSafe = bindField(el("input", { type: "checkbox" }), d, "urlSafe", ctx, convert);

      root.append(
        el("div", { class: "toolbar" }, [
          modeSel,
          el("label", { class: "inline" }, [urlSafe, "URL-safe"]),
          el("button", {
            class: "btn", text: "⇄ Swap",
            onclick: () => {
              d.mode = d.mode === "encode" ? "decode" : "encode";
              modeSel.value = d.mode;
              d.input = output.value;
              input.value = d.input;
              ctx.save();
              convert();
            },
          }),
          copyBtn(() => output.value, "Copy output"),
        ]),
        status,
        el("div", { class: "split" }, [
          el("div", {}, [el("span", { class: "pane-label", text: "Input" }), input]),
          el("div", {}, [el("span", { class: "pane-label", text: "Output" }), output]),
        ])
      );
      convert();
    },
  });

  // ======================================================================
  // URL Tools
  // ======================================================================
  registerTool({
    type: "url",
    icon: "%",
    name: "URL Tools",
    desc: "Encode/decode URL components and dissect a URL into parts & query parameters.",
    defaults: () => ({ input: "", mode: "decode" }),
    render(root, tab, ctx) {
      const d = tab.data;
      const output = el("textarea", { class: "grow", readonly: "", spellcheck: "false" });
      const status = el("div", { class: "status-line dim" });
      const parts = el("div");

      const convert = () => {
        try {
          output.value =
            d.mode === "encode" ? encodeURIComponent(d.input)
            : d.mode === "encode-uri" ? encodeURI(d.input)
            : decodeURIComponent(d.input.replaceAll("+", "%20"));
          setStatus(status, "", "dim");
        } catch (e) {
          output.value = "";
          setStatus(status, "✗ " + e.message, "err");
        }
        renderParts();
      };

      const renderParts = () => {
        parts.replaceChildren();
        let u;
        try { u = new URL(d.input.trim()); } catch { return; }
        const rows = [
          ["Protocol", u.protocol], ["Host", u.host], ["Path", u.pathname],
          ["Hash", u.hash],
        ].filter(([, v]) => v && v !== ":");
        for (const [k, v] of u.searchParams) rows.push(["Param: " + k, v]);
        if (rows.length) {
          parts.append(
            el("span", { class: "pane-label", text: "URL breakdown" }),
            el("table", { class: "kv" }, rows.map(([k, v]) =>
              el("tr", {}, [el("th", { text: k }), el("td", { text: v })])
            ))
          );
        }
      };

      const input = boundArea(d, "input", ctx, {}, convert);
      root.append(
        el("div", { class: "toolbar" }, [
          bindField(
            el("select", {}, [
              el("option", { value: "decode", text: "Decode" }),
              el("option", { value: "encode", text: "Encode component" }),
              el("option", { value: "encode-uri", text: "Encode full URI" }),
            ]),
            d, "mode", ctx, convert
          ),
          copyBtn(() => output.value, "Copy output"),
        ]),
        status,
        el("div", { class: "split" }, [
          el("div", {}, [el("span", { class: "pane-label", text: "Input" }), input]),
          el("div", {}, [el("span", { class: "pane-label", text: "Output" }), output]),
        ]),
        parts
      );
      convert();
    },
  });

  // ======================================================================
  // JWT Decoder
  // ======================================================================
  registerTool({
    type: "jwt",
    icon: "🔑",
    name: "JWT Decoder",
    desc: "Decode a JWT's header and payload, with human-readable timestamps for exp/iat/nbf.",
    defaults: () => ({ input: "" }),
    render(root, tab, ctx) {
      const d = tab.data;
      const status = el("div", { class: "status-line dim" });
      const out = el("div", { class: "split" });

      const decode = () => {
        out.replaceChildren();
        const token = (d.input || "").trim();
        if (!token) return setStatus(status, "Paste a JWT above", "dim");
        const segs = token.split(".");
        if (segs.length !== 3) return setStatus(status, "✗ A JWT has 3 dot-separated segments", "err");
        try {
          const header = JSON.parse(b64decode(segs[0]));
          const payload = JSON.parse(b64decode(segs[1]));
          const notes = [];
          for (const claim of ["exp", "iat", "nbf"]) {
            if (typeof payload[claim] === "number") {
              const when = new Date(payload[claim] * 1000);
              const rel = claim === "exp" ? (when > new Date() ? " (valid)" : " (EXPIRED)") : "";
              notes.push(`${claim}: ${when.toISOString()}${rel}`);
            }
          }
          out.append(
            el("div", {}, [
              el("span", { class: "pane-label", text: "Header" }),
              el("pre", { class: "output", text: JSON.stringify(header, null, 2) }),
            ]),
            el("div", {}, [
              el("span", { class: "pane-label", text: "Payload" }),
              el("pre", { class: "output", text: JSON.stringify(payload, null, 2) }),
            ])
          );
          setStatus(status, "✓ Decoded. " + notes.join("  ·  ") + "  ·  Signature NOT verified.", "ok");
        } catch {
          setStatus(status, "✗ Could not decode token segments", "err");
        }
      };

      root.append(
        el("div", {}, [
          el("span", { class: "pane-label", text: "Token" }),
          boundArea(d, "input", ctx, { class: "", rows: "4", style: "width:100%" }, decode),
        ]),
        status,
        out
      );
      decode();
    },
  });

  // ======================================================================
  // API Client (Postman-like)
  // ======================================================================
  /** Extract endpoints and a base URL from Swagger 2.0 / OpenAPI 3.x JSON. */
  function parseSwagger(doc, sourceUrl) {
    const endpoints = [];
    for (const [path, ops] of Object.entries(doc.paths || {})) {
      for (const m of ["get", "post", "put", "patch", "delete", "head", "options"]) {
        if (ops && ops[m]) {
          endpoints.push({ method: m.toUpperCase(), path, name: ops[m].summary || ops[m].operationId || "" });
        }
      }
    }
    let base = "";
    if (Array.isArray(doc.servers) && doc.servers[0] && doc.servers[0].url) {
      base = doc.servers[0].url; // OpenAPI 3
    } else if (doc.host) {
      base = ((doc.schemes && doc.schemes[0]) || "https") + "://" + doc.host + (doc.basePath || ""); // Swagger 2
    }
    try { base = new URL(base || "/", sourceUrl).toString(); } catch { /* keep as-is */ }
    return { endpoints, baseUrl: base.replace(/\/+$/, "") };
  }

  // ---- request authorization (API client) --------------------------------
  // Auth lives on the request, and on the collection so requests under the
  // base URL can inherit one set of credentials.
  const AUTH_TYPES = [
    { value: "none", label: "No auth" },
    { value: "basic", label: "Basic" },
    { value: "bearer", label: "Bearer token" },
    { value: "apikey", label: "API key" },
  ];

  /** Turn an auth config into the headers (and query params) it contributes. */
  function authParts(auth) {
    const out = { headers: {}, query: [] };
    if (!auth) return out;
    switch (auth.type) {
      case "basic": {
        const u = auth.username || "", p = auth.password || "";
        if (!u && !p) break;
        // RFC 7617: base64 of "user:password" — b64encode is UTF-8 safe, so
        // non-ASCII credentials encode correctly
        out.headers["Authorization"] = "Basic " + b64encode(u + ":" + p);
        break;
      }
      case "bearer": {
        const t = (auth.token || "").trim();
        if (!t) break;
        // tolerate a token pasted with the scheme already on it
        out.headers["Authorization"] = /^bearer\s+/i.test(t) ? t : "Bearer " + t;
        break;
      }
      case "apikey": {
        const k = (auth.key || "").trim();
        if (!k) break;
        if (auth.in === "query") out.query.push([k, auth.value || ""]);
        else out.headers[k] = auth.value || "";
        break;
      }
    }
    return out;
  }

  const appendQuery = (url, pairs) => {
    if (!pairs.length) return url;
    const qs = pairs.map(([k, v]) => encodeURIComponent(k) + "=" + encodeURIComponent(v)).join("&");
    return url + (url.includes("?") ? "&" : "?") + qs;
  };

  /** Editor for an auth config living on `holder.auth`. */
  function authEditor(holder, ctx, { allowInherit = false, onChange } = {}) {
    if (!holder.auth) holder.auth = { type: allowInherit ? "inherit" : "none", in: "header" };
    const a = holder.auth;
    const box = el("div", { class: "auth-box" });
    const types = allowInherit
      ? [{ value: "inherit", label: "Inherit from collection" }, ...AUTH_TYPES]
      : AUTH_TYPES;

    const field = (label, node) => el("div", { class: "field" }, [el("span", { class: "pane-label", text: label }), node]);
    const bind = (key, attrs) => {
      const input = el("input", { style: "width:100%", ...attrs });
      input.value = a[key] || "";
      input.addEventListener("input", () => { a[key] = input.value; ctx.save(); draw(); });
      return input;
    };

    function draw() {
      box.replaceChildren();
      const sel = el("select", {}, types.map((t) => el("option", { value: t.value, text: t.label })));
      sel.value = a.type || types[0].value;
      sel.addEventListener("change", () => { a.type = sel.value; ctx.save(); draw(); onChange && onChange(); });
      box.append(el("div", { class: "toolbar" }, [el("span", { class: "pane-label", text: "Type" }), sel]));

      if (a.type === "basic") {
        box.append(el("div", { class: "form-grid" }, [
          field("Username", bind("username", { type: "text", placeholder: "user" })),
          field("Password", bind("password", { type: "password", placeholder: "password" })),
        ]));
      } else if (a.type === "bearer") {
        box.append(el("div", { class: "form-grid" }, [
          field("Token", bind("token", { type: "text", placeholder: "eyJhbGciOi… (the 'Bearer ' prefix is added for you)" })),
        ]));
      } else if (a.type === "apikey") {
        const inSel = el("select", {}, [
          el("option", { value: "header", text: "Header" }),
          el("option", { value: "query", text: "Query param" }),
        ]);
        inSel.value = a.in || "header";
        inSel.addEventListener("change", () => { a.in = inSel.value; ctx.save(); draw(); });
        box.append(el("div", { class: "form-grid" }, [
          field("Key", bind("key", { type: "text", placeholder: "X-API-Key" })),
          field("Value", bind("value", { type: "text", placeholder: "secret" })),
          field("Send in", inSel),
        ]));
      }

      // show exactly what will be sent, so the encoding is verifiable
      const parts = authParts(a);
      const lines = Object.entries(parts.headers).map(([k, v]) => k + ": " + v)
        .concat(parts.query.map(([k, v]) => "?" + k + "=" + v));
      if (lines.length) {
        const text = lines.join("\n");
        box.append(el("div", { class: "auth-preview" }, [
          el("span", { class: "pane-label", text: "Sends" }),
          el("code", { text }),
          copyBtn(() => text, "Copy"),
        ]));
      }
    }
    draw();
    return box;
  }

  const authSummary = (auth, inheriting) => {
    const t = (auth && auth.type) || "none";
    if (t === "inherit") return "Auth — inherit from collection" + (inheriting ? " (" + inheriting + ")" : "");
    const label = (AUTH_TYPES.find((x) => x.value === t) || AUTH_TYPES[0]).label;
    return "Auth — " + label;
  };

  registerTool({
    type: "api",
    icon: "🚀",
    name: "API Client",
    desc: "Postman-like client: multiple collections with searchable request trees, per-request auth (Basic / Bearer / API key), global headers, Swagger/OpenAPI import and history.",
    defaults: () => ({
      collections: [], activeColId: null,
      history: [], swaggerUrl: "",
      tabs: [], activeTabId: null,
    }),
    subTabs: (d) => (d.tabs || []).map((t) => ({
      id: t.id,
      label: t.kind === "collection"
        ? "📁 " + ((d.collections || []).find((c) => c.id === t.colId) || {}).name
        : (t.name || ((t.method || "GET") + " " + (t.url || "request"))),
      select: () => { d.activeTabId = t.id; },
      remove: () => {
        const i = d.tabs.findIndex((x) => x.id === t.id);
        if (i >= 0) d.tabs.splice(i, 1);
        if (d.activeTabId === t.id) d.activeTabId = d.tabs[0]?.id ?? null;
      },
    })),
    render(root, tab, ctx) {
      const d = tab.data;

      // ---- data model -----------------------------------------------------
      // A collection owns a base URL, global headers, auth and a list of
      // saved requests. A saved request is a *complete* request (headers,
      // body, auth), not just a method+path, so opening one and editing it
      // and saving it back round-trips properly.
      const newCollection = (name) => ({
        id: uid(), name: name || "New collection", baseUrl: "",
        headers: [{ k: "", v: "" }], auth: { type: "none", in: "header" },
        requests: [],
      });
      const newSavedRequest = (partial = {}) => ({
        id: uid(), name: partial.name || "", method: partial.method || "GET",
        path: partial.path || "",
        headers: partial.headers && partial.headers.length ? partial.headers : [{ k: "", v: "" }],
        body: partial.body || "", auth: partial.auth || { type: "inherit", in: "header" },
      });
      const newReqTab = (partial = {}) => ({
        id: uid(), kind: "request",
        name: partial.name || "New request", method: partial.method || "GET",
        url: partial.url || "",
        headers: partial.headers && partial.headers.length ? partial.headers : [{ k: "", v: "" }],
        body: partial.body || "", insecure: !!partial.insecure, response: partial.response || null,
        auth: partial.auth || { type: "inherit", in: "header" },
        // where this came from, so Save updates in place instead of duplicating
        colId: partial.colId || null, reqId: partial.reqId || null,
      });

      // ---- init & migration -----------------------------------------------
      if (!Array.isArray(d.collections)) d.collections = [];
      // the single unnamed collection this tool used to have
      if (d.collection) {
        const old = d.collection;
        const col = newCollection("My Collection");
        col.baseUrl = old.baseUrl || "";
        if (Array.isArray(old.headers) && old.headers.length) col.headers = old.headers;
        if (old.auth) col.auth = old.auth;
        col.requests = (old.requests || []).map((r) =>
          newSavedRequest({ name: r.name, method: r.method, path: r.path }));
        d.collections.push(col);
        delete d.collection;
      }
      if (!Array.isArray(d.tabs)) d.tabs = [];
      if (Array.isArray(d.reqTabs)) { // pre-collections tab shape
        for (const t of d.reqTabs) d.tabs.push(newReqTab(t));
        delete d.reqTabs;
        delete d.activeReqId;
      }
      if (!d.collections.length) d.collections.push(newCollection("My Collection"));
      for (const c of d.collections) {
        if (!Array.isArray(c.headers) || !c.headers.length) c.headers = [{ k: "", v: "" }];
        if (!c.auth) c.auth = { type: "none", in: "header" };
        if (!Array.isArray(c.requests)) c.requests = [];
        for (const r of c.requests) {
          if (!r.id) r.id = uid();
          if (!Array.isArray(r.headers) || !r.headers.length) r.headers = [{ k: "", v: "" }];
          if (!r.auth) r.auth = { type: "inherit", in: "header" };
          if (r.body === undefined) r.body = "";
        }
      }
      if (!Array.isArray(d.history)) d.history = [];
      if (!d.collections.some((c) => c.id === d.activeColId)) d.activeColId = d.collections[0].id;
      if (!d.tabs.length) d.tabs.push(newReqTab());
      if (!d.tabs.some((t) => t.id === d.activeTabId)) d.activeTabId = d.tabs[0].id;

      // ---- lookups ---------------------------------------------------------
      const activeTab = () => d.tabs.find((t) => t.id === d.activeTabId) || d.tabs[0];
      const colById = (id) => d.collections.find((c) => c.id === id) || null;
      const trimBase = (u) => (u || "").trim().replace(/\/+$/, "");
      const shortPath = (url) => { try { return new URL(url).pathname; } catch { return url; } };
      const resolveUrl = (col, path) => (/^https?:\/\//i.test(path) ? path : trimBase(col.baseUrl) + path);

      // Which collection's settings a request inherits: the one it was saved
      // in, otherwise whichever collection's base URL the URL sits under.
      const owningCollection = (t) => {
        if (t.colId) { const c = colById(t.colId); if (c) return c; }
        const url = (t.url || "").toLowerCase();
        return d.collections.find((c) => c.baseUrl && url.startsWith(c.baseUrl.toLowerCase())) || null;
      };

      const reqLabel = (r) => r.name || (r.method + " " + (shortPath(r.path || r.url) || "…"));

      // ---- open / focus tabs ------------------------------------------------
      function openTab(t) {
        d.tabs.push(t);
        d.activeTabId = t.id;
        ctx.save();
        renderSide();
        renderMain();
      }
      function openCollectionTab(colId) {
        const existing = d.tabs.find((t) => t.kind === "collection" && t.colId === colId);
        if (existing) { d.activeTabId = existing.id; ctx.save(); renderSide(); renderMain(); return; }
        openTab({ id: uid(), kind: "collection", colId });
      }
      function openSavedRequest(col, r) {
        const existing = d.tabs.find((t) => t.kind === "request" && t.reqId === r.id);
        if (existing) { d.activeTabId = existing.id; ctx.save(); renderSide(); renderMain(); return; }
        openTab(newReqTab({
          name: reqLabel(r), method: r.method, url: resolveUrl(col, r.path),
          // copy, so editing an open tab doesn't silently mutate the saved
          // request before the user presses Save
          headers: JSON.parse(JSON.stringify(r.headers)),
          body: r.body, auth: JSON.parse(JSON.stringify(r.auth)),
          colId: col.id, reqId: r.id,
        }));
      }
      function openAdHoc(partial = {}) {
        const existing = partial.url && d.tabs.find((t) =>
          t.kind === "request" && !t.reqId && t.method === (partial.method || "GET") && t.url === partial.url);
        if (existing) { d.activeTabId = existing.id; ctx.save(); renderSide(); renderMain(); return; }
        openTab(newReqTab(partial));
      }

      // ---- key/value editor, shared by request and collection headers ------
      const headersEditor = (list) => {
        const box = el("div", { style: "display:flex;flex-direction:column;gap:6px" });
        const draw = () => {
          box.replaceChildren();
          list.forEach((h, i) => {
            const key = el("input", { type: "text", class: "hk", placeholder: "Header", value: h.k });
            const val = el("input", { type: "text", class: "hv", placeholder: "Value", value: h.v });
            key.addEventListener("input", () => { h.k = key.value; ctx.save(); });
            val.addEventListener("input", () => { h.v = val.value; ctx.save(); });
            box.append(el("div", { class: "header-row" }, [
              key, val,
              el("button", {
                class: "icon-btn", text: "×", title: "Remove header",
                onclick: () => { list.splice(i, 1); if (!list.length) list.push({ k: "", v: "" }); ctx.save(); draw(); },
              }),
            ]));
          });
          box.append(el("div", {}, [
            el("button", { class: "btn", text: "+ Header", onclick: () => { list.push({ k: "", v: "" }); ctx.save(); draw(); } }),
          ]));
        };
        draw();
        return box;
      };

      // ---- layout ------------------------------------------------------------
      const sideBox = el("div", { class: "api-side" });
      const mainBox = el("div", { class: "api-main" });
      root.append(el("div", { class: "api-layout" }, [sideBox, mainBox]));
      let sideView = "collections";
      let query = "";              // sidebar filter — a view concern, not persisted
      let shareMsg = null;         // survives the renderSide() an import triggers
      // An import or a save rebuilds the pane it was triggered from, which
      // would take its own confirmation down with it. Park the message here
      // so whichever pane renders next can show it.
      let flash = null;
      const setFlash = (text, kind) => { flash = { text, kind }; };
      const showFlash = (node) => { if (flash) setStatus(node, flash.text, flash.kind); };

      // ============================ side panel ============================

      function renderSide() {
        const subtab = (view, label) => el("button", {
          class: sideView === view ? "active" : "",
          text: label,
          onclick: () => { sideView = view; renderSide(); },
        });
        const total = d.collections.reduce((n, c) => n + c.requests.length, 0);
        sideBox.replaceChildren(
          el("div", { class: "subtabs" }, [
            subtab("collections", `Collections (${total})`),
            subtab("history", `History (${d.history.length})`),
          ]),
          sideView === "history" ? historyPanel() : collectionsPanel()
        );
      }

      // ---- the collection tree ------------------------------------------
      function collectionsPanel() {
        const box = el("div", { class: "api-side-content" });

        const search = el("input", {
          type: "search", class: "api-search", placeholder: "Search requests…",
          value: query, autocomplete: "off",
        });
        search.addEventListener("input", () => { query = search.value.trim(); renderTree(); });
        search.addEventListener("keydown", (e) => {
          e.stopPropagation(); // don't fire the app-level shortcuts while typing
          if (e.key === "Escape") { search.value = ""; query = ""; renderTree(); }
        });

        const fileIn = el("input", { type: "file", accept: "application/json,.json", style: "display:none" });
        fileIn.addEventListener("change", () => importCollectionFile(fileIn));

        box.append(el("div", { class: "api-tree-head" }, [
          search,
          el("button", {
            class: "btn", text: "+ New", title: "New collection",
            onclick: async () => {
              const name = await promptDialog("Name for the new collection:", "New collection");
              if (!name) return;
              const c = newCollection(name.trim());
              d.collections.push(c);
              d.activeColId = c.id;
              ctx.save();
              renderSide();
              openCollectionTab(c.id);
            },
          }),
          el("button", { class: "btn", text: "Import", title: "Import a collection from a Devtil export file", onclick: () => fileIn.click() }),
          fileIn,
        ]));

        const tree = el("div", { class: "api-tree" });
        box.append(tree);

        function renderTree() {
          tree.replaceChildren();
          const q = query.toLowerCase();
          let shown = 0;

          for (const col of d.collections) {
            const colHit = !q || col.name.toLowerCase().includes(q);
            const hits = q
              ? col.requests.filter((r) =>
                  (r.name || "").toLowerCase().includes(q) ||
                  (r.path || "").toLowerCase().includes(q) ||
                  (r.method || "").toLowerCase().includes(q))
              : col.requests;
            if (q && !colHit && !hits.length) continue;
            // when the collection name itself matched, show all of its
            // requests rather than none
            const visible = q && !colHit ? hits : col.requests;
            shown += visible.length;

            // searching implies "show me the matches", so force it open
            const open = q ? true : !col.collapsed;
            const caret = el("button", {
              class: "icon-btn api-caret", text: open ? "▾" : "▸",
              title: open ? "Collapse" : "Expand",
              onclick: (e) => { e.stopPropagation(); col.collapsed = !col.collapsed; ctx.save(); renderTree(); },
            });

            const row = el("div", {
              class: "api-col-row" + (col.id === d.activeColId ? " active" : ""),
              title: "Open collection settings",
              onclick: () => { d.activeColId = col.id; ctx.save(); openCollectionTab(col.id); },
            }, [
              caret,
              el("span", { class: "api-col-name", text: col.name }),
              el("span", { class: "api-col-count", text: String(col.requests.length) }),
              el("button", {
                class: "icon-btn", text: "✎", title: "Rename collection",
                onclick: async (e) => {
                  e.stopPropagation();
                  const name = await promptDialog("Collection name:", col.name);
                  if (name && name.trim()) { col.name = name.trim(); ctx.save(); renderSide(); renderMain(); }
                },
              }),
              el("button", {
                class: "icon-btn", text: "×", title: "Delete collection",
                onclick: async (e) => {
                  e.stopPropagation();
                  if (!(await confirmDialog(`Delete collection “${col.name}” and its ${col.requests.length} request(s)?`, { okLabel: "Delete", danger: true }))) return;
                  d.collections = d.collections.filter((c) => c.id !== col.id);
                  if (!d.collections.length) d.collections.push(newCollection("My Collection"));
                  if (d.activeColId === col.id) d.activeColId = d.collections[0].id;
                  // close any tabs that belonged to it, and unlink open requests
                  d.tabs = d.tabs.filter((t) => !(t.kind === "collection" && t.colId === col.id));
                  for (const t of d.tabs) if (t.colId === col.id) { t.colId = null; t.reqId = null; }
                  if (!d.tabs.length) d.tabs.push(newReqTab());
                  if (!d.tabs.some((t) => t.id === d.activeTabId)) d.activeTabId = d.tabs[0].id;
                  ctx.save();
                  renderSide();
                  renderMain();
                },
              }),
            ]);
            tree.append(row);

            if (!open) continue;
            if (!visible.length) {
              tree.append(el("div", { class: "api-req-empty", text: q ? "no matches here" : "empty — save a request into it" }));
              continue;
            }
            for (const r of visible) {
              tree.append(el("div", {
                class: "api-req-row" + (d.tabs.some((t) => t.reqId === r.id && t.id === d.activeTabId) ? " active" : ""),
                title: (r.path || "") + (r.name ? " — " + r.name : ""),
                onclick: () => openSavedRequest(col, r),
              }, [
                el("span", { class: "api-method m" + (r.method || "GET"), text: r.method || "GET" }),
                el("span", { class: "api-req-name", text: r.name || r.path || "(unnamed)" }),
                el("button", {
                  class: "icon-btn", text: "✎", title: "Rename request",
                  onclick: async (e) => {
                    e.stopPropagation();
                    const name = await promptDialog("Request name:", r.name || r.path || "");
                    if (name === null) return;
                    r.name = name.trim();
                    // keep an open tab's label in step with the rename
                    for (const t of d.tabs) if (t.reqId === r.id) t.name = reqLabel(r);
                    ctx.save();
                    renderSide();
                    renderMain();
                  },
                }),
                el("button", {
                  class: "icon-btn", text: "×", title: "Remove from collection",
                  onclick: async (e) => {
                    e.stopPropagation();
                    if (!(await confirmDialog(`Remove “${reqLabel(r)}” from ${col.name}?`, { okLabel: "Remove", danger: true }))) return;
                    col.requests = col.requests.filter((x) => x.id !== r.id);
                    for (const t of d.tabs) if (t.reqId === r.id) { t.reqId = null; }
                    ctx.save();
                    renderSide();
                    renderMain();
                  },
                }),
              ]));
            }
          }

          if (q && !shown && !tree.querySelector(".api-col-row")) {
            tree.append(el("div", { class: "status-line dim", text: `Nothing matches “${query}”` }));
          }
          if (!q && !d.collections.some((c) => c.requests.length)) {
            tree.append(el("div", { class: "status-line dim", text: "No saved requests yet. Press Save on a request, or open a collection and import a Swagger/OpenAPI doc." }));
          }
        }

        renderTree();
        if (shareMsg) {
          const line = el("div", { class: "status-line" });
          setStatus(line, shareMsg.text, shareMsg.kind);
          box.append(line);
        }
        return box;
      }

      function historyPanel() {
        const box = el("div", { class: "api-side-content" });
        box.append(el("span", { class: "pane-label", text: "Sent requests — click to reopen in a tab" }));
        if (!d.history.length) box.append(el("div", { class: "status-line dim", text: "No requests sent yet" }));
        d.history.forEach((h) => {
          box.append(el("div", {
            class: "history-item", title: h.url,
            onclick: () => openAdHoc({ name: h.method + " " + shortPath(h.url), method: h.method, url: h.url }),
          }, [
            el("span", { class: "badge s" + String(h.status)[0], text: h.status }),
            el("span", { text: h.method }),
            el("span", { class: "h-url", text: h.url }),
            el("span", { text: h.durationMs + "ms" }),
          ]));
        });
        if (d.history.length) {
          box.append(el("div", { class: "toolbar" }, [
            el("button", { class: "btn", text: "Clear history", onclick: () => { d.history = []; ctx.save(); renderSide(); } }),
          ]));
        }
        return box;
      }

      // ---- import a collection file into a NEW collection -------------------
      async function importCollectionFile(fileIn) {
        const f = fileIn.files && fileIn.files[0];
        if (!f) return;
        try {
          const doc = JSON.parse(await f.text());
          const src = doc.collection || doc; // tolerate a bare collection object
          if (!Array.isArray(src.requests)) throw new Error("no requests array — is this a Devtil collection export?");
          const col = newCollection(src.name || doc.name || f.name.replace(/\.json$/i, ""));
          col.baseUrl = trimBase(src.baseUrl || "");
          col.headers = (src.headers || []).filter((h) => (h.k || "").trim());
          col.headers.push({ k: "", v: "" });
          if (src.auth && src.auth.type) col.auth = src.auth;
          for (const r of src.requests) {
            if (!r || !r.path) continue;
            col.requests.push(newSavedRequest({
              name: r.name, method: (r.method || "GET").toUpperCase(), path: r.path,
              headers: r.headers, body: r.body, auth: r.auth,
            }));
          }
          d.collections.push(col);
          d.activeColId = col.id;
          const notes = [];
          if (doc.containsCredentials === false && col.auth.type !== "none") notes.push("credentials weren't exported, so fill in the auth");
          shareMsg = {
            text: `✓ Imported “${col.name}” with ${col.requests.length} request(s)` + (notes.length ? " · " + notes.join(", ") : ""),
            kind: "ok",
          };
          ctx.save();
          renderSide();
          openCollectionTab(col.id);
        } catch (e) {
          shareMsg = { text: "✗ " + e.message, kind: "err" };
          renderSide();
        }
        fileIn.value = "";
      }

      // ======================= main: tab bar + panes =======================

      function renderMain(view = "body") {
        mainBox.replaceChildren();

        // tab bar: request tabs and collection tabs side by side
        mainBox.append(el("div", { class: "req-tabs" }, [
          ...d.tabs.map((t) => {
            const isCol = t.kind === "collection";
            const label = isCol ? "📁 " + ((colById(t.colId) || {}).name || "collection") : (t.name || "request");
            return el("div", {
              class: "req-tab" + (t.id === d.activeTabId ? " active" : ""),
              title: isCol ? "Collection settings" : (t.url || ""),
              onclick: () => {
                if (d.activeTabId === t.id) return;
                d.activeTabId = t.id;
                flash = null;
                ctx.save();
                renderSide();
                renderMain();
              },
            }, [
              el("span", { text: label }),
              el("button", {
                class: "tab-close", text: "×", title: "Close tab",
                onclick: (e) => {
                  e.stopPropagation();
                  const idx = d.tabs.findIndex((x) => x.id === t.id);
                  d.tabs.splice(idx, 1);
                  if (!d.tabs.length) d.tabs.push(newReqTab());
                  if (d.activeTabId === t.id) d.activeTabId = d.tabs[Math.min(idx, d.tabs.length - 1)].id;
                  ctx.save();
                  renderSide();
                  renderMain();
                },
              }),
            ]);
          }),
          el("button", { class: "icon-btn", text: "+", title: "New request tab", onclick: () => openAdHoc() }),
        ]));

        const t = activeTab();
        if (t.kind === "collection") renderCollectionPane(t);
        else renderRequestPane(t, view);
      }

      // ---- collection pane: everything about one collection ---------------
      function renderCollectionPane(t) {
        const col = colById(t.colId);
        if (!col) {
          mainBox.append(el("div", { class: "status-line dim", text: "This collection was deleted." }));
          return;
        }
        const status = el("div", { class: "status-line dim" });
        showFlash(status);

        const nameIn = el("input", { type: "text", value: col.name, style: "font-size:15px;font-weight:500" });
        nameIn.addEventListener("input", () => { col.name = nameIn.value; ctx.save(); });
        nameIn.addEventListener("change", () => { renderSide(); renderMain(); });

        const baseIn = el("input", { type: "text", placeholder: "https://api.example.com", value: col.baseUrl, style: "width:100%" });
        baseIn.addEventListener("input", () => { col.baseUrl = trimBase(baseIn.value); ctx.save(); });

        mainBox.append(
          el("div", { class: "col-head" }, [
            el("span", { class: "pane-label", text: "Collection" }),
            nameIn,
            el("span", { class: "spacer" }),
            el("button", {
              class: "btn", text: "+ Request", title: "New request in this collection",
              onclick: () => {
                const r = newSavedRequest({ name: "New request", method: "GET", path: "/" });
                col.requests.push(r);
                ctx.save();
                renderSide();
                openSavedRequest(col, r);
              },
            }),
          ]),
          el("div", { class: "field" }, [
            el("span", { class: "pane-label", text: "Base URL — requests under it inherit the headers and auth below" }),
            baseIn,
          ]),
          status
        );

        const ghCount = col.headers.filter((h) => h.k.trim()).length;
        const gh = el("details", { class: "section" }, [
          el("summary", { text: `Global headers (${ghCount})` }),
          headersEditor(col.headers),
        ]);
        if (ghCount) gh.open = true;
        mainBox.append(gh);

        const ga = el("details", { class: "section" }, [
          el("summary", { text: authSummary(col.auth) }),
          authEditor(col, ctx, { onChange: () => renderMain() }),
        ]);
        if (col.auth && col.auth.type && col.auth.type !== "none") ga.open = true;
        mainBox.append(ga);

        mainBox.append(swaggerSection(col, status));
        mainBox.append(shareSection(col, status));

        // the collection's own requests, listed and openable from here too
        const list = el("div", { class: "col-req-list" });
        if (!col.requests.length) {
          list.append(el("div", { class: "status-line dim", text: "No requests yet — press “+ Request”, import a Swagger doc, or press Save on any request tab." }));
        }
        for (const r of col.requests) {
          list.append(el("div", { class: "api-req-row", onclick: () => openSavedRequest(col, r) }, [
            el("span", { class: "api-method m" + (r.method || "GET"), text: r.method || "GET" }),
            el("span", { class: "api-req-name", text: r.name || "(unnamed)" }),
            el("span", { class: "api-req-path", text: r.path }),
          ]));
        }
        mainBox.append(el("details", { class: "section", open: "" }, [
          el("summary", { text: `Requests (${col.requests.length})` }),
          list,
        ]));
      }

      // ---- Swagger / OpenAPI import, targeting this collection -------------
      function swaggerSection(col, status) {
        const listBox = el("div", { style: "display:flex;flex-direction:column;gap:2px" });
        const importStatus = el("div", { class: "status-line dim" });
        const urlIn = el("input", { type: "text", placeholder: "https://api.example.com/swagger.json", value: d.swaggerUrl || "", style: "width:100%" });
        urlIn.addEventListener("input", () => { d.swaggerUrl = urlIn.value; ctx.save(); });

        return el("details", { class: "section" }, [
          el("summary", { text: "Import from Swagger / OpenAPI" }),
          el("div", { class: "status-line dim", text: `Endpoints are imported into “${col.name}”.` }),
          urlIn,
          el("div", { style: "margin:6px 0" }, [
            el("button", {
              class: "btn primary", text: "Load endpoints",
              onclick: () => loadSwagger(col, urlIn.value.trim(), listBox, importStatus),
            }),
          ]),
          importStatus,
          listBox,
        ]);
      }

      async function loadSwagger(col, url, box, importStatus) {
        if (!url) return setStatus(importStatus, "✗ Enter the Swagger/OpenAPI doc URL", "err");
        setStatus(importStatus, "Fetching Swagger doc…", "dim");
        box.replaceChildren();
        let doc;
        try {
          const r = await api("POST", "/api/proxy", { method: "GET", url });
          if (r.status >= 400) throw new Error("doc endpoint returned " + r.status);
          doc = JSON.parse(r.body);
        } catch (e) {
          return setStatus(importStatus, "✗ " + e.message, "err");
        }
        const { endpoints, baseUrl } = parseSwagger(doc, url);
        if (!endpoints.length) return setStatus(importStatus, "✗ No paths found in that document", "err");
        setStatus(importStatus, `✓ ${endpoints.length} endpoint(s)` + (baseUrl ? " · base " + baseUrl : ""), "ok");

        const checks = endpoints.map(() => {
          const c = el("input", { type: "checkbox" });
          c.checked = true;
          c.addEventListener("click", (e) => e.stopPropagation());
          return c;
        });
        const selectAll = el("input", { type: "checkbox" });
        selectAll.checked = true;
        selectAll.addEventListener("change", () => checks.forEach((c) => (c.checked = selectAll.checked)));

        // A Swagger doc usually has a title — offer it as the collection name
        // when the collection is still the untouched default.
        const title = (doc.info && doc.info.title) ? String(doc.info.title).trim() : "";
        const renameChk = el("input", { type: "checkbox" });
        renameChk.checked = !!title && /^(new collection|my collection)$/i.test(col.name);

        box.append(
          el("div", { class: "toolbar" }, [
            el("label", { class: "inline" }, [selectAll, "Select all"]),
            title ? el("label", { class: "inline" }, [renameChk, `Name the collection “${title}”`]) : null,
            el("button", {
              class: "btn primary", text: "Import selected",
              onclick: () => {
                if (!col.baseUrl && baseUrl) col.baseUrl = trimBase(baseUrl);
                if (title && renameChk.checked) col.name = title;
                let added = 0, skipped = 0;
                endpoints.forEach((ep, i) => {
                  if (!checks[i].checked) return;
                  if (col.requests.some((r) => r.method === ep.method && r.path === ep.path)) { skipped++; return; }
                  col.requests.push(newSavedRequest({ method: ep.method, path: ep.path, name: ep.name }));
                  added++;
                });
                ctx.save();
                setFlash(`✓ Added ${added} request(s) to “${col.name}”` + (skipped ? ` · ${skipped} already there` : ""), "ok");
                renderSide();
                renderMain();
              },
            }),
          ]),
          ...endpoints.map((ep, i) =>
            el("div", { class: "history-item", onclick: () => { checks[i].checked = !checks[i].checked; } }, [
              checks[i],
              el("span", { class: "api-method m" + ep.method, text: ep.method }),
              el("span", { class: "h-url", text: ep.path + (ep.name ? " — " + ep.name : "") }),
            ])
          )
        );
      }

      // ---- export / import one collection ------------------------------------
      function shareSection(col, status) {
        const shareStatus = el("div", { class: "status-line dim" });
        const withSecrets = el("input", { type: "checkbox" });

        const doExport = () => {
          const include = withSecrets.checked;
          const auth = JSON.parse(JSON.stringify(col.auth || { type: "none" }));
          if (!include) {
            // never write passwords/tokens into a file meant for sharing
            // unless the user explicitly asked for it
            for (const k of ["password", "token", "value"]) if (auth[k]) auth[k] = "";
          }
          const scrub = (a) => {
            const copy = JSON.parse(JSON.stringify(a || { type: "inherit" }));
            if (!include) for (const k of ["password", "token", "value"]) if (copy[k]) copy[k] = "";
            return copy;
          };
          const doc = {
            devtil: "api-collection",
            version: 2,
            exportedAt: new Date().toISOString(),
            containsCredentials: include,
            collection: {
              name: col.name,
              baseUrl: col.baseUrl || "",
              headers: (col.headers || []).filter((h) => (h.k || "").trim()),
              auth,
              requests: (col.requests || []).map((r) => ({
                name: r.name, method: r.method, path: r.path,
                headers: (r.headers || []).filter((h) => (h.k || "").trim()),
                body: r.body, auth: scrub(r.auth),
              })),
            },
          };
          const slug = (col.name || "collection").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
          downloadFile(`devtil-${slug || "collection"}.json`, "application/json", JSON.stringify(doc, null, 2));
          setStatus(shareStatus, include
            ? "✓ Exported with credentials — treat the file as a secret"
            : "✓ Exported — auth credentials left out; header values are included, so review before sharing",
            include ? "err" : "ok");
        };

        return el("details", { class: "section" }, [
          el("summary", { text: "Export this collection" }),
          el("div", { class: "status-line dim", text: "Writes the name, base URL, global headers, auth and every saved request to a JSON file. Import it from the Collections panel — it lands as a new collection." }),
          el("label", { class: "inline" }, [withSecrets, "Include credentials (passwords / tokens)"]),
          el("div", { class: "toolbar" }, [
            el("button", { class: "btn", text: "Export", onclick: doExport }),
          ]),
          shareStatus,
        ]);
      }

      // ---- request pane -------------------------------------------------------
      function renderRequestPane(r, view) {
        const col = owningCollection(r);
        const savedIn = r.reqId ? colById(r.colId) : null;
        const saved = savedIn ? savedIn.requests.find((x) => x.id === r.reqId) : null;

        const status = el("div", { class: "status-line dim" });
        showFlash(status);

        const nameIn = el("input", { type: "text", class: "req-name", value: r.name, title: "Request name" });
        nameIn.addEventListener("input", () => { r.name = nameIn.value; ctx.save(); });
        nameIn.addEventListener("change", () => renderMain(view));

        const where = saved
          ? el("span", { class: "req-origin", text: "in " + savedIn.name, title: "Saving updates this request in place" })
          : el("span", { class: "req-origin dim", text: "unsaved" });

        mainBox.append(el("div", { class: "req-head" }, [nameIn, where]));

        const methodSel = el("select", {}, ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].map((m) =>
          el("option", { value: m, text: m })));
        methodSel.value = r.method;
        methodSel.addEventListener("change", () => { r.method = methodSel.value; ctx.save(); });
        const urlInput = el("input", { type: "text", placeholder: "https://api.example.com/v1/users", value: r.url });
        urlInput.addEventListener("input", () => { r.url = urlInput.value; ctx.save(); });
        urlInput.addEventListener("keydown", (e) => { if (e.key === "Enter") send(); });
        const sendBtn = el("button", { class: "btn primary", text: "Send", onclick: () => send() });

        mainBox.append(el("div", { class: "req-line" }, [
          methodSel, urlInput, sendBtn,
          // wrap the handler: passing doSave directly would hand it the click
          // event as `forceNew`, making Save always behave as Save-as
          el("button", { class: "btn", text: saved ? "Save" : "Save…", title: saved ? "Update the saved request" : "Save into a collection", onclick: () => doSave(false) }),
          saved ? el("button", { class: "btn", text: "Save as…", title: "Save as a new request", onclick: () => doSave(true) }) : null,
        ]));

        // auth: falls back to the owning collection's when set to inherit
        const colAuthLabel = (col && col.auth && col.auth.type && col.auth.type !== "none")
          ? (AUTH_TYPES.find((x) => x.value === col.auth.type) || {}).label + " from " + col.name
          : "none set";
        const authDetails = el("details", { class: "section" }, [
          el("summary", { text: authSummary(r.auth, colAuthLabel) }),
          authEditor(r, ctx, { allowInherit: true, onChange: () => renderMain(view) }),
        ]);
        if (r.auth && r.auth.type && r.auth.type !== "inherit" && r.auth.type !== "none") authDetails.open = true;
        mainBox.append(authDetails);

        const hdrCount = r.headers.filter((h) => h.k.trim()).length;
        const hdrDetails = el("details", { class: "section" }, [
          el("summary", { text: `Request headers (${hdrCount})` }),
          headersEditor(r.headers),
        ]);
        if (hdrCount) hdrDetails.open = true;
        mainBox.append(hdrDetails);

        const bodyArea = el("textarea", { rows: "4", style: "width:100%", spellcheck: "false", placeholder: "Request body (raw / JSON)" });
        bodyArea.value = r.body || "";
        bodyArea.addEventListener("input", () => { r.body = bodyArea.value; ctx.save(); });
        mainBox.append(el("div", {}, [el("span", { class: "pane-label", text: "Body" }), bodyArea]));

        const insecure = el("input", { type: "checkbox" });
        insecure.checked = !!r.insecure;
        insecure.addEventListener("change", () => { r.insecure = insecure.checked; ctx.save(); });
        mainBox.append(el("div", { class: "toolbar" }, [
          el("label", { class: "inline" }, [insecure, "Skip TLS verification (dev servers)"]),
          status,
        ]));

        const respArea = el("div", { class: "tool", style: "flex:1" });
        mainBox.append(respArea);
        renderResponse(respArea, r, view);

        async function send() {
          if (!r.url.trim()) return setStatus(status, "✗ Enter a URL", "err");
          flash = null;
          sendBtn.disabled = true;
          setStatus(status, "Sending…", "dim");
          try {
            const headers = {};
            const owner = owningCollection(r);
            const under = !!owner && (!owner.baseUrl || r.url.trim().toLowerCase().startsWith(owner.baseUrl.toLowerCase()));
            if (owner && under) {
              for (const h of owner.headers) if (h.k.trim()) headers[h.k.trim()] = h.v;
            }
            // request auth wins; "inherit" falls back to the collection's auth
            const auth = (r.auth && r.auth.type && r.auth.type !== "inherit")
              ? r.auth
              : (owner && under ? owner.auth : null);
            const parts = authParts(auth);
            Object.assign(headers, parts.headers);
            // an explicit header always overrides the generated one
            for (const h of r.headers) if (h.k.trim()) headers[h.k.trim()] = h.v;
            const resp = await api("POST", "/api/proxy", {
              method: r.method, url: appendQuery(r.url.trim(), parts.query), headers, body: r.body, insecure: r.insecure,
            });
            r.response = resp;
            if (r.name === "New request") r.name = r.method + " " + (shortPath(r.url.trim()) || r.url.trim());
            d.history.unshift({ method: r.method, url: r.url.trim(), status: resp.status, durationMs: resp.durationMs, at: Date.now() });
            d.history.length = Math.min(d.history.length, 50);
            ctx.save();
            renderSide();
            renderMain();
          } catch (e) {
            setStatus(status, "✗ " + e.message, "err");
            sendBtn.disabled = false;
            ctx.save();
          }
        }

        // Saving an already-saved request updates it in place; anything else
        // asks where it should go, so nothing is filed somewhere by accident.
        async function doSave(forceNew) {
          const url = r.url.trim();
          if (!url) return setStatus(status, "✗ Enter a URL first", "err");

          if (saved && !forceNew) {
            Object.assign(saved, {
              name: r.name === "New request" ? saved.name : r.name,
              method: r.method,
              path: pathWithin(savedIn, url),
              headers: JSON.parse(JSON.stringify(r.headers)),
              body: r.body,
              auth: JSON.parse(JSON.stringify(r.auth)),
            });
            ctx.save();
            setStatus(status, `✓ Updated in ${savedIn.name}`, "ok");
            renderSide();
            return;
          }

          const choice = await saveRequestDialog({
            name: r.name === "New request" ? (r.method + " " + shortPath(url)) : r.name,
            colId: (savedIn && savedIn.id) || (col && col.id) || d.activeColId,
          });
          if (!choice) return;
          let target = colById(choice.colId);
          if (!target) {
            target = newCollection(choice.newName || "New collection");
            d.collections.push(target);
          }
          const rec = newSavedRequest({
            name: choice.name, method: r.method, path: pathWithin(target, url),
            headers: JSON.parse(JSON.stringify(r.headers)), body: r.body,
            auth: JSON.parse(JSON.stringify(r.auth)),
          });
          target.requests.push(rec);
          r.name = choice.name;
          r.colId = target.id;
          r.reqId = rec.id;
          d.activeColId = target.id;
          target.collapsed = false;
          ctx.save();
          setFlash(`✓ Saved to ${target.name}`, "ok");
          sideView = "collections";
          renderSide();
          renderMain(view);
        }
      }

      // A saved request stores a path relative to its collection's base URL
      // when it sits under it, so re-pointing the base URL moves every request.
      function pathWithin(col, url) {
        const base = trimBase(col && col.baseUrl);
        if (base && url.toLowerCase().startsWith(base.toLowerCase())) return url.slice(base.length) || "/";
        return url;
      }

      // ---- "save into which collection?" ---------------------------------
      function saveRequestDialog({ name, colId }) {
        return new Promise((resolve) => {
          const overlay = el("div", { class: "app-dialog-overlay" });
          const close = (val) => { overlay.remove(); document.removeEventListener("keydown", onKey); resolve(val); };
          const onKey = (e) => {
            e.stopPropagation();
            if (e.key === "Escape") close(null);
          };
          document.addEventListener("keydown", onKey);

          const nameIn = el("input", { class: "app-dialog-input", type: "text", value: name || "" });
          const colSel = el("select", { class: "app-dialog-input" }, [
            ...d.collections.map((c) => el("option", { value: c.id, text: c.name })),
            el("option", { value: "__new__", text: "＋ New collection…" }),
          ]);
          colSel.value = colId && d.collections.some((c) => c.id === colId) ? colId : d.collections[0].id;

          const newNameIn = el("input", { class: "app-dialog-input", type: "text", placeholder: "New collection name" });
          const newNameRow = el("div", { class: "field", style: "display:none" }, [
            el("span", { class: "pane-label", text: "New collection name" }), newNameIn,
          ]);
          colSel.addEventListener("change", () => {
            const isNew = colSel.value === "__new__";
            newNameRow.style.display = isNew ? "" : "none";
            if (isNew) newNameIn.focus();
          });

          const submit = () => {
            const n = nameIn.value.trim();
            if (!n) return nameIn.focus();
            if (colSel.value === "__new__") {
              const cn = newNameIn.value.trim();
              if (!cn) return newNameIn.focus();
              return close({ name: n, colId: null, newName: cn });
            }
            close({ name: n, colId: colSel.value });
          };

          overlay.append(el("div", { class: "app-dialog" }, [
            el("div", { class: "app-dialog-msg", text: "Save request" }),
            el("div", { class: "field" }, [el("span", { class: "pane-label", text: "Name" }), nameIn]),
            el("div", { class: "field" }, [el("span", { class: "pane-label", text: "Collection" }), colSel]),
            newNameRow,
            el("div", { class: "app-dialog-actions" }, [
              el("button", { class: "btn", text: "Cancel", onclick: () => close(null) }),
              el("button", { class: "btn primary", text: "Save", onclick: submit }),
            ]),
          ]));
          overlay.addEventListener("click", (e) => { if (e.target === overlay) close(null); });
          for (const inp of [nameIn, newNameIn]) {
            inp.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); submit(); } });
          }
          document.body.append(overlay);
          nameIn.focus();
          nameIn.select();
        });
      }

      function renderResponse(respArea, r, view) {
        respArea.replaceChildren();
        const resp = r.response;
        if (resp) {
          respArea.append(el("div", { class: "resp-meta" }, [
            el("span", { class: "badge s" + String(resp.status)[0], text: resp.status + " " + resp.statusText }),
            el("span", { text: resp.durationMs + " ms" }),
            el("span", { text: fmtBytes(resp.size) + (resp.truncated ? " (truncated)" : "") }),
            copyBtn(() => resp.body, "Copy body"),
          ]));
        }
        respArea.append(el("div", { class: "subtabs" }, [
          el("button", { class: view === "body" ? "active" : "", text: "Response body", onclick: () => renderResponse(respArea, r, "body") }),
          el("button", { class: view === "headers" ? "active" : "", text: "Response headers", onclick: () => renderResponse(respArea, r, "headers") }),
        ]));
        if (!resp) {
          return respArea.append(el("div", { class: "status-line dim", text: "Send the request to see the response here" }));
        }
        if (view === "headers") {
          respArea.append(el("table", { class: "kv" }, Object.entries(resp.headers || {}).map(([k, v]) =>
            el("tr", {}, [el("th", { text: k }), el("td", { text: v })])
          )));
        } else {
          let body = resp.body;
          try { body = JSON.stringify(JSON.parse(resp.body), null, 2); } catch { /* not JSON */ }
          respArea.append(el("pre", { class: "output", text: body }));
        }
      }

      renderSide();
      renderMain();
    },
  });

  // ======================================================================
  // Kube Logs
  // ======================================================================
  // Live tail timers, dedup sets, the set of panels currently tailing, and the
  // maximized panel live in a module-level registry keyed by tab id so they
  // survive the tool being re-rendered on every tab switch (otherwise switching
  // away and back would silently stop live tails).
  const kubeReg = {};
  onSessionSweep((live) => {
    for (const tabId of Object.keys(kubeReg)) {
      const reg = kubeReg[tabId];
      if (live.has(tabId)) {
        if (reg._disposeTimer) { clearTimeout(reg._disposeTimer); reg._disposeTimer = null; }
      } else if (!reg._disposeTimer) {
        reg._disposeTimer = setTimeout(() => {
          for (const id in reg.timers) clearInterval(reg.timers[id]);
          delete kubeReg[tabId];
        }, SESSION_TTL_MS);
      }
    }
  });

  registerTool({
    type: "kube",
    icon: "☸️",
    name: "Kube Console",
    desc: "Connect to the kubemaster over SSH (password), find pods, then open a terminal panel per container — tail logs, run commands, search folders.",
    defaults: () => ({
      connections: [], activeConnId: null,
      sshHost: "", sshPort: "", sshPassword: "",
      context: "", namespace: "", podQuery: "", panels: [],
    }),
    subTabs: (d, tab) => (d.panels || []).map((p) => ({
      id: p.id,
      label: p.pod + " › " + p.container,
      select: () => {
        p.minimized = false;
        // un-maximize so the selected panel is actually visible
        const reg = tab && kubeReg[tab.id];
        if (reg && reg.maximizedId && reg.maximizedId !== p.id) reg.maximizedId = null;
      },
      remove: () => {
        const i = d.panels.findIndex((x) => x.id === p.id);
        if (i >= 0) d.panels.splice(i, 1);
      },
    })),
    render(root, tab, ctx) {
      const d = tab.data;
      if (!Array.isArray(d.panels)) d.panels = [];
      // Saved clusters. The form fields stay the working copy — selecting a
      // saved connection loads it in, Save writes it back — so everything that
      // worked before still works, and a host you use daily is now one pick
      // away instead of a retyped password.
      if (!Array.isArray(d.connections)) d.connections = [];
      for (const c of d.connections) if (!c.id) c.id = uid();
      if ((d.sshHost || "").trim() && !d.connections.length) {
        // the single unnamed connection this tool used to have
        d.connections.push({
          id: uid(), name: d.sshHost, sshHost: d.sshHost, sshPort: d.sshPort,
          sshPassword: d.sshPassword, context: d.context, namespace: d.namespace,
        });
        d.activeConnId = d.connections[0].id;
        ctx.save();
      }
      const status = el("div", { class: "status-line dim" });
      const podBox = el("div");
      const svcBox = el("div");
      const panelsArea = el("div", { class: "kube-panels" });

      // runtime-only state (not persisted), kept per-tab so live tails survive
      // tab switches — see kubeReg above.
      if (!kubeReg[tab.id]) kubeReg[tab.id] = { timers: {}, tailSeen: {}, tailing: new Set(), maximizedId: null };
      const reg = kubeReg[tab.id];
      const timers = reg.timers;
      const tailSeen = reg.tailSeen;

      const ctxSel = el("select", { style: "min-width:160px" });
      const nsSel = el("select", { style: "min-width:160px" });
      const sshHost = bindField(el("input", { type: "text", placeholder: "user@kubemaster", style: "min-width:200px" }), d, "sshHost", ctx);
      const sshPort = bindField(el("input", { type: "text", placeholder: "22", style: "width:70px" }), d, "sshPort", ctx);
      const sshPassword = bindField(el("input", { type: "password", placeholder: "ssh password", style: "min-width:170px" }), d, "sshPassword", ctx);
      const podQuery = bindField(el("input", { type: "text", placeholder: "service / pod name filter" }), d, "podQuery", ctx);

      const connQS = () =>
        "context=" + encodeURIComponent(d.context || "") +
        "&sshHost=" + encodeURIComponent(d.sshHost || "") +
        "&sshPort=" + encodeURIComponent(d.sshPort || "") +
        "&sshPassword=" + encodeURIComponent(d.sshPassword || "");
      const connBody = () => ({
        context: d.context,
        sshHost: d.sshHost, sshPort: d.sshPort, sshPassword: d.sshPassword,
      });
      const shq = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";

      // ---------- container terminal panels ----------

      function openPanel(pod, container) {
        let p = d.panels.find((x) => x.pod === pod && x.container === container);
        if (!p) {
          p = { id: uid(), pod, container, output: "", cmd: "", dir: "/var/log", term: "", tailN: "500", minimized: false };
          d.panels.push(p);
        } else {
          p.minimized = false;
        }
        reg.maximizedId = null;
        ctx.save();
        renderPanels();
      }

      function stopAllTails() {
        for (const id in timers) { clearInterval(timers[id]); delete timers[id]; }
      }

      function renderPanels() {
        stopAllTails(); // DOM is about to be rebuilt; drop stale intervals
        panelsArea.replaceChildren();
        if (!d.panels.length) {
          panelsArea.append(el("div", { class: "status-line dim", text: "No panels open. Click a container above to open a terminal for it." }));
          return;
        }
        // a maximized panel can be removed elsewhere (tab tree, another render);
        // a stale id would filter every panel out and leave the area blank
        if (reg.maximizedId && !d.panels.some((p) => p.id === reg.maximizedId)) reg.maximizedId = null;
        const list = reg.maximizedId ? d.panels.filter((p) => p.id === reg.maximizedId) : d.panels;
        for (const panel of list) {
          const node = buildPanel(panel);
          panelsArea.append(node);
          // resume a live tail that was running before this re-render / tab switch
          if (reg.tailing.has(panel.id) && node._startTail) node._startTail();
        }
      }

      function buildPanel(panel) {
        const outPre = el("pre", { class: "kube-panel-out" });
        outPre.textContent = panel.output || "";

        const append = (text) => {
          let buf = (panel.output || "") + text;
          if (buf.length > 120000) buf = buf.slice(buf.length - 120000);
          panel.output = buf;
          outPre.textContent = buf;
          outPre.scrollTop = outPre.scrollHeight;
          ctx.save();
        };

        // command bar
        const cmdInput = el("input", { type: "text", class: "kube-cmd", placeholder: "run a command in this container, e.g. ls -la /var/log", value: panel.cmd || "" });
        cmdInput.addEventListener("input", () => { panel.cmd = cmdInput.value; ctx.save(); });
        const runCmd = async (command) => {
          command = (command != null ? command : cmdInput.value).trim();
          if (!command) return;
          append("$ " + command + "\n");
          try {
            const r = await api("POST", "/api/kube/exec", {
              ...connBody(), namespace: d.namespace, pod: panel.pod, container: panel.container, command,
            });
            append((r.output || "") + ((r.output || "").endsWith("\n") ? "" : "\n"));
          } catch (e) {
            append("✗ " + e.message + "\n");
          }
        };
        cmdInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { runCmd(); cmdInput.value = ""; panel.cmd = ""; ctx.save(); } });

        // tail / logs
        const tailN = el("input", { type: "number", min: "1", max: "5000", style: "width:70px", value: panel.tailN || "500" });
        tailN.addEventListener("input", () => { panel.tailN = tailN.value; ctx.save(); });
        const tailBtn = el("button", { class: "btn", text: timers[panel.id] ? "⏸ Stop" : "▶ Tail" });
        const stopTail = () => {
          if (timers[panel.id]) { clearInterval(timers[panel.id]); delete timers[panel.id]; }
          reg.tailing.delete(panel.id);
          tailBtn.textContent = "▶ Tail";
        };
        const startTail = () => {
          if (timers[panel.id]) return;
          reg.tailing.add(panel.id); // remembered so the tail resumes after a tab switch
          tailSeen[panel.id] = new Set();
          append("── tailing " + panel.container + " (stdout) ──\n");
          tailBtn.textContent = "⏸ Stop";
          const poll = async () => {
            if (!outPre.isConnected) { stopTail(); return; } // panel was rebuilt/closed
            try {
              const r = await api("POST", "/api/kube/logs", {
                ...connBody(), namespace: d.namespace, pods: [panel.pod], container: panel.container,
                tail: 500, sinceSeconds: 8, source: "stdout",
              });
              const seen = tailSeen[panel.id];
              let add = "";
              for (const line of (r.lines || [])) {
                if (!seen.has(line)) { seen.add(line); add += line + "\n"; }
              }
              if (seen.size > 8000) tailSeen[panel.id] = new Set();
              if (add) append(add);
            } catch (e) { /* transient; keep polling */ }
          };
          poll();
          timers[panel.id] = setInterval(poll, 2500);
        };
        const toggleTail = () => (timers[panel.id] ? stopTail() : startTail());
        tailBtn.addEventListener("click", toggleTail);
        const logsOnce = async () => {
          try {
            const r = await api("POST", "/api/kube/logs", {
              ...connBody(), namespace: d.namespace, pods: [panel.pod], container: panel.container,
              tail: Number(panel.tailN) || 500, source: "stdout",
            });
            append((r.lines || []).join("\n") + "\n");
          } catch (e) {
            append("✗ " + e.message + "\n");
          }
        };

        // folder search
        const dirIn = el("input", { type: "text", placeholder: "/var/log", style: "width:150px", value: panel.dir || "" });
        dirIn.addEventListener("input", () => { panel.dir = dirIn.value; ctx.save(); });
        const termIn = el("input", { type: "text", placeholder: "text to find (blank = list files)", style: "flex:1;min-width:120px", value: panel.term || "" });
        termIn.addEventListener("input", () => { panel.term = termIn.value; ctx.save(); });
        const searchFolder = () => {
          const dir = (panel.dir || "").trim() || "/var/log";
          const term = (panel.term || "").trim();
          const cmd = term
            ? `grep -rIn ${shq(term)} ${shq(dir)} 2>/dev/null | head -n 500`
            : `ls -la ${shq(dir)}`;
          runCmd(cmd);
        };

        // header controls
        const headBtn = (txt, title, fn) => el("button", { class: "icon-btn", text: txt, title, onclick: fn });
        const head = el("div", { class: "kube-panel-head" }, [
          el("span", { class: "kube-panel-title", text: panel.pod + " › " + panel.container }),
          headBtn(panel.minimized ? "▸" : "▾", "Minimize / expand", () => { panel.minimized = !panel.minimized; ctx.save(); renderPanels(); }),
          headBtn(reg.maximizedId === panel.id ? "🗗" : "🗖", "Maximize / restore", () => { reg.maximizedId = reg.maximizedId === panel.id ? null : panel.id; renderPanels(); }),
          headBtn("×", "Close panel", () => { stopTail(); d.panels = d.panels.filter((x) => x.id !== panel.id); if (reg.maximizedId === panel.id) reg.maximizedId = null; ctx.save(); renderPanels(); }),
        ]);

        const bodyEl = el("div", { class: "kube-panel-body" }, [
          el("div", { class: "toolbar" }, [
            el("button", { class: "btn", text: "Logs", title: "Fetch the last N log lines", onclick: logsOnce }),
            tailBtn, el("label", { class: "inline" }, ["last", tailN]),
            el("button", { class: "btn", text: "Clear", onclick: () => { panel.output = ""; outPre.textContent = ""; ctx.save(); } }),
            copyBtn(() => panel.output || "", "Copy"),
          ]),
          el("div", { class: "toolbar" }, [
            el("span", { class: "pane-label", text: "Search folder" }), dirIn, termIn,
            el("button", { class: "btn", text: "Search", onclick: searchFolder }),
          ]),
          outPre,
          el("div", { class: "kube-cmd-bar" }, [
            cmdInput,
            el("button", { class: "btn primary", text: "Run", onclick: () => { runCmd(); cmdInput.value = ""; panel.cmd = ""; ctx.save(); } }),
          ]),
        ]);
        bodyEl.style.display = panel.minimized ? "none" : "";

        const cls = "kube-panel" + (reg.maximizedId === panel.id ? " max" : "") + (panel.minimized ? " min" : "");
        const node = el("div", { class: cls }, [head, bodyEl]);
        node._startTail = startTail; // let renderPanels resume a live tail after a switch
        outPre.scrollTop = outPre.scrollHeight;
        return node;
      }

      // ---------- pods & connection ----------

      const renderPods = (pods) => {
        podBox.replaceChildren();
        if (!pods.length) return podBox.append(el("div", { class: "status-line dim", text: "No pods matched." }));
        const table = el("table", { class: "kv" }, [
          el("tr", {}, [el("th", { text: "Pod" }), el("th", { text: "Status" }), el("th", { text: "Containers — click to open a terminal" })]),
        ]);
        for (const p of pods) {
          const containers = (p.containers || []).length ? p.containers : [""];
          table.append(el("tr", {}, [
            el("td", { text: p.name }),
            el("td", { text: p.status }),
            el("td", {}, containers.map((cn) =>
              el("button", { class: "btn chip", text: cn || "(default)", title: "Open a terminal panel for this container", onclick: () => openPanel(p.name, cn) })
            )),
          ]));
        }
        podBox.append(table);
      };

      const fillSelect = (sel, values, current) => {
        sel.replaceChildren(...values.map((v) => el("option", { value: v, text: v })));
        if (values.includes(current)) sel.value = current;
      };

      async function loadContexts() {
        setStatus(status, "Loading contexts…", "dim");
        try {
          const r = await api("GET", "/api/kube/contexts?" + connQS());
          fillSelect(ctxSel, r.contexts || [], d.context || r.current);
          d.context = ctxSel.value || "";
          ctx.save();
        } catch (e) {
          return setStatus(status, "✗ " + e.message, "err");
        }
        await loadNamespaces();
      }
      async function loadNamespaces() {
        setStatus(status, "Loading namespaces…", "dim");
        try {
          const r = await api("GET", "/api/kube/namespaces?" + connQS());
          fillSelect(nsSel, r.namespaces || [], d.namespace);
          d.namespace = nsSel.value;
          ctx.save();
          setStatus(status, "", "dim");
        } catch (e) {
          setStatus(status, "✗ " + e.message, "err");
        }
      }
      async function loadPods() {
        if (!d.namespace) return setStatus(status, "✗ Pick a namespace first (Connect)", "err");
        setStatus(status, "Finding pods…", "dim");
        try {
          const r = await api("GET", "/api/kube/pods?" + connQS() +
            "&namespace=" + encodeURIComponent(d.namespace) + "&query=" + encodeURIComponent(d.podQuery || ""));
          renderPods(r.pods || []);
          setStatus(status, `✓ ${r.pods.length} pod(s) — click a container to open a terminal`, "ok");
        } catch (e) {
          setStatus(status, "✗ " + e.message, "err");
        }
      }

      ctxSel.addEventListener("change", () => { d.context = ctxSel.value; ctx.save(); loadNamespaces(); });
      nsSel.addEventListener("change", () => { d.namespace = nsSel.value; ctx.save(); });
      podQuery.addEventListener("keydown", (e) => { if (e.key === "Enter") loadPods(); });

      // ---------- services ----------
      // A cluster is easier to reason about through its services than its
      // pods, so this lists them and resolves one to the pods it fronts.
      async function loadServices() {
        if (!d.namespace) return setStatus(status, "✗ Pick a namespace first (Connect)", "err");
        setStatus(status, "Finding services…", "dim");
        try {
          const r = await api("GET", "/api/kube/services?" + connQS() +
            "&namespace=" + encodeURIComponent(d.namespace) + "&query=" + encodeURIComponent(d.podQuery || ""));
          renderServices(r.services || []);
          setStatus(status, `✓ ${r.count} service(s) — click one to see the pods behind it`, "ok");
        } catch (e) {
          svcBox.replaceChildren();
          setStatus(status, "✗ " + e.message, "err");
        }
      }

      function renderServices(list) {
        svcBox.replaceChildren();
        if (!list.length) {
          svcBox.append(el("div", { class: "status-line dim", text: "No services matched." }));
          return;
        }
        const rows = list.map((sv) => el("tr", {}, [
          el("td", {}, [el("a", {
            class: "svc-link", text: sv.name,
            title: sv.selects ? "Show the pods this service selects" : "This service has no pod selector",
            onclick: () => sv.selects ? podsForSelector(sv.name, sv.selects) : setStatus(status, `${sv.name} has no pod selector (type ${sv.type})`, "err"),
          })]),
          el("td", { text: sv.type || "" }),
          el("td", { text: (sv.ports || []).join(", ") }),
          el("td", { class: "svc-sel", text: sv.selects || "—" }),
        ]));
        svcBox.append(el("table", { class: "kv svc-table" }, [
          el("tr", {}, [el("th", { text: "Service" }), el("th", { text: "Type" }), el("th", { text: "Ports" }), el("th", { text: "Selector" })]),
          ...rows,
        ]));
      }

      async function podsForSelector(name, selector) {
        setStatus(status, `Finding pods for ${name}…`, "dim");
        try {
          const r = await api("GET", "/api/kube/pods?" + connQS() +
            "&namespace=" + encodeURIComponent(d.namespace) + "&selector=" + encodeURIComponent(selector));
          renderPods(r.pods || []);
          setStatus(status, `✓ ${r.pods.length} pod(s) behind ${name} (${selector}) — click a container to open a terminal`, "ok");
        } catch (e) {
          setStatus(status, "✗ " + e.message, "err");
        }
      }

      // ---------- saved connections ----------
      const connSel = el("select", { style: "min-width:180px" });
      const loadFields = () => {
        sshHost.value = d.sshHost || "";
        sshPort.value = d.sshPort || "";
        sshPassword.value = d.sshPassword || "";
      };
      const fillConnSel = () => {
        connSel.replaceChildren(
          el("option", { value: "", text: d.connections.length ? "— unsaved —" : "— no saved clusters —" }),
          ...d.connections.map((c) => el("option", { value: c.id, text: c.name }))
        );
        connSel.value = d.connections.some((c) => c.id === d.activeConnId) ? d.activeConnId : "";
      };
      connSel.addEventListener("change", () => {
        const c = d.connections.find((x) => x.id === connSel.value);
        d.activeConnId = c ? c.id : null;
        if (c) {
          d.sshHost = c.sshHost || ""; d.sshPort = c.sshPort || "";
          d.sshPassword = c.sshPassword || "";
          d.context = c.context || ""; d.namespace = c.namespace || "";
          loadFields();
          if (d.context) fillSelect(ctxSel, [d.context], d.context);
          if (d.namespace) fillSelect(nsSel, [d.namespace], d.namespace);
          setStatus(status, `Loaded “${c.name}” — press Connect to list contexts and namespaces`, "dim");
        }
        ctx.save();
      });

      async function saveConnection() {
        if (!(d.sshHost || "").trim()) return setStatus(status, "✗ Enter an SSH host before saving", "err");
        const existing = d.connections.find((c) => c.id === d.activeConnId);
        const name = await promptDialog("Name for this cluster:", existing ? existing.name : d.sshHost);
        if (!name || !name.trim()) return;
        const fields = {
          name: name.trim(), sshHost: d.sshHost, sshPort: d.sshPort,
          sshPassword: d.sshPassword, context: d.context, namespace: d.namespace,
        };
        // The name is the identity: saving over an existing name updates that
        // cluster, a new name creates one. Falling back to "whatever is
        // selected" would silently rename the cluster you had loaded.
        let target = d.connections.find((c) => c.name === fields.name);
        if (target) Object.assign(target, fields);
        else {
          target = { id: uid(), ...fields };
          d.connections.push(target);
        }
        d.activeConnId = target.id;
        ctx.save();
        fillConnSel();
        setStatus(status, `✓ Saved “${fields.name}” — agents can reach it by that name over MCP`, "ok");
      }

      async function deleteConnection() {
        const c = d.connections.find((x) => x.id === d.activeConnId);
        if (!c) return setStatus(status, "✗ Pick a saved cluster to delete", "err");
        if (!(await confirmDialog(`Delete the saved cluster “${c.name}”?`, { okLabel: "Delete", danger: true }))) return;
        d.connections = d.connections.filter((x) => x.id !== c.id);
        d.activeConnId = null;
        ctx.save();
        fillConnSel();
        setStatus(status, `Deleted “${c.name}”`, "dim");
      }

      const field = (label, node) => el("div", { class: "field" }, [el("span", { text: label }), node]);

      root.append(
        el("div", { class: "form-grid" }, [
          field("Saved cluster", connSel),
          el("button", { class: "btn", text: "💾 Save", title: "Save these connection details under a name (agents can then use it by name)", onclick: saveConnection }),
          el("button", { class: "btn danger", text: "Delete", title: "Delete the selected saved cluster", onclick: deleteConnection }),
        ]),
        el("div", { class: "form-grid" }, [
          field("SSH host — kubectl runs here", sshHost),
          field("SSH port", sshPort),
          field("SSH password", sshPassword),
          el("button", { class: "btn", text: "⟳ Connect", title: "Load contexts & namespaces", onclick: loadContexts }),
        ]),
        el("div", { class: "form-grid" }, [
          field("Context", ctxSel),
          field("Namespace", nsSel),
          field("Service / pod filter", podQuery),
          el("button", { class: "btn", text: "Find services", onclick: loadServices }),
          el("button", { class: "btn primary", text: "Find pods", onclick: loadPods }),
        ]),
        svcBox,
        podBox,
        status,
        panelsArea
      );
      renderPanels();
      fillConnSel();
      if (d.context) fillSelect(ctxSel, [d.context], d.context);
      if (d.namespace) fillSelect(nsSel, [d.namespace], d.namespace);
    },
  });

  // ======================================================================
  // SSH / PuTTY — multiple SSH terminal sessions in one tab, with a shared
  // command bar that broadcasts to all sessions (MobaXterm-style multi-exec)
  // ======================================================================
  // Live terminals must survive the tool being re-rendered on every tab
  // switch, so their xterm instances, WebSockets and panel DOM nodes live in
  // a module-level registry keyed by tab id (never serialized).
  const puttyReg = {};

  // When a PuTTY tab is closed, keep its terminals connected for SESSION_TTL_MS
  // (so briefly closing/reopening — or an accidental close — doesn't drop the
  // shell), then dispose them. Re-opening the tab within the window cancels the
  // teardown.
  onSessionSweep((live) => {
    for (const tabId of Object.keys(puttyReg)) {
      const reg = puttyReg[tabId];
      if (live.has(tabId)) {
        if (reg._disposeTimer) { clearTimeout(reg._disposeTimer); reg._disposeTimer = null; }
      } else if (!reg._disposeTimer) {
        reg._disposeTimer = setTimeout(() => {
          for (const id in reg.rt) {
            try { reg.rt[id].ro && reg.rt[id].ro.disconnect(); } catch (e) {}
            try { reg.rt[id].ws && reg.rt[id].ws.close(); } catch (e) {}
            try { reg.rt[id].term && reg.rt[id].term.dispose(); } catch (e) {}
          }
          delete puttyReg[tabId];
        }, SESSION_TTL_MS);
      }
    }
  });

  registerTool({
    type: "putty",
    icon: "🖥️",
    name: "SSH / PuTTY",
    desc: "Interactive SSH terminals (real PTY over WebSocket): multiple sessions in one tab, broadcast typing to all, minimize/maximize/close each.",
    defaults: () => ({ sessions: [], savedHosts: [], newHost: "", newPort: "22", newUser: "", newPass: "", shared: "" }),
    subTabs: (d, tab) => (d.sessions || []).map((s) => ({
      id: s.id,
      label: (s.username ? s.username + "@" : "") + s.host + ":" + (s.port || "22"),
      select: () => {
        s.minimized = false;
        // un-maximize so the selected session is actually visible
        const reg = tab && puttyReg[tab.id];
        if (reg && reg.maximizedId && reg.maximizedId !== s.id) reg.maximizedId = null;
      },
      remove: () => {
        const i = d.sessions.findIndex((x) => x.id === s.id);
        if (i >= 0) d.sessions.splice(i, 1);
      },
    })),
    render(root, tab, ctx) {
      const d = tab.data;
      if (!Array.isArray(d.sessions)) d.sessions = [];
      if (!puttyReg[tab.id]) puttyReg[tab.id] = { rt: {}, nodes: {}, maximizedId: null, resizeWired: false };
      const reg = puttyReg[tab.id];
      const rt = reg.rt;      // session id → { term, fit, ws, wired }
      const nodes = reg.nodes; // session id → persistent panel DOM node

      const status = el("div", { class: "status-line dim" });
      const panelsArea = el("div", { class: "kube-panels" });
      const hasXterm = typeof window.Terminal === "function" && window.FitAddon;

      const themeColors = () => {
        const dark = document.documentElement.getAttribute("data-theme") === "dark";
        return dark
          ? { background: "#201515", foreground: "#fffefb", cursor: "#ff6a2b" }
          : { background: "#fffefb", foreground: "#201515", cursor: "#ff4f00" };
      };

      function connect(s) {
        const r = rt[s.id];
        if (!r || !r.term) return;
        const proto = location.protocol === "https:" ? "wss" : "ws";
        const ws = new WebSocket(proto + "://" + location.host + "/api/ssh/pty");
        ws.binaryType = "arraybuffer";
        r.ws = ws;
        ws.onopen = () => {
          try { r.fit.fit(); } catch (e) { /* not laid out yet */ }
          ws.send(JSON.stringify({ type: "start", host: s.host, port: s.port, username: s.username, password: s.password, cols: r.term.cols, rows: r.term.rows }));
          r.term.focus();
        };
        ws.onmessage = (ev) => {
          if (typeof ev.data === "string") r.term.write(ev.data);
          else r.term.write(new Uint8Array(ev.data));
        };
        ws.onclose = () => { try { r.term.write("\r\n\x1b[33m[disconnected — use ⟳ to reconnect]\x1b[0m\r\n"); } catch (e) {} };
        ws.onerror = () => {};
      }

      function ensureTerm(s, hostEl) {
        let r = rt[s.id];
        if (r && r.wired) {
          // Panel node was re-shown (tab switch back, sibling closed). Re-fit on
          // the next frame, once layout has settled, then repaint the buffer.
          // (A per-terminal ResizeObserver handles later size changes.)
          requestAnimationFrame(() => {
            try {
              r.fit.fit();
              if (r.ws && r.ws.readyState === 1) r.ws.send(JSON.stringify({ type: "resize", cols: r.term.cols, rows: r.term.rows }));
              r.term.refresh(0, r.term.rows - 1);
            } catch (e) { /* ignore */ }
          });
          return;
        }
        const term = new Terminal({ fontFamily: "ui-monospace, Menlo, Consolas, monospace", fontSize: 12, cursorBlink: true, scrollback: 5000, rightClickSelectsWord: true, theme: themeColors() });
        const fit = new FitAddon.FitAddon();
        term.loadAddon(fit);
        term.open(hostEl);
        try { fit.fit(); } catch (e) { /* ignore */ }
        // clipboard: Ctrl+Shift+C copies the selection, Ctrl+Shift+V pastes.
        // (plain Ctrl+C must stay as SIGINT for the shell.)
        term.attachCustomKeyEventHandler((e) => {
          if (e.type !== "keydown") return true;
          if (e.ctrlKey && e.shiftKey && (e.key === "C" || e.key === "c")) {
            const sel = term.getSelection();
            if (sel) navigator.clipboard.writeText(sel).catch(() => {});
            return false;
          }
          if (e.ctrlKey && e.shiftKey && (e.key === "V" || e.key === "v")) {
            navigator.clipboard.readText().then((t) => {
              const w = rt[s.id] && rt[s.id].ws;
              if (t && w && w.readyState === 1) w.send(JSON.stringify({ type: "input", data: t }));
            }).catch(() => {});
            return false;
          }
          return true;
        });
        // copy the selection to the clipboard as soon as it's made (xterm/Linux style)
        term.onSelectionChange(() => {
          const sel = term.getSelection();
          if (sel) navigator.clipboard.writeText(sel).catch(() => {});
        });
        term.onData((data) => { const w = rt[s.id] && rt[s.id].ws; if (w && w.readyState === 1) w.send(JSON.stringify({ type: "input", data })); });
        term.onResize(({ cols, rows }) => { const w = rt[s.id] && rt[s.id].ws; if (w && w.readyState === 1) w.send(JSON.stringify({ type: "resize", cols, rows })); });
        // Re-fit whenever the panel's box actually resizes — e.g. when a sibling
        // panel is opened or closed and this one grows/shrinks. The observer
        // fires after layout has settled, so fit() measures the correct size and
        // xterm reflows + repaints; without it the terminal keeps its old buffer
        // rendered blank until the next window resize.
        let ro = null;
        if (typeof ResizeObserver === "function") {
          ro = new ResizeObserver(() => {
            const rr = rt[s.id];
            if (rr && rr.fit) { try { rr.fit.fit(); } catch (e) { /* not laid out */ } }
          });
          try { ro.observe(hostEl); } catch (e) { /* ignore */ }
        }
        rt[s.id] = { term, fit, ws: null, wired: true, ro };
        connect(s);
      }

      function reconnect(s) {
        const r = rt[s.id];
        if (r && r.ws) { try { r.ws.close(); } catch (e) {} }
        if (r && r.term) r.term.write("\r\n\x1b[36m[reconnecting…]\x1b[0m\r\n");
        connect(s);
      }

      function disposeSession(s) {
        const r = rt[s.id];
        if (r) {
          try { r.ro && r.ro.disconnect(); } catch (e) {}
          try { r.ws && r.ws.close(); } catch (e) {}
          try { r.term && r.term.dispose(); } catch (e) {}
          delete rt[s.id];
        }
        delete nodes[s.id];
      }

      function buildNode(s) {
        const hostEl = el("div", { class: "term-host" });
        const headBtn = (txt, title, fn) => el("button", { class: "icon-btn", text: txt, title, onclick: fn });
        const castBtn = el("button", {
          class: "icon-btn cast" + (s.broadcast ? " on" : ""),
          text: s.broadcast ? "📡 on" : "📡 off",
          title: "Include this session when broadcasting a shared command",
          onclick: () => { s.broadcast = !s.broadcast; castBtn.className = "icon-btn cast" + (s.broadcast ? " on" : ""); castBtn.textContent = s.broadcast ? "📡 on" : "📡 off"; ctx.save(); },
        });
        const body = el("div", { class: "kube-panel-body term-body" }, [hostEl]);
        const copySel = () => {
          const r = rt[s.id];
          const sel = r && r.term ? r.term.getSelection() : "";
          if (sel) navigator.clipboard.writeText(sel).catch(() => {});
        };
        const pasteClip = () => {
          navigator.clipboard.readText().then((t) => {
            const w = rt[s.id] && rt[s.id].ws;
            if (t && w && w.readyState === 1) w.send(JSON.stringify({ type: "input", data: t }));
          }).catch(() => {});
        };
        const head = el("div", { class: "kube-panel-head" }, [
          el("span", { class: "kube-panel-title", text: (s.username ? s.username + "@" : "") + s.host + ":" + s.port }),
          castBtn,
          headBtn("⧉", "Copy selection (Ctrl+Shift+C, or auto-copies on select)", copySel),
          headBtn("📋", "Paste (Ctrl+Shift+V)", pasteClip),
          headBtn("⟳", "Reconnect", () => reconnect(s)),
          headBtn("▾", "Minimize / expand", () => { s.minimized = !s.minimized; ctx.save(); renderPanels(); }),
          headBtn("🗖", "Maximize / restore", () => { reg.maximizedId = reg.maximizedId === s.id ? null : s.id; renderPanels(); }),
          headBtn("×", "Close session", () => { disposeSession(s); d.sessions = d.sessions.filter((x) => x.id !== s.id); if (reg.maximizedId === s.id) reg.maximizedId = null; ctx.save(); renderPanels(); }),
        ]);
        const node = el("div", { class: "kube-panel term-panel" }, [head, body]);
        node._hostEl = hostEl;
        node._body = body;
        return node;
      }

      function renderPanels() {
        if (!hasXterm) { panelsArea.replaceChildren(el("div", { class: "status-line err", text: "Terminal component failed to load." })); return; }
        // dispose live terminals whose session was removed elsewhere (e.g. the
        // workspace tab tree) so the shell doesn't linger unseen
        for (const id of Object.keys(rt)) {
          if (!d.sessions.some((s) => s.id === id)) {
            try { rt[id].ro && rt[id].ro.disconnect(); } catch (e) {}
            try { rt[id].ws && rt[id].ws.close(); } catch (e) {}
            try { rt[id].term && rt[id].term.dispose(); } catch (e) {}
            delete rt[id];
            delete nodes[id];
          }
        }
        if (!d.sessions.length) { panelsArea.replaceChildren(el("div", { class: "status-line dim", text: "No sessions. Add a host above and click “Open session”." })); return; }
        // Reconcile in place: keep each session's persistent panel node, drop the
        // nodes of closed sessions, and hide (not remove) panels when another is
        // maximized. Each terminal keeps its own id so nodes never collide, and a
        // per-terminal ResizeObserver re-fits when a panel grows/shrinks (e.g. a
        // sibling closes) so xterm reflows and repaints at the new size.
        const alive = new Set(d.sessions.map((s) => s.id));
        // a maximized session can be removed elsewhere (tab tree, close);
        // a stale id would mark every surviving panel hidden — nothing shows
        if (reg.maximizedId && !alive.has(reg.maximizedId)) reg.maximizedId = null;
        for (const child of Array.from(panelsArea.children)) {
          if (!child._sid || !alive.has(child._sid)) child.remove();
        }
        let prev = null;
        for (const s of d.sessions) {
          if (!nodes[s.id]) nodes[s.id] = buildNode(s);
          const node = nodes[s.id];
          node._sid = s.id;
          const hidden = reg.maximizedId && reg.maximizedId !== s.id;
          node.className = "kube-panel term-panel" + (reg.maximizedId === s.id ? " max" : "") + (s.minimized ? " min" : "");
          node.style.display = hidden ? "none" : "";
          node._body.style.display = s.minimized ? "none" : "";
          const at = prev ? prev.nextSibling : panelsArea.firstChild;
          if (at !== node) panelsArea.insertBefore(node, at);
          prev = node;
          if (!hidden && !s.minimized) requestAnimationFrame(() => ensureTerm(s, node._hostEl));
        }
      }

      if (!Array.isArray(d.savedHosts)) d.savedHosts = [];
      const hostLabel = (h) => (h.username ? h.username + "@" : "") + h.host + ":" + (h.port || "22");

      function saveHost(host, port, username, password) {
        const label = hostLabel({ host, port, username });
        const existing = d.savedHosts.find((h) => hostLabel(h) === label);
        if (existing) { existing.password = password; return; }
        d.savedHosts.push({ id: uid(), host, port, username, password });
      }

      function openSession() {
        if (!(d.newHost || "").trim()) return setStatus(status, "✗ Enter a host (or user@host)", "err");
        const host = d.newHost.trim(), port = (d.newPort || "22").trim() || "22", username = (d.newUser || "").trim(), password = d.newPass || "";
        d.sessions.push({ id: uid(), host, port, username, password, minimized: false, broadcast: true });
        saveHost(host, port, username, password); // remember it for the dropdown
        reg.maximizedId = null;
        ctx.save();
        renderPanels();
        renderForm();
        setStatus(status, "", "dim");
      }

      const runShared = () => {
        const cmd = (d.shared || "").trim();
        if (!cmd) return;
        const targets = d.sessions.filter((s) => s.broadcast && rt[s.id] && rt[s.id].ws && rt[s.id].ws.readyState === 1);
        if (!targets.length) return setStatus(status, "✗ No connected sessions have broadcast (📡) enabled", "err");
        for (const s of targets) rt[s.id].ws.send(JSON.stringify({ type: "input", data: cmd + "\n" }));
        setStatus(status, `✓ Sent to ${targets.length} session(s)`, "ok");
      };

      const sharedInput = bindField(el("input", { type: "text", class: "kube-cmd", placeholder: "shared command — typed into every session with 📡 on" }), d, "shared", ctx);
      sharedInput.addEventListener("keydown", (e) => { if (e.key === "Enter") runShared(); });

      const field = (label, node) => el("div", { class: "field" }, [el("span", { text: label }), node]);
      const newHost = bindField(el("input", { type: "text", placeholder: "user@host", style: "min-width:180px" }), d, "newHost", ctx);
      const newPort = bindField(el("input", { type: "text", placeholder: "22", style: "width:70px" }), d, "newPort", ctx);
      const newUser = bindField(el("input", { type: "text", placeholder: "(or set in host)", style: "width:130px" }), d, "newUser", ctx);
      const newPass = bindField(el("input", { type: "password", placeholder: "password", style: "min-width:150px" }), d, "newPass", ctx);
      newPass.addEventListener("keydown", (e) => { if (e.key === "Enter") openSession(); });

      // saved-hosts dropdown: pick a saved host to prefill the form, or "New host"
      const hostSel = el("select", { style: "min-width:200px" });
      const setForm = (h) => {
        d.newHost = h ? h.host : ""; d.newPort = h ? (h.port || "22") : "22";
        d.newUser = h ? (h.username || "") : ""; d.newPass = h ? (h.password || "") : "";
        newHost.value = d.newHost; newPort.value = d.newPort; newUser.value = d.newUser; newPass.value = d.newPass;
        ctx.save();
      };
      const fillHostSel = () => {
        hostSel.replaceChildren(
          el("option", { value: "", text: d.savedHosts.length ? "— New host —" : "— No saved hosts —" }),
          ...d.savedHosts.map((h) => el("option", { value: h.id, text: hostLabel(h) }))
        );
      };
      hostSel.addEventListener("change", () => {
        const h = d.savedHosts.find((x) => x.id === hostSel.value);
        setForm(h || null);
      });
      const forgetBtn = el("button", {
        class: "btn", text: "Forget", title: "Remove the selected saved host",
        onclick: () => {
          if (!hostSel.value) return;
          d.savedHosts = d.savedHosts.filter((h) => h.id !== hostSel.value);
          ctx.save();
          fillHostSel();
        },
      });

      const formGrid = el("div", { class: "form-grid" });
      const renderForm = () => {
        fillHostSel();
        formGrid.replaceChildren(
          field("Saved host", hostSel),
          forgetBtn,
          field("Host", newHost), field("Port", newPort), field("User", newUser), field("Password", newPass),
          el("button", { class: "btn primary", text: "+ Open session", onclick: openSession }),
        );
      };
      renderForm();

      root.append(
        formGrid,
        el("div", { class: "toolbar" }, [
          el("span", { class: "pane-label", text: "Broadcast typing" }),
          sharedInput,
          el("button", { class: "btn", text: "Send to all 📡", onclick: runShared }),
        ]),
        status,
        panelsArea
      );
      renderPanels();

      if (!reg.resizeWired) {
        reg.resizeWired = true;
        window.addEventListener("resize", () => {
          for (const s of d.sessions) {
            const r = rt[s.id];
            if (r && r.fit && !s.minimized) { try { r.fit.fit(); } catch (e) {} }
          }
        });
      }
    },
  });

  // ======================================================================
  // SFTP / Files — WinSCP-style remote file browser: list directories,
  // navigate, and download files to your machine (password SSH)
  // ======================================================================
  registerTool({
    type: "sftp",
    icon: "📁",
    name: "SFTP / Files",
    desc: "Browse a remote host's files over SFTP (password auth) and download them to your machine — WinSCP-style listing and download.",
    defaults: () => ({ host: "", port: "22", username: "", password: "", path: "", entries: [] }),
    render(root, tab, ctx) {
      const d = tab.data;
      if (!Array.isArray(d.entries)) d.entries = [];
      const status = el("div", { class: "status-line dim" });
      const tableBox = el("div", { style: "flex:1;overflow:auto" });
      const connOf = () => ({ host: d.host, port: d.port, username: d.username, password: d.password });

      const parentOf = (p) => {
        if (!p || p === "/") return "/";
        const t = p.replace(/\/+$/, "");
        const i = t.lastIndexOf("/");
        return i <= 0 ? "/" : t.slice(0, i);
      };
      const joinPath = (dir, name) => (dir === "/" ? "" : dir.replace(/\/+$/, "")) + "/" + name;

      const pathInput = el("input", { type: "text", placeholder: "/home/user (blank = home)", style: "flex:1;min-width:200px" });
      pathInput.value = d.path || "";
      pathInput.addEventListener("keydown", (e) => { if (e.key === "Enter") list(pathInput.value.trim()); });

      async function list(p) {
        if (!(d.host || "").trim()) return setStatus(status, "✗ Enter a host first", "err");
        setStatus(status, "Listing…", "dim");
        try {
          const r = await api("POST", "/api/sftp/list", { conn: connOf(), path: p || "" });
          d.path = r.path;
          d.entries = r.entries || [];
          pathInput.value = r.path;
          ctx.save();
          renderTable();
          setStatus(status, `✓ ${d.entries.length} item(s) in ${r.path}`, "ok");
        } catch (e) {
          setStatus(status, "✗ " + e.message, "err");
        }
      }

      async function download(entry) {
        const full = joinPath(d.path || "/", entry.name);
        setStatus(status, "Downloading " + entry.name + "…", "dim");
        try {
          const res = await fetch("/api/sftp/download", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ conn: connOf(), path: full }),
          });
          if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.error || res.status + " " + res.statusText);
          }
          const blob = await res.blob();
          const url = URL.createObjectURL(blob);
          const a = el("a", { href: url, download: entry.name });
          document.body.appendChild(a);
          a.click();
          a.remove();
          setTimeout(() => URL.revokeObjectURL(url), 15000);
          setStatus(status, `✓ Downloaded ${entry.name} (${fmtBytes(blob.size)})`, "ok");
        } catch (e) {
          setStatus(status, "✗ " + e.message, "err");
        }
      }

      function renderTable() {
        tableBox.replaceChildren();
        if (!d.entries.length) { tableBox.append(el("div", { class: "status-line dim", text: "Empty directory." })); return; }
        const table = el("table", { class: "kv" }, [
          el("tr", {}, [el("th", { text: "Name" }), el("th", { text: "Size" }), el("th", { text: "Modified" }), el("th", { text: "" })]),
        ]);
        for (const e of d.entries) {
          const nameCell = e.isDir
            ? el("td", {}, [el("a", { href: "#", class: "sftp-dir", text: "📂 " + e.name, onclick: (ev) => { ev.preventDefault(); list(joinPath(d.path || "/", e.name)); } })])
            : el("td", {}, [el("a", { href: "#", class: "sftp-file", text: "📄 " + e.name, title: "Download", onclick: (ev) => { ev.preventDefault(); download(e); } })]);
          table.append(el("tr", {}, [
            nameCell,
            el("td", { text: e.isDir ? "—" : fmtBytes(e.size) }),
            el("td", { text: (e.modTime || "").replace("T", " ").replace("Z", "") }),
            el("td", {}, e.isDir ? [] : [el("button", { class: "btn", text: "Download", onclick: () => download(e) })]),
          ]));
        }
        tableBox.append(table);
      }

      const field = (label, node) => el("div", { class: "field" }, [el("span", { text: label }), node]);
      const hostIn = bindField(el("input", { type: "text", placeholder: "user@host", style: "min-width:180px" }), d, "host", ctx);
      const portIn = bindField(el("input", { type: "text", placeholder: "22", style: "width:70px" }), d, "port", ctx);
      const userIn = bindField(el("input", { type: "text", placeholder: "(or set in host)", style: "width:130px" }), d, "username", ctx);
      const passIn = bindField(el("input", { type: "password", placeholder: "password", style: "min-width:150px" }), d, "password", ctx);
      passIn.addEventListener("keydown", (e) => { if (e.key === "Enter") list(""); });

      root.append(
        el("div", { class: "form-grid" }, [
          field("Host", hostIn), field("Port", portIn), field("User", userIn), field("Password", passIn),
          el("button", { class: "btn primary", text: "Connect", onclick: () => list("") }),
        ]),
        el("div", { class: "toolbar" }, [
          el("button", { class: "btn", text: "⬆ Up", title: "Parent directory", onclick: () => list(parentOf(d.path || "/")) }),
          el("button", { class: "btn", text: "⟳", title: "Refresh", onclick: () => list(d.path || "") }),
          el("span", { class: "pane-label", text: "Path" }),
          pathInput,
          el("button", { class: "btn", text: "Go", onclick: () => list(pathInput.value.trim()) }),
        ]),
        status,
        tableBox
      );
      renderTable();
    },
  });

  // ======================================================================
  // Data-infrastructure clients (Kafka / Elastic / Cassandra / Oracle)
  // Shared pattern, mirroring the API client: a side panel of saved
  // connections (clusters) + inner console tabs. Everything autosaves and
  // stays until the user deletes it from the tab.
  // ======================================================================

  function clientTool(cfg) {
    registerTool({
      type: cfg.type,
      icon: cfg.icon,
      name: cfg.name,
      desc: cfg.desc,
      defaults: () => ({ connections: [], activeConnId: null, consoles: [], activeConsoleId: null }),
      // inner console tabs, for the workspace tab tree in the sidebar
      subTabs: (d) => (d.consoles || []).map((c) => {
        const conn = (d.connections || []).find((x) => x.id === c.connId);
        const where = conn ? (conn.name || cfg.connName(conn) || "") : "";
        return {
          id: c.id,
          label: cfg.consoleLabel(c) + (where ? " · " + where : ""),
          select: () => { d.activeConsoleId = c.id; if (c.connId) d.activeConnId = c.connId; },
          remove: () => {
            const i = d.consoles.findIndex((x) => x.id === c.id);
            if (i >= 0) d.consoles.splice(i, 1);
            if (d.activeConsoleId === c.id) d.activeConsoleId = d.consoles[0]?.id ?? null;
          },
        };
      }),
      render(root, tab, ctx) {
        const d = tab.data;
        if (!Array.isArray(d.connections)) d.connections = [];
        if (!Array.isArray(d.consoles)) d.consoles = [];
        if (!d.consoles.length) d.consoles.push(cfg.newConsole());
        // Consoles and connections saved before inner tabs had ids have none,
        // and `undefined === undefined` matches the *first* entry — so every
        // lookup resolved to console one, every tab drew as active, and
        // clicking a tab appeared to do nothing. Backfill before anything
        // reads an id.
        let backfilled = false;
        for (const c of d.consoles) if (!c.id) { c.id = uid(); backfilled = true; }
        for (const c of d.connections) if (!c.id) { c.id = uid(); backfilled = true; }
        // A connection that never had an id left activeConnId pointing at
        // nothing, so a tool with saved clusters greeted you with "add one".
        if (d.connections.length && !d.connections.some((c) => c.id === d.activeConnId)) {
          d.activeConnId = d.connections[0].id;
          backfilled = true;
        }
        if (backfilled) ctx.save();
        if (!d.consoles.some((c) => c.id === d.activeConsoleId)) d.activeConsoleId = d.consoles[0].id;

        const sideBox = el("div", { class: "api-side" });
        const mainBox = el("div", { class: "api-main" });
        root.append(el("div", { class: "api-layout" }, [sideBox, mainBox]));

        const activeConn = () => d.connections.find((c) => c.id === d.activeConnId) || null;
        let editingId = null;
        let adding = false;

        function connForm(existing) {
          const form = el("div", { class: "conn-form" });
          const values = {};
          cfg.fields.forEach((f) => {
            let input;
            if (f.type === "checkbox") input = el("input", { type: "checkbox" });
            else if (f.type === "select") input = el("select", { style: "width:100%" }, (f.options || []).map((o) => el("option", { value: o.value, text: o.label })));
            else input = el("input", { type: f.type || "text", placeholder: f.placeholder || "", style: "width:100%" });
            if (existing) {
              if (f.type === "checkbox") input.checked = !!existing[f.key];
              else input.value = existing[f.key] || (f.type === "select" && f.options && f.options.length ? f.options[0].value : "");
            } else if (f.type === "select" && f.default) {
              input.value = f.default;
            }
            values[f.key] = input;
            form.append(f.type === "checkbox"
              ? el("label", { class: "inline" }, [input, f.label])
              : el("div", { class: "field" }, [el("span", { class: "pane-label", text: f.label }), input]));
          });
          form.append(el("div", { class: "toolbar" }, [
            el("button", {
              class: "btn primary", text: existing ? "Save" : "Add",
              onclick: () => {
                const target = existing || { id: uid() };
                cfg.fields.forEach((f) => {
                  target[f.key] = f.type === "checkbox" ? values[f.key].checked : values[f.key].value.trim();
                });
                if (!existing) {
                  d.connections.push(target);
                  d.activeConnId = target.id;
                  const cur = d.consoles.find((x) => x.id === d.activeConsoleId);
                  if (cur) cur.connId = target.id; // point the current tab at the new connection
                }
                adding = false;
                editingId = null;
                ctx.save();
                renderSide();
                renderMain();
              },
            }),
            el("button", { class: "btn", text: "Cancel", onclick: () => { adding = false; editingId = null; renderSide(); } }),
          ]));
          return form;
        }

        function renderSide() {
          const box = el("div", { class: "api-side-content" });
          sideBox.replaceChildren(
            el("div", { class: "subtabs" }, [
              el("button", { class: "active", text: `${cfg.connLabel} (${d.connections.length})` }),
            ]),
            box
          );
          if (!d.connections.length && !adding) {
            box.append(el("div", { class: "status-line dim", text: `No ${cfg.connLabel.toLowerCase()} yet — add one to get started. Click a ${cfg.connSingular} to make it active.` }));
          }
          d.connections.forEach((c, i) => {
            box.append(el("div", {
              class: "history-item" + (c.id === d.activeConnId ? " conn-active" : ""),
              title: "Click to make this the active " + cfg.connSingular,
              onclick: () => {
                d.activeConnId = c.id;
                const cur = d.consoles.find((x) => x.id === d.activeConsoleId);
                if (cur) cur.connId = c.id; // re-target the current console tab to this cluster
                ctx.save();
                renderSide();
                renderMain();
              },
            }, [
              el("span", { class: "conn-dot" + (c.id === d.activeConnId ? " on" : "") }),
              el("span", { class: "h-url", text: c.name || cfg.connName(c) || cfg.connSingular }),
              el("button", { class: "icon-btn", text: "✎", title: "Edit", onclick: (e) => { e.stopPropagation(); editingId = c.id; adding = false; renderSide(); } }),
              el("button", {
                class: "icon-btn", text: "×", title: "Delete " + cfg.connSingular,
                onclick: async (e) => {
                  e.stopPropagation();
                  if (!(await confirmDialog(`Delete ${cfg.connSingular} "${c.name || cfg.connName(c)}"?`, { okLabel: "Delete", danger: true }))) return;
                  d.connections.splice(i, 1);
                  if (d.activeConnId === c.id) d.activeConnId = d.connections[0]?.id ?? null;
                  ctx.save();
                  renderSide();
                  renderMain();
                },
              }),
            ]));
            if (editingId === c.id) box.append(connForm(c));
          });
          if (adding) box.append(connForm(null));
          else box.append(el("div", {}, [
            el("button", { class: "btn", text: "+ Add " + cfg.connSingular, onclick: () => { adding = true; editingId = null; renderSide(); } }),
          ]));
        }

        function renderMain() {
          mainBox.replaceChildren();
          mainBox.append(el("div", { class: "req-tabs" }, [
            ...d.consoles.map((c) => {
              const consoleConn = d.connections.find((x) => x.id === c.connId);
              const clusterName = consoleConn ? (consoleConn.name || cfg.connName(consoleConn) || "") : "";
              return el("div", {
                class: "req-tab" + (c.id === d.activeConsoleId ? " active" : ""),
                title: clusterName ? cfg.connSingular + ": " + clusterName : "",
                onclick: () => {
                  if (d.activeConsoleId === c.id) return;
                  d.activeConsoleId = c.id;
                  // switch the active connection to whatever this tab is bound to
                  if (c.connId && d.connections.some((x) => x.id === c.connId)) d.activeConnId = c.connId;
                  ctx.save();
                  renderSide();
                  renderMain();
                },
              }, [
                el("span", { text: cfg.consoleLabel(c) + (clusterName ? "  ·  " + clusterName : "") }),
                el("button", {
                  class: "tab-close", text: "×", title: "Close console tab",
                  onclick: (e) => {
                    e.stopPropagation();
                    const idx = d.consoles.findIndex((x) => x.id === c.id);
                    d.consoles.splice(idx, 1);
                    if (!d.consoles.length) d.consoles.push(cfg.newConsole());
                    if (d.activeConsoleId === c.id) d.activeConsoleId = d.consoles[Math.min(idx, d.consoles.length - 1)].id;
                    ctx.save();
                    renderMain();
                  },
                }),
              ]);
            }),
            el("button", {
              class: "icon-btn", text: "+", title: "New console tab",
              onclick: () => {
                const c = cfg.newConsole();
                c.connId = d.activeConnId; // new tab targets the current cluster
                d.consoles.push(c);
                d.activeConsoleId = c.id;
                ctx.save();
                renderMain();
              },
            }),
          ]));

          const consoleData = d.consoles.find((c) => c.id === d.activeConsoleId) || d.consoles[0];
          // each console remembers its own connection; migrate legacy consoles and
          // keep the active-connection highlight in sync with the current tab
          if (!consoleData.connId || !d.connections.some((x) => x.id === consoleData.connId)) {
            consoleData.connId = d.activeConnId;
          }
          d.activeConnId = consoleData.connId;
          const conn = d.connections.find((c) => c.id === consoleData.connId) || null;
          // Resolve the connection *live* from this console's own connId at call
          // time. Request handlers must use this rather than closing over `conn`,
          // so a console always talks to the cluster it is bound to — never a
          // stale one captured at an earlier render.
          const getConn = () => d.connections.find((x) => x.id === consoleData.connId) || conn;
          const body = el("div", { class: "tool", style: "flex:1" });
          mainBox.append(body);
          if (!conn) {
            body.append(el("div", { class: "empty-hint" }, [
              el("div", { class: "big", text: cfg.icon }),
              el("div", { text: `Add a ${cfg.connSingular} in the left panel and click it to make it active.` }),
            ]));
            return;
          }
          cfg.renderConsole(body, conn, consoleData, ctx, getConn);
        }

        renderSide();
        renderMain();
      },
    });
  }

  /** Render a QueryResult (or {error}) as a status line + data grid. */
  // ---- shared data table ---------------------------------------------------
  // One table treatment for every result grid (SQL, Kafka, Elastic): resizable
  // columns, and every cell clamped to a line with hover actions to expand
  // (pretty-printing JSON) or copy the full value.

  /** A <td> whose text is clamped, with expand + copy on hover. */
  function gridCell(text, label, extra = []) {
    const s = text == null ? "" : String(text);
    const td = el("td", { class: "rg-cell", title: s ? "Double-click to expand · full value is never truncated when copied" : "" });
    const tools = el("div", { class: "rg-tools" }, [
      ...extra,
      el("button", {
        class: "icon-btn", text: "⤢", title: "Expand" + (looksJson(s) ? " (formatted JSON)" : ""),
        onclick: (e) => { e.stopPropagation(); showJsonModal(label, s); },
      }),
      copyBtn(() => s, "⧉"),
    ]);
    td.append(el("span", { class: "rg-cell-text", text: s }), tools);
    td.addEventListener("dblclick", () => showJsonModal(label, s));
    return td;
  }

  const looksJson = (v) => {
    const s = String(v ?? "").trim();
    return s.length > 1 && (s.startsWith("{") || s.startsWith("["));
  };

  /** Make a header cell resizable by dragging its right edge. */
  function addColGrip(table, headRow, th) {
    const grip = el("span", { class: "col-grip", title: "Drag to resize column" });
    grip.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const startX = e.clientX, startW = th.offsetWidth, startTableW = table.offsetWidth;
      if (table.style.tableLayout !== "fixed") {
        // freeze the current layout so only the dragged column changes
        for (const h of headRow.children) h.style.width = h.offsetWidth + "px";
        table.style.tableLayout = "fixed";
        table.style.width = startTableW + "px";
      }
      const move = (ev) => {
        const w = Math.max(60, startW + (ev.clientX - startX));
        th.style.width = w + "px";
        table.style.width = startTableW + (w - startW) + "px";
      };
      const up = () => { document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", up); };
      document.addEventListener("mousemove", move);
      document.addEventListener("mouseup", up);
    });
    th.append(grip);
  }

  /**
   * Build a result table. `columns` are header labels; `rows` are arrays of
   * values, or of {text, extra} to add per-cell buttons.
   */
  function dataTable(columns, rows) {
    const table = el("table", { class: "kv rg" });
    const headRow = el("tr");
    for (const name of columns) {
      const th = el("th", {}, [el("span", { text: name })]);
      addColGrip(table, headRow, th);
      headRow.append(th);
    }
    table.append(headRow);
    for (const r of rows) {
      table.append(el("tr", {}, r.map((v, i) => {
        const cell = v && typeof v === "object" && "text" in v ? v : { text: v };
        return gridCell(cell.text, columns[i], cell.extra || []);
      })));
    }
    return el("div", { class: "rg-wrap" }, [table]);
  }

  function resultGrid(res) {
    if (!res) return el("div", { class: "status-line dim", text: "Run a query to see results here" });
    if (res.error) return el("div", { class: "status-line err", text: "✗ " + res.error });
    if (!res.columns || !res.columns.length) {
      return el("div", { class: "status-line ok", text: `✓ OK — ${res.rowsAffected ?? 0} row(s) affected · ${res.durationMs ?? 0} ms` });
    }
    return el("div", { class: "tool", style: "flex:1;min-height:0" }, [
      el("div", { class: "status-line ok", text: `✓ ${res.rows.length} row(s)${res.truncated ? " (truncated)" : ""} · ${res.durationMs} ms` }),
      dataTable(res.columns, res.rows),
    ]);
  }

  const consoleName = (q, fallback) => {
    const words = (q || "").trim().split(/\s+/).slice(0, 3).join(" ");
    return words ? words.slice(0, 22) : fallback;
  };

  /** Checkbox grid for choosing columns/fields, with an all-toggle. */
  function colsPicker(available, selected, onChange) {
    const box = el("div", { class: "cols-grid" });
    const checks = [];
    const all = el("input", { type: "checkbox" });
    all.checked = available.length > 0 && available.every((f) => selected.includes(f.name));
    all.addEventListener("change", () => {
      checks.forEach((c) => (c.checked = all.checked));
      onChange(all.checked ? available.map((f) => f.name) : []);
    });
    box.append(el("label", { class: "inline all-toggle" }, [all, "All"]));
    available.forEach((f) => {
      const c = el("input", { type: "checkbox" });
      c.checked = selected.includes(f.name);
      c.addEventListener("change", () => {
        const next = available.filter((x, i) => checks[i].checked).map((x) => x.name);
        all.checked = next.length === available.length;
        onChange(next);
      });
      checks.push(c);
      box.append(el("label", { class: "inline", title: f.type || "" }, [c, f.name]));
    });
    return box;
  }

  // ---- tabular export (CSV / Excel) ---------------------------------------
  // Dependency-free: CSV with a UTF-8 BOM (so Excel opens unicode correctly)
  // and an Excel 2003 SpreadsheetML .xls for a native-Excel download.
  const EXPORT_DEFAULT = 1000, EXPORT_MAX = 10000;
  const clampExport = (n) => Math.min(Math.max(Number(n) || EXPORT_DEFAULT, 1), EXPORT_MAX);
  const csvCell = (v) => {
    const s = String(v ?? "");
    return /[",\n\r]/.test(s) ? '"' + s.replaceAll('"', '""') + '"' : s;
  };
  const toCsv = (cols, rows) => "\uFEFF" + [cols, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n");
  const toXls = (cols, rows) => {
    const cell = (v) => `<Cell><Data ss:Type="String">${escapeHtml(String(v ?? ""))}</Data></Cell>`;
    const row = (r) => `<Row>${r.map(cell).join("")}</Row>`;
    return `<?xml version="1.0"?>\n<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"><Worksheet ss:Name="Export"><Table>${row(cols)}${rows.map(row).join("")}</Table></Worksheet></Workbook>`;
  };
  function downloadFile(name, mime, content) {
    const a = el("a", { href: URL.createObjectURL(new Blob([content], { type: mime })), download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }
  function exportRows(fmt, baseName, cols, rows) {
    const ts = new Date().toISOString().slice(0, 19).replaceAll(":", "-");
    if (fmt === "xls") downloadFile(`${baseName}-${ts}.xls`, "application/vnd.ms-excel", toXls(cols, rows));
    else downloadFile(`${baseName}-${ts}.csv`, "text/csv;charset=utf-8", toCsv(cols, rows));
  }
  // shared "Export [n] rows [CSV] [Excel]" toolbar row; doExport(fmt, n).
  // `extras` are appended after the export buttons (e.g. a copy-response
  // button) so each console can add its own action without a second toolbar.
  function exportBar(c, ctx, doExport, extras = []) {
    const n = el("input", { type: "number", min: "1", max: String(EXPORT_MAX), style: "width:90px", title: `Rows to export (max ${EXPORT_MAX})` });
    n.value = c.exportN || String(EXPORT_DEFAULT);
    n.addEventListener("input", () => { c.exportN = n.value; ctx.save(); });
    return el("div", { class: "toolbar" }, [
      el("span", { class: "pane-label", text: "Export" }),
      n,
      el("span", { class: "pane-label", text: "rows as" }),
      el("button", { class: "btn", text: "CSV", onclick: () => doExport("csv", clampExport(c.exportN)) }),
      el("button", { class: "btn", text: "Excel", onclick: () => doExport("xls", clampExport(c.exportN)) }),
      ...extras,
    ]);
  }

  /** Query console shared by Cassandra and Oracle, with a table/column
      browser that builds SELECTs for you. */
  // engine helpers for the relational tool (Oracle / MySQL / PostgreSQL)
  const sqlEsc = (s) => String(s).replace(/'/g, "''");
  const rdbEngine = (e) => ({ mysql: "mysql", mariadb: "mysql", postgres: "postgres", postgresql: "postgres", pg: "postgres" }[String(e || "").toLowerCase()] || "oracle");
  const rdbPlaceholder = (e) => e === "oracle" ? "SELECT * FROM employees FETCH FIRST 50 ROWS ONLY" : "SELECT * FROM employees LIMIT 50";
  const rdbBrowser = (engine, conn) => {
    const schema = (conn.schema || "").trim();
    if (engine === "mysql") {
      const db = schema || (conn.database || "").trim();
      const whereDb = db ? `'${sqlEsc(db)}'` : "DATABASE()";
      return {
        tablesQuery: `SELECT table_name FROM information_schema.tables WHERE table_schema = ${whereDb} ORDER BY table_name`,
        tableFromRow: (r) => r[0],
        columnsQuery: (t) => `SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = ${whereDb} AND table_name = '${sqlEsc(t)}' ORDER BY ordinal_position`,
        buildSelect: (t, cols, n) => `SELECT ${cols} FROM \`${t}\` LIMIT ${n}`,
      };
    }
    if (engine === "postgres") {
      const sch = schema || "public";
      return {
        tablesQuery: `SELECT table_name FROM information_schema.tables WHERE table_schema = '${sqlEsc(sch)}' ORDER BY table_name`,
        tableFromRow: (r) => r[0],
        columnsQuery: (t) => `SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = '${sqlEsc(sch)}' AND table_name = '${sqlEsc(t)}' ORDER BY ordinal_position`,
        buildSelect: (t, cols, n) => `SELECT ${cols} FROM "${sch}"."${t}" LIMIT ${n}`,
      };
    }
    // oracle
    if (schema) {
      const owner = schema.toUpperCase();
      return {
        tablesQuery: `SELECT table_name FROM all_tables WHERE owner = '${sqlEsc(owner)}' ORDER BY table_name`,
        tableFromRow: (r) => r[0],
        columnsQuery: (t) => `SELECT column_name, data_type FROM all_tab_columns WHERE owner = '${sqlEsc(owner)}' AND table_name = '${sqlEsc(t)}' ORDER BY column_id`,
        buildSelect: (t, cols, n) => `SELECT ${cols} FROM ${owner}.${t} FETCH FIRST ${n} ROWS ONLY`,
      };
    }
    return {
      tablesQuery: "SELECT table_name FROM user_tables ORDER BY table_name",
      tableFromRow: (r) => r[0],
      columnsQuery: (t) => `SELECT column_name, data_type FROM user_tab_columns WHERE table_name = '${sqlEsc(t)}' ORDER BY column_id`,
      buildSelect: (t, cols, n) => `SELECT ${cols} FROM ${t} FETCH FIRST ${n} ROWS ONLY`,
    };
  };

  // resolve: (conn) => { type, placeholder, browser, label } — lets the same
  // console serve a fixed engine (Cassandra) or a per-connection one (the
  // relational tool, which picks Oracle/MySQL/PostgreSQL from conn.engine).
  const sqlConsole = (resolve) => (body, conn, c, ctx, getConn) => {
    const cluster = () => (getConn && getConn()) || conn;
    const cfg0 = resolve(cluster());
    const status = el("div", { class: "status-line dim" });
    const out = el("div", { style: "flex:1;overflow:auto;display:flex;flex-direction:column" });

    // visible target so it's clear which engine/schema this tab queries
    const target = el("div", { class: "es-target" });
    const refreshTarget = () => {
      const k = cluster();
      const r = resolve(k);
      target.replaceChildren(
        el("span", { class: "pane-label", text: "Target" }),
        el("span", { class: "es-target-name", text: r.label || r.type }),
        el("span", { class: "es-target-url", text: r.where ? "→ " + r.where : "" }),
      );
    };
    refreshTarget();

    const query = el("textarea", {
      rows: "6", style: "width:100%", spellcheck: "false",
      placeholder: cfg0.placeholder + ";\n-- multiple queries supported: separate with ';' — select one (or put the cursor on it) and Run",
    });
    query.value = c.query || "";
    query.addEventListener("input", () => { c.query = query.value; ctx.save(); });

    const maxRows = el("input", { type: "number", min: "1", max: "5000", style: "width:90px" });
    maxRows.value = c.maxRows || "200";
    maxRows.addEventListener("input", () => { c.maxRows = maxRows.value; ctx.save(); });

    // The editor can hold several statements. Run executes the selected text
    // if there is a selection; otherwise the ';'-separated statement under the
    // cursor (the whole text when there's only one). Naive split: a ';' inside
    // a string literal counts as a separator.
    const pickStatement = () => {
      const full = query.value || "";
      const s = query.selectionStart ?? 0, e = query.selectionEnd ?? 0;
      if (e > s && full.slice(s, e).trim()) return { text: full.slice(s, e).trim(), how: "selection" };
      const parts = [];
      let off = 0;
      for (const seg of full.split(";")) {
        parts.push({ text: seg, start: off, end: off + seg.length });
        off += seg.length + 1;
      }
      const stmts = parts.filter((p) => p.text.trim());
      if (stmts.length <= 1) return { text: full.trim(), how: "all" };
      const cur = stmts.find((p) => s >= p.start && s <= p.end + 1) || stmts[stmts.length - 1];
      return { text: cur.text.trim(), how: `statement ${stmts.indexOf(cur) + 1} of ${stmts.length}` };
    };

    const run = async () => {
      const picked = pickStatement();
      if (!picked.text) return setStatus(status, "✗ Enter a query", "err");
      const k = cluster();
      setStatus(status, picked.how === "all" ? "Running…" : `Running ${picked.how}…`, "dim");
      try {
        const res = await api("POST", "/api/db/query", {
          type: resolve(k).type,
          conn: { ...k, port: Number(k.port) || 0 },
          query: picked.text,
          maxRows: Number(c.maxRows) || 200,
        });
        c.result = res;
        setStatus(status, picked.how === "all" ? "" : `✓ ran ${picked.how}`, picked.how === "all" ? "dim" : "ok");
      } catch (e) {
        c.result = { error: e.message };
        setStatus(status, "", "dim");
      }
      c.name = consoleName(picked.text, "query");
      ctx.save();
      out.replaceChildren(resultGrid(c.result));
    };
    query.addEventListener("keydown", (e) => { if ((e.ctrlKey || e.metaKey) && e.key === "Enter") run(); });

    // ---- query helper: table picker → column picker → generated SELECT ----
    const dbq = (q, mr) => { const k = cluster(); return api("POST", "/api/db/query", {
      type: resolve(k).type, conn: { ...k, port: Number(k.port) || 0 }, query: q, maxRows: mr || 5000,
    }); };
    const browserCfg = () => resolve(cluster()).browser;

    // ---- export: re-run the current query at the export size, download ----
    // (same statement Run would pick: the selection, or the one under the cursor)
    const doExport = async (fmt, n) => {
      const picked = pickStatement();
      if (!picked.text) return setStatus(status, "✗ Enter (or build) a query first", "err");
      setStatus(status, `Exporting up to ${n} row(s)…`, "dim");
      try {
        const res = await dbq(picked.text, n);
        if (!res.columns || !res.columns.length) return setStatus(status, "✗ The query returned no result grid to export", "err");
        exportRows(fmt, resolve(cluster()).type + "-export", res.columns, res.rows || []);
        setStatus(status, `✓ Exported ${(res.rows || []).length} row(s)${res.truncated ? " (truncated)" : ""}`, "ok");
      } catch (e) {
        setStatus(status, "✗ " + e.message, "err");
      }
    };

    const tableSel = el("select", { style: "min-width:220px" });
    const colsBox = el("div");
    const limit = el("input", { type: "number", min: "1", max: "5000", style: "width:80px" });
    limit.value = c.limit || "50";
    limit.addEventListener("input", () => { c.limit = limit.value; ctx.save(); });

    const fillTables = () => {
      tableSel.replaceChildren(
        el("option", { value: "", text: "— pick a table —" }),
        ...(c.tables || []).map((t) => el("option", { value: t, text: t }))
      );
      if (c.table && (c.tables || []).includes(c.table)) tableSel.value = c.table;
    };
    const drawCols = () => {
      colsBox.replaceChildren();
      if (!c.table || !Array.isArray(c.cols) || !c.cols.length) return;
      if (!Array.isArray(c.selectedCols)) c.selectedCols = c.cols.map((f) => f.name);
      // collapsed by default — open to pick a subset of columns
      const summary = el("summary", { text: `Columns of ${c.table} (${c.selectedCols.length}/${c.cols.length} selected) — open to choose` });
      colsBox.append(el("details", { class: "section" }, [
        summary,
        colsPicker(c.cols, c.selectedCols, (next) => {
          c.selectedCols = next;
          summary.textContent = `Columns of ${c.table} (${next.length}/${c.cols.length} selected) — open to choose`;
          ctx.save();
        }),
      ]));
    };

    const loadTables = async () => {
      const browser = browserCfg();
      setStatus(status, "Loading tables…", "dim");
      try {
        const res = await dbq(browser.tablesQuery);
        c.tables = res.rows.map(browser.tableFromRow).filter(Boolean);
        ctx.save();
        fillTables();
        setStatus(status, `✓ ${c.tables.length} table(s)`, "ok");
      } catch (e) {
        setStatus(status, "✗ " + e.message, "err");
      }
    };
    const loadCols = async () => {
      if (!c.table) { c.cols = []; drawCols(); return; }
      setStatus(status, "Loading columns…", "dim");
      try {
        const res = await dbq(browserCfg().columnsQuery(c.table));
        c.cols = res.rows.map((r) => ({ name: r[0], type: r[1] }));
        c.selectedCols = c.cols.map((f) => f.name);
        ctx.save();
        drawCols();
        setStatus(status, `✓ ${c.cols.length} column(s)`, "ok");
      } catch (e) {
        setStatus(status, "✗ " + e.message, "err");
      }
    };
    tableSel.addEventListener("change", () => { c.table = tableSel.value; ctx.save(); loadCols(); });

    const buildQuery = () => {
      if (!c.table) { setStatus(status, "✗ Pick a table first (Load tables)", "err"); return false; }
      const sel = c.selectedCols || [];
      const colSql = !sel.length || sel.length === (c.cols || []).length ? "*" : sel.join(", ");
      c.query = browserCfg().buildSelect(c.table, colSql, Number(c.limit) || 50);
      query.value = c.query;
      ctx.save();
      return true;
    };

    const helper = el("details", { class: "section" }, [
      el("summary", { text: "Query helper — pick a table, choose columns, build the SELECT" }),
      el("div", { class: "toolbar" }, [
        el("button", { class: "btn", text: "Load tables", onclick: loadTables }),
        tableSel,
        el("label", { class: "inline" }, ["Limit", limit]),
        el("button", { class: "btn", text: "Build query", onclick: buildQuery }),
        el("button", { class: "btn primary", text: "Build & run", onclick: () => { if (buildQuery()) run(); } }),
      ]),
      colsBox,
    ]);
    if (c.table) helper.open = true;
    fillTables();
    drawCols();

    body.append(
      el("div", { class: "console-controls" }, [
        target,
        helper,
        query,
        el("div", { class: "toolbar" }, [
          el("button", { class: "btn primary", text: "Run (Ctrl+Enter)", onclick: run }),
          el("label", { class: "inline" }, ["Max rows", maxRows]),
          status,
        ]),
        exportBar(c, ctx, doExport),
      ]),
      out
    );
    out.replaceChildren(resultGrid(c.result));
  };

  /** Kafka console: topics browser, consumer (latest/beginning/time-range
      with key & value search), producer. */
  function kafkaConsole(body, conn, c, ctx) {
    const status = el("div", { class: "status-line dim" });
    // The status line is the result of the last run. Rebuilding the console
    // on every outer-tab switch wiped it, so a console you had just used came
    // back looking untouched. Terminal results are kept on the console data;
    // in-progress notes ("Consuming…") deliberately are not.
    const say = (node, key, text, kind) => {
      if (kind === "ok" || kind === "err") { c[key] = { text, kind }; ctx.save(); }
      else if (c[key]) { delete c[key]; ctx.save(); }
      setStatus(node, text, kind);
    };
    const out = el("div", { style: "flex:1;overflow:auto;display:flex;flex-direction:column;gap:10px" });

    // connection payload with numeric timeout (form fields store strings)
    const kconn = () => ({ ...conn, timeoutMs: Number(conn.timeoutMs) || 1000 });

    // topic picker: a real dropdown populated by "List topics", plus a text
    // field for typing a custom topic. Either keeps c.topic in sync.
    const topic = el("input", { type: "text", placeholder: "topic name", style: "min-width:160px" });
    topic.value = c.topic || "";
    topic.addEventListener("input", () => { c.topic = topic.value.trim(); ctx.save(); syncTopicInputs(); });
    const topicSel = el("select", { style: "min-width:200px" });
    topicSel.addEventListener("change", () => {
      if (!topicSel.value) return;
      c.topic = topicSel.value;
      ctx.save();
      syncTopicInputs();
    });
    // the Produce pane needs its own picker elements (a node can only live in
    // one place), kept in sync through the same c.topic
    const topic2 = el("input", { type: "text", placeholder: "topic name", style: "min-width:160px" });
    const topicSel2 = el("select", { style: "min-width:200px" });
    topic2.addEventListener("input", () => { c.topic = topic2.value.trim(); ctx.save(); syncTopicInputs(); });
    topicSel2.addEventListener("change", () => {
      if (!topicSel2.value) return;
      c.topic = topicSel2.value;
      ctx.save();
      syncTopicInputs();
    });
    const syncTopicInputs = () => {
      const t = c.topic || "";
      if (topic.value !== t) topic.value = t;
      if (topic2.value !== t) topic2.value = t;
      const listed = (c.topics || []).some((x) => x.name === t);
      topicSel.value = listed ? t : "";
      topicSel2.value = listed ? t : "";
    };

    const fillOpts = (sel) => {
      const opts = [el("option", { value: "", text: (c.topics && c.topics.length) ? `— pick a topic (${c.topics.length}) —` : "— List topics first —" })];
      for (const t of (c.topics || [])) opts.push(el("option", { value: t.name, text: `${t.name} (${t.partitions}p)` }));
      sel.replaceChildren(...opts);
    };
    const fillTopics = () => {
      fillOpts(topicSel);
      fillOpts(topicSel2);
      syncTopicInputs();
    };
    const max = el("input", { type: "number", min: "1", max: "500", style: "width:80px" });
    max.value = c.max || "50";
    max.addEventListener("input", () => { c.max = max.value; ctx.save(); });

    const fromSel = el("select", {}, [
      el("option", { value: "latest", text: "Latest" }),
      el("option", { value: "beginning", text: "From beginning" }),
      el("option", { value: "time", text: "Time range" }),
    ]);
    fromSel.value = c.from || "latest";
    const startT = el("input", { type: "datetime-local", step: "1" });
    startT.value = c.startT || "";
    startT.addEventListener("input", () => { c.startT = startT.value; ctx.save(); });
    const endT = el("input", { type: "datetime-local", step: "1", title: "optional end of range" });
    endT.value = c.endT || "";
    endT.addEventListener("input", () => { c.endT = endT.value; ctx.save(); });
    const startWrap = el("label", { class: "inline" }, ["From", startT]);
    const endWrap = el("label", { class: "inline" }, ["To", endT]);
    const syncFrom = () => {
      const t = fromSel.value === "time";
      startWrap.style.display = t ? "" : "none";
      endWrap.style.display = t ? "" : "none";
    };
    fromSel.addEventListener("change", () => { c.from = fromSel.value; ctx.save(); syncFrom(); });

    const keyQ = el("input", { type: "text", placeholder: "search key contains…", style: "min-width:150px" });
    keyQ.value = c.keyQ || "";
    keyQ.addEventListener("input", () => { c.keyQ = keyQ.value; ctx.save(); });
    const valQ = el("input", { type: "text", placeholder: "search value contains…", style: "min-width:150px;flex:1" });
    valQ.value = c.valQ || "";
    valQ.addEventListener("input", () => { c.valQ = valQ.value; ctx.save(); });

    const tryPretty = (v) => { try { return JSON.stringify(JSON.parse(v), null, 2); } catch { return v == null ? "" : String(v); } };

    // the ⤢ button on a value cell opens the full-screen Value/Headers view
    const maximizeBtn = (m) => {
      const pretty = tryPretty(m.value);
      const headersView = () => {
        const hs = m.headers || [];
        if (!hs.length) return el("div", { class: "status-line dim", text: "No headers on this message." });
        return el("table", { class: "kv" }, [
          el("tr", {}, [el("th", { text: "Header" }), el("th", { text: "Value" })]),
          ...hs.map((h) => el("tr", {}, [el("td", { text: h.key }), el("td", { text: h.value })])),
        ]);
      };
      const valueView = () => {
        const p = el("pre", { class: "output", style: "flex:1;overflow:auto;margin:0" });
        p.textContent = pretty;
        return el("div", { style: "display:flex;flex-direction:column;flex:1;min-height:0;gap:6px" }, [copyBtn(() => pretty, "Copy"), p]);
      };
      const maximize = () => showTabsModal(`Partition ${m.partition} · Offset ${m.offset}`, [
        { label: "Value", build: valueView },
        { label: `Headers (${(m.headers || []).length})`, build: headersView },
      ]);
      return el("button", {
        class: "icon-btn", text: "⛶",
        title: "Open full-screen with Value & Headers tabs",
        onclick: (e) => { e.stopPropagation(); maximize(); },
      });
    };

    const draw = () => {
      out.replaceChildren();
      if (Array.isArray(c.messages)) {
        // newest first (backend returns chronological; reverse for display)
        const rows = c.messages.slice().reverse();
        out.append(
          el("span", { class: "pane-label", text: `Messages (${c.messages.length}, newest first)` }),
          // same table treatment as the SQL/Elastic grids: resizable columns,
          // every cell expandable and copyable (so a long key is reachable)
          dataTable(["P/Offset", "Time", "Key", "Value"], rows.map((m) => [
            m.partition + "/" + m.offset,
            (m.time || "").replace("T", " ").replace("Z", ""),
            m.key,
            { text: tryPretty(m.value), extra: [maximizeBtn(m)] },
          ]))
        );
      }
    };

    const listTopics = async () => {
      say(status, "lastStatus", "Listing topics…", "dim");
      try {
        const r = await api("POST", "/api/kafka/topics", { conn: kconn() });
        c.topics = r.topics || [];
        ctx.save();
        fillTopics();
        say(status, "lastStatus", c.topics.length
          ? `✓ ${c.topics.length} topic(s) — pick one from the dropdown`
          : "✓ Connected, but no (non-internal) topics were returned", c.topics.length ? "ok" : "dim");
      } catch (e) {
        say(status, "lastStatus", "✗ " + e.message, "err");
      }
    };
    const fmtSecs = (ms) => (ms / 1000).toFixed(1) + "s";
    // "⟳ Reading messages… 12 so far   1.4s" — spinner + live elapsed time
    const busyIn = (node, text, ms) => {
      node.className = "status-line busy";
      node.replaceChildren(
        el("span", { class: "spinner" }),
        el("span", { text }),
        el("span", { class: "elapsed", text: fmtSecs(ms) }),
      );
    };
    const busy = (text, ms) => busyIn(status, text, ms);
    const busy2 = (text, ms) => busyIn(status2, text, ms);

    const consume = async () => {
      if (!c.topic) return say(status, "lastStatus", "✗ Enter or pick a topic", "err");
      if ((c.from || "latest") === "time" && !c.startT) {
        return say(status, "lastStatus", "✗ Set the start of the time range", "err");
      }
      const started = Date.now();
      let live = [], seen = 0;
      busy("Reading messages…", 0);
      const ticker = setInterval(() => busy(`Reading messages… ${seen} so far`, Date.now() - started), 100);
      // messages stream in as each partition yields them, so the table fills
      // progressively instead of appearing all at once at the end
      c.messages = [];
      draw();
      try {
        const res = await fetch("/api/kafka/consume/stream", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            conn: kconn(),
            topic: c.topic,
            max: Number(c.max) || 50,
            from: c.from || "latest",
            startMs: c.startT ? new Date(c.startT).getTime() : 0,
            endMs: c.endT ? new Date(c.endT).getTime() : 0,
            keyQuery: c.keyQ || "",
            valueQuery: c.valQ || "",
          }),
        });
        if (!res.ok || !res.body) {
          let msg = `${res.status} ${res.statusText}`;
          try { const j = JSON.parse(await res.text()); if (j.error) msg = j.error; } catch { /* not JSON */ }
          throw new Error(msg);
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "", done = null, failed = null, dirty = false;
        // repaint on a timer rather than per message, so a fast burst of
        // thousands of matches doesn't thrash the DOM
        const painter = setInterval(() => {
          if (!dirty) return;
          dirty = false;
          c.messages = live.slice();
          draw();
        }, 250);
        try {
          for (;;) {
            const { value, done: fin } = await reader.read();
            if (fin) break;
            buf += decoder.decode(value, { stream: true });
            const lines = buf.split("\n");
            buf = lines.pop();
            for (const line of lines) {
              if (!line.trim()) continue;
              let ev;
              try { ev = JSON.parse(line); } catch { continue; }
              if (ev.type === "msg") { live.push(ev.message); seen++; dirty = true; }
              else if (ev.type === "done") done = ev;
              else if (ev.type === "error") failed = ev;
            }
          }
        } finally {
          clearInterval(painter);
        }
        clearInterval(ticker);
        if (failed) throw new Error(failed.error);

        const took = fmtSecs(done ? done.elapsedMs : Date.now() - started);
        // settle on the server's sorted + trimmed list
        c.messages = done ? done.messages : live;
        c.name = c.topic;
        ctx.save();
        draw();
        say(status, "lastStatus", done
          ? `✓ ${done.matched} match(es) of ${done.scanned} scanned, showing ${done.messages.length}${done.truncated ? " (scan capped — narrow the range or raise Last N)" : ""} · ${took}`
          : `✓ ${c.messages.length} message(s) · ${took}`, "ok");
      } catch (e) {
        clearInterval(ticker);
        say(status, "lastStatus", "✗ " + e.message + ` · ${fmtSecs(Date.now() - started)}`, "err");
      }
    };

    if (!Array.isArray(c.prodHeaders)) c.prodHeaders = [{ k: "", v: "" }];
    const prodKey = el("input", { type: "text", placeholder: "key (optional)", style: "width:160px" });
    prodKey.value = c.prodKey || "";
    prodKey.addEventListener("input", () => { c.prodKey = prodKey.value; ctx.save(); });
    // Payloads are JSON far more often than not, and a single-line input made
    // one unreadable the moment it was pasted. This is a real editor: it
    // pretty-prints a pasted payload, and says how big it is and whether it
    // parses so you find out before the broker does.
    const prodValue = el("textarea", {
      class: "prod-value", spellcheck: "false",
      placeholder: "message value — paste JSON and it is formatted for you",
    });
    prodValue.value = c.prodValue || "";
    const valueInfo = el("span", { class: "prod-info" });
    const describeValue = () => {
      const raw = prodValue.value;
      if (!raw.trim()) return (valueInfo.textContent = "");
      let shape = "text";
      try { JSON.parse(raw); shape = "valid JSON"; }
      catch { shape = looksJson(raw) ? "JSON — but it does not parse" : "text"; }
      valueInfo.textContent = `${fmtBytes(new Blob([raw]).size)} · ${shape}`;
      valueInfo.className = "prod-info" + (shape.includes("not parse") ? " bad" : "");
    };
    const setValue = (v) => { prodValue.value = v; c.prodValue = v; ctx.save(); describeValue(); };
    /** Pretty-print the value when it is JSON; leave anything else alone. */
    const formatValue = (quiet) => {
      const raw = prodValue.value.trim();
      if (!raw) return;
      try {
        const pretty = JSON.stringify(JSON.parse(raw), null, 2);
        if (pretty !== prodValue.value) setValue(pretty);
        if (!quiet) say(status2, "lastStatus2", "✓ Formatted", "ok");
      } catch (e) {
        if (!quiet) say(status2, "lastStatus2", "Not JSON, left as-is — " + e.message, "dim");
      }
    };
    const minifyValue = () => {
      const raw = prodValue.value.trim();
      if (!raw) return;
      try { setValue(JSON.stringify(JSON.parse(raw))); say(status2, "lastStatus2", "✓ Minified", "ok"); }
      catch (e) { say(status2, "lastStatus2", "✗ Not valid JSON: " + e.message, "err"); }
    };
    prodValue.addEventListener("input", () => { c.prodValue = prodValue.value; ctx.save(); describeValue(); });
    // The paste event fires before the text lands, so format on the next tick.
    prodValue.addEventListener("paste", () => setTimeout(() => formatValue(true), 0));
    // the Produce pane reports into its own status line
    const status2 = el("div", { class: "status-line dim" });
    const produce = async () => {
      if (!c.topic) return say(status2, "lastStatus2", "✗ Enter or pick a topic", "err");
      const t0 = Date.now();
      busy2("Producing…", 0);
      const tick = setInterval(() => busy2("Producing…", Date.now() - t0), 100);
      try {
        const headers = (c.prodHeaders || []).filter((h) => h.k.trim()).map((h) => ({ key: h.k.trim(), value: h.v }));
        await api("POST", "/api/kafka/produce", { conn: kconn(), topic: c.topic, key: c.prodKey || "", value: c.prodValue || "", headers });
        clearInterval(tick);
        say(status2, "lastStatus2", `✓ Produced to ${c.topic}${headers.length ? " with " + headers.length + " header(s)" : ""} · ${fmtSecs(Date.now() - t0)}`, "ok");
      } catch (e) {
        clearInterval(tick);
        say(status2, "lastStatus2", "✗ " + e.message + ` · ${fmtSecs(Date.now() - t0)}`, "err");
      }
    };

    // produce area with Message / Headers subtabs
    let prodTab = "msg";
    const produceBox = el("div", { class: "produce-box" });
    const renderProduce = () => {
      produceBox.replaceChildren();
      const hdrCount = c.prodHeaders.filter((h) => h.k.trim()).length;
      produceBox.append(el("div", { class: "toolbar" }, [
        el("span", { class: "pane-label", text: "Produce" }),
        el("div", { class: "subtabs" }, [
          el("button", { class: prodTab === "msg" ? "active" : "", text: "Message", onclick: () => { prodTab = "msg"; renderProduce(); } }),
          el("button", { class: prodTab === "hdr" ? "active" : "", text: `Headers (${hdrCount})`, onclick: () => { prodTab = "hdr"; renderProduce(); } }),
        ]),
        el("button", { class: "btn primary", text: "Send", onclick: produce }),
      ]));
      if (prodTab === "msg") {
        produceBox.append(
          el("div", { class: "toolbar" }, [
            el("label", { class: "inline" }, ["Key", prodKey]),
            el("button", { class: "btn", text: "{ } Format", title: "Pretty-print the value as JSON", onclick: () => formatValue(false) }),
            el("button", { class: "btn", text: "Minify", title: "Collapse the JSON to one line", onclick: minifyValue }),
            copyBtn(() => prodValue.value, "Copy"),
            valueInfo,
          ]),
          el("span", { class: "pane-label", text: "Value" }),
          prodValue
        );
        describeValue();
      } else {
        const box = el("div", { style: "display:flex;flex-direction:column;gap:6px" });
        c.prodHeaders.forEach((h, i) => {
          const k = el("input", { type: "text", class: "hk", placeholder: "Header", value: h.k });
          const v = el("input", { type: "text", class: "hv", placeholder: "Value", value: h.v });
          k.addEventListener("input", () => { h.k = k.value; ctx.save(); });
          v.addEventListener("input", () => { h.v = v.value; ctx.save(); });
          box.append(el("div", { class: "header-row" }, [
            k, v,
            el("button", { class: "icon-btn", text: "×", title: "Remove header", onclick: () => { c.prodHeaders.splice(i, 1); if (!c.prodHeaders.length) c.prodHeaders.push({ k: "", v: "" }); ctx.save(); renderProduce(); } }),
          ]));
        });
        box.append(el("div", {}, [el("button", { class: "btn", text: "+ Header", onclick: () => { c.prodHeaders.push({ k: "", v: "" }); ctx.save(); renderProduce(); } })]));
        produceBox.append(box);
      }
    };

    // Consume and Produce are separate modes: each is a full workflow and
    // showing both at once left neither enough room.
    const consumePane = el("div", { class: "console-controls" }, [
      el("div", { class: "toolbar" }, [
        el("button", { class: "btn", text: "List topics", onclick: listTopics }),
        topicSel,
        el("label", { class: "inline" }, ["or", topic]),
        el("label", { class: "inline" }, ["Read", fromSel]),
        startWrap,
        endWrap,
        el("label", { class: "inline" }, ["Max", max, "msgs"]),
        el("button", { class: "btn primary", text: "▶ Consume", onclick: consume }),
      ]),
      el("div", { class: "toolbar" }, [
        el("span", { class: "pane-label", text: "Search" }),
        keyQ, valQ,
      ]),
      status,
    ]);
    const producePane = el("div", { class: "console-controls produce-pane" }, [
      el("div", { class: "toolbar" }, [
        el("button", { class: "btn", text: "List topics", onclick: listTopics }),
        topicSel2,
        el("label", { class: "inline" }, ["or", topic2]),
      ]),
      produceBox,
      status2,
    ]);

    const modeBar = el("div", { class: "subtabs" });
    const applyMode = () => {
      const producing = c.mode === "produce";
      modeBar.replaceChildren(
        el("button", { class: producing ? "" : "active", text: "Consume", onclick: () => { c.mode = "consume"; ctx.save(); applyMode(); } }),
        el("button", { class: producing ? "active" : "", text: "Produce", onclick: () => { c.mode = "produce"; ctx.save(); applyMode(); } }),
      );
      consumePane.style.display = producing ? "none" : "";
      producePane.style.display = producing ? "" : "none";
      out.style.display = producing ? "none" : "";
      if (producing) syncTopicInputs();
    };

    body.append(modeBar, consumePane, producePane, out);
    syncFrom();
    fillTopics();
    renderProduce();
    applyMode();
    draw();
    // put the last result back so switching away and returning shows the
    // console exactly as you left it
    if (c.lastStatus) setStatus(status, c.lastStatus.text, c.lastStatus.kind);
    if (c.lastStatus2) setStatus(status2, c.lastStatus2.text, c.lastStatus2.kind);
  }

  /** Flatten an ES mapping's properties into dotted field paths, recording
      the nearest `nested`-typed ancestor path so nested queries can be built. */
  function flattenProps(props, prefix = "", nestedPath = "") {
    let out = [];
    for (const [k, v] of Object.entries(props || {})) {
      const path = prefix ? prefix + "." + k : k;
      if (v && v.properties) {
        const np = v.type === "nested" ? path : nestedPath;
        out = out.concat(flattenProps(v.properties, path, np));
      } else {
        out.push({ name: path, type: (v && v.type) || "object", nestedPath: nestedPath || undefined });
      }
    }
    return out;
  }

  /** Elasticsearch / OpenSearch console: REST requests through the proxy,
      with an index/field browser that builds _search queries. */
  function esConsole(body, conn, c, ctx, getConn) {
    // Always resolve the cluster live so requests hit whatever this console tab
    // is bound to right now, not a connection captured when the tab was drawn.
    const cluster = () => (getConn && getConn()) || conn;
    const status = el("div", { class: "status-line dim" });
    // Same as the Kafka console: the last result has to outlive the re-render
    // an outer-tab switch causes, or the console comes back looking untouched.
    const say = (text, kind) => {
      if (kind === "ok" || kind === "err") { c.lastStatus = { text, kind }; ctx.save(); }
      else if (c.lastStatus) { delete c.lastStatus; ctx.save(); }
      setStatus(status, text, kind);
    };
    const out = el("div", { class: "tool", style: "flex:1;min-height:160px" });
    let esView = "table"; // _search results render as a grid by default

    // Search responses get the same table treatment as the SQL/Kafka grids —
    // hits are flattened to dot-notation columns, every cell expandable and
    // copyable — with the raw JSON one click away.
    const drawResponse = () => {
      out.replaceChildren();
      const text = c.response || "";
      if (!text) {
        out.append(el("div", { class: "status-line dim", text: "Send a request to see the response here" }));
        return;
      }
      const rawPre = () => {
        const p = el("pre", { class: "output", style: "flex:1;overflow:auto;margin:0" });
        p.textContent = text;
        return p;
      };
      let hits = null;
      try {
        const j = JSON.parse(text);
        if (j && j.hits && Array.isArray(j.hits.hits)) hits = j.hits.hits;
      } catch { /* not JSON — show it raw */ }
      if (!hits) { out.append(rawPre()); return; }

      out.append(el("div", { class: "subtabs" }, [
        el("button", { class: esView === "table" ? "active" : "", text: `Table (${hits.length})`, onclick: () => { esView = "table"; drawResponse(); } }),
        el("button", { class: esView === "raw" ? "active" : "", text: "Raw JSON", onclick: () => { esView = "raw"; drawResponse(); } }),
      ]));
      if (esView === "raw" || !hits.length) { out.append(rawPre()); return; }
      const flat = hits.map((h) => flatten(h._source, "", { _id: h._id }));
      const cols = [];
      for (const row of flat) for (const k of Object.keys(row)) if (!cols.includes(k)) cols.push(k);
      out.append(dataTable(cols, flat.map((row) => cols.map((k) => row[k] ?? ""))));
    };

    // copies the whole response body exactly as shown (pretty-printed JSON)
    const copyResponseBtn = () => {
      const btn = el("button", { class: "btn", text: "Copy response" });
      btn.addEventListener("click", () => {
        const text = c.response || "";
        if (!text) return say("✗ Nothing to copy — send a request first", "err");
        Devtil.copyText(text, btn);
      });
      return btn;
    };

    // Visible target so it's unambiguous which cluster this console talks to.
    const target = el("div", { class: "es-target" });
    const refreshTarget = () => {
      const k = cluster();
      target.replaceChildren(
        el("span", { class: "pane-label", text: "Target cluster" }),
        el("span", { class: "es-target-name", text: (k && k.name) || "—" }),
        el("span", { class: "es-target-url", text: k && k.baseUrl ? "→ " + k.baseUrl : "" }),
      );
    };
    refreshTarget();

    const methodSel = el("select", {}, ["GET", "POST", "PUT", "DELETE", "HEAD"].map((m) => el("option", { value: m, text: m })));
    methodSel.value = c.method || "GET";
    methodSel.addEventListener("change", () => { c.method = methodSel.value; ctx.save(); });
    const path = el("input", { type: "text", placeholder: "_cluster/health · my-index/_search", style: "flex:1" });
    path.value = c.path || "";
    path.addEventListener("input", () => { c.path = path.value; ctx.save(); });
    const reqBody = el("textarea", { rows: "4", style: "width:100%", spellcheck: "false", placeholder: '{"query": {"match_all": {}}, "size": 10}' });
    reqBody.value = c.body || "";
    reqBody.addEventListener("input", () => { c.body = reqBody.value; ctx.save(); });

    const send = async (method, p, bodyText) => {
      const k = cluster();
      if (!k || !k.baseUrl) return say("✗ The active cluster has no base URL", "err");
      say("Sending…", "dim");
      const headers = {};
      if (bodyText) headers["Content-Type"] = "application/json";
      if (k.username) headers["Authorization"] = "Basic " + btoa(k.username + ":" + (k.password || ""));
      try {
        const r = await api("POST", "/api/proxy", {
          method,
          url: k.baseUrl.replace(/\/+$/, "") + "/" + String(p || "").replace(/^\/+/, ""),
          headers,
          body: bodyText || "",
          insecure: !!k.insecure,
        });
        let text = r.body;
        try { text = JSON.stringify(JSON.parse(r.body), null, 2); } catch { /* not JSON */ }
        c.response = text;
        c.name = method + " /" + String(p || "").split("?")[0];
        // The first response is the moment the room stops belonging to the
        // request. Fold it once, unprompted; after that the toggle is the
        // developer's and we never move it again.
        if (c.reqCollapsed === undefined) c.reqCollapsed = true;
        ctx.save();
        applyReqOpen();
        drawResponse();
        say(`${r.status < 400 ? "✓" : "✗"} ${r.status} · ${r.durationMs} ms · ${fmtBytes(r.size)}`, r.status < 400 ? "ok" : "err");
      } catch (e) {
        say("✗ " + e.message, "err");
      }
    };
    const quick = (label, method, p) => el("button", {
      class: "btn", text: label,
      onclick: () => { c.method = method; c.path = p; methodSel.value = method; path.value = p; ctx.save(); send(method, p, ""); },
    });
    path.addEventListener("keydown", (e) => { if (e.key === "Enter") send(c.method || "GET", c.path, c.body); });

    // ---- query builder: index picker → field picker → generated _search ----
    const esFetch = async (method, p, bodyText) => {
      const k = cluster();
      if (!k || !k.baseUrl) throw new Error("the active cluster has no base URL");
      const headers = {};
      if (bodyText) headers["Content-Type"] = "application/json";
      if (k.username) headers["Authorization"] = "Basic " + btoa(k.username + ":" + (k.password || ""));
      const r = await api("POST", "/api/proxy", {
        method, url: k.baseUrl.replace(/\/+$/, "") + "/" + p, headers, body: bodyText || "", insecure: !!k.insecure,
      });
      if (r.status >= 400) throw new Error(r.status + " " + r.body.slice(0, 160));
      return JSON.parse(r.body);
    };

    // ---- export: re-run the search at the export size, flatten hits ----
    // Nested _source objects flatten to dot-notation columns; arrays are
    // JSON-encoded so a cell never silently loses data.
    const flatten = (obj, prefix, out) => {
      for (const [k, v] of Object.entries(obj || {})) {
        const key = prefix ? prefix + "." + k : k;
        if (v && typeof v === "object" && !Array.isArray(v)) flatten(v, key, out);
        else out[key] = Array.isArray(v) ? JSON.stringify(v) : v;
      }
      return out;
    };
    const doExport = async (fmt, n) => {
      let p = (c.path || "").split("?")[0];
      if (!/_search(\/|$)/.test(p)) {
        if (c.index) p = encodeURIComponent(c.index) + "/_search";
        else return say("✗ Point the request at a _search endpoint (or pick an index in the builder) first", "err");
      }
      let bodyObj = {};
      if ((c.body || "").trim()) {
        try { bodyObj = JSON.parse(c.body); } catch { return say("✗ Body is not valid JSON", "err"); }
      }
      if (!bodyObj.query) bodyObj.query = { match_all: {} };
      bodyObj.size = n;
      say(`Exporting up to ${n} hit(s)…`, "dim");
      try {
        const data = await esFetch("POST", p, JSON.stringify(bodyObj));
        const hits = data.hits && data.hits.hits;
        if (!Array.isArray(hits)) return say("✗ Response has no hits — is this a _search?", "err");
        const flat = hits.map((h) => flatten(h._source, "", { _id: h._id }));
        const cols = [];
        for (const row of flat) for (const k of Object.keys(row)) if (!cols.includes(k)) cols.push(k);
        exportRows(fmt, "elastic-export", cols, flat.map((row) => cols.map((k) => row[k] ?? "")));
        say(`✓ Exported ${flat.length} hit(s)`, "ok");
      } catch (e) {
        say("✗ " + e.message, "err");
      }
    };

    const idxSel = el("select", { style: "min-width:220px" });
    const fieldsBox = el("div");
    const qText = el("input", { type: "text", placeholder: "search text (query_string) — empty = match_all", style: "flex:1;min-width:220px" });
    qText.value = c.qText || "";
    qText.addEventListener("input", () => { c.qText = qText.value; ctx.save(); });
    const size = el("input", { type: "number", min: "1", max: "1000", style: "width:75px" });
    size.value = c.size || "10";
    size.addEventListener("input", () => { c.size = size.value; ctx.save(); });

    const fillIndices = () => {
      idxSel.replaceChildren(
        el("option", { value: "", text: "— pick an index —" }),
        ...(c.indices || []).map((n) => el("option", { value: n, text: n }))
      );
      if (c.index && (c.indices || []).includes(c.index)) idxSel.value = c.index;
    };
    const drawFields = () => {
      fieldsBox.replaceChildren();
      if (!c.index || !Array.isArray(c.fields) || !c.fields.length) return;
      if (!Array.isArray(c.selectedFields)) c.selectedFields = c.fields.map((f) => f.name);
      // collapsed by default — open to pick which fields come back
      const summary = el("summary", { text: `Return fields (_source) — ${c.selectedFields.length}/${c.fields.length} selected, open to choose` });
      fieldsBox.append(el("details", { class: "section" }, [
        summary,
        colsPicker(c.fields, c.selectedFields, (next) => {
          c.selectedFields = next;
          summary.textContent = `Return fields (_source) — ${next.length}/${c.fields.length} selected, open to choose`;
          syncBody();
        }),
      ]));
    };

    const loadIndices = async () => {
      say("Loading indices…", "dim");
      try {
        const list = await esFetch("GET", "_cat/indices?format=json");
        c.indices = list.map((i) => i.index).filter((n) => n && !n.startsWith(".")).sort();
        ctx.save();
        fillIndices();
        say(`✓ ${c.indices.length} index(es)`, "ok");
      } catch (e) {
        say("✗ " + e.message, "err");
      }
    };
    const loadFields = async () => {
      if (!c.index) { c.fields = []; drawFields(); renderConds(); return; }
      say("Loading mapping…", "dim");
      try {
        const m = await esFetch("GET", encodeURIComponent(c.index) + "/_mapping");
        const entry = m[c.index] || Object.values(m)[0] || {};
        c.fields = flattenProps(entry.mappings && entry.mappings.properties);
        c.selectedFields = c.fields.map((f) => f.name);
        ctx.save();
        drawFields();
        renderConds();
        say(`✓ ${c.fields.length} field(s)`, "ok");
      } catch (e) {
        say("✗ " + e.message, "err");
      }
    };
    idxSel.addEventListener("change", () => { c.index = idxSel.value; c.conds = []; ctx.save(); loadFields(); });

    // ---- per-field condition builder: the clause is auto-chosen by type ----
    const NUMERIC = ["long", "integer", "short", "byte", "double", "float", "half_float", "scaled_float", "unsigned_long"];
    const opsFor = (type) => {
      if (type === "text" || type === "match_only_text") return ["match", "match_phrase", "exists"];
      if (type === "keyword" || type === "ip" || type === "constant_keyword") return ["term", "terms", "prefix", "wildcard", "exists"];
      if (NUMERIC.includes(type)) return ["term", "gt", "gte", "lt", "lte", "between", "exists"];
      if (type === "date") return ["gte", "lte", "between", "term", "exists"];
      if (type === "boolean") return ["true", "false", "exists"];
      return ["match", "term", "exists"];
    };
    const OP_LABEL = { match: "matches", match_phrase: "phrase", term: "= (term)", terms: "in (a,b,c)", prefix: "prefix", wildcard: "wildcard *?", gt: ">", gte: "≥", lt: "<", lte: "≤", between: "between", "true": "is true", "false": "is false", exists: "exists" };
    const noValueOp = (op) => op === "exists" || op === "true" || op === "false";
    const coerce = (type, v) => {
      if (NUMERIC.includes(type)) { const n = Number(v); return v !== "" && !isNaN(n) ? n : v; }
      if (type === "boolean") return v === "true";
      return v;
    };
    const fieldByName = (name) => (c.fields || []).find((f) => f.name === name);

    const clauseFor = (cond) => {
      const f = cond.field, v = (cond.value || "").trim(), v2 = (cond.value2 || "").trim(), t = cond.type;
      let clause;
      switch (cond.op) {
        case "match": clause = { match: { [f]: v } }; break;
        case "match_phrase": clause = { match_phrase: { [f]: v } }; break;
        case "term": clause = { term: { [f]: coerce(t, v) } }; break;
        case "terms": clause = { terms: { [f]: v.split(",").map((s) => coerce(t, s.trim())).filter((x) => x !== "") } }; break;
        case "prefix": clause = { prefix: { [f]: v } }; break;
        case "wildcard": clause = { wildcard: { [f]: v } }; break;
        case "gt": case "gte": case "lt": case "lte": clause = { range: { [f]: { [cond.op]: coerce(t, v) } } }; break;
        case "between": clause = { range: { [f]: { gte: coerce(t, v), lte: coerce(t, v2) } } }; break;
        case "true": clause = { term: { [f]: true } }; break;
        case "false": clause = { term: { [f]: false } }; break;
        case "exists": clause = { exists: { field: f } }; break;
        default: clause = { match: { [f]: v } };
      }
      if (cond.nestedPath) clause = { nested: { path: cond.nestedPath, query: clause } };
      return clause;
    };

    const condsBox = el("div", { class: "es-conds" });
    const renderConds = () => {
      condsBox.replaceChildren();
      if (!c.index || !Array.isArray(c.fields) || !c.fields.length) {
        condsBox.append(el("div", { class: "status-line dim", text: "Load an index to add field conditions." }));
        return;
      }
      if (!Array.isArray(c.conds)) c.conds = [];
      const combineSel = el("select", {}, [el("option", { value: "must", text: "ALL (AND)" }), el("option", { value: "should", text: "ANY (OR)" })]);
      combineSel.value = c.combine || "must";
      combineSel.addEventListener("change", () => { c.combine = combineSel.value; syncBody(); });
      condsBox.append(el("div", { class: "toolbar" }, [
        el("span", { class: "pane-label", text: "Where — match" }),
        combineSel,
        el("span", { class: "pane-label", text: "of:" }),
        el("button", {
          class: "btn", text: "+ Add field condition",
          onclick: () => {
            const f = c.fields[0];
            c.conds.push({ field: f.name, type: f.type, nestedPath: f.nestedPath, op: opsFor(f.type)[0], value: "", value2: "" });
            syncBody();
            renderConds();
          },
        }),
      ]));

      c.conds.forEach((cond, i) => {
        const fieldSel = el("select", { style: "min-width:200px" }, c.fields.map((f) => el("option", { value: f.name, text: `${f.name} (${f.type})${f.nestedPath ? " ⓝ" : ""}` })));
        fieldSel.value = cond.field;
        const opSel = el("select", {}, opsFor(cond.type).map((o) => el("option", { value: o, text: OP_LABEL[o] || o })));
        if (!opsFor(cond.type).includes(cond.op)) cond.op = opsFor(cond.type)[0];
        opSel.value = cond.op;

        const valWrap = el("span", { style: "display:inline-flex;gap:4px;flex:1;align-items:center" });
        const buildVals = () => {
          valWrap.replaceChildren();
          if (noValueOp(cond.op)) return;
          const ph = cond.type === "date" ? "2026-01-01 or now-7d" : "value";
          const v1 = el("input", { type: "text", placeholder: ph, style: "flex:1;min-width:90px", value: cond.value || "" });
          v1.addEventListener("input", () => { cond.value = v1.value; syncBody(); });
          valWrap.append(v1);
          if (cond.op === "between") {
            const v2 = el("input", { type: "text", placeholder: "to", style: "flex:1;min-width:90px", value: cond.value2 || "" });
            v2.addEventListener("input", () => { cond.value2 = v2.value; syncBody(); });
            valWrap.append(el("span", { class: "pane-label", text: "…" }), v2);
          }
        };
        buildVals();

        fieldSel.addEventListener("change", () => {
          const f = fieldByName(fieldSel.value);
          cond.field = f.name; cond.type = f.type; cond.nestedPath = f.nestedPath;
          cond.op = opsFor(f.type)[0];
          syncBody();
          renderConds();
        });
        opSel.addEventListener("change", () => { cond.op = opSel.value; syncBody(); buildVals(); });

        condsBox.append(el("div", { class: "header-row" }, [
          fieldSel, opSel, valWrap,
          el("button", { class: "icon-btn", text: "×", title: "Remove condition", onclick: () => { c.conds.splice(i, 1); syncBody(); renderConds(); } }),
        ]));
      });
    };

    const buildQueryObj = () => {
      const clauses = (c.conds || []).filter((cond) => noValueOp(cond.op) || (cond.value || "").trim() !== "").map(clauseFor);
      if ((c.qText || "").trim()) clauses.push({ query_string: { query: c.qText.trim() } });
      let query;
      if (!clauses.length) query = { match_all: {} };
      else if (clauses.length === 1 && (c.combine || "must") === "must") query = clauses[0];
      else {
        const combine = c.combine || "must";
        query = { bool: { [combine]: clauses } };
        if (combine === "should") query.bool.minimum_should_match = 1;
      }
      const q = { query, size: Number(c.size) || 10 };
      const sel = c.selectedFields || [];
      if (sel.length && sel.length !== (c.fields || []).length) q._source = sel;
      return q;
    };

    const syncBody = () => {
      ctx.save();
      if (!c.index) return;
      c.method = "POST";
      c.path = c.index + "/_search";
      c.body = JSON.stringify(buildQueryObj(), null, 2);
      methodSel.value = c.method;
      path.value = c.path;
      reqBody.value = c.body;
    };
    const buildSearch = () => {
      if (!c.index) { say("✗ Pick an index first (Load indices)", "err"); return false; }
      syncBody();
      return true;
    };

    const builder = el("details", { class: "section" }, [
      el("summary", { text: "Query builder — pick an index & fields; the query is generated from each field's schema type" }),
      el("div", { class: "toolbar" }, [
        el("button", { class: "btn", text: "Load indices", onclick: loadIndices }),
        idxSel,
        el("label", { class: "inline" }, ["Size", size]),
        el("button", { class: "btn", text: "Build query", onclick: buildSearch }),
        el("button", { class: "btn primary", text: "Build & search", onclick: () => { if (buildSearch()) send(c.method, c.path, c.body); } }),
      ]),
      condsBox,
      el("div", { class: "toolbar" }, [el("span", { class: "pane-label", text: "Extra query_string (optional)" }), qText]),
      fieldsBox,
    ]);
    if (c.index) builder.open = true;
    fillIndices();
    drawFields();
    renderConds();

    // The request block — index picker, query builder and body — is the tall
    // part, and once a response is on screen it is usually the response you
    // want the room for. Everything except the send line folds away, and the
    // choice is remembered per console.
    const reqBlock = el("div", { class: "es-req" }, [
      target,
      builder,
      el("div", { class: "toolbar" }, [
        quick("Cluster health", "GET", "_cluster/health"),
        quick("Indices", "GET", "_cat/indices?v&format=json"),
        quick("Nodes", "GET", "_cat/nodes?v&format=json"),
      ]),
      el("div", {}, [el("span", { class: "pane-label", text: "Body (JSON, for _search etc.)" }), reqBody]),
    ]);
    const reqToggle = el("button", { class: "btn req-toggle" });
    const applyReqOpen = () => {
      const open = c.reqCollapsed !== true;
      reqBlock.classList.toggle("collapsed", !open);
      reqToggle.textContent = open ? "▾ Request" : "▸ Request";
      reqToggle.title = open ? "Fold the request away and give the response the pane" : "Show the index picker, query builder and body";
    };
    reqToggle.addEventListener("click", () => {
      c.reqCollapsed = c.reqCollapsed !== true;
      ctx.save();
      applyReqOpen();
    });
    applyReqOpen();

    body.append(
      el("div", { class: "console-controls" }, [
        reqBlock,
        el("div", { class: "req-line" }, [
          reqToggle, methodSel, path,
          el("button", { class: "btn primary", text: "Send", onclick: () => send(c.method || "GET", c.path, c.body) }),
        ]),
        // copy sits with the export actions so it's available for every
        // response, not just the _search ones that render as a table
        exportBar(c, ctx, doExport, [copyResponseBtn()]),
        status,
      ]),
      out
    );
    drawResponse();
    // put the last result back, so returning to this console shows it exactly
    // as you left it
    if (c.lastStatus) setStatus(status, c.lastStatus.text, c.lastStatus.kind);
  }

  clientTool({
    type: "kafka",
    icon: "📨",
    name: "Kafka",
    desc: "Browse topics, read messages (latest, from beginning, or a time range) with key/value search, and produce — multiple clusters, SASL/TLS.",
    connLabel: "Clusters",
    connSingular: "cluster",
    connName: (c) => c.brokers,
    fields: [
      { key: "name", label: "Name", placeholder: "prod-cluster" },
      { key: "brokers", label: "Brokers (comma-separated)", placeholder: "broker1:9092, broker2:9092" },
      { key: "timeoutMs", label: "Timeout (ms)", placeholder: "1000" },
      { key: "username", label: "SASL username (optional)" },
      { key: "password", label: "SASL password", type: "password" },
      { key: "tls", label: "TLS", type: "checkbox" },
      { key: "insecure", label: "Skip TLS verification", type: "checkbox" },
    ],
    newConsole: () => ({ id: uid(), topic: "", max: "50" }),
    consoleLabel: (c) => c.name || c.topic || "console",
    renderConsole: kafkaConsole,
  });

  clientTool({
    type: "elastic",
    icon: "🔎",
    name: "Elastic / OpenSearch",
    desc: "Query Elasticsearch and OpenSearch clusters: health, indices, search — with basic auth per cluster.",
    connLabel: "Clusters",
    connSingular: "cluster",
    connName: (c) => c.baseUrl,
    fields: [
      { key: "name", label: "Name", placeholder: "logs-cluster" },
      { key: "baseUrl", label: "Base URL", placeholder: "http://elastic-host:9200" },
      { key: "username", label: "Username (optional)" },
      { key: "password", label: "Password", type: "password" },
      { key: "insecure", label: "Skip TLS verification", type: "checkbox" },
    ],
    newConsole: () => ({ id: uid(), method: "GET", path: "_cluster/health", body: "" }),
    consoleLabel: (c) => c.name || "console",
    renderConsole: esConsole,
  });

  clientTool({
    type: "cassandra",
    icon: "💠",
    name: "Cassandra",
    desc: "Run CQL against Cassandra clusters — results grid, multiple connections and query tabs.",
    connLabel: "Connections",
    connSingular: "connection",
    connName: (c) => c.hosts,
    fields: [
      { key: "name", label: "Name", placeholder: "cass-prod" },
      { key: "hosts", label: "Contact points (comma-separated)", placeholder: "cass1, cass2" },
      { key: "port", label: "Port", placeholder: "9042" },
      { key: "keyspace", label: "Keyspace (optional)" },
      { key: "username", label: "Username (optional)" },
      { key: "password", label: "Password", type: "password" },
    ],
    newConsole: () => ({ id: uid(), query: "", maxRows: "200" }),
    consoleLabel: (c) => c.name || "cql",
    renderConsole: sqlConsole((conn) => ({
      type: "cassandra",
      label: "Cassandra",
      where: conn.keyspace ? "keyspace: " + conn.keyspace : (conn.hosts || ""),
      placeholder: "SELECT * FROM keyspace.table LIMIT 50;",
      browser: {
        tablesQuery: "SELECT keyspace_name, table_name FROM system_schema.tables",
        tableFromRow: (r) => {
          const system = ["system", "system_schema", "system_auth", "system_distributed", "system_traces", "system_views", "system_virtual_schema"];
          return system.includes(r[0]) ? null : r[0] + "." + r[1];
        },
        columnsQuery: (t) => {
          const [ks, tb] = t.split(".");
          return `SELECT column_name, type FROM system_schema.columns WHERE keyspace_name='${ks}' AND table_name='${tb}'`;
        },
        buildSelect: (t, cols, n) => `SELECT ${cols} FROM ${t} LIMIT ${n};`,
      },
    })),
  });

  clientTool({
    // type stays "oracle" so existing saved tabs keep working; the tool now
    // covers Oracle, MySQL and PostgreSQL, chosen per connection.
    type: "oracle",
    icon: "🗄",
    name: "Relational Databases",
    desc: "Run SQL against Oracle, MySQL and PostgreSQL (pure-Go drivers — no client install). Connect with host/port fields or a single URL; schema-aware query helper and results grid.",
    connLabel: "Connections",
    connSingular: "connection",
    connName: (c) => {
      const eng = { oracle: "Oracle", mysql: "MySQL", postgres: "PostgreSQL", postgresql: "PostgreSQL" }[String(c.engine || "oracle").toLowerCase()] || "Oracle";
      const loc = c.url || (c.hosts ? c.hosts + (c.database ? "/" + c.database : c.service ? "/" + c.service : "") : "");
      return eng + (loc ? " · " + loc : "");
    },
    fields: [
      { key: "name", label: "Name", placeholder: "orders-db" },
      { key: "engine", label: "Engine", type: "select", default: "oracle", options: [
        { value: "oracle", label: "Oracle" },
        { value: "mysql", label: "MySQL / MariaDB" },
        { value: "postgres", label: "PostgreSQL" },
      ] },
      { key: "url", label: "Connect URL (fills in the rest — overrides host/port below)", placeholder: "jdbc:oracle:thin:@host:1521/svc · mysql://u:p@host:3306/db · postgres://u:p@host:5432/db" },
      { key: "hosts", label: "Host", placeholder: "db-host" },
      { key: "port", label: "Port (blank = default: 1521 / 3306 / 5432)", placeholder: "1521" },
      { key: "service", label: "Oracle service name", placeholder: "ORCLPDB1" },
      { key: "database", label: "Database (MySQL / PostgreSQL)", placeholder: "sales" },
      { key: "schema", label: "Schema (Oracle owner / PostgreSQL schema — where to query)", placeholder: "HR / public" },
      { key: "username", label: "Username" },
      { key: "password", label: "Password", type: "password" },
      { key: "insecure", label: "Skip TLS (disable SSL)", type: "checkbox" },
    ],
    newConsole: () => ({ id: uid(), query: "", maxRows: "200" }),
    consoleLabel: (c) => c.name || "sql",
    renderConsole: sqlConsole((conn) => {
      const engine = rdbEngine(conn.engine);
      const nameOf = { oracle: "Oracle", mysql: "MySQL", postgres: "PostgreSQL" }[engine];
      const loc = engine === "oracle"
        ? (conn.schema ? "schema: " + conn.schema : (conn.service ? "service: " + conn.service : ""))
        : ((conn.database ? "db: " + conn.database : "") + (conn.schema ? (conn.database ? " · " : "") + "schema: " + conn.schema : ""));
      const host = (conn.hosts || "").split(",")[0].trim();
      return {
        type: engine,
        label: nameOf,
        where: [loc, host].filter(Boolean).join("  ·  "),
        placeholder: rdbPlaceholder(engine),
        browser: rdbBrowser(engine, conn),
      };
    }),
  });

  // ======================================================================
  // App Logs — devtil's own diagnostic log, for debugging the tools
  // ======================================================================
  registerTool({
    type: "applogs",
    icon: "🐞",
    name: "App Logs",
    desc: "Devtil's own diagnostic log: every kubectl/ssh command, proxy call, DB/Kafka connection and UI error — for debugging the tools themselves.",
    defaults: () => ({ lines: "500", filter: "", auto: false }),
    render(root, tab, ctx) {
      const d = tab.data;
      const status = el("div", { class: "status-line dim" });
      const pre = el("pre", { class: "output", style: "flex:1;min-height:200px" });
      let cached = [];
      let timer = null;

      const lines = bindField(el("input", { type: "number", min: "50", max: "5000", style: "width:90px" }), d, "lines", ctx);
      const filter = bindField(el("input", { type: "text", placeholder: "filter (e.g. kube:, error, pods)", style: "flex:1;min-width:180px" }), d, "filter", ctx, () => draw());
      const auto = bindField(el("input", { type: "checkbox" }), d, "auto", ctx, () => schedule());

      const draw = () => {
        const q = (d.filter || "").trim().toLowerCase();
        const shown = q ? cached.filter((l) => l.toLowerCase().includes(q)) : cached;
        pre.textContent = shown.join("\n") || "(no matching log lines)";
        pre.scrollTop = pre.scrollHeight;
      };

      const refresh = async () => {
        try {
          const r = await api("GET", "/api/logs?lines=" + (Number(d.lines) || 500));
          cached = r.lines || [];
          draw();
          setStatus(status, `✓ ${cached.length} line(s) · file: ${r.path}`, "ok");
        } catch (e) {
          setStatus(status, "✗ " + e.message, "err");
        }
      };

      const schedule = () => {
        clearInterval(timer);
        if (d.auto) timer = setInterval(() => {
          // stop polling once this tab is no longer on screen
          if (!root.isConnected) return clearInterval(timer);
          refresh();
        }, 3000);
      };

      root.append(
        el("div", { class: "toolbar" }, [
          el("button", { class: "btn primary", text: "⟳ Refresh", onclick: refresh }),
          el("label", { class: "inline" }, ["Tail", lines, "lines"]),
          filter,
          el("label", { class: "inline" }, [auto, "Auto-refresh (3s)"]),
          copyBtn(() => pre.textContent, "Copy"),
        ]),
        status,
        pre
      );
      refresh();
      schedule();
    },
  });

  // ======================================================================
  // Notepad
  // ======================================================================
  registerTool({
    type: "notepad",
    icon: "📝",
    name: "Notepad",
    desc: "Scratch pads that autosave as you type — multiple pads as inner tabs, named after their first line.",
    defaults: () => ({ pads: [], activePadId: null }),
    subTabs: (d) => (d.pads || []).map((p) => ({
      id: p.id,
      label: ((p.text || "").split("\n")[0].trim().slice(0, 32)) || "pad",
      select: () => { d.activePadId = p.id; },
      remove: () => {
        const i = d.pads.findIndex((x) => x.id === p.id);
        if (i >= 0) d.pads.splice(i, 1);
        if (d.activePadId === p.id) d.activePadId = d.pads[0]?.id ?? null;
      },
    })),
    render(root, tab, ctx) {
      const d = tab.data;
      const newPad = () => ({ id: uid(), text: "", mono: true });

      // migrate the old single-pad shape into the first inner pad
      if (!Array.isArray(d.pads)) d.pads = [];
      if (d.text !== undefined || d.mono !== undefined) {
        d.pads.unshift({ id: uid(), text: d.text || "", mono: d.mono !== false });
        delete d.text;
        delete d.mono;
      }
      if (!d.pads.length) d.pads.push(newPad());
      if (!d.pads.some((p) => p.id === d.activePadId)) d.activePadId = d.pads[0].id;

      const padLabel = (p) => {
        const first = (p.text || "").split("\n").find((l) => l.trim());
        return first ? first.trim().slice(0, 18) : "new pad";
      };

      const renderPad = () => {
        root.replaceChildren();
        const p = d.pads.find((x) => x.id === d.activePadId) || d.pads[0];

        root.append(el("div", { class: "req-tabs" }, [
          ...d.pads.map((pad) =>
            el("div", {
              class: "req-tab" + (pad.id === d.activePadId ? " active" : ""),
              onclick: () => {
                if (d.activePadId === pad.id) return;
                d.activePadId = pad.id;
                ctx.save();
                renderPad();
              },
            }, [
              el("span", { text: padLabel(pad) }),
              el("button", {
                class: "tab-close", text: "×", title: "Delete pad",
                onclick: async (e) => {
                  e.stopPropagation();
                  if ((pad.text || "").trim() && !(await confirmDialog(`Delete pad "${padLabel(pad)}" and its contents?`, { okLabel: "Delete", danger: true }))) return;
                  const idx = d.pads.findIndex((x) => x.id === pad.id);
                  d.pads.splice(idx, 1);
                  if (!d.pads.length) d.pads.push(newPad());
                  if (d.activePadId === pad.id) d.activePadId = d.pads[Math.min(idx, d.pads.length - 1)].id;
                  ctx.save();
                  renderPad();
                },
              }),
            ])
          ),
          el("button", {
            class: "icon-btn", text: "+", title: "New pad",
            onclick: () => {
              const pad = newPad();
              d.pads.push(pad);
              d.activePadId = pad.id;
              ctx.save();
              renderPad();
            },
          }),
        ]));

        const counter = el("span", { class: "status-line dim" });
        const area = el("textarea", { class: "grow", placeholder: "Type away — everything is saved automatically." });
        area.value = p.text || "";
        const mono = el("input", { type: "checkbox" });
        mono.checked = p.mono !== false;
        const wrap = el("input", { type: "checkbox" });
        wrap.checked = p.wrap !== false;

        const update = () => {
          area.style.fontFamily = p.mono !== false ? "var(--mono)" : "var(--sans)";
          // off = don't wrap long lines; the textarea scrolls horizontally
          area.wrap = p.wrap !== false ? "soft" : "off";
          area.style.whiteSpace = p.wrap !== false ? "" : "pre";
          const text = p.text || "";
          const words = text.trim() ? text.trim().split(/\s+/).length : 0;
          counter.textContent = `${text.length} chars · ${words} words · ${text ? text.split("\n").length : 0} lines`;
        };
        area.addEventListener("input", () => { p.text = area.value; ctx.save(); update(); });
        mono.addEventListener("change", () => { p.mono = mono.checked; ctx.save(); update(); });
        wrap.addEventListener("change", () => { p.wrap = wrap.checked; ctx.save(); update(); });

        // ---- find / replace -------------------------------------------------
        const findIn = el("input", { type: "text", placeholder: "Find", style: "min-width:150px" });
        const replIn = el("input", { type: "text", placeholder: "Replace with", style: "min-width:150px" });
        const caseChk = el("input", { type: "checkbox" });
        const findStatus = el("span", { class: "status-line dim" });
        const findBar = el("div", { class: "toolbar find-bar hidden" });

        const needle = () => findIn.value;
        const hay = () => area.value;
        const norm = (s) => (caseChk.checked ? s : s.toLowerCase());

        const setText = (next, caretAt) => {
          area.value = next;
          p.text = next;
          ctx.save();
          update();
          if (caretAt != null) { area.selectionStart = area.selectionEnd = caretAt; }
          area.focus();
        };

        // select the next match after the caret, wrapping to the top
        const findNext = (backwards) => {
          const n = needle();
          if (!n) return setStatus(findStatus, "", "dim");
          const h = norm(hay()), q = norm(n);
          let idx;
          if (backwards) {
            const before = area.selectionStart;
            idx = h.lastIndexOf(q, Math.max(0, before - 1));
            if (idx < 0) idx = h.lastIndexOf(q); // wrap to the end
          } else {
            idx = h.indexOf(q, area.selectionEnd);
            if (idx < 0) idx = h.indexOf(q); // wrap to the start
          }
          if (idx < 0) return setStatus(findStatus, "No matches", "err");
          area.focus();
          area.setSelectionRange(idx, idx + n.length);
          // keep the match in view
          const upto = area.value.slice(0, idx).split("\n").length;
          area.scrollTop = Math.max(0, (upto - 5) * 18);
          const total = countAll();
          setStatus(findStatus, `Match ${h.slice(0, idx).split(q).length} of ${total}`, "ok");
        };

        const countAll = () => {
          const n = needle();
          if (!n) return 0;
          return norm(hay()).split(norm(n)).length - 1;
        };

        const findAll = () => {
          const total = countAll();
          if (!needle()) return setStatus(findStatus, "Enter something to find", "err");
          setStatus(findStatus, total ? `${total} match(es)` : "No matches", total ? "ok" : "err");
          if (total) findNext(false);
        };

        // replace just the current selection when it is a match, then advance
        const replaceOne = () => {
          const n = needle();
          if (!n) return;
          const sel = area.value.slice(area.selectionStart, area.selectionEnd);
          if (sel && norm(sel) === norm(n)) {
            const at = area.selectionStart;
            setText(area.value.slice(0, at) + replIn.value + area.value.slice(area.selectionEnd), at + replIn.value.length);
            setStatus(findStatus, `Replaced · ${countAll()} left`, "ok");
          }
          findNext(false);
        };

        const replaceAll = () => {
          const n = needle();
          if (!n) return setStatus(findStatus, "Enter something to find", "err");
          const total = countAll();
          if (!total) return setStatus(findStatus, "No matches", "err");
          let out;
          if (caseChk.checked) {
            out = area.value.split(n).join(replIn.value);
          } else {
            // case-insensitive replace without regex, so the needle can hold
            // any characters safely
            const h = area.value, q = norm(n);
            let res = "", from = 0, i;
            while ((i = norm(h).indexOf(q, from)) >= 0) {
              res += h.slice(from, i) + replIn.value;
              from = i + n.length;
            }
            out = res + h.slice(from);
          }
          setText(out);
          setStatus(findStatus, `Replaced ${total} occurrence(s)`, "ok");
        };

        const showFind = (withReplace) => {
          findBar.classList.remove("hidden");
          replIn.style.display = withReplace ? "" : "none";
          findBar.querySelectorAll(".repl-only").forEach((b) => (b.style.display = withReplace ? "" : "none"));
          const sel = area.value.slice(area.selectionStart, area.selectionEnd);
          if (sel && !sel.includes("\n")) findIn.value = sel;
          findIn.focus();
          findIn.select();
        };
        const hideFind = () => { findBar.classList.add("hidden"); area.focus(); };

        findBar.append(
          el("span", { class: "pane-label", text: "Find" }),
          findIn,
          el("button", { class: "btn", text: "Find", title: "Enter / F3", onclick: () => findNext(false) }),
          el("button", { class: "btn", text: "◀", title: "Find previous (Shift+Enter / Shift+F3)", onclick: () => findNext(true) }),
          el("button", { class: "btn", text: "Find all", onclick: findAll }),
          replIn,
          el("button", { class: "btn repl-only", text: "Replace", onclick: replaceOne }),
          el("button", { class: "btn repl-only", text: "Replace all", onclick: replaceAll }),
          el("label", { class: "inline" }, [caseChk, "Match case"]),
          findStatus,
          el("button", { class: "icon-btn", text: "×", title: "Close (Esc)", onclick: hideFind }),
        );
        findIn.addEventListener("keydown", (e) => {
          if (e.key === "Enter") { e.preventDefault(); findNext(e.shiftKey); }
          if (e.key === "Escape") { e.preventDefault(); hideFind(); }
        });
        replIn.addEventListener("keydown", (e) => {
          if (e.key === "Enter") { e.preventDefault(); replaceOne(); }
          if (e.key === "Escape") { e.preventDefault(); hideFind(); }
        });

        // ---- line/text operations ------------------------------------------
        // operate on the selection when there is one, else the whole pad
        const onTarget = (fn) => () => {
          const s = area.selectionStart, e = area.selectionEnd;
          if (e > s) {
            const next = area.value.slice(0, s) + fn(area.value.slice(s, e)) + area.value.slice(e);
            setText(next);
            area.setSelectionRange(s, s + fn(area.value.slice(s, e)).length);
          } else {
            setText(fn(area.value));
          }
        };
        const lines = (t) => t.split("\n");
        const ops = [
          ["UPPER", (t) => t.toUpperCase()],
          ["lower", (t) => t.toLowerCase()],
          ["Sort", (t) => lines(t).sort((a, b) => a.localeCompare(b)).join("\n")],
          ["Dedupe", (t) => [...new Set(lines(t))].join("\n")],
          ["Trim", (t) => lines(t).map((l) => l.replace(/\s+$/, "")).join("\n")],
          ["Drop blanks", (t) => lines(t).filter((l) => l.trim()).join("\n")],
        ];

        root.append(
          el("div", { class: "toolbar" }, [
            el("button", { class: "btn", text: "Find", title: "Ctrl+F", onclick: () => showFind(false) }),
            el("button", { class: "btn", text: "Replace", title: "Ctrl+H", onclick: () => showFind(true) }),
            ...ops.map(([label, fn]) => el("button", { class: "btn", text: label, title: "Applies to the selection, or the whole pad", onclick: onTarget(fn) })),
            el("label", { class: "inline" }, [wrap, "Wrap"]),
            el("label", { class: "inline" }, [mono, "Monospace"]),
            copyBtn(() => p.text || "", "Copy all"),
            counter,
          ]),
          findBar,
          area
        );
        // editor shortcuts: Ctrl/Cmd+F find, Ctrl/Cmd+H replace, F3 next
        area.addEventListener("keydown", (e) => {
          const mod = e.ctrlKey || e.metaKey;
          if (mod && e.key.toLowerCase() === "f") { e.preventDefault(); showFind(false); }
          else if (mod && e.key.toLowerCase() === "h") { e.preventDefault(); showFind(true); }
          else if (e.key === "F3") { e.preventDefault(); findNext(e.shiftKey); }
          else if (e.key === "Escape") hideFind();
          else if (e.key === "Tab") { // keep Tab in the editor
            e.preventDefault();
            const s = area.selectionStart;
            setText(area.value.slice(0, s) + "  " + area.value.slice(area.selectionEnd), s + 2);
          }
        });
        update();
      };
      renderPad();
    },
  });

  // ======================================================================
  // Generators (UUID / random string / hash)
  // ======================================================================
  registerTool({
    type: "generate",
    icon: "🎲",
    name: "Generators",
    desc: "UUIDs, random strings/tokens, and SHA hashes of any text.",
    defaults: () => ({ uuidCount: "5", uuids: "", randLen: "32", randOut: "", hashInput: "", hashAlgo: "SHA-256", hashOut: "" }),
    render(root, tab, ctx) {
      const d = tab.data;

      // UUID
      const uuidOut = el("pre", { class: "output", text: d.uuids || "" });
      const uuidCount = bindField(el("input", { type: "number", min: "1", max: "500", style: "width:80px" }), d, "uuidCount", ctx);
      const genUuids = () => {
        const n = Math.min(Math.max(Number(d.uuidCount) || 1, 1), 500);
        d.uuids = Array.from({ length: n }, () => crypto.randomUUID()).join("\n");
        uuidOut.textContent = d.uuids;
        ctx.save();
      };

      // random string
      const randOut = el("pre", { class: "output", text: d.randOut || "" });
      const randLen = bindField(el("input", { type: "number", min: "1", max: "4096", style: "width:80px" }), d, "randLen", ctx);
      const genRand = () => {
        const n = Math.min(Math.max(Number(d.randLen) || 32, 1), 4096);
        const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
        const bytes = crypto.getRandomValues(new Uint8Array(n));
        d.randOut = Array.from(bytes, (b) => chars[b % chars.length]).join("");
        randOut.textContent = d.randOut;
        ctx.save();
      };

      // hash
      const hashOut = el("pre", { class: "output", text: d.hashOut || "" });
      const hashAlgo = bindField(
        el("select", {}, ["SHA-1", "SHA-256", "SHA-384", "SHA-512"].map((a) => el("option", { value: a, text: a }))),
        d, "hashAlgo", ctx
      );
      const hashInput = boundArea(d, "hashInput", ctx, { class: "", rows: "3", style: "width:100%", placeholder: "Text to hash" });
      const doHash = async () => {
        const buf = await crypto.subtle.digest(d.hashAlgo || "SHA-256", te.encode(d.hashInput || ""));
        d.hashOut = Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
        hashOut.textContent = d.hashOut;
        ctx.save();
      };

      root.append(
        el("span", { class: "pane-label", text: "UUID v4" }),
        el("div", { class: "toolbar" }, [
          uuidCount,
          el("button", { class: "btn primary", text: "Generate", onclick: genUuids }),
          copyBtn(() => d.uuids || ""),
        ]),
        uuidOut,
        el("span", { class: "pane-label", text: "Random string" }),
        el("div", { class: "toolbar" }, [
          randLen,
          el("button", { class: "btn primary", text: "Generate", onclick: genRand }),
          copyBtn(() => d.randOut || ""),
        ]),
        randOut,
        el("span", { class: "pane-label", text: "Hash" }),
        hashInput,
        el("div", { class: "toolbar" }, [
          hashAlgo,
          el("button", { class: "btn primary", text: "Hash", onclick: doHash }),
          copyBtn(() => d.hashOut || ""),
        ]),
        hashOut
      );
    },
  });

  // ======================================================================
  // Timestamp Converter
  // ======================================================================
  registerTool({
    type: "timestamp",
    icon: "⏱",
    name: "Timestamps",
    desc: "Convert between epoch seconds/millis and ISO dates — auto-detects what you paste.",
    defaults: () => ({ input: "" }),
    render(root, tab, ctx) {
      const d = tab.data;
      const status = el("div", { class: "status-line dim" });
      const table = el("div");

      const convert = () => {
        table.replaceChildren();
        const raw = (d.input || "").trim();
        if (!raw) return setStatus(status, "Enter an epoch or date, or press Now", "dim");
        let date, kind;
        if (/^\d{1,10}$/.test(raw)) { date = new Date(Number(raw) * 1000); kind = "epoch seconds"; }
        else if (/^\d{11,14}$/.test(raw)) { date = new Date(Number(raw)); kind = "epoch milliseconds"; }
        else { date = new Date(raw); kind = "date string"; }
        if (isNaN(date.getTime())) return setStatus(status, "✗ Could not parse input", "err");
        setStatus(status, "✓ Parsed as " + kind, "ok");

        const rel = (() => {
          const s = Math.round((date.getTime() - Date.now()) / 1000);
          const abs = Math.abs(s);
          const unit = abs < 60 ? [abs, "s"] : abs < 3600 ? [Math.round(abs / 60), "min"] : abs < 86400 ? [Math.round(abs / 3600), "h"] : [Math.round(abs / 86400), "d"];
          return `${unit[0]}${unit[1]} ${s < 0 ? "ago" : "from now"}`;
        })();

        const rows = [
          ["Epoch seconds", Math.floor(date.getTime() / 1000)],
          ["Epoch millis", date.getTime()],
          ["ISO 8601 (UTC)", date.toISOString()],
          ["Local", date.toString()],
          ["Relative", rel],
        ];
        table.append(el("table", { class: "kv" }, rows.map(([k, v]) => {
          const btn = Devtil.copyBtn(() => String(v));
          return el("tr", {}, [el("th", { text: k }), el("td", { text: String(v) }), el("td", {}, [btn])]);
        })));
      };

      const input = bindField(el("input", { type: "text", placeholder: "1700000000 · 2026-07-16T12:00:00Z · Jul 16 2026", style: "flex:1" }), d, "input", ctx, convert);
      root.append(
        el("div", { class: "toolbar" }, [
          input,
          el("button", { class: "btn primary", text: "Now", onclick: () => { d.input = String(Date.now()); input.value = d.input; ctx.save(); convert(); } }),
        ]),
        status,
        table
      );
      convert();
    },
  });

  // ======================================================================
  // Regex Tester
  // ======================================================================
  registerTool({
    type: "regex",
    icon: ".*",
    name: "Regex Tester",
    desc: "Test regular expressions live: match highlighting, groups, and match list.",
    defaults: () => ({ pattern: "", flags: "g", text: "" }),
    render(root, tab, ctx) {
      const d = tab.data;
      const status = el("div", { class: "status-line dim" });
      const highlighted = el("pre", { class: "output" });
      const groups = el("div");

      const run = () => {
        groups.replaceChildren();
        if (!d.pattern) {
          highlighted.textContent = d.text || "";
          return setStatus(status, "Enter a pattern", "dim");
        }
        let re;
        try {
          re = new RegExp(d.pattern, d.flags.includes("g") ? d.flags : d.flags + "g");
        } catch (e) {
          highlighted.textContent = d.text || "";
          return setStatus(status, "✗ " + e.message, "err");
        }
        const text = d.text || "";
        let html = "", last = 0, count = 0;
        const rows = [];
        for (const m of text.matchAll(re)) {
          count++;
          html += escapeHtml(text.slice(last, m.index)) + "<mark>" + escapeHtml(m[0]) + "</mark>";
          last = m.index + m[0].length;
          if (rows.length < 200) {
            rows.push(el("tr", {}, [
              el("th", { text: "#" + count + " @" + m.index }),
              el("td", { text: m[0] }),
              el("td", { text: m.length > 1 ? m.slice(1).map((g, i) => `$${i + 1}=${g ?? "∅"}`).join("  ") : "" }),
            ]));
          }
          if (m[0] === "") re.lastIndex++; // avoid infinite loop on empty matches
        }
        html += escapeHtml(text.slice(last));
        highlighted.innerHTML = html || "<span style='color:var(--text-dim)'>(empty)</span>";
        setStatus(status, count ? `✓ ${count} match(es)` : "0 matches", count ? "ok" : "dim");
        if (rows.length) groups.append(el("table", { class: "kv" }, rows));
      };

      root.append(
        el("div", { class: "toolbar" }, [
          "/",
          bindField(el("input", { type: "text", placeholder: "pattern", style: "flex:1" }), d, "pattern", ctx, run),
          "/",
          bindField(el("input", { type: "text", placeholder: "flags", style: "width:70px" }), d, "flags", ctx, run),
        ]),
        status,
        el("div", { class: "split" }, [
          el("div", {}, [el("span", { class: "pane-label", text: "Test text" }), boundArea(d, "text", ctx, {}, run)]),
          el("div", {}, [el("span", { class: "pane-label", text: "Matches" }), highlighted]),
        ]),
        groups
      );
      run();
    },
  });

  // ======================================================================
  // Text Diff
  // ======================================================================
  registerTool({
    type: "diff",
    icon: "±",
    name: "Text Diff",
    desc: "Line-by-line diff of two texts — spot what changed between configs, payloads, or outputs.",
    defaults: () => ({ left: "", right: "" }),
    render(root, tab, ctx) {
      const d = tab.data;
      const status = el("div", { class: "status-line dim" });
      const out = el("pre", { class: "output", style: "min-height:140px" });

      // classic LCS line diff
      const diff = () => {
        const a = (d.left || "").split("\n");
        const b = (d.right || "").split("\n");
        const n = a.length, m = b.length;
        if (n * m > 4_000_000) {
          out.textContent = "";
          return setStatus(status, "✗ Inputs too large to diff", "err");
        }
        const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
        for (let i = n - 1; i >= 0; i--) {
          for (let j = m - 1; j >= 0; j--) {
            dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
          }
        }
        const lines = [];
        let i = 0, j = 0, added = 0, removed = 0;
        while (i < n && j < m) {
          if (a[i] === b[j]) { lines.push(["ctx", a[i]]); i++; j++; }
          else if (dp[i + 1][j] >= dp[i][j + 1]) { lines.push(["del", a[i]]); removed++; i++; }
          else { lines.push(["add", b[j]]); added++; j++; }
        }
        while (i < n) { lines.push(["del", a[i++]]); removed++; }
        while (j < m) { lines.push(["add", b[j++]]); added++; }

        out.replaceChildren(...lines.map(([kind, text]) =>
          el("span", {
            class: "diff-line " + (kind === "add" ? "add" : kind === "del" ? "del" : ""),
            text: (kind === "add" ? "+ " : kind === "del" ? "- " : "  ") + text,
          })
        ));
        setStatus(status, added || removed ? `+${added} −${removed} lines` : "Texts are identical", added || removed ? "ok" : "dim");
      };

      root.append(
        el("div", { class: "split", style: "flex:0 0 30%" }, [
          el("div", {}, [el("span", { class: "pane-label", text: "Original" }), boundArea(d, "left", ctx, {}, diff)]),
          el("div", {}, [el("span", { class: "pane-label", text: "Changed" }), boundArea(d, "right", ctx, {}, diff)]),
        ]),
        status,
        out
      );
      diff();
    },
  });

  // ======================================================================
  // Knowledge Graph — an Open Knowledge Format bundle
  // ======================================================================
  // OKF (https://github.com/GoogleCloudPlatform/knowledge-catalog) stores
  // knowledge as plain markdown with YAML frontmatter: one file per concept,
  // the file path as its identity, and ordinary markdown links between files
  // as the graph. This tool is a reader/editor for the same bundle that
  // `devtil mcp` hands to AI agents, so what an agent records while it works
  // shows up here, and what you write here is there for the agent to find.

  const SVG_NS = "http://www.w3.org/2000/svg";

  function svg(tag, attrs = {}, children = []) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined) continue;
      if (k === "text") node.textContent = v;
      else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v);
    }
    for (const c of [].concat(children)) if (c) node.append(c);
    return node;
  }

  /** Force-directed layout, settled up front so the SVG renders static. */
  function layoutGraph(nodes, edges, width, height) {
    const n = nodes.length;
    if (!n) return [];
    const pts = nodes.map((node, i) => {
      // start on a circle: a deterministic seed keeps the picture stable
      // between renders instead of reshuffling on every refresh
      const a = (2 * Math.PI * i) / n;
      return { node, x: width / 2 + Math.cos(a) * width * 0.3, y: height / 2 + Math.sin(a) * height * 0.3, vx: 0, vy: 0 };
    });
    const index = new Map(pts.map((p, i) => [p.node.path, i]));
    const links = edges
      .map((e) => [index.get(e.from), index.get(e.to)])
      .filter(([a, b]) => a !== undefined && b !== undefined);

    const ideal = Math.min(width, height) / Math.max(2, Math.sqrt(n));
    for (let step = 0; step < 320; step++) {
      const cool = 1 - step / 320;
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          let dx = pts[i].x - pts[j].x, dy = pts[i].y - pts[j].y;
          let d2 = dx * dx + dy * dy;
          if (d2 < 1) { dx = (i - j) || 1; dy = 1; d2 = 2; }
          const f = (ideal * ideal) / d2;
          const d = Math.sqrt(d2);
          pts[i].vx += (dx / d) * f; pts[i].vy += (dy / d) * f;
          pts[j].vx -= (dx / d) * f; pts[j].vy -= (dy / d) * f;
        }
      }
      for (const [a, b] of links) {
        const dx = pts[b].x - pts[a].x, dy = pts[b].y - pts[a].y;
        const d = Math.max(1, Math.hypot(dx, dy));
        const f = (d * d) / ideal / 12;
        pts[a].vx += (dx / d) * f; pts[a].vy += (dy / d) * f;
        pts[b].vx -= (dx / d) * f; pts[b].vy -= (dy / d) * f;
      }
      for (const p of pts) {
        p.vx += (width / 2 - p.x) * 0.008;
        p.vy += (height / 2 - p.y) * 0.008;
        p.x += Math.max(-25, Math.min(25, p.vx * cool));
        p.y += Math.max(-25, Math.min(25, p.vy * cool));
        p.vx *= 0.6; p.vy *= 0.6;
        p.x = Math.max(40, Math.min(width - 40, p.x));
        p.y = Math.max(28, Math.min(height - 28, p.y));
      }
    }

    // The simulation settles at whatever scale the forces balance at, which
    // often leaves the graph huddled in one corner of a wide panel. Stretch
    // the settled bounding box to fill the canvas so the space is used.
    const padX = 60, padY = 34;
    const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    const sx = maxX - minX > 1 ? (width - 2 * padX) / (maxX - minX) : 1;
    const sy = maxY - minY > 1 ? (height - 2 * padY) / (maxY - minY) : 1;
    // one scale for both axes, so the layout is not sheared out of shape
    const scale = Math.min(sx, sy);
    const offX = (width - (maxX - minX) * scale) / 2 - minX * scale;
    const offY = (height - (maxY - minY) * scale) / 2 - minY * scale;
    for (const p of pts) {
      p.x = p.x * scale + offX;
      p.y = p.y * scale + offY;
    }
    return pts;
  }

  // A stable colour per concept type, so the same kind of thing looks the
  // same across renders without anyone maintaining a palette mapping.
  const KG_COLORS = ["#ff4f00", "#2b7fff", "#12a150", "#a855f7", "#e11d48", "#0891b2", "#ca8a04", "#7c3aed"];
  function typeColor(type) {
    if (!type) return "#8b8580";
    let h = 0;
    for (let i = 0; i < type.length; i++) h = (h * 31 + type.charCodeAt(i)) >>> 0;
    return KG_COLORS[h % KG_COLORS.length];
  }

  const OKF_TEMPLATE = [
    "# Overview",
    "",
    "What this is, and when someone would need it.",
    "",
    "# Related",
    "",
    "- [another concept](/path/to/concept.md)",
  ].join("\n");

  registerTool({
    type: "knowledge",
    icon: "🕸",
    name: "Knowledge Graph",
    desc: "Browse and edit an Open Knowledge Format bundle — markdown concepts linked into a graph. The same bundle AI agents read and write over MCP.",
    defaults: () => ({ view: "graph", path: "", query: "", typeFilter: "" }),
    render(root, tab, ctx) {
      const d = tab.data;
      const status = el("div", { class: "status-line dim" });
      const sideBox = el("div", { class: "api-side" });
      const mainBox = el("div", { class: "api-main" });

      let concepts = [];   // metadata for the list
      let graph = null;    // { nodes, edges, broken, orphans }
      // pan/zoom survives a re-render, so switching to a concept and back
      // does not throw away where you were looking
      let gView = null;
      // the previous graph pane's window listeners, dropped before the next
      // one installs its own
      let graphCleanup = null;
      let problems = [];
      let bundleRoot = "";

      const search = el("input", { type: "search", placeholder: "Search concepts…", value: d.query || "", style: "min-width:200px" });
      const typeSel = el("select", {});

      // ---- data -----------------------------------------------------------
      async function load(keepStatus) {
        try {
          const [list, g] = await Promise.all([
            api("GET", "/api/okf/list"),
            api("GET", "/api/okf/graph"),
          ]);
          concepts = list.concepts || [];
          bundleRoot = list.root || "";
          graph = g.graph || null;
          problems = g.problems || [];
          if (!keepStatus) {
            const bits = [`${concepts.length} concept${concepts.length === 1 ? "" : "s"}`];
            if (graph) bits.push(`${(graph.edges || []).length} links`);
            if (problems.length) bits.push(`${problems.length} issue${problems.length === 1 ? "" : "s"}`);
            bits.push(`OKF v${list.okfVersion}`);
            setStatus(status, (problems.length ? "⚠ " : "✓ ") + bits.join(" · ") + "  ·  " + bundleRoot, problems.length ? "err" : "ok");
          }
        } catch (e) {
          concepts = []; graph = null;
          setStatus(status, "✗ " + e.message, "err");
        }
        renderTypes();
        renderSide();
        renderMain();
      }

      function renderTypes() {
        const types = [...new Set(concepts.map((c) => c.type).filter(Boolean))].sort();
        typeSel.replaceChildren(
          el("option", { value: "", text: "All types" }),
          ...types.map((t) => el("option", { value: t, text: t }))
        );
        typeSel.value = types.includes(d.typeFilter) ? d.typeFilter : "";
        if (typeSel.value !== d.typeFilter) { d.typeFilter = typeSel.value; ctx.save(); }
      }

      function visible() {
        const q = (d.query || "").toLowerCase();
        return concepts.filter((c) =>
          (!d.typeFilter || c.type === d.typeFilter) &&
          (!q || (c.path + " " + c.title + " " + (c.description || "") + " " + (c.tags || []).join(" ")).toLowerCase().includes(q))
        );
      }

      // ---- concept list ---------------------------------------------------
      function renderSide() {
        const list = el("div", { class: "kg-list" });
        const shown = visible();
        if (!shown.length) {
          list.append(el("div", { class: "kg-empty", text: concepts.length ? "Nothing matches that filter." : "No concepts yet. Create one, or let an agent write the first." }));
        }
        const byType = new Map();
        for (const c of shown) {
          const key = c.type || "Untyped";
          if (!byType.has(key)) byType.set(key, []);
          byType.get(key).push(c);
        }
        for (const [type, items] of [...byType].sort((a, b) => a[0].localeCompare(b[0]))) {
          list.append(el("div", { class: "kg-group" }, [
            el("span", { class: "kg-dot", style: `background:${typeColor(type)}` }),
            el("span", { text: `${type} (${items.length})` }),
          ]));
          for (const c of items) {
            list.append(el("div", {
              class: "kg-item" + (c.path === d.path ? " active" : ""),
              title: c.path + (c.description ? "\n" + c.description : ""),
              onclick: () => open(c.path),
            }, [
              el("span", { class: "kg-item-title", text: c.title }),
              el("span", { class: "kg-item-path", text: c.path }),
            ]));
          }
        }
        // The type filter can also be set from the graph's legend, so keep
        // the dropdown in step rather than letting it claim "All types" while
        // the list is filtered.
        if (typeSel.value !== (d.typeFilter || "")) typeSel.value = d.typeFilter || "";
        sideBox.replaceChildren(
          el("div", { class: "toolbar" }, [search, typeSel]),
          el("div", { class: "api-side-content" }, [list])
        );
      }

      // ---- main pane ------------------------------------------------------
      function renderMain() {
        mainBox.replaceChildren(
          el("div", { class: "toolbar" }, [
            el("span", { class: "pane-label", text: "View" }),
            viewBtn("graph", "🕸 Graph"),
            viewBtn("doc", "📄 Concept"),
            el("span", { class: "spacer" }),
            el("button", { class: "btn primary", text: "+ New concept", onclick: newConcept }),
            el("button", {
              class: "btn", text: "⬇ Export", title: "Download the whole bundle as a zip you can share or commit",
              onclick: () => { window.location.href = "/api/okf/export"; },
            }),
            el("button", { class: "btn", text: "⬆ Import", title: "Merge someone else's bundle into yours", onclick: pickImport }),
            el("button", { class: "btn", text: "↻ Refresh", onclick: () => load() }),
          ]),
          d.view === "doc" ? docPane() : graphPane()
        );
      }

      function viewBtn(view, label) {
        return el("button", {
          class: "btn" + (d.view === view ? " active" : ""), text: label,
          onclick: () => { d.view = view; ctx.save(); renderMain(); },
        });
      }

      // ---- import a bundle archive ----------------------------------------
      function pickImport() {
        const input = el("input", { type: "file", accept: ".zip,application/zip", style: "display:none" });
        input.addEventListener("change", async () => {
          const f = input.files && input.files[0];
          input.remove();
          if (!f) return;
          const opts = await importDialog(f.name);
          if (!opts) return;
          setStatus(status, `Importing ${f.name}…`, "dim");
          try {
            const qs = new URLSearchParams();
            if (opts.prefix) qs.set("prefix", opts.prefix);
            if (opts.overwrite) qs.set("overwrite", "true");
            const res = await fetch("/api/okf/import?" + qs.toString(), { method: "POST", body: f });
            const out = await res.json();
            if (!res.ok) throw new Error(out.error || res.statusText);
            const bits = [`${(out.added || []).length} added`];
            if ((out.replaced || []).length) bits.push(`${out.replaced.length} replaced`);
            if ((out.skipped || []).length) bits.push(`${out.skipped.length} left alone (already here)`);
            if ((out.ignored || []).length) bits.push(`${out.ignored.length} ignored (not markdown)`);
            await load(true);
            setStatus(status, "✓ Imported — " + bits.join(", "), "ok");
          } catch (e) {
            setStatus(status, "✗ " + e.message, "err");
          }
        });
        document.body.append(input);
        input.click();
      }

      function importDialog(fileName) {
        return new Promise((resolve) => {
          const overlay = el("div", { class: "app-dialog-overlay" });
          const close = (v) => { overlay.remove(); document.removeEventListener("keydown", onKey); resolve(v); };
          const onKey = (e) => { e.stopPropagation(); if (e.key === "Escape") close(null); };
          document.addEventListener("keydown", onKey);

          const prefix = el("input", { class: "app-dialog-input", type: "text", placeholder: "e.g. vendor/acme — leave blank to merge at the top level" });
          const overwrite = el("input", { type: "checkbox" });

          overlay.append(el("div", { class: "app-dialog" }, [
            el("div", { class: "app-dialog-msg", text: `Import ${fileName}` }),
            el("div", { class: "set-note", text: "Concepts are merged into your bundle. Anything you already have is left untouched unless you say otherwise." }),
            el("div", { class: "field" }, [el("span", { class: "pane-label", text: "Import into folder (optional)" }), prefix]),
            el("label", { class: "inline" }, [overwrite, "Overwrite concepts I already have with the same path"]),
            el("div", { class: "app-dialog-actions" }, [
              el("button", { class: "btn", text: "Cancel", onclick: () => close(null) }),
              el("button", { class: "btn primary", text: "Import", onclick: () => close({ prefix: prefix.value.trim(), overwrite: overwrite.checked }) }),
            ]),
          ]));
          overlay.addEventListener("click", (e) => { if (e.target === overlay) close(null); });
          prefix.addEventListener("keydown", (e) => { if (e.key === "Enter") close({ prefix: prefix.value.trim(), overwrite: overwrite.checked }); });
          document.body.append(overlay);
          prefix.focus();
        });
      }

      // ---- graph ----------------------------------------------------------
      function graphPane() {
        const box = el("div", { class: "kg-graph" });
        if (!graph || !graph.nodes || !graph.nodes.length) {
          box.append(el("div", { class: "kg-empty", text: "The bundle is empty. Concepts appear here once they exist, and the links between them become edges." }));
          return box;
        }
        // Lay out once the box has real dimensions, otherwise every node
        // lands on top of the others in a zero-width viewport.
        requestAnimationFrame(() => buildGraph(box));
        return box;
      }

      function buildGraph(box) {
        const w = Math.max(320, box.clientWidth), h = Math.max(260, box.clientHeight);
        let unpinBtn = null; // created with the legend, revealed by a drag
        const real = graph.nodes.filter((n) => !n.reserved);
        const broken = graph.broken || [];
        // A link to a concept that doesn't exist yet is worth seeing, so give
        // each missing target a placeholder node rather than dropping the edge
        // and quietly showing a smaller graph than the bundle has.
        const known = new Set(real.map((n) => n.path));
        const missing = [...new Set(broken.map((e) => e.to))]
          .filter((p) => !known.has(p))
          .map((p) => ({ path: p, title: p.split("/").pop(), type: "", missing: true }));
        const nodes = real.concat(missing);
        const edges = (graph.edges || []).concat(broken);

        // degree drives node size, so the hubs of a domain stand out
        const degree = new Map(nodes.map((n) => [n.path, 0]));
        const adj = new Map(nodes.map((n) => [n.path, new Set()]));
        for (const e of edges) {
          if (degree.has(e.from)) degree.set(e.from, degree.get(e.from) + 1);
          if (degree.has(e.to)) degree.set(e.to, degree.get(e.to) + 1);
          if (adj.has(e.from)) adj.get(e.from).add(e.to);
          if (adj.has(e.to)) adj.get(e.to).add(e.from);
        }
        const radius = (n) => 6 + Math.min(9, (degree.get(n.path) || 0) * 1.6);

        const pts = layoutGraph(nodes, edges, w, h);
        // a node the user dragged keeps the spot they put it in
        for (const p of pts) {
          const pin = d.pins && d.pins[p.node.path];
          if (pin) { p.x = pin.x; p.y = pin.y; }
        }
        const at = new Map(pts.map((p) => [p.node.path, p]));

        const canvas = svg("svg", { class: "kg-svg", viewBox: `0 0 ${w} ${h}`, preserveAspectRatio: "xMidYMid meet" });
        canvas.append(svg("defs", {}, [
          svg("marker", { id: "kg-arrow", viewBox: "0 0 10 10", refX: "10", refY: "5", markerWidth: "6", markerHeight: "6", orient: "auto-start-reverse" },
            [svg("path", { d: "M 0 0 L 10 5 L 0 10 z", class: "kg-arrow-head" })]),
        ]));
        const viewport = svg("g", { class: "kg-viewport" });
        canvas.append(viewport);

        // ---- edges then nodes, so nodes sit on top
        const brokenSet = new Set(broken.map((e) => e.from + " " + e.to));
        const edgeEls = [];
        for (const e of edges) {
          const a = at.get(e.from), b = at.get(e.to);
          if (!a || !b) continue;
          const isBroken = brokenSet.has(e.from + " " + e.to);
          const line = svg("line", {
            x1: a.x, y1: a.y, x2: b.x, y2: b.y,
            class: "kg-edge" + (isBroken ? " broken" : ""),
            "marker-end": "url(#kg-arrow)",
          }, [svg("title", { text: `${e.from} → ${e.to}${isBroken ? " (broken link)" : ""}` })]);
          viewport.append(line);
          edgeEls.push({ e, line, a, b });
        }

        const nodeEls = new Map();
        for (const p of pts) {
          const isMissing = !!p.node.missing;
          const g = svg("g", {
            class: "kg-node" + (isMissing ? " missing" : "") + (p.node.path === d.path ? " active" : ""),
          });
          const circle = svg("circle", {
            cx: p.x, cy: p.y, r: radius(p.node),
            fill: isMissing ? "transparent" : typeColor(p.node.type),
          });
          const label = svg("text", { x: p.x, y: p.y - radius(p.node) - 6, "text-anchor": "middle", text: p.node.title });
          g.append(circle, label, svg("title", {
            text: isMissing
              ? `${p.node.path}\nlinked to, but this concept does not exist`
              : `${p.node.title}\n${p.node.type || "untyped"}\n${p.node.path}\n${degree.get(p.node.path) || 0} link(s)`,
          }));
          viewport.append(g);
          nodeEls.set(p.node.path, { g, circle, label, p, node: p.node });
        }

        // ---- highlight: the sidebar's filter, and whatever is hovered
        const q = (d.query || "").toLowerCase();
        const matches = (n) =>
          (!d.typeFilter || n.type === d.typeFilter) &&
          (!q || (n.path + " " + (n.title || "") + " " + (n.description || "")).toLowerCase().includes(q));
        const filtering = !!(q || d.typeFilter);
        let hovered = null;

        function applyHighlight() {
          // Hovering wins over the filter: you asked about *this* node now.
          const near = hovered ? new Set([hovered, ...(adj.get(hovered) || [])]) : null;
          for (const [path, ne] of nodeEls) {
            const dim = near ? !near.has(path) : (filtering && !matches(ne.node));
            ne.g.classList.toggle("dim", dim);
            ne.g.classList.toggle("hot", !!near && near.has(path));
          }
          for (const { e, line } of edgeEls) {
            const on = near
              ? (e.from === hovered || e.to === hovered)
              : (!filtering || (matches0(e.from) && matches0(e.to)));
            line.classList.toggle("dim", !on);
          }
        }
        const matches0 = (path) => {
          const ne = nodeEls.get(path);
          return ne ? matches(ne.node) : false;
        };

        // ---- pan / zoom ------------------------------------------------
        const view = gView || { k: 1, tx: 0, ty: 0 };
        const applyView = () => {
          viewport.setAttribute("transform", `translate(${view.tx} ${view.ty}) scale(${view.k})`);
          gView = view;
        };
        applyView();

        // Screen→world through the SVG's own matrix, so the maths stays right
        // whatever the element's size or aspect ratio is.
        const toWorld = (evt) => {
          const pt = canvas.createSVGPoint();
          pt.x = evt.clientX; pt.y = evt.clientY;
          const m = viewport.getScreenCTM();
          return m ? pt.matrixTransform(m.inverse()) : { x: 0, y: 0 };
        };

        canvas.addEventListener("wheel", (evt) => {
          evt.preventDefault();
          const before = toWorld(evt);
          const factor = Math.exp(-evt.deltaY * 0.0015);
          view.k = Math.max(0.2, Math.min(4, view.k * factor));
          applyView();
          const after = toWorld(evt);
          // keep the point under the cursor fixed while zooming
          view.tx += (after.x - before.x) * view.k;
          view.ty += (after.y - before.y) * view.k;
          applyView();
        }, { passive: false });

        let panFrom = null;
        canvas.addEventListener("mousedown", (evt) => {
          if (evt.target.closest(".kg-node")) return; // node drag handles it
          panFrom = { x: evt.clientX, y: evt.clientY, tx: view.tx, ty: view.ty };
          canvas.classList.add("panning");
        });
        // Dragging has to keep working when the pointer leaves the SVG, so
        // the listeners go on the window — which means the previous pane's
        // pair must be removed or every re-render leaks another set.
        if (graphCleanup) graphCleanup();
        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
        graphCleanup = () => {
          window.removeEventListener("mousemove", onMove);
          window.removeEventListener("mouseup", onUp);
          graphCleanup = null;
        };

        let dragging = null;
        function onMove(evt) {
          if (dragging) {
            const p = toWorld(evt);
            dragging.moved = true;
            dragging.entry.p.x = p.x;
            dragging.entry.p.y = p.y;
            placeNode(dragging.entry);
            return;
          }
          if (panFrom) {
            view.tx = panFrom.tx + (evt.clientX - panFrom.x);
            view.ty = panFrom.ty + (evt.clientY - panFrom.y);
            applyView();
          }
        }
        function onUp() {
          if (dragging) {
            if (dragging.moved) {
              // remember where the user put it
              if (!d.pins) d.pins = {};
              d.pins[dragging.path] = { x: dragging.entry.p.x, y: dragging.entry.p.y };
              ctx.save();
              // reveal the escape hatch as soon as there is something to undo,
              // rather than waiting for whatever re-renders next
              if (unpinBtn) unpinBtn.style.display = "";
            } else {
              openNode(dragging.entry);
            }
            dragging.entry.g.classList.remove("dragging");
            dragging = null;
          }
          panFrom = null;
          canvas.classList.remove("panning");
        }

        function placeNode(entry) {
          const r = radius(entry.node);
          entry.circle.setAttribute("cx", entry.p.x);
          entry.circle.setAttribute("cy", entry.p.y);
          entry.label.setAttribute("x", entry.p.x);
          entry.label.setAttribute("y", entry.p.y - r - 6);
          for (const { e, line } of edgeEls) {
            if (e.from === entry.node.path) { line.setAttribute("x1", entry.p.x); line.setAttribute("y1", entry.p.y); }
            if (e.to === entry.node.path) { line.setAttribute("x2", entry.p.x); line.setAttribute("y2", entry.p.y); }
          }
        }

        function openNode(entry) {
          if (entry.node.missing) {
            return setStatus(status, `${entry.node.path} is linked to but does not exist yet — create it to close the gap.`, "err");
          }
          open(entry.node.path);
        }

        for (const [path, entry] of nodeEls) {
          entry.g.addEventListener("mousedown", (evt) => {
            evt.stopPropagation();
            dragging = { path, entry, moved: false };
            entry.g.classList.add("dragging");
          });
          entry.g.addEventListener("mouseenter", () => { hovered = path; applyHighlight(); });
          entry.g.addEventListener("mouseleave", () => { hovered = null; applyHighlight(); });
        }

        applyHighlight();
        box.replaceChildren(canvas);

        // ---- legend + hints -------------------------------------------
        const types = [...new Set(real.map((n) => n.type).filter(Boolean))].sort();
        const legend = el("div", { class: "kg-legend-bar" });
        for (const t of types) {
          legend.append(el("button", {
            class: "kg-chip" + (d.typeFilter === t ? " active" : ""),
            title: d.typeFilter === t ? "Show all types" : `Highlight only ${t}`,
            onclick: () => {
              d.typeFilter = d.typeFilter === t ? "" : t;
              ctx.save();
              renderSide();
              renderMain();
            },
          }, [
            el("span", { class: "kg-dot", style: `background:${typeColor(t)}` }),
            el("span", { text: t }),
          ]));
        }
        legend.append(el("span", { class: "spacer" }));
        unpinBtn = el("button", {
          class: "btn kg-chip", text: "Unpin all",
          title: "Forget the positions you dragged nodes to",
          onclick: () => { d.pins = {}; ctx.save(); renderMain(); },
        });
        if (!(d.pins && Object.keys(d.pins).length)) unpinBtn.style.display = "none";
        legend.append(unpinBtn);
        legend.append(el("button", {
          class: "btn kg-chip", text: "Reset view", title: "Back to the default zoom and position",
          onclick: () => { gView = null; renderMain(); },
        }));
        box.append(legend);

        const hints = [];
        if (graph.orphans && graph.orphans.length) {
          hints.push(`${graph.orphans.length} unlinked concept(s) — link them from a related concept so they are discoverable`);
        }
        hints.push("scroll to zoom · drag the background to pan · drag a node to pin it · hover to isolate its links");
        box.append(el("div", { class: "kg-hint", text: hints.join("  ·  ") }));
      }

      function docPane() {
        const wrap = el("div", { class: "tool", style: "flex:1;min-height:0" });
        if (!d.path) {
          wrap.append(el("div", { class: "kg-empty", text: "Pick a concept on the left, or create one. Every concept is a markdown file with YAML frontmatter; the only required field is its type." }));
          return wrap;
        }
        const docStatus = el("div", { class: "status-line dim", text: "Loading…" });
        wrap.append(docStatus);
        const form = el("div", { style: "flex:1;min-height:0;display:flex;flex-direction:column;gap:8px" });
        wrap.append(form);

        api("GET", "/api/okf/doc?path=" + encodeURIComponent(d.path)).then((doc) => {
          const fm = doc.frontmatter || {};
          const fields = {};
          const textField = (key, label, placeholder) => {
            const input = el("input", { type: "text", value: fm[key] == null ? "" : String(fm[key]), placeholder: placeholder || "", style: "width:100%" });
            fields[key] = input;
            return el("div", { class: "field" }, [el("span", { class: "pane-label", text: label }), input]);
          };
          const tagsInput = el("input", { type: "text", value: (Array.isArray(fm.tags) ? fm.tags : []).join(", "), placeholder: "sales, revenue", style: "width:100%" });
          const body = el("textarea", { class: "grow", spellcheck: "false", style: "min-height:200px" });
          body.value = doc.body || "";

          const save = async () => {
            const front = {};
            for (const [k, input] of Object.entries(fields)) {
              const v = input.value.trim();
              // Sending null deletes a key, so clearing a field in the UI
              // removes it from the file rather than leaving an empty string.
              front[k] = v === "" ? null : v;
            }
            const tags = tagsInput.value.split(",").map((t) => t.trim()).filter(Boolean);
            front.tags = tags.length ? tags : null;
            try {
              await api("PUT", "/api/okf/doc", { path: d.path, frontmatter: front, body: body.value, merge: true });
              setStatus(docStatus, "✓ Saved " + d.path, "ok");
              load(true);
            } catch (e) {
              setStatus(docStatus, "✗ " + e.message, "err");
            }
          };

          const remove = async () => {
            if (!(await confirmDialog(`Delete ${d.path}? Concepts linking to it will show a broken link.`, { okLabel: "Delete", danger: true }))) return;
            try {
              await api("DELETE", "/api/okf/doc?path=" + encodeURIComponent(d.path));
              d.path = ""; ctx.save();
              await load();
            } catch (e) {
              setStatus(docStatus, "✗ " + e.message, "err");
            }
          };

          // Incoming links matter as much as outgoing ones: they are how you
          // find what depends on this concept.
          const incoming = (graph && graph.edges || []).filter((e) => e.to === doc.path);
          const linkChips = (items, get) => items.length
            ? items.map((it) => el("button", { class: "btn chip", text: get(it), onclick: () => open(get(it)) }))
            : [el("span", { class: "dim", text: "none" })];

          form.replaceChildren(
            el("div", { class: "toolbar" }, [
              el("span", { class: "pane-label", text: doc.path }),
              el("span", { class: "spacer" }),
              el("button", { class: "btn primary", text: "Save", onclick: save }),
              copyBtn(() => body.value, "Copy body"),
              el("button", { class: "btn danger", text: "Delete", onclick: remove }),
            ]),
            el("div", { class: "kg-fields" }, [
              textField("type", "Type (required)", "Runbook · Database Table · Kafka Topic"),
              textField("title", "Title", "Orders"),
              textField("status", "Status", "draft · stable · deprecated"),
              textField("resource", "Resource URI", "https://console…"),
            ]),
            textField("description", "Description", "One sentence: what this is."),
            el("div", { class: "field" }, [el("span", { class: "pane-label", text: "Tags (comma-separated)" }), tagsInput]),
            el("div", { class: "field", style: "flex:1;min-height:0;display:flex;flex-direction:column" }, [
              el("span", { class: "pane-label", text: "Body (markdown — link concepts with [text](/path/to/concept.md))" }),
              body,
            ]),
            el("details", { class: "section" }, [
              el("summary", { text: `Links — ${(doc.links || []).filter((l) => l.resolved).length} out, ${incoming.length} in` }),
              el("div", {}, [
                el("span", { class: "pane-label", text: "Links to" }),
                el("div", {}, linkChips((doc.links || []).filter((l) => l.resolved), (l) => l.resolved)),
                el("span", { class: "pane-label", text: "Linked from" }),
                el("div", {}, linkChips(incoming, (e) => e.from)),
              ]),
            ])
          );
          setStatus(docStatus, `Last modified ${doc.modTime || "—"} · ${fmtBytes(doc.size || 0)}`, "dim");
        }).catch((e) => setStatus(docStatus, "✗ " + e.message, "err"));

        return wrap;
      }

      // ---- actions --------------------------------------------------------
      function open(path) {
        d.path = path;
        d.view = "doc";
        ctx.save();
        renderSide();
        renderMain();
      }

      async function newConcept() {
        const path = await promptDialog("Path for the new concept (e.g. /runbooks/checkout.md):", "/notes/new-concept.md");
        if (!path) return;
        const type = await promptDialog("Concept type — the one field OKF requires:", "Note");
        if (!type) return;
        try {
          const doc = await api("PUT", "/api/okf/doc", {
            path, frontmatter: { type }, body: OKF_TEMPLATE, merge: false,
          });
          d.path = doc.path; d.view = "doc"; ctx.save();
          await load();
        } catch (e) {
          setStatus(status, "✗ " + e.message, "err");
        }
      }

      // the filter dims the graph as well as the list, so both have to redraw
      search.addEventListener("input", debounce(() => {
        d.query = search.value; ctx.save(); renderSide();
        if (d.view === "graph") renderMain();
      }, 200));
      typeSel.addEventListener("change", () => {
        d.typeFilter = typeSel.value; ctx.save(); renderSide();
        if (d.view === "graph") renderMain();
      });

      root.append(status, el("div", { class: "api-layout" }, [sideBox, mainBox]));
      load();
    },
  });
})();
