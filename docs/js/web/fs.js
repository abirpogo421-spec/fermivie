// Storage adapters for the browser back end (WEB_CONTRACT.md section 5.1). Every adapter has the LibFS
// interface: name, kind, readOnly, readBytes, readText, readFile, stat, exists, list, write, mkdirp,
// remove, copy, move. Paths are POSIX and relative ("items/abc/main.pdf"); checkPath (fserror.js) refuses
// bad ones with FsError "Bad path". Errors are FsError with the codes listed in fserror.js, plus:
//   "denied"  the browser no longer lets the page use the folder (permission revoked, or never given)
//   "quota"   the browser's storage is full
//
//   new DirFS(handle, {kind = "folder" | "opfs", name, readOnly})
//       over a FileSystemDirectoryHandle: a folder from showDirectoryPicker, or OPFS. Duck-typed, so the test
//       look-alike in tests/web/mockhandle.js works too. write() replaces an existing file through
//       createWritable(): Chrome writes a swap file ("<name>.crswap") and swaps it in on close(), so readers see
//       the old or the new file, never half of one; on any error the stream is aborted and the old file
//       survives. A NEW file is written under a temporary name (".pm-write-...") and moved into place with
//       FileSystemFileHandle.move(), as Python writes a temp file and os.replace()s it: until it is complete
//       the file does not exist, and a crash leaves no empty file. Where move() is missing the file is created
//       empty first (no other way), and removed again if the write fails.
//       move(src, dst): a file moves with FileSystemFileHandle.move() when dst does not exist, else (and where
//       move() fails or is missing) it is copied, then the source is removed. Chrome can't move folders, so a
//       folder moves file by file into a new tree, then its folders are removed deepest first, each only once
//       it is empty. On a real folder Chrome neither lists nor opens some names (with ? : * " < > |, a space, dot
//       or ~ at either end, CON, desktop.ini, .lnk, .url, links ...); such a file keeps its folder from being
//       removed, and then every moved file goes back and move() fails with FsError "io": nothing is left half
//       moved and nothing is removed that was not moved first. Disks that fold case or Unicode form open
//       "Paper.pdf" for "paper.pdf" (macOS also "STRASSE.pdf" for "straße.pdf", "μm" for "µm" ...): when
//       dst exists, move() asks the folder whether the two names are two entries (both listed side by side);
//       if it can't tell, the move goes through a temporary name, so a file is never copied onto itself.
//       list() hides Chrome's "*.crswap" swap files and the ".pm-write-..." / ".pm-move-..." temporary names
//       (operations in progress); move() takes them along like any file. Folders report mtime 0.
//       readFile() returns Chrome's lazy, disk-backed File: once the file changes on disk, reading that File
//       fails (NotReadableError; NotFoundError once it is moved or removed), so read it soon or use
//       readBytes() (readBytes and copy read again when that happens). On real folders Chrome refuses the
//       names listed above, which OPFS allows: such a path gives FsError "bad-path" and is not listed.
//   DirFS.fromHandle(handle, opts)   checks permission first: readwrite granted -> writable; only read
//       granted -> readOnly; otherwise FsError "denied".
//   new IdbFS(dbName = "pm-web-library", {name = "Browser storage"})
//       one IndexedDB database, object store "files": path -> {data: Blob, size, mtime}. Folders are implicit
//       (a folder exists while a file lives under it), so mkdirp only checks that no file is in the way.
//       Every write, copy, remove and move is one transaction (all or nothing). close(), IdbFS.drop(dbName).
//   new ListFS(files, {name, strip = true})
//       read-only over a FileList from <input type=file webkitdirectory> (or any iterable of File, or of
//       {path, file}); webkitRelativePath minus its first segment (the picked folder's name) is the path.
//   ReadOnlyFS   the base class of ListFS and of zip.js's ZipFS.
//   opfsRoot(), openBrowserStorage({folder = "library", idbName = "pm-web-library"}) -> DirFS(OPFS) or IdbFS,
//   persistStorage(), storagePersisted(), supportsFolders(), supportsOpfsWritable()
//   rememberHandle(slot, value), recallHandle(slot), forgetHandle(slot): IndexedDB "pm-web", store "handles"
//       (slots "library" {kind, handle?, name, id}, "profile" {handle, name}, "watch" [{handle, name}]).
//   permissionOf(handle, mode = "readwrite") -> "granted" | "prompt" | "denied" ("granted" where the API has
//       no permissions, e.g. OPFS in Safari); requestPermissionOf(handle, mode) needs a click (user
//       activation); without one it returns "prompt" instead of throwing.
//   withLock(name, fn): runs fn alone among all callers using the same name: Web Locks
//       (navigator.locks.request, shared by every tab of the site) when present, else an in-page promise
//       chain (withLocalLock). NOT re-entrant: calling withLock(name, ...) again inside fn with the same name
//       waits forever. Public methods take the lock once and call internal *Unlocked helpers.

import { FsError, checkPath, cmpNames, readOnlyError, baseName } from "./fserror.js";
import { utf8, fromUtf8, pyCompare } from "./pyjson.js";

export { FsError };

const SWAP = ".crswap";

const MIME = { pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", json: "application/json",
  md: "text/markdown", txt: "text/plain", zip: "application/zip", bib: "text/plain", html: "text/html" };
/** A MIME type for a file name, "" when unknown. */
export function mimeOf(name) {
  const i = name.lastIndexOf(".");
  return i < 0 ? "" : MIME[name.slice(i + 1).toLowerCase()] || "";
}

const isDom = (e, ...names) => !!e && names.includes(e.name);

