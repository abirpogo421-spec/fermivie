// The Library class of library_store.py over a LibFS (WEB_CONTRACT.md 5.1, 6.1): library.json, marks,
// notes, settings, projects, history and _deleted/, byte for byte what the Python app writes.
//
// Locking: the public methods take the library lock once (fs.js withLock, name "pm-web:" + libraryId: Web
// Locks across tabs, else an in-page promise chain) and call *Unlocked helpers, like Python's RLock-guarded
// methods call _load_unlocked. The lock is NOT re-entrant: code running inside withLock(fn) must call the
// *Unlocked methods (loadUnlocked, saveUnlocked, writeMdUnlocked, markTypesUnlocked, ...), never the public
// ones. Methods Python runs without the lock (backup, stats, getItem, projectIds, findDuplicate) take none.
//
// Arguments: every public method (and every *Unlocked entry point) reads its arguments through asJson, as the
// JSON request body Python's server would get: undefined keys left out, NaN / Infinity as null, -0 as 0, and a
// copy taken at call time, so the caller can't change what is being saved while a call waits on storage. The
// `lib` objects the store hands out (load(), stats(lib), getItem(lib, ...)) are passed as they are.
// Import reservations (reserve / release) are shared by every Library object on a libraryId and, through Web
// Locks, by every tab (reserve.js).
//
// Every operation re-reads the files it needs (another app may write the same folder). The only caches are
// the per-attachment mark counts, keyed by (path, size, mtime), and lastLib, the library object most recently
// loaded or saved (for the synchronous bibtexUrl).
//
// Python method -> JS: optional keyword arguments become an options object, tuples become arrays:
//   create_item(meta, project, key, tags)      createItem(meta, {project, key, tags})
//   add_attachment_file(key, path, label, ...)  addAttachmentBytes(key, data, label, {source, url, prefer}) -> [item, att]
//   reserve(idents, base_key) -> [key, dupKey]  set_mark_types(...) -> [types, rev]
//   save_marks(key, att, marks, base_rev, force) saveMarks(key, att, marks, baseRev, {force})
//   save_notes(kind, id, text, base_rev, force, saved_at)  saveNotes(kind, id, text, baseRev, {force, savedAt})
// Call `await lib.init()` (or `Library.open(fs, opts)`) to create items/, projects/, history/ and _deleted/
// as Python's constructor does; the first locked operation does it too when the storage is writable.

import { nowIso, stamp, secStamp, sha256Hex, utf8, fromUtf8, pyLoads, pyDumps, pyCompare,
  JSONDecodeError, UnicodeDecodeError } from "../pyjson.js";
import { withLock } from "../fs.js";
import { citekey, bibtex as bibtexEntry } from "../importers/bibtex.js";
import * as py from "./py.js";
import * as R from "./reserve.js";
import { parseLibJson, dumpLibJson, deepCopy, dictCopy, keysOf, assign, remove, markFloat, asJson } from "./libjson.js";
import {
  KEY_RE, ATT_RE, PROJECT_RE, CROP_RE, READ_STATES, STR_FIELDS, META_FIELDS, EDITABLE, TYPES, HISTORY_KEEP,
  SEARCH_MAX_HITS, MARK_TYPES, WINDOWS_RESERVED, StoreError, bad, notFound, rx, slug, cleanMeta, newItem,
  itemMeta, cleanAuthors, year, strList, cleanMarkTypes, defaultMarkTypes, fillSettings, mergeSettings,
  marksMd, countMarks,
} from "./model.js";

const DIRS = ["items", "projects", "history", "_deleted"];
const VERSION_END = new RegExp(`v[${py.DIGIT_CLASS}]+$`, "u"); // re.sub(r"v\d+$", "", ...) on stripped text
const zeroCounts = () => ({ question: 0, remark: 0, explain: 0, total: 0 });
/** it.get("attachments", []) iterated as Python does (no `or []`). */
const atts = (it) => py.iterStrict(py.pg(it, "attachments", []));

/** The exceptions Python's `except (ValueError, UnicodeDecodeError, OSError)` catches when reading a file. */
const isReadError = (e) => e instanceof JSONDecodeError || e instanceof UnicodeDecodeError
  || e instanceof py.ValueError || e?.name === "FsError";

const missingFile = (path) => {
  const e = new Error(`[Errno 2] No such file or directory: '${path}'`);
  e.name = "FsError";
  return e;
};

async function toBytes(data) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (typeof Blob !== "undefined" && data instanceof Blob) return new Uint8Array(await data.arrayBuffer());
  throw new TypeError("PDF data must be a Uint8Array, an ArrayBuffer or a Blob");
}

// run the jobs (functions returning promises) n at a time; the first error stops the rest and is thrown
async function pool(jobs, n) {
  let i = 0;
  const run = async () => { while (i < jobs.length) { const job = jobs[i++]; await job(); } };
  await Promise.all(Array.from({ length: Math.min(n, jobs.length) }, run));
}

export class Library {
  constructor(fs, { libraryId = "" } = {}) {
    this.fs = fs;
    this.libraryId = String(libraryId ?? "");
    this.root = "";
    // import reservations (Python's cond, inflight, reserved) live in reserve.js, shared by every Library
    // object on this libraryId and, through Web Locks, by every tab
    this._statsCache = new Map();
    this._dirsReady = false;
    this.lastLib = null;
  }

  static async open(fs, opts) {
    return new Library(fs, opts).init();
  }

  async init() {
    if (!this.fs.readOnly) for (const d of DIRS) await this.fs.mkdirp(d);
    this._dirsReady = true;
    return this;
  }

  /** Run fn with the library lock held (not re-entrant: inside, use the *Unlocked methods). */
  withLock(fn) {
    return withLock("pm-web:" + this.libraryId, async () => {
      if (!this._dirsReady) await this.init();
      return fn();
    });
  }

  // ---- paths ------------------------------------------------------------------------------------
  get libPath() { return "library.json"; }

  get settingsPath() { return "settings.json"; }

  itemDir(key) {
    if (!rx(KEY_RE, key)) throw notFound("No such paper.");
    return `items/${key}`;
  }

  marksPath(key, att) {
    if (!rx(ATT_RE, att)) throw notFound("No such attachment.");
    return `${this.itemDir(key)}/${att}.marks.json`;
  }

  rel(path) { return path; }

  /** os.path.exists: false for a path the storage can't even name (Python just finds nothing there). */
  async _exists(path) {
    try {
      return await this.fs.exists(path);
    } catch (e) {
      if (e?.name === "FsError" && e.code === "bad-path") return false;
      throw e;
    }
  }

  async _stat(path) {
    try {
      return await this.fs.stat(path);
    } catch (e) {
      if (e?.name === "FsError" && e.code === "bad-path") return null;
      throw e;
    }
  }

  async _isDir(path) {
    return (await this._stat(path))?.kind === "dir";
  }

  // ---- history ----------------------------------------------------------------------------------
  /** Copy path into history/ (exact-identity rotation, newest HISTORY_KEEP kept). Takes no lock. */
  async backup(path) {
    if (!(await this._exists(path))) return null;
    await this.fs.mkdirp("history");
    const flat = this.rel(path).split("/").join("__");
    let name = `${flat}__${stamp()}`;
    let n = 1;
    while (await this._exists(`history/${name}`)) {
      name = `${flat}__${stamp()}_${n}`;
      n++;
    }
    await this.fs.copy(path, `history/${name}`);
    const d = `[${py.DIGIT_CLASS}]`; // re's \d: Python's digits, not this engine's \p{Nd}
    const pat = new RegExp("^" + py.escapeRe(flat) + `__${d}{8}_${d}{6}_${d}{6}(?:_${d}+)?\\n?$`, "u");
    const mine = (await this.fs.list("history")).filter((e) => pat.test(e.name)).sort((a, b) => pyCompare(a.name, b.name));
    for (const old of mine.slice(0, Math.max(0, mine.length - HISTORY_KEEP))) {
      if (old.kind !== "file") continue; // os.remove fails on a folder, and Python lets it be
      try {
        await this.fs.remove(`history/${old.name}`);
      } catch {
        // like Python's `except OSError: pass`
      }
    }
    return name;
  }

