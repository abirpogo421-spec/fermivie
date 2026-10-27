// Python-compatible JSON text, UTF-8, clock, timestamps and SHA-256 for the browser back end
// (WEB_CONTRACT.md section 4). Pure ES module with no imports: runs in node (>= 20) and in pages.
//
//   pyDumps(obj, {indent = 1, ensureAscii = false, sortKeys = false, separators})
//                       == json.dumps(obj, indent=..., ensure_ascii=..., sort_keys=..., separators=...)
//                       Defaults are the ones Fermivie writes files with. For Python's own defaults
//                       (json.dumps(x)) pass {indent: null, ensureAscii: true}.
//   dumpJson(obj)       == library_store.dump_json(obj): UTF-8 bytes of pyDumps(obj) + "\n"
//   pyLoads(text)       == json.loads(text): same values (NaN/Infinity accepted) and, on bad input, a
//                       JSONDecodeError whose message is Python's ("Expecting value: line 1 column 1 (char 0)")
//   utf8(s)             == s.encode("utf-8"); lone surrogates throw UnicodeEncodeError with Python's message
//   fromUtf8(bytes, {errors = "strict" | "replace"})
//                       == bytes.decode("utf-8"[, "replace"]); strict errors throw UnicodeDecodeError with
//                       Python's message; a BOM is kept as U+FEFF, as Python's "utf-8" codec does
//   pyCompare(a, b)     Python's str ordering (code points, not UTF-16 units); use for sorted()
//   pyFloatRepr(x)      == repr(float(x))
//   setClock(fnOrValue) fn returns a Date or epoch milliseconds; a Date or a number freezes the clock;
//                       null restores the real clock. Only the timestamps below read it.
//   now() -> Date, nowMs() -> number
//   nowIso(t?)          == datetime.now().isoformat(timespec="seconds"), local time
//   stamp(t?)           == datetime.now().strftime("%Y%m%d_%H%M%S_%f"); microseconds = milliseconds * 1000
//                       (a clock returning fractional milliseconds supplies the extra digits)
//   secStamp(t?)        == datetime.now().strftime("%Y%m%d_%H%M%S")
//                       t (optional) formats another instant: a Date or epoch ms (e.g. a file's mtime).
//   sha256Hex(Uint8Array | ArrayBuffer | Blob) -> Promise<hex>   (crypto.subtle, pure-JS fallback)
//   sha256HexPure(bytes) -> hex, synchronous pure-JS SHA-256 (the fallback; also used by tests)
//
// Known, accepted limits (contract section 4): a Python float with an integral value (1.0, 1e300) read by
// JS comes back as an integer and is written as Python would write int(x); -0 is written as 0; integers
// beyond 2**53 lose precision in JSON.parse; JS orders integer-like object keys ("123") first.

// ---------------------------------------------------------------------------------------------------
// UTF-8

export class UnicodeDecodeError extends Error {
  constructor(start, end, reason, bytes) {
    const b = bytes[start];
    super(end === start + 1
      ? `'utf-8' codec can't decode byte 0x${b.toString(16).padStart(2, "0")} in position ${start}: ${reason}`
      : `'utf-8' codec can't decode bytes in position ${start}-${end - 1}: ${reason}`);
    this.name = "UnicodeDecodeError";
    this.encoding = "utf-8";
    this.start = start;
    this.end = end;
    this.reason = reason;
  }
}

export class UnicodeEncodeError extends Error {
  constructor(start, end, ch, reason) {
    let msg;
    if (end === start + 1) {
      const hex = ch.toString(16);
      const r = ch <= 0xff ? "\\x" + hex.padStart(2, "0") : ch <= 0xffff ? "\\u" + hex.padStart(4, "0")
        : "\\U" + hex.padStart(8, "0");
      msg = `'utf-8' codec can't encode character '${r}' in position ${start}: ${reason}`;
    } else {
      msg = `'utf-8' codec can't encode characters in position ${start}-${end - 1}: ${reason}`;
    }
    super(msg);
    this.name = "UnicodeEncodeError";
    this.encoding = "utf-8";
    this.start = start;
    this.end = end;
    this.reason = reason;
  }
}

