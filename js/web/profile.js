// Your profile in the browser: the port of userprofile.py (WEB_CONTRACT.md 6.4). The whole library in one
// folder (or zip) you choose, kept up to date, and loadable anywhere:
//
//   paper-marker-profile.json   every paper's details, projects, mark types, settings, all marks, notes and crops
//   pdfs/<sha256>.pdf           a copy of every PDF (optional, on by default)
//
// Files written are byte for byte what userprofile.py writes for the same library and clock.
//
//   FILE, FORMAT, DELAY (ms), ZIP_FOLDER
//   snapshot(lib) -> the profile object (format, version, app, savedAt, library, settings, marks, notes, crops)
//   save(lib, profileFs = the connected folder, {includePdfs}) -> status()      (userprofile.save; while a
//       folder is connected, a save into any other folder is an export: the status is left as it was)
//   readProfile(fs) -> [fs, data]          (read_profile; fs is a LibFS rooted at the profile folder)
//   preview(fs) -> {folder, savedAt, papers, projects, marks, pdfs}
//   load(lib, fs, {connect = true, download, token}) -> {added, skipped, projects, marks, missingPdfs, folder}
//   connect(lib, fs, {token}), disconnect(), connection() -> {fs, lib, token} | null   (a pending debounced
//       save survives both, as Python's timer does: it saves into the folder connected when it fires)
//   status() -> the status object, from what this page knows (synchronous)
//   statusOf(lib) -> Promise of the same, after re-reading settings.json and the folder (use for GET profile)
//   changed(lib)   debounced save to the connected folder DELAY ms after the last change; never throws
//   flush()        run a pending debounced save now (pagehide); resolves when saving is done
//   exportZip(lib, {includePdfs}) -> Blob: "Fermivie Profile/paper-marker-profile.json" + ".../pdfs/"
//   importSource(lib, fs, {download, connect = false}) -> load's summary. fs is any LibFS (folder, ListFS,
//       ZipFS) or a zip File/Blob (opened with openZip): a profile is loaded with load(); a library folder (library.json, or library/library.json) is
//       read through new Library(fs) + snapshot() and merged with the same rules; a zip or folder holding
//       one top folder with either inside is looked into.
//   openZip(blob, {name}) -> ZipFS: readZip, but entries whose names are not safe paths are left out instead
//       of refusing the zip (zfs.skipped counts them). Use it for every zip given to importSource.
//   findSource(fs) -> {kind: "profile" | "library", fs} | null,  hasProfile(fs), reset()
//   profileBytes(snap) -> the profile file's bytes; b64encode / b64decode (Python's base64 rules);
//   SubFS(base, prefix, {hide, readOnly}) -> a LibFS view of a folder inside another LibFS
//
// Differences from the Python module, all forced by the browser:
//  - The connected folder is a LibFS handle held here (the back end remembers it in IndexedDB), not a path in
//    settings.json, so load(..., {connect}) does not write profile.folder into settings.json, and connect is
//    skipped for read-only sources. includePdfs is still read from settings.json (profile.includePdfs).
//  - No git: status reports git: false and push: false.
//  - load's download step is importers.downloadPdf (web-reachable hosts only), or the `download` option:
//    false (never download) or a function url -> Promise<{ok, bytes}>.
//  - Paths come from the profile and the library, so a value Python would join into a path outside the
//    folder (an absolute "file", a sha256 with "..") finds nothing here instead of reading that file.
//  - A file name a LibFS can't hold (a backslash, legal on a Mac) is left out: a marks file, crop or project
//    note so named is not in the snapshot, and a PDF copy so named is not made. Python reads and writes them.
//
// Locking: snapshot() and the library half of load() take the library lock once (Library#withLock) and use
// the store's *Unlocked methods inside, as userprofile.py holds store.lock. Saves are serialised.

import { nowIso, utf8, fromUtf8, JSONDecodeError, UnicodeDecodeError } from "./pyjson.js";
import { Library, StoreError, KEY_RE, ATT_RE, rx, cleanMarkTypes } from "./store/index.js";
import { parseLibJson, dumpsLib, dumpLibJson, assign, remove, keysOf, deepCopy, markFloat, markExact, isFloat, exactText }
  from "./store/libjson.js";
import * as py from "./store/py.js";
import { readOnlyError, checkPath } from "./fserror.js";
import { writeZip, readZip } from "./zip.js";

export const FILE = "paper-marker-profile.json";
export const FORMAT = "paper-marker-profile";
export const DELAY = 4000; // ms of quiet after a change before saving
export const ZIP_FOLDER = "Fermivie Profile";

// _state describes the connected folder (as in Python, where save() always writes there): while one is
// connected, a save into any other folder (an export) leaves it as it is.
const _state = { lastSaved: null, lastError: null, saving: false, gitResult: null };
let _conn = null; // {fs, lib, token}
let _includePdfs = true; // profile.includePdfs as last read from settings.json
let _exists = false; // the connected folder is there (os.path.isdir), as last looked at
let _hasFile = false; // ... and holds the profile file (os.path.isfile), as last looked at
let _timer = null;
let _timerLib = null;
let _chain = Promise.resolve(); // saves run one after another

// ---------------------------------------------------------------------------------------------------
// Python semantics for values read from a profile (parsed JSON)

/** The exceptions `except (OSError, ValueError)` catches around reading and parsing a file. */
const isReadError = (e) => e instanceof JSONDecodeError || e instanceof UnicodeDecodeError
  || e instanceof py.ValueError || e?.name === "FsError";