  // ---- library.json -----------------------------------------------------------------------------
  load() {
    return this.withLock(() => this.loadUnlocked());
  }

  async loadUnlocked() {
    const p = this.libPath;
    if (!(await this._exists(p))) return { version: 1, items: {}, projects: [], savedAt: null };
    let lib;
    try {
      const bytes = await this.fs.readBytes(p);
      if (bytes === null) throw missingFile(p);
      lib = parseLibJson(fromUtf8(bytes));
      if (!py.isDict(lib) || !py.isDict(py.pg(lib, "items")) || !Array.isArray(py.pg(lib, "projects"))) {
        throw new py.ValueError("unexpected structure");
      }
    } catch (e) {
      if (!isReadError(e)) throw e;
      throw new StoreError(500, `library.json is unreadable (${e.message}). Nothing was changed; `
        + "restore it from library/history/.", { corrupt: true });
    }
    this.lastLib = lib;
    return lib;
  }

  save(lib, { backup = true } = {}) {
    return this.withLock(() => this.saveUnlocked(lib, { backup }));
  }

  async saveUnlocked(lib, { backup = true } = {}) {
    assign(lib, "version", 1);
    assign(lib, "savedAt", nowIso());
    if (py.truthy(backup)) await this.backup(this.libPath);
    await this.fs.write(this.libPath, dumpLibJson(lib));
    this.lastLib = lib;
  }

  getItem(lib, key) {
    const it = rx(KEY_RE, key) ? py.pg(lib.items, key) : null;
    if (!py.truthy(it)) throw notFound(`No paper with key ${py.repr(key)}.`);
    return it;
  }

  projectIds(lib) {
    return new Set(lib.projects.map((p) => py.req(p, "id")));
  }

  /** reserved: the item keys running imports hold (read from reserve.js when not given). */
  async _uniqueKey(lib, base, reserved = null) {
    base = (typeof base === "string" ? base : "").replace(/[^a-z0-9]/gu, "") || "anonnd";
    base = py.cpSlice(base, 0, 60);
    const taken = new Set([...Object.keys(lib.items), ...(reserved ?? (await R.reservedKeys(this.libraryId)))]);
    const free = async (k) => !taken.has(k) && !(await this._exists(`items/${k}`));
    if (await free(base)) return base;
    for (const c of "bcdefghijklmnopqrstuvwxyz") if (await free(base + c)) return base + c;
    let n = 2;
    while (!(await free(`${base}${n}`))) n++;
    return `${base}${n}`;
  }

  // ---- library + stats --------------------------------------------------------------------------
  async _attCounts(path) {
    const st = await this._stat(path);
    if (!st) return zeroCounts();
    const sig = `${st.mtime}:${st.size}`;
    const hit = this._statsCache.get(path);
    if (hit && hit[0] === sig) return dictCopy(hit[1]);
    let c;
    try {
      const bytes = await this.fs.readBytes(path);
      if (bytes === null) throw missingFile(path);
      const data = pyLoads(fromUtf8(bytes));
      c = countMarks(py.pg(data, "marks"));
    } catch {
      c = { ...zeroCounts(), error: "unreadable marks file" };
    }
    this._statsCache.set(path, [sig, c]);
    return dictCopy(c);
  }

  /** {key: {marks, perAttachment, hasNotes}} for every item (reads the marks files; takes no lock). Built with
   *  assign, so keysOf lists every level in Python's order even for keys JS puts first (an item "120205", an
   *  attachment "2", a mark type "5"). */
  async stats(lib) {
    const out = {};
    for (const key of keysOf(lib.items)) {
      const it = lib.items[key];
      const per = {};
      const tot = zeroCounts();
      for (const a of atts(it)) {
        const ak = py.req(a, "key");
        const c = await this._attCounts(`items/${key}/${py.str(ak)}.marks.json`);
        assign(per, py.str(ak), c);
        for (const k of keysOf(c)) {
          const v = c[k];
          if (py.isInt(v)) assign(tot, k, (Object.hasOwn(tot, k) ? tot[k] : 0) + v);
        }
      }
      const st = await this._stat(`items/${key}/notes.md`);
      assign(out, key, { marks: tot, perAttachment: per, hasNotes: !!st && st.size > 0 });
    }
    return out;
  }

  // ---- items ------------------------------------------------------------------------------------
  async createItem(meta, { project = null, key = null, tags = [] } = {}) {
    // every public method takes its copy of the arguments before it waits for the lock, as Python's server reads
    // the request body first (asJson's copy is handed to the *Unlocked twin without copying again)
    [meta, project, key, tags] = [asJson(meta), asJson(project), asJson(key), asJson(tags)];
    return this.withLock(() => this.createItemUnlocked(meta, { project, key, tags }));
  }

  async createItemUnlocked(meta, { project = null, key = null, tags = [] } = {}) {
    [meta, project, key, tags] = [asJson(meta), asJson(project), asJson(key), asJson(tags)];
    const lib = await this.loadUnlocked();
    let projects = [];
    if (py.truthy(project)) {
      py.hashable(project);
      if (!this.projectIds(lib).has(project)) throw bad("That project does not exist.");
      projects = [project];
    }
    const k = py.truthy(key) ? key : await this._uniqueKey(lib, citekey(itemMeta(cleanMeta(meta))));
    py.hashable(k);
    if (py.has(lib.items, k)) throw bad(`Key ${py.repr(k)} is already used.`);
    const it = newItem(k, meta, projects, tags ?? []);
    await this.fs.mkdirp(this.itemDir(k));
    assign(lib.items, k, it);
    await this.saveUnlocked(lib);
    return deepCopy(it);
  }

  /** Many papers at once (a library import), with one save of library.json for all of them.
   *  entries: [{meta, tags?, projects?, notes?}] -> the new items, in order (library_store.create_items). */
  async createItems(entries) {
    entries = asJson(entries);
    return this.withLock(async () => {
      if (!Array.isArray(entries) || !entries.length) throw bad("Send a list of papers.");
      const lib = await this.loadUnlocked();
      const ids = this.projectIds(lib), out = [];
      for (const e of entries) {
        if (!py.isDict(e) || !py.isDict(py.pg(e, "meta"))) throw bad("meta must be an object.");
        const projects = py.pg(e, "projects") ?? [];
        if (!Array.isArray(projects) || projects.some((p) => !ids.has(p))) throw bad("That project does not exist.");
        const k = await this._uniqueKey(lib, citekey(itemMeta(cleanMeta(e.meta))));
        const it = newItem(k, e.meta, [...new Set(projects)], py.pg(e, "tags") || []);
        await this.fs.mkdirp(this.itemDir(k));
        assign(lib.items, k, it);
        out.push(deepCopy(it));
      }
      for (const e of entries) {
        const n = py.pg(e, "notes");
        if (n !== null && n !== undefined && typeof n !== "string") throw bad("text must be a string.");
      }
      await this.saveUnlocked(lib);
      await pool(out.map((it, i) => () => (py.truthy(py.pg(entries[i], "notes")) ? this.saveNotesUnlocked("item", it.key, entries[i].notes, 0) : null)), 6);
      return out;
    });
  }