/** FsError for a DOMException (or anything else) thrown by the browser's storage APIs. */
export function storageError(e, path = "") {
  if (e instanceof FsError) return e;
  const opts = { path, cause: e };
  switch (e?.name) {
    case "NotAllowedError":
    case "SecurityError":
      return new FsError("Fermivie no longer has permission to use this folder. Reopen it to continue.", { ...opts, code: "denied" });
    case "QuotaExceededError":
      return new FsError("There is not enough storage space to save this.", { ...opts, code: "quota" });
    case "NoModificationAllowedError":
      return new FsError("The file is being written right now. Try again.", { ...opts, code: "io" });
    case "NotReadableError":
      return new FsError("The file could not be read. It may have changed or been removed.", { ...opts, code: "io" });
    case "NotFoundError":
      return new FsError("No such file or folder", { ...opts, code: "not-found" });
    case "TypeMismatchError":
      return new FsError("A file is where a folder should be, or a folder where a file should be.", { ...opts, code: "not-dir" });
    case "InvalidModificationError":
      return new FsError("Folder is not empty", { ...opts, code: "not-empty" });
    case "TypeError":
      // Chrome refuses some names on real folders that OPFS allows (for example "...").
      if (/Name is not allowed/.test(e.message)) {
        return new FsError(`This browser can't open a file or folder with this name: “${path}”.`, { ...opts, code: "bad-path" });
      }
      return new FsError(e.message, { ...opts, code: "io" });
    default:
      return new FsError(e?.message || String(e), { ...opts, code: "io" });
  }
}

/** write() input -> Uint8Array or Blob. A string is UTF-8 encoded first, so a bad one writes nothing. */
function toBody(data, path) {
  if (typeof data === "string") {
    try {
      return utf8(data);
    } catch (e) {
      throw new FsError(e.message, { code: "encode", path, cause: e });
    }
  }
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (typeof Blob !== "undefined" && data instanceof Blob) return data;
  throw new FsError("write() needs bytes, a string or a Blob", { code: "invalid", path });
}

function decode(bytes, path) {
  try {
    return fromUtf8(bytes);
  } catch (e) {
    throw new FsError(e.message, { code: "decode", path, cause: e });
  }
}

// Replace the contents of file handle fh with body through createWritable() (a swap file Chrome moves over the
// file on close()); on any error the stream is aborted, so the old contents survive. FsError keeps the browser's
// error as its cause (copy() reads a source again when that is NotReadableError).
async function writeHandle(fh, body, path) {
  let w;
  try {
    w = await fh.createWritable({ keepExistingData: false });
  } catch (e) {
    throw storageError(e, path);
  }
  try {
    await w.write(body);
    await w.close();
  } catch (e) {
    try { await w.abort(); } catch { /* already closed or errored */ }
    throw storageError(e, path);
  }
}

// A loose fold (compatibility forms, then case both ways: ß, ẞ and SS, ſ and s, µ and μ, ﬁ and fi, ϑ and θ end
// up equal). Only a cheap first look for a move into a folder's own subtree; the folder itself decides.
const loose = (s) => s.normalize("NFKD").toLowerCase().toUpperCase().toLowerCase().normalize("NFKC");