/** v or {} */
const orDict = (v) => (py.truthy(v) ? v : {});

/** d.items() for a dict parsed from JSON, in Python's key order. */
function items(d) {
  if (!py.isDict(d)) throw new TypeError(`'${py.typeName(d)}' object has no attribute 'items'`);
  return keysOf(d).map((k) => [k, d[k]]);
}

/** d.values() */
const values = (d) => {
  if (!py.isDict(d)) throw new TypeError(`'${py.typeName(d)}' object has no attribute 'values'`);
  return keysOf(d).map((k) => d[k]);
};

/** len(v) */
function pyLen(v) {
  if (Array.isArray(v)) return v.length;
  if (typeof v === "string") return py.cpLen(v);
  if (py.isDict(v)) return Object.keys(v).length;
  throw new TypeError(`object of type '${py.typeName(v)}' has no len()`);
}

/** str.partition(sep) */
function partition(s, sep) {
  const i = s.indexOf(sep);
  return i < 0 ? [s, "", ""] : [s.slice(0, i), sep, s.slice(i + sep.length)];
}

/** s.endswith(suffix) for a value that must be a str. */
function endsWith(s, ...suffixes) {
  if (typeof s !== "string") throw new TypeError(`'${py.typeName(s)}' object has no attribute 'endswith'`);
  return suffixes.some((x) => s.endsWith(x));
}

/** s.startswith(prefix) for a value that must be a str. */
function startsWith(s, prefix) {
  if (typeof s !== "string") throw new TypeError(`'${py.typeName(s)}' object has no attribute 'startswith'`);
  return s.startsWith(prefix);
}

/** text.encode("utf-8") */
function encodeText(text) {
  if (typeof text !== "string") throw new TypeError(`'${py.typeName(text)}' object has no attribute 'encode'`);
  return utf8(text);
}

/** userprofile._safe: one plain file name (no folders, not hidden). */
function safe(name) {
  return py.truthy(name) && typeof name === "string" && !name.includes("/") && !name.includes("\\") && !name.startsWith(".");
}

/** os.path.join(..., part) needs a str. */
function pathPart(v) {
  if (typeof v !== "string") throw new TypeError(`join() argument must be str, bytes, or os.PathLike object, not '${py.typeName(v)}'`);
  return v;
}

/** v + s for a str s, with Python's TypeError when v is not a str (list + str has its own message). */
function plusStr(v, s) {
  if (typeof v === "string") return v + s;
  if (Array.isArray(v)) throw new TypeError('can only concatenate list (not "str") to list');
  throw new TypeError(`unsupported operand type(s) for +: '${py.typeName(v)}' and 'str'`);
}

/** sha + ".pdf" */
const shaName = (sha) => plusStr(sha, ".pdf");

/** One file name a LibFS can hold (no "\", NUL, "/", not "" / "." / ".."); Python's os functions take more. */
function nameable(name) {
  try {
    checkPath(name);
    return !name.includes("/");
  } catch {
    return false;
  }
}

/** holder[key] = json.loads(text), keeping what JS numbers lose when the whole document is one number
 *  (1.0 stays a float, a big integer keeps its digits): the side tables live on the holder. */
function setParsed(holder, key, text) {
  const v = parseLibJson(text);
  holder[key] = v;
  if (typeof v === "number" && Number.isInteger(v)) {
    const box = parseLibJson(`[${text}]`); // the same number one level down, where its holder records it
    if (isFloat(box, 0)) markFloat(holder, key);
    else if (exactText(box, 0) !== null) markExact(holder, key, exactText(box, 0));
  }
}

// ---- base64, as Python's base64 module ---------------------------------------------------------------

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_VAL = (() => {
  const t = new Int16Array(128).fill(-1);
  for (let i = 0; i < 64; i++) t[B64.charCodeAt(i)] = i;
  return t;
})();

/** base64.b64encode(bytes).decode("ascii") */
export function b64encode(u8) {
  let out = "";
  const n = u8.length;
  const parts = [];
  let i = 0;
  for (; i + 2 < n; i += 3) {
    const v = (u8[i] << 16) | (u8[i + 1] << 8) | u8[i + 2];
    out += B64[v >> 18] + B64[(v >> 12) & 63] + B64[(v >> 6) & 63] + B64[v & 63];
    if (out.length >= 65536) { parts.push(out); out = ""; }
  }
  if (i < n) {
    const v = (u8[i] << 16) | ((i + 1 < n ? u8[i + 1] : 0) << 8);
    out += B64[v >> 18] + B64[(v >> 12) & 63] + (i + 1 < n ? B64[(v >> 6) & 63] : "=") + "=";
  }
  parts.push(out);
  return parts.join("");
}

/** binascii.Error */
class BinasciiError extends py.ValueError {
  constructor(message) {
    super(message);
    this.name = "Error";
  }
}

/** base64.b64decode(s): CPython 3.13's binascii.a2b_base64 with strict_mode off (other characters are
 *  skipped, the first complete padding ends the data). */