const ENC = new TextEncoder();
const DEC_FATAL = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const DEC_LOOSE = new TextDecoder("utf-8", { ignoreBOM: true });
const LONE_SURROGATE = /[\uD800-\uDFFF]/u;

function wellFormed(s) {
  return typeof s.isWellFormed === "function" ? s.isWellFormed() : !LONE_SURROGATE.test(s);
}

/** s.encode("utf-8"). Throws UnicodeEncodeError (Python's message) when s holds a lone surrogate. */
export function utf8(s) {
  if (typeof s !== "string") throw new TypeError("utf8() needs a string");
  if (!wellFormed(s)) {
    // Python counts code points; a run of consecutive surrogate code points is reported as one range.
    let pos = 0, start = -1, end = -1, first = 0;
    for (const ch of s) {
      const cp = ch.codePointAt(0);
      const sur = cp >= 0xd800 && cp <= 0xdfff;
      if (start < 0 && sur) { start = pos; first = cp; }
      else if (start >= 0 && !sur) { end = pos; break; }
      pos++;
    }
    if (end < 0) end = pos;
    throw new UnicodeEncodeError(start, end, first, "surrogates not allowed");
  }
  return ENC.encode(s);
}

function asBytes(b) {
  if (b instanceof Uint8Array) return b;
  if (b instanceof ArrayBuffer) return new Uint8Array(b);
  if (ArrayBuffer.isView(b)) return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  throw new TypeError("expected bytes (Uint8Array or ArrayBuffer)");
}

const isCont = (c) => c >= 0x80 && c <= 0xbf;

// CPython's stringlib utf8_decode + unicode_decode_utf8 error classification. Returns null at the end of
// valid data or {start, end, reason} for the first error at or after i, plus the valid prefix end.
function utf8Scan(u8, i) {
  const n = u8.length;
  while (i < n) {
    const c = u8[i];
    if (c < 0x80) { i++; continue; }
    const left = n - i;
    if (c < 0xe0) {
      if (c < 0xc2) return { at: i, start: i, end: i + 1, reason: "invalid start byte" };
      if (left < 2) return { at: i, start: i, end: n, reason: "unexpected end of data" };
      if (!isCont(u8[i + 1])) return { at: i, start: i, end: i + 1, reason: "invalid continuation byte" };
      i += 2; continue;
    }
    if (c < 0xf0) {
      const c2 = u8[i + 1];
      if (left < 3) {
        if (left < 2) return { at: i, start: i, end: n, reason: "unexpected end of data" };
        if (!isCont(c2) || (c2 < 0xa0 ? c === 0xe0 : c === 0xed))
          return { at: i, start: i, end: i + 1, reason: "invalid continuation byte" };
        return { at: i, start: i, end: n, reason: "unexpected end of data" };
      }
      if (!isCont(c2) || (c === 0xe0 && c2 < 0xa0) || (c === 0xed && c2 >= 0xa0))
        return { at: i, start: i, end: i + 1, reason: "invalid continuation byte" };
      if (!isCont(u8[i + 2])) return { at: i, start: i, end: i + 2, reason: "invalid continuation byte" };
      i += 3; continue;
    }
    if (c < 0xf5) {
      const c2 = u8[i + 1];
      if (left < 4) {
        if (left < 2) return { at: i, start: i, end: n, reason: "unexpected end of data" };
        if (!isCont(c2) || (c2 < 0x90 ? c === 0xf0 : c === 0xf4))
          return { at: i, start: i, end: i + 1, reason: "invalid continuation byte" };
        if (left < 3) return { at: i, start: i, end: n, reason: "unexpected end of data" };
        if (!isCont(u8[i + 2])) return { at: i, start: i, end: i + 2, reason: "invalid continuation byte" };
        return { at: i, start: i, end: n, reason: "unexpected end of data" };
      }
      if (!isCont(c2) || (c === 0xf0 && c2 < 0x90) || (c === 0xf4 && c2 >= 0x90))
        return { at: i, start: i, end: i + 1, reason: "invalid continuation byte" };
      if (!isCont(u8[i + 2])) return { at: i, start: i, end: i + 2, reason: "invalid continuation byte" };
      if (!isCont(u8[i + 3])) return { at: i, start: i, end: i + 3, reason: "invalid continuation byte" };
      i += 4; continue;
    }
    return { at: i, start: i, end: i + 1, reason: "invalid start byte" };
  }
  return null;
}

