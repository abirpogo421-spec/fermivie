// Settings tab (CONTRACT.md §10.3) and the one list of keyboard shortcuts (the "?" sheet shows it too).
//   mountSettings(rootEl, ctx) -> { show(), hide(), route(section), onKey(ev) }
import { store, SETTINGS_DEFAULTS } from "./store.js";
import * as ui from "./ui.js";
import { api } from "./api.js";
import * as commands from "./commands.js";
import * as mt from "./marktypes.js";

const { el, h } = ui;

/* ---------------------------------------------------------------- gear icon (now in ui.icon; kept for importers) */
export function gearIcon() { return ui.icon("gear"); }

export const SECTIONS = [
  ["general", "General"], ["appearance", "Appearance"], ["reader", "Reader"], ["marking", "Marking"],
  ["library", "Library & import"], ["profile", "Profile"], ["marktypes", "Mark types"], ["keys", "Keyboard shortcuts"], ["about", "About"],
];

/* ---------------------------------------------------------------- shortcuts (single source) */
export const SHORTCUTS = [
  { head: "Anywhere", rows: [
    ["⌘K", "Search everything: papers, marks, notes, projects, commands"],
    ["⌘P", "Go to a paper"],
    ["⌘,", "Settings"],
    ["⌘Z / ⌘⇧Z", "Undo / redo (marks, trash, projects, tags, edits)"],
    ["⌘V", "Paste a DOI, arXiv ID, link or PDF to add it"],
    ["⌥1 … ⌥9", "Library, then open tabs"],
    ["⌥[ / ⌥]", "Previous / next tab"],
    ["⌥W", "Close tab"],
    ["⌥⇧T", "Reopen the last closed tab"],
    ["⌥⇧N", "Move the current tab to a new window"],
    ["/", "Search the library"],
    ["?", "Keyboard shortcuts"],
  ] },
  { head: "Search (⌘K)", rows: [
    ["↑ ↓", "Move through the results"],
    ["↵", "Open"],
    ["⌘↵", "Open the paper in a new window"],
    ["⇥ / ⇧⇥", "Next / previous filter (All, Papers, Marks & notes, Projects, Commands)"],
    ["Esc", "Close"],
  ] },
  { head: "Library", rows: [
    ["↑ ↓, ⇧↑ ⇧↓", "Move / extend selection"], ["⌘A", "Select all"], ["↵", "Open"],
    ["⌘C", "Copy BibTeX of the selected papers"], ["⌘⇧C", "Copy citations"], ["⌫", "Move to Trash"],
    ["⌥↑ / ⌥↓", "Move up / down in the project's order"], ["⌘F", "Search"],
  ] },
  { head: "Reader", rows: [
    ["`", "Annotate on / off"], ["Esc", "Back to Select, close the note"], ["⌘C", "Copy selected text, or the open mark"],
    ["⌃1 … ⌃9", "Mark type while writing a note"], ["⌘↵", "Save the note"], ["⌘+ / ⌘− / ⌘0", "Zoom in / out / fit width"],
    ["N", "Side panel"], ["⌘G / ⌘⇧G", "Next / previous find result"],
  ] },
];
const SECTION_OF = { "Go to": "Anywhere", App: "Anywhere", Library: "Library", Reader: "Reader", Marking: "Reader" };
const normKeys = (k) => String(k || "").replace(/\s+/g, "").toLowerCase();

// the static list plus every registered command that has a shortcut not listed yet
export function shortcutGroups() {
  const groups = SHORTCUTS.map((g) => ({ head: g.head, rows: g.rows.slice() }));
  // every single shortcut a static row covers: "⌥[ / ⌥]" -> ⌥[, ⌥]; "⌥1 … ⌥9" -> ⌥1 … ⌥9
  const tokens = (k) => {
    const out = new Set([normKeys(k)]);
    for (const part of String(k).split(/\s+\/\s+|\s+or\s+|,\s+/)) {
      out.add(normKeys(part));
      const m = /^(.*?)1\s*…\s*\1?9$/.exec(part.trim());
      if (m) for (let i = 1; i <= 9; i++) out.add(normKeys(m[1] + i));
    }
    return out;
  };
  // the one-key marking letters (Q, R, E, …) follow the mark types, so they are listed from them
  const reader = groups.find((g) => g.head === "Reader");
  if (reader && ((store.settings || {}).reader || {}).quickKeys !== false) {
    try { for (const [k, id] of mt.quickKeys()) reader.rows.push([k.toUpperCase(), `Mark the selected text: ${(mt.get(id) || {}).name || id}`]); } catch (_) {}
  }
  const seen = new Set(groups.flatMap((g) => g.rows.flatMap((r) => [...tokens(r[0])].map((t) => g.head + "|" + t))));
  let cmds = [];
  try { cmds = typeof commands.all === "function" ? commands.all() : commands.available(); } catch (_) {}
  for (const c of cmds) {
    if (!c.keys) continue;
    const head = SECTION_OF[c.section] || "Anywhere";
    const id = head + "|" + normKeys(c.keys);
    if (seen.has(id)) continue;
    seen.add(id);
    (groups.find((g) => g.head === head) || groups[0]).rows.push([c.keys, c.title]);
  }
  return groups;
}

