// Shared UI helpers: elements, icons, menus, popovers, dialogs, toast, formatting.
export const $ = (id) => document.getElementById(id);
export const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

// el("div", "cls", "text") — the short form used all over the reader
export function el(tag, cls, txt) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (txt != null) e.textContent = txt;
  return e;
}
// h("button", {class: "btn", onclick, title, dataset: {...}}, child, "text", ...)
export function h(tag, props, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === "class") e.className = v;
    else if (k === "dataset") Object.assign(e.dataset, v);
    else if (k === "style" && typeof v === "object") Object.assign(e.style, v);
    else if (k.startsWith("on") && typeof v === "function") e.addEventListener(k.slice(2), v);
    else if (k in e && typeof v !== "string") e[k] = v;
    else e.setAttribute(k, v === true ? "" : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) e.append(c.nodeType ? c : document.createTextNode(String(c)));
  return e;
}

export const debounce = (fn, ms) => { let t; const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; d.flush = (...a) => { clearTimeout(t); fn(...a); }; d.cancel = () => clearTimeout(t); return d; };

/* ------------------------------------------------------------------ icons (16px, stroked) */
const P = {
  plus: "M8 3v10M3 8h10",
  minus: "M3 8h10",
  x: "M4 4l8 8M12 4l-8 8",
  check: "M3.5 8.5l3 3 6-7",
  search: "M7 12a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM10.6 10.6L14 14",
  folder: "M1.8 4.2c0-.6.4-1 1-1h3.4l1.5 1.6h5.5c.6 0 1 .4 1 1v6.9c0 .6-.4 1-1 1H2.8c-.6 0-1-.4-1-1z",
  "folder-plus": "M1.8 4.2c0-.6.4-1 1-1h3.4l1.5 1.6h5.5c.6 0 1 .4 1 1v6.9c0 .6-.4 1-1 1H2.8c-.6 0-1-.4-1-1zM8 7.3v4M6 9.3h4",
  library: "M2.5 2.5h3v11h-3zM6.5 2.5h3v11h-3zM10.3 3.2l2.8-.8 2.4 10.6-2.8.7z",
  doc: "M4 1.8h5.2L12.5 5v9.2H4zM9 1.8V5.2h3.5M6 8h4.5M6 10.5h4.5",
  pdf: "M4 1.8h5.2L12.5 5v9.2H4zM9 1.8V5.2h3.5",
  inbox: "M2 9.5l1.6-6h8.8L14 9.5v3.7H2zM2 9.5h3.5l1 1.5h3l1-1.5H14",
  clock: "M8 14.2A6.2 6.2 0 1 0 8 1.8a6.2 6.2 0 0 0 0 12.4zM8 4.5V8l2.3 1.6",
  mark: "M10.5 2.5l3 3-6.8 6.8-3.6.6.6-3.6zM3 13.5h10",
  trash: "M2.5 4h11M6 4V2.5h4V4M4 4l.7 9.5h6.6L12 4M6.6 6.5v5M9.4 6.5v5",
  tag: "M2 2h5.6L14 8.4 8.4 14 2 7.6zM5 5.2h.01",
  link: "M6.6 9.4l2.8-2.8M7.2 4.6l1.1-1.1a2.6 2.6 0 0 1 3.7 3.7l-1.1 1.1M8.8 11.4l-1.1 1.1a2.6 2.6 0 0 1-3.7-3.7l1.1-1.1",
  external: "M9.5 2.5h4v4M13.5 2.5L7.5 8.5M12 9.5v4H2.5V4h4",
  "chev-right": "M6 3.5L10.5 8 6 12.5",
  "chev-down": "M3.5 6L8 10.5 12.5 6",
  "chev-left": "M10 3.5L5.5 8 10 12.5",
  "sidebar-left": "M2 2.5h12v11H2zM6 2.5v11",
  "sidebar-right": "M2 2.5h12v11H2zM10 2.5v11",
  more: "M3.5 8h.01M8 8h.01M12.5 8h.01",
  quote: "M3 9.5h3v3.5H2.5V9.2C2.5 6.5 3.6 5 5.5 4.3M9.5 9.5h3v3.5H9V9.2c0-2.7 1.1-4.2 3-4.9",
  restore: "M3 8a5 5 0 1 0 1.5-3.6M3 2.5v2.5h2.5",
  outline: "M3 3.5h10M5 6.5h8M5 9.5h8M3 12.5h10",
  pages: "M3 2h6.5v8.5H3zM6.5 5.5H13V14H6.5z",
  note: "M3 2h10v12H3zM5.5 5h5M5.5 7.5h5M5.5 10h3",
  download: "M8 2.5v8M4.8 7.5L8 10.7l3.2-3.2M2.5 13.5h11",
  back: "M6.5 3.5L2 8l4.5 4.5M2.5 8H14",
  cursor: "M4 2.5l8 5.3-3.6.9 2 4.1-1.6.8-2-4.1-2.8 2.3z",
  sliders: "M3 4.5h6M12 4.5h1M3 11.5h1M7 11.5h6M10.5 3v3M5.5 10v3",
  gear: "M12.9 8.5L14.4 9.2L13.4 11.6L11.8 11.1L11.1 11.8L11.6 13.4L9.2 14.4L8.5 12.9L7.5 12.9L6.8 14.4L4.4 13.4L4.9 11.8L4.2 11.1L2.6 11.6L1.6 9.2L3.1 8.5L3.1 7.5L1.6 6.8L2.6 4.4L4.2 4.9L4.9 4.2L4.4 2.6L6.8 1.6L7.5 3.1L8.5 3.1L9.2 1.6L11.6 2.6L11.1 4.2L11.8 4.9L13.4 4.4L14.4 6.8L12.9 7.5zM8 10.1a2.1 2.1 0 1 0 0-4.2 2.1 2.1 0 0 0 0 4.2z",
};
export function icon(name, cls) {
  const ns = "http://www.w3.org/2000/svg";
  const s = document.createElementNS(ns, "svg");
  s.setAttribute("viewBox", "0 0 16 16");
  s.setAttribute("class", "ic" + (cls ? " " + cls : ""));
  s.setAttribute("aria-hidden", "true");
  const p = document.createElementNS(ns, "path");
  p.setAttribute("d", P[name] || P.doc);
  if (name === "more") { p.setAttribute("stroke-width", "2.6"); }
  s.appendChild(p);
  return s;
}