export function b64decode(s) {
  if (typeof s !== "string") throw new TypeError(`argument should be a bytes-like object or ASCII string, not '${py.typeName(s)}'`);
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) > 127) throw new py.ValueError("string argument should contain only ASCII characters");
  }
  const out = new Uint8Array(Math.floor(s.length / 4) * 3 + 3);
  let n = 0, quad = 0, left = 0, pads = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 61) { // "="
      if (quad >= 2 && quad + ++pads >= 4) return out.slice(0, n);
      continue;
    }
    const v = B64_VAL[c];
    if (v < 0) continue;
    pads = 0;
    if (quad === 0) { quad = 1; left = v; }
    else if (quad === 1) { quad = 2; out[n++] = ((left << 2) | (v >> 4)) & 255; left = v & 0x0f; }
    else if (quad === 2) { quad = 3; out[n++] = ((left << 4) | (v >> 2)) & 255; left = v & 0x03; }
    else { quad = 0; out[n++] = ((left << 6) | v) & 255; left = 0; }
  }
  if (quad === 1) {
    throw new BinasciiError("Invalid base64-encoded string: number of data characters "
      + `(${Math.floor(n / 3) * 4 + 1}) cannot be 1 more than a multiple of 4`);
  }
  if (quad !== 0) throw new BinasciiError("Incorrect padding");
  return out.slice(0, n);
}

// ---------------------------------------------------------------------------------------------------
// Files on a LibFS. A path the storage cannot name (Python would join it into somewhere else) is missing.

async function statOf(fs, path) {
  try {
    return await fs.stat(path);
  } catch (e) {
    if (e?.name === "FsError" && e.code === "bad-path") return null;
    throw e;
  }
}

const isFile = async (fs, path) => (await statOf(fs, path))?.kind === "file";
const isDir = async (fs, path) => (await statOf(fs, path))?.kind === "dir";
const exists = async (fs, path) => (await statOf(fs, path)) !== null;

/** sorted(os.listdir(dir)) names (Python's code point order). */
async function listNames(fs, dir) {
  return (await fs.list(dir)).map((e) => e.name).sort(py.pyCompare);
}

function missingFile(path) {
  const e = new Error(`[Errno 2] No such file or directory: '${path}'`);
  e.name = "FsError";
  e.code = "not-found";
  return e;
}

/** _read(path): the file's bytes. */
async function readBytes(fs, path) {
  const b = await fs.readBytes(path);
  if (b === null) throw missingFile(path);
  return b;
}

/** _read(path): the file as strict UTF-8 text. */
async function readText(fs, path) {
  return fromUtf8(await readBytes(fs, path));
}

/** A LibFS view of a folder inside another LibFS (a zip's top folder, a library/ subfolder; prefix "" is the
 *  whole of base). hide(name) leaves entries out of list(), e.g. macOS's "._name" AppleDouble files;
 *  readOnly: true refuses writes even when base allows them. */
export class SubFS {
  constructor(base, prefix, { hide = null, readOnly = false } = {}) {
    this.base = base;
    this.prefix = prefix;
    this.hide = hide;
    this.name = prefix ? prefix.slice(prefix.lastIndexOf("/") + 1) : base.name;
    this.kind = base.kind;
    this.readOnly = !!(readOnly || base.readOnly);
  }

  _w(path) {
    if (this.readOnly) throw readOnlyError(path);
    return this._p(path);
  }

  _p(path) {
    if (!this.prefix) return path;
    return path === "" ? this.prefix : `${this.prefix}/${path}`;
  }

  readBytes(path) { return this.base.readBytes(this._p(path)); }
  readText(path) { return this.base.readText(this._p(path)); }
  readFile(path) { return this.base.readFile(this._p(path)); }
  stat(path) { return this.base.stat(this._p(path)); }
  exists(path) { return this.base.exists(this._p(path)); }
  async list(dir) {
    const all = await this.base.list(this._p(dir));
    return this.hide ? all.filter((e) => !this.hide(e.name)) : all;
  }
  async write(path, data) { return this.base.write(this._w(path), data); }
  async mkdirp(dir) { return this.base.mkdirp(this._w(dir)); }
  async remove(path, opts) { return this.base.remove(this._w(path), opts); }
  async copy(src, dst) { return this.base.copy(this._p(src), this._w(dst)); }
  async move(src, dst) { return this.base.move(this._w(src), this._w(dst)); }
}

// ---------------------------------------------------------------------------------------------------
// Settings, connection, status

/** (store.get_settings().get("profile") or {}), {} when settings.json can't be read (folder_of). */
async function profileSettings(lib) {
  try {
    const p = py.pg(await lib.getSettings(), "profile");
    return py.isDict(p) ? p : {};
  } catch (e) {
    if (e instanceof StoreError) return {};
    throw e;
  }
}

/** p.get("includePdfs", True) is not False */
const wantPdfs = (p) => py.pg(p, "includePdfs", true) !== false;

/** Make fs the profile folder: every later changed(lib) saves into it. Writes nothing (call save next). */
export function connect(lib, fs, { token = "" } = {}) {
  if (!fs || fs.readOnly) throw new StoreError(400, "Fermivie can't save into that folder. Choose a folder it may write to.");
  // A pending debounced save is kept: as with Python's timer, it saves into whatever folder is connected when
  // it fires (so the change reaches the new folder), and flush() still runs it.
  _conn = { fs, lib, token: String(token || "") };
  _exists = true; // a folder the browser just handed over; statusOf() looks again
  _hasFile = false;
  return status();
}

/** Stop saving into the profile folder (nothing in it is changed). A pending debounced save is kept, as
 *  Python keeps its timer: when it fires with no folder connected it fails into lastError ("No profile
 *  folder is connected."), and it saves into a folder connected again before then. */
export function disconnect() {
  _conn = null;
  _exists = false;
  _hasFile = false;
  return status();
}

