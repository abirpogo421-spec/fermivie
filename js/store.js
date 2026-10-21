// Library state + a tiny event bus shared by the shell, the library view and the reader.
import { api } from "./api.js";
import * as undoLog from "./undo.js";

const clone = (x) => JSON.parse(JSON.stringify(x));
const short = (k) => { const it = store.item(k); const t = (it && it.title) || k; return "“" + (t.length > 40 ? t.slice(0, 39) + "…" : t) + "”"; };

const listeners = new Map();

/* ---------------------------------------------------------------- settings (CONTRACT §10.3) */
export const SETTINGS_DEFAULTS = {
  theme: "system", tabs: "horizontal", density: "comfortable",
  reader: { defaultZoom: "width", pageTheme: "normal", showFlags: true, selectionToolbar: true, quickKeys: true, smoothScroll: true },
  marks: { confirmDelete: true },
  library: { preferJournal: true, preprintFallback: true, watchDirs: ["~/Downloads", "~/Desktop"], newProjectSections: ["To mark", "Reference"] },
};
const isObj = (x) => x && typeof x === "object" && !Array.isArray(x);
function deepMerge(base, patch) {
  const out = clone(base);
  for (const [k, v] of Object.entries(patch || {})) out[k] = isObj(v) && isObj(out[k]) ? deepMerge(out[k], v) : clone(v);
  return out;
}
const LS_SETTINGS = "pm2:settings";   // a local copy so the theme is right before the server answers
// The server writes its saved settings into index.html (window.__PM_SETTINGS__) when it serves it; that
// beats this origin's local copy, which is missing or stale on a new origin / browser or after a hand edit.
const cachedSettings = () => {
  if (window.__PM_SETTINGS__ && typeof window.__PM_SETTINGS__ === "object") return window.__PM_SETTINGS__;
  try { return JSON.parse(localStorage.getItem(LS_SETTINGS) || "null"); } catch (_) { return null; }
};
const cacheSettings = (s) => { try { localStorage.setItem(LS_SETTINGS, JSON.stringify(s)); } catch (_) {} };
async function settingsReq(method, body) {
  let r;
  try { r = await fetch("/api/settings", body ? { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : { method }); }
  catch (_) { throw new Error("Can't reach the Paper Marker server. Is it running?"); }
  const j = await r.json().catch(() => ({ ok: false, error: `Bad response (${r.status})` }));
  if (!r.ok || j.ok === false) throw new Error(j.error || `Server error ${r.status}`);
  return j;
}
let settingsQueue = Promise.resolve();
// Settings > Library & import > New project sections: a new project starts with these sections.
// The default pair is what the library shows for a project without sections, so nothing is stored then.
async function withStartSections(p) {
  const names = ((store.settings.library || {}).newProjectSections || []).map((x) => String(x).replace(/\s+/g, " ").trim().slice(0, 40)).filter(Boolean).slice(0, 20);
  if (!p || !names.length || JSON.stringify(names) === JSON.stringify(SETTINGS_DEFAULTS.library.newProjectSections)) return p;
  const used = new Set();
  const sections = names.map((name) => {
    let base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 20) || "section", id = base, n = 2;
    while (used.has(id)) id = base + "-" + n++;
    used.add(id);
    return { id, name };
  });
  try { const k = await api.patchProject(p.id, { sections }); Object.assign(p, k.project); }
  catch (e) { console.warn("project sections:", e.message); }
  return p;
}

