// FsError and path rules shared by every LibFS adapter (WEB_CONTRACT.md section 5.1): js/web/fs.js,
// js/web/zip.js and the test-only tests/web/nodefs.mjs all import from here, so `instanceof FsError`
// and `err.name === "FsError"` hold whichever adapter threw. fs.js re-exports FsError.
//
// Error codes (err.code):
//   "bad-path"   a path segment is "", ".", "..", or holds "/", "\" or NUL; or the path is not a string
//   "read-only"  a write on a read-only adapter
//   "not-found"  copy/move source missing
//   "is-dir"     a file operation on a folder
//   "not-dir"    a file sits where a folder is needed
//   "not-empty"  remove(dir) without {recursive: true} on a folder that has entries
//   "exists"     move onto an existing folder, or a folder onto an existing file
//   "invalid"    a folder moved into itself; unsupported data for write()
//   "decode"     readText: bytes are not UTF-8 (message is Python's UnicodeDecodeError text)
//   "encode"     write: a string with a lone surrogate (message is Python's UnicodeEncodeError text)
//   "io"         anything else from the underlying storage

import { pyCompare } from "./pyjson.js";

export class FsError extends Error {
  constructor(message, { code = "io", path = "", cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "FsError";
    this.code = code;
    this.path = path;
  }
}

/**
 * Validate a LibFS path and return its segments. "" means the root and is accepted only with
 * {allowRoot: true} (list, stat, exists, mkdirp). Throws FsError("Bad path") otherwise.
 */
export function checkPath(path, { allowRoot = false } = {}) {
  if (typeof path !== "string") throw new FsError("Bad path", { code: "bad-path", path: String(path) });
  if (path === "") {
    if (allowRoot) return [];
    throw new FsError("Bad path", { code: "bad-path", path });
  }
  const segs = path.split("/");
  for (const s of segs) {
    if (s === "" || s === "." || s === ".." || s.includes("\\") || s.includes("\0")) {
      throw new FsError("Bad path", { code: "bad-path", path });
    }
  }
  return segs;
}

/** Order for list(): by code point, as Python's sorted() orders os.listdir() names. */
export function cmpNames(a, b) {
  return pyCompare(a.name ?? a, b.name ?? b);
}

export function readOnlyError(path = "") {
  return new FsError("This storage is read-only.", { code: "read-only", path });
}

/** Parent folder of a validated path ("" for a top-level name). */
export function parentOf(path) {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

/** Last segment of a validated path. */
export function baseName(path) {
  return path.slice(path.lastIndexOf("/") + 1);
}
