// First-run / reconnect screen of the browser version (WEB_CONTRACT.md §8).
//   chooseStorage() -> {fs, libraryId, name, kind}
// Decides where the library lives: a folder the user picked (Chrome, Edge, Arc), or this browser's own
// storage (OPFS, else IndexedDB). A remembered folder whose permission is still granted, or a remembered
// browser-storage library, opens with no screen at all. Otherwise a plain full-window screen asks.
// Test switches (read once, never stored): ?storage=opfs|idb opens that browser storage directly;
// ?testfs=1 uses window.__PM_TEST_HANDLE__ as the picked folder.
import * as ui from "../ui.js";

const { el, h } = ui;
const QS = new URLSearchParams(location.search);
const TEST_FS = QS.get("testfs") === "1";
const TEST_STORAGE = ["opfs", "idb"].includes(QS.get("storage")) ? QS.get("storage") : "";
const BROWSER_NAME = "Browser storage";
const LIBRARY_FILE = "library.json";
const PROFILE_FILE = "paper-marker-profile.json";

/* ---------------------------------------------------------------- what this browser can do
   (local copies of the fs.js helpers of the same names, WEB_CONTRACT §5.1) */
export const supportsFolders = () => typeof window.showDirectoryPicker === "function";
export const supportsOpfsWritable = () => !!(navigator.storage && typeof navigator.storage.getDirectory === "function")
  && typeof FileSystemFileHandle === "function" && "createWritable" in FileSystemFileHandle.prototype;
export async function permissionOf(handle, mode = "readwrite") {
  try { return typeof handle.queryPermission === "function" ? await handle.queryPermission({ mode }) : "granted"; }
  catch (_) { return "denied"; }
}
export async function requestPermissionOf(handle, mode = "readwrite") {
  try { return typeof handle.requestPermission === "function" ? await handle.requestPermission({ mode }) : "granted"; }
  catch (_) { return "denied"; }
}

/* ---------------------------------------------------------------- handle memory
   IndexedDB database "pm-web", object store "handles", one record per slot (WEB_CONTRACT §5.1):
   library -> {kind, handle?, name, id, sub?}, profile -> {handle, name}, watch -> [{handle, name}].
   "folders" -> [{handle, id}] keeps each folder's library id, so a folder chosen again after
   Change Library gets its old id back (its tabs and unsynced marks are kept under that id). */
const DB = "pm-web", STORE = "handles";
function idbReq(r) { return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }
async function openMem(version) {
  const r = version ? indexedDB.open(DB, version) : indexedDB.open(DB);
  r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains(STORE)) r.result.createObjectStore(STORE); };
  const db = await idbReq(r);
  if (db.objectStoreNames.contains(STORE)) return db;
  const v = db.version + 1;      // the database exists without our store: add it
  db.close();
  return openMem(v);
}
async function withStore(mode, fn) {
  const db = await openMem();
  try {
    const tx = db.transaction(STORE, mode);
    const done = new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error); });
    done.catch(() => {});      // awaited below; this only keeps an early failure from being reported twice
    const out = await fn(tx.objectStore(STORE));
    await done;
    return out;
  } finally { db.close(); }
}
export async function memGet(slot) {
  try { return (await withStore("readonly", (s) => idbReq(s.get(slot)))) || null; }
  catch (e) { console.warn("pm-web handles:", e); return null; }
}
export const memSet = (slot, value) => withStore("readwrite", (s) => idbReq(s.put(value, slot)));
export const memDel = (slot) => withStore("readwrite", (s) => idbReq(s.delete(slot)));
// Change Library: forget where the library is (its files stay as they are)
export const forgetLibrary = () => memDel("library");

async function sameEntry(a, b) {
  try { return !!(a && b && typeof a.isSameEntry === "function" && await a.isSameEntry(b)); } catch (_) { return false; }
}
const newId = () => "f" + Array.from(crypto.getRandomValues(new Uint8Array(6)), (x) => x.toString(16).padStart(2, "0")).join("");
async function folderId(handle) {
  const known = (await memGet("folders")) || [];
  for (const k of known) if (await sameEntry(k.handle, handle)) return k.id;
  const id = newId();
  try { await memSet("folders", [{ handle, id }, ...known].slice(0, 30)); } catch (e) { console.warn(e); }
  return id;
}