/** bytes.decode("utf-8") (strict) or bytes.decode("utf-8", "replace"). */
export function fromUtf8(bytes, { errors = "strict" } = {}) {
  const u8 = asBytes(bytes);
  try {
    return DEC_FATAL.decode(u8);
  } catch {
    // invalid input: classify exactly like CPython
  }
  if (errors === "strict") {
    const e = utf8Scan(u8, 0);
    if (e) throw new UnicodeDecodeError(e.start, e.end, e.reason, u8);
    return DEC_LOOSE.decode(u8); // not reached: the scanner and the decoder agree on validity
  }
  if (errors !== "replace") throw new TypeError(`unsupported errors mode: ${errors}`);
  const parts = [];
  let i = 0;
  for (;;) {
    const e = utf8Scan(u8, i);
    if (!e) { parts.push(DEC_LOOSE.decode(u8.subarray(i))); break; }
    parts.push(DEC_LOOSE.decode(u8.subarray(i, e.start)), "�");
    i = e.end;
  }
  return parts.join("");
}

// ---------------------------------------------------------------------------------------------------
// Python str ordering and float repr

/** Compare two strings the way Python compares str (by code point). Returns <0, 0 or >0. */
export function pyCompare(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a.charCodeAt(i) === b.charCodeAt(i)) continue;
    const p = i > 0 ? a.charCodeAt(i - 1) : 0;
    if (p >= 0xd800 && p <= 0xdbff) { // the shared previous unit is a high surrogate: compare whole code points
      const ca = a.codePointAt(i - 1), cb = b.codePointAt(i - 1);
      if (ca !== cb) return ca - cb; // one side (or both) completes a pair there
    }
    return a.codePointAt(i) - b.codePointAt(i);
  }
  return a.length - b.length;
}

/** repr(float(x)) as CPython prints it ('r' format, shortest round-trip digits). */
export function pyFloatRepr(x) {
  if (x !== x) return "nan";
  if (x === Infinity) return "inf";
  if (x === -Infinity) return "-inf";
  if (x === 0) return Object.is(x, -0) ? "-0.0" : "0.0";
  const neg = x < 0;
  const [mant, ex] = (neg ? -x : x).toExponential().split("e");
  const digits = mant.replace(".", "");
  const decpt = Number(ex) + 1; // x = 0.DIGITS * 10**decpt
  let out;
  if (decpt <= -4 || decpt > 16) {
    const e = decpt - 1;
    out = digits[0] + (digits.length > 1 ? "." + digits.slice(1) : "") + "e" + (e < 0 ? "-" : "+")
      + String(Math.abs(e)).padStart(2, "0");
  } else if (decpt <= 0) {
    out = "0." + "0".repeat(-decpt) + digits;
  } else if (decpt >= digits.length) {
    out = digits + "0".repeat(decpt - digits.length) + ".0";
  } else {
    out = digits.slice(0, decpt) + "." + digits.slice(decpt);
  }
  return neg ? "-" + out : out;
}

// ---------------------------------------------------------------------------------------------------
// json.dumps

const ESC = /[\x00-\x1f"\\]/g;
const ESC_ASCII = /[^\x20\x21\x23-\x5b\x5d-\x7e]/g;
const SHORT = { '"': '\\"', "\\": "\\\\", "\n": "\\n", "\r": "\\r", "\t": "\\t", "\b": "\\b", "\f": "\\f" };
const escChar = (c) => SHORT[c] ?? "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0");

function encStr(s, ascii) {
  return '"' + s.replace(ascii ? ESC_ASCII : ESC, escChar) + '"';
}

const TWO53 = 2 ** 53;

function encNumber(x) {
  if (Number.isInteger(x)) return Math.abs(x) < TWO53 ? String(x) : BigInt(x).toString();
  if (x !== x) return "NaN";
  if (x === Infinity) return "Infinity";
  if (x === -Infinity) return "-Infinity";
  return pyFloatRepr(x);
}

function typeName(v) {
  if (v === undefined) return "undefined";
  if (typeof v === "function") return "function";
  if (typeof v === "symbol") return "symbol";
  return v?.constructor?.name || typeof v;
}

function notSerializable(v) {
  const e = new TypeError(`Object of type ${typeName(v)} is not JSON serializable`);
  return e;
}

