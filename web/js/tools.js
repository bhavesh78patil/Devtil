/* Devtil tools. Each tool renders into a tab and stores everything it needs
   in tab.data, which is autosaved by the app shell via ctx.save(). */
"use strict";

(() => {
  const { registerTool, el, escapeHtml, debounce, uid, fmtBytes, copyBtn, setStatus, api } = Devtil;

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
    name: "Kube Logs",
    desc: "Find pods for a service and search their logs — local kubectl, or kubectl over SSH on the kubemaster; stdout or files inside the pod.",
    defaults: () => ({
      context: "", sshHost: "", sshPort: "", sshKey: "", sshPassword: "",
      server: "", token: "", insecureTLS: false,
      namespace: "", podQuery: "", selected: [], container: "",
      source: "stdout", filePath: "",
      tail: "2000", sinceMinutes: "", grep: "", grepRegex: false, output: [],
    }),
    render(root, tab, ctx) {
      const d = tab.data;
      if (!Array.isArray(d.selected)) d.selected = [];
      const status = el("div", { class: "status-line dim" });
      const podBox = el("div");
      const logPre = el("pre", { class: "output", style: "min-height:180px" });

      const ctxSel = el("select", { style: "min-width:160px" });
      const nsSel = el("select", { style: "min-width:160px" });
      const sshHost = bindField(el("input", { type: "text", placeholder: "user@kubemaster", style: "min-width:180px" }), d, "sshHost", ctx);
      const sshPort = bindField(el("input", { type: "text", placeholder: "22", style: "width:70px" }), d, "sshPort", ctx);
      const sshKey = bindField(el("input", { type: "text", placeholder: "~/.ssh/id_ed25519 (optional)", style: "min-width:170px" }), d, "sshKey", ctx);
      const sshPassword = bindField(el("input", { type: "password", placeholder: "ssh password (optional)", style: "min-width:150px" }), d, "sshPassword", ctx);
      const server = bindField(el("input", { type: "text", placeholder: "https://<apiserver>:6443 (optional)", style: "min-width:200px" }), d, "server", ctx);
      const token = bindField(el("input", { type: "password", placeholder: "bearer token (optional)", style: "min-width:160px" }), d, "token", ctx);
      const insecureTLS = bindField(el("input", { type: "checkbox" }), d, "insecureTLS", ctx);
      const podQuery = bindField(el("input", { type: "text", placeholder: "service / pod name filter" }), d, "podQuery", ctx);
      const container = bindField(el("input", { type: "text", placeholder: "(default)", style: "width:120px" }), d, "container", ctx);
      const sourceSel = bindField(
        el("select", {}, [
          el("option", { value: "stdout", text: "Container stdout" }),
          el("option", { value: "file", text: "File inside pod (exec)" }),
        ]),
        d, "source", ctx, () => syncSource()
      );
      const filePath = bindField(el("input", { type: "text", placeholder: "/var/log/app.log", style: "min-width:180px" }), d, "filePath", ctx);
      const tail = bindField(el("input", { type: "number", min: "1", style: "width:90px" }), d, "tail", ctx);
      const since = bindField(el("input", { type: "number", min: "0", placeholder: "all", style: "width:90px" }), d, "sinceMinutes", ctx);
      const grep = bindField(el("input", { type: "text", placeholder: "filter lines (grep)", style: "flex:1;min-width:180px" }), d, "grep", ctx);
      const grepRegex = bindField(el("input", { type: "checkbox" }), d, "grepRegex", ctx);

      const connQS = () =>
        "context=" + encodeURIComponent(d.context || "") +
        "&server=" + encodeURIComponent(d.server || "") +
        "&token=" + encodeURIComponent(d.token || "") +
        "&insecure=" + (d.insecureTLS ? "true" : "false") +
        "&sshHost=" + encodeURIComponent(d.sshHost || "") +
        "&sshPort=" + encodeURIComponent(d.sshPort || "") +
        "&sshKey=" + encodeURIComponent(d.sshKey || "") +
        "&sshPassword=" + encodeURIComponent(d.sshPassword || "");

      const renderLogs = () => {
        const lines = d.output || [];
        if (!lines.length) { logPre.textContent = "No log lines loaded."; return; }
        const q = (d.grep || "").trim();
        if (q && !d.grepRegex) {
          const safe = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          const re = new RegExp("(" + safe + ")", "gi");
          logPre.innerHTML = lines.map((l) => escapeHtml(l).replace(re, "<mark>$1</mark>")).join("\n");
        } else {
          logPre.textContent = lines.join("\n");
        }
      };

      const renderPods = (pods) => {
        podBox.replaceChildren();
        if (!pods.length) return podBox.append(el("div", { class: "status-line dim", text: "No pods matched." }));
        const table = el("table", { class: "kv" }, [
          el("tr", {}, [el("th", { text: "" }), el("th", { text: "Pod" }), el("th", { text: "Status" }), el("th", { text: "Containers" })]),
        ]);
        for (const p of pods) {
          const check = el("input", { type: "checkbox" });
          check.checked = d.selected.includes(p.name);
          const toggle = () => {
            if (d.selected.includes(p.name)) d.selected = d.selected.filter((n) => n !== p.name);
            else d.selected.push(p.name);
            check.checked = d.selected.includes(p.name);
            row.classList.toggle("selected", check.checked);
            ctx.save();
          };
          check.addEventListener("click", (e) => { e.stopPropagation(); toggle(); });
          const row = el("tr", { class: "pod-row" + (check.checked ? " selected" : ""), onclick: toggle }, [
            el("td", {}, [check]),
            el("td", { text: p.name }),
            el("td", { text: p.status }),
            el("td", { text: (p.containers || []).join(", ") }),
          ]);
          table.append(row);
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
          // no kubeconfig contexts is fine when a direct API server is set
          if (!d.server) return setStatus(status, "✗ " + e.message, "err");
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
          setStatus(status, `✓ ${r.pods.length} pod(s)`, "ok");
        } catch (e) {
          setStatus(status, "✗ " + e.message, "err");
        }
      }
      async function fetchLogs() {
        if (!d.selected.length) return setStatus(status, "✗ Select at least one pod", "err");
        if (d.source === "file" && !(d.filePath || "").trim()) {
          return setStatus(status, "✗ Enter the log file path inside the pod", "err");
        }
        setStatus(status, "Fetching logs…", "dim");
        try {
          const r = await api("POST", "/api/kube/logs", {
            context: d.context, server: d.server, token: d.token, insecure: d.insecureTLS,
            sshHost: d.sshHost, sshPort: d.sshPort, sshKey: d.sshKey, sshPassword: d.sshPassword,
            namespace: d.namespace, pods: d.selected,
            container: d.container, tail: Number(d.tail) || 2000,
            sinceMinutes: Number(d.sinceMinutes) || 0,
            grep: d.grep, grepRegex: d.grepRegex,
            source: d.source || "stdout", filePath: d.filePath,
          });
          d.output = r.lines;
          ctx.save();
          renderLogs();
          const errs = (r.errors || []).length ? ` · errors: ${r.errors.join("; ")}` : "";
          setStatus(status, `✓ ${r.matched}/${r.total} lines${r.truncated ? " (truncated)" : ""}${errs}`, errs ? "err" : "ok");
        } catch (e) {
          setStatus(status, "✗ " + e.message, "err");
        }
      }

      ctxSel.addEventListener("change", () => { d.context = ctxSel.value; ctx.save(); loadNamespaces(); });
      nsSel.addEventListener("change", () => { d.namespace = nsSel.value; d.selected = []; ctx.save(); });
      podQuery.addEventListener("keydown", (e) => { if (e.key === "Enter") loadPods(); });

      const field = (label, node) => el("div", { class: "field" }, [el("span", { text: label }), node]);
      const filePathField = field("Log file path", filePath);
      const sinceField = field("Since (min)", since);
      const syncSource = () => {
        const fileMode = d.source === "file";
        filePathField.style.display = fileMode ? "" : "none";
        sinceField.style.display = fileMode ? "none" : "";
      };

      root.append(
        el("div", { class: "form-grid" }, [
          field("SSH host — kubectl runs here (optional)", sshHost),
          field("SSH port", sshPort),
          field("SSH password (or use key/agent)", sshPassword),
          field("SSH key", sshKey),
          field("API server (optional)", server),
          field("Token", token),
          el("label", { class: "inline", style: "padding-bottom:8px" }, [insecureTLS, "skip TLS verify"]),
        ]),
        el("div", { class: "form-grid" }, [
          el("button", { class: "btn", text: "⟳ Connect", title: "Load contexts & namespaces", onclick: loadContexts }),
          field("Context", ctxSel),
          field("Namespace", nsSel),
          field("Service / pod filter", podQuery),
          el("button", { class: "btn primary", text: "Find pods", onclick: loadPods }),
        ]),
        podBox,
        el("div", { class: "form-grid" }, [
          field("Log source", sourceSel),
          filePathField,
          field("Container", container),
          field("Tail lines", tail),
          sinceField,
          field("Search in logs", grep),
          el("label", { class: "inline", style: "padding-bottom:8px" }, [grepRegex, "regex"]),
          el("button", { class: "btn primary", text: "Fetch logs", onclick: fetchLogs }),
          copyBtn(() => (d.output || []).join("\n"), "Copy logs"),
        ]),
        status,
        logPre
      );
      syncSource();
      renderLogs();
      if (d.context) fillSelect(ctxSel, [d.context], d.context);
      if (d.namespace) fillSelect(nsSel, [d.namespace], d.namespace);
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
              onclick: () => { d.activeConnId = c.id; ctx.save(); renderSide(); renderMain(); },
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
            ...d.consoles.map((c) =>
              el("div", {
                class: "req-tab" + (c.id === d.activeConsoleId ? " active" : ""),
                onclick: () => {
                  if (d.activeConsoleId === c.id) return;
                  d.activeConsoleId = c.id;
                  ctx.save();
                  renderMain();
                },
              }, [
                el("span", { text: cfg.consoleLabel(c) }),
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
              ])
            ),
            el("button", {
              class: "icon-btn", text: "+", title: "New console tab",
              onclick: () => {
                const c = cfg.newConsole();
                d.consoles.push(c);
                d.activeConsoleId = c.id;
                ctx.save();
                renderMain();
              },
            }),
          ]));

          const conn = activeConn();
          const consoleData = d.consoles.find((c) => c.id === d.activeConsoleId) || d.consoles[0];
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

  /** Kafka console: topics browser, tail consumer, producer. */
  function kafkaConsole(body, conn, c, ctx) {
    const status = el("div", { class: "status-line dim" });
    const out = el("div", { style: "flex:1;overflow:auto;display:flex;flex-direction:column;gap:10px" });

    const topic = el("input", { type: "text", placeholder: "topic", style: "min-width:200px" });
    topic.value = c.topic || "";
    topic.addEventListener("input", () => { c.topic = topic.value.trim(); ctx.save(); });
    const max = el("input", { type: "number", min: "1", max: "500", style: "width:80px" });
    max.value = c.max || "50";
    max.addEventListener("input", () => { c.max = max.value; ctx.save(); });

    const draw = () => {
      out.replaceChildren();
      if (Array.isArray(c.topics)) {
        out.append(
          el("span", { class: "pane-label", text: `Topics (${c.topics.length}) — click to select` }),
          el("table", { class: "kv" }, [
            el("tr", {}, [el("th", { text: "Topic" }), el("th", { text: "Partitions" })]),
            ...c.topics.map((t) => el("tr", {
              class: "pod-row",
              onclick: () => { c.topic = t.name; topic.value = t.name; ctx.save(); },
            }, [el("td", { text: t.name }), el("td", { text: String(t.partitions) })])),
          ])
        );
      }
      if (Array.isArray(c.messages)) {
        out.append(
          el("span", { class: "pane-label", text: `Messages (${c.messages.length}, oldest first)` }),
          el("table", { class: "kv" }, [
            el("tr", {}, [el("th", { text: "P/Offset" }), el("th", { text: "Time" }), el("th", { text: "Key" }), el("th", { text: "Value" })]),
            ...c.messages.map((m) => el("tr", {}, [
              el("td", { text: m.partition + "/" + m.offset }),
              el("td", { text: m.time }),
              el("td", { text: m.key }),
              el("td", { text: m.value }),
            ])),
          ])
        );
      }
    };

    const listTopics = async () => {
      setStatus(status, "Listing topics…", "dim");
      try {
        const r = await api("POST", "/api/kafka/topics", { conn });
        c.topics = r.topics;
        ctx.save();
        draw();
        setStatus(status, `✓ ${r.topics.length} topic(s)`, "ok");
      } catch (e) {
        setStatus(status, "✗ " + e.message, "err");
      }
    };
    const consume = async () => {
      if (!c.topic) return setStatus(status, "✗ Enter or pick a topic", "err");
      setStatus(status, "Reading latest messages…", "dim");
      try {
        const r = await api("POST", "/api/kafka/consume", { conn, topic: c.topic, max: Number(c.max) || 50 });
        c.messages = r.messages;
        c.name = c.topic;
        ctx.save();
        draw();
        setStatus(status, `✓ ${r.messages.length} message(s)`, "ok");
      } catch (e) {
        setStatus(status, "✗ " + e.message, "err");
      }
    };

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
        await api("POST", "/api/kafka/produce", { conn, topic: c.topic, key: c.prodKey || "", value: c.prodValue || "" });
        setStatus(status, "✓ Message produced to " + c.topic, "ok");
      } catch (e) {
        setStatus(status, "✗ " + e.message, "err");
      }
    };

    body.append(
      el("div", { class: "toolbar" }, [
        el("button", { class: "btn", text: "List topics", onclick: listTopics }),
        topic,
        el("label", { class: "inline" }, ["Last", max, "msgs"]),
        el("button", { class: "btn primary", text: "Consume", onclick: consume }),
      ]),
      el("div", { class: "toolbar" }, [
        el("span", { class: "pane-label", text: "Produce" }),
        prodKey, prodValue,
        el("button", { class: "btn", text: "Send", onclick: produce }),
      ]),
      status,
      out
    );
    draw();
  }

  /** Flatten an ES mapping's properties into dotted field paths. */
  function flattenProps(props, prefix = "") {
    let out = [];
    for (const [k, v] of Object.entries(props || {})) {
      const path = prefix ? prefix + "." + k : k;
      if (v && v.properties) out = out.concat(flattenProps(v.properties, path));
      else out.push({ name: path, type: (v && v.type) || "object" });
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
        el("span", { class: "pane-label", text: `Fields of ${c.index} — pick which columns to return (_source)` }),
        colsPicker(c.fields, c.selectedFields, (next) => { c.selectedFields = next; ctx.save(); })
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
      if (!c.index) { c.fields = []; drawFields(); return; }
      setStatus(status, "Loading mapping…", "dim");
      try {
        const m = await esFetch("GET", encodeURIComponent(c.index) + "/_mapping");
        const entry = m[c.index] || Object.values(m)[0] || {};
        c.fields = flattenProps(entry.mappings && entry.mappings.properties);
        c.selectedFields = c.fields.map((f) => f.name);
        ctx.save();
        drawFields();
        setStatus(status, `✓ ${c.fields.length} field(s)`, "ok");
      } catch (e) {
        setStatus(status, "✗ " + e.message, "err");
      }
    };
    idxSel.addEventListener("change", () => { c.index = idxSel.value; ctx.save(); loadFields(); });

    const buildSearch = () => {
      if (!c.index) { setStatus(status, "✗ Pick an index first (Load indices)", "err"); return false; }
      const q = {
        query: (c.qText || "").trim() ? { query_string: { query: c.qText.trim() } } : { match_all: {} },
        size: Number(c.size) || 10,
      };
      const sel = c.selectedFields || [];
      if (sel.length && sel.length !== (c.fields || []).length) q._source = sel;
      c.method = "POST";
      c.path = c.index + "/_search";
      c.body = JSON.stringify(q, null, 2);
      methodSel.value = c.method;
      path.value = c.path;
      reqBody.value = c.body;
      ctx.save();
      return true;
    };

    const builder = el("details", { class: "section" }, [
      el("summary", { text: "Query helper — pick an index, choose fields, build the search" }),
      el("div", { class: "toolbar" }, [
        el("button", { class: "btn", text: "Load indices", onclick: loadIndices }),
        idxSel,
        qText,
        el("label", { class: "inline" }, ["Size", size]),
        el("button", { class: "btn", text: "Build query", onclick: buildSearch }),
        el("button", { class: "btn primary", text: "Build & search", onclick: () => { if (buildSearch()) send(c.method, c.path, c.body); } }),
      ]),
      fieldsBox,
    ]);
    if (c.index) builder.open = true;
    fillIndices();
    drawFields();

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
    desc: "Browse topics, tail the latest messages and produce — multiple clusters, SASL/TLS supported.",
    connLabel: "Clusters",
    connSingular: "cluster",
    connName: (c) => c.brokers,
    fields: [
      { key: "name", label: "Name", placeholder: "prod-cluster" },
      { key: "brokers", label: "Brokers (comma-separated)", placeholder: "broker1:9092, broker2:9092" },
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
    connName: (c) => c.hosts,
    fields: [
      { key: "name", label: "Name", placeholder: "orders-db" },
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
  // Notepad
  // ======================================================================
  registerTool({
    type: "notepad",
    icon: "📝",
    name: "Notepad",
    desc: "A scratch pad that autosaves as you type. Keep snippets, TODOs, or paste buffers around.",
    defaults: () => ({ text: "", mono: true }),
    render(root, tab, ctx) {
      const d = tab.data;
      const counter = el("span", { class: "status-line dim" });
      const area = boundArea(d, "text", ctx, { placeholder: "Type away — everything is saved automatically." }, () => update());
      const mono = bindField(el("input", { type: "checkbox" }), d, "mono", ctx, () => update());

      const update = () => {
        area.style.fontFamily = d.mono ? "var(--mono)" : "var(--sans)";
        const text = d.text || "";
        const words = text.trim() ? text.trim().split(/\s+/).length : 0;
        counter.textContent = `${text.length} chars · ${words} words · ${text ? text.split("\n").length : 0} lines`;
      };

      root.append(
        el("div", { class: "toolbar" }, [
          el("label", { class: "inline" }, [mono, "Monospace"]),
          copyBtn(() => d.text || "", "Copy all"),
          counter,
        ]),
        area
      );
      update();
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
