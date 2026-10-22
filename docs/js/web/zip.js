// Zip files for the browser back end (WEB_CONTRACT.md section 5.2). No dependencies: deflate and inflate
// come from CompressionStream / DecompressionStream("deflate-raw"). Runs in pages and in node (>= 21).
//
//   readZip(blob, {name}) -> ZipFS, a read-only LibFS (kind "zip") over the zip's entries. Only the end
//       record and the central directory are read up front; entries are read (and checked against their
//       CRC-32 and size) when asked for. Stored and deflated entries; UTF-8 names (the UTF-8 flag, the
//       Info-ZIP Unicode path field, else UTF-8 when the bytes are valid UTF-8, else code page 437 like
//       Python's zipfile); MS-DOS times, or the extended timestamp field when present. Data in front of the
//       zip (self-extractors) is allowed, as in Python. Refused with an FsError and a plain message: not a
//       zip, zip64, encrypted entries, split archives, names that are not safe LibFS paths ("..", absolute,
//       empty segments), a file and a folder with the same name, damaged headers. A "." segment ("./x" from
//       macOS tar, "a/./b") is dropped, as Python's zipfile does when it extracts. An entry compressed with
//       another method (bzip2, LZMA...) is listed but reading it fails with a message naming it.
//       Duplicate names: the last entry wins, as in Python's zipfile.
//   writeZip(entries, {comment}) -> Blob ("application/zip"). entries: an array or (async) iterable of
//       {path, data, mtime?}; data is a Uint8Array, ArrayBuffer, string (UTF-8) or Blob; a path ending in
//       "/" or {path, dir: true} makes a folder entry. Each file is deflated and stored instead when that is
//       not smaller. mtime: a Date or epoch ms (default: pyjson's clock), written as an MS-DOS local time.
//       Names are UTF-8, with the UTF-8 flag set when not plain ASCII. Refuses bad paths, the same path
//       twice, and anything that would need zip64 (a file or the whole zip of 4 GB or more, 65,535+ entries).
//   crc32(bytes, crc = 0) -> the CRC-32 (unsigned) of bytes, continuing from crc.

import { FsError, checkPath, baseName } from "./fserror.js";
import { utf8, fromUtf8, nowMs } from "./pyjson.js";
import { ReadOnlyFS, mimeOf } from "./fs.js";

// ---------------------------------------------------------------------------------------------------
// CRC-32 (the zip / zlib polynomial)

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes, crc = 0) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes.buffer ?? bytes, bytes.byteOffset ?? 0, bytes.byteLength);
  let c = (crc ^ 0xffffffff) >>> 0;
  for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ---------------------------------------------------------------------------------------------------
// Shared bits

const SIG_LOCAL = 0x04034b50, SIG_CENTRAL = 0x02014b50, SIG_END = 0x06054b50, SIG_Z64_LOCATOR = 0x07064b50;
const MAX32 = 0xffffffff, MAX16 = 0xffff;
const FLAG_ENCRYPTED = 0x1, FLAG_STRONG = 0x40, FLAG_UTF8 = 0x800;

const CP437_HIGH = "ÇüéâäàåçêëèïîìÄÅ"
  + "ÉæÆôöòûùÿÖÜ¢£¥₧ƒ"
  + "áíóúñÑªº¿⌐¬½¼¡«»"
  + "░▒▓│┤╡╢╖╕╣║╗╝╜╛┐"
  + "└┴┬├─┼╞╟╚╔╩╦╠═╬╧"
  + "╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀"
  + "αßΓπΣσµτΦΘΩδ∞φε∩"
  + "≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ";

const cp437 = (raw) => Array.from(raw, (b) => (b < 0x80 ? String.fromCharCode(b) : CP437_HIGH[b - 0x80])).join("");
const isAscii = (raw) => raw.every((b) => b < 0x80);

const damaged = (detail, path = "", cause) =>
  new FsError(detail ? `The zip file is damaged: ${detail}` : "The zip file is damaged.", { code: "io", path, cause });