  /** Many PDFs at once (a library import): the PDFs are written side by side and library.json is saved once.
   *  entries: [{key, data (Blob or bytes), label?, marks?}] -> [{key, attachment, marks?} | {key, error}], in order.
   *  The browser back end's own call (the local app uploads PDFs one by one, where each is quick). */
  async addAttachmentsBatch(entries) {
    return this.withLock(async () => {
      const lib = await this.loadUnlocked();
      const out = [], jobs = [];
      for (const e of entries) {
        try {
          const it = this.getItem(lib, e.key);
          const bytes = await toBytes(e.data);
          const sha = await sha256Hex(bytes);
          if (atts(it).some((a) => py.eq(py.pg(a, "sha256"), sha))) throw new StoreError(409, "That PDF is already attached to this paper.", { duplicate: true });
          const att = await this._newAttKey(it, e.label || "", null);
          const a = { key: att, label: e.label ? e.label : att, file: `${att}.pdf`, source: "file", url: "", added: nowIso(), bytes: bytes.length, sha256: sha, pages: 0 };
          if (!py.has(it, "attachments")) assign(it, "attachments", []);
          it.attachments.push(a);
          if (!py.truthy(py.pg(it, "primary"))) assign(it, "primary", att);
          assign(it, "modified", nowIso());
          const r = { key: e.key, attachment: a };
          out.push(r);
          jobs.push(async () => {
            const dest = `${this.itemDir(e.key)}/${att}.pdf`;
            await this.fs.write(dest, bytes);
            const st = await this.fs.stat(dest);
            if (st) a.bytes = st.size;
          });
        } catch (err) {
          if (!(err instanceof StoreError)) throw err;
          out.push({ key: e.key, error: err.message, duplicate: !!(err.extra && err.extra.duplicate) });
        }
      }
      await pool(jobs, 6);
      await this.saveUnlocked(lib);
      await pool(out.map((r, i) => () => (r.attachment && Array.isArray(entries[i].marks) && entries[i].marks.length
        ? this.saveMarksUnlocked(r.key, r.attachment.key, entries[i].marks, 0).then((m) => { r.marks = m.marks.length; })
        : null)), 4);
      return out.map((r) => deepCopy(r));
    });
  }

  _validatePatch(lib, it, patch) {
    if (!py.isDict(patch) || !py.truthy(patch)) throw bad("Nothing to change.");
    const out = {};
    for (const k of keysOf(patch)) {
      let v = patch[k];
      if (!EDITABLE.includes(k)) throw bad(`Field ${py.repr(k)} cannot be edited.`);
      if (STR_FIELDS.includes(k)) {
        if (v === null) v = "";
        if (typeof v !== "string") throw bad(`${k} must be text.`);
      } else if (k === "type") {
        if (!TYPES.includes(v)) throw bad("Unknown item type.");
      } else if (k === "authors") {
        if (!Array.isArray(v)) throw bad("authors must be a list.");
        v = cleanAuthors(v);
      } else if (k === "year") {
        if (v !== null && v !== "" && year(v) === null) throw bad("year must be a 4-digit number.");
        v = year(v);
      } else if (k === "categories" || k === "tags") {
        if (!Array.isArray(v)) throw bad(`${k} must be a list.`);
        v = strList(v);
      } else if (k === "projects") {
        if (!Array.isArray(v)) throw bad("projects must be a list.");
        const ids = this.projectIds(lib);
        v = strList(v);
        if (v.some((p) => !ids.has(p))) throw bad("Unknown project.");
      } else if (k === "read") {
        if (!READ_STATES.includes(v)) throw bad("read must be unread, reading or read.");
      } else if (k === "primary") {
        if (!py.inList(atts(it).map((a) => py.req(a, "key")), v)) {
          throw bad("primary must be one of the paper's attachments.");
        }
      } else if (k === "opened") {
        if (v !== null && typeof v !== "string") throw bad("opened must be a timestamp or null.");
      }
      out[k] = v;
    }
    return out;
  }

  async patchItem(key, patch) {
    [key, patch] = [asJson(key), asJson(patch)];
    return this.withLock(() => this.patchItemUnlocked(key, patch));
  }

  async patchItemUnlocked(key, patch) {
    [key, patch] = [asJson(key), asJson(patch)];
    const lib = await this.loadUnlocked();
    const it = this.getItem(lib, key);
    const changes = this._validatePatch(lib, it, patch);
    const keys = Object.keys(changes);
    for (const k of keys) assign(it, k, changes[k]);
    if (keys.some((k) => k !== "opened" && k !== "read")) assign(it, "modified", nowIso());
    // "opened" is bookkeeping (Recently Opened), not an edit: no history copy for it
    await this.saveUnlocked(lib, { backup: keys.some((k) => k !== "opened") });
    return deepCopy(it);
  }

  /** Fill empty metadata fields of an item from importer META (all if overwrite). */
  async applyMeta(key, meta, { overwrite = false } = {}) {
    [key, meta, overwrite] = [asJson(key), asJson(meta), asJson(overwrite)];
    return this.withLock(() => this.applyMetaUnlocked(key, meta, { overwrite }));
  }

  async applyMetaUnlocked(key, meta, { overwrite = false } = {}) {
    [key, meta, overwrite] = [asJson(key), asJson(meta), asJson(overwrite)];
    const lib = await this.loadUnlocked();
    const it = this.getItem(lib, key);
    const nw = cleanMeta(meta);
    const empty = (v) => v === "" || v === null || (Array.isArray(v) && v.length === 0);
    let changed = false;
    for (const k of META_FIELDS) {
      const nv = py.pg(nw, k);
      if (empty(nv) || (k === "type" && nv === "misc")) continue;
      const cur = py.pg(it, k);
      const isEmpty = empty(cur) || (k === "type" && cur === "misc");
      if ((py.truthy(overwrite) || isEmpty) && !py.eq(cur, nv)) {
        assign(it, k, nv);
        changed = true;
      }
    }
    if (changed) {
      assign(it, "modified", nowIso());
      await this.saveUnlocked(lib);
    }
    return deepCopy(it);
  }

  async setTrashed(key, trashed) {
    [key, trashed] = [asJson(key), asJson(trashed)];
    return this.withLock(() => this.setTrashedUnlocked(key, trashed));
  }

  async setTrashedUnlocked(key, trashed) {
    [key, trashed] = [asJson(key), asJson(trashed)];
    const lib = await this.loadUnlocked();
    const it = this.getItem(lib, key);
    assign(it, "trashed", py.truthy(trashed) ? nowIso() : null);
    await this.saveUnlocked(lib);
    return deepCopy(it);
  }

  emptyTrash() {
    return this.withLock(() => this.emptyTrashUnlocked());
  }

  async emptyTrashUnlocked() {
    const lib = await this.loadUnlocked();
    const moved = [];
    const st = secStamp();
    for (const key of keysOf(lib.items)) {
      const it = lib.items[key];
      if (!py.truthy(py.pg(it, "trashed"))) continue;
      let dest = `_deleted/${st}_${key}`;
      let n = 2;
      while (await this._exists(dest)) {
        dest = `_deleted/${st}_${key}_${n}`;
        n++;
      }
      const src = `items/${key}`;
      if (await this._isDir(src)) await this.fs.move(src, dest);
      else await this.fs.mkdirp(dest);
      await this.fs.write(`${dest}/item.json`, dumpLibJson(it));
      remove(lib.items, key);
      moved.push(key);
    }
    if (moved.length) await this.saveUnlocked(lib);
    return moved;
  }

  async bulk(body) {
    body = asJson(body);
    if (!py.isDict(body)) throw bad("Bad request.");
    const keys = py.pg(body, "keys");
    if (!Array.isArray(keys) || !keys.length || !keys.every((k) => typeof k === "string")) {
      throw bad("keys must be a non-empty list.");
    }
    return this.withLock(() => this.bulkUnlocked(body));
  }