/**
 * json.dumps(obj, indent=indent, ensure_ascii=ensureAscii, sort_keys=sortKeys, separators=separators).
 * Accepts null, booleans, numbers, bigints, strings, arrays and plain objects. Anything else (undefined,
 * functions, Dates, Maps, class instances) throws TypeError, as Python does for objects it can't encode,
 * so a port never silently drops a key that Python would have written.
 */
export function pyDumps(obj, { indent = 1, ensureAscii = false, sortKeys = false, separators = null } = {}) {
  const ind = indent === null || indent === undefined ? null
    : typeof indent === "number" ? " ".repeat(Math.max(0, indent)) : String(indent);
  let itemSep, keySep;
  if (separators) [itemSep, keySep] = separators;
  else { itemSep = ind === null ? ", " : ","; keySep = ": "; }
  const out = [];
  const seen = new Set();

  function enc(v, level) {
    if (v === null) { out.push("null"); return; }
    switch (typeof v) {
      case "string": out.push(encStr(v, ensureAscii)); return;
      case "boolean": out.push(v ? "true" : "false"); return;
      case "number": out.push(encNumber(v)); return;
      case "bigint": out.push(v.toString()); return;
      case "object": break;
      default: throw notSerializable(v);
    }
    const isArr = Array.isArray(v);
    if (!isArr) {
      const proto = Object.getPrototypeOf(v);
      if (proto !== Object.prototype && proto !== null) throw notSerializable(v);
    }
    if (seen.has(v)) {
      const e = new Error("Circular reference detected");
      e.name = "ValueError";
      throw e;
    }
    const nl = ind === null ? "" : "\n" + ind.repeat(level + 1);
    if (isArr) {
      if (v.length === 0) { out.push("[]"); return; }
      seen.add(v);
      out.push("[");
      for (let i = 0; i < v.length; i++) {
        out.push(i ? itemSep + nl : nl);
        enc(v[i], level + 1);
      }
    } else {
      let keys = Object.keys(v);
      if (keys.length === 0) { out.push("{}"); return; }
      if (sortKeys) keys = keys.sort(pyCompare);
      seen.add(v);
      out.push("{");
      for (let i = 0; i < keys.length; i++) {
        out.push((i ? itemSep + nl : nl) + encStr(keys[i], ensureAscii) + keySep);
        enc(v[keys[i]], level + 1);
      }
    }
    if (ind !== null) out.push("\n" + ind.repeat(level));
    out.push(isArr ? "]" : "}");
    seen.delete(v);
  }

  enc(obj, 0);
  return out.join("");
}

/** library_store.dump_json(obj): (json.dumps(obj, indent=1, ensure_ascii=False) + "\n").encode("utf-8") */
export function dumpJson(obj) {
  return utf8(pyDumps(obj, { indent: 1, ensureAscii: false }) + "\n");
}

// ---------------------------------------------------------------------------------------------------
// json.loads (CPython's C scanner, Modules/_json.c in 3.13: same values, same error messages)

/** Python's JSONDecodeError: message "<msg>: line L column C (char P)", positions in code points. */
export class JSONDecodeError extends Error {
  constructor(msg, doc, unitPos) {
    const pre = doc.slice(0, unitPos);
    const cps = (t) => { let n = 0; for (let i = 0; i < t.length; i++) { const c = t.charCodeAt(i); if (c < 0xdc00 || c > 0xdfff || i === 0 || (t.charCodeAt(i - 1) & 0xfc00) !== 0xd800) n++; } return n; };
    const pos = cps(pre);
    const nl = pre.lastIndexOf("\n");
    const lineno = pre.split("\n").length;
    const colno = nl < 0 ? pos + 1 : cps(pre.slice(nl));
    super(`${msg}: line ${lineno} column ${colno} (char ${pos})`);
    this.name = "JSONDecodeError";
    this.msg = msg;
    this.pos = pos;
    this.lineno = lineno;
    this.colno = colno;
  }
}

class StopScan { constructor(idx) { this.idx = idx; } }

const isWs = (c) => c === 32 || c === 9 || c === 10 || c === 13;
const HEX = (c) => (c >= 48 && c <= 57) ? c - 48 : (c >= 97 && c <= 102) ? c - 87 : (c >= 65 && c <= 70) ? c - 55 : -1;
const isDigit = (c) => c >= 48 && c <= 57;