const ZIP64_MESSAGE = "This zip uses the zip64 format (for zips over 4 GB or with more than 65,535 files), which Paper Marker can't read.";

async function sliceBytes(blob, start, end) {
  return new Uint8Array(await blob.slice(start, end).arrayBuffer());
}

function dv(u8) {
  return new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
}

// Extra fields of a header: Map(tag -> Uint8Array). Malformed trailing bytes are ignored, as unzip does.
function extraFields(u8) {
  const m = new Map();
  const v = dv(u8);
  for (let i = 0; i + 4 <= u8.length;) {
    const tag = v.getUint16(i, true), len = v.getUint16(i + 2, true);
    if (i + 4 + len > u8.length) break;
    if (!m.has(tag)) m.set(tag, u8.subarray(i + 4, i + 4 + len));
    i += 4 + len;
  }
  return m;
}

function decodeName(raw, flags, extras) {
  if (flags & FLAG_UTF8) {
    try { return fromUtf8(raw); } catch { return cp437(raw); }
  }
  const up = extras.get(0x7075); // Info-ZIP Unicode path: version 1, CRC-32 of the header name, UTF-8 name
  if (up && up.length > 5 && up[0] === 1 && dv(up).getUint32(1, true) === crc32(raw)) {
    try { return fromUtf8(up.subarray(5)); } catch { /* fall through */ }
  }
  if (isAscii(raw)) return String.fromCharCode(...raw);
  try { return fromUtf8(raw); } catch { return cp437(raw); }
}

function dosToMs(time, date) {
  const y = 1980 + (date >>> 9), mo = (date >>> 5) & 15, d = date & 31;
  const h = time >>> 11, mi = (time >>> 5) & 63, s = (time & 31) * 2;
  const t = new Date(y, Math.max(mo, 1) - 1, Math.max(d, 1), h, mi, s).getTime();
  return Number.isFinite(t) ? t : 0;
}

