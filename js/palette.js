// ⌘K palette: one search over open tabs, papers, projects, marks & notes, and commands.
// See CONTRACT.md §10.2. openPalette(ctx, {filter, query}) opens it, or refocuses the open one.
import { store } from "./store.js";
import { api } from "./api.js";
import * as ui from "./ui.js";
import * as commands from "./commands.js";
import * as marktypes from "./marktypes.js";

const { el, icon } = ui;

const FILTERS = [
  ["all", "All"], ["papers", "Papers"], ["marks", "Marks & notes"], ["projects", "Projects"], ["commands", "Commands"],
];
const LS_CMDS = "pm2:palette:cmds";   // recently run command ids (newest first)
const PAGE = 120;                      // rows rendered at a time in long lists

/* ------------------------------------------------------------------ text helpers */
// lower-case, accents folded ("Schrödinger" finds "schrodinger"), sub/superscript digits made plain ("WTe₂" finds "wte2")
const fold = (s) => String(s == null ? "" : s).normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();
// Titles are stored as typed (with TeX like "WTe$_2$"); show them the way the library table does.
// The library's texPlain is used once library.js has loaded; until then a small local version.
let texPlain = (s) => String(s || "").replace(/\$([^$]*)\$/g, (m, x) => x.replace(/_\{?(\d+)\}?/g, (n, d) => [...d].map((c) => "₀₁₂₃₄₅₆₇₈₉"[c]).join("")).replace(/\\([a-zA-Z]+)/g, (n, w) => GREEK[w] || w).replace(/[{}]/g, ""));
import("./library.js").then((m) => { if (typeof m.texPlain === "function") { texPlain = m.texPlain; indexDirty = true; } }).catch(() => {});
const titleOf = (it) => (it ? texPlain(it.title || "") || it.key : "");
const words = (q) => fold(q).split(/[\s,;]+/).filter(Boolean);
const oneLine = (s) => String(s || "").replace(/\s+/g, " ").trim();
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
// display-only tidy-up of an abstract snippet (stored text is never changed): TeX quotes, \ensuremath,
// JATS tags, $…$ and font commands, so "``shift current''" reads as “shift current”
function tidyAbstract(s) {
  return oneLine(s)
    .replace(/<\/?[a-z][\w:-]*[^>]*>/gi, "")
    .replace(/``/g, "\u201c").replace(/''/g, "\u201d").replace(/(^|[\s(])`/g, "$1\u2018")
    .replace(/\\(?:ensuremath|mathit|mathbf|mathrm|textit|textbf|emph|text)\s*/g, "")
    .replace(/\\([a-zA-Z]+)/g, (m, w) => GREEK[w] || w)
    .replace(/[{}$]/g, "").replace(/\s+/g, " ");
}
const GREEK = { alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε", varepsilon: "ε", theta: "θ", kappa: "κ", lambda: "λ", mu: "μ", nu: "ν", pi: "π", rho: "ρ", sigma: "σ", tau: "τ", phi: "φ", varphi: "φ", chi: "χ", psi: "ψ", omega: "ω", Gamma: "Γ", Delta: "Δ", Theta: "Θ", Lambda: "Λ", Pi: "Π", Sigma: "Σ", Phi: "Φ", Psi: "Ψ", Omega: "Ω", hbar: "ħ", times: "×", pm: "±", approx: "≈", sim: "~", le: "≤", ge: "≥", leq: "≤", geq: "≥", infty: "∞", partial: "∂", nabla: "∇" };

// How well does `w` appear in `hay`? 4 = a whole word, 3 = the start of a word, 2 = inside a word, 0 = no.
// Results are ranked by match quality first: 5 = the text starts with the whole query, then 4..2 as here,
// and 1 = only with a typo (see near / subseq). A typo-only paper never sits above an exact match.
const WC = /[\p{L}\p{N}]/u;
function where(hay, w) {
  let i = hay.indexOf(w);
  if (i < 0) return 0;
  let best = 2;
  while (i >= 0) {
    if (i === 0 || !WC.test(hay[i - 1])) {
      const e = i + w.length;
      if (e >= hay.length || !WC.test(hay[e])) return 4;
      best = 3;
    }
    i = hay.indexOf(w, i + 1);
  }
  return best;
}
// letters of `w` in order inside one word of `hay` (typo-tolerant fallback for words of 4+ letters)
function subseq(hay, w) {
  if (w.length < 4) return false;
  for (const part of hay.split(/[^a-z0-9]+/)) {
    if (part.length < w.length || part[0] !== w[0]) continue;
    let j = 0;
    for (let k = 0; k < part.length && j < w.length; k++) if (part[k] === w[j]) j++;
    if (j === w.length && part.length <= w.length * 1.6) return true;
  }
  return false;
}

// one typo away (a letter missing, extra, wrong, or two neighbours swapped), for words of 4+ letters
function oneEdit(a, b) {
  if (a === b) return true;
  const la = a.length, lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  let i = 0; while (i < la && i < lb && a[i] === b[i]) i++;
  if (la === lb) {
    if (a.slice(i + 1) === b.slice(i + 1)) return true;                                   // substitution
    return a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2);   // transposition
  }
  return la > lb ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);         // deletion / insertion
}
function near(hay, w) {
  if (w.length < 4) return false;
  for (const part of hay.split(/[^a-z0-9]+/)) {
    if (part.length >= w.length - 1 && oneEdit(part.slice(0, w.length + 1), w)) return true;   // also as a prefix
    if (part.length > w.length && oneEdit(part.slice(0, w.length), w)) return true;
  }
  return false;
}

/* ------------------------------------------------------------------ paper index (rebuilt lazily) */
let index = null;            // [{it, title, authors, rest, recent}]
let indexDirty = true;
store.on("library", () => { indexDirty = true; });
store.on("item", () => { indexDirty = true; });

function buildIndex() {
  const out = [];
  for (const it of Object.values(store.lib.items || {})) {
    if (!it || it.trashed) continue;
    const fam = (it.authors || []).map((a) => [a.given, a.family].filter(Boolean).join(" ")).join(" ");
    out.push({
      it,
      title: fold(titleOf(it)),
      authors: fold(fam),
      rest: fold([it.year, it.venue, (it.tags || []).join(" "), it.doi, it.arxiv, it.key].join(" ")),
      recent: it.opened || "",
    });
  }
  index = out; indexDirty = false;
  return out;
}
const paperIndex = () => (indexDirty || !index ? buildIndex() : index);

// score one paper against query words: null = not a match, else {s: score, q: match quality 1..5}
function scorePaper(e, ws, q) {
  let s = 0, qual = 4;
  for (const w of ws) {
    const t = where(e.title, w);
    if (t) { s += t >= 3 ? 10 : 6; qual = Math.min(qual, t); continue; }
    const a = where(e.authors, w);
    if (a) { s += a >= 3 ? 8 : 4; qual = Math.min(qual, a); continue; }
    const r = where(e.rest, w);
    if (r) { s += r >= 3 ? 5 : 3; qual = Math.min(qual, r); continue; }
    if (subseq(e.title, w) || subseq(e.authors, w) || near(e.title, w) || near(e.authors, w)) { s += 1; qual = 1; continue; }
    return null;
  }
  if (q.length > 1 && e.title.startsWith(q)) { s += 12; qual = 5; }
  else if (q.length > 3 && e.title.includes(q)) s += 6;
  if (e.recent) s += 1;
  return { s, q: qual };
}
// papers best first: [{it, q}]
function searchPapersQ(q, limit) {
  const ws = words(q), qf = fold(q).trim(), list = paperIndex();
  if (!ws.length) return [];
  const hits = [];
  for (const e of list) { const r = scorePaper(e, ws, qf); if (r) hits.push([r, e]); }
  hits.sort((a, b) => b[0].q - a[0].q || b[0].s - a[0].s || cmp(b[1].recent, a[1].recent) || cmp(a[1].title, b[1].title));
  return hits.slice(0, limit).map((h) => ({ it: h[1].it, q: h[0].q }));
}
const searchPapers = (q, limit) => searchPapersQ(q, limit).map((x) => x.it);

// a pasted arXiv ID / DOI / link to one: the paper already in the library, if any
function idsIn(text) {
  const t = String(text || "").trim();
  if (!t || /\s/.test(t)) return null;
  const doi = (/10\.\d{4,9}\/[^\s?#"<>]+/i.exec(t) || [])[0];
  const ax = (/(?:^|arxiv[:/.]\s*|abs\/|pdf\/)(\d{4}\.\d{4,5}|[a-z-]+(?:\.[a-z]{2})?\/\d{7})(?:v\d+)?/i.exec(t) || [])[1];
  if (!doi && !ax) return null;
  return { doi: doi ? doi.toLowerCase().replace(/(\.pdf|[.,;)\]]+)$/, "") : "", ax: ax ? ax.toLowerCase() : "" };
}
function paperById(text) {
  const ids = idsIn(text); if (!ids) return null;
  for (const e of paperIndex()) {
    const it = e.it;
    const ax = String(it.arxiv || "").toLowerCase().replace(/^arxiv:\s*/, "").replace(/v\d+$/, "");
    if (ids.ax && ax && ax === ids.ax) return it;
    const d = String(it.doi || "").toLowerCase().replace(/^https?:\/\/(dx\.)?doi\.org\//, "");
    if (ids.doi && d && (ids.doi === d || (ids.doi.startsWith(d) && !/[a-z0-9]/.test(ids.doi[d.length])))) return it;
  }
  return null;
}
function recentPapers(limit) {
  return paperIndex().filter((e) => e.recent).sort((a, b) => cmp(b.recent, a.recent)).slice(0, limit).map((e) => e.it);
}
function allPapersByUse() {
  return paperIndex().slice().sort((a, b) => cmp(b.recent, a.recent) || cmp(b.it.added || "", a.it.added || "")).map((e) => e.it);
}

// same test as the shell's ⌘V import (app.js)
const looksLikePaper = (t) => /^(https?:\/\/\S+|10\.\d{4,9}\/\S+|doi:\s*10\.\S+|arxiv:\s*\S+|\d{4}\.\d{4,5}(v\d+)?|[a-z-]+(\.[A-Z]{2})?\/\d{7}(v\d+)?)$/i.test(t.trim());

/* ------------------------------------------------------------------ projects, commands, tabs */
function projectPath(p) {
  const names = [];
  for (let q = p, n = 0; q && n < 20; q = q.parent ? store.project(q.parent) : null, n++) names.unshift(q.name || "Untitled project");
  return names;
}
function projectCount(id) {
  const ids = new Set(store.projectTree(id));
  let n = 0;
  for (const e of paperIndex()) if ((e.it.projects || []).some((p) => ids.has(p))) n++;
  return n;
}
// projects best first: [{p, path, q}]
function searchProjects(q, limit) {
  const ws = words(q), qf = fold(q).trim();
  const out = [];
  for (const p of store.lib.projects || []) {
    const path = projectPath(p), name = fold(p.name), full = fold(path.join(" "));
    let s = 0, qual = 4;
    for (const w of ws) {
      const a = where(name, w); if (a) { s += a >= 3 ? 6 : 4; qual = Math.min(qual, a); continue; }
      const b = where(full, w); if (b) { s += 2; qual = Math.min(qual, b, 3); continue; }
      s = 0; break;
    }
    if (!ws.length) s = 1;
    if (!s) continue;
    if (ws.length && name.startsWith(qf)) { s += 6; qual = 5; }
    out.push([s, p, path, qual]);
  }
  out.sort((a, b) => b[3] - a[3] || b[0] - a[0] || cmp(a[2].join("/").toLowerCase(), b[2].join("/").toLowerCase()));
  return out.slice(0, limit).map((x) => ({ p: x[1], path: x[2], q: x[3] }));
}

// commands that would only reopen this palette as it is
const SELF = new Set(["app.search", "app.palette"]);
function cmdUse() { try { return JSON.parse(localStorage.getItem(LS_CMDS) || "[]"); } catch (_) { return []; } }
function noteCmdUse(id) {
  try { const l = cmdUse().filter((x) => x !== id); l.unshift(id); localStorage.setItem(LS_CMDS, JSON.stringify(l.slice(0, 20))); } catch (_) {}
}
// The parts of a command title a person would start typing: the title itself, what follows "Go to"
// ("Go to Settings" -> "settings", "Go to project: Thesis" -> "thesis") and what follows a colon
// ("Theme: light" -> "light").
function cmdHeads(t) {
  const out = [t];
  const g = t.replace(/^go to (project: )?/, ""); if (g !== t) out.push(g);
  const c = t.indexOf(": "); if (c > 0) out.push(t.slice(c + 2));
  return out;
}
// commands best first: [{c, q}]; {skip} leaves some out (the All view shows projects in their own group)
function searchCommands(q, limit, { skip } = {}) {
  const ws = words(q), qf = fold(q).trim(), used = cmdUse();
  const out = [];
  for (const c of commands.available()) {
    if (SELF.has(c.id) || (skip && skip(c))) continue;
    const t = fold(c.title), rest = fold([c.section, c.keywords, c.keys].flat().filter(Boolean).join(" "));
    let s = 0, qual = 4;
    for (const w of ws) {
      const a = where(t, w); if (a) { s += a >= 3 ? 6 : 3; qual = Math.min(qual, a); continue; }
      const b = where(rest, w); if (b) { s += 2; qual = Math.min(qual, b, 3); continue; }
      s = 0; break;
    }
    if (!ws.length) s = 1;
    if (!s) continue;
    if (ws.length) {
      const heads = cmdHeads(t.replace(/[…]+$/, ""));
      if (heads.some((h) => h === qf)) { s += 20; qual = 5; }               // the whole name: "settings" -> Go to Settings
      else if (heads.some((h) => h.startsWith(qf))) { s += 5; qual = 5; }
    }
    const u = used.indexOf(c.id);
    if (u >= 0) s += ws.length ? Math.max(0, 3 - u * 0.2) : 100 - u;
    out.push([s, c, qual]);
  }
  out.sort((a, b) => b[2] - a[2] || b[0] - a[0]);
  return out.slice(0, limit).map((x) => ({ c: x[1], q: x[2] }));
}
// the empty-query "Commands" list: recently used first, then a few that are always handy
// (reader ones first when a paper is the active tab)
const STARTERS = ["go.paper", "go.library", "go.settings", "library.add-paper", "app.reopen-tab", "app.tabs-vertical", "app.shortcuts"];
const READER_STARTERS = ["reader.page", "reader.find", "reader.next-mark", "reader.annotate", "reader.next-paper", "reader.notes"];
function starterCommands(limit, inReader) {
  const avail = commands.available().filter((c) => !SELF.has(c.id)), by = new Map(avail.map((c) => [c.id, c]));
  const out = [];
  for (const id of [...cmdUse(), ...(inReader ? READER_STARTERS : []), ...STARTERS]) { const c = by.get(id); if (c && !out.includes(c)) out.push(c); if (out.length >= limit) return out; }
  for (const c of avail) { if (!out.includes(c)) out.push(c); if (out.length >= limit) break; }
  return out;
}
function openTabs(ctx) {
  let t = [];
  try { t = (ctx.tabs && ctx.tabs()) || []; } catch (_) {}
  return t.filter((x) => x && x.key && store.item(x.key));
}

/* ------------------------------------------------------------------ marks & notes (server search) */
// GET /api/search returns {key, where, snippet, att?, markId?, num?}; the page and type of a mark hit
// come from the marks file, fetched once per PDF and kept until that PDF's marks change.
const marksCache = new Map();   // "key/att" -> Promise<Map(id -> mark)>
// marks or notes changed: forget cached hits so the next search asks the server again
// (while the palette is open the old hits stay on screen until the new ones arrive)
const staleHits = () => { if (!P) return; P.ms.stale = true; if (P.open) scheduleMarks(true); };
store.on("marks-changed", ({ key, att } = {}) => { marksCache.delete(key + "/" + att); staleHits(); });
store.on("item", staleHits);
// the library arrived (or reloaded) while the palette is open: show what now matches
store.on("library", () => { marksCache.clear(); if (P && P.open) refresh(); staleHits(); });
function marksOf(key, att) {
  const id = key + "/" + att;
  if (!marksCache.has(id)) {
    const p = api.getMarks(key, att).then((j) => new Map((j.marks || []).map((m) => [m.id, m]))).catch(() => { marksCache.delete(id); return new Map(); });
    marksCache.set(id, p);
  }
  return marksCache.get(id);
}

/* ------------------------------------------------------------------ the palette */
let P = null;   // the one palette (built once, re-attached on each open)

function build() {
  const scrim = el("div", "scrim pal-scrim");
  const box = el("div", "pal"); box.setAttribute("role", "dialog"); box.setAttribute("aria-modal", "true"); box.setAttribute("aria-label", "Search");
  const head = el("div", "pal-head");
  const title = el("h2", "pal-title", "Search");
  const x = el("button", "ibtn pal-x"); x.title = "Close (Esc)"; x.setAttribute("aria-label", "Close"); x.append(icon("x"));
  head.append(title, x);
  const sw = el("div", "search pal-search");
  const input = el("input", "input pal-input");
  input.type = "text"; input.spellcheck = false; input.autocomplete = "off";
  input.setAttribute("role", "combobox"); input.setAttribute("aria-expanded", "true"); input.setAttribute("aria-controls", "pal-list"); input.setAttribute("aria-autocomplete", "list");
  sw.append(icon("search"), input);
  const tabs = el("div", "segctl pal-filters"); tabs.setAttribute("role", "radiogroup"); tabs.setAttribute("aria-label", "Show");
  const tabBtns = new Map();
  for (const [id, label] of FILTERS) {
    const b = el("button", "segctl__btn", label); b.type = "button"; b.tabIndex = -1;
    b.setAttribute("role", "radio"); b.dataset.f = id;
    b.addEventListener("mousedown", (ev) => ev.preventDefault());   // keep the caret in the input
    b.addEventListener("click", () => setFilter(id));
    tabBtns.set(id, b); tabs.append(b);
  }
  const list = el("div", "pal-list"); list.id = "pal-list"; list.setAttribute("role", "listbox"); list.setAttribute("aria-label", "Results");
  const foot = el("div", "pal-foot");
  for (const [label, k] of [["Close", "Esc"], ["Switch", "⇥"], ["Open", "↵"], ["New window", "⌘↵"], ["Show in Library", "⌥↵"]]) {
    const s = el("span", "pal-foot__hint"); s.append(el("span", null, label + " "), el("kbd", null, k)); foot.append(s);
  }
  box.append(head, sw, tabs, list, foot);
  scrim.append(box);

  scrim.addEventListener("mousedown", (ev) => { if (ev.target === scrim) { ev.preventDefault(); close(); } });
  x.addEventListener("click", () => close());
  input.addEventListener("input", () => { P.query = input.value; P.resetSel = true; refresh(); scheduleMarks(); });
  input.addEventListener("keydown", onKey);
  // clicks anywhere in the box (rows, headings, footer, empty space) leave the caret in the field
  box.addEventListener("mousedown", (ev) => { if (ev.target !== input) ev.preventDefault(); });
  list.addEventListener("pointermove", (ev) => {
    if (ev.clientX === P.px && ev.clientY === P.py) return;   // the list scrolled under a still pointer
    P.px = ev.clientX; P.py = ev.clientY;
    const r = ev.target.closest(".pal-row"); if (r) select(+r.dataset.i, false);
  });
  list.addEventListener("click", (ev) => {
    const r = ev.target.closest(".pal-row"); if (!r) return;
    runAt(+r.dataset.i, { newWindow: ev.metaKey || ev.ctrlKey, reveal: ev.altKey });
  });
  list.addEventListener("scroll", () => { if (P.more && list.scrollTop + list.clientHeight > list.scrollHeight - 300) renderMore(); }, { passive: true });

  return { scrim, box, input, tabs, tabBtns, list, ctx: null, filter: "all", query: "", sel: 0, entries: [], rendered: 0, more: false,
    px: -1, py: -1, ms: { q: "", hits: [], loading: false, timer: 0, abort: null }, prevFocus: null, open: false };
}

export function openPalette(ctx, { filter = "all", query = "" } = {}) {
  const t0 = performance.now();
  if (!P) P = build();
  P.ctx = ctx || P.ctx || {};
  if (!FILTERS.some((f) => f[0] === filter)) filter = "all";
  if (!P.open) {
    P.prevFocus = document.activeElement;
    ui.closeMenus(); ui.closePopover();
    document.getElementById("overlay-root").append(P.scrim);
    P.open = true;
    P.query = query || "";
    // notes and abstracts are saved without telling anyone: ask the server afresh each time
    P.ms.q = ""; P.ms.hits = []; P.ms.stale = false;
    document.addEventListener("keydown", onDocKey, true);
    document.addEventListener("focusin", onDocFocus, true);
  } else if (query) P.query = query;
  P.input.value = P.query;
  P.filter = filter; P.resetSel = true;
  syncFilterTabs();
  refresh();
  scheduleMarks(true);
  P.input.focus({ preventScroll: true });
  P.input.select();
  P.openMs = performance.now() - t0;
  return P;
}

export function closePalette() { close(); }
export const isPaletteOpen = () => !!(P && P.open);

function close({ restoreFocus = true } = {}) {
  if (!P || !P.open) return;
  P.open = false;
  document.removeEventListener("keydown", onDocKey, true);
  document.removeEventListener("focusin", onDocFocus, true);
  clearTimeout(P.ms.timer); if (P.ms.abort) P.ms.abort.abort();
  P.scrim.remove();
  P.list.textContent = ""; P.entries = []; P.rendered = 0;
  const f = P.prevFocus; P.prevFocus = null;
  if (restoreFocus && f && f.isConnected && f.focus) f.focus({ preventScroll: true });
}

function setFilter(id) {
  if (!P || P.filter === id) return;
  P.filter = id; P.resetSel = true;
  syncFilterTabs();
  refresh();
  scheduleMarks(true);
}
function syncFilterTabs() {
  for (const [id, b] of P.tabBtns) b.setAttribute("aria-checked", String(id === P.filter));
  P.input.placeholder = {
    all: "Search papers, marks, notes, projects and commands",
    papers: "Search titles, authors, years, venues, tags, DOIs",
    marks: "Search the text of marks, notes and abstracts",
    projects: "Search projects",
    commands: "Search commands",
  }[P.filter];
}
function cycleFilter(d) {
  const i = FILTERS.findIndex((f) => f[0] === P.filter);
  setFilter(FILTERS[(i + d + FILTERS.length) % FILTERS.length][0]);
}

// The palette keeps the keyboard while it is open, wherever the focus went (a click on a heading,
// the footer, the list's scrollbar): keys are handed to the field, and focus never leaves the box.
function onDocKey(ev) {
  if (!P || !P.open || ev.target === P.input) return;
  const t = ev.target;
  // something else on top of the palette (a dialog or menu) owns its own keys
  if (!P.scrim.contains(t) && t.closest && t.closest(".scrim, .popover, .menu")) return;
  P.input.focus({ preventScroll: true });
  onKey(ev);
}
function onDocFocus(ev) {
  if (!P || !P.open || ev.target === P.input) return;
  if (ev.target.closest && ev.target.closest(".scrim:not(.pal-scrim), .popover, .menu")) return;
  P.input.focus({ preventScroll: true });
}

function onKey(ev) {
  const mod = ev.metaKey || ev.ctrlKey;
  const k = ev.key;
  if (k === "Escape") { ev.preventDefault(); ev.stopPropagation(); close(); return; }
  if (mod && !ev.altKey && k.toLowerCase() === "k") { ev.preventDefault(); close(); return; }
  if (mod && !ev.altKey && k.toLowerCase() === "p") { ev.preventDefault(); setFilter("papers"); return; }
  if (k === "Tab") { ev.preventDefault(); cycleFilter(ev.shiftKey ? -1 : 1); return; }
  if ((k === "ArrowLeft" || k === "ArrowRight") && !P.input.value && !mod && !ev.altKey && !ev.shiftKey) { ev.preventDefault(); cycleFilter(k === "ArrowRight" ? 1 : -1); return; }
  if (k === "ArrowDown" || k === "ArrowUp") { ev.preventDefault(); move(k === "ArrowDown" ? 1 : -1, mod); return; }
  if (k === "PageDown" || k === "PageUp") { ev.preventDefault(); move(k === "PageDown" ? 8 : -8); return; }
  if (k === "Enter" && !ev.isComposing) { ev.preventDefault(); runAt(P.sel, { newWindow: mod, reveal: ev.altKey && !mod }); return; }
  // digits with ⌃ jump straight to a filter (⌃1 All … ⌃5 Commands)
  if (ev.ctrlKey && !ev.metaKey && /^Digit[1-5]$/.test(ev.code)) { ev.preventDefault(); setFilter(FILTERS[+ev.code.slice(5) - 1][0]); }
}

/* ------------------------------------------------------------------ results */
// entries: {head} | {line} | {kind: "paper"|"tab"|"project"|"command"|"hit", id, ...}
function compute() {
  const q = P.query.trim(), f = P.filter, has = !!words(q).length, out = [];
  const tabs = openTabs(P.ctx), inTab = new Map(tabs.map((t) => [t.key, t]));
  const group = (title, items) => { if (items.length) out.push({ head: title }, ...items); };
  // a paper whose tab is the one showing counts as active, so the reset rule in refresh() skips it
  const paperE = (it) => { const tab = inTab.get(it.key); return { kind: "paper", id: "p:" + it.key, it, tab, active: !!(tab && tab.active) }; };
  const tabE = (t) => ({ kind: "tab", id: "t:" + t.key + "/" + t.att, it: store.item(t.key), att: t.att, title: t.title, active: !!t.active });
  const projE = (x) => ({ kind: "project", id: "j:" + x.p.id, p: x.p, path: x.path });
  const cmdE = (c) => ({ kind: "command", id: "c:" + c.id, c });
  const hitE = (h, i) => ({ kind: "hit", id: "h:" + i + ":" + h.key + "/" + (h.att || "") + "/" + (h.markId || h.where), h, it: store.item(h.key) });
  const hits = () => (P.ms.q === q ? P.ms.hits.filter((h) => store.item(h.key) && !store.item(h.key).trashed) : []);
  const pending = () => has && P.ms.q !== q;

  if (f === "all") {
    if (!has) {
      group("Open tabs", tabs.slice(0, 12).map(tabE));
      const recent = recentPapers(8 + tabs.length).filter((it) => !inTab.has(it.key)).slice(0, 8);
      group("Recent", recent.map(paperE));
      // nothing opened yet: the newest papers instead
      if (!recent.length) group("Recently added", allPapersByUse().filter((it) => !inTab.has(it.key)).slice(0, 5).map(paperE));
      let inReader = false; try { inReader = !!(P.ctx.activeTab && (P.ctx.activeTab() || {}).key); } catch (_) {}
      group("Commands", starterCommands(5, inReader).map(cmdE));
      if (!out.length) out.push({ line: "Type to search your library." });
      return out;
    }
    // Groups are ordered by their best match (ties keep the order below), so "find" puts the
    // Find command first; a paper that matches only with a typo is left out when anything matches exactly.
    const pq = new Map(searchPapersQ(q, 1000).map((x) => [x.it.key, x.q]));
    const known = paperById(q);               // a pasted ID / DOI / link of a paper already here
    if (known) pq.set(known.key, 6);
    const qf = fold(q).trim();
    const tabQ = (t) => Math.max(pq.get(t.key) || 0, fold(texPlain(t.title || "")).includes(qf) ? 2 : 0);
    let tabHits = tabs.map((t) => [t, tabQ(t)]).filter((x) => x[1]).sort((a, b) => b[1] - a[1]);
    const shown = new Set(tabHits.map((x) => x[0].key));
    let papers = [...pq].filter(([k]) => !shown.has(k)).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, qq]) => [store.item(k), qq]);
    const projs = searchProjects(q, 4);
    const projIds = new Set(projs.map((x) => x.p.id));
    const cmds = searchCommands(q, 5, { skip: (c) => c.id.startsWith("go.project.") && projIds.has(c.id.slice(11)) });
    const best = Math.max(0, ...tabHits.map((x) => x[1]), ...papers.map((x) => x[1]), ...projs.map((x) => x.q), ...cmds.map((x) => x.q));
    if (best >= 2) { tabHits = tabHits.filter((x) => x[1] >= 2); papers = papers.filter((x) => x[1] >= 2); }
    // a pasted DOI / arXiv ID / link that isn't in the library yet can be added right from here
    const add = looksLikePaper(q) && !known ? [{ kind: "add", id: "a:" + q, input: q }] : [];
    const groups = [
      { title: "Add to library", q: 7, rows: add },
      { title: "Open tabs", q: Math.max(0, ...tabHits.map((x) => x[1])), rows: tabHits.slice(0, 5).map((x) => tabE(x[0])) },
      { title: "Papers", q: Math.max(0, ...papers.map((x) => x[1])), rows: papers.map((x) => paperE(x[0])) },
      { title: "Projects", q: Math.max(0, ...projs.map((x) => x.q)), rows: projs.map(projE) },
      { title: "Commands", q: Math.max(0, ...cmds.map((x) => x.q)), rows: cmds.map((x) => cmdE(x.c)) },
    ].filter((g) => g.rows.length);
    groups.sort((a, b) => b.q - a.q);           // stable: ties keep the order above
    for (const g of groups) group(g.title, g.rows);
    // server results arrive last, so they go last: rows already on screen never move down
    group("Marks & notes", hits().slice(0, 6).map(hitE));
    if (!out.length) out.push({ line: !store.loaded ? "Loading the library…" : pending() ? "Searching…" : "No results" });
    return out;
  }
  if (f === "papers") {
    let list = has ? searchPapers(q, 100000) : allPapersByUse();
    const known = has && paperById(q);
    if (known) list = [known, ...list.filter((it) => it !== known)];
    group(has ? "Papers" : "All papers", list.map(paperE));
    if (!out.length) out.push({ line: !store.loaded ? "Loading the library…" : has ? "No results" : "No papers in your library yet." });
    return out;
  }
  if (f === "marks") {
    if (q.length < 2) { out.push({ line: "Type to search the text of your marks, notes and abstracts." }); return out; }
    const hs = hits();
    const marks = [], notes = [], abs = [];
    hs.forEach((h, i) => (h.where === "marks" ? marks : h.where === "notes" ? notes : abs).push(hitE(h, i)));
    group("Marks", marks); group("Notes", notes); group("Abstracts", abs);
    if (!out.length) out.push({ line: pending() ? "Searching…" : "No results" });
    return out;
  }
  if (f === "projects") {
    group(has ? "Projects" : "All projects", searchProjects(q, 1000).map(projE));
    if (!out.length) out.push({ line: has ? "No results" : "No projects yet." });
    return out;
  }
  // commands
  if (has) group("Commands", searchCommands(q, 1000).map((x) => cmdE(x.c)));
  else {
    const by = new Map();
    for (const c of commands.available()) { if (SELF.has(c.id)) continue; const s = c.section || "Other"; if (!by.has(s)) by.set(s, []); by.get(s).push(c); }
    const order = ["Go to", "App", "Library", "Reader", "Marking"];
    for (const s of [...order.filter((x) => by.has(x)), ...[...by.keys()].filter((x) => !order.includes(x))]) group(s, by.get(s).map(cmdE));
  }
  if (!out.length) out.push({ line: has ? "No results" : "No commands yet." });
  return out;
}

// recompute and redraw, keeping the highlighted row when it is still there
function refresh() {
  if (!P || !P.open) return;
  const prevId = P.entries[P.sel] && P.entries[P.sel].id;
  P.entries = compute();
  const sels = selectable();
  let i = prevId ? P.entries.findIndex((e) => e.id === prevId) : -1;
  const reset = P.resetSel || i < 0, keepTop = P.list.scrollTop;
  // start on the first row, unless that is the tab already showing (Enter would do nothing)
  if (reset) i = sels.length ? (sels.length > 1 && P.entries[sels[0]].active ? sels[1] : sels[0]) : -1;
  P.resetSel = false;
  P.sel = i;
  P.list.textContent = ""; P.rendered = 0;
  renderMore(Math.max(PAGE, i + 20));
  P.list.scrollTop = reset ? 0 : keepTop;
  select(i, true);
}
const isRow = (e) => e && !e.head && !e.line;
const selectable = () => { const s = []; P.entries.forEach((e, i) => { if (isRow(e)) s.push(i); }); return s; };

function renderMore(n = PAGE) {
  const end = Math.min(P.entries.length, P.rendered + n), frag = document.createDocumentFragment();
  for (let i = P.rendered; i < end; i++) frag.append(renderEntry(P.entries[i], i));
  P.list.append(frag);
  P.rendered = end;
  P.more = end < P.entries.length;
}

/* ------------------------------------------------------------------ rows */
// text with the query words in bold (cheap: only for rows that are drawn)
// the folded text plus, for each of its positions, where that is in the original text
// (folding can change the length: "…" -> "...", "ﬁ" -> "fi", "é" stays one letter)
function foldMap(text) {
  const f0 = fold(text);
  if (f0.length === text.length) { const at = new Array(text.length + 1); for (let i = 0; i <= text.length; i++) at[i] = i; return { f: f0, at }; }
  let f = ""; const at = [];
  for (let i = 0; i < text.length;) {
    const ch = String.fromCodePoint(text.codePointAt(i)), fc = fold(ch);
    for (let k = 0; k < fc.length; k++) at.push(i);
    f += fc; i += ch.length;
  }
  at.push(text.length);
  // the end of a match is the start of the next folded position, so a match never splits a letter
  return { f, at };
}
function hl(text, ws) {
  const span = el("span");
  text = String(text || "");
  if (!ws.length || !text) { span.textContent = text; return span; }
  const { f, at } = foldMap(text);
  const marks = new Uint8Array(text.length);
  for (const w of ws) {
    if (w.length < 2) continue;
    let i = f.indexOf(w);
    while (i >= 0) { marks.fill(1, at[i], at[i + w.length]); i = f.indexOf(w, i + w.length); }
  }
  let i = 0;
  while (i < text.length) {
    let j = i; while (j < text.length && marks[j] === marks[i]) j++;
    const part = text.slice(i, j);
    span.append(marks[i] ? el("b", null, part) : document.createTextNode(part));
    i = j;
  }
  return span;
}
const hintOf = (it, tab) => {
  if (tab) return tab.active ? "current tab" : "open tab";
  const p = (it.projects || []).map((id) => store.project(id)).find(Boolean);
  return p ? p.name : "";
};
function paperMeta(it) {
  const venue = it.venue || (it.arxiv ? "arXiv:" + it.arxiv : "");
  return [ui.authorsShort(it.authors), it.year, venue].filter((x) => x !== "" && x != null).join(" · ");
}
function attLabel(it, att) {
  if (!it || (it.attachments || []).length < 2) return "";
  const a = it.attachments.find((x) => x.key === att);
  return a ? a.label || a.key : "";
}

function renderEntry(e, i) {
  if (e.head) { const d = el("div", "pal-head2", e.head); d.setAttribute("role", "presentation"); return d; }
  if (e.line) { const d = el("div", "pal-line", e.line); d.setAttribute("role", "presentation"); return d; }
  const ws = words(P.query);
  const r = el("div", "pal-row"); r.dataset.i = i; r.id = "pal-o-" + i; r.setAttribute("role", "option");
  const ic = el("span", "pal-row__ic"), main = el("span", "pal-row__main"), t = el("span", "pal-row__title"), m = el("span", "pal-row__meta");
  let hint = "", kbd = "";
  if (e.kind === "paper" || e.kind === "tab") {
    const it = e.it;
    ic.append(icon("pdf"));
    t.append(hl(titleOf(it), ws));
    const lbl = e.kind === "tab" ? attLabel(it, e.att) : "";
    m.textContent = [paperMeta(it), lbl].filter(Boolean).join(" · ");
    hint = e.kind === "tab" ? (e.active ? "current tab" : "open tab") : hintOf(it, e.tab);
    if (!(it.attachments || []).length) hint = "no PDF";
  } else if (e.kind === "project") {
    ic.append(icon("folder"));
    t.append(hl(e.p.name, ws));
    m.textContent = e.path.length > 1 ? "In " + e.path.slice(0, -1).join(" / ") : "Project";
    const n = projectCount(e.p.id); hint = n === 1 ? "1 paper" : n + " papers";
  } else if (e.kind === "command") {
    ic.append(icon(cmdIcon(e.c)));
    t.append(hl(e.c.title, ws));
    r.classList.add("pal-row--one");
    hint = P.filter === "commands" && !ws.length ? "" : e.c.section || ""; kbd = e.c.keys || "";
  } else if (e.kind === "add") {
    ic.append(icon("plus"));
    t.append(document.createTextNode("Add “" + ui.shortTitle(e.input, 60) + "” to the library"));
    r.classList.add("pal-row--one");
    hint = e.project ? "into " + e.project.name : "";
  } else if (e.kind === "hit") {
    const h = e.h, it = e.it;
    if (h.where === "marks") {
      const mk = h.mark;
      ic.append(icon("mark"));
      const page = h.page || (mk && mk.page);
      hint = page ? "p. " + page : h.num ? "#" + h.num : "";
    } else {
      ic.append(icon(h.where === "notes" ? "note" : "doc"));
      hint = h.where === "notes" ? "Notes" : "Abstract";
    }
    t.append(hl(h.where === "abstract" ? tidyAbstract(h.snippet) : oneLine(h.snippet), ws));
    t.classList.add("pal-row__title--snip");
    const lbl = attLabel(it, h.att);
    m.textContent = [ui.shortTitle(it ? titleOf(it) : h.key, lbl ? 60 : 90), lbl && ui.shortTitle(lbl, 26)].filter(Boolean).join(" · ");
    const type = h.where === "marks" && ((h.mark && h.mark.type) || h.type);
    // the type as everywhere else: a small square in the type colour + its name
    if (type) { r.classList.add(marktypes.cls(type)); m.prepend(el("span", "pal-sq"), el("span", "pal-type", marktypes.get(type).name), document.createTextNode(" · ")); }
  }
  main.append(t);
  if (m.textContent) main.append(m); else r.classList.add("pal-row--one");
  r.append(ic, main);
  if (hint) r.append(el("span", "pal-row__hint", hint));
  if (kbd) r.append(el("kbd", "pal-row__kbd", kbd));
  return r;
}
function cmdIcon(c) {
  const s = (c.section || "").toLowerCase(), t = (c.title || "").toLowerCase();
  if (/setting|preference/.test(t)) return "sliders";
  if (/trash/.test(t)) return "trash";
  if (/project|section/.test(t)) return "folder";
  if (/library/.test(t)) return "library";
  if (/^add |import/.test(t)) return "plus";
  if (/window|tab/.test(t)) return "sidebar-left";
  if (/bibtex|citation|cite|copy/.test(t)) return "quote";
  if (/note/.test(t)) return "note";
  if (s === "marking" || /mark/.test(t)) return "mark";
  if (/find|search/.test(t)) return "search";
  if (/paper|pdf|journal/.test(t)) return "doc";
  if (/page|zoom|fit/.test(t)) return "pages";
  if (/outline/.test(t)) return "outline";
  if (/theme|density/.test(t)) return "sliders";
  if (/undo|redo|reopen/.test(t)) return "restore";
  if (s === "reader") return "pdf";
  return "chev-right";      // every command row has an icon, so the titles line up
}

/* ------------------------------------------------------------------ selection + running */
function rowEl(i) { return i >= 0 && i < P.rendered ? P.list.querySelector(`.pal-row[data-i="${i}"]`) : null; }
function select(i, scroll) {
  const old = P.list.querySelector(".pal-row.is-sel");
  if (old) { old.classList.remove("is-sel"); old.setAttribute("aria-selected", "false"); }
  P.sel = i;
  if (i >= P.rendered && P.more) renderMore(i - P.rendered + PAGE);
  const r = rowEl(i);
  if (!r) { P.input.removeAttribute("aria-activedescendant"); return; }
  r.classList.add("is-sel"); r.setAttribute("aria-selected", "true");
  P.input.setAttribute("aria-activedescendant", r.id);
  if (scroll) {
    // the first row of a group brings its heading into view too
    const prev = r.previousElementSibling;
    const top = prev && prev.classList.contains("pal-head2") ? prev : r;
    const L = P.list, lt = L.scrollTop, lh = L.clientHeight;
    if (top.offsetTop < lt) L.scrollTop = top === L.firstElementChild ? 0 : top.offsetTop - 2;
    else if (r.offsetTop + r.offsetHeight > lt + lh) L.scrollTop = r.offsetTop + r.offsetHeight - lh + 2;
  }
}
function move(d, toEnd) {
  const s = selectable(); if (!s.length) return;
  let k = s.indexOf(P.sel);
  if (toEnd) k = d > 0 ? s.length - 1 : 0;
  else if (k < 0) k = d > 0 ? 0 : s.length - 1;
  else if (Math.abs(d) === 1) k = (k + d + s.length) % s.length;     // wrap at the ends
  else k = Math.max(0, Math.min(s.length - 1, k + d));
  select(s[k], true);
}

function runAt(i, mods = {}) {
  const e = P.entries[i]; if (!isRow(e)) return;
  const ctx = P.ctx || {};
  // close first so whatever runs (a dialog, a new tab) gets the focus
  close({ restoreFocus: e.kind === "command" });
  try {
    if (e.kind === "command") { noteCmdUse(e.c.id); Promise.resolve(commands.run(e.c.id)).catch((err) => ui.toast(err.message || String(err), { error: true })); return; }
    if (e.kind === "add") { addPaper(ctx, e.input); return; }
    if (e.kind === "project") { ctx.openLibrary && ctx.openLibrary({ name: "library", filter: "project", id: e.p.id }); return; }
    if (e.kind === "paper") return openPaper(ctx, e.it, (e.tab && e.tab.att) || null, mods);
    if (e.kind === "tab") return openPaper(ctx, e.it, e.att, mods);
    if (e.kind === "hit") {
      const h = e.h, it = e.it; if (!it) return;
      if (h.where === "abstract" && !mods.newWindow) return reveal(ctx, it.key);
      const page = h.page || (h.mark && h.mark.page) || null;
      const jump = h.where === "marks" ? { page, markId: h.markId || null } : { panel: "notes", find: P.query.trim() };
      return openPaper(ctx, it, h.att || null, mods, jump);
    }
  } catch (err) { console.error(err); ui.toast(err.message || String(err), { error: true }); }
}
async function addPaper(ctx, input) {
  ui.toast("Adding " + input + "…", { ms: 60000 });
  try {
    const j = await store.import(input.trim(), null);
    ui.toast(j.duplicate ? "Already in your library." : (j.warnings || [])[0] || "Added.");
    reveal(ctx, j.item.key);
  } catch (err) { ui.toast(input + ": " + err.message, { error: true }); }
}
function reveal(ctx, key) {
  if (ctx.openLibrary) ctx.openLibrary();
  // the library listens for "reveal" once it is showing
  setTimeout(() => store.emit("reveal", { keys: [key] }), 0);
}
function openPaper(ctx, it, att, mods = {}, jump = null) {
  if (!it) return;
  att = att || (store.primaryAtt(it) || {}).key;
  if (mods.reveal || !att) { if (!att && !mods.reveal) ui.toast("This paper has no PDF yet."); return reveal(ctx, it.key); }
  if (mods.newWindow) {
    if (ctx.openInNewWindow) return ctx.openInNewWindow(it.key, att);
    const id = it.key + "/" + att, enc = encodeURIComponent;
    const w = window.open(location.pathname + "?solo=" + enc(id) + "#/read/" + enc(it.key) + "/" + enc(att), "pm2-" + id.replace(/[^\w-]/g, "_"), "popup=yes,width=1200,height=860");
    if (!w) ui.toast("The browser blocked the new window. Allow pop-ups for localhost.", { error: true });
    return;
  }
  ctx.openReader && ctx.openReader(it.key, att, jump || undefined);
  if (!jump) return;
  // The reader may take this over (CONTRACT §10.2): a listener that will go to the page / mark or show
  // the notes sets detail.handled = true. Until then the palette does it through the reader's controls.
  const detail = { key: it.key, att, ...jump, handled: false };
  store.emit("reader-jump", detail);
  if (!detail.handled) applyJump(detail);
}

/* ------------------------------------------------------------------ server search for marks & notes */
function scheduleMarks(now) {
  if (!P || !P.open) return;
  const q = P.query.trim();
  clearTimeout(P.ms.timer);
  if (!(P.filter === "all" || P.filter === "marks") || q.length < 2) return;
  if (P.ms.q === q && !P.ms.stale) return;
  P.ms.timer = setTimeout(() => fetchMarks(q), now ? 0 : 150);
}
async function fetchMarks(q) {
  if (P.ms.abort) P.ms.abort.abort();
  const ac = new AbortController(); P.ms.abort = ac;
  let hits = [];
  try { hits = (await api.search(q, ac.signal)).hits || []; }
  catch (err) { if (ac.signal.aborted) return; console.warn("palette search:", err); hits = []; }
  if (ac.signal.aborted || !P.open || P.query.trim() !== q) return;
  P.ms.q = q; P.ms.hits = hits; P.ms.stale = false;
  refresh();
  // fill in the page + type of mark hits from their marks files (one request per PDF, cached)
  const need = new Map();
  for (const h of hits) if (h.where === "marks" && h.att && h.page == null && !h.mark) { const id = h.key + "/" + h.att; if (!need.has(id)) need.set(id, []); need.get(id).push(h); }
  if (!need.size) return;
  await Promise.all([...need].slice(0, 40).map(async ([id, hs]) => {
    const [key, att] = id.split("/");
    const ms = await marksOf(key, att);
    for (const h of hs) { const m = ms.get(h.markId); if (m) h.mark = { page: m.page, type: m.type }; }
  }));
  if (P.open && P.ms.q === q && P.ms.hits === hits) refresh();
}

// warm the index while the browser is idle, so the first ⌘K is instant
store.on("library", () => { const f = () => { if (indexDirty) buildIndex(); }; (window.requestIdleCallback || setTimeout)(f, { timeout: 1500 }); });

/* ------------------------------------------------------------------ going to a mark / the notes */
// Fallback for while the reader doesn't take "reader-jump" itself: wait until the reader shows this
// PDF (it may still be loading, or be the one already open), then use its own controls — the mark's
// card in the side panel (goes to the mark and opens it), the page box, or the Notes tab.
let jumpSeq = 0;
function applyJump(d) {
  const seq = ++jumpSeq, t0 = performance.now();
  const q = (id) => document.getElementById("rd-" + id);
  const onRoute = () => {
    const parts = location.hash.replace(/^#\/?/, "").split("/").map((x) => { try { return decodeURIComponent(x); } catch (_) { return x; } });
    return parts[0] === "read" && parts[1] === d.key && parts[2] === d.att;
  };
  const showing = () => {
    const view = document.getElementById("view-reader"), gp = q("gnPath"), ds = q("docSelect"), pages = q("pages");
    return view && !view.hidden && gp && gp.textContent === "library/items/" + d.key + "/notes.md" &&
      ds && ds.value === d.att && pages && pages.querySelector(".page") && !q("loadState");
  };
  let readyAt = 0;
  const tick = () => {
    if (seq !== jumpSeq || performance.now() - t0 > 20000 || !onRoute()) return;
    if (!showing()) { readyAt = 0; setTimeout(tick, 50); return; }
    // let the reader finish laying out the pages (restored zoom, fit) before moving
    if (!readyAt) { readyAt = performance.now(); setTimeout(tick, 120); return; }
    if (d.panel === "notes") return showNotes(d, seq);
    const card = d.markId && q("list") && q("list").querySelector('[data-card="' + CSS.escape(d.markId) + '"]');
    if (card) { card.click(); return; }
    if (d.page && q("pageIn")) {
      const pi = q("pageIn");
      pi.value = String(d.page);
      pi.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    }
  };
  setTimeout(tick, 0);
}
function showNotes(d, seq) {
  const q = (id) => document.getElementById("rd-" + id);
  const panel = q("panel");
  if (!panel) return;
  if (panel.hidden && q("notesBtn")) q("notesBtn").click();          // opens the panel on Notes
  else if (q("tabNotes")) q("tabNotes").click();
  // select the words that were searched for once the notes have loaded
  const ta = q("gnText"), t0 = performance.now();
  const sel = () => {
    if (seq !== jumpSeq || !ta || !d.find) return;
    const fm = foldMap(ta.value), w = fold(d.find), i = fm.f.indexOf(w);
    if (i < 0 && !ta.value && performance.now() - t0 < 3000) { setTimeout(sel, 80); return; }
    if (i < 0) return;
    const at = fm.at[i];
    ta.focus({ preventScroll: true });
    ta.setSelectionRange(at, fm.at[i + w.length]);
    // bring the selection into view: put the caret line near the top
    const lines = ta.value.slice(0, at).split("\n").length - 1, lh = parseFloat(getComputedStyle(ta).lineHeight) || 18;
    ta.scrollTop = Math.max(0, lines * lh - lh * 2);
  };
  setTimeout(sel, 0);
}