// Temporary names of operations in progress: ".pm-write-<id><ext>" (a new file until it is complete) and
// ".pm-move-<id><ext>" (a file or folder half way through a move). The extension is kept because Chrome checks
// a file on a real folder again when a move changes its extension.
let tmpSeq = 0;
const TMP_RE = /^\.pm-(?:write|move)-[0-9a-z]+-[0-9a-z]+-[0-9a-z]*(?:\.|$)/;
function tmpName(kind, name = "") {
  const base = `.pm-${kind}-${Date.now().toString(36)}-${(++tmpSeq).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot) : "";
  return ext && new TextEncoder().encode(base + ext).length <= 255 ? base + ext : base;
}
/** True for names list() leaves out: Chrome's swap files and DirFS's temporary names. */
export const isTempName = (name) => name.endsWith(SWAP) || TMP_RE.test(name);
const segsOf = (rel) => (rel ? rel.split("/") : []);
// A directory handle FileSystemFileHandle.move() accepts: the browser's own class where there is one (the test
// look-alike in tests/web/mockhandle.js passes as one); duck-typed only where the class doesn't exist (node).
const isDirHandle = (h) => (typeof globalThis.FileSystemDirectoryHandle === "function"
  ? h instanceof globalThis.FileSystemDirectoryHandle : !!h && h.kind === "directory" && typeof h.getFileHandle === "function");

// ---------------------------------------------------------------------------------------------------
// Locks

const chains = new Map();

/** The in-page fallback of withLock: a promise chain per name. Not re-entrant. */
export async function withLocalLock(name, fn) {
  const key = String(name);
  const prev = chains.get(key) || Promise.resolve();
  let release;
  const held = new Promise((r) => { release = r; });
  const tail = prev.then(() => held);
  chains.set(key, tail);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (chains.get(key) === tail) chains.delete(key);
  }
}

/** Run fn with the lock `name` held (Web Locks when present, else withLocalLock). Not re-entrant. */
export function withLock(name, fn) {
  const locks = globalThis.navigator?.locks;
  if (locks && typeof locks.request === "function") return locks.request(String(name), () => fn());
  return withLocalLock(name, fn);
}

// ---------------------------------------------------------------------------------------------------
// Feature checks, OPFS, persistence

export function supportsFolders() {
  return typeof globalThis.showDirectoryPicker === "function";
}

export function supportsOpfsWritable() {
  return typeof globalThis.navigator?.storage?.getDirectory === "function"
    && typeof globalThis.FileSystemFileHandle === "function"
    && "createWritable" in globalThis.FileSystemFileHandle.prototype;
}

/** The origin private file system's root directory handle. */
export async function opfsRoot() {
  if (typeof globalThis.navigator?.storage?.getDirectory !== "function") {
    throw new FsError("This browser has no private file storage.", { code: "io" });
  }
  try {
    return await navigator.storage.getDirectory();
  } catch (e) {
    throw storageError(e);
  }
}

/**
 * The browser-storage library: DirFS over OPFS `<folder>/` when OPFS can write files, else IdbFS(idbName).
 * Falls back to IndexedDB when OPFS is present but refuses (private windows in some browsers).
 */
export async function openBrowserStorage({ folder = "library", idbName = "pm-web-library", name = "Browser storage" } = {}) {
  if (supportsOpfsWritable()) {
    try {
      const root = await opfsRoot();
      const dir = await root.getDirectoryHandle(folder, { create: true });
      return new DirFS(dir, { kind: "opfs", name });
    } catch {
      // fall through to IndexedDB
    }
  }
  return new IdbFS(idbName, { name });
}

/** navigator.storage.persist(): true when the browser promises not to evict this site's storage. */
export async function persistStorage() {
  try {
    return !!(await globalThis.navigator?.storage?.persist?.());
  } catch {
    return false;
  }
}

export async function storagePersisted() {
  try {
    return !!(await globalThis.navigator?.storage?.persisted?.());
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------------------------------
// IndexedDB helpers, handle memory, permissions

/** Promise for an IDBRequest's result. */
export function idbReq(r) {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

/**
 * Open an IndexedDB database at its current version and make sure it has the given object stores: a store
 * that is missing is added with a version bump (js/web/setup.js opens "pm-web" the same way, so either side
 * can create it first).
 */
export function idbOpen(dbName, stores, version) {
  if (typeof globalThis.indexedDB === "undefined") {
    return Promise.reject(new FsError("This browser has no IndexedDB storage.", { code: "io" }));
  }
  return new Promise((resolve, reject) => {
    let r;
    try {
      r = version ? indexedDB.open(dbName, version) : indexedDB.open(dbName);
    } catch (e) {
      reject(storageError(e));
      return;
    }
    r.onupgradeneeded = () => {
      for (const s of stores) if (!r.result.objectStoreNames.contains(s)) r.result.createObjectStore(s);
    };
    r.onsuccess = () => {
      const db = r.result;
      if (stores.some((s) => !db.objectStoreNames.contains(s))) {
        const v = db.version + 1;
        db.close();
        resolve(idbOpen(dbName, stores, v));
        return;
      }
      db.onversionchange = () => db.close();
      resolve(db);
    };
    r.onerror = () => reject(storageError(r.error));
    r.onblocked = () => {}; // another tab holds the database open; onsuccess follows once it closes
  });
}

/** Run body(store) in one transaction; resolves with body's result after the transaction commits. */
export async function idbTx(db, storeName, mode, body) {
  const t = db.transaction(storeName, mode, mode === "readwrite" ? { durability: "strict" } : undefined);
  const done = new Promise((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new DOMException("The transaction was aborted.", "AbortError"));
  });
  let result;
  try {
    result = await body(t.objectStore(storeName), t);
  } catch (e) {
    try { t.abort(); } catch { /* already finished */ }
    await done.catch(() => {});
    throw e;
  }
  await done;
  return result;
}

const HANDLE_DB = "pm-web";
const HANDLE_STORE = "handles";

async function withHandleDb(mode, body) {
  const db = await idbOpen(HANDLE_DB, [HANDLE_STORE]);
  try {
    return await idbTx(db, HANDLE_STORE, mode, body);
  } finally {
    db.close();
  }
}

/** Keep value (structured-cloneable, may hold FileSystemHandles) under slot in IndexedDB "pm-web". */
export async function rememberHandle(slot, value) {
  try {
    await withHandleDb("readwrite", (s) => { s.put(value, String(slot)); });
  } catch (e) {
    if (e?.name === "DataCloneError") throw new FsError("This browser can't remember that folder.", { code: "io", cause: e });
    throw storageError(e);
  }
}

/** The value kept under slot, or null. */
export async function recallHandle(slot) {
  try {
    const v = await withHandleDb("readonly", (s) => idbReq(s.get(String(slot))));
    return v === undefined ? null : v;
  } catch (e) {
    throw storageError(e);
  }
}

export async function forgetHandle(slot) {
  try {
    await withHandleDb("readwrite", (s) => { s.delete(String(slot)); });
  } catch (e) {
    throw storageError(e);
  }
}

/** handle.queryPermission({mode}); "granted" when the browser has no permission API for the handle. */
export async function permissionOf(handle, mode = "readwrite") {
  if (!handle) return "denied";
  if (typeof handle.queryPermission !== "function") return "granted";
  try {
    return await handle.queryPermission({ mode });
  } catch {
    return "denied";
  }
}

/** handle.requestPermission({mode}); must run inside a click. Without user activation it returns "prompt". */
export async function requestPermissionOf(handle, mode = "readwrite") {
  if (!handle) return "denied";
  if (typeof handle.requestPermission !== "function") return "granted";
  try {
    return await handle.requestPermission({ mode });
  } catch (e) {
    if (isDom(e, "SecurityError", "NotAllowedError")) return "prompt";
    throw storageError(e);
  }
}

// ---------------------------------------------------------------------------------------------------
// DirFS: a FileSystemDirectoryHandle (picked folder or OPFS)

export class DirFS {
  constructor(handle, { kind = "folder", name, readOnly = false } = {}) {
    if (!handle || handle.kind !== "directory") throw new TypeError("DirFS needs a FileSystemDirectoryHandle");
    this.handle = handle;
    this.kind = kind;
    this.name = name ?? (kind === "opfs" ? "Browser storage" : handle.name || "Folder");
    this.readOnly = !!readOnly;
  }

  /** A DirFS whose readOnly follows the permission the page holds for handle. */
  static async fromHandle(handle, opts = {}) {
    if ((await permissionOf(handle, "readwrite")) === "granted") return new DirFS(handle, opts);
    if ((await permissionOf(handle, "read")) === "granted") return new DirFS(handle, { ...opts, readOnly: true });
    throw new FsError(`Fermivie needs permission to open “${handle.name}”.`, { code: "denied" });
  }

  _w(path) {
    if (this.readOnly) throw readOnlyError(path);
  }

  // The directory handle at segs, or null when it is missing or a file is in the way.
  async _dirOrNull(segs) {
    let d = this.handle;
    for (const s of segs) {
      try {
        d = await d.getDirectoryHandle(s);
      } catch (e) {
        if (isDom(e, "NotFoundError", "TypeMismatchError")) return null;
        throw storageError(e, segs.join("/"));
      }
    }
    return d;
  }

  // The directory handle at segs, made (with its parents) when missing; a file in the way -> "not-dir".
  async _dirMake(segs, path) {
    let d = this.handle;
    for (const s of segs) {
      try {
        d = await d.getDirectoryHandle(s, { create: true });
      } catch (e) {
        if (isDom(e, "TypeMismatchError")) throw new FsError("Not a folder", { code: "not-dir", path, cause: e });
        throw storageError(e, path);
      }
    }
    return d;
  }

  // The File at segs (a lazy, disk-backed snapshot), null when missing; FsError "is-dir" for a folder.
  async _getFile(segs, path) {
    const parent = await this._dirOrNull(segs.slice(0, -1));
    if (!parent) return null;
    let fh;
    try {
      fh = await parent.getFileHandle(segs[segs.length - 1]);
    } catch (e) {
      if (isDom(e, "NotFoundError")) return null;
      if (isDom(e, "TypeMismatchError")) throw new FsError("Is a folder", { code: "is-dir", path, cause: e });
      throw storageError(e, path);
    }
    try {
      return await fh.getFile();
    } catch (e) {
      if (isDom(e, "NotFoundError")) return null;
      throw storageError(e, path);
    }
  }

  async readBytes(path) {
    const segs = checkPath(path);
    for (let attempt = 0; ; attempt++) {
      const f = await this._getFile(segs, path);
      if (!f) return null;
      try {
        return new Uint8Array(await f.arrayBuffer());
      } catch (e) {
        // The file was replaced, moved or removed between getFile() and the read (another tab or app saved
        // it): read again (null when it is gone).
        if (isDom(e, "NotReadableError", "NotFoundError") && attempt < 3) continue;
        throw storageError(e, path);
      }
    }
  }

  async readText(path) {
    const b = await this.readBytes(path);
    return b === null ? null : decode(b, path);
  }

  async readFile(path) {
    return this._getFile(checkPath(path), path);
  }

  async stat(path) {
    const segs = checkPath(path, { allowRoot: true });
    if (!segs.length) return { size: 0, mtime: 0, kind: "dir" };
    const parent = await this._dirOrNull(segs.slice(0, -1));
    if (!parent) return null;
    const name = segs[segs.length - 1];
    try {
      const f = await (await parent.getFileHandle(name)).getFile();
      return { size: f.size, mtime: f.lastModified, kind: "file" };
    } catch (e) {
      if (isDom(e, "NotFoundError")) return null;
      if (!isDom(e, "TypeMismatchError")) throw storageError(e, path);
    }
    try {
      await parent.getDirectoryHandle(name);
      return { size: 0, mtime: 0, kind: "dir" };
    } catch (e) {
      if (isDom(e, "NotFoundError", "TypeMismatchError")) return null;
      throw storageError(e, path);
    }
  }

  async exists(path) {
    return (await this.stat(path)) !== null;
  }

  async list(dir) {
    const d = await this._dirOrNull(checkPath(dir, { allowRoot: true }));
    if (!d) return [];
    const out = [];
    try {
      for await (const [name, h] of d.entries()) {
        if (isTempName(name)) continue; // a write or move in progress
        out.push({ name, kind: h.kind === "directory" ? "dir" : "file" });
      }
    } catch (e) {
      if (isDom(e, "NotFoundError")) return [];
      throw storageError(e, dir);
    }
    return out.sort(cmpNames);
  }

  async write(path, data) {
    this._w(path);
    const segs = checkPath(path);
    const body = toBody(data, path);
    const parent = await this._dirMake(segs.slice(0, -1), path);
    await this._writeIn(parent, segs[segs.length - 1], body, path);
  }

  // Atomic replace of parent/name with body (Uint8Array or Blob): an existing file through createWritable(), a
  // new one under a temporary name that is moved into place once it is complete.
  async _writeIn(parent, name, body, path) {
    let fh;
    try {
      fh = await parent.getFileHandle(name);
    } catch (e) {
      if (isDom(e, "TypeMismatchError")) throw new FsError("Is a folder", { code: "is-dir", path, cause: e });
      if (!isDom(e, "NotFoundError")) throw storageError(e, path);
      return this._writeNew(parent, name, body, path);
    }
    await writeHandle(fh, body, path);
  }

  async _writeNew(parent, name, body, path) {
    if (this._fileMove !== false) {
      const tmp = tmpName("write", name);
      let th = null;
      try {
        th = await parent.getFileHandle(tmp, { create: true });
      } catch {
        // the direct write below reports what is wrong
      }
      if (th && typeof th.move !== "function") {
        this._fileMove = false; // this browser can't move files: don't try again
        await parent.removeEntry(tmp).catch(() => {});
        th = null;
      }
      if (th) {
        try {
          await writeHandle(th, body, path);
        } catch (e) {
          await parent.removeEntry(tmp).catch(() => {});
          throw e;
        }
        try {
          await th.move(name);
          return;
        } catch {
          // Something took the name meanwhile (a folder, a file being written), or this storage can't move:
          // write it directly; that says what is wrong if it can't be done either.
          try {
            await this._writeDirect(parent, name, body, path);
          } finally {
            await parent.removeEntry(tmp).catch(() => {});
          }
          return;
        }
      }
    }
    await this._writeDirect(parent, name, body, path);
  }

  // The fallback without move(): create the file (empty), then write it; a failed first write removes it again.
  async _writeDirect(parent, name, body, path) {
    let fh, fresh = false;
    try {
      fh = await parent.getFileHandle(name);
    } catch (e) {
      if (isDom(e, "TypeMismatchError")) throw new FsError("Is a folder", { code: "is-dir", path, cause: e });
      if (!isDom(e, "NotFoundError")) throw storageError(e, path);
      try {
        fh = await parent.getFileHandle(name, { create: true });
        fresh = true;
      } catch (e2) {
        if (isDom(e2, "TypeMismatchError")) throw new FsError("Is a folder", { code: "is-dir", path, cause: e2 });
        throw storageError(e2, path);
      }
    }
    try {
      await writeHandle(fh, body, path);
    } catch (e) {
      // remove the empty file a failed first write left behind (unless another write has filled it since)
      if (fresh) {
        try {
          if ((await fh.getFile()).size === 0) await parent.removeEntry(name);
        } catch {
          // best effort
        }
      }
      throw e;
    }
  }

  async mkdirp(dir) {
    this._w(dir);
    await this._dirMake(checkPath(dir, { allowRoot: true }), dir);
  }

  async remove(path, { recursive = false } = {}) {
    this._w(path);
    const segs = checkPath(path);
    const parent = await this._dirOrNull(segs.slice(0, -1));
    if (!parent) return;
    try {
      await parent.removeEntry(segs[segs.length - 1], { recursive: !!recursive });
    } catch (e) {
      if (isDom(e, "NotFoundError")) return;
      if (isDom(e, "InvalidModificationError")) throw new FsError("Folder is not empty", { code: "not-empty", path, cause: e });
      throw storageError(e, path);
    }
  }

  async copy(src, dst) {
    this._w(dst);
    const a = checkPath(src), b = checkPath(dst);
    for (let attempt = 0; ; attempt++) {
      const f = await this._getFile(a, src);
      if (!f) throw new FsError("No such file", { code: "not-found", path: src });
      const parent = await this._dirMake(b.slice(0, -1), dst);
      try {
        await this._writeIn(parent, b[b.length - 1], f, dst);
        return;
      } catch (e) {
        // the source was replaced (or moved away) while it was being copied: copy what is there now
        if (isDom(e.cause, "NotReadableError", "NotFoundError") && attempt < 3) continue;
        throw e;
      }
    }
  }

  async move(src, dst) {
    this._w(dst);
    const a = checkPath(src), b = checkPath(dst);
    const sa = await this.stat(src);
    if (!sa) throw new FsError("No such file or folder", { code: "not-found", path: src });
    if (src === dst) return;
    if (dst.startsWith(src + "/") || (await this._aliasInside(a, b))) {
      throw new FsError("Can't move a folder into itself", { code: "invalid", path: dst });
    }
    const sb = await this.stat(dst);
    if (!sb) return this._moveNew(a, b, sa.kind);
    if (sa.kind === sb.kind && (await this._maybeSame(a, b))) return this._moveVia(a, b, sa.kind);
    return this._moveOnto(a, b, sa.kind, sb.kind);
  }

  // Could a and b (different strings; b exists) be one entry? A disk that folds case or Unicode form opens
  // "Paper.pdf" for "paper.pdf", by rules that differ between systems (macOS: ß and SS, µ and μ, ﬁ and fi ...),
  // so ask the folder: below their common folder, two different names it lists side by side are two entries.
  async _maybeSame(a, b) {
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    if (i >= a.length || i >= b.length) return true;
    const d = await this._dirOrNull(a.slice(0, i)).catch(() => null);
    if (!d) return true;
    let seenA = false, seenB = false;
    try {
      for await (const [n] of d.entries()) {
        if (n === a[i]) seenA = true;
        else if (n === b[i]) seenB = true;
        if (seenA && seenB) return false;
      }
    } catch {
      return true;
    }
    return true;
  }

  // dst inside src through a folding disk ("Items/k" -> "items/k/sub"): refused like dst.startsWith(src + "/").
  async _aliasInside(a, b) {
    if (b.length <= a.length) return false;
    const head = b.slice(0, a.length);
    if (head.some((s, i) => loose(s) !== loose(a[i]))) return false;
    if (!(await this.stat(head.join("/")))) return false;
    return this._maybeSame(a, head);
  }

  // dst is an existing entry other than src: a file replaces a file (os.replace); anything else is refused.
  async _moveOnto(a, b, kind, dstKind) {
    const src = a.join("/"), dst = b.join("/");
    if (dstKind === "dir") {
      throw new FsError(kind === "dir" ? "Already exists" : "Is a folder", { code: kind === "dir" ? "exists" : "is-dir", path: dst });
    }
    if (kind === "dir") throw new FsError("Already exists", { code: "exists", path: dst });
    await this.copy(src, dst);
    await this.remove(src);
  }

  // src and dst may be one entry (a case-only rename on a folding disk): move src to a temporary name first, so
  // nothing is ever copied onto itself, then on to dst; on failure it goes back to src.
  async _moveVia(a, b, kind) {
    const t = [...a.slice(0, -1), tmpName("move", a[a.length - 1])];
    await this._moveNew(a, t, kind);
    try {
      const sb = await this.stat(b.join("/"));
      if (!sb) await this._moveNew(t, b, kind);
      else await this._moveOnto(t, b, kind, sb.kind); // dst was another entry after all
    } catch (e) {
      await this._moveNew(t, a, kind).catch(() => {});
      throw e;
    }
  }

  // Move a to b, where nothing exists at b.
  _moveNew(a, b, kind) {
    return kind === "file" ? this._transferFile(a, b) : this._moveTree(a, b);
  }

  // Move file a to b (nothing at b): FileSystemFileHandle.move() where it works, else copy and remove.
  async _transferFile(a, b) {
    const src = a.join("/"), dst = b.join("/");
    const to = await this._dirMake(b.slice(0, -1), dst);
    if (this._fileMove !== false) {
      const from = await this._dirOrNull(a.slice(0, -1));
      let fh = null;
      try {
        fh = from && (await from.getFileHandle(a[a.length - 1]));
      } catch (e) {
        if (!isDom(e, "NotFoundError", "TypeMismatchError")) throw storageError(e, src);
      }
      if (!fh) throw new FsError("No such file", { code: "not-found", path: src });
      // Only with a real directory handle: given anything else, Chrome's move(x) renames the file to String(x).
      if (typeof fh.move === "function" && isDirHandle(to)) {
        try {
          await fh.move(to, b[b.length - 1]);
          if (fh.name === b[b.length - 1]) return;
          throw new FsError(`The file was moved to “${fh.name}” instead of “${dst}”.`, { code: "io", path: dst });
        } catch (e) {
          if (e instanceof FsError) throw e;
          // Not moved (for example a handle of another kind, or the file is being written): look before copying.
          if (!(await this.exists(src))) {
            if (await this.exists(dst)) return;
            throw storageError(e, src);
          }
        }
      } else if (typeof fh.move !== "function") {
        this._fileMove = false;
      }
    }
    await this.copy(src, dst);
    try {
      await this.remove(src);
    } catch (e) {
      await this.remove(dst).catch(() => {}); // the source stays; don't leave a second copy
      throw e;
    }
  }

  // Move folder a to b (nothing at b). Chrome has no FileSystemDirectoryHandle.move(), so: list the whole tree
  // first (folders made under b while moving are then never walked), make every folder at b, then folder by
  // folder, deepest first, move its files and remove it, which only works once it is empty. A file the page
  // can't see (a name Chrome hides on real folders, or one added meanwhile) keeps its folder from being
  // removed: then every moved file goes back, and the move fails without having changed anything.
  async _moveTree(a, b) {
    const src = a.join("/"), dst = b.join("/");
    const from = await this._dirOrNull(a);
    if (!from) throw new FsError("No such file or folder", { code: "not-found", path: src });
    const dirs = []; // {rel, files} in pre-order (a folder before the folders in it)
    const walk = async (h, rel) => {
      const node = { rel, files: [] };
      dirs.push(node);
      const kids = [];
      try {
        for await (const [n, k] of h.entries()) kids.push([n, k]);
      } catch (e) {
        throw storageError(e, rel ? `${src}/${rel}` : src);
      }
      kids.sort((x, y) => pyCompare(x[0], y[0]));
      for (const [n, k] of kids) {
        if (k.kind === "directory") await walk(k, rel ? `${rel}/${n}` : n);
        else node.files.push(n);
      }
    };
    await walk(from, "");
    const at = (base, rel) => [...base, ...segsOf(rel)];
    const moved = []; // files now at b
    try {
      for (const node of dirs) await this._dirMake(at(b, node.rel), dst);
      for (const node of [...dirs].reverse()) {
        for (const f of node.files) {
          const rel = node.rel ? `${node.rel}/${f}` : f;
          await this._transferFile(at(a, rel), at(b, rel));
          moved.push(rel);
        }
        await this._removeEmptyDir(at(a, node.rel), src);
      }
    } catch (e) {
      const stuck = await this._unmoveTree(a, b, dirs, moved);
      if (stuck.length) {
        e.message += ` ${stuck.length === 1 ? "One file" : `${stuck.length} files`} could not be put back and ${stuck.length === 1 ? "is" : "are"} in “${dst}”.`;
      }
      throw e;
    }
  }

  // Remove the folder at segs if it is empty. Not empty after its files were moved = it holds entries this page
  // can't see.
  async _removeEmptyDir(segs, src) {
    const parent = await this._dirOrNull(segs.slice(0, -1));
    if (!parent) return;
    try {
      await parent.removeEntry(segs[segs.length - 1]);
    } catch (e) {
      if (isDom(e, "NotFoundError")) return;
      if (isDom(e, "InvalidModificationError")) {
        throw new FsError(`Some files in “${src}” can't be moved, so nothing was moved. This browser can't open names `
          + "with ? : * \" < > |, names that start or end with a space, dot or ~, nor links. Rename those files, then try again.", { code: "io", path: segs.join("/"), cause: e });
      }
      throw storageError(e, segs.join("/"));
    }
  }

  // Undo a failed _moveTree: make a's folders again, move the moved files back, remove what was made at b
  // (only folders that are empty again). Returns the files that could not be moved back.
  async _unmoveTree(a, b, dirs, moved) {
    for (const node of dirs) await this._dirMake([...a, ...segsOf(node.rel)], a.join("/")).catch(() => {});
    const stuck = [];
    for (const rel of [...moved].reverse()) {
      try {
        await this._transferFile([...b, ...segsOf(rel)], [...a, ...segsOf(rel)]);
      } catch {
        stuck.push(rel);
      }
    }
    for (const node of [...dirs].reverse()) {
      const segs = [...b, ...segsOf(node.rel)];
      const parent = await this._dirOrNull(segs.slice(0, -1)).catch(() => null);
      await parent?.removeEntry(segs[segs.length - 1]).catch(() => {});
    }
    return stuck;
  }
}

// ---------------------------------------------------------------------------------------------------
// IdbFS: files in one IndexedDB database, folders implicit

const FILES = "files";
// Every key below folder p: "p/" <= key < "p0" ("0" follows "/"), exactly the keys that start with "p/".
const under = (p) => IDBKeyRange.bound(p + "/", p + "0", false, true);

export class IdbFS {
  constructor(dbName = "pm-web-library", { name = "Browser storage", readOnly = false } = {}) {
    this.dbName = dbName;
    this.name = name;
    this.kind = "idb";
    this.readOnly = !!readOnly;
    this._db = null;
  }

  /** Delete a whole IdbFS database (tests, "start over"). */
  static drop(dbName) {
    return new Promise((resolve, reject) => {
      const r = indexedDB.deleteDatabase(dbName);
      r.onsuccess = () => resolve();
      r.onerror = () => reject(storageError(r.error));
      r.onblocked = () => {};
    });
  }

  close() {
    const p = this._db;
    this._db = null;
    p?.then((db) => db.close(), () => {});
  }

  _w(path) {
    if (this.readOnly) throw readOnlyError(path);
  }

  async _tx(mode, body, path = "") {
    if (!this._db) {
      this._db = idbOpen(this.dbName, [FILES]).then((db) => {
        const drop = () => { if (this._db === p) this._db = null; };
        db.addEventListener("close", drop);
        db.addEventListener("versionchange", drop);
        return db;
      });
      const p = this._db;
      p.catch(() => { if (this._db === p) this._db = null; });
    }
    try {
      return await idbTx(await this._db, FILES, mode, body);
    } catch (e) {
      throw storageError(e, path);
    }
  }

  // Throws "not-dir" when a file sits where one of segs' parent folders (or, with self, segs itself) would be.
  static async _noFileOnTheWay(s, segs, path, self = false) {
    const n = self ? segs.length : segs.length - 1;
    for (let i = 1; i <= n; i++) {
      if ((await idbReq(s.getKey(segs.slice(0, i).join("/")))) !== undefined) {
        throw new FsError("Not a folder", { code: "not-dir", path });
      }
    }
  }

  static async _isDir(s, p) {
    return (await idbReq(s.getKey(under(p)))) !== undefined;
  }

  async _record(path) {
    const p = checkPath(path).join("/");
    return this._tx("readonly", async (s) => {
      const rec = await idbReq(s.get(p));
      if (rec) return rec;
      if (await IdbFS._isDir(s, p)) throw new FsError("Is a folder", { code: "is-dir", path });
      return null;
    }, path);
  }

  async readBytes(path) {
    const rec = await this._record(path);
    if (!rec) return null;
    try {
      return new Uint8Array(await rec.data.arrayBuffer());
    } catch (e) {
      throw storageError(e, path);
    }
  }

  async readText(path) {
    const b = await this.readBytes(path);
    return b === null ? null : decode(b, path);
  }

  async readFile(path) {
    const rec = await this._record(path);
    if (!rec) return null;
    const name = baseName(path);
    return new File([rec.data], name, { type: rec.data.type || mimeOf(name), lastModified: rec.mtime });
  }

  async stat(path) {
    const segs = checkPath(path, { allowRoot: true });
    if (!segs.length) return { size: 0, mtime: 0, kind: "dir" };
    const p = segs.join("/");
    return this._tx("readonly", async (s) => {
      const rec = await idbReq(s.get(p));
      if (rec) return { size: rec.size, mtime: rec.mtime, kind: "file" };
      return (await IdbFS._isDir(s, p)) ? { size: 0, mtime: 0, kind: "dir" } : null;
    }, path);
  }

  async exists(path) {
    return (await this.stat(path)) !== null;
  }

  async list(dir) {
    const p = checkPath(dir, { allowRoot: true }).join("/");
    const keys = await this._tx("readonly", (s) => idbReq(p ? s.getAllKeys(under(p)) : s.getAllKeys()), dir);
    const pre = p ? p.length + 1 : 0;
    const kinds = new Map();
    for (const k of keys) {
      const rest = k.slice(pre);
      const i = rest.indexOf("/");
      if (i < 0) kinds.set(rest, "file");
      else kinds.set(rest.slice(0, i), "dir");
    }
    return [...kinds].map(([name, kind]) => ({ name, kind })).sort(cmpNames);
  }

  async write(path, data) {
    this._w(path);
    const segs = checkPath(path);
    const p = segs.join("/");
    const body = toBody(data, path);
    const blob = body instanceof Blob ? body : new Blob([body]);
    const rec = { data: blob, size: blob.size, mtime: Date.now() };
    await this._tx("readwrite", async (s) => {
      await IdbFS._noFileOnTheWay(s, segs, path);
      if (await IdbFS._isDir(s, p)) throw new FsError("Is a folder", { code: "is-dir", path });
      s.put(rec, p);
    }, path);
  }

  async mkdirp(dir) {
    this._w(dir);
    const segs = checkPath(dir, { allowRoot: true });
    if (!segs.length) return;
    await this._tx("readonly", (s) => IdbFS._noFileOnTheWay(s, segs, dir, true), dir);
  }

  async remove(path, { recursive = false } = {}) {
    this._w(path);
    const p = checkPath(path).join("/");
    await this._tx("readwrite", async (s) => {
      if ((await idbReq(s.getKey(p))) !== undefined) {
        s.delete(p);
        return;
      }
      if (!(await IdbFS._isDir(s, p))) return;
      if (!recursive) throw new FsError("Folder is not empty", { code: "not-empty", path });
      s.delete(under(p));
    }, path);
  }

  async copy(src, dst) {
    this._w(dst);
    const a = checkPath(src).join("/"), bs = checkPath(dst), b = bs.join("/");
    await this._tx("readwrite", async (s) => {
      const rec = await idbReq(s.get(a));
      if (!rec) {
        if (await IdbFS._isDir(s, a)) throw new FsError("Is a folder", { code: "is-dir", path: src });
        throw new FsError("No such file", { code: "not-found", path: src });
      }
      await IdbFS._noFileOnTheWay(s, bs, dst);
      if (await IdbFS._isDir(s, b)) throw new FsError("Is a folder", { code: "is-dir", path: dst });
      s.put({ data: rec.data, size: rec.size, mtime: Date.now() }, b);
    }, dst);
  }

  async move(src, dst) {
    this._w(dst);
    const a = checkPath(src).join("/"), bs = checkPath(dst), b = bs.join("/");
    await this._tx("readwrite", async (s) => {
      const rec = await idbReq(s.get(a));
      const isDir = !rec && (await IdbFS._isDir(s, a));
      if (!rec && !isDir) throw new FsError("No such file or folder", { code: "not-found", path: src });
      if (a === b) return;
      if (b.startsWith(a + "/")) throw new FsError("Can't move a folder into itself", { code: "invalid", path: dst });
      if (await IdbFS._isDir(s, b)) {
        throw new FsError(isDir ? "Already exists" : "Is a folder", { code: isDir ? "exists" : "is-dir", path: dst });
      }
      if (isDir && (await idbReq(s.getKey(b))) !== undefined) throw new FsError("Already exists", { code: "exists", path: dst });
      await IdbFS._noFileOnTheWay(s, bs, dst);
      if (rec) {
        s.put(rec, b);
        s.delete(a);
        return;
      }
      const range = under(a);
      const [keys, recs] = await Promise.all([idbReq(s.getAllKeys(range)), idbReq(s.getAll(range))]);
      for (let i = 0; i < keys.length; i++) s.put(recs[i], b + keys[i].slice(a.length));
      s.delete(range); // same transaction: the copies and the removal commit together or not at all
    }, dst);
  }
}

// ---------------------------------------------------------------------------------------------------
// Read-only trees: ListFS here, ZipFS in zip.js

export class ReadOnlyFS {
  constructor({ name, kind }) {
    this.name = name;
    this.kind = kind;
    this.readOnly = true;
    this._files = new Map(); // path -> entry (adapter specific)
    this._kids = new Map([["", new Map()]]); // folder path -> Map(name -> "file" | "dir")
  }

  // Add a file (or, with dir = true, a folder) at a validated path. Returns false when a file and a folder
  // would share the path.
  _add(path, entry, dir = false) {
    const segs = path.split("/");
    for (let i = 0; i < segs.length; i++) {
      const parent = segs.slice(0, i).join("/");
      const here = segs.slice(0, i + 1).join("/");
      const kind = dir || i < segs.length - 1 ? "dir" : "file";
      const had = this._kids.get(parent).get(segs[i]);
      if (had && had !== kind) return false;
      this._kids.get(parent).set(segs[i], kind);
      if (kind === "dir" && !this._kids.has(here)) this._kids.set(here, new Map());
    }
    if (!dir) this._files.set(path, entry);
    return true;
  }

  // Subclasses: async _bytes(path, entry) -> Uint8Array; async _file(path, entry) -> File.
  _entry(path, allowRoot = false) {
    const p = checkPath(path, { allowRoot }).join("/");
    return [p, this._files.get(p)];
  }

  async readBytes(path) {
    const [p, e] = this._entry(path);
    if (e === undefined) {
      if (this._kids.has(p)) throw new FsError("Is a folder", { code: "is-dir", path });
      return null;
    }
    return this._bytes(p, e);
  }

  async readText(path) {
    const b = await this.readBytes(path);
    return b === null ? null : decode(b, path);
  }

  async readFile(path) {
    const [p, e] = this._entry(path);
    if (e === undefined) {
      if (this._kids.has(p)) throw new FsError("Is a folder", { code: "is-dir", path });
      return null;
    }
    return this._file(p, e);
  }

  async stat(path) {
    const [p, e] = this._entry(path, true);
    if (e !== undefined) return this._stat(p, e);
    return this._kids.has(p) ? { size: 0, mtime: 0, kind: "dir" } : null;
  }

  async exists(path) {
    return (await this.stat(path)) !== null;
  }

  async list(dir) {
    const p = checkPath(dir, { allowRoot: true }).join("/");
    const kids = this._kids.get(p);
    if (!kids) return [];
    return [...kids].map(([name, kind]) => ({ name, kind })).sort(cmpNames);
  }

  async write(path) { throw readOnlyError(path); }
  async mkdirp(dir) { throw readOnlyError(dir); }
  async remove(path) { throw readOnlyError(path); }
  async copy(src, dst) { throw readOnlyError(dst); }
  async move(src, dst) { throw readOnlyError(dst); }
}

/**
 * Read-only LibFS over the files of <input type=file webkitdirectory> (or any iterable of File, or of
 * {path, file}). Paths come from webkitRelativePath without its first segment (the chosen folder). Files
 * whose path is not a valid LibFS path are left out and counted in fs.skipped.
 */
export class ListFS extends ReadOnlyFS {
  constructor(files, { name, strip = true } = {}) {
    super({ name: name || "", kind: "list" });
    this.skipped = 0;
    let first = "";
    for (const item of files || []) {
      const file = item instanceof Blob ? item : item?.file;
      if (!(file instanceof Blob)) { this.skipped++; continue; }
      let rel = item instanceof Blob ? file.webkitRelativePath || file.name : String(item.path ?? "");
      if (item instanceof Blob && strip && file.webkitRelativePath) {
        const i = rel.indexOf("/");
        if (!first) first = i < 0 ? "" : rel.slice(0, i);
        rel = i < 0 ? rel : rel.slice(i + 1);
      }
      try {
        checkPath(rel);
      } catch {
        this.skipped++;
        continue;
      }
      if (!this._add(rel, file)) this.skipped++;
    }
    if (!this.name) this.name = first || "Chosen files";
  }

  async _bytes(path, file) {
    try {
      return new Uint8Array(await file.arrayBuffer());
    } catch (e) {
      if (isDom(e, "NotReadableError")) {
        throw new FsError("A file changed after the folder was chosen. Choose the folder again.", { code: "io", path, cause: e });
      }
      throw storageError(e, path);
    }
  }

  async _file(path, file) {
    return file;
  }

  _stat(path, file) {
    return { size: file.size, mtime: file.lastModified, kind: "file" };
  }
}