  async bulkUnlocked(body) {
    body = asJson(body);
    const lib = await this.loadUnlocked();
    const items = body.keys.map((k) => this.getItem(lib, k));
    const ids = this.projectIds(lib);
    const addP = strList(py.pg(body, "addProjects"));
    const remP = strList(py.pg(body, "removeProjects"));
    if (addP.some((p) => !ids.has(p))) throw bad("Unknown project.");
    const addT = strList(py.pg(body, "addTags"));
    const remT = strList(py.pg(body, "removeTags"));
    const read = py.pg(body, "read");
    if (read !== null && !READ_STATES.includes(read)) throw bad("read must be unread, reading or read.");
    const t = nowIso();
    const canon = (it) => pyDumps(it, { indent: null, sortKeys: true, ensureAscii: true });
    for (const it of items) {
      const before = canon(it);
      const projects = py.req(it, "projects");
      for (const p of addP) if (!py.inList(projects, p)) projects.push(p);
      assign(it, "projects", it.projects.filter((p) => !py.inList(remP, p)));
      const tags = py.req(it, "tags");
      for (const tg of addT) if (!py.inList(tags, tg)) tags.push(tg);
      assign(it, "tags", it.tags.filter((tg) => !py.inList(remT, tg)));
      if (py.pg(body, "trash") === true && !py.truthy(py.pg(it, "trashed"))) assign(it, "trashed", t);
      if (py.pg(body, "restore") === true) assign(it, "trashed", null);
      if (read !== null) assign(it, "read", read);
      if (canon(it) !== before && (addP.length || remP.length || addT.length || remT.length)) assign(it, "modified", t);
    }
    await this.saveUnlocked(lib);
    return deepCopy(items);
  }

  // ---- duplicates -------------------------------------------------------------------------------
  findDuplicate(lib, { doi = "", arxiv = "", sha = "" } = {}) {
    [doi, arxiv, sha] = [asJson(doi), asJson(arxiv), asJson(sha)];
    const low = (v) => py.lower(py.strip(py.truthy(v) ? v : ""));
    const noVer = (s) => s.replace(VERSION_END, "");
    const d = low(doi);
    const ax = noVer(low(arxiv));
    for (const key of keysOf(lib.items)) {
      const it = lib.items[key];
      if (py.truthy(py.pg(it, "trashed"))) continue;
      if (d && low(py.pg(it, "doi")) === d) return key;
      if (ax && noVer(low(py.pg(it, "arxiv"))) === ax) return key;
      if (py.truthy(sha) && atts(it).some((a) => py.eq(py.pg(a, "sha256"), sha))) return key;
    }
    return null;
  }

  async addToProject(key, project) {
    [key, project] = [asJson(key), asJson(project)];
    if (!py.truthy(project)) return null;
    return this.withLock(async () => {
      const lib = await this.loadUnlocked();
      const it = this.getItem(lib, key);
      py.hashable(project);
      if (!this.projectIds(lib).has(project)) throw bad("That project does not exist.");
      if (!py.inList(py.req(it, "projects"), project)) {
        it.projects.push(project);
        await this.saveUnlocked(lib);
      }
      return deepCopy(it);
    });
  }

  // ---- import reservations ----------------------------------------------------------------------
  /** Wait until no other import (in any tab) is busy with the same identifiers, then reserve a key.
   *  Returns [key, null] or [null, duplicateKey]. idents: any iterable of "doi:...", "arxiv:...", "sha:...". */
  async reserve(idents, baseKey) {
    const ids = R.identSet(idents, py.truthy);
    baseKey = asJson(baseKey);
    return R.reserve(this.libraryId, ids, async (reserved) => {
      const lib = await this.load();
      let dup = null;
      for (const i of ids) {
        const at = i.indexOf(":");
        const kind = at < 0 ? i : i.slice(0, at), val = at < 0 ? "" : i.slice(at + 1);
        if (!["doi", "arxiv", "sha"].includes(kind)) {
          throw new TypeError(`Library.find_duplicate() got an unexpected keyword argument '${kind}'`);
        }
        dup = this.findDuplicate(lib, { [kind]: val });
        if (dup) break;
      }
      if (dup) return [null, dup];
      return [await this._uniqueKey(lib, baseKey, reserved), null];
    });
  }

  async release(idents, key) {
    return R.release(this.libraryId, R.identSet(idents, py.truthy), asJson(key));
  }

  // ---- attachments ------------------------------------------------------------------------------
  async _newAttKey(it, label = "", prefer = null) {
    const keys = new Set(atts(it).map((a) => py.req(a, "key")));
    const d = `items/${py.str(py.req(it, "key"))}`;
    if (py.truthy(prefer) && rx(ATT_RE, prefer) && !keys.has(prefer) && !(await this._exists(`${d}/${prefer}.pdf`))) {
      return prefer;
    }
    if (!keys.size && !(await this._exists(`${d}/main.pdf`))) return "main";
    let base = slug(label, 24) || "pdf";
    if (WINDOWS_RESERVED.has(base)) base += "-pdf"; // con.pdf, aux.pdf ... are devices on Windows
    let k = base, n = 2;
    while (keys.has(k) || (await this._exists(`${d}/${k}.pdf`)) || (await this._exists(`${d}/${k}.marks.json`))) {
      k = `${base}-${n}`;
      n++;
    }
    return k;
  }

  /** Python's add_attachment_file with the PDF's bytes instead of a path: data is a Uint8Array, an
   *  ArrayBuffer or a Blob/File. Returns [item, attachment]. */
  async addAttachmentBytes(key, data, label, { source = "file", url = "", prefer = null } = {}) {
    [key, label, source, url, prefer] = [asJson(key), asJson(label), asJson(source), asJson(url), asJson(prefer)];
    // the bytes as they are now (a Blob or File cannot change)
    if (data instanceof ArrayBuffer) data = data.slice(0);
    else if (ArrayBuffer.isView(data)) data = new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
    return this.withLock(() => this.addAttachmentBytesUnlocked(key, data, label, { source, url, prefer }));
  }

  async addAttachmentBytesUnlocked(key, data, label, { source = "file", url = "", prefer = null } = {}) {
    [key, label, source, url, prefer] = [asJson(key), asJson(label), asJson(source), asJson(url), asJson(prefer)];
    const lib = await this.loadUnlocked();
    const it = this.getItem(lib, key);
    const bytes = await toBytes(data);
    const sha = await sha256Hex(bytes);
    for (const a of atts(it)) {
      if (py.eq(py.pg(a, "sha256"), sha)) throw new StoreError(409, "That PDF is already attached to this paper.", { duplicate: true });
    }
    const att = await this._newAttKey(it, label, prefer);
    const dest = `${this.itemDir(key)}/${att}.pdf`;
    await this.fs.write(dest, bytes);
    const st = await this.fs.stat(dest);
    const a = { key: att, label: py.truthy(label) ? label : att, file: `${att}.pdf`, source, url: py.truthy(url) ? url : "",
      added: nowIso(), bytes: st ? st.size : bytes.length, sha256: sha, pages: 0 };
    if (!py.has(it, "attachments")) assign(it, "attachments", []);
    it.attachments.push(a);
    if (!py.truthy(py.pg(it, "primary")) || !py.inList(it.attachments.map((x) => py.req(x, "key")), it.primary)) {
      assign(it, "primary", att);
    }
    assign(it, "modified", nowIso());
    await this.saveUnlocked(lib);
    return [deepCopy(it), deepCopy(a)];
  }

