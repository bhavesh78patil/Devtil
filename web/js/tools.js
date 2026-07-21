/* Devtil tools. Each tool renders into a tab and stores everything it needs
   in tab.data, which is autosaved by the app shell via ctx.save(). */
"use strict";

(() => {
  const { registerTool, el, escapeHtml, debounce, uid, fmtBytes, copyBtn, setStatus, api } = Devtil;

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

  registerTool({
    type: "api",
    icon: "🚀",
    name: "API Client",
    desc: "Postman-like client: request tabs, a saved collection with global headers, Swagger/OpenAPI import, and history.",
    defaults: () => ({
      collection: { baseUrl: "", headers: [{ k: "", v: "" }], requests: [] },
      history: [], swaggerUrl: "", reqTabs: [], activeReqId: null,
    }),
    render(root, tab, ctx) {
      const d = tab.data;

      const newReqTab = (partial = {}) => ({
        id: uid(), name: partial.name || "New request", method: partial.method || "GET",
        url: partial.url || "", headers: partial.headers && partial.headers.length ? partial.headers : [{ k: "", v: "" }],
        body: partial.body || "", insecure: !!partial.insecure, response: partial.response || null,
      });

      // ---- init & migration from the pre-inner-tabs data shape ----
      if (!d.collection) d.collection = { baseUrl: "", headers: [], requests: [] };
      const col = d.collection;
      if (!Array.isArray(col.headers) || !col.headers.length) col.headers = [{ k: "", v: "" }];
      if (!Array.isArray(col.requests)) col.requests = [];
      if (!Array.isArray(d.history)) d.history = [];
      if (!Array.isArray(d.reqTabs)) d.reqTabs = [];
      if (d.method !== undefined || d.url !== undefined) {
        d.reqTabs.push(newReqTab({
          name: "Request", method: d.method, url: d.url, headers: d.headers,
          body: d.body, insecure: d.insecure, response: d.response,
        }));
        delete d.method; delete d.url; delete d.headers;
        delete d.body; delete d.insecure; delete d.response;
      }
      if (!d.reqTabs.length) d.reqTabs.push(newReqTab());
      if (!d.reqTabs.some((r) => r.id === d.activeReqId)) d.activeReqId = d.reqTabs[0].id;

      const active = () => d.reqTabs.find((r) => r.id === d.activeReqId) || d.reqTabs[0];
      const inCollection = (url) =>
        !!col.baseUrl && (url || "").toLowerCase().startsWith(col.baseUrl.toLowerCase());
      const resolveUrl = (path) => (/^https?:\/\//i.test(path) ? path : col.baseUrl + path);
      const shortPath = (url) => { try { return new URL(url).pathname; } catch { return url; } };
      const reqLabel = (r) => r.name || r.method + " " + (shortPath(r.url) || "…");

      // open (or focus) an inner request tab
      const openReqTab = (partial = {}) => {
        const url = partial.url || "";
        const existing = url && d.reqTabs.find((r) => r.method === (partial.method || "GET") && r.url === url);
        if (existing) {
          d.activeReqId = existing.id;
        } else {
          const t = newReqTab(partial);
          d.reqTabs.push(t);
          d.activeReqId = t.id;
        }
        ctx.save();
        renderMain();
      };

      // ---- key/value editor, used for request and collection headers ----
      const headersEditor = (list) => {
        const box = el("div", { style: "display:flex;flex-direction:column;gap:6px" });
        const render = () => {
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
                onclick: () => { list.splice(i, 1); if (!list.length) list.push({ k: "", v: "" }); ctx.save(); render(); },
              }),
            ]));
          });
          box.append(el("div", {}, [
            el("button", { class: "btn", text: "+ Header", onclick: () => { list.push({ k: "", v: "" }); ctx.save(); render(); } }),
          ]));
        };
        render();
        return box;
      };

      // ---- layout: side panel (collection/history) + main (request tabs) ----
      const sideBox = el("div", { class: "api-side" });
      const mainBox = el("div", { class: "api-main" });
      root.append(el("div", { class: "api-layout" }, [sideBox, mainBox]));
      let sideView = "collection";

      // ================= side panel =================

      function renderSide() {
        sideBox.replaceChildren(
          el("div", { class: "subtabs" }, [
            el("button", {
              class: sideView === "collection" ? "active" : "",
              text: `Collection (${col.requests.length})`,
              onclick: () => { sideView = "collection"; renderSide(); },
            }),
            el("button", {
              class: sideView === "history" ? "active" : "",
              text: "History",
              onclick: () => { sideView = "history"; renderSide(); },
            }),
          ]),
          sideView === "collection" ? collectionPanel() : historyPanel()
        );
      }

      function collectionPanel() {
        const box = el("div", { class: "api-side-content" });

        const baseInput = el("input", { type: "text", placeholder: "https://api.example.com", value: col.baseUrl, style: "width:100%" });
        baseInput.addEventListener("input", () => { col.baseUrl = baseInput.value.trim().replace(/\/+$/, ""); ctx.save(); });
        box.append(el("span", { class: "pane-label", text: "Base URL" }), baseInput);

        const ghCount = col.headers.filter((h) => h.k.trim()).length;
        const gh = el("details", { class: "section" }, [
          el("summary", { text: `Global headers (${ghCount}) — sent with every request under the base URL` }),
          headersEditor(col.headers),
        ]);
        if (ghCount) gh.open = true;
        box.append(gh);

        box.append(el("span", { class: "pane-label", text: "Saved requests — click to open in a tab" }));
        if (!col.requests.length) {
          box.append(el("div", { class: "status-line dim", text: "Nothing saved yet. Import from Swagger below, or use “Save to collection” on a request." }));
        }
        col.requests.forEach((r, i) => {
          box.append(el("div", {
            class: "history-item", title: "Open in a request tab",
            onclick: () => openReqTab({ name: r.name || r.method + " " + r.path, method: r.method, url: resolveUrl(r.path) }),
          }, [
            el("span", { text: r.method, style: "min-width:46px" }),
            el("span", { class: "h-url", text: r.path + (r.name ? " — " + r.name : "") }),
            el("button", {
              class: "icon-btn", text: "×", title: "Remove from collection",
              onclick: (e) => { e.stopPropagation(); col.requests.splice(i, 1); ctx.save(); renderSide(); },
            }),
          ]));
        });

        const importBox = el("div", { style: "display:flex;flex-direction:column;gap:4px" });
        const importStatus = el("div", { class: "status-line dim" });
        const swaggerIn = el("input", { type: "text", placeholder: "https://api.example.com/swagger.json", value: d.swaggerUrl || "", style: "width:100%" });
        swaggerIn.addEventListener("input", () => { d.swaggerUrl = swaggerIn.value; ctx.save(); });
        box.append(el("details", { class: "section" }, [
          el("summary", { text: "Import from Swagger / OpenAPI" }),
          swaggerIn,
          el("div", { style: "margin:6px 0" }, [
            el("button", { class: "btn primary", text: "Load endpoints", onclick: () => loadSwagger(swaggerIn.value.trim(), importBox, importStatus) }),
          ]),
          importStatus,
          importBox,
        ]));
        return box;
      }

      function historyPanel() {
        const box = el("div", { class: "api-side-content" });
        box.append(el("span", { class: "pane-label", text: "Sent requests — click to reopen in a tab" }));
        if (!d.history.length) box.append(el("div", { class: "status-line dim", text: "No requests sent yet" }));
        d.history.forEach((h) => {
          box.append(el("div", {
            class: "history-item", title: h.url,
            onclick: () => openReqTab({ name: h.method + " " + shortPath(h.url), method: h.method, url: h.url }),
          }, [
            el("span", { class: "badge s" + String(h.status)[0], text: h.status }),
            el("span", { text: h.method }),
            el("span", { class: "h-url", text: h.url }),
            el("span", { text: h.durationMs + "ms" }),
          ]));
        });
        return box;
      }

      async function loadSwagger(url, box, importStatus) {
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

        box.append(
          el("div", { class: "toolbar" }, [
            el("label", { class: "inline" }, [selectAll, "Select all"]),
            el("button", {
              class: "btn primary", text: "Import selected",
              onclick: () => {
                if (!col.baseUrl && baseUrl) col.baseUrl = baseUrl;
                endpoints.forEach((ep, i) => {
                  if (!checks[i].checked) return;
                  if (col.requests.some((r) => r.method === ep.method && r.path === ep.path)) return;
                  col.requests.push({ method: ep.method, path: ep.path, name: ep.name });
                });
                ctx.save();
                renderSide();
              },
            }),
          ]),
          ...endpoints.map((ep, i) =>
            el("div", { class: "history-item", onclick: () => { checks[i].checked = !checks[i].checked; } }, [
              checks[i],
              el("span", { text: ep.method, style: "min-width:46px" }),
              el("span", { class: "h-url", text: ep.path + (ep.name ? " — " + ep.name : "") }),
            ])
          )
        );
      }

      // ================= main: inner request tabs + editor + response =================

      function renderMain(view = "body") {
        const r = active();
        mainBox.replaceChildren();

        // inner request tab bar
        mainBox.append(el("div", { class: "req-tabs" }, [
          ...d.reqTabs.map((t) =>
            el("div", {
              class: "req-tab" + (t.id === d.activeReqId ? " active" : ""),
              onclick: () => {
                if (d.activeReqId === t.id) return;
                d.activeReqId = t.id;
                ctx.save();
                renderMain();
              },
            }, [
              el("span", { text: reqLabel(t) }),
              el("button", {
                class: "tab-close", text: "×", title: "Close request tab",
                onclick: (e) => {
                  e.stopPropagation();
                  const idx = d.reqTabs.findIndex((x) => x.id === t.id);
                  d.reqTabs.splice(idx, 1);
                  if (!d.reqTabs.length) d.reqTabs.push(newReqTab());
                  if (d.activeReqId === t.id) d.activeReqId = d.reqTabs[Math.min(idx, d.reqTabs.length - 1)].id;
                  ctx.save();
                  renderMain();
                },
              }),
            ])
          ),
          el("button", { class: "icon-btn", text: "+", title: "New request tab", onclick: () => openReqTab() }),
        ]));

        const status = el("div", { class: "status-line dim" });

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
          el("button", { class: "btn", text: "Save to collection", title: "Keep this request in the collection panel", onclick: saveToCollection }),
        ]));

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
          sendBtn.disabled = true;
          setStatus(status, "Sending…", "dim");
          try {
            const headers = {};
            if (inCollection(r.url.trim())) {
              for (const h of col.headers) if (h.k.trim()) headers[h.k.trim()] = h.v;
            }
            for (const h of r.headers) if (h.k.trim()) headers[h.k.trim()] = h.v;
            const resp = await api("POST", "/api/proxy", {
              method: r.method, url: r.url.trim(), headers, body: r.body, insecure: r.insecure,
            });
            r.response = resp;
            if (r.name === "New request") r.name = r.method + " " + (shortPath(r.url.trim()) || r.url.trim());
            d.history.unshift({ method: r.method, url: r.url.trim(), status: resp.status, durationMs: resp.durationMs, at: Date.now() });
            d.history.length = Math.min(d.history.length, 50);
            ctx.save();
            renderMain();
            if (sideView === "history") renderSide();
          } catch (e) {
            setStatus(status, "✗ " + e.message, "err");
            sendBtn.disabled = false;
            ctx.save();
          }
        }

        function saveToCollection() {
          const url = r.url.trim();
          if (!url) return setStatus(status, "✗ Enter a URL first", "err");
          const path = inCollection(url) ? url.slice(col.baseUrl.length) || "/" : url;
          if (col.requests.some((q) => q.method === r.method && q.path === path)) {
            return setStatus(status, "Already in the collection", "dim");
          }
          col.requests.push({ method: r.method, path, name: r.name === "New request" ? "" : r.name });
          ctx.save();
          setStatus(status, "✓ Saved — see the Collection panel on the left", "ok");
          sideView = "collection";
          renderSide();
        }
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
  registerTool({
    type: "kube",
    icon: "☸️",
    name: "Kube Console",
    desc: "Connect to the kubemaster over SSH (password), find pods, then open a terminal panel per container — tail logs, run commands, search folders.",
    defaults: () => ({
      sshHost: "", sshPort: "", sshPassword: "",
      context: "", namespace: "", podQuery: "", panels: [],
    }),
    render(root, tab, ctx) {
      const d = tab.data;
      if (!Array.isArray(d.panels)) d.panels = [];
      const status = el("div", { class: "status-line dim" });
      const podBox = el("div");
      const panelsArea = el("div", { class: "kube-panels" });

      // runtime-only state (not persisted): live tail timers, dedup sets,
      // and which panel is maximized
      const timers = {};
      const tailSeen = {};
      let maximizedId = null;

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
        maximizedId = null;
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
        const list = maximizedId ? d.panels.filter((p) => p.id === maximizedId) : d.panels;
        for (const panel of list) panelsArea.append(buildPanel(panel));
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
          tailBtn.textContent = "▶ Tail";
        };
        const startTail = () => {
          if (timers[panel.id]) return;
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
          headBtn(maximizedId === panel.id ? "🗗" : "🗖", "Maximize / restore", () => { maximizedId = maximizedId === panel.id ? null : panel.id; renderPanels(); }),
          headBtn("×", "Close panel", () => { stopTail(); d.panels = d.panels.filter((x) => x.id !== panel.id); if (maximizedId === panel.id) maximizedId = null; ctx.save(); renderPanels(); }),
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

        const cls = "kube-panel" + (maximizedId === panel.id ? " max" : "") + (panel.minimized ? " min" : "");
        const node = el("div", { class: cls }, [head, bodyEl]);
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

      const field = (label, node) => el("div", { class: "field" }, [el("span", { text: label }), node]);

      root.append(
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
          el("button", { class: "btn primary", text: "Find pods", onclick: loadPods }),
        ]),
        podBox,
        status,
        panelsArea
      );
      renderPanels();
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

  registerTool({
    type: "putty",
    icon: "🖥️",
    name: "SSH / PuTTY",
    desc: "Interactive SSH terminals (real PTY over WebSocket): multiple sessions in one tab, broadcast typing to all, minimize/maximize/close each.",
    defaults: () => ({ sessions: [], savedHosts: [], newHost: "", newPort: "22", newUser: "", newPass: "", shared: "" }),
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
          ? { background: "#201e1b", foreground: "#faf9f5", cursor: "#e0906f" }
          : { background: "#faf9f5", foreground: "#141413", cursor: "#cc785c" };
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
          try {
            r.fit.fit();
            if (r.ws && r.ws.readyState === 1) r.ws.send(JSON.stringify({ type: "resize", cols: r.term.cols, rows: r.term.rows }));
          } catch (e) { /* ignore */ }
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
        rt[s.id] = { term, fit, ws: null, wired: true };
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
        panelsArea.replaceChildren();
        if (!hasXterm) { panelsArea.append(el("div", { class: "status-line err", text: "Terminal component failed to load." })); return; }
        if (!d.sessions.length) { panelsArea.append(el("div", { class: "status-line dim", text: "No sessions. Add a host above and click “Open session”." })); return; }
        const list = reg.maximizedId ? d.sessions.filter((s) => s.id === reg.maximizedId) : d.sessions;
        for (const s of list) {
          if (!nodes[s.id]) nodes[s.id] = buildNode(s);
          const node = nodes[s.id];
          node.className = "kube-panel term-panel" + (reg.maximizedId === s.id ? " max" : "") + (s.minimized ? " min" : "");
          node._body.style.display = s.minimized ? "none" : "";
          panelsArea.append(node);
          if (!s.minimized) requestAnimationFrame(() => ensureTerm(s, node._hostEl));
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
      render(root, tab, ctx) {
        const d = tab.data;
        if (!Array.isArray(d.connections)) d.connections = [];
        if (!Array.isArray(d.consoles)) d.consoles = [];
        if (!d.consoles.length) d.consoles.push(cfg.newConsole());
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
            const input = f.type === "checkbox"
              ? el("input", { type: "checkbox" })
              : el("input", { type: f.type || "text", placeholder: f.placeholder || "", style: "width:100%" });
            if (existing) {
              if (f.type === "checkbox") input.checked = !!existing[f.key];
              else input.value = existing[f.key] || "";
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
                onclick: (e) => {
                  e.stopPropagation();
                  if (!confirm(`Delete ${cfg.connSingular} "${c.name || cfg.connName(c)}"?`)) return;
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
          const body = el("div", { class: "tool", style: "flex:1" });
          mainBox.append(body);
          if (!conn) {
            body.append(el("div", { class: "empty-hint" }, [
              el("div", { class: "big", text: cfg.icon }),
              el("div", { text: `Add a ${cfg.connSingular} in the left panel and click it to make it active.` }),
            ]));
            return;
          }
          cfg.renderConsole(body, conn, consoleData, ctx);
        }

        renderSide();
        renderMain();
      },
    });
  }

  /** Render a QueryResult (or {error}) as a status line + data grid. */
  function resultGrid(res) {
    if (!res) return el("div", { class: "status-line dim", text: "Run a query to see results here" });
    if (res.error) return el("div", { class: "status-line err", text: "✗ " + res.error });
    if (!res.columns || !res.columns.length) {
      return el("div", { class: "status-line ok", text: `✓ OK — ${res.rowsAffected ?? 0} row(s) affected · ${res.durationMs ?? 0} ms` });
    }
    return el("div", { class: "tool", style: "flex:1;min-height:0" }, [
      el("div", { class: "status-line ok", text: `✓ ${res.rows.length} row(s)${res.truncated ? " (truncated)" : ""} · ${res.durationMs} ms` }),
      el("div", { style: "overflow:auto;flex:1;min-height:120px" }, [
        el("table", { class: "kv" }, [
          el("tr", {}, res.columns.map((c) => el("th", { text: c }))),
          ...res.rows.map((r) => el("tr", {}, r.map((v) => el("td", { text: v })))),
        ]),
      ]),
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

  /** Query console shared by Cassandra and Oracle, with a table/column
      browser that builds SELECTs for you. */
  const sqlConsole = (dbType, placeholder, browser) => (body, conn, c, ctx) => {
    const status = el("div", { class: "status-line dim" });
    const out = el("div", { style: "flex:1;overflow:auto;display:flex;flex-direction:column" });

    const query = el("textarea", { rows: "5", style: "width:100%", spellcheck: "false", placeholder });
    query.value = c.query || "";
    query.addEventListener("input", () => { c.query = query.value; ctx.save(); });

    const maxRows = el("input", { type: "number", min: "1", max: "5000", style: "width:90px" });
    maxRows.value = c.maxRows || "200";
    maxRows.addEventListener("input", () => { c.maxRows = maxRows.value; ctx.save(); });

    const run = async () => {
      if (!(c.query || "").trim()) return setStatus(status, "✗ Enter a query", "err");
      setStatus(status, "Running…", "dim");
      try {
        const res = await api("POST", "/api/db/query", {
          type: dbType,
          conn: { ...conn, port: Number(conn.port) || 0 },
          query: c.query,
          maxRows: Number(c.maxRows) || 200,
        });
        c.result = res;
        setStatus(status, "", "dim");
      } catch (e) {
        c.result = { error: e.message };
        setStatus(status, "", "dim");
      }
      c.name = consoleName(c.query, "query");
      ctx.save();
      out.replaceChildren(resultGrid(c.result));
    };
    query.addEventListener("keydown", (e) => { if ((e.ctrlKey || e.metaKey) && e.key === "Enter") run(); });

    // ---- query helper: table picker → column picker → generated SELECT ----
    const dbq = (q) => api("POST", "/api/db/query", {
      type: dbType, conn: { ...conn, port: Number(conn.port) || 0 }, query: q, maxRows: 5000,
    });

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
      colsBox.append(
        el("span", { class: "pane-label", text: `Columns of ${c.table} — pick what to select` }),
        colsPicker(c.cols, c.selectedCols, (next) => { c.selectedCols = next; ctx.save(); })
      );
    };

    const loadTables = async () => {
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
        const res = await dbq(browser.columnsQuery(c.table));
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
      c.query = browser.buildSelect(c.table, colSql, Number(c.limit) || 50);
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
      helper,
      query,
      el("div", { class: "toolbar" }, [
        el("button", { class: "btn primary", text: "Run (Ctrl+Enter)", onclick: run }),
        el("label", { class: "inline" }, ["Max rows", maxRows]),
        status,
      ]),
      out
    );
    out.replaceChildren(resultGrid(c.result));
  };

  /** Kafka console: topics browser, consumer (latest/beginning/time-range
      with key & value search), producer. */
  function kafkaConsole(body, conn, c, ctx) {
    const status = el("div", { class: "status-line dim" });
    const out = el("div", { style: "flex:1;overflow:auto;display:flex;flex-direction:column;gap:10px" });

    // connection payload with numeric timeout (form fields store strings)
    const kconn = () => ({ ...conn, timeoutMs: Number(conn.timeoutMs) || 1000 });

    // topic picker: a real dropdown populated by "List topics", plus a text
    // field for typing a custom topic. Either keeps c.topic in sync.
    const topic = el("input", { type: "text", placeholder: "topic name", style: "min-width:160px" });
    topic.value = c.topic || "";
    topic.addEventListener("input", () => { c.topic = topic.value.trim(); topicSel.value = topic.value.trim(); ctx.save(); });
    const topicSel = el("select", { style: "min-width:200px" });
    topicSel.addEventListener("change", () => {
      if (!topicSel.value) return;
      c.topic = topicSel.value;
      topic.value = topicSel.value;
      ctx.save();
    });
    const fillTopics = () => {
      const opts = [el("option", { value: "", text: (c.topics && c.topics.length) ? `— pick a topic (${c.topics.length}) —` : "— List topics first —" })];
      for (const t of (c.topics || [])) opts.push(el("option", { value: t.name, text: `${t.name} (${t.partitions}p)` }));
      topicSel.replaceChildren(...opts);
      // reflect the current topic in the dropdown if it's one of the listed ones
      if (c.topic && (c.topics || []).some((t) => t.name === c.topic)) topicSel.value = c.topic;
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

    const valueCell = (m) => {
      const pretty = tryPretty(m.value);
      const pre = el("pre", { class: "kafka-val-pre collapsed" });
      pre.textContent = pretty;
      const toggle = el("button", { class: "btn xs", text: "Expand" });
      toggle.addEventListener("click", () => {
        const collapsed = pre.classList.toggle("collapsed");
        toggle.textContent = collapsed ? "Expand" : "Collapse";
      });
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
      const tools = el("div", { class: "kafka-val-tools" }, [
        toggle,
        el("button", { class: "btn xs", text: "⤢ Maximize", title: "Open full-screen with Value & Headers tabs", onclick: maximize }),
        copyBtn(() => pretty, "Copy"),
      ]);
      return el("td", { class: "kafka-val-cell" }, [tools, pre]);
    };

    const draw = () => {
      out.replaceChildren();
      if (Array.isArray(c.messages)) {
        // newest first (backend returns chronological; reverse for display)
        const rows = c.messages.slice().reverse();
        out.append(
          el("span", { class: "pane-label", text: `Messages (${c.messages.length}, newest first)` }),
          el("table", { class: "kv kafka-msgs" }, [
            el("tr", {}, [
              el("th", { class: "nowrap", text: "P/Offset" }),
              el("th", { class: "nowrap", text: "Time" }),
              el("th", { class: "nowrap", text: "Key" }),
              el("th", { text: "Value" }),
            ]),
            ...rows.map((m) => el("tr", {}, [
              el("td", { class: "nowrap", text: m.partition + "/" + m.offset }),
              el("td", { class: "nowrap", text: (m.time || "").replace("T", " ").replace("Z", "") }),
              el("td", { class: "kafka-key", title: m.key, text: m.key }),
              valueCell(m),
            ])),
          ])
        );
      }
    };

    const listTopics = async () => {
      setStatus(status, "Listing topics…", "dim");
      try {
        const r = await api("POST", "/api/kafka/topics", { conn: kconn() });
        c.topics = r.topics || [];
        ctx.save();
        fillTopics();
        setStatus(status, c.topics.length
          ? `✓ ${c.topics.length} topic(s) — pick one from the dropdown`
          : "✓ Connected, but no (non-internal) topics were returned", c.topics.length ? "ok" : "dim");
      } catch (e) {
        setStatus(status, "✗ " + e.message, "err");
      }
    };
    const consume = async () => {
      if (!c.topic) return setStatus(status, "✗ Enter or pick a topic", "err");
      if ((c.from || "latest") === "time" && !c.startT) {
        return setStatus(status, "✗ Set the start of the time range", "err");
      }
      setStatus(status, "Reading messages…", "dim");
      try {
        const r = await api("POST", "/api/kafka/consume", {
          conn: kconn(),
          topic: c.topic,
          max: Number(c.max) || 50,
          from: c.from || "latest",
          startMs: c.startT ? new Date(c.startT).getTime() : 0,
          endMs: c.endT ? new Date(c.endT).getTime() : 0,
          keyQuery: c.keyQ || "",
          valueQuery: c.valQ || "",
        });
        c.messages = r.messages;
        c.name = c.topic;
        ctx.save();
        draw();
        setStatus(status,
          `✓ ${r.matched} match(es) of ${r.scanned} scanned, showing ${r.messages.length}${r.truncated ? " (scan capped — narrow the range or raise Last N)" : ""}`,
          "ok");
      } catch (e) {
        setStatus(status, "✗ " + e.message, "err");
      }
    };

    if (!Array.isArray(c.prodHeaders)) c.prodHeaders = [{ k: "", v: "" }];
    const prodKey = el("input", { type: "text", placeholder: "key (optional)", style: "width:160px" });
    prodKey.value = c.prodKey || "";
    prodKey.addEventListener("input", () => { c.prodKey = prodKey.value; ctx.save(); });
    const prodValue = el("input", { type: "text", placeholder: "message value", style: "flex:1;min-width:200px" });
    prodValue.value = c.prodValue || "";
    prodValue.addEventListener("input", () => { c.prodValue = prodValue.value; ctx.save(); });
    const produce = async () => {
      if (!c.topic) return setStatus(status, "✗ Enter or pick a topic", "err");
      setStatus(status, "Producing…", "dim");
      try {
        const headers = (c.prodHeaders || []).filter((h) => h.k.trim()).map((h) => ({ key: h.k.trim(), value: h.v }));
        await api("POST", "/api/kafka/produce", { conn: kconn(), topic: c.topic, key: c.prodKey || "", value: c.prodValue || "", headers });
        setStatus(status, `✓ Message produced to ${c.topic}${headers.length ? " with " + headers.length + " header(s)" : ""}`, "ok");
      } catch (e) {
        setStatus(status, "✗ " + e.message, "err");
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
        produceBox.append(el("div", { class: "toolbar" }, [el("label", { class: "inline" }, ["Key", prodKey]), prodValue]));
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

    body.append(
      el("div", { class: "toolbar" }, [
        el("button", { class: "btn", text: "List topics", onclick: listTopics }),
        topicSel,
        el("label", { class: "inline" }, ["or", topic]),
        el("label", { class: "inline" }, ["Read", fromSel]),
        startWrap,
        endWrap,
        el("label", { class: "inline" }, ["Max", max, "msgs"]),
        el("button", { class: "btn primary", text: "Consume", onclick: consume }),
      ]),
      el("div", { class: "toolbar" }, [
        el("span", { class: "pane-label", text: "Search" }),
        keyQ, valQ,
      ]),
      produceBox,
      status,
      out
    );
    syncFrom();
    fillTopics();
    renderProduce();
    draw();
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
  function esConsole(body, conn, c, ctx) {
    const status = el("div", { class: "status-line dim" });
    const out = el("pre", { class: "output", style: "flex:1;min-height:160px" });

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
      if (!conn.baseUrl) return setStatus(status, "✗ The active cluster has no base URL", "err");
      setStatus(status, "Sending…", "dim");
      const headers = {};
      if (bodyText) headers["Content-Type"] = "application/json";
      if (conn.username) headers["Authorization"] = "Basic " + btoa(conn.username + ":" + (conn.password || ""));
      try {
        const r = await api("POST", "/api/proxy", {
          method,
          url: conn.baseUrl.replace(/\/+$/, "") + "/" + String(p || "").replace(/^\/+/, ""),
          headers,
          body: bodyText || "",
          insecure: !!conn.insecure,
        });
        let text = r.body;
        try { text = JSON.stringify(JSON.parse(r.body), null, 2); } catch { /* not JSON */ }
        c.response = text;
        c.name = method + " /" + String(p || "").split("?")[0];
        ctx.save();
        out.textContent = text;
        setStatus(status, `${r.status < 400 ? "✓" : "✗"} ${r.status} · ${r.durationMs} ms · ${fmtBytes(r.size)}`, r.status < 400 ? "ok" : "err");
      } catch (e) {
        setStatus(status, "✗ " + e.message, "err");
      }
    };
    const quick = (label, method, p) => el("button", {
      class: "btn", text: label,
      onclick: () => { c.method = method; c.path = p; methodSel.value = method; path.value = p; ctx.save(); send(method, p, ""); },
    });
    path.addEventListener("keydown", (e) => { if (e.key === "Enter") send(c.method || "GET", c.path, c.body); });

    // ---- query builder: index picker → field picker → generated _search ----
    const esFetch = async (method, p) => {
      if (!conn.baseUrl) throw new Error("the active cluster has no base URL");
      const headers = {};
      if (conn.username) headers["Authorization"] = "Basic " + btoa(conn.username + ":" + (conn.password || ""));
      const r = await api("POST", "/api/proxy", {
        method, url: conn.baseUrl.replace(/\/+$/, "") + "/" + p, headers, body: "", insecure: !!conn.insecure,
      });
      if (r.status >= 400) throw new Error(r.status + " " + r.body.slice(0, 160));
      return JSON.parse(r.body);
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
      fieldsBox.append(
        el("span", { class: "pane-label", text: `Return fields (_source) — pick which columns come back` }),
        colsPicker(c.fields, c.selectedFields, (next) => { c.selectedFields = next; syncBody(); })
      );
    };

    const loadIndices = async () => {
      setStatus(status, "Loading indices…", "dim");
      try {
        const list = await esFetch("GET", "_cat/indices?format=json");
        c.indices = list.map((i) => i.index).filter((n) => n && !n.startsWith(".")).sort();
        ctx.save();
        fillIndices();
        setStatus(status, `✓ ${c.indices.length} index(es)`, "ok");
      } catch (e) {
        setStatus(status, "✗ " + e.message, "err");
      }
    };
    const loadFields = async () => {
      if (!c.index) { c.fields = []; drawFields(); renderConds(); return; }
      setStatus(status, "Loading mapping…", "dim");
      try {
        const m = await esFetch("GET", encodeURIComponent(c.index) + "/_mapping");
        const entry = m[c.index] || Object.values(m)[0] || {};
        c.fields = flattenProps(entry.mappings && entry.mappings.properties);
        c.selectedFields = c.fields.map((f) => f.name);
        ctx.save();
        drawFields();
        renderConds();
        setStatus(status, `✓ ${c.fields.length} field(s)`, "ok");
      } catch (e) {
        setStatus(status, "✗ " + e.message, "err");
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
      if (!c.index) { setStatus(status, "✗ Pick an index first (Load indices)", "err"); return false; }
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

    body.append(
      builder,
      el("div", { class: "toolbar" }, [
        quick("Cluster health", "GET", "_cluster/health"),
        quick("Indices", "GET", "_cat/indices?v&format=json"),
        quick("Nodes", "GET", "_cat/nodes?v&format=json"),
      ]),
      el("div", { class: "req-line" }, [
        methodSel, path,
        el("button", { class: "btn primary", text: "Send", onclick: () => send(c.method || "GET", c.path, c.body) }),
      ]),
      el("div", {}, [el("span", { class: "pane-label", text: "Body (JSON, for _search etc.)" }), reqBody]),
      status,
      out
    );
    if (c.response) out.textContent = c.response;
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
    renderConsole: sqlConsole("cassandra", "SELECT * FROM keyspace.table LIMIT 50;", {
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
    }),
  });

  clientTool({
    type: "oracle",
    icon: "🏛",
    name: "Oracle",
    desc: "Run SQL against Oracle databases (no Oracle client install needed) — results grid, multiple connections.",
    connLabel: "Connections",
    connSingular: "connection",
    connName: (c) => c.url || (c.hosts ? c.hosts + (c.service ? "/" + c.service : "") : ""),
    fields: [
      { key: "name", label: "Name", placeholder: "orders-db" },
      { key: "url", label: "JDBC / connect URL (fills in the rest below)", placeholder: "jdbc:oracle:thin:@host:1521/service" },
      { key: "hosts", label: "Host", placeholder: "oracle-host" },
      { key: "port", label: "Port", placeholder: "1521" },
      { key: "service", label: "Service name", placeholder: "ORCLPDB1" },
      { key: "username", label: "Username" },
      { key: "password", label: "Password", type: "password" },
    ],
    newConsole: () => ({ id: uid(), query: "", maxRows: "200" }),
    consoleLabel: (c) => c.name || "sql",
    renderConsole: sqlConsole("oracle", "SELECT * FROM employees FETCH FIRST 50 ROWS ONLY", {
      tablesQuery: "SELECT table_name FROM user_tables ORDER BY table_name",
      tableFromRow: (r) => r[0],
      columnsQuery: (t) => `SELECT column_name, data_type FROM user_tab_columns WHERE table_name = '${String(t).replace(/'/g, "''")}' ORDER BY column_id`,
      buildSelect: (t, cols, n) => `SELECT ${cols} FROM ${t} FETCH FIRST ${n} ROWS ONLY`,
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
                onclick: (e) => {
                  e.stopPropagation();
                  if ((pad.text || "").trim() && !confirm(`Delete pad "${padLabel(pad)}" and its contents?`)) return;
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

        const update = () => {
          area.style.fontFamily = p.mono !== false ? "var(--mono)" : "var(--sans)";
          const text = p.text || "";
          const words = text.trim() ? text.trim().split(/\s+/).length : 0;
          counter.textContent = `${text.length} chars · ${words} words · ${text ? text.split("\n").length : 0} lines`;
        };
        area.addEventListener("input", () => { p.text = area.value; ctx.save(); update(); });
        mono.addEventListener("change", () => { p.mono = mono.checked; ctx.save(); update(); });

        root.append(
          el("div", { class: "toolbar" }, [
            el("label", { class: "inline" }, [mono, "Monospace"]),
            copyBtn(() => p.text || "", "Copy all"),
            counter,
          ]),
          area
        );
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
})();