export const store = {
  lib: { items: {}, projects: [] },
  stats: {},
  loaded: false,
  settings: deepMerge(SETTINGS_DEFAULTS, cachedSettings() || {}),
  about: null,      // {library, version, port} from GET /api/settings

  async loadSettings() {
    try {
      const j = await settingsReq("GET");
      store.settings = deepMerge(SETTINGS_DEFAULTS, j.settings || {});
      store.about = j.about || null;
      cacheSettings(store.settings);
    } catch (e) { console.warn("settings:", e.message); }
    store.emit("settings", { settings: store.settings, patch: null });
    return store.settings;
  },
  // deep-merges the patch, applies it at once, then saves; a failed save puts the old values back
  async setSettings(patch) {
    const before = store.settings;
    store.settings = deepMerge(store.settings, patch);
    cacheSettings(store.settings);
    store.emit("settings", { settings: store.settings, patch });
    const job = settingsQueue.then(() => settingsReq("PUT", { settings: patch }));
    settingsQueue = job.catch(() => {});
    try {
      const j = await job;
      store.settings = deepMerge(SETTINGS_DEFAULTS, j.settings || {});
      if (j.about) store.about = j.about;
      cacheSettings(store.settings);
      return store.settings;
    } catch (e) {
      store.settings = deepMerge(before, {});
      cacheSettings(store.settings);
      store.emit("settings", { settings: store.settings, patch: null, failed: true });
      throw e;
    }
  },

  on(ev, fn) { if (!listeners.has(ev)) listeners.set(ev, new Set()); listeners.get(ev).add(fn); return () => store.off(ev, fn); },
  off(ev, fn) { listeners.get(ev) && listeners.get(ev).delete(fn); },
  emit(ev, detail) { (listeners.get(ev) || []).forEach((fn) => { try { fn(detail); } catch (e) { console.error(e); } }); },

  async load() {
    const j = await api.library();
    store.lib = j.library || { items: {}, projects: [] };
    if (!store.lib.items) store.lib.items = {};
    if (!store.lib.projects) store.lib.projects = [];
    store.stats = j.stats || {};
    store.loaded = true;
    store.emit("library");
    return store.lib;
  },

  item(key) { return store.lib.items[key] || null; },
  project(id) { return store.lib.projects.find((p) => p.id === id) || null; },
  items({ trashed = false } = {}) { return Object.values(store.lib.items).filter((it) => !!it.trashed === trashed); },
  childrenOf(id) { return store.lib.projects.filter((p) => (p.parent || null) === (id || null)); },
  // a project and all its descendants
  projectTree(id) { const out = [id]; for (let i = 0; i < out.length; i++) store.childrenOf(out[i]).forEach((c) => out.push(c.id)); return out; },
  markCounts(key, att) {
    const s = store.stats[key]; if (!s) return { question: 0, remark: 0, explain: 0, total: 0 };
    return (att ? s.perAttachment && s.perAttachment[att] : s.marks) || { question: 0, remark: 0, explain: 0, total: 0 };
  },
  primaryAtt(it) {
    if (!it || !it.attachments || !it.attachments.length) return null;
    return it.attachments.find((a) => a.key === it.primary) || it.attachments[0];
  },
  allTags(items) {
    const m = new Map();
    for (const it of items || store.items()) for (const t of it.tags || []) m.set(t, (m.get(t) || 0) + 1);
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0], undefined, { sensitivity: "base" }));
  },

  setItem(item) {
    if (!item || !item.key) return;
    store.lib.items[item.key] = item;
    store.emit("item", { key: item.key });
  },
  setItems(items) { (items || []).forEach((it) => { store.lib.items[it.key] = it; }); store.emit("library"); },

  // every change made through the store can be undone (⌘Z); "opened" bookkeeping is not an edit
  async patchItem(key, patch) {
    const before = store.item(key);
    const old = before ? Object.fromEntries(Object.keys(patch).map((k) => [k, clone(before[k] === undefined ? null : before[k])])) : null;
    const j = await api.patchItem(key, patch);
    store.setItem(j.item);
    if (old && Object.keys(patch).some((k) => k !== "opened")) {
      const what = "opened" in patch ? null : Object.keys(patch).join(", ");
      undoLog.record({ label: `the ${what} change to ${short(key)}`, undo: () => store.patchItem(key, old), redo: () => store.patchItem(key, patch) });
    }
    return j.item;
  },
  async bulk(body) {
    const pre = (body.keys || []).map((k) => store.item(k)).filter(Boolean).map(clone);
    const j = await api.bulk(body);
    store.setItems(j.items);
    if (undoLog.recording() && pre.length) {
      const inv = [], has = (arr, v) => (arr || []).includes(v);
      const keysWhere = (f) => pre.filter(f).map((i) => i.key);
      if (body.trash) inv.push({ keys: keysWhere((i) => !i.trashed), restore: true });
      if (body.restore) inv.push({ keys: keysWhere((i) => i.trashed), trash: true });
      for (const p of body.addProjects || []) inv.push({ keys: keysWhere((i) => !has(i.projects, p)), removeProjects: [p] });
      for (const p of body.removeProjects || []) inv.push({ keys: keysWhere((i) => has(i.projects, p)), addProjects: [p] });
      for (const t of body.addTags || []) inv.push({ keys: keysWhere((i) => !has(i.tags, t)), removeTags: [t] });
      for (const t of body.removeTags || []) inv.push({ keys: keysWhere((i) => has(i.tags, t)), addTags: [t] });
      if (body.read) for (const r of new Set(pre.map((i) => i.read || "unread"))) inv.push({ keys: keysWhere((i) => (i.read || "unread") === r), read: r });
      if (!inv.some((b) => b.keys.length)) return j.items;   // nothing changed: nothing to undo
      const n = pre.length, what = n === 1 ? short(pre[0].key) : `${n} papers`;
      const label = body.trash ? `moving ${what} to the Trash` : body.restore ? `restoring ${what}`
        : body.addProjects ? `adding ${what} to a project` : body.removeProjects ? `removing ${what} from a project`
        : body.addTags ? `tagging ${what}` : body.removeTags ? `removing a tag from ${what}` : `changing ${what}`;
      undoLog.record({ label, undo: async () => { for (const b of inv) if (b.keys.length) await store.bulk(b); }, redo: () => store.bulk(body) });
    }
    return j.items;
  },
  async createProject(name, parent) {
    const j = await api.createProject(name, parent); await withStartSections(j.project); store.lib.projects.push(j.project); store.emit("library");
    undoLog.record({ label: `creating “${name}”`, undo: () => store.deleteProject(j.project.id), redo: async () => { const k = await api.createProject(name, parent); await withStartSections(k.project); store.lib.projects.push(k.project); store.emit("library"); } });
    return j.project;
  },
  async renameProject(id, name) {
    const oldName = (store.project(id) || {}).name;
    const j = await api.patchProject(id, { name }); Object.assign(store.project(id), j.project); store.emit("library");
    undoLog.record({ label: `renaming “${oldName}”`, undo: () => store.renameProject(id, oldName), redo: () => store.renameProject(id, name) });
    return j.project;
  },
  // project sections + the order of papers inside them (see library.js "project sections")
  async setProjectLayout(id, layout) {
    const p = store.project(id); if (!p) return;
    const old = { sections: clone(p.sections || null), placement: clone(p.placement || null) };
    const j = await api.patchProject(id, layout); Object.assign(p, j.project); store.emit("layout", { id });
    undoLog.record({ label: "reordering the project", undo: () => store.setProjectLayout(id, { sections: old.sections || [], placement: old.placement || {} }), redo: () => store.setProjectLayout(id, layout) });
    return j.project;
  },
  async moveProject(id, parent) { const j = await api.patchProject(id, { parent }); Object.assign(store.project(id), j.project); store.emit("library"); return j.project; },
  async deleteProject(id) { await api.deleteProject(id); await store.load(); },
  async import(input, project) { const j = await api.import(input, project); await store.load(); store.emit("imported", j); return j; },
  async importFile(file, project) { const j = await api.importFile(file, project); await store.load(); store.emit("imported", j); return j; },
};

// a settings change made in another window (e.g. a paper opened in its own window) applies here too
window.addEventListener("storage", (ev) => {
  if (ev.key !== LS_SETTINGS || !ev.newValue) return;
  try { store.settings = deepMerge(SETTINGS_DEFAULTS, JSON.parse(ev.newValue)); } catch (_) { return; }
  store.emit("settings", { settings: store.settings, patch: null, remote: true });
});

// the reader reports new mark counts after each save; keep the library's numbers in step
store.on("marks-changed", ({ key, att, counts }) => {
  if (!key || !counts) return;
  const s = store.stats[key] || (store.stats[key] = { marks: { question: 0, remark: 0, explain: 0, total: 0 }, perAttachment: {}, hasNotes: false });
  s.perAttachment = s.perAttachment || {};
  s.perAttachment[att] = counts;
  const tot = { question: 0, remark: 0, explain: 0, total: 0 };
  for (const c of Object.values(s.perAttachment)) for (const [k, v] of Object.entries(c || {})) if (typeof v === "number") tot[k] = (tot[k] || 0) + v;
  s.marks = tot;
  store.emit("stats", { key });
});