  async renameAttachment(key, att, label) {
    [key, att, label] = [asJson(key), asJson(att), asJson(label)];
    if (typeof label !== "string" || !py.strip(label)) throw bad("label must be non-empty text.");
    return this.withLock(async () => {
      const lib = await this.loadUnlocked();
      const it = this.getItem(lib, key);
      const a = atts(it).find((x) => py.eq(py.req(x, "key"), att));
      if (!a) throw notFound("No such attachment.");
      assign(a, "label", label);
      assign(it, "modified", nowIso());
      await this.saveUnlocked(lib);
      return deepCopy(it);
    });
  }

  async removeAttachment(key, att) {
    [key, att] = [asJson(key), asJson(att)];
    return this.withLock(() => this.removeAttachmentUnlocked(key, att));
  }

  async removeAttachmentUnlocked(key, att) {
    [key, att] = [asJson(key), asJson(att)];
    const lib = await this.loadUnlocked();
    const it = this.getItem(lib, key);
    const a = atts(it).find((x) => py.eq(py.req(x, "key"), att));
    if (!a) throw notFound("No such attachment.");
    const d = this.itemDir(key);
    let dest = `_deleted/${secStamp()}_${key}_${att}`;
    let n = 2;
    while (await this._exists(dest)) {
      dest = `_deleted/${secStamp()}_${key}_${att}_${n}`;
      n++;
    }
    await this.fs.mkdirp(`${dest}/crops`);
    const mp = `${d}/${att}.marks.json`;
    let crops = [];
    if (await this._exists(mp)) {
      try {
        const data = pyLoads(fromUtf8(await this.fs.readBytes(mp)));
        crops = py.iterStrict(py.pg(data, "marks", [])).filter((m) => py.isDict(m) && py.truthy(py.pg(m, "crop"))).map((m) => m.crop);
      } catch {
        crops = [];
      }
    }
    const fileV = py.pg(a, "file");
    for (const fn of [py.truthy(fileV) ? fileV : `${att}.pdf`, `${att}.marks.json`, `${att}.marks.md`]) {
      const p = `${d}/${fn}`;
      if (await this._exists(p)) await this.fs.move(p, `${dest}/${fn}`);
    }
    for (const c of crops) {
      if (typeof c === "string" && CROP_RE.test(c)) {
        const p = `${d}/crops/${c}`;
        if (await this._exists(p)) await this.fs.move(p, `${dest}/crops/${c}`);
      }
    }
    await this.fs.write(`${dest}/attachment.json`, dumpLibJson({ item: key, attachment: a }));
    assign(it, "attachments", it.attachments.filter((x) => !py.eq(py.req(x, "key"), att)));
    if (py.eq(py.pg(it, "primary"), att)) assign(it, "primary", it.attachments.length ? py.req(it.attachments[0], "key") : "");
    assign(it, "modified", nowIso());
    await this.saveUnlocked(lib);
    return deepCopy(it);
  }

  // ---- marks ------------------------------------------------------------------------------------
  _att(lib, key, att) {
    const it = this.getItem(lib, key);
    const a = atts(it).find((x) => py.eq(py.req(x, "key"), att));
    if (!a) throw notFound(`No attachment ${py.repr(att)} on this paper.`);
    return [it, a];
  }

  readMarksFile(path) {
    return this.withLock(() => this.readMarksFileUnlocked(path));
  }

  /** -> the parsed marks file, or null if missing; StoreError 500 when unreadable. */
  async readMarksFileUnlocked(path) {
    if (!(await this._exists(path))) return null;
    try {
      const bytes = await this.fs.readBytes(path);
      if (bytes === null) throw missingFile(path);
      const data = parseLibJson(fromUtf8(bytes)); // keeps a big integer's digits and integral floats for marks.md
      if (!py.isDict(data) || !Array.isArray(py.pg(data, "marks"))) throw new py.ValueError("no marks list");
      return data;
    } catch (e) {
      if (!isReadError(e)) throw e;
      throw new StoreError(500, `The marks file ${this.rel(path)} is unreadable (${e.message}). Nothing was `
        + "changed; fix or restore it from library/history/ before saving.", { corrupt: true });
    }
  }

  /** Library._rev: a file's revision (0 when missing, 1 when it has no valid "rev"). Keeps a bool as Python does. */
  static revOf(data) {
    if (data === null || data === undefined) return 0;
    const r = py.pg(data, "rev");
    return py.isIntOrBool(r) && r >= 0 ? r : 1;
  }

  async getMarks(key, att) {
    [key, att] = [asJson(key), asJson(att)];
    return this.withLock(() => this.getMarksUnlocked(key, att));
  }

  async getMarksUnlocked(key, att) {
    [key, att] = [asJson(key), asJson(att)];
    const lib = await this.loadUnlocked();
    const [, a] = this._att(lib, key, att);
    const data = await this.readMarksFileUnlocked(this.marksPath(key, att));
    if (data === null) {
      const label = py.pg(a, "label");
      return { item: key, attachment: att, doc: py.truthy(label) ? label : py.pg(a, "file"), marks: [], savedAt: null, rev: 0 };
    }
    const doc = py.pg(data, "doc");
    return { item: key, attachment: att, doc: py.truthy(doc) ? doc : py.pg(a, "label"),
      marks: data.marks, savedAt: py.pg(data, "savedAt"), rev: Library.revOf(data) };
  }

  /** marks: read as the JSON body carries them (asJson): a copy taken at call time, so the caller may go on
   *  changing its own mark objects (a crop landing, a new mark) while the save runs; the result's marks are
   *  that copy with crops filled in. */
  async saveMarks(key, att, marks, baseRev, { force = false } = {}) {
    [key, att, marks, baseRev, force] = [asJson(key), asJson(att), asJson(marks), asJson(baseRev), asJson(force)];
    if (!Array.isArray(marks) || !marks.every((m) => py.isDict(m))) throw bad("marks must be a list of objects.");
    return this.withLock(() => this.saveMarksUnlocked(key, att, marks, baseRev, { force }));
  }

  async saveMarksUnlocked(key, att, marks, baseRev, { force = false } = {}) {
    [key, att, marks, baseRev, force] = [asJson(key), asJson(att), asJson(marks), asJson(baseRev), asJson(force)];
    const lib = await this.loadUnlocked();
    const [it, a] = this._att(lib, key, att);
    const path = this.marksPath(key, att);
    const cur = await this.readMarksFileUnlocked(path);
    const rev = Library.revOf(cur);
    if (!py.truthy(force)) {
      const br = baseRev === null || baseRev === undefined ? 0 : baseRev;
      if (!py.isInt(br) || br !== Number(rev)) {
        throw new StoreError(409, "These marks were changed somewhere else.", { conflict: true, rev,
          marks: cur ? py.pg(cur, "marks", []) : [], savedAt: cur ? py.pg(cur, "savedAt") : null });
      }
    }
    // decode crops first, so a bad crop writes nothing
    const crops = [];
    for (const m of marks) {
      const cd = py.pg(m, "cropData");
      if (cd === null) continue;
      if (typeof cd !== "string" || !cd.startsWith("data:image/png;base64,")) throw bad("cropData must be a PNG data URL.");
      const png = py.b64decodeStrict(cd.slice(cd.indexOf(",") + 1));
      if (png === null) throw bad("cropData is not valid base64.");
      if (!(png.length >= 4 && png[0] === 0x89 && png[1] === 0x50 && png[2] === 0x4e && png[3] === 0x47)) {
        throw bad("cropData is not a PNG.");
      }
      const safeId = py.cpSlice(py.str(py.pg(m, "id")).replace(/[^A-Za-z0-9_-]/gu, "_"), 0, 80) || "mark";
      crops.push([m, `${att}_${safeId}.png`, png]);
    }
    for (const [m, fn, png] of crops) {
      await this.fs.write(`${this.itemDir(key)}/crops/${fn}`, png);
      delete m.cropData;
      m.crop = fn;
    }
    for (const m of marks) delete m.cropData; // cropData that was null is never stored
    const curDoc = cur ? py.pg(cur, "doc") : null;
    const label = py.pg(a, "label");
    const data = { item: key, attachment: att,
      doc: py.truthy(curDoc) ? curDoc : py.truthy(label) ? label : py.pg(a, "file"),
      marks, savedAt: nowIso(), rev: Number(rev) + 1 };
    await this.backup(path);
    await this.fs.write(path, dumpLibJson(data));
    await this.writeMdUnlocked(it, a, data);
    return { savedAt: data.savedAt, rev: data.rev, marks };
  }