/** The connected profile folder: {fs, lib, token}, or null. */
export function connection() {
  return _conn ? { ..._conn } : null;
}

/** Forget the connection and the save state (changing library, tests). */
export function reset() {
  if (_timer) clearTimeout(_timer);
  _timer = null;
  _timerLib = null;
  disconnect();
  Object.assign(_state, { lastSaved: null, lastError: null, saving: false, gitResult: null });
  _includePdfs = true;
  _chain = Promise.resolve();
}

/** userprofile.status: where the profile is saved and how the last save went. */
export function status() {
  const info = { folder: _conn ? _conn.token || _conn.fs.name || "" : "", includePdfs: _includePdfs, git: false, push: false, ..._state };
  if (_conn) {
    info.name = _conn.fs.name || "";
    info.exists = _exists;
    info.isGitRepo = false;
    info.file = FILE;
    info.hasFile = _hasFile;
  }
  return info;
}

/** os.path.isdir(folder) for a LibFS root: False when it is gone (an unplugged drive, a removed folder) or
 *  can't be looked at. A folder handle answers stat("") without looking, so it is asked to list itself. */
async function folderExists(fs) {
  try {
    const st = await fs.stat("");
    if (!st || st.kind !== "dir") return false;
    const h = fs.handle;
    if (h && typeof h.values === "function") {
      for await (const _ of h.values()) break; // eslint-disable-line no-unused-vars
    }
    return true;
  } catch {
    return false;
  }
}

/** Look again at the connected folder: is it there, does it hold the profile file. */
async function lookAtFolder() {
  const conn = _conn;
  if (!conn) return;
  const there = await folderExists(conn.fs);
  let has = false;
  if (there) {
    try {
      has = await isFile(conn.fs, FILE);
    } catch {
      has = false;
    }
  }
  if (_conn === conn) {
    _exists = there;
    _hasFile = has;
  }
}

/** status() after re-reading profile.includePdfs from settings.json and looking at the connected folder. */
export async function statusOf(lib = null) {
  lib = lib || _conn?.lib || null;
  if (lib) _includePdfs = wantPdfs(await profileSettings(lib));
  await lookAtFolder();
  return status();
}

/** Something was saved: write the profile once things are quiet for DELAY ms. Never throws. */
export function changed(lib) {
  if (!_conn) return;
  if (_timer) clearTimeout(_timer);
  _timerLib = lib || _conn.lib;
  _timer = setTimeout(() => {
    _timer = null;
    saveQuietly(_timerLib);
  }, DELAY);
}

/** Run a pending debounced save now; resolves when every save has finished. */
export function flush() {
  if (_timer) {
    clearTimeout(_timer);
    _timer = null;
    return saveQuietly(_timerLib);
  }
  return _chain;
}

async function saveQuietly(lib) {
  try {
    await save(lib);
  } catch (e) { // reported on the Profile page, never breaks the app
    _state.lastError = String(e?.message ?? e);
  }
}

/** Is there a profile file at the root of fs? */
export async function hasProfile(fs) {
  return isFile(fs, FILE);
}

// ---------------------------------------------------------------------------------------------------
// Writing

/** Everything in the library except the PDFs, as one JSON-able object (userprofile.snapshot). */
export async function snapshot(lib) {
  const taken = await lib.withLock(async () => {
    const data = await lib.loadUnlocked();
    const fs = lib.fs;
    const marks = {}, notes = {}, crops = {};
    const its = py.pg(data, "items", {});
    for (const key of py.isDict(its) ? keysOf(its) : py.iterStrict(its)) {
      const d = `items/${key}`;
      if (!(await isDir(fs, d))) continue;
      // (a file whose name this storage can't use, e.g. "a\b.png" from a Mac, can't be read here: left out)
      for (const name of await listNames(fs, d)) {
        const p = `${d}/${name}`;
        if (name.endsWith(".marks.json")) {
          if (nameable(name)) setParsed(marks, `${key}/${name.slice(0, -".marks.json".length)}`, await readText(fs, p));
        } else if (name === "notes.md" || name === "notes.rev.json") {
          notes[`items/${key}/${name}`] = await readText(fs, p);
        }
      }
      const cd = `${d}/crops`;
      if (await isDir(fs, cd)) {
        for (const name of await listNames(fs, cd)) {
          if (name.endsWith(".png") && nameable(name)) crops[`${key}/${name}`] = b64encode(await readBytes(fs, `${cd}/${name}`));
        }
      }
    }
    if (await isDir(fs, "projects")) {
      for (const name of await listNames(fs, "projects")) {
        if ((name.endsWith(".md") || name.endsWith(".rev.json")) && nameable(name)) {
          notes[`projects/${name}`] = await readText(fs, `projects/${name}`);
        }
      }
    }
    const settings = await lib.getSettingsUnlocked();
    return { data, settings, marks, notes, crops };
  });
  const settings = deepCopy(taken.settings);
  remove(settings, "profile"); // where the profile lives is this computer's business
  return { format: FORMAT, version: 1, app: "Paper Marker", savedAt: nowIso(), library: taken.data, settings,
    marks: taken.marks, notes: taken.notes, crops: taken.crops };
}

/** The profile file's bytes: json.dumps(snap, ensure_ascii=False, indent=1) as UTF-8 (no final newline). */
export function profileBytes(snap) {
  return utf8(dumpsLib(snap, { indent: 1, ensureAscii: false }));
}