/* ------------------------------------------------------------------ overlays */
const root = () => $("overlay-root");
let openMenus = [];
let menuOpener = null;   // what had focus before the top-level menu opened (shared by its submenus)
function closeMenusFrom(level) {
  while (openMenus.length > level) { const m = openMenus.pop(); m.el.remove(); m.onClose && m.onClose(); }
}
// closeMenus({refocus: true}) also hands focus back to what had it before the menu opened
export function closeMenus(opts) { if (opts && opts.refocus) closeMenusRefocus(); else closeMenusFrom(0); }
// keyboard close (Esc / ArrowLeft at the top level / choosing an item): hand focus back to the opener,
// so the next Tab carries on from there (and a dialog the item opens returns focus there too)
function closeMenusRefocus() {
  const o = menuOpener; menuOpener = null;
  closeMenusFrom(0);
  if (o && o.isConnected && o.focus && o !== document.body) o.focus({ preventScroll: true });
}

/**
 * menu(items, at) — at = {x, y} (context menu) or an element to drop below.
 * items: [{label, action, disabled, checked, kbd, submenu: [...]}, "-", {head: "Title"}]
 * Returns a promise that resolves when the menu closes.
 */
export function menu(items, at, opts = {}) {
  const level = opts.level || 0;
  if (level === 0) { const a = document.activeElement; menuOpener = a && a.closest && a.closest(".menu") ? null : a; }
  closeMenusFrom(level);
  return new Promise((resolve) => {
    const m = el("div", "menu");
    m.setAttribute("role", "menu"); m.tabIndex = -1;
    const rows = [];
    let active = -1;
    const setActive = (i) => {
      rows.forEach((r, j) => r.btn.classList.toggle("is-active", j === i));
      active = i;
      if (i >= 0) rows[i].btn.scrollIntoView({ block: "nearest" });
    };
    const openSub = (i) => {
      const r = rows[i]; if (!r || !r.item.submenu || r.item.disabled) return;
      const b = r.btn.getBoundingClientRect();
      menu(r.item.submenu, { x: b.right - 2, y: b.top - 4, alignSide: b.left }, { level: level + 1, parentFocus: () => m.focus() });
    };
    const fire = (i) => {
      const r = rows[i]; if (!r || r.item.disabled) return;
      if (r.item.submenu) { openSub(i); return; }
      closeMenusRefocus();
      try { r.item.action && r.item.action(); } finally { resolve(true); }
    };
    for (const it of items) {
      if (it === "-") { if (m.lastChild && !m.lastChild.classList.contains("menu__sep")) m.appendChild(el("div", "menu__sep")); continue; }
      if (it && it.head) { m.appendChild(el("div", "menu__head", it.head)); continue; }
      if (!it) continue;
      const b = el("button", "menu__item");
      b.setAttribute("role", it.checked != null ? "menuitemcheckbox" : "menuitem");
      if (it.checked != null) b.setAttribute("aria-checked", String(!!it.checked));
      b.disabled = !!it.disabled;
      b.append(el("span", "menu__check", it.checked ? "✓" : ""), el("span", "menu__label", it.label));
      if (it.kbd) b.append(el("kbd", null, it.kbd));
      if (it.submenu) { b.append(icon("chev-right", "menu__chev")); b.setAttribute("aria-haspopup", "menu"); }
      const i = rows.length;
      rows.push({ btn: b, item: it });
      b.addEventListener("mouseenter", () => { setActive(i); closeMenusFrom(level + 1); if (it.submenu) openSub(i); });
      b.addEventListener("click", (ev) => { ev.stopPropagation(); fire(i); });
      m.appendChild(b);
    }
    if (m.lastChild && m.lastChild.classList.contains("menu__sep")) m.lastChild.remove();
    m.addEventListener("keydown", (ev) => {
      const n = rows.length;
      // nothing highlighted yet: ↓ starts at the first item, ↑ at the last
      const step = (d) => { const from = active < 0 ? (d > 0 ? -1 : n) : active; for (let k = 1; k <= n; k++) { const j = (from + d * k + n * 2) % n; if (!rows[j].item.disabled) { setActive(j); return; } } };
      if (ev.key === "ArrowDown") { ev.preventDefault(); step(1); }
      else if (ev.key === "ArrowUp") { ev.preventDefault(); step(-1); }
      else if (ev.key === "ArrowRight") { ev.preventDefault(); openSub(active); }
      else if (ev.key === "ArrowLeft" || ev.key === "Escape") {
        ev.preventDefault(); ev.stopPropagation();
        if (level > 0) { closeMenusFrom(level); opts.parentFocus && opts.parentFocus(); }
        else closeMenusRefocus();
      }
      else if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); fire(active); }
    });
    root().appendChild(m);
    // position
    const W = m.offsetWidth, H = m.offsetHeight, M = 8;
    let x, y;
    if (at && at.nodeType === 1) { const r = at.getBoundingClientRect(); x = r.left; y = r.bottom + 4; if (y + H > innerHeight - M) y = Math.max(M, r.top - H - 4); }
    else { x = at.x; y = at.y; if (x + W > innerWidth - M) x = at.alignSide != null ? at.alignSide - W + 2 : innerWidth - W - M; if (y + H > innerHeight - M) y = Math.max(M, innerHeight - H - M); }
    m.style.left = clamp(x, M, innerWidth - W - M) + "px"; m.style.top = clamp(y, M, Math.max(M, innerHeight - H - M)) + "px";
    openMenus.push({ el: m, onClose: () => resolve(false) });
    m.focus({ preventScroll: true });
    if (opts.level && rows.length) setActive(rows.findIndex((r) => !r.item.disabled));
  });
}
// close menus on outside pointerdown / blur / resize
document.addEventListener("pointerdown", (ev) => { if (openMenus.length && !ev.target.closest(".menu")) closeMenus(); }, true);
window.addEventListener("blur", () => closeMenus());
window.addEventListener("resize", () => closeMenus());