  // ---- mark types -------------------------------------------------------------------------------
  async markTypes(lib = null) {
    if (lib !== null && lib !== undefined) return this.markTypesUnlocked(lib);
    return this.withLock(() => this.markTypesUnlocked());
  }

  async markTypesUnlocked(lib = null) {
    if (lib === null || lib === undefined) lib = await this.loadUnlocked();
    const mt = py.pg(lib, "markTypes");
    if (!Array.isArray(mt) || !mt.length) return defaultMarkTypes();
    try {
      return cleanMarkTypes(mt);
    } catch (e) {
      if (e instanceof StoreError) return defaultMarkTypes();
      throw e;
    }
  }

  /** -> [types, rev] */
  async setMarkTypes(types, { baseRev = null, force = false } = {}) {
    [baseRev, force] = [asJson(baseRev), asJson(force)];
    types = cleanMarkTypes(asJson(types));
    if (baseRev !== null && baseRev !== undefined && !py.isInt(baseRev)) throw bad("baseRev must be a whole number.");
    return this.withLock(() => this.setMarkTypesUnlocked(types, { baseRev: baseRev ?? null, force, cleaned: true }));
  }

  async setMarkTypesUnlocked(types, { baseRev = null, force = false, cleaned = false } = {}) {
    if (!cleaned) {
      [types, baseRev, force] = [asJson(types), asJson(baseRev), asJson(force)];
      types = cleanMarkTypes(types);
      if (baseRev !== null && !py.isInt(baseRev)) throw bad("baseRev must be a whole number.");
    }
    const lib = await this.loadUnlocked();
    const rv = py.pg(lib, "markTypesRev");
    const curRev = py.toInt(py.truthy(rv) ? rv : 0);
    if (!py.truthy(force) && baseRev !== null && baseRev !== curRev) {
      throw new StoreError(409, "Mark types were changed in another window. Close this and open Mark Types again.",
        { conflict: true, rev: curRev, types: await this.markTypesUnlocked(lib) });
    }
    const old = new Set((await this.markTypesUnlocked(lib)).map((t) => t.id));
    const keep = new Set(types.map((t) => t.id));
    const inUse = new Map();
    const st = await this.stats(lib);
    for (const key of keysOf(st)) {
      const counts = st[key].marks;
      for (const k of keysOf(counts)) {
        const v = counts[k];
        if (k !== "total" && py.isInt(v) && v) inUse.set(k, (inUse.get(k) || 0) + v);
      }
    }
    const gone = [...inUse].filter(([k]) => old.has(k) && !keep.has(k)).map(([k, n]) => `${k} (${n} marks)`);
    if (gone.length) throw bad("These types are still in use, so they can be hidden but not removed: " + gone.join(", ") + ".");
    if (MARK_TYPES.some((b) => !keep.has(b))) throw bad("Question, Remark and Explain are built in: hide them instead of removing them.");
    assign(lib, "markTypes", types);
    assign(lib, "markTypesRev", curRev + 1);
    await this.saveUnlocked(lib);
    // keep every marks.md legend in step with the new names and descriptions
    for (const key of keysOf(lib.items)) {
      const it = lib.items[key];
      for (const a of atts(it)) {
        const p = this.marksPath(key, py.req(a, "key"));
        if (await this._exists(p)) {
          try {
            await this.writeMdUnlocked(it, a, await this.readMarksFileUnlocked(p), { types });
          } catch {
            // like Python's `except Exception: pass`
          }
        }
      }
    }
    return [types, curRev + 1];
  }

  // ---- settings ---------------------------------------------------------------------------------
  readSettings() {
    return this.withLock(() => this.readSettingsUnlocked());
  }

  async readSettingsUnlocked() {
    const p = this.settingsPath;
    if (!(await this._exists(p))) return {};
    try {
      const bytes = await this.fs.readBytes(p);
      if (bytes === null) throw missingFile(p);
      const data = parseLibJson(fromUtf8(bytes)); // settings.json is written back with these values
      if (!py.isDict(data)) throw new py.ValueError("not an object");
      return data;
    } catch (e) {
      if (!isReadError(e)) throw e;
      throw new StoreError(500, `settings.json is unreadable (${e.message}). Nothing was changed; `
        + "fix or delete library/settings.json.", { corrupt: true });
    }
  }

  async getSettings() {
    return fillSettings(await this.readSettings());
  }

  async getSettingsUnlocked() {
    return fillSettings(await this.readSettingsUnlocked());
  }

  async setSettings(patch) {
    patch = asJson(patch);
    return this.withLock(() => this.setSettingsUnlocked(patch));
  }

  async setSettingsUnlocked(patch) {
    patch = asJson(patch);
    const merged = mergeSettings(fillSettings(await this.readSettingsUnlocked()), patch);
    merged.savedAt = nowIso();
    await this.backup(this.settingsPath);
    await this.fs.write(this.settingsPath, dumpLibJson(merged));
    return fillSettings(merged);
  }

  writeMd(it, a, data, { types = null } = {}) {
    [it, a, data, types] = [asJson(it), asJson(a), asJson(data), asJson(types)];
    return this.withLock(() => this.writeMdUnlocked(it, a, data, { types }));
  }

  async writeMdUnlocked(it, a, data, { types = null } = {}) {
    const key = py.req(it, "key"), att = py.req(a, "key");
    if (types === null || types === undefined) {
      try {
        types = await this.markTypesUnlocked();
      } catch (e) {
        if (!(e instanceof StoreError)) throw e;
        types = null;
      }
    }
    const doc = py.pg(data, "doc");
    const text = marksMd(py.pg(it, "title"), py.pg(a, "label"), key, att, py.truthy(doc) ? doc : py.pg(a, "label"), data, types);
    await this.fs.write(`${this.itemDir(key)}/${att}.marks.md`, utf8(text));
  }

  // ---- notes ------------------------------------------------------------------------------------
  _notesPaths(kind, ident) {
    if (kind === "item") {
      const d = this.itemDir(ident);
      return [`${d}/notes.md`, `${d}/notes.rev.json`];
    }
    if (!rx(PROJECT_RE, ident)) throw notFound("No such project.");
    return [`projects/${ident}.md`, `projects/${ident}.rev.json`];
  }

  /** Python's _check_owner: 404 unless the item or project exists (takes the lock). */
  checkOwner(kind, ident) {
    [kind, ident] = [asJson(kind), asJson(ident)];
    return this.withLock(() => this._checkOwnerUnlocked(kind, ident));
  }

  async _checkOwnerUnlocked(kind, ident) {
    const lib = await this.loadUnlocked();
    if (kind === "item") this.getItem(lib, ident);
    else if (!this.projectIds(lib).has(py.hashable(ident))) throw notFound("No such project.");
  }