/**
 * The PDF copies save() makes, one at a time in its order: yields [name ("<sha256>.pdf"), path in the library]
 * for every attachment with a sha256 whose file exists and whose copy has(name) says is not there yet. The
 * caller makes each copy before the next attachment is looked at, so a save that fails part way (an item
 * whose attachments is 5) has copied exactly the PDFs Python's had. A name this storage can't hold (a
 * backslash) is skipped; one Python can't write either (a "/", NUL) fails as Python's copyfile does.
 */
async function* pdfCopies(lib, snap, has) {
  const its = py.pg(snap.library, "items", {});
  for (const [key, it] of items(its)) {
    for (const a of py.iterStrict(py.pg(it, "attachments", []))) {
      const fv = py.pg(a, "file");
      const file = pathPart(py.truthy(fv) ? fv : "");
      const sv = py.pg(a, "sha256");
      const sha = py.truthy(sv) ? sv : "";
      if (!py.truthy(sha)) continue;
      const src = `items/${key}/${file}`;
      if (!(await isFile(lib.fs, src))) continue;
      const name = shaName(sha);
      if (await has(name)) continue;
      // shutil.copyfile(src, os.path.join(pdir, f".{sha}.tmp")): os.stat refuses a NUL, the folder ".x/" is missing
      if (name.includes("\0")) throw new py.ValueError(NUL_STAT);
      if (name.includes("/")) throw missingFile(`pdfs/.${sha}.tmp`);
      if (!nameable(name)) continue;
      yield [name, src];
    }
  }
}

/** Every copy pdfCopies() would make into an empty folder: Map(name -> path in the library). */
async function allPdfCopies(lib, snap) {
  const out = new Map();
  for await (const [name, src] of pdfCopies(lib, snap, (n) => out.has(n))) out.set(name, src);
  return out;
}

/** A library file's contents for a copy (a Blob, read lazily where the storage can). */
async function sourceFile(lib, src) {
  const blob = await lib.fs.readFile(src);
  if (blob === null) throw missingFile(src);
  return blob;
}

/** userprofile.save: write the profile into profileFs (default: the connected folder). Returns status(). */
export function save(lib, profileFs = null, { includePdfs } = {}) {
  const run = _chain.then(() => saveUnchained(lib, profileFs, { includePdfs }));
  _chain = run.catch(() => {});
  return run;
}

async function saveUnchained(lib, profileFs, { includePdfs } = {}) {
  const p = await profileSettings(lib);
  _includePdfs = wantPdfs(p);
  const conn = _conn;
  const fs = profileFs || conn?.fs || null;
  if (!fs) throw new StoreError(400, "No profile folder is connected.");
  // A save into the connected folder (or, while none is connected, into the folder given) is what Python's
  // save is. Into any other folder it is an export, which leaves the connected folder's status (saving,
  // last save, last error) as it is.
  const mine = !conn || fs === conn.fs;
  if (mine) _state.saving = true;
  try {
    const snap = await snapshot(lib);
    if (includePdfs ?? wantPdfs(p)) {
      await fs.mkdirp("pdfs");
      for await (const [name, src] of pdfCopies(lib, snap, (n) => isFile(fs, `pdfs/${n}`))) {
        await fs.write(`pdfs/${name}`, await sourceFile(lib, src));
      }
    }
    await fs.write(FILE, profileBytes(snap));
    if (mine) {
      _state.lastSaved = snap.savedAt;
      _state.lastError = null;
      await lookAtFolder();
    }
    return status(); // taken while saving is still true, as Python's save returns status(store) in its try
  } catch (e) {
    if (mine) await lookAtFolder(); // e.g. the folder is gone: status says so (never throws)
    throw e;
  } finally {
    if (mine) _state.saving = false;
  }
}

/** The profile as a zip: "Fermivie Profile/paper-marker-profile.json" and ".../pdfs/<sha256>.pdf", the
 *  files save() would write into an empty folder. */
export async function exportZip(lib, { includePdfs } = {}) {
  const p = await profileSettings(lib);
  const snap = await snapshot(lib);
  const top = ZIP_FOLDER;
  const entries = [{ path: `${top}/`, dir: true }, { path: `${top}/${FILE}`, data: profileBytes(snap) }];
  if (includePdfs ?? wantPdfs(p)) {
    entries.push({ path: `${top}/pdfs/`, dir: true });
    for (const [name, src] of await allPdfCopies(lib, snap)) {
      entries.push({ path: `${top}/pdfs/${name}`, data: await sourceFile(lib, src) });
    }
  }
  return writeZip(entries);
}

// ---------------------------------------------------------------------------------------------------
// Reading

/** userprofile.read_profile: [fs, data] for a LibFS whose root holds the profile file. */
export async function readProfile(fs) {
  if (!(await isFile(fs, FILE))) throw new StoreError(404, `There's no Fermivie profile (${FILE}) there.`);
  let data;
  try {
    data = parseLibJson(await readText(fs, FILE));
  } catch (e) {
    if (!isReadError(e)) throw e;
    throw new StoreError(400, `That profile can't be read: ${e.message}`);
  }
  if (!py.isDict(data) || !py.eq(py.pg(data, "format"), FORMAT) || !py.isDict(py.pg(data, "library"))) {
    throw new StoreError(400, "That file isn't a Fermivie profile.");
  }
  return [fs, data];
}