/** popover(anchor, content, {onClose, placement}) -> {close()} */
let openPop = null;
export function popover(anchor, content, opts = {}) {
  closePopover();
  const p = el("div", "popover");
  p.appendChild(content);
  root().appendChild(p);
  const place = () => {
    const r = anchor.getBoundingClientRect(), W = p.offsetWidth, H = p.offsetHeight, M = 8;
    let x = opts.align === "right" ? r.right - W : r.left, y = r.bottom + 6;
    if (y + H > innerHeight - M) y = Math.max(M, r.top - H - 6);
    p.style.left = clamp(x, M, innerWidth - W - M) + "px"; p.style.top = y + "px";
  };
  place();
  const onDown = (ev) => { if (!p.contains(ev.target) && !anchor.contains(ev.target) && !ev.target.closest(".menu")) close(); };
  const onKey = (ev) => { if (ev.key === "Escape") { ev.stopPropagation(); close(); anchor.focus && anchor.focus(); } };
  document.addEventListener("pointerdown", onDown, true);
  p.addEventListener("keydown", onKey);
  function close() {
    if (openPop !== api) return;
    openPop = null;
    document.removeEventListener("pointerdown", onDown, true);
    p.remove(); opts.onClose && opts.onClose();
  }
  const api = { el: p, close, place };
  openPop = api;
  return api;
}
export function closePopover() { if (openPop) openPop.close(); }

