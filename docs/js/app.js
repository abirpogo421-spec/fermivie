// Shell: tab bar (across the top or down the left), hash routing, global keys, drag & drop import,
// settings, the ⌘K palette. See CONTRACT.md §4 and §10.
import { api } from "./api.js";
import { store } from "./store.js";
import * as ui from "./ui.js";
import "./marktypes.js";
import * as undoLog from "./undo.js";
import * as commands from "./commands.js";

pdfjsLib.GlobalWorkerOptions.workerSrc = "vendor/pdf.worker.min.js";
const { $, el, icon } = ui;
const docEl = document.documentElement;

/* ------------------------------------------------------------------ tabs state */
const LS_TABS = "pm2:tabs", LS_ACTIVE = "pm2:active", LS_ROUTE = "pm2:libroute";
const LS_VT_W = "pm2:vtabs-w", LS_VT_MIN = "pm2:vtabs-min";
// A window opened from a tab ("Open in New Window", or a tab dragged off the bar) keeps its own tabs
// in sessionStorage, so it never overwrites the main window's tabs.
const SOLO = new URLSearchParams(location.search).get("solo");
const TABSTORE = (() => { try { return SOLO ? sessionStorage : localStorage; } catch (_) { return null; } })();
// open tabs belong to one library: their keys go through api.lsKey (unchanged in server mode), so they
// are read once the back end is known (loadTabState, at boot)
const K = (name) => api.lsKey(name);
let tabs = [];                 // [{key, att}] reader tabs (Library and Settings are fixed, always first)
let active = "library";        // "library", "settings" or "key/att"
let lastLibRoute = "#/library";
let lastSettingsRoute = "#/settings";
const titles = new Map();      // "key/att" -> title set by the reader
const tabHistory = [];         // activation order, for "close returns to previous tab"
const closedTabs = [];         // for "Reopen closed tab"
let tabsLoaded = false;
function loadTabState() {
  // window.open copies the opener's sessionStorage into the new window, so a window opened from another
  // separate window would start with that window's tabs. Keep only what this window wrote itself.
  if (SOLO && TABSTORE) try { if (TABSTORE.getItem("pm2:solo") !== SOLO) { [LS_TABS, LS_ACTIVE, LS_ROUTE].forEach((k) => TABSTORE.removeItem(K(k))); TABSTORE.setItem("pm2:solo", SOLO); } } catch (_) {}
  try {
    tabs = JSON.parse((TABSTORE && TABSTORE.getItem(K(LS_TABS))) || "null") || null;
    if (!tabs && SOLO) { const [k, a] = SOLO.split("/"); tabs = k && a ? [{ key: k, att: a }] : []; }
    tabs = (tabs || []).filter((t) => t && t.key && t.att);
    lastLibRoute = (TABSTORE && TABSTORE.getItem(K(LS_ROUTE))) || "#/library";
  } catch (_) {}
  tabsLoaded = true;
}
const tid = (t) => t.key + "/" + t.att;
const isPaper = (id) => !!id && id !== "library" && id !== "settings";
const readHash = (key, att) => "#/read/" + encodeURIComponent(key) + "/" + encodeURIComponent(att);
const saveTabs = () => { if (!tabsLoaded) return; try { TABSTORE.setItem(K(LS_TABS), JSON.stringify(tabs)); TABSTORE.setItem(K(LS_ACTIVE), active); TABSTORE.setItem(K(LS_ROUTE), lastLibRoute); } catch (_) {} };
const lsGet = (k) => { try { return localStorage.getItem(k); } catch (_) { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (_) {} };
let vtMin = lsGet(LS_VT_MIN) === "1";
let vtW = ui.clamp(+lsGet(LS_VT_W) || 220, 160, 440);
// In a narrow window the side list shows icons only (so the reader's toolbar still fits), unless the
// user widens it again; that choice lasts until the window gets wide again.
const VT_NARROW = 900;
let vtOpenNarrow = false;
const narrowWin = () => innerWidth < VT_NARROW;
const vtIsMin = () => vtMin || (narrowWin() && !vtOpenNarrow);
const vtWidth = () => Math.min(vtW, Math.max(160, Math.round(innerWidth * 0.3)));

/* ------------------------------------------------------------------ settings on the page */
// theme / density / tab layout live on <html> as data attributes (base.css reads them)
function applyShellSettings() {
  const S = store.settings || {};
  if (S.theme === "light" || S.theme === "dark") docEl.dataset.theme = S.theme; else delete docEl.dataset.theme;
  docEl.dataset.density = S.density === "compact" ? "compact" : "comfortable";
  const layout = S.tabs === "vertical" ? "vertical" : "horizontal";
  if (docEl.dataset.tabs !== layout) { docEl.dataset.tabs = layout; renderTabs(); }
}
const vertical = () => docEl.dataset.tabs === "vertical";

/* ------------------------------------------------------------------ views */
const ctx = {
  store, api, ui, commands,
  openReader: (key, att, opts) => openReader(key, att, opts),
  openLibrary: (route) => go(routeToHash(route || { name: "library", filter: "all" })),
  setTitle: (key, att, title) => { titles.set(key + "/" + att, title); renderTabs(); },
  // §10.2 additions
  tabs: () => tabs.map((t) => ({ key: t.key, att: t.att, title: titles.get(tid(t)) || (store.item(t.key) || {}).title || t.key, active: tid(t) === active })),
  activeTab: () => (isPaper(active) ? { key: active.split("/")[0], att: active.split("/")[1] } : { name: active }),
  openInNewWindow: (key, att) => openPaperInNewWindow(key, att),
  openSettings: (section) => go(section ? "#/settings/" + encodeURIComponent(section) : lastSettingsRoute),
  openPalette: (opts) => openPalette(opts),
  showShortcuts: () => showShortcuts(),
};
// The views are loaded dynamically so one broken module never takes the whole app down.
// Until they arrive each view is a silent stand-in (no "failed to load" text while it is only loading).
const noopView = () => ({ show() {}, hide() {}, route() {}, focusSearch() {}, currentProject: () => null, open: async () => {}, close() {}, hasUnsavedDraft: () => false, onKey: () => false });
const broken = (rootEl, name, err) => {
  rootEl.textContent = "";
  rootEl.append(el("div", "empty", `The ${name} failed to load: ${err && err.message ? err.message : err}`));
  return noopView();
};
// Settings has no section in index.html; give it one next to the other views
const settingsRoot = (() => {
  let s = $("view-settings");
  if (!s) { s = el("section", "view"); s.id = "view-settings"; s.setAttribute("aria-label", "Settings"); s.hidden = true; $("app").appendChild(s); }
  return s;
})();
let library = noopView(), reader = noopView();
let settingsView = noopView();
let settingsMod = null;
async function mountViews() {
  const [L, R, S] = await Promise.allSettled([import("./library.js"), import("./reader.js"), import("./settings.js")]);
  try { library = L.status === "fulfilled" ? L.value.mountLibrary($("view-library"), ctx) : broken($("view-library"), "library", L.reason); }
  catch (e) { console.error(e); library = broken($("view-library"), "library", e); }
  try { reader = R.status === "fulfilled" ? R.value.mountReader($("view-reader"), ctx) : broken($("view-reader"), "reader", R.reason); }
  catch (e) { console.error(e); reader = broken($("view-reader"), "reader", e); }
  try { settingsMod = S.status === "fulfilled" ? S.value : null; settingsView = settingsMod ? settingsMod.mountSettings(settingsRoot, ctx) : broken(settingsRoot, "settings", S.reason); }
  catch (e) { console.error(e); settingsView = broken(settingsRoot, "settings", e); }
}

/* ------------------------------------------------------------------ ⌘K palette (js/palette.js, optional) */
let palettePromise = null;
const loadPalette = () => palettePromise || (palettePromise = import("./palette.js").catch((e) => { console.error(e); palettePromise = null; return null; }));
async function openPalette(opts = {}) {
  const m = await loadPalette();
  if (m && typeof m.openPalette === "function") {
    try { m.openPalette(ctx, opts); return; } catch (e) { console.error(e); }
  }
  // no palette: fall back to the library's search field
  if (active !== "library") go(lastLibRoute);
  setTimeout(() => library.focusSearch(), 0);
}

/* ------------------------------------------------------------------ routing */
function routeToHash(r) {
  if (!r || r.name !== "library") return "#/library";
  if (r.filter === "project" && r.id) return "#/library/project/" + encodeURIComponent(r.id);
  if (r.filter && r.filter !== "all") return "#/library/" + r.filter;
  return "#/library";
}
function parseHash(hash) {
  const parts = (hash || "").replace(/^#\/?/, "").split("/").map((p) => { try { return decodeURIComponent(p); } catch (_) { return p; } });
  if (parts[0] === "read" && parts[1] && parts[2]) return { name: "read", key: parts[1], att: parts[2] };
  if (parts[0] === "settings") return { name: "settings", section: parts[1] || "" };
  if (parts[0] === "library") {
    if (parts[1] === "project" && parts[2]) return { name: "library", filter: "project", id: parts[2] };
    if (["unfiled", "recent", "marked", "trash"].includes(parts[1])) return { name: "library", filter: parts[1] };
  }
  return { name: "library", filter: "all" };
}
// opts.replace: change the current history entry instead of adding one (a version switch inside a tab)
function go(hash, opts = {}) {
  if (location.hash === hash) applyRoute();
  else if (opts.replace) { history.replaceState(null, "", hash); applyRoute(); }   // replaceState fires no hashchange
  else location.hash = hash;
}
function goTab(id) {
  if (id === "library") go(lastLibRoute);
  else if (id === "settings") go(lastSettingsRoute);
  else { const [k, a] = id.split("/"); go(readHash(k, a)); }
}

let routeHash = "";            // the hash the app is currently showing
let routeSeq = 0;
// Routes act only once the library is open (boot turns this on, then applies the address as it is then).
// Before that there is nothing to route to: an address change while the browser version's setup screen is
// up, or while the library is still loading, just waits, so no message comes from the empty app and the
// address is not rewritten.
let routing = false;
function showView(name) {
  if (name !== "reader") { reader.hide(); $("view-reader").hidden = true; }
  if (name !== "library") { library.hide(); $("view-library").hidden = true; }
  if (name !== "settings") { settingsView.hide(); settingsRoot.hidden = true; }
  const v = name === "reader" ? [reader, $("view-reader")] : name === "settings" ? [settingsView, settingsRoot] : [library, $("view-library")];
  v[1].hidden = false;
  v[0].show();
}
async function applyRoute() {
  if (!routing) return;
  const r = parseHash(location.hash);
  const seq = ++routeSeq;
  // switching to another paper would drop a mark the user is still typing: ask first
  if (r.name === "read" && isPaper(active) && r.key + "/" + r.att !== active && reader.hasUnsavedDraft()) {
    const ok = await ui.confirmDialog({ title: "Discard the unsaved mark?", message: "The note you were typing in this paper hasn't been saved.", ok: "Discard", danger: true });
    if (seq !== routeSeq) return;
    if (!ok) { history.replaceState(null, "", routeHash || lastLibRoute); renderTabs(); if (reader.focusDraft) reader.focusDraft(); return; }
  }
  // a menu or popover belongs to the view it was opened in: leaving that view closes it
  const nextActive = r.name === "read" ? r.key + "/" + r.att : r.name;
  if (nextActive !== active) { ui.closeMenus(); ui.closePopover(); }
  routeHash = location.hash;
  if (r.name === "read") {
    const it = store.item(r.key);
    if (!it || !(it.attachments || []).some((a) => a.key === r.att)) { ui.toast("That PDF isn't in the library any more.", { error: true }); go(lastLibRoute); return; }
    if (!tabs.some((t) => t.key === r.key && t.att === r.att)) { tabs.push({ key: r.key, att: r.att }); }
    activate(r.key + "/" + r.att);
    showView("reader");
    try { await reader.open(r.key, r.att); } catch (e) { console.error(e); ui.toast("Couldn't open this PDF: " + e.message, { error: true }); }
  } else if (r.name === "settings") {
    lastSettingsRoute = r.section ? "#/settings/" + encodeURIComponent(r.section) : "#/settings";
    activate("settings");
    showView("settings");
    settingsView.route(r.section || "general");
  } else {
    lastLibRoute = routeToHash(r);
    activate("library");
    showView("library");
    library.route(r);
  }
  saveTabs();
}
function activate(id) {
  active = id;
  const i = tabHistory.indexOf(id); if (i >= 0) tabHistory.splice(i, 1);
  tabHistory.push(id);
  renderTabs();
}

function openReader(key, att, opts = {}) {
  const it = store.item(key); if (!it) return;
  att = att || (store.primaryAtt(it) || {}).key;
  if (!att) { ui.toast("This paper has no PDF yet. Add one in its Attachments section."); return; }
  // switch version inside the current tab: that replaces the history entry too, so Back doesn't
  // bring the old version back as a second tab. (Asked for while another view is showing, it opens normally.)
  let inPlace = false;
  if (opts.replace && isPaper(active)) {
    const cur = tabs.find((t) => tid(t) === active);
    if (cur && cur.key === key) {
      inPlace = true;
      const dup = tabs.find((t) => t.key === key && t.att === att && t !== cur);
      if (dup) tabs = tabs.filter((t) => t !== cur); else { closeInReader(cur.key, cur.att); cur.att = att; }
    }
  }
  // the tab itself is added by applyRoute, after any 'discard the unsaved mark?' question, so Cancel leaves no stray tab
  saveTabs();
  go(readHash(key, att), { replace: inPlace });
}

// the reader forgets a closed tab's state; if that throws, the tab still closes (and the tab list is saved)
const closeInReader = (key, att) => { try { reader.close(key, att); } catch (e) { console.error(e); } };
async function closeTab(id, opts = {}) {
  const t = tabs.find((x) => tid(x) === id); if (!t) return;
  if (!opts.force && id === active && reader.hasUnsavedDraft()) {
    const ok = await ui.confirmDialog({ title: "Discard the unsaved mark?", message: "The note you were typing hasn't been saved.", ok: "Discard", danger: true });
    if (!ok) return;
  }
  const idx = tabs.indexOf(t);
  if (idx < 0) return;
  tabs.splice(idx, 1);
  if (!opts.moved) { closedTabs.push({ key: t.key, att: t.att, idx }); if (closedTabs.length > 20) closedTabs.shift(); }
  closeInReader(t.key, t.att);
  titles.delete(id);
  const hi = tabHistory.indexOf(id); if (hi >= 0) tabHistory.splice(hi, 1);
  saveTabs();
  if (id === active) {
    const prev = [...tabHistory].reverse().find((h) => !isPaper(h) || tabs.some((x) => tid(x) === h));
    goTab(prev || "library");
  } else renderTabs();
}
function reopenClosedTab() {
  while (closedTabs.length) {
    const c = closedTabs.pop(), it = store.item(c.key);
    if (!it || it.trashed || !(it.attachments || []).some((a) => a.key === c.att)) continue;
    if (!tabs.some((t) => t.key === c.key && t.att === c.att)) { tabs.splice(Math.min(c.idx, tabs.length), 0, { key: c.key, att: c.att }); saveTabs(); }
    go(readHash(c.key, c.att));
    return;
  }
  ui.toast("No closed tabs to reopen.");
}
function closeTabs(ids) { ids.forEach((x) => closeTab(x)); }

// Give a tab its own browser window (which can then go to another screen)
function popupWindow(id, key, att) {
  const url = location.origin + location.pathname + "?solo=" + encodeURIComponent(id) + readHash(key, att);
  const w = Math.min(1280, screen.availWidth - 80), h = Math.min(900, screen.availHeight - 80);
  const win = window.open(url, "pm2-" + id.replace(/[^\w-]/g, "_"), `popup=yes,width=${w},height=${h},left=${(screen.availLeft || 0) + 60},top=${(screen.availTop || 0) + 40}`);
  if (!win) ui.toast(api.mode === "browser" ? "The browser blocked the new window. Allow pop-ups for this site." : "The browser blocked the new window. Allow pop-ups for localhost.", { error: true });
  return !!win;
}
async function openInNewWindow(id) {
  const t = tabs.find((x) => tid(x) === id); if (!t) return;
  if (id === active && reader.hasUnsavedDraft()) {
    const ok = await ui.confirmDialog({ title: "Move the tab with an unsaved mark?", message: "The note you were typing hasn't been saved; it won't come along.", ok: "Move Anyway" });
    if (!ok) return;
  }
  if (popupWindow(id, t.key, t.att)) await closeTab(id, { force: true, moved: true });
}
// from the palette (⌘↵): a paper that is open here moves; any other paper just opens in its own window
function openPaperInNewWindow(key, att) {
  const it = store.item(key); if (!it) return;
  att = att || (store.primaryAtt(it) || {}).key;
  if (!att) { ui.toast("This paper has no PDF yet. Add one in its Attachments section."); return; }
  const id = key + "/" + att;
  if (tabs.some((t) => tid(t) === id)) return openInNewWindow(id);
  popupWindow(id, key, att);
}

/* ------------------------------------------------------------------ tab bar (top) / tab list (left) */
let texPlain = (x) => x;   // from library.js once it has loaded (WTe$_2$ -> WTe₂)
import("./library.js").then((m) => { if (m.texPlain) { texPlain = m.texPlain; renderTabs(); } }).catch(() => {});
function tabTitle(t) {
  const it = store.item(t.key);
  const base = texPlain(titles.get(tid(t)) || (it ? it.title : t.key) || "Untitled");
  let s = ui.shortTitle(base, 34);
  if (it && (it.attachments || []).length > 1) {
    const a = it.attachments.find((x) => x.key === t.att);
    if (a && a.label) s += " · " + ui.shortTitle(a.label, 14);
  }
  return s;
}
// the version's label when the paper has more than one PDF (else "")
function tabVer(t) {
  const it = store.item(t.key); if (!it || (it.attachments || []).length < 2) return "";
  const a = it.attachments.find((x) => x.key === t.att);
  return (a && (a.label || a.key)) || "";
}
// "v8 diff vs v7 (J# = …)" -> "v8 diff vs v7"
const verShort = (ver, n) => ui.shortTitle(ver.replace(/\s*\(.*$/, "") || ver, n);
// second line in the side list: version (when there are several), authors, year
function tabSub(t) {
  const it = store.item(t.key); if (!it) return "";
  const a = (it.attachments || []).find((x) => x.key === t.att);
  const parts = [];
  if ((it.attachments || []).length > 1 && a && a.label) parts.push(verShort(a.label, 24));
  const who = ui.authorsShort(it.authors);
  if (who) parts.push(who + (it.year ? " " + it.year : ""));
  else if (it.year) parts.push(String(it.year));
  return parts.join(" · ") || (a && a.label) || "";
}
const gear = () => icon("gear");

function fixedTab(kind) {
  const isLib = kind === "library", v = vertical();
  const b = el("button", "tab tab--fixed tab--" + kind);
  b.setAttribute("role", "tab");
  b.setAttribute("aria-selected", String(active === kind));
  b.setAttribute("aria-label", isLib ? "Library" : "Settings");
  b.title = isLib ? "Library (⌥1)" : "Settings (⌘,)";
  b.append(isLib ? icon("library") : gear());
  if (isLib || v) b.append(el("span", "tab__label", isLib ? "Library" : "Settings"));
  b.onclick = () => goTab(kind);
  return b;
}

function paperTab(t, i) {
  const id = tid(t), it = store.item(t.key), v = vertical();
  const full = texPlain(titles.get(id) || (it ? it.title : t.key) || "Untitled");
  const b = el("div", "tab tab--paper");
  b.dataset.id = id;
  b.setAttribute("role", "tab"); b.tabIndex = 0;
  b.setAttribute("aria-selected", String(active === id));
  const ver = tabVer(t);
  b.title = full + (ver ? "\n" + ver : "") + (i < 8 ? `  (⌥${i + 2})` : "");
  b.append(icon("pdf"));
  if (v) {
    const txt = el("span", "tab__text");
    txt.append(el("span", "tab__label", full.replace(/\s+/g, " ").trim()));
    const sub = tabSub(t); if (sub) txt.append(el("span", "tab__sub", sub));
    b.append(txt);
  } else {
    // several versions of one paper: the version comes first so it never gets cut off
    const lab = el("span", "tab__label");
    if (ver) lab.append(el("span", "tab__ver", verShort(ver, 16)), " ");
    lab.append(ui.shortTitle(full, 34));
    b.append(lab);
  }
  const x = el("button", "tab__close"); x.title = "Close tab (⌥W)"; x.setAttribute("aria-label", "Close tab");
  x.append(icon("x"));
  x.onclick = (ev) => { ev.stopPropagation(); closeTab(id); };
  b.append(x);
  b.onclick = () => go(readHash(t.key, t.att));
  b.onkeydown = (ev) => {
    // Enter / Space on the × keep its own button behaviour (close)
    if ((ev.key === "Enter" || ev.key === " ") && ev.target === b) { ev.preventDefault(); b.onclick(); }
    else if (ev.key === "Delete" || ev.key === "Backspace") { ev.preventDefault(); closeTab(id); }
  };
  b.onauxclick = (ev) => { if (ev.button === 1) { ev.preventDefault(); closeTab(id); } };
  b.onmousedown = (ev) => { if (ev.button === 1) ev.preventDefault(); };   // no autoscroll on middle-click
  b.oncontextmenu = (ev) => {
    ev.preventDefault();
    const after = tabs.slice(i + 1).map(tid);
    ui.menu([
      { label: "Open in New Window", kbd: id === active ? "⌥⇧N" : "", action: () => openInNewWindow(id) },
      "-",
      { label: "Close Tab", kbd: id === active ? "⌥W" : "", action: () => closeTab(id) },
      { label: "Close Other Tabs", disabled: tabs.length < 2, action: () => closeTabs(tabs.filter((x) => tid(x) !== id).map(tid)) },
      { label: v ? "Close Tabs Below" : "Close Tabs to the Right", disabled: !after.length, action: () => closeTabs(after) },
      "-",
      { label: "Show in Library", action: () => { go("#/library"); store.emit("reveal", { keys: [t.key] }); } },
    ], { x: ev.clientX, y: ev.clientY });
  };
  b.draggable = true;
  b.addEventListener("dragstart", (ev) => { dragTab = { id, dropped: false }; ev.dataTransfer.setData("application/x-pm-tab", id); ev.dataTransfer.effectAllowed = "move"; b.classList.add("is-dragging"); });
  b.addEventListener("dragend", (ev) => {
    b.classList.remove("is-dragging"); clearTabDrop();
    const d = dragTab; dragTab = null;
    if (!d || d.dropped) return;
    // released outside this window: give the tab its own window
    const out = ev.clientX < 0 || ev.clientY < 0 || ev.clientX > innerWidth || ev.clientY > innerHeight || (ev.screenX === 0 && ev.screenY === 0);
    if (out) openInNewWindow(id);
  });
  return b;
}

function renderTabs() {
  const bar = $("tabbar"), v = vertical();
  const keepScroll = bar.querySelector(".tabbar__list") ? bar.querySelector(".tabbar__list")[v ? "scrollTop" : "scrollLeft"] : 0;
  const mini = v && vtIsMin();
  bar.className = "tabbar" + (v ? " tabbar--v" + (mini ? " is-min" : "") : "");
  bar.setAttribute("aria-orientation", v ? "vertical" : "horizontal");
  bar.style.width = v && !mini ? vtWidth() + "px" : "";
  bar.textContent = "";
  if (overflowRO) { overflowRO.disconnect(); overflowRO = null; }
  const search = el("button", v ? "tabbar__search" : "ibtn tabbar__searchbtn");
  search.title = "Search papers, marks, notes and commands (⌘K)";
  search.setAttribute("aria-label", "Search");
  search.append(icon("search"));
  if (v) search.append(el("span", "tabbar__searchlabel", "Search"), el("kbd", null, "⌘K"));
  search.onclick = () => openPalette();
  const list = el("div", "tabbar__list");
  list.append(fixedTab("library"), fixedTab("settings"));
  if (v && tabs.length) list.append(el("div", "tabbar__sep"));
  tabs.forEach((t, i) => list.append(paperTab(t, i)));
  if (v) {
    const foot = el("div", "tabbar__foot");
    const min = el("button", "ibtn");
    min.title = mini ? "Show titles" : "Narrow to icons";
    min.setAttribute("aria-label", min.title);
    min.append(icon(mini ? "chev-right" : "chev-left"));
    min.onclick = () => setVtMin(!mini);
    foot.append(min);
    const split = el("div", "tabbar__splitter");
    split.title = "Drag to resize, double-click to narrow";
    split.addEventListener("pointerdown", startVtResize);
    split.addEventListener("dblclick", () => setVtMin(!vtIsMin()));
    const top = el("div", "tabbar__top"); top.append(search);
    bar.append(top, list, foot, split);
  } else {
    // more tabs than fit: they shrink first, then the strip scrolls (mouse wheel too) and a
    // button lists them all
    const more = el("button", "ibtn tabbar__more");
    more.title = "All tabs"; more.setAttribute("aria-label", "All tabs"); more.hidden = true;
    more.append(icon("chev-down"));
    more.onclick = () => allTabsMenu(more);
    list.addEventListener("wheel", (ev) => {
      if (ev.ctrlKey || Math.abs(ev.deltaY) <= Math.abs(ev.deltaX) || list.scrollWidth <= list.clientWidth) return;
      ev.preventDefault();
      list.scrollLeft += ev.deltaY * (ev.deltaMode === 1 ? 16 : 1);
    }, { passive: false });
    bar.append(list, more, search);
    watchOverflow(list, more);
  }
  list[v ? "scrollTop" : "scrollLeft"] = keepScroll;
  const act = list.querySelector('[aria-selected="true"]');
  if (act && act.scrollIntoView) act.scrollIntoView({ block: "nearest", inline: "nearest" });
  const cur = tabs.find((t) => tid(t) === active);
  document.title = active === "settings" ? "Settings — Paper Marker" : cur ? tabTitle(cur) + " — Paper Marker" : "Paper Marker";
}
let overflowRO = null;
function watchOverflow(list, more) {
  const check = () => {
    const over = list.scrollWidth > list.clientWidth + 1;
    if (more.hidden === over) more.hidden = !over;
  };
  if (overflowRO) overflowRO.disconnect();
  if (window.ResizeObserver) { overflowRO = new ResizeObserver(check); overflowRO.observe(list); }
  check();
}
function allTabsMenu(anchor) {
  const items = [
    { label: "Library", checked: active === "library", kbd: "⌥1", action: () => goTab("library") },
    { label: "Settings", checked: active === "settings", kbd: "⌘,", action: () => goTab("settings") },
  ];
  if (tabs.length) items.push("-");
  tabs.forEach((t, i) => {
    const it = store.item(t.key), ver = tabVer(t);
    const full = texPlain(titles.get(tid(t)) || (it ? it.title : t.key) || "Untitled");
    items.push({ label: ver ? ui.shortTitle(full, 26) + " · " + verShort(ver, 16) : ui.shortTitle(full, 60), checked: tid(t) === active, kbd: i < 8 ? "⌥" + (i + 2) : "", action: () => goTab(tid(t)) });
  });
  ui.menu(items, anchor);
}
// Narrowing in a narrow window only undoes "widen it anyway"; elsewhere the choice is remembered.
function setVtMin(on) {
  if (on) { vtOpenNarrow = false; if (!narrowWin()) { vtMin = true; lsSet(LS_VT_MIN, "1"); } }
  else { vtMin = false; lsSet(LS_VT_MIN, "0"); vtOpenNarrow = narrowWin(); }
  renderTabs();
}
function startVtResize(ev) {
  if (ev.button !== 0 || vtIsMin()) return;
  ev.preventDefault();
  const bar = $("tabbar"), split = ev.currentTarget, x0 = ev.clientX, w0 = bar.offsetWidth;
  split.classList.add("dragging"); split.setPointerCapture(ev.pointerId);
  const move = (e) => {
    const w = w0 + e.clientX - x0;
    if (w < 110) { bar.classList.add("is-min-preview"); return; }
    bar.classList.remove("is-min-preview");
    vtW = ui.clamp(Math.round(w), 160, Math.max(160, Math.min(440, Math.round(innerWidth * 0.3)))); bar.style.width = vtW + "px";
  };
  vtDragging = true;
  const up = (e) => {
    split.removeEventListener("pointermove", move); split.removeEventListener("pointerup", up); split.removeEventListener("pointercancel", up);
    split.classList.remove("dragging");
    vtDragging = false;
    if (bar.classList.contains("is-min-preview")) { bar.classList.remove("is-min-preview"); setVtMin(true); return; }
    lsSet(LS_VT_W, String(vtW));
    refitNow();
  };
  split.addEventListener("pointermove", move); split.addEventListener("pointerup", up); split.addEventListener("pointercancel", up);
}

/* ------------------------------------------------------------------ keep the PDF fitted when its area changes */
// The reader refits on window "resize". Its area also changes when the tab layout switches, the side
// list is narrowed / widened / dragged, or the density changes; tell it then too.
let vtDragging = false, synthResize = false, readerBox = "";
function refitNow() {
  synthResize = true;
  try { window.dispatchEvent(new Event("resize")); } finally { synthResize = false; }
}
let wasNarrow = narrowWin();
window.addEventListener("resize", () => {
  if (synthResize) return;
  const n = narrowWin();
  if (!n) vtOpenNarrow = false;
  if (vertical()) {
    const bar = $("tabbar");
    if (n !== wasNarrow || bar.classList.contains("is-min") !== vtIsMin()) renderTabs();
    else if (!vtIsMin()) bar.style.width = vtWidth() + "px";
  }
  wasNarrow = n;
});
if (window.ResizeObserver) {
  new ResizeObserver((entries) => {
    const r = entries[entries.length - 1].contentRect;
    if (!r.width || !r.height) return;                     // hidden
    const box = Math.round(r.width) + "x" + Math.round(r.height);
    if (box === readerBox) return;
    const first = !readerBox; readerBox = box;
    if (first || vtDragging) return;
    refitNow();          // (after a real window resize this is a repeat, which the reader's debounce absorbs)
  }).observe($("view-reader"));
}

let dragTab = null;
const clearTabDrop = () => $("tabbar").querySelectorAll(".is-drop-before, .is-drop-after").forEach((x) => x.classList.remove("is-drop-before", "is-drop-after"));
function tabDropSpot(ev) {
  const all = [...$("tabbar").querySelectorAll(".tab--paper")], v = vertical();
  for (const [i, el_] of all.entries()) {
    const r = el_.getBoundingClientRect();
    if (v ? ev.clientY < r.top + r.height / 2 : ev.clientX < r.left + r.width / 2) return { i, el: el_, cls: "is-drop-before" };
  }
  return all.length ? { i: all.length, el: all[all.length - 1], cls: "is-drop-after" } : null;
}
$("tabbar").addEventListener("dragover", (ev) => {
  if (!dragTab) return;
  ev.preventDefault(); ev.dataTransfer.dropEffect = "move";
  clearTabDrop(); const s_ = tabDropSpot(ev); if (s_) s_.el.classList.add(s_.cls);
});
$("tabbar").addEventListener("dragleave", (ev) => { if (!$("tabbar").contains(ev.relatedTarget)) clearTabDrop(); });
$("tabbar").addEventListener("drop", (ev) => {
  if (!dragTab) return;
  ev.preventDefault(); dragTab.dropped = true;
  const s_ = tabDropSpot(ev); clearTabDrop(); if (!s_) return;
  const from = tabs.findIndex((t) => tid(t) === dragTab.id); if (from < 0) return;
  const [t] = tabs.splice(from, 1);
  tabs.splice(s_.i > from ? s_.i - 1 : s_.i, 0, t);
  saveTabs(); renderTabs();
});
// dropping a tab anywhere else in this window just cancels the move (no new window)
document.addEventListener("drop", () => { if (dragTab) dragTab.dropped = true; }, true);
document.addEventListener("dragover", (ev) => { if (dragTab) ev.preventDefault(); });

/* ------------------------------------------------------------------ global keys */
function stepTab(d) {
  const order = ["library", "settings", ...tabs.map(tid)];
  const i = Math.max(0, order.indexOf(active)), j = (i + d + order.length) % order.length;
  goTab(order[j]);
}
document.addEventListener("keydown", (ev) => {
  if (ev.defaultPrevented) return;
  const mod = ev.metaKey || ev.ctrlKey;
  const key = (ev.key || "").toLowerCase();
  const browserCmd = mod && !ev.altKey && (key === "p" || key === "s");   // print / save page: never the browser's
  // no back end yet (the browser version is still finding the library; its setup screen guards keys
  // itself while it is up): the app's shortcuts have nothing to act on
  if (!api.mode) { if (browserCmd) ev.preventDefault(); return; }
  if (document.querySelector("#overlay-root .scrim")) {   // a modal dialog (or the palette) owns the keyboard
    if (browserCmd) ev.preventDefault();
    return;
  }
  // an open menu owns the keyboard too: it handles arrows / Enter / Space / Esc itself (and prevents
  // their default); any other key just closes it, so nothing acts on the page behind it
  if (document.querySelector("#overlay-root .menu")) {
    if (browserCmd) ev.preventDefault();
    ev.stopImmediatePropagation();   // the views' own document listeners (e.g. the library's Delete) skip it too
    if (!["Shift", "Control", "Alt", "Meta"].includes(ev.key)) ui.closeMenus({ refocus: true });
    return;
  }
  const typing = ev.target.closest && ev.target.closest("input, textarea, select, [contenteditable='true']");
  // ⌘K search everything, ⌘P go to a paper (instead of printing), ⌘, settings — also while typing
  if (mod && !ev.altKey && !ev.shiftKey && key === "k") { ev.preventDefault(); openPalette(); return; }
  if (mod && !ev.altKey && !ev.shiftKey && key === "p") { ev.preventDefault(); openPalette({ filter: "papers" }); return; }
  if (mod && !ev.altKey && !ev.shiftKey && (ev.key === "," || ev.code === "Comma")) { ev.preventDefault(); ctx.openSettings(); return; }
  // ⌥1..9 tabs, ⌥W close, ⌥[ ⌥] prev/next (browser keeps ⌘W/⌘1/Ctrl+Tab for itself)
  if (ev.altKey && !mod) {
    const d = /^Digit([1-9])$/.exec(ev.code);
    if (d && !ev.shiftKey) {
      ev.preventDefault();
      const n = +d[1];
      if (n === 1) go(lastLibRoute);
      else if (tabs[n - 2]) go(readHash(tabs[n - 2].key, tabs[n - 2].att));
      return;
    }
    if (ev.shiftKey && ev.code === "KeyT") { ev.preventDefault(); reopenClosedTab(); return; }
    if (ev.shiftKey && ev.code === "KeyN" && isPaper(active)) { ev.preventDefault(); openInNewWindow(active); return; }
    if (!ev.shiftKey && ev.code === "KeyW" && isPaper(active)) { ev.preventDefault(); closeTab(active); return; }
    // (⌥⇧[ / ⌥⇧] type ” and ’ on a Mac: let them through)
    if (!ev.shiftKey && (ev.code === "BracketLeft" || ev.code === "BracketRight")) {
      ev.preventDefault();
      stepTab(ev.code === "BracketRight" ? 1 : -1);
      return;
    }
  }
  // ⌘Z / ⌘⇧Z (and ⌘Y): app-wide undo/redo; text fields keep the browser's own undo
  if (mod && !ev.altKey && !typing && (key === "z" || key === "y")) {
    ev.preventDefault();
    if (key === "y" || ev.shiftKey) undoLog.redo(); else undoLog.undo();
    return;
  }
  if (mod && !ev.altKey && key === "s") { ev.preventDefault(); ui.toast("Everything saves automatically."); return; }
  if (!typing && !mod && !ev.altKey && ev.key === "?") { ev.preventDefault(); showShortcuts(); return; }
  if (isPaper(active) && reader.onKey(ev)) return;
  if (active === "settings" && settingsView.onKey && settingsView.onKey(ev)) return;
  if (mod && !ev.altKey && !ev.shiftKey && key === "f" && active === "library") { ev.preventDefault(); library.focusSearch(); return; }
  if (!typing && !mod && !ev.altKey && ev.key === "/") {
    ev.preventDefault();
    if (active !== "library") go(lastLibRoute);
    setTimeout(() => library.focusSearch(), 0);
  }
});

window.addEventListener("beforeunload", (ev) => {
  if (reader.hasUnsavedDraft()) { ev.preventDefault(); ev.returnValue = ""; }
});

/* ------------------------------------------------------------------ ⌘V: paste papers in */
// Outside text fields, pasting a DOI / arXiv ID / link (one per line) or a copied PDF file adds it to the library.
const looksLikePaper = (t) => /^(https?:\/\/\S+|10\.\d{4,9}\/\S+|doi:\s*10\.\S+|arxiv:\s*\S+|\d{4}\.\d{4,5}(v\d+)?|[a-z-]+(\.[A-Z]{2})?\/\d{7}(v\d+)?)$/i.test(t.trim());
document.addEventListener("paste", async (ev) => {
  const t = ev.target;
  if (t && t.closest && t.closest("input, textarea, select, [contenteditable='true']")) return;
  if (document.querySelector("#overlay-root .scrim, #overlay-root .popover, #overlay-root .menu")) return;
  const dt = ev.clipboardData; if (!dt) return;
  const files = [...(dt.files || [])].filter((f) => f.type === "application/pdf" || /\.pdf$/i.test(f.name));
  if (files.length) { ev.preventDefault(); await importFiles(files, active === "library" ? library.currentProject() : null); return; }
  const lines = (dt.getData("text/plain") || "").split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  if (!lines.length) return;
  ev.preventDefault();
  const papers = lines.filter(looksLikePaper);
  // a list, a reference list or a .bib file: review it in the Add papers dialog
  if (ctx.bulkAdd && (lines.length > 1 || !papers.length)) {
    const { parseEntries } = await import("./bulkadd.js");
    if (parseEntries(lines.join("\n")).length) { if (active !== "library") go(lastLibRoute); ctx.bulkAdd(lines.join("\n")); return; }
  }
  if (!papers.length) { ui.toast("To add a paper, paste its DOI, arXiv ID or link.", { error: true }); return; }
  const project = active === "library" ? library.currentProject() : null;
  const keys = [];
  for (let i = 0; i < papers.length; i++) {
    ui.toast(papers.length > 1 ? `Adding ${i + 1} of ${papers.length}…` : `Adding ${papers[i]}…`, { ms: 60000 });
    try {
      const j = await store.import(papers[i], project);
      keys.push(j.item.key);
      if (j.duplicate) ui.toast("Already in your library.");
      else if ((j.warnings || []).length) ui.toast(j.warnings[0]);
    } catch (e) { ui.toast(`${papers[i]}: ${e.message}`, { error: true }); }
  }
  if (keys.length) { if (active !== "library") go(lastLibRoute); store.emit("reveal", { keys }); if (keys.length > 1) ui.toast(`Added ${keys.length} papers.`); }
});

/* ------------------------------------------------------------------ keyboard shortcuts sheet (?) */
// The list itself lives in settings.js (SHORTCUTS), shared with Settings > Keyboard shortcuts.
function showShortcuts() {
  ui.confirmDialog({ title: "Keyboard shortcuts", message: "", ok: "Done", cancel: "Close" });
  setTimeout(() => {
    const d = document.querySelector("#overlay-root .dialog"); if (!d) return;
    d.classList.add("dialog--keys");
    const tbl = settingsMod && settingsMod.shortcutsTable ? settingsMod.shortcutsTable() : el("p", null, "Shortcuts are listed in Settings.");
    d.querySelector("h2").after(tbl);
    const p = d.querySelector("p:not(.keys p)"); if (p && !p.textContent) p.remove();
    const c = [...d.querySelectorAll(".dialog__actions .btn")].find((b) => b.textContent === "Close"); if (c) c.remove();
  }, 0);
}

/* ------------------------------------------------------------------ drag & drop import */
let dragDepth = 0;
const hasFiles = (ev) => ev.dataTransfer && [...(ev.dataTransfer.types || [])].includes("Files");
window.addEventListener("dragenter", (ev) => {
  if (!hasFiles(ev)) return;
  ev.preventDefault();
  dragDepth++;
  const pid = active === "library" ? library.currentProject() : null;
  const p = pid && store.project(pid);
  $("dropzoneScope").textContent = p ? "They'll go into " + p.name + "." : "They'll go into My Library.";
  $("dropzone").hidden = false;
});
window.addEventListener("dragover", (ev) => { if (hasFiles(ev)) { ev.preventDefault(); ev.dataTransfer.dropEffect = "copy"; } });
window.addEventListener("dragleave", (ev) => { if (!hasFiles(ev)) return; dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $("dropzone").hidden = true; });
window.addEventListener("drop", async (ev) => {
  if (!hasFiles(ev)) return;
  ev.preventDefault();
  dragDepth = 0; $("dropzone").hidden = true;
  const all = [...ev.dataTransfer.files];
  const files = all.filter((f) => f.type === "application/pdf" || /\.pdf$/i.test(f.name));
  const lists = all.filter((f) => /\.(bib|txt|ris|md)$/i.test(f.name) || /^text\//.test(f.type));
  if (lists.length && ctx.bulkAdd) {   // a .bib file or a list of papers: review it, PDFs dropped with it included
    const text = (await Promise.all(lists.map((f) => f.text()))).join("\n");
    if (active !== "library") go(lastLibRoute);
    ctx.bulkAdd(text, files); return;
  }
  if (!files.length) { ui.toast("Drop PDFs, or a .bib or text file listing papers.", { error: true }); return; }
  const project = active === "library" ? library.currentProject() : null;
  await importFiles(files, project);
});
async function importFiles(files, project) {
  let dups = 0;
  const keys = [];
  for (let i = 0; i < files.length; i++) {
    ui.toast(files.length > 1 ? `Adding ${i + 1} of ${files.length}: ${files[i].name}` : `Adding ${files[i].name}…`, { ms: 60000 });
    try {
      const j = await store.importFile(files[i], project);
      keys.push(j.item.key);
      if (j.duplicate) { dups++; ui.toast(`${files[i].name} is already in your library.`); }
    } catch (e) { ui.toast(`${files[i].name}: ${e.message}`, { error: true }); }
  }
  if (keys.length) {
    if (active !== "library") go(lastLibRoute);
    store.emit("reveal", { keys, enrich: true });
    if (dups === keys.length) ui.toast(keys.length === 1 ? "That paper is already in your library." : "Those papers are already in your library.");
    else ui.toast(keys.length === 1 ? "Added." : `Added ${keys.length - dups} papers` + (dups ? ` (${dups} already in your library).` : "."));
  }
}
ctx.importFiles = importFiles;

/* ------------------------------------------------------------------ commands (for the ⌘K palette) */
const setSetting = (patch) => store.setSettings(patch).catch((e) => ui.toast("Couldn't save the setting: " + e.message, { error: true }));
const SETTING_SECTIONS = [["general", "General"], ["appearance", "Appearance"], ["reader", "Reader"], ["marking", "Marking"],
  ["library", "Library & import"], ["profile", "Profile"], ["marktypes", "Mark types"], ["keys", "Keyboard shortcuts"], ["about", "About"]];
function registerAppCommands() {
  const S = () => store.settings || {};
  const onPaper = () => isPaper(active);
  commands.registerAll([
    { id: "app.search", title: "Search everything", section: "App", keys: "⌘K", keywords: "find palette", run: () => openPalette() },
    { id: "go.paper", title: "Go to paper…", section: "Go to", keys: "⌘P", keywords: "open switch", run: () => openPalette({ filter: "papers" }) },
    { id: "go.library", title: "Go to Library", section: "Go to", keys: "⌥1", run: () => go(lastLibRoute) },
    { id: "go.settings", title: "Go to Settings", section: "Go to", keys: "⌘,", keywords: "preferences options", run: () => ctx.openSettings() },
    ...SETTING_SECTIONS.map(([id, label]) => ({ id: "go.settings." + id, title: "Settings: " + label, section: "Go to", keywords: "preferences", run: () => ctx.openSettings(id) })),
    { id: "app.next-tab", title: "Next tab", section: "App", keys: "⌥]", run: () => stepTab(1) },
    { id: "app.prev-tab", title: "Previous tab", section: "App", keys: "⌥[", run: () => stepTab(-1) },
    { id: "app.close-tab", title: "Close tab", section: "App", keys: "⌥W", when: onPaper, run: () => closeTab(active) },
    { id: "app.close-other-tabs", title: "Close other tabs", section: "App", when: () => tabs.length > 1, run: () => closeTabs(tabs.map(tid).filter((x) => x !== active)) },
    { id: "app.close-all-tabs", title: "Close all paper tabs", section: "App", when: () => tabs.length > 0, run: () => closeTabs(tabs.map(tid)) },
    { id: "app.reopen-tab", title: "Reopen closed tab", section: "App", keys: "⌥⇧T", when: () => closedTabs.length > 0, run: () => reopenClosedTab() },
    { id: "app.tab-window", title: "Open current tab in new window", section: "App", keys: "⌥⇧N", when: onPaper, run: () => openInNewWindow(active) },
    { id: "app.tabs-vertical", title: "Show tabs down the left side", section: "App", keywords: "toggle vertical horizontal tabs layout sidebar left", when: () => S().tabs !== "vertical", run: () => setSetting({ tabs: "vertical" }) },
    { id: "app.tabs-horizontal", title: "Show tabs across the top", section: "App", keywords: "toggle vertical horizontal tabs layout top", when: () => S().tabs === "vertical", run: () => setSetting({ tabs: "horizontal" }) },
    { id: "app.tabs-narrow", title: "Narrow the tab list to icons", section: "App", keywords: "collapse side tab list", when: () => vertical() && !vtIsMin(), run: () => setVtMin(true) },
    { id: "app.tabs-widen", title: "Show tab titles", section: "App", keywords: "expand side tab list", when: () => vertical() && vtIsMin(), run: () => setVtMin(false) },
    { id: "app.theme-system", title: "Theme: match the system", section: "App", keywords: "appearance auto", when: () => S().theme !== "system", run: () => setSetting({ theme: "system" }) },
    { id: "app.theme-light", title: "Theme: light", section: "App", keywords: "appearance", when: () => S().theme !== "light", run: () => setSetting({ theme: "light" }) },
    { id: "app.theme-dark", title: "Theme: dark", section: "App", keywords: "appearance night", when: () => S().theme !== "dark", run: () => setSetting({ theme: "dark" }) },
    { id: "app.density-compact", title: "Density: compact", section: "App", keywords: "appearance rows small", when: () => S().density !== "compact", run: () => setSetting({ density: "compact" }) },
    { id: "app.density-comfortable", title: "Density: comfortable", section: "App", keywords: "appearance rows", when: () => S().density === "compact", run: () => setSetting({ density: "comfortable" }) },
    { id: "app.undo", title: "Undo", section: "App", keys: "⌘Z", run: () => undoLog.undo() },
    { id: "app.redo", title: "Redo", section: "App", keys: "⌘⇧Z", run: () => undoLog.redo() },
    { id: "app.shortcuts", title: "Keyboard shortcuts", section: "App", keys: "?", keywords: "keys help", run: () => showShortcuts() },
  ]);
}
// one "Go to project" command per project, kept in step with the library
let offProjects = null;
function registerProjectCommands() {
  if (offProjects) offProjects();
  const name = (p) => { const parts = [p.name]; let q = p, n = 0; while (q.parent && (q = store.project(q.parent)) && n++ < 8) parts.unshift(q.name); return parts.join(" / "); };
  offProjects = commands.registerAll(store.lib.projects.map((p) => ({
    id: "go.project." + p.id, title: "Go to project: " + name(p), section: "Go to", keywords: "project folder",
    run: () => go("#/library/project/" + encodeURIComponent(p.id)),
  })));
}

/* ------------------------------------------------------------------ boot */
function bootFailed(e) {
  const v = $("view-library");
  v.textContent = "";
  const box = el("div", "empty", "Paper Marker couldn't open the library: " + (e && e.message ? e.message : e));
  // the browser version: a way to another library from here (no back end means no Settings page), which
  // forgets the remembered one and reloads to the setup screen, like Settings > About > Change Library…
  if (api.mode !== "server") {
    const b = ui.h("button", { class: "btn", type: "button" }, "Change Library…");
    b.addEventListener("click", async () => {
      b.disabled = true;
      try { const S = await import("./web/setup.js"); await S.forgetLibrary(); } catch (err) { console.warn(err); }
      location.reload();
    });
    const p = el("p"); p.append(b); box.append(p);
  }
  v.append(box);
  v.hidden = false;
}
window.addEventListener("hashchange", applyRoute);
store.on("item", ({ key }) => { if (tabs.some((t) => t.key === key)) renderTabs(); });
store.on("library", () => {
  // drop tabs whose paper or PDF disappeared
  const before = tabs.length;
  tabs = tabs.filter((t) => { const it = store.item(t.key); return it && (it.attachments || []).some((a) => a.key === t.att); });
  if (tabs.length !== before) { saveTabs(); if (isPaper(active) && !tabs.some((t) => tid(t) === active)) go(lastLibRoute); }
  renderTabs();
  try { registerProjectCommands(); } catch (e) { console.error(e); }
});
store.on("settings", applyShellSettings);
applyShellSettings();          // from the local copy, before the server answers (no flash of the wrong theme)
renderTabs();

(async function boot() {
  // the back end first (in the browser version this may show the setup screen and wait for the user)
  try { await api.ready(); }
  catch (e) { console.error(e); bootFailed(e); return; }
  loadTabState();
  renderTabs();
  await Promise.all([mountViews(), store.loadSettings()]);
  try { registerAppCommands(); } catch (e) { console.error(e); }
  try { await store.load(); }
  catch (e) { ui.toast(e.message, { error: true, ms: 10000 }); }
  if (!location.hash || location.hash === "#") {
    let a = SOLO || "library"; try { a = (TABSTORE && TABSTORE.getItem(K(LS_ACTIVE))) || a; } catch (_) {}
    const t = tabs.find((x) => tid(x) === a);
    history.replaceState(null, "", t ? readHash(t.key, t.att) : a === "settings" ? "#/settings" : lastLibRoute);
  }
  renderTabs();
  routing = true;
  applyRoute();
  // warm up the palette so the first ⌘K opens at once
  const idle = window.requestIdleCallback || ((f) => setTimeout(f, 300));
  idle(() => loadPalette());
})();