/** What loading the profile would bring: {folder, savedAt, papers, projects, marks, pdfs}. */
export async function preview(fs) {
  const [root, data] = await readProfile(fs);
  const lib = data.library;
  // in the order Python's dict literal evaluates them, so a broken profile fails with Python's first error
  const out = { folder: root.name || "", savedAt: py.pg(data, "savedAt") };
  out.papers = pyLen(orDict(py.pg(lib, "items")));
  out.projects = pyLen(py.truthy(py.pg(lib, "projects")) ? lib.projects : []);
  let marks = 0;
  for (const m of values(orDict(py.pg(data, "marks")))) {
    const list = py.pg(orDict(m), "marks");
    marks += pyLen(py.truthy(list) ? list : []);
  }
  out.marks = marks;
  out.pdfs = await isDir(root, "pdfs");
  return out;
}

/** Python's ValueError for a path holding NUL: shutil.copyfile's os.stat, and open() (ls.atomic_write). */
const NUL_STAT = "stat: embedded null character in path";
const NUL_OPEN = "embedded null byte";

/** ls.atomic_write (or, with copy: true, shutil.copyfile) into the library: a name with NUL fails as in Python
 *  (before anything is written) instead of with the storage's "Bad path". */
async function libWrite(lib, path, data, { copy = false } = {}) {
  if (path.includes("\0")) throw new py.ValueError(copy ? NUL_STAT : NUL_OPEN);
  return lib.fs.write(path, data);
}

/** download_pdf(url, dest): fetch the PDF and write it to dest; true when it worked. Never throws. */
async function fetchInto(lib, url, dest, download) {
  if (download === false) return false;
  try {
    const dl = typeof download === "function" ? download : (await import("./importers/index.js")).downloadPdf;
    const r = await dl(url);
    if (!r || !r.ok || !r.bytes) return false;
    await lib.fs.write(dest, r.bytes);
    return true;
  } catch {
    return false;
  }
}

/**
 * The merge half of userprofile.load: add what the profile data has and this library doesn't; change nothing
 * that exists. pdf(sha) -> a Blob / Uint8Array of the stored copy, or null. Returns the summary.
 */
async function merge(lib, data, { folder, pdf, download }) {
  const plib = data.library;
  const have = new Set(keysOf((await lib.load()).items));
  const marks = orDict(py.pg(data, "marks")), notes = orDict(py.pg(data, "notes")), crops = orDict(py.pg(data, "crops"));
  const ready = new Map();
  const missing = [];
  // 1) files first, outside the lock (PDF copies or downloads can take a while)
  for (const [key, it0] of items(orDict(py.pg(plib, "items")))) {
    if (!py.isDict(it0) || !rx(KEY_RE, key) || have.has(key)) continue;
    const it = deepCopy(it0);
    const d = `items/${key}`;
    await lib.fs.mkdirp(`${d}/crops`);
    const atts = [];
    for (const a of py.iter(py.pg(it, "attachments"))) {
      const fv = py.pg(a, "file");
      const fn = py.truthy(fv) ? fv : "";
      if (!rx(ATT_RE, py.pg(a, "key")) || !endsWith(fn, ".pdf") || !safe(fn)) continue;
      const dest = `${d}/${fn}`;
      const sv = py.pg(a, "sha256");
      const sha = py.truthy(sv) ? sv : "";
      shaName(sha); // src = os.path.join(folder, "pdfs", sha + ".pdf")
      let ok = false;
      const src = py.truthy(sha) ? await pdf(sha) : null;
      if (src) {
        await libWrite(lib, dest, src, { copy: true });
        ok = true;
      } else {
        const uv = py.pg(a, "url");
        if (startsWith(py.truthy(uv) ? uv : "", "http")) ok = await fetchInto(lib, a.url, dest, download);
      }
      if (ok) atts.push(a);
      else {
        const t = py.pg(it, "title"), l = py.pg(a, "label");
        missing.push(`${py.str(py.truthy(t) ? t : key)} (${py.str(py.truthy(l) ? l : py.pg(a, "key"))})`);
      }
    }
    assign(it, "attachments", atts);
    if (atts.length && !atts.some((a) => py.eq(py.req(a, "key"), py.pg(it, "primary")))) assign(it, "primary", py.req(atts[0], "key"));
    for (const [ref, m] of items(marks)) {
      const [k, , att] = partition(ref, "/");
      if (k === key && rx(ATT_RE, att) && py.isDict(m)) await libWrite(lib, `${d}/${att}.marks.json`, dumpLibJson(m));
    }
    for (const [ref, b64] of items(crops)) {
      const [k, , name] = partition(ref, "/");
      if (k === key && safe(name) && name.endsWith(".png")) await libWrite(lib, `${d}/crops/${name}`, b64decode(b64));
    }
    for (const [ref, text] of items(notes)) {
      const parts = ref.split("/");
      if (parts.length === 3 && parts[0] === "items" && parts[1] === key && (parts[2] === "notes.md" || parts[2] === "notes.rev.json")) {
        await libWrite(lib, `${d}/${parts[2]}`, encodeText(text));
      }
    }
    ready.set(key, it);
  }
  // 2) then the library itself, under the lock
  const done = await lib.withLock(async () => {
    const cur = await lib.loadUnlocked();
    const added = [...ready.keys()].filter((k) => !py.has(cur.items, k));
    for (const k of added) assign(cur.items, k, ready.get(k));
    const mine = py.iterStrict(py.pg(cur, "projects", [])).map((p) => py.hashable(py.pg(p, "id")));
    const newProjects = py.iter(py.pg(plib, "projects"))
      .filter((p) => py.isDict(p) && py.truthy(py.pg(p, "id")) && !py.inList(mine, py.hashable(p.id)));
    if (!py.has(cur, "projects")) assign(cur, "projects", []);
    cur.projects.push(...newProjects);
    const ptypes = py.iter(py.pg(plib, "markTypes")).filter((t) => py.isDict(t) && py.truthy(py.pg(t, "id")));
    const rev = () => { const r = py.pg(cur, "markTypesRev"); return py.toInt(py.truthy(r) ? r : 0) + 1; };
    if (ptypes.length && !py.truthy(py.pg(cur, "markTypes"))) { // never edited here: take the profile's as they are
      assign(cur, "markTypes", cleanMarkTypes(ptypes));
      assign(cur, "markTypesRev", rev());
    }
    const current = async () => (py.truthy(py.pg(cur, "markTypes")) ? cur.markTypes : lib.markTypesUnlocked(cur));
    const types = py.iterStrict(await current()).map((t) => py.hashable(py.pg(t, "id")));
    const extra = ptypes.filter((t) => !py.inList(types, py.hashable(py.pg(t, "id"))));
    if (extra.length) {
      assign(cur, "markTypes", cleanMarkTypes([...py.iterStrict(await current()), ...extra]));
      assign(cur, "markTypesRev", rev());
    }
    await lib.saveUnlocked(cur);
    for (const [ref, text] of items(notes)) { // project notes you don't have yet
      const parts = ref.split("/");
      if (parts.length === 2 && parts[0] === "projects" && safe(parts[1]) && (parts[1].endsWith(".md") || parts[1].endsWith(".rev.json"))) {
        const dest = `projects/${parts[1]}`;
        if (!(await exists(lib.fs, dest))) await libWrite(lib, dest, encodeText(text));
      }
    }
    for (const k of added) { // readable .marks.md copies
      const it = cur.items[k];
      for (const a of py.iterStrict(py.pg(it, "attachments", []))) {
        const m = py.pg(marks, `${k}/${py.str(py.req(a, "key"))}`);
        if (py.isDict(m)) {
          try {
            await lib.writeMdUnlocked(it, a, m);
          } catch {
            // like Python's `except Exception: pass`
          }
        }
      }
    }
    return { added, newProjects };
  });
  if (!(await isFile(lib.fs, lib.settingsPath)) && py.isDict(py.pg(data, "settings"))) {
    try {
      await lib.setSettings(data.settings);
    } catch (e) {
      if (!(e instanceof StoreError)) throw e;
    }
  }
  let nMarks = 0;
  for (const k of done.added) {
    for (const a of ready.get(k).attachments) {
      const m = orDict(py.pg(marks, `${k}/${py.str(py.req(a, "key"))}`));
      const list = py.pg(m, "marks");
      nMarks += pyLen(py.truthy(list) ? list : []);
    }
  }
  return { added: done.added.length, skipped: pyLen(orDict(py.pg(plib, "items"))) - done.added.length,
    projects: done.newProjects.length, marks: nMarks, missingPdfs: missing, folder };
}