/* ---------------------------------------------------------------- storage adapters (js/web/fs.js, zip.js)
   Assumed constructors (WEB_CONTRACT §5.1 names the classes, not their arguments; adjust here only):
   new DirFS(handle, {name, kind, readOnly}), new IdbFS(dbName, {name}), new ListFS(fileList), readZip(blob). */
let fsModP = null;
const fsMod = () => fsModP || (fsModP = import("./fs.js"));
async function folderFs(handle, { name, readOnly = false } = {}) {
  const F = await fsMod();
  return new F.DirFS(handle, { name: name || handle.name, kind: "folder", readOnly });
}
async function browserFs(kind) {
  const F = await fsMod();
  if (kind === "opfs") {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle("library", { create: true });
    return new F.DirFS(dir, { name: BROWSER_NAME, kind: "opfs" });
  }
  return new F.IdbFS("pm-web-library", { name: BROWSER_NAME, kind: "idb" });
}
async function listFs(files) { const F = await fsMod(); return new F.ListFS(files); }
// profile.openZip, not zip.js readZip: one oddly named entry (a\\b.txt, legal on a Mac) must not refuse the zip
async function zipFs(file) { const P = await import("./profile.js"); return P.openZip(file); }

/* ---------------------------------------------------------------- reading a picked folder (raw handle API) */
async function hasFile(dir, name) { try { await dir.getFileHandle(name); return true; } catch (_) { return false; } }
async function subDir(dir, name) { try { return await dir.getDirectoryHandle(name); } catch (_) { return null; } }
async function firstVisibleName(dir) {
  const it = typeof dir.keys === "function" ? dir.keys() : dir.entries();
  for await (const x of it) { const n = Array.isArray(x) ? x[0] : x; if (!String(n).startsWith(".")) return n; }
  return null;
}
// A Fermivie library: library.json, or (before its first paper) the four folders both apps make at once
// when they open a folder as a library (library_store.Library.__init__, js/web/store Library.init). Python's
// Library(root).load() opens such a folder as an empty library and writes nothing, so it is one here too.
const LIBRARY_DIRS = ["items", "projects", "history", "_deleted"];
async function isLibrary(dir) {
  if (await hasFile(dir, LIBRARY_FILE)) return true;
  for (const d of LIBRARY_DIRS) if (!(await subDir(dir, d))) return false;
  return true;
}
// a library here -> this folder; a library in library/ -> that subfolder; a profile; empty; or something else
async function classify(dir) {
  if (await isLibrary(dir)) return { type: "library", root: dir, sub: "" };
  const lib = await subDir(dir, "library");
  if (lib && await isLibrary(lib)) return { type: "library", root: lib, sub: "library" };
  if (await hasFile(dir, PROFILE_FILE)) return { type: "profile" };
  return (await firstVisibleName(dir)) == null ? { type: "empty", root: dir, sub: "" } : { type: "other" };
}