function setKey(obj, k, v) {
  if (k === "__proto__") Object.defineProperty(obj, k, { value: v, writable: true, enumerable: true, configurable: true });
  else obj[k] = v;
}

function pyScan(s) {
  const len = s.length, endIdx = len - 1;
  const fail = (msg, pos) => { throw new JSONDecodeError(msg, s, pos); };

  function scanString(end) { // end = index after the opening quote
    const begin = end - 1;
    const chunks = [];
    for (;;) {
      let next = end, c = 0;
      for (; next < len; next++) {
        c = s.charCodeAt(next);
        if (c === 34 || c === 92) break;
        if (c <= 0x1f) fail("Invalid control character at", next);
      }
      if (next >= len || (c !== 34 && c !== 92)) fail("Unterminated string starting at", begin);
      if (next > end) chunks.push(s.slice(end, next));
      next++;
      if (c === 34) return [chunks.join(""), next];
      if (next === len) fail("Unterminated string starting at", begin);
      c = s.charCodeAt(next);
      if (c !== 117) { // 'u'
        end = next + 1;
        const m = { 34: '"', 92: "\\", 47: "/", 98: "\b", 102: "\f", 110: "\n", 114: "\r", 116: "\t" }[c];
        if (m === undefined) fail("Invalid \\escape", end - 2);
        chunks.push(m);
        continue;
      }
      next++;
      end = next + 4;
      if (end >= len) fail("Invalid \\uXXXX escape", next - 1);
      let u = 0;
      for (; next < end; next++) {
        const h = HEX(s.charCodeAt(next));
        if (h < 0) fail("Invalid \\uXXXX escape", end - 5);
        u = (u << 4) | h;
      }
      if (u >= 0xd800 && u <= 0xdbff && end + 6 < len && s.charCodeAt(next++) === 92 && s.charCodeAt(next++) === 117) {
        let u2 = 0;
        end += 6;
        for (; next < end; next++) {
          const h = HEX(s.charCodeAt(next));
          if (h < 0) fail("Invalid \\uXXXX escape", end - 5);
          u2 = (u2 << 4) | h;
        }
        if (u2 >= 0xdc00 && u2 <= 0xdfff) chunks.push(String.fromCharCode(u, u2));
        else { end -= 6; chunks.push(String.fromCharCode(u)); }
      } else {
        chunks.push(String.fromCharCode(u));
      }
    }
  }

  function matchNumber(start) {
    let idx = start;
    if (s.charCodeAt(idx) === 45) { idx++; if (idx > endIdx) throw new StopScan(start); }
    const c0 = s.charCodeAt(idx);
    if (c0 >= 49 && c0 <= 57) { idx++; while (idx <= endIdx && isDigit(s.charCodeAt(idx))) idx++; }
    else if (c0 === 48) idx++;
    else throw new StopScan(start);
    if (idx < endIdx && s.charCodeAt(idx) === 46 && isDigit(s.charCodeAt(idx + 1))) {
      idx += 2;
      while (idx <= endIdx && isDigit(s.charCodeAt(idx))) idx++;
    }
    if (idx < endIdx && (s.charCodeAt(idx) === 101 || s.charCodeAt(idx) === 69)) {
      const eStart = idx;
      idx++;
      if (idx < endIdx && (s.charCodeAt(idx) === 45 || s.charCodeAt(idx) === 43)) idx++;
      while (idx <= endIdx && isDigit(s.charCodeAt(idx))) idx++;
      if (!isDigit(s.charCodeAt(idx - 1))) idx = eStart; // no exponent digits: backtrack
    }
    return [Number(s.slice(start, idx)), idx];
  }

  function skipWs(idx) { while (idx <= endIdx && isWs(s.charCodeAt(idx))) idx++; return idx; }

  function parseObject(idx) {
    const obj = {};
    idx = skipWs(idx);
    if (idx > endIdx || s.charCodeAt(idx) !== 125) {
      for (;;) {
        if (idx > endIdx || s.charCodeAt(idx) !== 34) fail("Expecting property name enclosed in double quotes", idx);
        let key;
        [key, idx] = scanString(idx + 1);
        idx = skipWs(idx);
        if (idx > endIdx || s.charCodeAt(idx) !== 58) fail("Expecting ':' delimiter", idx);
        idx = skipWs(idx + 1);
        let val;
        [val, idx] = scanOnce(idx);
        setKey(obj, key, val);
        idx = skipWs(idx);
        if (idx <= endIdx && s.charCodeAt(idx) === 125) break;
        if (idx > endIdx || s.charCodeAt(idx) !== 44) fail("Expecting ',' delimiter", idx);
        const comma = idx;
        idx = skipWs(idx + 1);
        if (idx <= endIdx && s.charCodeAt(idx) === 125) fail("Illegal trailing comma before end of object", comma);
      }
    }
    return [obj, idx + 1];
  }

  function parseArray(idx) {
    const arr = [];
    idx = skipWs(idx);
    if (idx > endIdx || s.charCodeAt(idx) !== 93) {
      for (;;) {
        let val;
        [val, idx] = scanOnce(idx);
        arr.push(val);
        idx = skipWs(idx);
        if (idx <= endIdx && s.charCodeAt(idx) === 93) break;
        if (idx > endIdx || s.charCodeAt(idx) !== 44) fail("Expecting ',' delimiter", idx);
        const comma = idx;
        idx = skipWs(idx + 1);
        if (idx <= endIdx && s.charCodeAt(idx) === 93) fail("Illegal trailing comma before end of array", comma);
      }
    }
    return [arr, idx + 1];
  }

  function scanOnce(idx) {
    if (idx >= len) throw new StopScan(idx);
    const c = s.charCodeAt(idx);
    if (c === 34) return scanString(idx + 1);
    if (c === 123) return parseObject(idx + 1);
    if (c === 91) return parseArray(idx + 1);
    if (c === 110 && idx + 3 < len && s.startsWith("null", idx)) return [null, idx + 4];
    if (c === 116 && idx + 3 < len && s.startsWith("true", idx)) return [true, idx + 4];
    if (c === 102 && idx + 4 < len && s.startsWith("false", idx)) return [false, idx + 5];
    if (c === 78 && idx + 2 < len && s.startsWith("NaN", idx)) return [NaN, idx + 3];
    if (c === 73 && idx + 7 < len && s.startsWith("Infinity", idx)) return [Infinity, idx + 8];
    if (c === 45 && idx + 8 < len && s.startsWith("-Infinity", idx)) return [-Infinity, idx + 9];
    return matchNumber(idx);
  }

  let idx = 0;
  while (idx < len && isWs(s.charCodeAt(idx))) idx++;
  let obj;
  try {
    [obj, idx] = scanOnce(idx);
  } catch (e) {
    if (e instanceof StopScan) fail("Expecting value", e.idx);
    throw e;
  }
  while (idx < len && isWs(s.charCodeAt(idx))) idx++;
  if (idx !== len) fail("Extra data", idx);
  return obj;
}