/** The stored copy pdfs/<sha>.pdf of a profile folder, or null. */
const profilePdf = (root) => async (sha) => {
  const p = `pdfs/${shaName(sha)}`;
  return (await isFile(root, p)) ? root.readFile(p) : null;
};

/**
 * userprofile.load: add what the profile in fs has and this library doesn't. With connect (and a writable
 * fs) the folder becomes the profile folder. Returns {added, skipped, projects, marks, missingPdfs, folder}.
 */
export async function load(lib, fs, { connect: conn = true, download, token = "" } = {}) {
  const [root, data] = await readProfile(fs);
  const summary = await merge(lib, data, { folder: root.name || "", pdf: profilePdf(root), download });
  if (conn && !root.readOnly) {
    connect(lib, root, { token });
    _state.lastSaved = py.pg(data, "savedAt");
    _hasFile = true;
  }
  return summary;
}

/** What a chosen folder or zip holds: {kind: "profile" | "library", fs} (fs rooted at it), or null.
 *  Looks at the root, at library/, and inside a single top folder (how zips of a folder are made). */
export async function findSource(fs) {
  const here = async (f) => {
    if (await isFile(f, "library.json")) return { kind: "library", fs: f };
    if (await isFile(f, "library/library.json")) return { kind: "library", fs: new SubFS(f, "library") };
    if (await isFile(f, FILE)) return { kind: "profile", fs: f };
    return null;
  };
  const found = await here(fs);
  if (found) return found;
  const top = (await fs.list("")).filter((e) => !e.name.startsWith(".") && e.name !== "__MACOSX");
  if (top.length === 1 && top[0].kind === "dir") return here(new SubFS(fs, top[0].name));
  return null;
}

/**
 * Load a profile or a library from a read-only source (a folder, the files of a chosen folder, a zip) into
 * lib with load()'s rules. A library is read through new Library(fs) and snapshot(), with its PDFs taken
 * from the library itself, as if it had been saved to a profile with copies of every PDF and that profile
 * loaded. Returns load()'s summary.
 */