function msToDos(ms) {
  const d = new Date(ms);
  const y = d.getFullYear();
  if (!Number.isFinite(y) || y < 1980) return [0, (1 << 5) | 1]; // 1980-01-01 00:00:00
  if (y > 2107) return [(23 << 11) | (59 << 5) | 29, (127 << 9) | (12 << 5) | 31];
  return [(d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), ((y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()];
}

// ---------------------------------------------------------------------------------------------------
// Reading

// Find the end-of-central-directory record in the file's last 64 KB + 22 bytes.
async function findEnd(blob) {
  const size = blob.size;
  if (size < 22) return null;
  const from = Math.max(0, size - 22 - MAX16);
  const tail = await sliceBytes(blob, from, size);
  const v = dv(tail);
  let fallback = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (v.getUint32(i, true) !== SIG_END) continue;
    const clen = v.getUint16(i + 20, true);
    if (i + 22 + clen === tail.length) return { pos: from + i, rec: tail.subarray(i, i + 22), tail, tailPos: from, at: i };
    if (fallback < 0 && i + 22 + clen <= tail.length) fallback = i; // the last one, like Python's rfind
  }
  return fallback < 0 ? null : { pos: from + fallback, rec: tail.subarray(fallback, fallback + 22), tail, tailPos: from, at: fallback };
}

/** Open a zip (Blob, File, Uint8Array or ArrayBuffer) as a read-only LibFS. */
export async function readZip(input, { name } = {}) {
  const blob = typeof Blob !== "undefined" && input instanceof Blob ? input : new Blob([input]);
  const zfs = new ZipFS(blob, name || input?.name || "Zip file");
  await zfs._open();
  return zfs;
}

export class ZipFS extends ReadOnlyFS {
  constructor(blob, name) {
    super({ name, kind: "zip" });
    this._blob = blob;
    this.comment = "";
  }

  async _open() {
    const blob = this._blob;
    const end = await findEnd(blob);
    if (!end) throw new FsError("This file is not a zip file.", { code: "io" });
    const e = dv(end.rec);
    const disk = e.getUint16(4, true), cdDisk = e.getUint16(6, true);
    const countHere = e.getUint16(8, true), count = e.getUint16(10, true);
    const cdSize = e.getUint32(12, true), cdOffset = e.getUint32(16, true), clen = e.getUint16(20, true);
    if (end.at >= 20 && dv(end.tail).getUint32(end.at - 20, true) === SIG_Z64_LOCATOR) throw new FsError(ZIP64_MESSAGE, { code: "io" });
    if (count === MAX16 || countHere === MAX16 || cdSize === MAX32 || cdOffset === MAX32) throw new FsError(ZIP64_MESSAGE, { code: "io" });
    if (disk !== 0 || cdDisk !== 0 || countHere !== count) {
      throw new FsError("This zip is split into several parts. Paper Marker can only open a zip that is in one piece.", { code: "io" });
    }
    const commentBytes = end.tail.subarray(end.at + 22, end.at + 22 + clen);
    this.comment = (() => { try { return fromUtf8(commentBytes); } catch { return cp437(commentBytes); } })();
    // Data in front of the zip (a self-extractor stub) shifts every offset, as Python's zipfile allows.
    const concat = end.pos - cdSize - cdOffset;
    if (concat < 0) throw damaged("the central directory lies outside the file.");
    const cdStart = cdOffset + concat;
    this._dataEnd = cdStart;
    const cd = await sliceBytes(blob, cdStart, cdStart + cdSize);
    const v = dv(cd);
    let i = 0, n = 0;
    while (i < cd.length) {
      if (i + 46 > cd.length || v.getUint32(i, true) !== SIG_CENTRAL) throw damaged("a central directory entry is broken.");
      const madeBy = v.getUint16(i + 4, true) >>> 8;
      const flags = v.getUint16(i + 8, true), method = v.getUint16(i + 10, true);
      const time = v.getUint16(i + 12, true), date = v.getUint16(i + 14, true);
      const crc = v.getUint32(i + 16, true), csize = v.getUint32(i + 20, true), usize = v.getUint32(i + 24, true);
      const nlen = v.getUint16(i + 28, true), xlen = v.getUint16(i + 30, true), mlen = v.getUint16(i + 32, true);
      const offset = v.getUint32(i + 42, true);
      if (i + 46 + nlen + xlen + mlen > cd.length) throw damaged("a central directory entry is cut short.");
      const raw = cd.slice(i + 46, i + 46 + nlen);
      const extras = extraFields(cd.subarray(i + 46 + nlen, i + 46 + nlen + xlen));
      i += 46 + nlen + xlen + mlen;
      n++;
      if (csize === MAX32 || usize === MAX32 || offset === MAX32 || extras.has(0x0001)) throw new FsError(ZIP64_MESSAGE, { code: "io" });
      if (flags & (FLAG_ENCRYPTED | FLAG_STRONG) || method === 99) {
        throw new FsError("This zip is password-protected. Paper Marker can't open encrypted zips.", { code: "io" });
      }
      let name = decodeName(raw, flags, extras);
      // Zips made on Windows (MS-DOS, NTFS or VFAT hosts) may use backslashes between folders.
      if ((madeBy === 0 || madeBy === 11 || madeBy === 14) && name.includes("\\")) name = name.replaceAll("\\", "/");
      const isDir = name.endsWith("/");
      let path = isDir ? name.slice(0, -1) : name;
      // A "." segment names the folder it is in: macOS tar ("tar -a -cf lib.zip -C folder .") writes "./",
      // "./library.json" ... Drop it, as Python's zipfile does when it extracts; "./" itself is the top.
      if (path === "." || path.startsWith("./") || path.includes("/./") || path.endsWith("/.")) {
        path = path.split("/").filter((s) => s !== ".").join("/");
        if (!path && isDir) continue;
      }
      try {
        checkPath(path);
      } catch {
        throw new FsError(`This zip holds a file with an unsafe name: “${name}”.`, { code: "bad-path", path: name });
      }
      let mtime = dosToMs(time, date);
      const ut = extras.get(0x5455); // extended timestamp: flags, then the UTC modification time
      if (ut && ut.length >= 5 && ut[0] & 1) mtime = dv(ut).getUint32(1, true) * 1000;
      const entry = { name: path, raw, flags, method, crc, csize, usize, offset: offset + concat, mtime };
      if (!this._add(path, entry, isDir)) {
        throw new FsError(`This zip holds a file and a folder with the same name: “${path}”.`, { code: "io", path });
      }
    }
    if (n !== count) throw damaged("the number of entries does not match.");
  }

  async _bytes(path, e) {
    const blob = this._blob;
    const head = await sliceBytes(blob, e.offset, e.offset + 30 + e.raw.length);
    const h = dv(head);
    if (head.length < 30 || h.getUint32(0, true) !== SIG_LOCAL) throw damaged(`the header of “${path}” is missing.`, path);
    const nlen = h.getUint16(26, true), xlen = h.getUint16(28, true);
    if (nlen !== e.raw.length || head.subarray(30).some((b, k) => b !== e.raw[k])) {
      throw damaged(`the two names stored for “${path}” differ.`, path);
    }
    if (h.getUint16(6, true) & FLAG_ENCRYPTED) throw new FsError("This zip is password-protected. Paper Marker can't open encrypted zips.", { code: "io", path });
    const start = e.offset + 30 + nlen + xlen, end = start + e.csize;
    if (end > this._dataEnd) throw damaged(`“${path}” runs past the end of the data.`, path);
    let bytes;
    if (e.method === 0) {
      if (e.csize !== e.usize) throw damaged(`the sizes of “${path}” don't match.`, path);
      bytes = await sliceBytes(blob, start, end);
    } else if (e.method === 8) {
      bytes = await inflate(blob.slice(start, end), e.usize, path);
    } else {
      throw new FsError(`Can't read “${path}” from the zip: it uses compression method ${e.method}. Only stored and deflated files can be read.`, { code: "io", path });
    }
    if (crc32(bytes) !== e.crc) throw damaged(`the checksum of “${path}” doesn't match.`, path);
    return bytes;
  }

  async _file(path, e) {
    const name = baseName(path);
    return new File([await this._bytes(path, e)], name, { type: mimeOf(name), lastModified: e.mtime });
  }

  _stat(path, e) {
    return { size: e.usize, mtime: e.mtime, kind: "file" };
  }
}

// Inflate raw deflate data, refusing more output than the zip declares (a zip bomb stops early).
async function inflate(blob, usize, path) {
  const reader = blob.stream().pipeThrough(new DecompressionStream("deflate-raw")).getReader();
  const chunks = [];
  let n = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      n += value.length;
      if (n > usize) throw damaged(`“${path}” is larger than the zip says.`, path);
      chunks.push(value);
    }
  } catch (e) {
    reader.cancel().catch(() => {});
    if (e instanceof FsError) throw e;
    throw damaged(`“${path}” can't be decompressed.`, path, e);
  }
  if (n !== usize) throw damaged(`“${path}” is shorter than the zip says.`, path);
  if (chunks.length === 1) return chunks[0];
  const out = new Uint8Array(n);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