/** json.loads(text) for a str. Valid JSON goes through JSON.parse; anything else through the scanner. */
export function pyLoads(text) {
  if (typeof text !== "string") throw new TypeError("pyLoads() needs a string");
  if (text.charCodeAt(0) === 0xfeff) throw new JSONDecodeError("Unexpected UTF-8 BOM (decode using utf-8-sig)", text, 0);
  try {
    return JSON.parse(text);
  } catch {
    return pyScan(text);
  }
}

// ---------------------------------------------------------------------------------------------------
// Clock and timestamps (local time, like datetime.now())

let clockFn = null;

function toMs(v) {
  if (v instanceof Date) return v.getTime();
  if (typeof v === "number" && Number.isFinite(v)) return v;
  throw new TypeError("the clock must give a Date or a number of milliseconds");
}

/** setClock(fn) uses fn() (Date or epoch ms) as the time; setClock(dateOrMs) freezes it; setClock(null) resets. */
export function setClock(fn) {
  if (fn === null || fn === undefined) { clockFn = null; return; }
  if (typeof fn === "function") { clockFn = fn; return; }
  const ms = toMs(fn);
  clockFn = () => ms;
}

/** Epoch milliseconds from the settable clock (may carry a fraction when a test clock gives one). */
export function nowMs() {
  return clockFn ? toMs(clockFn()) : Date.now();
}