export async function importSource(lib, fs, { download, connect: conn = false, token = "" } = {}) {
  if (typeof Blob !== "undefined" && fs instanceof Blob) fs = await openZip(fs); // a zip file: never readZip
  const found = await findSource(fs);
  if (!found) {
    throw new StoreError(404, `There's no Fermivie profile (${FILE}) or library (library.json) there.`);
  }
  if (found.kind === "profile") return load(lib, found.fs, { connect: conn, download, token });
  // read only (nothing is created in the source), without macOS's "._name" files, which a zip made with
  // ditto or a folder on a FAT drive holds next to every file (Python would try to read them as marks)
  const view = new SubFS(found.fs, "", { hide: (n) => n.startsWith("._"), readOnly: true });
  const src = new Library(view, { libraryId: `import:${Math.random().toString(36).slice(2)}` });
  const snap = await snapshot(src);
  const copies = await allPdfCopies(src, snap);
  // the same data a saved profile file gives back
  const data = parseLibJson(dumpsLib(snap, { indent: 1, ensureAscii: false }));
  const pdf = async (sha) => {
    const p = copies.get(shaName(sha));
    return p ? view.readFile(p) : null;
  };
  return merge(lib, data, { folder: found.fs.name || fs.name || "", pdf, download });
}

// ---------------------------------------------------------------------------------------------------
// Zips to import

const SIG_CENTRAL = 0x02014b50, SIG_END = 0x06054b50;

/** A central directory entry named "x", put after the entry being tried (see unsafeName). */
const PROBE_TAIL = (() => {
  const u = new Uint8Array(47);
  const v = new DataView(u.buffer);
  v.setUint32(0, SIG_CENTRAL, true);
  v.setUint16(4, 20, true);
  v.setUint16(6, 20, true);
  v.setUint16(28, 1, true);
  u[46] = 0x78;
  return u;
})();

/** Does readZip refuse this central directory entry for its name? Tried as a zip of its own: the entry, a
 *  plain entry "x" (so the bytes before the end record are known ones), the end record. Only the central
 *  directory is read when a zip is opened, so no file data is needed. */
async function unsafeName(entry) {
  const end = new Uint8Array(22);
  const v = new DataView(end.buffer);
  v.setUint32(0, SIG_END, true);
  v.setUint16(8, 2, true);
  v.setUint16(10, 2, true);
  v.setUint32(12, entry.length + PROBE_TAIL.length, true);
  try {
    await readZip(new Blob([entry, PROBE_TAIL, end]));
    return false;
  } catch (e) {
    return e?.name === "FsError" && e.code === "bad-path";
  }
}

/** The zip without the entries readZip refuses for their names: the same bytes up to the central directory,
 *  the other entries' records unchanged, the end record's counts and size made to match. {blob, skipped}. */
async function withoutUnsafeNames(blob) {
  const size = blob.size;
  const from = Math.max(0, size - 22 - 0xffff);
  const tail = new Uint8Array(await blob.slice(from, size).arrayBuffer());
  const tv = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  let at = -1; // the end record readZip uses: the one that ends the file, else the last one
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tv.getUint32(i, true) !== SIG_END) continue;
    const clen = tv.getUint16(i + 20, true);
    if (i + 22 + clen === tail.length) { at = i; break; }
    if (at < 0 && i + 22 + clen <= tail.length) at = i;
  }
  if (at < 0) return { blob, skipped: 0 };
  const endPos = from + at;
  const cdSize = tv.getUint32(at + 12, true);
  const cdStart = endPos - cdSize;
  if (cdStart < 0) return { blob, skipped: 0 };
  const cd = new Uint8Array(await blob.slice(cdStart, endPos).arrayBuffer());
  const v = new DataView(cd.buffer, cd.byteOffset, cd.byteLength);
  const kept = [];
  let count = 0, keptSize = 0, skipped = 0, i = 0;
  while (i + 46 <= cd.length && v.getUint32(i, true) === SIG_CENTRAL) {
    const len = 46 + v.getUint16(i + 28, true) + v.getUint16(i + 30, true) + v.getUint16(i + 32, true);
    const entry = cd.subarray(i, Math.min(i + len, cd.length));
    i += len;
    if (await unsafeName(entry)) { skipped++; continue; }
    kept.push(entry);
    keptSize += entry.length;
    count++;
  }
  if (i < cd.length) { kept.push(cd.subarray(i)); keptSize += cd.length - i; } // damaged: readZip says so
  const end = tail.slice(at, at + 22 + tv.getUint16(at + 20, true));
  const ev = new DataView(end.buffer);
  ev.setUint16(8, count, true);
  ev.setUint16(10, count, true);
  ev.setUint32(12, keptSize, true);
  // the central directory's offset stays: data in front of the zip still shifts every offset the same way
  return { blob: new Blob([blob.slice(0, cdStart), ...kept, end]), skipped };
}

/**
 * readZip (zip.js) for a profile or library zip the user chose: same arguments, result and errors, except
 * that entries whose names are not safe paths are left out instead of refusing the whole zip (zip.js does
 * that). Python's zipfile reads such a zip, and an import never reads those files: a stray "notes\draft.txt"
 * a Mac allows, "../x". ListFS leaves them out of a chosen folder the same way. zfs.skipped counts them.
 */
export async function openZip(input, { name } = {}) {
  const blob = typeof Blob !== "undefined" && input instanceof Blob ? input : new Blob([input]);
  const opts = { name: name || input?.name || "Zip file" };
  try {
    const zfs = await readZip(blob, opts);
    zfs.skipped = 0;
    return zfs;
  } catch (e) {
    if (!(e?.name === "FsError" && e.code === "bad-path")) throw e;
  }
  const { blob: kept, skipped } = await withoutUnsafeNames(blob);
  const zfs = await readZip(kept, opts);
  zfs.skipped = skipped;
  return zfs;
}
