/* Devtil core: DOM helpers, API wrapper, tool registry. */
"use strict";

window.Devtil = (() => {
  const tools = [];

  /** Register a tool: {type, icon, name, desc, defaults(), render(root, tab, ctx)} */
  function registerTool(def) {
    tools.push(def);
  }

  function getTool(type) {
    return tools.find((t) => t.type === type);
  }

  // ---- DOM helpers ----

  /** el('div', {class: 'x', onclick: fn}, [children...]) */
  function el(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (key === "class") node.className = value;
      else if (key === "text") node.textContent = value;
      else if (key === "html") node.innerHTML = value;
      else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
      else if (value !== undefined && value !== null) node.setAttribute(key, value);
    }
    for (const child of [].concat(children)) {
      if (child == null) continue;
      node.append(child.nodeType ? child : document.createTextNode(child));
    }
    return node;
  }

  function escapeHtml(s) {
    return String(s)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  function debounce(fn, ms) {
    let timer;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), ms);
    };
  }

  function uid() {
    return crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2);
  }

  function fmtBytes(n) {
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
    return (n / (1024 * 1024)).toFixed(2) + " MB";
  }

  async function copyText(text, button) {
    try {
      await navigator.clipboard.writeText(text);
      if (button) {
        const old = button.textContent;
        button.textContent = "Copied!";
        setTimeout(() => (button.textContent = old), 1200);
      }
    } catch {
      /* clipboard may be unavailable; ignore */
    }
  }

  /** A "Copy" button that copies whatever getText() returns at click time. */
  function copyBtn(getText, label = "Copy") {
    const btn = el("button", { class: "btn", text: label });
    btn.addEventListener("click", () => copyText(getText(), btn));
    return btn;
  }

  function setStatus(node, msg, kind = "dim") {
    node.className = "status-line " + kind;
    node.textContent = msg;
  }

  // ---- in-app dialogs ----
  // Native prompt()/confirm()/alert() are disabled inside the Electron shell,
  // so we use small in-app modals that work in both browser and desktop modes.

  function closeDialog(overlay, onEsc) {
    overlay.remove();
    document.removeEventListener("keydown", onEsc, true);
  }

  /** Promise<boolean>. Styled replacement for window.confirm. */
  function confirmDialog(message, { okLabel = "OK", cancelLabel = "Cancel", danger = false } = {}) {
    return new Promise((resolve) => {
      const overlay = el("div", { class: "json-modal-overlay" });
      const settle = (val) => { closeDialog(overlay, onEsc); resolve(val); };
      const onEsc = (e) => {
        if (e.key === "Escape") { e.preventDefault(); settle(false); }
        if (e.key === "Enter") { e.preventDefault(); settle(true); }
      };
      const box = el("div", { class: "app-dialog" }, [
        el("div", { class: "app-dialog-msg", text: message }),
        el("div", { class: "app-dialog-actions" }, [
          el("button", { class: "btn", text: cancelLabel, onclick: () => settle(false) }),
          el("button", { class: "btn " + (danger ? "danger primary" : "primary"), text: okLabel, onclick: () => settle(true) }),
        ]),
      ]);
      overlay.append(box);
      overlay.addEventListener("click", (e) => { if (e.target === overlay) settle(false); });
      document.addEventListener("keydown", onEsc, true);
      document.body.append(overlay);
      box.querySelector(".btn.primary").focus();
    });
  }

  /** Promise<string|null> (null = cancelled). Styled replacement for window.prompt. */
  function promptDialog(message, defaultValue = "", { okLabel = "OK", cancelLabel = "Cancel" } = {}) {
    return new Promise((resolve) => {
      const overlay = el("div", { class: "json-modal-overlay" });
      const input = el("input", { type: "text", class: "app-dialog-input", value: defaultValue });
      const settle = (val) => { closeDialog(overlay, onEsc); resolve(val); };
      const onEsc = (e) => { if (e.key === "Escape") { e.preventDefault(); settle(null); } };
      const box = el("div", { class: "app-dialog" }, [
        el("div", { class: "app-dialog-msg", text: message }),
        input,
        el("div", { class: "app-dialog-actions" }, [
          el("button", { class: "btn", text: cancelLabel, onclick: () => settle(null) }),
          el("button", { class: "btn primary", text: okLabel, onclick: () => settle(input.value) }),
        ]),
      ]);
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); settle(input.value); }
      });
      overlay.append(box);
      overlay.addEventListener("click", (e) => { if (e.target === overlay) settle(null); });
      document.addEventListener("keydown", onEsc, true);
      document.body.append(overlay);
      input.focus();
      input.select();
    });
  }

  // ---- backend API ----

  async function api(method, path, body) {
    const opts = { method, headers: {} };
    if (body !== undefined) {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(path, opts);
    const text = await res.text();
    let data = {};
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        throw new Error(`${res.status} ${res.statusText} — server sent a non-JSON response (${text.length} bytes); check the App Logs tool`);
      }
    }
    if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}${text ? "" : " (empty response)"}`);
    return data;
  }

  return { registerTool, getTool, tools, el, escapeHtml, debounce, uid, fmtBytes, copyText, copyBtn, setStatus, api, confirmDialog, promptDialog };
})();