/** The settable clock as a Date (millisecond resolution). */
export function now() {
  return new Date(Math.floor(nowMs()));
}

const p2 = (n) => String(n).padStart(2, "0");

function localParts(t) {
  const ms = t === undefined ? nowMs() : toMs(t);
  const totalUs = Math.round(ms * 1000);
  const sec = Math.floor(totalUs / 1e6);
  const us = totalUs - sec * 1e6;
  const d = new Date(sec * 1000);
  return {
    Y: String(d.getFullYear()).padStart(4, "0"), M: p2(d.getMonth() + 1), D: p2(d.getDate()),
    h: p2(d.getHours()), m: p2(d.getMinutes()), s: p2(d.getSeconds()), us: String(us).padStart(6, "0"),
  };
}

/** datetime.now().isoformat(timespec="seconds"), e.g. "2026-10-21T11:50:00". */
export function nowIso(t) {
  const p = localParts(t);
  return `${p.Y}-${p.M}-${p.D}T${p.h}:${p.m}:${p.s}`;
}

/** datetime.now().strftime("%Y%m%d_%H%M%S_%f"), e.g. "20261021_115000_123000". */
export function stamp(t) {
  const p = localParts(t);
  return `${p.Y}${p.M}${p.D}_${p.h}${p.m}${p.s}_${p.us}`;
}

/** datetime.now().strftime("%Y%m%d_%H%M%S"), e.g. "20261021_115000". */
export function secStamp(t) {
  const p = localParts(t);
  return `${p.Y}${p.M}${p.D}_${p.h}${p.m}${p.s}`;
}

// ---------------------------------------------------------------------------------------------------
// SHA-256

const K256 = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function sha256Blocks(H, W, u8, off, nBlocks) {
  for (let b = 0; b < nBlocks; b++, off += 64) {
    for (let t = 0; t < 16; t++) {
      const i = off + t * 4;
      W[t] = (u8[i] << 24) | (u8[i + 1] << 16) | (u8[i + 2] << 8) | u8[i + 3];
    }
    for (let t = 16; t < 64; t++) {
      const x = W[t - 15], y = W[t - 2];
      const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
      const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
      W[t] = (W[t - 16] + s0 + W[t - 7] + s1) | 0;
    }
    let a = H[0], bb = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
    for (let t = 0; t < 64; t++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const t1 = (h + S1 + ((e & f) ^ (~e & g)) + K256[t] + W[t]) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const t2 = (S0 + ((a & bb) ^ (a & c) ^ (bb & c))) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = bb; bb = a; a = (t1 + t2) | 0;
    }
    H[0] = (H[0] + a) | 0; H[1] = (H[1] + bb) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
    H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
  }
}

const toHex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, "0")).join("");

/** Synchronous pure-JS SHA-256 (hex). The fallback when crypto.subtle is missing (plain-http pages). */
export function sha256HexPure(bytes) {
  const u8 = asBytes(bytes);
  const H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const W = new Uint32Array(64);
  const full = Math.floor(u8.length / 64);
  sha256Blocks(H, W, u8, 0, full);
  const rest = u8.length - full * 64;
  const tail = new Uint8Array(rest < 56 ? 64 : 128);
  tail.set(u8.subarray(full * 64));
  tail[rest] = 0x80;
  const bits = u8.length * 8;
  const dv = new DataView(tail.buffer);
  dv.setUint32(tail.length - 8, Math.floor(bits / 0x100000000));
  dv.setUint32(tail.length - 4, bits >>> 0);
  sha256Blocks(H, W, tail, 0, tail.length / 64);
  const out = new Uint8Array(32);
  const odv = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) odv.setUint32(i * 4, H[i]);
  return toHex(out);
}

/** hashlib.sha256(data).hexdigest() for a Uint8Array, ArrayBuffer, typed array or Blob/File. */
export async function sha256Hex(data) {
  let u8;
  if (typeof Blob !== "undefined" && data instanceof Blob) u8 = new Uint8Array(await data.arrayBuffer());
  else u8 = asBytes(data);
  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    try {
      return toHex(new Uint8Array(await subtle.digest("SHA-256", u8)));
    } catch {
      // fall through to the pure-JS digest
    }
  }
  return sha256HexPure(u8);
}