/** dialog helpers — resolve true/false or a string/null */
function modal(build) {
  return new Promise((resolve) => {
    const prev = document.activeElement;
    const s = el("div", "scrim");
    const d = el("div", "dialog"); d.setAttribute("role", "dialog"); d.setAttribute("aria-modal", "true");
    s.appendChild(d);
    const done = (v) => { s.remove(); document.removeEventListener("keydown", onKey, true); prev && prev.focus && prev.focus(); resolve(v); };
    const onKey = (ev) => { if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); done(build.cancelValue); } };
    document.addEventListener("keydown", onKey, true);
    s.addEventListener("pointerdown", (ev) => { if (ev.target === s) done(build.cancelValue); });
    build(d, done);
    root().appendChild(s);
    const f = d.querySelector("[autofocus]") || d.querySelector("input, textarea, .btn--primary, button");
    f && f.focus();
  });
}
export function confirmDialog({ title, message, ok = "OK", cancel = "Cancel", danger = false }) {
  const b = (d, done) => {
    d.append(h("h2", null, title));
    if (message) d.append(h("p", null, message));
    const okB = h("button", { class: "btn " + (danger ? "btn--primary btn--danger-fill" : "btn--primary"), onclick: () => done(true), autofocus: true }, ok);
    if (danger) okB.style.background = "var(--danger)", okB.style.borderColor = "var(--danger)";
    d.append(h("div", { class: "dialog__actions" }, h("button", { class: "btn", onclick: () => done(false) }, cancel), okB));
  };
  b.cancelValue = false;
  return modal(b);
}
export function promptDialog({ title, message, label, value = "", ok = "OK", placeholder = "", multiline = false }) {
  const b = (d, done) => {
    d.append(h("h2", null, title));
    if (message) d.append(h("p", null, message));
    const inp = multiline ? h("textarea", { class: "textarea", rows: 4, placeholder, "aria-label": label || title }) : h("input", { class: "input", placeholder, "aria-label": label || title });
    inp.value = value;
    inp.addEventListener("keydown", (ev) => { if (ev.key === "Enter" && (!multiline || ev.metaKey || ev.ctrlKey)) { ev.preventDefault(); done(inp.value); } });
    d.append(inp, h("div", { class: "dialog__actions" }, h("button", { class: "btn", onclick: () => done(null) }, "Cancel"), h("button", { class: "btn btn--primary", onclick: () => done(inp.value) }, ok)));
    setTimeout(() => { inp.focus(); inp.select(); }, 0);
  };
  b.cancelValue = null;
  return modal(b);
}