// One plain sentence for what went wrong (WEB_CONTRACT §8: errors are one sentence under the buttons).
// The browser's own errors and fs.js's FsError codes get our wording; any other message (fs.js, zip.js,
// profile.js and the store may say two sentences: the problem, then what to do) is cut to its first.
const SENTENCE_END = /[.!?]["'”’)]*$/;
export function firstSentence(text) {
  const t = String(text == null ? "" : text).replace(/\s+/g, " ").trim();
  let quoted = 0;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (c === "“") quoted++;
    else if (c === "”") quoted = Math.max(0, quoted - 1);
    else if (!quoted && (c === "." || c === "!" || c === "?") && t[i + 1] === " " && /[\p{Lu}\d“"'(]/u.test(t[i + 2] || "")) return t.slice(0, i + 1);
  }
  if (!t) return "Something went wrong.";
  return SENTENCE_END.test(t) ? t : t + ".";
}
export function problem(e, name) {
  const n = e && e.name, code = n === "FsError" ? e.code : "";
  if (n === "NotAllowedError" || n === "SecurityError" || code === "denied") return name ? `Fermivie wasn't allowed to open “${name}”.` : "Fermivie wasn't allowed to open that folder.";
  if (n === "NotFoundError" || code === "not-found") return name ? `Fermivie can't find “${name}”, which may have been moved or deleted.` : "That folder can't be found.";
  if (n === "QuotaExceededError" || code === "quota") return "The browser has no room left for the library.";
  // a folder that refuses writes (a read-only disk, a locked folder): fs.js says "being written right now"
  // for the browser's NoModificationAllowedError, which is wrong here, since nothing else is writing
  const cause = e && e.cause && e.cause.name;
  if (name && (n === "NoModificationAllowedError" || cause === "NoModificationAllowedError" || code === "read-only")) {
    return `Fermivie can't save changes in “${name}”, which may be on a read-only disk.`;
  }
  const msg = e && typeof e === "object" ? e.message : e;   // an Error with no message says nothing useful
  return firstSentence(typeof msg === "string" ? msg : "");
}
const cancelled = (e) => e && e.name === "AbortError";

/* ---------------------------------------------------------------- opening a library */
const warn = (e) => console.warn("Fermivie setup:", e);
const remember = (slot, value) => (TEST_FS ? Promise.resolve() : memSet(slot, value).catch(warn));
// this browser's own storage: OPFS where files can be written there, else IndexedDB (one library per site)
async function useBrowserStorage({ kind, persist = false } = {}) {
  let fs;
  if (kind) fs = await browserFs(kind);           // a remembered (or test) choice: that storage or an error, never another
  else if (supportsOpfsWritable()) {
    try { fs = await browserFs((kind = "opfs")); }
    catch (e) { warn(e); fs = await browserFs((kind = "idb")); }   // OPFS refused (some private windows)
  } else fs = await browserFs((kind = "idb"));
  if (persist) {
    try { if (navigator.storage && navigator.storage.persist && !(await navigator.storage.persisted())) await navigator.storage.persist(); }
    catch (_) {}
  }
  return { fs, libraryId: kind, name: BROWSER_NAME, kind };
}
const rememberBrowser = (st) => remember("library", { kind: st.kind, name: BROWSER_NAME, id: st.libraryId });

// a picked folder that is (or will now be) a library: `found` = {root, sub} from classify()
async function useFolder(picked, found) {
  const name = found.sub ? `${picked.name}/${found.sub}` : picked.name;
  const id = TEST_FS ? "testfs" : await folderId(picked);
  const fs = await folderFs(found.root, { name });
  await remember("library", { kind: "folder", handle: picked, name, id, sub: found.sub || "" });
  return { fs, libraryId: id, name, kind: "folder" };
}
async function openRemembered(saved) {
  const root = saved.sub ? await saved.handle.getDirectoryHandle(saved.sub) : saved.handle;
  await firstVisibleName(root);          // a folder that was moved or deleted fails here, not inside the app
  const id = saved.id || await folderId(saved.handle);
  const fs = await folderFs(root, { name: saved.name || root.name });
  return { fs, libraryId: id, name: saved.name || root.name, kind: "folder" };
}

// profiles (js/web/profile.js) and libraries read from elsewhere go into browser storage
async function loadInto(st, run) {
  const [S, P] = await Promise.all([import("./store/index.js"), import("./profile.js")]);
  const lib = new S.Library(st.fs, { libraryId: st.libraryId });
  return run(lib, P);
}
// a profile folder: its library opens in browser storage (merged into what is there), and the folder stays
// connected as the profile when the browser gave write access to it
async function useProfileFolder(dir) {
  const writable = (await permissionOf(dir, "readwrite")) === "granted";
  const src = await folderFs(dir, { readOnly: !writable });
  const st = await useBrowserStorage({ persist: true });
  const summary = await loadInto(st, (lib, P) => P.load(lib, src, { connect: writable }));
  await rememberBrowser(st);
  if (writable) await remember("profile", { handle: dir, name: dir.name });
  return { st, summary };
}
// Load Profile or Zip: any read-only source (profile or library folder, zip) merged into browser storage
async function useSource(src) {
  const st = await useBrowserStorage({ persist: true });
  const summary = await loadInto(st, (lib, P) => P.importSource(lib, src.fs));
  await rememberBrowser(st);
  return { st, summary };
}
// the same words as Settings > Profile uses after loading a profile
function summaryText(s) {
  if (!s || typeof s !== "object") return "";
  const miss = Array.isArray(s.missingPdfs) ? s.missingPdfs : [];
  return `Loaded ${s.added || 0} papers, ${s.projects || 0} projects, ${s.marks || 0} marks` + (s.skipped ? ` (${s.skipped} were already here)` : "") +
    (miss.length ? `. ${miss.length} PDFs couldn't be restored: ${miss.slice(0, 3).join("; ")}` : ".");
}

/* ---------------------------------------------------------------- pickers */
function pickFolder() {
  if (TEST_FS && window.__PM_TEST_HANDLE__) return Promise.resolve(window.__PM_TEST_HANDLE__);
  return window.showDirectoryPicker({ id: "pm-library", mode: "readwrite", startIn: "documents" });
}
// <input type=file>: resolves with the chosen FileList, or null when the user cancels
function pickFiles({ directory = false, accept = "" } = {}) {
  return new Promise((resolve) => {
    const inp = h("input", { type: "file", hidden: true });
    if (directory) { inp.webkitdirectory = true; inp.setAttribute("webkitdirectory", ""); }
    if (accept) inp.accept = accept;
    const done = (v) => { inp.remove(); resolve(v); };
    inp.addEventListener("change", () => done(inp.files && inp.files.length ? inp.files : null));
    inp.addEventListener("cancel", () => done(null));
    document.body.append(inp);
    inp.click();
  });
}
async function chooseSourceFolder() {
  if (TEST_FS && window.__PM_TEST_HANDLE__) {
    const d = window.__PM_TEST_HANDLE__;
    return { fs: await folderFs(d, { readOnly: true }), name: d.name };
  }
  if (supportsFolders()) {
    const d = await window.showDirectoryPicker({ id: "pm-profile", mode: "read" });
    return { fs: await folderFs(d, { readOnly: true }), name: d.name };
  }
  const files = await pickFiles({ directory: true });
  if (!files) return null;
  const name = String((files[0] && files[0].webkitRelativePath) || "").split("/")[0] || "the folder";
  return { fs: await listFs(files), name };
}
async function chooseZip() {
  const files = await pickFiles({ accept: ".zip,application/zip" });
  if (!files) return null;
  return { fs: await zipFs(files[0]), name: files[0].name };
}

/* ---------------------------------------------------------------- the screen (#pm-setup)
   States (WEB_CONTRACT §8): 2 remembered folder needing permission again, 3 first visit with folder
   support, 4 first visit without it. States 1 and 5 open without a screen (chooseStorage). */
function runScreen({ saved = null, error = "", auto = null } = {}) {
  return new Promise((resolve) => {
    const app = document.getElementById("app");
    let root = document.getElementById("pm-setup");
    if (!root) {
      root = el("div");
      root.id = "pm-setup";
      document.body.insertBefore(root, document.getElementById("overlay-root"));
    }
    root.textContent = "";
    root.hidden = false;
    if (app) app.hidden = true;
    document.documentElement.removeAttribute("data-pm-booting");

    // while the screen is up the app behind it must not react to keys, drops or pastes (dialogs and
    // menus opened from the screen still get their keys)
    const guard = (ev) => {
      if (ev.type === "keydown" && document.querySelector("#overlay-root .scrim, #overlay-root .menu")) return;
      ev.stopImmediatePropagation();
      if (ev.type === "drop" || ev.type === "dragover") ev.preventDefault();
    };
    const GUARDED = ["keydown", "paste", "dragenter", "dragover", "dragleave", "drop"];
    GUARDED.forEach((t) => window.addEventListener(t, guard, true));

    const col = el("div", "pms");
    const title = el("h1", "pms__title"); title.append(el("span", "pms__wm", "Fermi"), "vie"); title.id = "pm-setup-title";
    root.setAttribute("role", "main"); root.setAttribute("aria-labelledby", title.id);
    const lede = el("p", "pms__lede");
    const choices = el("div", "pms__choices");
    const status = el("p", "pms__status"); status.setAttribute("role", "status"); status.hidden = true;
    const err = el("p", "pms__error"); err.setAttribute("role", "alert"); err.hidden = true;
    col.append(title, lede, choices, status, err);
    root.append(col);

    let finished = false;
    const finish = (result, note) => {
      if (finished) return;
      finished = true;
      GUARDED.forEach((t) => window.removeEventListener(t, guard, true));
      root.remove();
      if (app) app.hidden = false;
      if (note) setTimeout(() => ui.toast(note, { ms: 9000 }), 0);
      resolve(result);
    };
    const showError = (text) => { err.textContent = text || ""; err.hidden = !text; };
    const setBusy = (text) => {
      status.textContent = text || ""; status.hidden = !text;
      choices.querySelectorAll("button").forEach((b) => { b.disabled = !!text; });
    };
    // Keyboard focus after an action that didn't finish: setBusy() disabled the buttons, which drops focus
    // to the page body, so put it back on the button that started the action (else the first one). Left
    // alone when focus is somewhere that still works, or a dialog or menu is open.
    let lastButton = null;
    const refocus = () => {
      const a = document.activeElement;
      if (a && a !== document.body && a.isConnected && !a.disabled) return;
      if (document.querySelector("#overlay-root .scrim, #overlay-root .menu")) return;
      const b = lastButton && lastButton.isConnected && !lastButton.disabled ? lastButton : choices.querySelector("button:not([disabled])");
      if (b) b.focus();
    };
    // every action: clear the last error, run, and on failure say what happened in one sentence
    const run = async (fn, name) => {
      showError("");
      try { await fn(); }
      catch (e) { if (!cancelled(e)) { console.warn(e); showError(problem(e, name)); } }
      finally { if (!finished) { setBusy(""); refocus(); } }
    };
    const choice = (label, onClick, { primary = false, hint = "" } = {}) => {
      const b = h("button", { class: "btn" + (primary ? " btn--primary" : ""), type: "button" }, label);
      b.addEventListener("click", () => { lastButton = b; onClick(b); });
      const box = el("div", "pms__choice");
      box.append(b);
      if (hint) box.append(el("p", "pms__hint", hint));
      choices.append(box);
      return b;
    };

    // a folder the user just picked: a library, a library/ inside it, a profile, empty, or ask
    const afterPick = async (dir) => {
      const found = await classify(dir);
      if (found.type === "library" || found.type === "empty") { finish(await useFolder(dir, found)); return; }
      if (found.type === "profile") {
        setBusy(`Loading the profile in “${dir.name}”…`);
        const r = await useProfileFolder(dir);
        finish(r.st, summaryText(r.summary));
        return;
      }
      const ok = await ui.confirmDialog({
        title: `Make a library folder in “${dir.name}”?`,
        message: "This folder isn't a Fermivie library or profile. Fermivie can keep your library in a new folder called library inside it.",
        ok: "Make Library Folder",
      });
      if (!ok) return;
      const existing = await subDir(dir, "library");
      if (existing && (await firstVisibleName(existing)) != null) {
        throw new Error(`Fermivie can't use “${dir.name}” because it already has a folder called library that isn't a Fermivie library.`);
      }
      const lib = existing || await dir.getDirectoryHandle("library", { create: true });
      finish(await useFolder(dir, { root: lib, sub: "library" }));
    };
    const chooseFolder = () => run(async () => { const d = await pickFolder(); await afterPick(d); });
    const keepInBrowser = () => run(async () => {
      setBusy("Opening the library…");
      const st = await useBrowserStorage({ persist: true });
      await rememberBrowser(st);
      finish(st);
    });
    const loadFrom = (get) => run(async () => {
      const src = await get();
      if (!src) return;
      setBusy(`Loading “${src.name}”…`);
      const r = await useSource(src);
      finish(r.st, summaryText(r.summary));
    });
    const loadMenu = (b) => ui.menu([
      { label: "Profile Folder…", action: () => loadFrom(chooseSourceFolder) },
      { label: "Zip File…", action: () => loadFrom(chooseZip) },
    ], b);

    if (saved) {
      // 2. the remembered folder needs permission again (or couldn't be opened: the error says why)
      lede.textContent = error ? `Fermivie couldn't open your library in the folder “${saved.name}”.` : `Your library is in the folder “${saved.name}”. Allow Fermivie to open it again.`;
      choice(`Reopen “${saved.name}”`, () => run(async () => {
        if ((await requestPermissionOf(saved.handle, "readwrite")) !== "granted") throw Object.assign(new Error("not allowed"), { name: "NotAllowedError" });
        setBusy("Opening the library…");
        finish(await openRemembered(saved));
      }, saved.name), { primary: true });
      if (supportsFolders() || TEST_FS) choice("Choose Another Folder…", chooseFolder);
      choice("Use Browser Storage", keepInBrowser);
    } else if (supportsFolders() || TEST_FS) {
      // 3. first visit, folders supported
      lede.textContent = "Choose where your library is kept.";
      choice("Choose Folder…", chooseFolder, { primary: true, hint: "An empty folder starts a new library. A Fermivie library or profile folder opens as it is." });
      choice("Keep in This Browser", keepInBrowser, { hint: "Stored by this browser for this site. Download a copy from Settings > Profile now and then." });
      choice("Load Profile or Zip…", loadMenu);
    } else {
      // 4. first visit, no folder support (Safari, Firefox)
      lede.textContent = "This browser can't open folders, so your library is kept in its storage for this site. Folders need Chrome, Edge or Arc.";
      choice("Open Library", keepInBrowser, { primary: true });
      choice("Load Profile or Zip…", loadMenu);
    }
    showError(error);
    if (auto) run(() => afterPick(auto));
  });
}

/* ---------------------------------------------------------------- entry point
   chooseStorage() picks the storage. chooseStorage({failed, error}) is for when the app couldn't open the
   storage it was given (js/api.js, when the back end refuses it): the screen comes back with what went
   wrong in one sentence, and a remembered folder can be tried again, or another folder or browser storage
   chosen. This also runs after a reload, so a library that can't be opened never leaves the user stuck. */
export async function chooseStorage({ failed = null, error = null } = {}) {
  if (failed) {
    const isFolder = failed.kind === "folder";
    const text = problem(error, isFolder ? failed.name : "");
    const saved = TEST_FS ? null : await memGet("library");
    if (isFolder && saved && saved.kind === "folder" && saved.handle) return runScreen({ saved, error: text });
    return runScreen({ error: text });
  }
  if (TEST_STORAGE) return useBrowserStorage({ kind: TEST_STORAGE });
  if (TEST_FS && window.__PM_TEST_HANDLE__) return runScreen({ auto: window.__PM_TEST_HANDLE__ });
  const saved = await memGet("library");
  // 5. a browser-storage library: no screen
  if (saved && (saved.kind === "opfs" || saved.kind === "idb")) {
    try { return await useBrowserStorage({ kind: saved.kind }); }
    catch (e) { console.warn(e); return runScreen({ error: problem(e) }); }
  }
  if (saved && saved.kind === "folder" && saved.handle) {
    // 1. permission still granted: no screen
    if ((await permissionOf(saved.handle, "readwrite")) === "granted") {
      try { return await openRemembered(saved); }
      catch (e) { console.warn(e); return runScreen({ saved, error: problem(e, saved.name) }); }
    }
    return runScreen({ saved });
  }
  return runScreen({});
}