// ---------------------------------------------------------------------------------------------------
// Writing

const TOO_BIG = "Zip files of 4 GB or more can't be made here.";

function toBlob(data, path) {
  if (typeof Blob !== "undefined" && data instanceof Blob) return data;
  if (typeof data === "string") {
    try {
      return new Blob([utf8(data)]);
    } catch (e) {
      throw new FsError(e.message, { code: "encode", path, cause: e });
    }
  }
  if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) return new Blob([data]);
  throw new FsError(`“${path}” has no data to put in the zip.`, { code: "invalid", path });
}

// CRC-32 and size of blob's bytes, and its raw deflate stream as a Blob, in one pass.
async function deflate(blob) {
  let crc = 0, size = 0;
  const tap = new TransformStream({
    transform(chunk, ctl) {
      crc = crc32(chunk, crc);
      size += chunk.length;
      ctl.enqueue(chunk);
    },
  });
  const reader = blob.stream().pipeThrough(tap).pipeThrough(new CompressionStream("deflate-raw")).getReader();
  const chunks = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return { crc, size, compressed: new Blob(chunks) };
}

function header(sig, fields, name) {
  // fields: [bytes, value] pairs after the signature
  const len = 4 + fields.reduce((a, [n]) => a + n, 0);
  const u8 = new Uint8Array(len + name.length);
  const v = dv(u8);
  v.setUint32(0, sig, true);
  let at = 4;
  for (const [n, val] of fields) {
    if (n === 2) v.setUint16(at, val, true);
    else v.setUint32(at, val >>> 0, true);
    at += n;
  }
  u8.set(name, len);
  return u8;
}