let toastT;
export function toast(msg, opts = {}) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.toggle("is-error", !!opts.error);
  t.hidden = false;
  clearTimeout(toastT);
  toastT = setTimeout(() => (t.hidden = true), opts.ms || (opts.error ? 4500 : 2200));
}

export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; }
  catch (_) {
    const ta = el("textarea"); ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    let ok = false; try { ok = document.execCommand("copy"); } catch (_) {}
    ta.remove(); return ok;
  }
}

/* ------------------------------------------------------------------ formatting */
export function authorsShort(authors) {
  const a = (authors || []).filter((x) => x && (x.family || x.given));
  const fam = (x) => x.family || x.given;
  if (!a.length) return "";
  if (a.length === 1) return fam(a[0]);
  if (a.length === 2) return fam(a[0]) + " & " + fam(a[1]);
  return fam(a[0]) + " et al.";
}
export function authorsFull(authors) {
  return (authors || []).map((x) => [x.given, x.family].filter(Boolean).join(" ")).filter(Boolean).join(", ");
}
export function parseAuthors(text) {
  // one author per line (or ";"), "Family, Given" or "Given Family"
  return String(text || "").split(/\n|;/).map((s) => s.trim()).filter(Boolean).map((s) => {
    if (s.includes(",")) { const [f, ...g] = s.split(","); return { given: g.join(",").trim(), family: f.trim() }; }
    const parts = s.split(/\s+/); const family = parts.pop(); return { given: parts.join(" "), family };
  });
}
export function authorsToLines(authors) {
  return (authors || []).map((x) => (x.family ? x.family + (x.given ? ", " + x.given : "") : x.given)).join("\n");
}
export function citation(it) {
  // "Morimoto et al., Phys. Rev. B 94, 035117 (2016)" style, plain text
  const who = authorsShort(it.authors);
  const where = [it.venue, it.volume, it.pages ? (it.volume ? ", " : "") + it.pages : ""].filter(Boolean).join(" ").replace(" ,", ",");
  const arx = !it.venue || /arxiv/i.test(it.venue) ? (it.arxiv ? "arXiv:" + it.arxiv : "") : "";
  const parts = [who, where || arx].filter(Boolean).join(", ");
  return (parts || it.title || "Untitled") + (it.year ? ` (${it.year})` : "");
}
export function timeShort(iso) { const d = new Date(iso); return isNaN(d) ? "" : d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }); }
export function dateShort(iso) {
  const d = new Date(iso); if (isNaN(d)) return "";
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return timeShort(iso);
  return d.toLocaleDateString([], d.getFullYear() === now.getFullYear() ? { month: "short", day: "numeric" } : { year: "numeric", month: "short", day: "numeric" });
}
export function dateLong(iso) { const d = new Date(iso); return isNaN(d) ? "" : d.toLocaleString([], { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }); }
export function shortTitle(t, n = 42) { t = (t || "Untitled").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1).trimEnd() + "…" : t; }
export const TYPE_LABEL = { question: "Question", remark: "Remark", explain: "Explain" };
export const ITEM_TYPES = [["article", "Journal article"], ["preprint", "Preprint"], ["inproceedings", "Conference paper"], ["book", "Book"], ["thesis", "Thesis"], ["manuscript", "Manuscript / draft"], ["misc", "Other"]];