export function shortcutsTable() {
  const tbl = el("div", "keys");
  for (const g of shortcutGroups()) {
    tbl.append(el("div", "keys__head", g.head));
    for (const [k, v] of g.rows) tbl.append(el("kbd", "keys__k", k), el("span", "keys__v", v));
  }
  return tbl;
}

/* ---------------------------------------------------------------- small plain controls */
let uid = 0;
function row(label, ...ctl) {
  const r = el("div", "st-row");
  r.append(el("div", "st-row__label", label), h("div", { class: "st-row__ctl" }, ...ctl));
  return r;
}
const hint = (text) => el("div", "st-hint", text);

function radios(value, options, onChange) {
  const name = "st-r" + (++uid);
  const box = el("div", "st-radios"); box.setAttribute("role", "radiogroup");
  for (const [v, label, sub] of options) {
    const inp = h("input", { type: "radio", name, value: v });
    inp.checked = v === value;
    inp.addEventListener("change", () => { if (inp.checked) onChange(v); });
    const lab = h("label", { class: "st-choice" }, inp, el("span", null, label));
    box.append(lab);
    if (sub) box.append(el("div", "st-hint st-hint--choice", sub));
  }
  return box;
}
function check(label, value, onChange, sub) {
  const inp = h("input", { type: "checkbox" });
  inp.checked = !!value;
  inp.addEventListener("change", () => onChange(inp.checked));
  const wrap = el("div", "st-checkwrap");
  wrap.append(h("label", { class: "st-choice" }, inp, el("span", null, label)));
  if (sub) wrap.append(el("div", "st-hint st-hint--choice", sub));
  return wrap;
}
function select(value, options, onChange) {
  const s = h("select", { class: "select st-select" });
  for (const [v, label] of options) s.append(h("option", { value: v }, label));
  if (!options.some((o) => o[0] === value)) s.append(h("option", { value }, value + " %"));
  s.value = value;
  s.addEventListener("change", () => onChange(s.value));
  return s;
}
// a short list of text values: each row has a remove button, an input below adds one
// (min: the list never goes below that many entries; the last ones have no remove button)
function listEditor(values, { placeholder, note, validate, onChange, min = 0 }) {
  const box = el("div", "st-list");
  const ul = el("div", "st-list__rows");
  values.forEach((v, i) => {
    const r = el("div", "st-list__row");
    r.append(el("span", "st-list__text", v));
    const n = note && note(v);
    if (n) r.append(el("span", "st-list__note", n));
    if (values.length > min) {
      const x = h("button", { class: "ibtn st-list__x", title: "Remove", "aria-label": "Remove " + v,
        onclick: () => onChange(values.filter((_, j) => j !== i)) }, ui.icon("x"));
      r.append(x);
    }
    ul.append(r);
  });
  if (!values.length) ul.append(el("div", "st-list__empty", "None."));
  const inp = h("input", { class: "input st-list__input", placeholder: placeholder || "" });
  const err = el("div", "st-list__err"); err.hidden = true;
  const add = () => {
    const v = inp.value.trim(); if (!v) return;
    if (values.includes(v)) { inp.select(); return; }
    const problem = validate && validate(v);
    if (problem) { err.textContent = problem; err.hidden = false; inp.select(); return; }
    onChange([...values, v]);
  };
  inp.addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); add(); } });
  inp.addEventListener("input", () => { err.hidden = true; });
  const addBtn = h("button", { class: "btn btn--small", onclick: add }, "Add");
  box.append(ul, h("div", { class: "st-list__add" }, inp, addBtn), err);
  return box;
}