/** Make a zip from entries ({path, data, mtime?}; a path ending "/" or dir: true makes a folder). */
export async function writeZip(entries, { comment = "" } = {}) {
  const parts = [], central = [];
  const seen = new Set();
  let offset = 0, count = 0;
  for await (const e of entries) {
    const raw = e?.path;
    if (typeof raw !== "string") throw new FsError("Bad path", { code: "bad-path", path: String(raw) });
    const isDir = e.dir === true || raw.endsWith("/");
    const path = raw.endsWith("/") ? raw.slice(0, -1) : raw;
    checkPath(path);
    const name = isDir ? path + "/" : path;
    if (seen.has(path)) throw new FsError(`The zip would hold “${path}” twice.`, { code: "invalid", path });
    seen.add(path);
    let nameBytes;
    try {
      nameBytes = utf8(name);
    } catch (err) {
      throw new FsError(err.message, { code: "encode", path, cause: err });
    }
    if (nameBytes.length > MAX16) throw new FsError(`The name “${path}” is too long for a zip.`, { code: "invalid", path });
    const [time, date] = msToDos(e.mtime instanceof Date ? e.mtime.getTime() : e.mtime ?? nowMs());
    let method = 0, crc = 0, size = 0, body = null;
    if (!isDir) {
      const blob = toBlob(e.data, path);
      const d = blob.size ? await deflate(blob) : { crc: 0, size: 0, compressed: blob };
      ({ crc, size } = d);
      if (size > 0 && d.compressed.size < size) {
        method = 8;
        body = d.compressed;
      } else {
        body = blob;
      }
    }
    const csize = body ? body.size : 0;
    if (size >= MAX32 || csize >= MAX32 || offset >= MAX32) throw new FsError(TOO_BIG, { code: "invalid", path });
    if (count + 1 >= MAX16) throw new FsError("Zip files with more than 65,534 entries can't be made here.", { code: "invalid", path });
    const flags = isAscii(nameBytes) ? 0 : FLAG_UTF8;
    const local = header(SIG_LOCAL, [[2, 20], [2, flags], [2, method], [2, time], [2, date], [4, crc], [4, csize], [4, size],
      [2, nameBytes.length], [2, 0]], nameBytes);
    const attrs = isDir ? ((0o40755 << 16) | 0x10) >>> 0 : (0o100644 << 16) >>> 0;
    central.push(header(SIG_CENTRAL, [[2, (3 << 8) | 20], [2, 20], [2, flags], [2, method], [2, time], [2, date], [4, crc],
      [4, csize], [4, size], [2, nameBytes.length], [2, 0], [2, 0], [2, 0], [2, 0], [4, attrs], [4, offset]], nameBytes));
    parts.push(local);
    if (body && csize) parts.push(body);
    offset += local.length + csize;
    count++;
  }
  const cdSize = central.reduce((a, c) => a + c.length, 0);
  if (offset >= MAX32 || offset + cdSize >= MAX32) throw new FsError(TOO_BIG, { code: "invalid" });
  let commentBytes;
  try {
    commentBytes = utf8(String(comment));
  } catch (err) {
    throw new FsError(err.message, { code: "encode", cause: err });
  }
  if (commentBytes.length > MAX16) throw new FsError("The zip comment is too long.", { code: "invalid" });
  const end = header(SIG_END, [[2, 0], [2, 0], [2, count], [2, count], [4, cdSize], [4, offset], [2, commentBytes.length]], commentBytes);
  return new Blob([...parts, ...central, end], { type: "application/zip" });
}