  async readNotesUnlocked(kind, ident) {
    const [mp, rp] = this._notesPaths(kind, ident);
    if (!(await this._exists(mp))) return { text: "", savedAt: null, rev: 0 };
    let text;
    try {
      const bytes = await this.fs.readBytes(mp);
      if (bytes === null) throw missingFile(mp);
      text = fromUtf8(bytes);
    } catch (e) {
      if (!(e instanceof UnicodeDecodeError || e?.name === "FsError")) throw e;
      throw new StoreError(500, `${this.rel(mp)} is unreadable (${e.message}). Nothing was changed.`, { corrupt: true });
    }
    let meta = {};
    if (await this._exists(rp)) {
      try {
        const bytes = await this.fs.readBytes(rp);
        if (bytes === null) throw missingFile(rp);
        meta = pyLoads(fromUtf8(bytes));
        if (!py.isDict(meta)) throw new py.ValueError("not an object");
      } catch (e) {
        if (!isReadError(e)) throw e;
        throw new StoreError(500, `${this.rel(rp)} is unreadable (${e.message}). Nothing was changed.`, { corrupt: true });
      }
    }
    const r = py.pg(meta, "rev");
    const rev = py.isIntOrBool(r) ? r : 1;
    const sv = py.pg(meta, "savedAt");
    const saved = py.truthy(sv) ? sv : nowIso((await this.fs.stat(mp)).mtime);
    return { text, savedAt: saved, rev };
  }

  /** Python's _read_notes: {text, savedAt, rev} of the notes file, without the owner check (takes the lock). */
  readNotes(kind, ident) {
    [kind, ident] = [asJson(kind), asJson(ident)];
    return this.withLock(() => this.readNotesUnlocked(kind, ident));
  }

  getNotes(kind, ident) {
    [kind, ident] = [asJson(kind), asJson(ident)];
    return this.withLock(async () => {
      await this._checkOwnerUnlocked(kind, ident);
      return this.readNotesUnlocked(kind, ident);
    });
  }

  async saveNotes(kind, ident, text, baseRev, { force = false, savedAt = null } = {}) {
    [kind, ident, text, baseRev, force, savedAt] = [kind, ident, text, baseRev, force, savedAt].map(asJson);
    if (typeof text !== "string") throw bad("text must be a string.");
    return this.withLock(() => this.saveNotesUnlocked(kind, ident, text, baseRev, { force, savedAt }));
  }

  async saveNotesUnlocked(kind, ident, text, baseRev, { force = false, savedAt = null } = {}) {
    [kind, ident, text, baseRev, force, savedAt] = [kind, ident, text, baseRev, force, savedAt].map(asJson);
    if (typeof text !== "string") throw bad("text must be a string.");
    await this._checkOwnerUnlocked(kind, ident);
    const cur = await this.readNotesUnlocked(kind, ident);
    if (!py.truthy(force)) {
      const br = baseRev === null || baseRev === undefined ? 0 : baseRev;
      if (!py.isInt(br) || br !== Number(cur.rev)) {
        throw new StoreError(409, "These notes were changed somewhere else.", { conflict: true,
          rev: cur.rev, text: cur.text, savedAt: cur.savedAt });
      }
    }
    const [mp, rp] = this._notesPaths(kind, ident);
    await this.backup(mp);
    await this.fs.write(mp, utf8(text));
    const meta = { rev: Number(cur.rev) + 1, savedAt: py.truthy(savedAt) ? savedAt : nowIso() };
    await this.fs.write(rp, dumpLibJson(meta));
    return { text, savedAt: meta.savedAt, rev: meta.rev };
  }

  // ---- projects ---------------------------------------------------------------------------------
  _proj(lib, pid) {
    const p = lib.projects.find((x) => py.eq(py.req(x, "id"), pid));
    if (!p) throw notFound("No such project.");
    return p;
  }

  async createProject(name, { parent = null, pid = null } = {}) {
    [name, parent, pid] = [asJson(name), asJson(parent), asJson(pid)];
    if (typeof name !== "string" || !py.strip(name)) throw bad("Project name is empty.");
    return this.withLock(() => this.createProjectUnlocked(name, { parent, pid }));
  }

  async createProjectUnlocked(name, { parent = null, pid = null } = {}) {
    [name, parent, pid] = [asJson(name), asJson(parent), asJson(pid)];
    if (typeof name !== "string" || !py.strip(name)) throw bad("Project name is empty.");
    const lib = await this.loadUnlocked();
    if (py.truthy(parent)) this._proj(lib, parent);
    const ids = this.projectIds(lib);
    const base = py.truthy(pid) ? pid : "p_" + (slug(name, 32, "_") || "project");
    let k = base, n = 2;
    while (ids.has(k) || (await this._exists(`projects/${py.str(k)}.md`))) {
      k = `${py.str(base)}_${n}`;
      n++;
    }
    const p = { id: k, name: py.strip(name), parent: py.truthy(parent) ? parent : null, created: nowIso() };
    lib.projects.push(p);
    await this.saveUnlocked(lib);
    return { ...p };
  }

  async patchProject(pid, body) {
    [pid, body] = [asJson(pid), asJson(body)];
    if (!py.isDict(body)) throw bad("Bad request.");
    return this.withLock(() => this.patchProjectUnlocked(pid, body));
  }

  async patchProjectUnlocked(pid, body) {
    [pid, body] = [asJson(pid), asJson(body)];
    if (!py.isDict(body)) throw bad("Bad request.");
    const lib = await this.loadUnlocked();
    const p = this._proj(lib, pid);
    if (Object.hasOwn(body, "name")) {
      if (typeof body.name !== "string" || !py.strip(body.name)) throw bad("Project name is empty.");
      assign(p, "name", py.strip(body.name));
    }
    if (Object.hasOwn(body, "parent")) {
      const par = py.truthy(body.parent) ? body.parent : null;
      if (par !== null) {
        this._proj(lib, par);
        let a = par;
        let guard = lib.projects.length + 1;
        while (py.truthy(a)) { // no cycles
          if (py.eq(a, pid)) throw bad("A project can't be moved inside itself.");
          const up = lib.projects.find((x) => py.eq(py.req(x, "id"), a));
          a = up ? py.pg(up, "parent") : null;
          if (--guard < 0) throw new Error("The projects' parents form a loop."); // Python would spin forever
        }
      }
      assign(p, "parent", par);
    }
    if (Object.hasOwn(body, "sections")) {
      const secs = body.sections;
      if (!Array.isArray(secs) || secs.length > 20) throw bad("sections must be a list of at most 20.");
      const out = [], seen = new Set();
      for (const x of secs) {
        const xd = py.truthy(x) ? x : {};
        const sidV = py.pg(xd, "id"), nameV = py.pg(xd, "name");
        const sid = py.str(py.truthy(sidV) ? sidV : "");
        const name = py.cpSlice(py.oneLine(py.str(py.truthy(nameV) ? nameV : "")), 0, 40);
        if (!/^[a-z0-9-]{1,24}\n?$/.test(sid) || seen.has(sid) || !name) throw bad("Each section needs a unique id and a name.");
        seen.add(sid);
        out.push({ id: sid, name });
      }
      assign(p, "sections", out);
    }
    if (Object.hasOwn(body, "placement")) {
      const pl = body.placement;
      if (!py.isDict(pl)) throw bad("placement must be an object.");
      const secIds = new Set(py.iter(py.pg(p, "sections")).map((x) => py.req(x, "id")));
      const clean = {};
      for (const k of keysOf(pl)) {
        const v = pl[k];
        if (!(py.has(lib.items, k) && py.isDict(v))) continue;
        if (secIds.size && !secIds.has(py.hashable(py.pg(v, "section")))) continue;
        const r = py.pg(v, "rank");
        const entry = { section: py.str(py.pg(v, "section")), rank: typeof r === "number" || typeof r === "boolean" ? Number(r) : 0 };
        markFloat(entry, "rank"); // float(r): Python writes 1.0 for a rank of 1
        assign(clean, k, entry);
      }
      assign(p, "placement", clean);
    }
    await this.saveUnlocked(lib);
    return { ...p };
  }