/* ---------------------------------------------------------------- sections */
const ZOOMS = [["width", "Fit width"], ["page", "Fit page"], ["75", "75 %"], ["100", "100 %"], ["125", "125 %"], ["150", "150 %"], ["200", "200 %"]];

function sectionGeneral(S, save, ctx) {
  return [
    row("Tabs", radios(S.tabs, [
      ["horizontal", "Across the top"],
      ["vertical", "Down the left side", "Shows each paper's title and version. Drag its edge to resize it or narrow it to icons."],
    ], (v) => save({ tabs: v }))),
    row("Search", h("div", { class: "st-inline" },
      h("button", { class: "btn", onclick: () => ctx.openPalette && ctx.openPalette() }, "Open Search"), el("kbd", "st-kbd", "⌘K")),
      hint("Finds papers, marks, notes, projects and commands. ⌘P searches papers only.")),
  ];
}
function sectionAppearance(S, save) {
  return [
    row("Theme", radios(S.theme, [["system", "Match the system"], ["light", "Light"], ["dark", "Dark"]], (v) => save({ theme: v }))),
    row("Density", radios(S.density, [["comfortable", "Comfortable"], ["compact", "Compact", "Shorter rows, tabs and toolbars."]], (v) => save({ density: v }))),
  ];
}
function sectionReader(S, save) {
  const r = S.reader || {};
  const set = (k) => (v) => save({ reader: { [k]: v } });
  return [
    row("Zoom for a new paper", select(String(r.defaultZoom || "width"), ZOOMS, set("defaultZoom")),
      hint("Papers you have opened before keep their own zoom.")),
    row("Page colour", radios(r.pageTheme || "normal", [["normal", "Normal"], ["dim", "Dimmed"], ["dark", "Dark (inverted)"]], set("pageTheme"))),
    row("While reading",
      check("Show mark numbers on the page", r.showFlags !== false, set("showFlags")),
      check("Show mark buttons when text is selected", r.selectionToolbar !== false, set("selectionToolbar")),
      check("Mark selected text with one key", r.quickKeys !== false, set("quickKeys"), "Each mark type's letter (Q, R, E …) marks the selected text."),
      check("Smooth scrolling when jumping to a mark", r.smoothScroll !== false, set("smoothScroll"))),
  ];
}
function sectionMarking(S, save, ctx) {
  const m = S.marks || {};
  return [
    row("Deleting", check("Ask before deleting a mark", m.confirmDelete !== false, (v) => save({ marks: { confirmDelete: v } }))),
    row("Mark types", h("div", { class: "st-inline" },
      h("button", { class: "btn", onclick: () => ctx.openSettings && ctx.openSettings("marktypes") }, "Show Mark Types"))),
  ];
}
function sectionLibrary(S, save, ctx, rerender) {
  const L = S.library || {};
  const home = (store.about && store.about.home) || "~";
  const win = /^[A-Za-z]:|\\/.test(home);   // Windows paths: backslashes, any case
  const norm = (d) => (win ? d.replace(/\//g, "\\").toLowerCase() : d);
  const watching = new Set((((store.about || {}).watching) || []).map(norm));
  const known = !!(store.about && store.about.watching);
  const expand = (d) => norm(d.replace(/^~(?=[\\/]|$)/, home)).replace(/(.)[\\/]+$/, "$1");
  const importLib = async () => {
    const m = await import("./importlib.js");
    m.openImportLibrary({ onDone: (keys) => { location.hash = "#/library"; setTimeout(() => store.emit("reveal", { keys }), 0); } });
  };
  return [
    row("Import a library", h("button", { class: "btn", onclick: () => importLib().catch((e) => ui.toast(e.message, { error: true })) }, "Import Library…"),
      hint("From Zotero, Mendeley, EndNote, JabRef, Paperpile and others. Papers already in your library are not added twice.")),
    row("Default version", radios(L.preferJournal !== false ? "journal" : "arxiv", [
      ["journal", "Journal version", "When a paper is published, new imports open the journal PDF first."],
      ["arxiv", "arXiv version", "New imports open the arXiv PDF first. The journal PDF is still added if one is found."],
    ], (v) => save({ library: { preferJournal: v === "journal" } }))),
    row("No free PDF", check("Use the arXiv preprint when the journal's PDF can't be downloaded", L.preprintFallback !== false,
      (v) => save({ library: { preprintFallback: v } }),
      "For a paywalled paper, Paper Marker finds the arXiv version by title and authors and adds that.")),
    api.mode === "browser" ? watchFoldersWeb(rerender) : row("Folders to check", listEditor(L.watchDirs || [], {
      placeholder: "~/Downloads",
      note: (d) => (known && !watching.has(expand(d)) ? "Not found" : ""),
      validate: (d) => (/^(?:[/~]|[A-Za-z]:[\\/]|\\\\)/.test(d) ? "" : "Use a full folder path, such as ~/Downloads, /Volumes/Data/Papers or C:\\Users\\you\\Downloads."),
      onChange: (v) => save({ library: { watchDirs: v } }),
    }), hint("PDFs you download into these folders are added to the matching paper.")),
    // a project always has at least one section (the library keeps one too); an empty list saved
    // earlier means the default pair, so that is what shows
    row("New project sections", listEditor(L.newProjectSections && L.newProjectSections.length ? L.newProjectSections : SETTINGS_DEFAULTS.library.newProjectSections, {
      placeholder: "Section name", min: 1,
      onChange: (v) => save({ library: { newProjectSections: v } }),
    }), hint("Every new project starts with these sections.")),
  ];
}

async function markTypesMod() { try { return await import("./marktypes.js"); } catch (_) { return null; } }

function sectionMarkTypes(S, save, ctx, rerender) {
  const box = el("div", "st-types");
  markTypesMod().then((mt) => {
    if (!mt) { box.append(hint("Mark types couldn't be loaded.")); return; }
    for (const t of mt.all()) {
      const r = el("div", "st-type " + mt.cls(t.id));
      r.append(el("span", "sq"), el("span", "st-type__name tlabel", t.name), el("span", "st-type__purpose", t.hidden ? "Hidden" : (t.purpose || "")));
      box.append(r);
    }
  });
  const edit = h("button", { class: "btn", onclick: async () => { const mt = await markTypesMod(); if (mt) { await mt.openEditor(); rerender(); } } }, "Edit Mark Types…");
  return [
    row("Types", box, edit, hint("Rename types, change their colours, add your own, or hide ones you don't use.")),
  ];
}
function sectionKeys() {
  return [h("div", { class: "st-keys" }, shortcutsTable())];
}
/* ---------------------------------------------------------------- profile: the library in a folder you choose */
const when = (iso) => { if (!iso) return "never"; const d = new Date(iso); return isNaN(d) ? iso : d.toLocaleString([], { dateStyle: "medium", timeStyle: "short" }); };
async function chooseFolder(prompt) {
  try { const j = await api.profileAct("choose", { prompt }); return j.path || ""; }
  catch (e) { ui.toast(e.message, { error: true }); return ""; }
}
// load a profile folder into this library (asks first, says what was added)
export async function loadProfile(path, after) {
  let pv;
  try { pv = (await api.profileAct("preview", { path })).preview; } catch (e) { ui.toast(e.message, { error: true }); return false; }
  const ok = await ui.confirmDialog({ title: "Load this profile?",
    message: `${pv.papers} papers, ${pv.projects} projects and ${pv.marks} marks, saved ${when(pv.savedAt)}. Papers you already have aren't changed. The rest are added.` +
      (api.mode === "browser" ? "" : " This folder then becomes your profile folder."),
    ok: "Load profile" });
  if (!ok) return false;
  ui.toast("Loading your profile…", { ms: 120000 });
  try {
    const j = await api.profileAct("load", { path });
    const s = j.summary;
    await store.load(); await store.loadSettings?.();
    ui.toast(loadedText(s), { ms: 9000 });
    after && after();
    return true;
  } catch (e) { ui.toast(e.message, { error: true, ms: 9000 }); return false; }
}
const loadedText = (s) => `Loaded ${s.added} papers, ${s.projects} projects, ${s.marks} marks` + (s.skipped ? ` (${s.skipped} were already here)` : "") +
  ((s.missingPdfs || []).length ? `. ${s.missingPdfs.length} PDFs couldn't be restored: ${s.missingPdfs.slice(0, 3).join("; ")}` : ".");
function sectionProfile(S, save, ctx, rerender) {
  if (api.mode === "browser") return sectionProfileWeb(S, save, ctx, rerender);
  const box = el("div", "st-profile");
  box.append(hint("Your profile is a folder with a copy of your library and settings, including the PDFs. Paper Marker saves into it after every change. Load it on another computer or in a fresh copy of Paper Marker to get everything back. It can live on a synced drive, a USB stick or in a private GitHub repository."));
  const slot = el("div"); box.append(slot);
  const draw = (P) => {
    slot.textContent = "";
    const path = h("input", { class: "input st-path", placeholder: "~/Documents/Paper Marker profile", value: P.folder || "", spellcheck: false, "aria-label": "Profile folder" });
    const connect = async (folder, replace = false) => {
      if (!folder) return;
      try { draw((await api.profileAct("connect", { folder, replace })).profile); ui.toast("Profile folder connected and saved."); }
      catch (e) {
        if (e.status === 409 && e.payload && e.payload.preview) {
          if (await loadProfile(folder, () => refresh())) return;
          if (await ui.confirmDialog({ title: "Replace that profile?", message: "This folder already has a profile. Replacing it overwrites that profile with this library.", ok: "Replace", danger: true })) connect(folder, true);
        } else ui.toast(e.message, { error: true, ms: 8000 });
      }
    };
    const pick = h("button", { class: "btn", onclick: async () => { const f = await chooseFolder("Choose a folder for your Paper Marker profile"); if (f) connect(f); } }, P.folder ? "Change…" : "Choose folder…");
    const use = h("button", { class: "btn", onclick: () => connect(path.value.trim()) }, "Use this path");
    const state = P.folder
      ? el("div", "st-hint", (P.saving ? "Saving… " : "") + "Last saved " + when(P.lastSaved) + (P.lastError ? ". Problem: " + P.lastError : "") + (P.git && P.gitResult ? ". Git: " + P.gitResult : "") + "  ·  " + P.folder)
      : el("div", "st-hint", "Not connected yet.");
    const actions = h("div", { class: "st-inline" }, pick);
    if (P.folder) actions.append(
      h("button", { class: "btn", onclick: async () => { try { draw((await api.profileAct("save")).profile); ui.toast("Profile saved."); } catch (e) { ui.toast(e.message, { error: true }); } } }, "Save now"),
      h("button", { class: "btn", onclick: async () => { draw((await api.profileAct("disconnect")).profile); } }, "Disconnect"));
    slot.append(
      row("Profile folder", h("div", { class: "st-inline" }, path, use), actions, state),
      row("PDFs", check("Keep a copy of every PDF in the profile", P.includePdfs, async (v) => { await save({ profile: { includePdfs: v } }); refresh(); },
        "If this is off, loading the profile downloads the PDFs again from their sources.")),
      row("Git / GitHub", check("Commit each save with git", P.git, async (v) => { await save({ profile: { git: v } }); refresh(); },
        P.folder && !P.isGitRepo ? "This folder isn't a git repository. To use GitHub, make a private repository, clone it, and choose the cloned folder above." : "Works when the profile folder is a git repository, such as a clone of a private GitHub repo."),
        check("Also push after each commit", P.push, async (v) => { await save({ profile: { push: v } }); refresh(); }, "Sends each save to the repository's remote, using git's own sign-in on this computer.")),
      row("Load a profile", h("div", { class: "st-inline" },
        h("button", { class: "btn", onclick: async () => { const f = await chooseFolder("Choose the profile folder to load"); if (f) loadProfile(f, () => refresh()); } }, "Choose profile…")),
        hint("Adds the papers, marks, notes and projects from a profile folder that this library doesn't have. Nothing you already have is changed.")),
    );
  };
  const refresh = async () => { try { draw((await api.profile()).profile); } catch (e) { slot.textContent = ""; slot.append(hint("Couldn't read the profile status: " + e.message)); } };
  refresh();
  return [box];
}

function sectionAbout() {
  if (api.mode === "browser") return sectionAboutWeb();
  const a = store.about || {};
  const items = store.items(), trashed = store.items({ trashed: true });
  let pdfs = 0, marks = 0;
  for (const it of items) pdfs += (it.attachments || []).length;
  for (const s of Object.values(store.stats || {})) marks += ((s && s.marks) || {}).total || 0;
  const loc = a.library || "library/";
  const copy = h("button", { class: "btn btn--small", onclick: async () => { ui.toast((await ui.copyText(loc)) ? "Copied the library location." : "Couldn't copy."); } }, "Copy");
  const n = (x, one, many) => `${x.toLocaleString()} ${x === 1 ? one : many}`;
  return [
    row("Library", h("div", { class: "st-inline" }, el("code", "st-path", loc), copy),
      hint("Papers, marks and notes are plain files here. Settings are in settings.json.")),
    row("Contents", el("div", "st-plain num", [n(items.length, "paper", "papers"), n(pdfs, "PDF", "PDFs"), n(marks, "mark", "marks"),
      n(store.lib.projects.length, "project", "projects"), n(trashed.length, "paper in the Trash", "papers in the Trash")].join(" · "))),
    row("Version", el("div", "st-plain", "Paper Marker " + (a.version || "2") + (a.port ? ` · localhost:${a.port}` : ""))),
  ];
}

/* ---------------------------------------------------------------- the browser version (WEB_CONTRACT §6.5, §8)
   Folders are handles the browser granted, not paths; git needs the downloadable version. */
const canOpenFolders = () => typeof window.showDirectoryPicker === "function";
const isCancel = (e) => e && (e.name === "AbortError" || (e.payload && e.payload.cancelled));
// Library & import > Folders to check: the folders this browser was allowed to read
function watchFoldersWeb(rerender) {
  const names = ((store.about || {}).watching) || [];
  const act = async (name, body) => {
    try { const j = await api.profileAct(name, body); if (!(j && j.cancelled)) await store.loadSettings(); }
    catch (e) { if (!isCancel(e)) ui.toast(e.message, { error: true }); }
    rerender();
  };
  const box = el("div", "st-list");
  const rows = el("div", "st-list__rows");
  names.forEach((name, index) => {
    const r = el("div", "st-list__row");
    r.append(el("span", "st-list__text", name),
      h("button", { class: "btn btn--small", "aria-label": "Remove " + name, onclick: () => act("forgetWatch", { index, name }) }, "Remove"));
    rows.append(r);
  });
  if (!names.length) rows.append(el("div", "st-list__empty", "None."));
  box.append(rows);
  if (!canOpenFolders()) return row("Folders to check", box, hint("This browser can't open folders. After Get journal PDF, choose the downloaded PDF instead."));
  box.append(h("div", { class: "st-list__add" }, h("button", { class: "btn btn--small", onclick: () => act("watchFolder", {}) }, "Choose Folder…")));
  return row("Folders to check", box, hint("PDFs you download into these folders are added to the matching paper."));
}

// Profile: a connected folder (Chrome, Edge, Arc), a zip download, and loading either back
function sectionProfileWeb(S, save, ctx, rerender) {
  const box = el("div", "st-profile");
  box.append(hint("Your profile is a copy of your library and settings, including the PDFs. You can load it in another browser, on another computer or in the downloadable version of Paper Marker."));
  const slot = el("div"); box.append(slot);
  const refresh = async () => { try { draw((await api.profile()).profile || {}); } catch (e) { slot.textContent = ""; slot.append(hint("Couldn't read the profile status: " + e.message)); } };
  const connect = async (folder, replace = false) => {
    try { draw((await api.profileAct("connect", { folder, replace })).profile); ui.toast("Profile folder connected and saved."); }
    catch (e) {
      if (e.status === 409 && e.payload && e.payload.preview) {
        if (await loadProfile(folder, () => refresh())) return;
        if (await ui.confirmDialog({ title: "Replace that profile?", message: "This folder already has a profile. Replacing it overwrites that profile with this library.", ok: "Replace", danger: true })) connect(folder, true);
      } else ui.toast(e.message, { error: true, ms: 8000 });
    }
  };
  const exportZip = async () => {
    ui.toast("Making the zip…", { ms: 120000 });
    try { await api.profileAct("exportZip"); ui.toast("Downloaded the profile zip."); }
    catch (e) { ui.toast(e.message, { error: true, ms: 8000 }); }
  };
  const importZip = async () => {
    const file = await pickFile(".zip,application/zip");
    if (!file) return;
    ui.toast("Loading " + file.name + "…", { ms: 120000 });
    try {
      const j = await api.profileAct("importZip", { file });
      await store.load(); await store.loadSettings();
      ui.toast(j && j.summary ? loadedText(j.summary) : "Loaded " + file.name + ".", { ms: 9000 });
      refresh();
    } catch (e) { ui.toast(e.message, { error: true, ms: 9000 }); }
  };
  const loadMenu = (anchor) => ui.menu([
    { label: "Profile Folder…", action: async () => { const f = await chooseFolder("Choose the profile folder to load"); if (f) loadProfile(f, () => refresh()); } },
    { label: "Zip File…", action: importZip },
  ], anchor);
  const draw = (P) => {
    slot.textContent = "";
    const name = P.name || (/^handle:/.test(P.folder || "") ? "" : P.folder || "");
    const folderRow = canOpenFolders()
      ? (() => {
        const actions = h("div", { class: "st-inline" },
          h("button", { class: "btn", onclick: async () => { const f = await chooseFolder("Choose a folder for your Paper Marker profile"); if (f) connect(f); } }, P.folder ? "Change…" : "Choose Folder…"));
        if (P.folder) actions.append(
          h("button", { class: "btn", onclick: async () => { try { draw((await api.profileAct("save")).profile); ui.toast("Profile saved."); } catch (e) { ui.toast(e.message, { error: true }); } } }, "Save Now"),
          h("button", { class: "btn", onclick: async () => { try { draw((await api.profileAct("disconnect")).profile); } catch (e) { ui.toast(e.message, { error: true }); } } }, "Disconnect"));
        const state = P.folder
          ? hint((P.saving ? "Saving… " : "") + "Last saved " + when(P.lastSaved) + (P.lastError ? ". Problem: " + P.lastError : "") + (name ? "  ·  " + name : ""))
          : hint("Not connected yet. Once connected, Paper Marker saves into the folder after every change.");
        return row("Profile folder", actions, state);
      })()
      : row("Profile folder", hint("This browser can't save into folders. Use Download Profile instead."));
    const loadBtn = h("button", { class: "btn" }, "Load Profile or Zip…");
    loadBtn.addEventListener("click", () => loadMenu(loadBtn));
    slot.append(
      folderRow,
      row("Download", h("div", { class: "st-inline" }, h("button", { class: "btn", onclick: exportZip }, "Download Profile (.zip)")),
        hint("The whole profile in one zip file. Load Profile or Zip brings it back here or in another browser.")),
      row("PDFs", check("Keep a copy of every PDF in the profile", P.includePdfs !== false, async (v) => { await save({ profile: { includePdfs: v } }); refresh(); },
        "If this is off, loading the profile downloads the PDFs again from their sources.")),
      row("Load a profile", h("div", { class: "st-inline" }, loadBtn),
        hint("Adds the papers, marks, notes and projects from a profile folder or zip that this library doesn't have. Nothing you already have is changed.")),
      row("Git / GitHub", hint("Committing each save with git needs the downloadable version of Paper Marker.")),
    );
  };
  refresh();
  return [box];
}
// <input type=file> for one file; null when cancelled
function pickFile(accept) {
  return new Promise((resolve) => {
    const inp = h("input", { type: "file", accept, hidden: true });
    const done = (v) => { inp.remove(); resolve(v); };
    inp.addEventListener("change", () => done((inp.files && inp.files[0]) || null));
    inp.addEventListener("cancel", () => done(null));
    document.body.append(inp);
    inp.click();
  });
}

// About: where the library is, and Change Library…
function sectionAboutWeb() {
  const a = store.about || {};
  const items = store.items(), trashed = store.items({ trashed: true });
  let pdfs = 0, marks = 0;
  for (const it of items) pdfs += (it.attachments || []).length;
  for (const s of Object.values(store.stats || {})) marks += ((s && s.marks) || {}).total || 0;
  const n = (x, one, many) => `${x.toLocaleString()} ${x === 1 ? one : many}`;
  const folder = a.storage === "folder";
  const where = folder ? `The folder “${a.library || "library"}”` : "This browser's storage for this site";
  const change = h("button", { class: "btn btn--small", onclick: async () => {
    try { await api.profileAct("changeLibrary"); } catch (e) { ui.toast(e.message, { error: true }); }
  } }, "Change Library…");
  return [
    row("Library", h("div", { class: "st-inline" }, el("span", "st-plain", where), change),
      hint(folder ? "Papers, marks and notes are plain files in this folder. Settings are in settings.json."
        : "Stored by this browser for this site. Download a copy from Settings > Profile now and then." +
          (a.persisted === false ? " The browser may clear it if the computer runs low on space." : ""))),
    row("Contents", el("div", "st-plain num", [n(items.length, "paper", "papers"), n(pdfs, "PDF", "PDFs"), n(marks, "mark", "marks"),
      n(store.lib.projects.length, "project", "projects"), n(trashed.length, "paper in the Trash", "papers in the Trash")].join(" · "))),
    row("Version", el("div", "st-plain", "Paper Marker " + (a.version || "2.3 (web)"))),
  ];
}
const BUILD = { general: sectionGeneral, appearance: sectionAppearance, reader: sectionReader, marking: sectionMarking,
  library: sectionLibrary, profile: sectionProfile, marktypes: sectionMarkTypes, keys: sectionKeys, about: sectionAbout };

/* ---------------------------------------------------------------- the view */
export function mountSettings(rootEl, ctx) {
  rootEl.textContent = "";
  const wrap = el("div", "st");
  const nav = el("nav", "st-nav"); nav.setAttribute("aria-label", "Settings sections");
  const pane = el("div", "st-pane");
  const head = el("div", "st-head");
  const title = el("h1", "st-title");
  const status = el("span", "st-status"); status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite");
  head.append(title, status);
  const body = el("div", "st-body");
  pane.append(head, body);
  wrap.append(nav, pane);
  rootEl.append(wrap);

  let section = "general", shown = false, selfSave = 0, statusT = 0;
  const navBtns = new Map();
  for (const [id, label] of SECTIONS) {
    const b = h("button", { class: "st-nav__item", "data-id": id, onclick: () => go(id) }, label);
    navBtns.set(id, b);
    nav.append(b);
  }
  nav.addEventListener("keydown", (ev) => {
    if (ev.key !== "ArrowDown" && ev.key !== "ArrowUp") return;
    ev.preventDefault();
    const ids = SECTIONS.map((x) => x[0]);
    const i = (ids.indexOf(section) + (ev.key === "ArrowDown" ? 1 : -1) + ids.length) % ids.length;
    go(ids[i], { focusNav: true });
  });
  const go = (id, o = {}) => {
    if (ctx.openSettings) ctx.openSettings(id); else route(id);
    if (o.focusNav) setTimeout(() => navBtns.get(id) && navBtns.get(id).focus(), 0);
  };

  function flash(text, error) {
    clearTimeout(statusT);
    status.textContent = text;
    status.classList.toggle("is-error", !!error);
    if (!error) statusT = setTimeout(() => { status.textContent = ""; }, 1600);
  }
  async function save(patch) {
    selfSave++;
    try { await store.setSettings(patch); flash("Saved"); }
    catch (e) { flash("Not saved: " + e.message, true); render(); }
    finally { selfSave--; }
    if (needsRender(patch)) render();
  }
  // lists and the watched-folder notes depend on the server's answer; plain radios/checkboxes don't
  const needsRender = (patch) => !!(patch && patch.library);

  function render() {
    const keepScroll = body.scrollTop;
    const label = (SECTIONS.find((x) => x[0] === section) || SECTIONS[0])[1];
    title.textContent = label;
    for (const [id, b] of navBtns) b.setAttribute("aria-current", String(id === section));
    body.textContent = "";
    const build = BUILD[section] || BUILD.general;
    const S = store.settings || {};
    let parts = [];
    try { parts = build(S, save, ctx, render); }
    catch (e) { console.error(e); parts = [el("div", "st-hint", "This section failed to load: " + e.message)]; }
    body.append(...parts);
    body.scrollTop = keepScroll;
  }
  function route(id) {
    const next = BUILD[id] ? id : "general";
    const changed = next !== section;
    section = next;
    render();
    if (changed) body.scrollTop = 0;
  }
  store.on("settings", ({ patch, failed } = {}) => { if (shown && (!selfSave || failed)) render(); });
  store.on("library", () => { if (shown && (section === "about" || section === "marktypes")) render(); });
  store.on("marktypes", () => { if (shown && section === "marktypes") render(); });

  return {
    show() { shown = true; if (!body.firstChild) render(); },
    hide() { shown = false; },
    route,
    section: () => section,
    onKey() { return false; },
  };
}