  async deleteProject(pid) {
    pid = asJson(pid);
    return this.withLock(() => this.deleteProjectUnlocked(pid));
  }

  async deleteProjectUnlocked(pid) {
    pid = asJson(pid);
    const lib = await this.loadUnlocked();
    const p = this._proj(lib, pid);
    for (const c of lib.projects) if (py.eq(py.pg(c, "parent"), pid)) assign(c, "parent", py.pg(p, "parent"));
    assign(lib, "projects", lib.projects.filter((x) => !py.eq(py.req(x, "id"), pid)));
    for (const key of keysOf(lib.items)) {
      const it = lib.items[key];
      if (py.inList(py.iterStrict(py.pg(it, "projects", [])), pid)) assign(it, "projects", it.projects.filter((x) => !py.eq(x, pid)));
    }
    await this.saveUnlocked(lib);
    const st = secStamp();
    for (const suffix of [".md", ".rev.json"]) {
      const src = `projects/${py.str(pid)}${suffix}`;
      if (await this._exists(src)) {
        // Python's shutil.move would replace an earlier file of the same name (same project id, same
        // second) and so lose it; nothing is ever hard-deleted, so a later one gets _2, _3, ...
        let dest = `_deleted/${st}_project_${py.str(pid)}${suffix}`;
        let n = 2;
        while (await this._exists(dest)) dest = `_deleted/${st}_project_${py.str(pid)}_${n++}${suffix}`;
        await this.fs.move(src, dest);
      }
    }
    return true;
  }

  // ---- search / bibtex --------------------------------------------------------------------------
  /** Library._snip: text around code point i (match of n code points), whitespace collapsed. */
  static snip(text, i, n) {
    const len = py.cpLen(text);
    const a = Math.max(0, i - 50), b = Math.min(len, i + n + 70);
    const s = py.strip(py.collapseWs(py.cpSlice(text, a, b)));
    return (a > 0 ? "…" : "") + s + (b < len ? "…" : "");
  }

  /** Python's text.lower().find(ql) as a code point index (-1 when absent); ql is already lower(). */
  static _find(text, ql) {
    const low = py.lower(text);
    const hi = (c) => c >= 0xd800 && c <= 0xdbff, lo = (c) => c >= 0xdc00 && c <= 0xdfff;
    for (let from = 0; ;) {
      const u = low.indexOf(ql, from);
      if (u < 0) return -1;
      const end = u + ql.length; // a match may not cut a surrogate pair (one character in Python)
      if (!(u > 0 && lo(ql.charCodeAt(0)) && hi(low.charCodeAt(u - 1)))
        && !(ql && hi(ql.charCodeAt(ql.length - 1)) && lo(low.charCodeAt(end)))) return py.cpLen(low.slice(0, u));
      from = u + 1;
    }
  }

  /** Library._fold: lower case without accents or compatibility forms (á -> a, ₂ -> 2), for search. */
  static fold(s) { return String(s).normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase(); }
  static words(q) { return Library.fold(q).split(/[\s\-‐-―/,;]+/u).filter(Boolean); }
  /** Library._match: [code point index, length] for the snippet when every word occurs in text, else [-1, 0]. */
  static match(text, words) {
    const f = Library.fold(text);
    if (!words.every((w) => f.includes(w))) return [-1, 0];
    let u = py.lower(text).indexOf(words[0]);
    let i = u >= 0 ? py.cpLen(py.lower(text).slice(0, u)) : Math.min(py.cpLen(f.slice(0, f.indexOf(words[0]))), Math.max(py.cpLen(text) - 1, 0));
    return [i, py.cpLen(words[0])];
  }

  async search(q) {
    q = asJson(q);
    q = py.strip(py.truthy(q) ? q : "");
    const words = Library.words(q);
    if (!words.length) return [];
    const lib = await this.load();
    const hits = [];
    for (const key of keysOf(lib.items)) {
      const it = lib.items[key];
      const abV = py.pg(it, "abstract");
      const ab = py.truthy(abV) ? abV : "";
      let [i, n] = Library.match(ab, words);
      if (i >= 0) hits.push({ key, where: "abstract", snippet: Library.snip(ab, i, n) });
      const np = `items/${key}/notes.md`;
      if (await this._exists(np)) {
        try {
          const bytes = await this.fs.readBytes(np);
          if (bytes !== null) {
            const txt = fromUtf8(bytes, { errors: "replace" });
            [i, n] = Library.match(txt, words);
            if (i >= 0) hits.push({ key, where: "notes", snippet: Library.snip(txt, i, n) });
          }
        } catch (e) {
          if (e?.name !== "FsError") throw e;
        }
      }
      for (const a of atts(it)) {
        const mp = `items/${key}/${py.str(py.req(a, "key"))}.marks.json`;
        if (!(await this._exists(mp))) continue;
        let marks;
        try {
          marks = py.pg(pyLoads(fromUtf8(await this.fs.readBytes(mp))), "marks", []);
        } catch {
          continue;
        }
        if (!Array.isArray(marks)) continue;
        // every matching mark is returned (no per-PDF cap). A mark matches when its note, suggested wording and
        // quote together hold every word; the snippet comes from the first of those fields with the first word.
        for (const m of marks) {
          if (!py.isDict(m)) continue;
          const vals = ["note", "suggest", "quote"].map((fld) => py.pg(m, fld)).filter((v) => typeof v === "string");
          if (!vals.length || Library.match(vals.join("\n"), words)[0] < 0) continue;
          const v = vals.find((x) => Library.match(x, words.slice(0, 1))[0] >= 0) || vals[0];
          [i, n] = Library.match(v, words.slice(0, 1));
          hits.push({ key, where: "marks", att: a.key, markId: py.pg(m, "id"), page: py.pg(m, "page"),
            type: py.pg(m, "type"), num: py.pg(m, "num"), snippet: Library.snip(v, Math.max(i, 0), n) });
          if (hits.length >= SEARCH_MAX_HITS) return hits;
        }
      }
      if (hits.length >= SEARCH_MAX_HITS) break;
    }
    return hits.slice(0, SEARCH_MAX_HITS);
  }

  async bibtex({ keys = null, project = null } = {}) {
    [keys, project] = [asJson(keys), asJson(project)];
    const lib = await this.load();
    let items;
    if (py.truthy(keys)) {
      items = py.iterStrict(keys).map((k) => this.getItem(lib, k));
    } else if (py.truthy(project)) {
      this._proj(lib, project);
      const tree = [project];
      for (let i = 0; i < tree.length; i++) {
        for (const p of lib.projects) if (py.eq(py.pg(p, "parent"), tree[i])) tree.push(py.req(p, "id"));
      }
      items = keysOf(lib.items).map((k) => lib.items[k])
        .filter((it) => !py.truthy(py.pg(it, "trashed")) && py.iterStrict(py.pg(it, "projects", [])).some((x) => tree.some((t) => py.eq(t, x))));
      items.sort((x, y) => pyCompare(py.req(x, "key"), py.req(y, "key")));
    } else {
      items = keysOf(lib.items).map((k) => lib.items[k]).filter((it) => !py.truthy(py.pg(it, "trashed")));
      items.sort((x, y) => pyCompare(py.req(x, "key"), py.req(y, "key")));
    }
    return items.map((it) => bibtexEntry(itemMeta(it), it.key)).join("\n");
  }
}
