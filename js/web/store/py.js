// Python semantics the store port needs to give the same answers as library_store.py (WEB_CONTRACT.md 6.1):
// str() / repr() of JSON values, truthiness, ==, <, str.strip() / str.split() whitespace, len() and slicing
// by code point, casefold(), int() of a string, the decimal value of a Unicode digit, dict.get / d[k] on
// parsed JSON, datetime.fromisoformat(...).strftime("%Y-%m-%d %H:%M") and base64.b64decode(validate=True).
// Pure ES module; runs in node and in pages.

import { pyCompare, pyFloatRepr } from "../pyjson.js";
import { exactText, isFloat } from "./libjson.js";
import * as U from "./unicode.js";

export { pyCompare };

/** Python's ValueError (JS has no such class); TypeError is JS's own. */
export class ValueError extends Error {
  constructor(message) {
    super(message);
    this.name = "ValueError";
  }
}

/** Python's KeyError for d[k] on a missing key. */
export class KeyError extends Error {
  constructor(key) {
    super(repr(key));
    this.name = "KeyError";
  }
}

// ---------------------------------------------------------------------------------------------------
// Types, dict access

export const isDict = (v) => v !== null && typeof v === "object" && !Array.isArray(v) && !ArrayBuffer.isView(v);
/** isinstance(v, int) without bool. JS cannot tell 1.0 from 1, so an integral number counts as an int, except
 *  from 1e21 up, where JSON text can only have been a float ("1e+21") for Python. */
export const isInt = (v) => typeof v === "number" && Number.isInteger(v) && Math.abs(v) < 1e21;
/** isinstance(v, int) with bool, as Python's isinstance does. */
export const isIntOrBool = (v) => isInt(v) || typeof v === "boolean";

/** type(v).__name__ for parsed JSON values. */
export function typeName(v) {
  if (v === null || v === undefined) return "NoneType";
  if (typeof v === "boolean") return "bool";
  if (typeof v === "number") return Number.isInteger(v) ? "int" : "float";
  if (typeof v === "string") return "str";
  if (Array.isArray(v)) return "list";
  if (v instanceof Uint8Array) return "bytes";
  return "dict";
}

/** key in d, for a dict parsed from JSON (keys are strings; anything else is never a key). */
export const has = (d, k) => isDict(d) && typeof k === "string" && Object.hasOwn(d, k);

/** d.get(k, dflt). Throws like Python when d is not a dict. */
export function pg(d, k, dflt = null) {
  if (!isDict(d)) throw new TypeError(`'${typeName(d)}' object has no attribute 'get'`);
  return has(d, k) ? d[k] : dflt;
}

/** d[k]: KeyError when missing, TypeError when d is not a dict. */
export function req(d, k) {
  if (!isDict(d)) throw new TypeError(`'${typeName(d)}' object is not subscriptable`);
  if (!has(d, k)) throw new KeyError(k);
  return d[k];
}

/** d[k] = v on a fresh dict, safe for the key "__proto__". */
export function setOwn(d, k, v) {
  if (k === "__proto__") Object.defineProperty(d, k, { value: v, writable: true, enumerable: true, configurable: true });
  else d[k] = v;
  return v;
}

/** hash(v) succeeds: Python raises TypeError when a list or dict is used as a set member or dict key. */
export function hashable(v) {
  if (Array.isArray(v)) throw new TypeError("unhashable type: 'list'");
  if (isDict(v)) throw new TypeError("unhashable type: 'dict'");
  return v;
}

/** The values `for x in (v or [])` visits: list items, dict keys, string code points; else TypeError. */
export function iter(v) {
  if (!truthy(v)) return [];
  if (Array.isArray(v)) return v;
  if (typeof v === "string") return Array.from(v);
  if (isDict(v)) return Object.keys(v);
  throw new TypeError(`'${typeName(v)}' object is not iterable`);
}

/** The values `for x in v` visits (no `or []`): list items, dict keys, string code points; else TypeError. */
export function iterStrict(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === "string") return Array.from(v);
  if (isDict(v)) return Object.keys(v);
  throw new TypeError(`'${typeName(v)}' object is not iterable`);
}

// ---------------------------------------------------------------------------------------------------
// Truthiness, ==, <

export function truthy(v) {
  if (v === null || v === undefined || v === false) return false;
  if (v === true) return true;
  if (typeof v === "number") return v !== 0; // NaN is true in Python too
  if (typeof v === "bigint") return v !== 0n;
  if (typeof v === "string" || Array.isArray(v)) return v.length > 0;
  if (isDict(v)) return Object.keys(v).length > 0;
  return true;
}

const numOf = (v) => (typeof v === "number" ? v : typeof v === "boolean" ? Number(v) : null);

/** a == b for parsed JSON values (1 == 1.0 == True, lists by item, dicts by key set and values). */
export function eq(a, b) {
  if (a === b) return true;
  const na = numOf(a), nb = numOf(b);
  if (na !== null || nb !== null) return na !== null && nb !== null && na === nb;
  if (typeof a === "string" || typeof b === "string" || a == null || b == null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!eq(a[i], b[i])) return false;
    return true;
  }
  if (isDict(a) && isDict(b)) {
    const ka = Object.keys(a);
    if (ka.length !== Object.keys(b).length) return false;
    for (const k of ka) if (!Object.hasOwn(b, k) || !eq(a[k], b[k])) return false;
    return true;
  }
  return false;
}

/** x in seq (list or tuple membership by ==). */
export const inList = (seq, x) => seq.some((y) => eq(y, x));

/** a < b as Python evaluates it; TypeError for pairs Python can't order. */
export function lt(a, b) {
  const na = numOf(a), nb = numOf(b);
  if (na !== null && nb !== null) return na < nb;
  if (typeof a === "string" && typeof b === "string") return pyCompare(a, b) < 0;
  if (Array.isArray(a) && Array.isArray(b)) {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) if (!eq(a[i], b[i])) return lt(a[i], b[i]);
    return a.length < b.length;
  }
  throw new TypeError(`'<' not supported between instances of '${typeName(a)}' and '${typeName(b)}'`);
}

/** A sort comparator over Python sort keys (tuples as arrays): stable sorted(key=...) order. */
export function cmpKeys(x, y) {
  if (lt(x, y)) return -1;
  return lt(y, x) ? 1 : 0;
}

/** sorted(strings) */
export const sortStrings = (arr) => arr.slice().sort(pyCompare);

// ---------------------------------------------------------------------------------------------------
// Whitespace (str.isspace / re's \s for str patterns), strip, split

export const WS_CLASS = "\\t\\n\\x0b\\x0c\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const WS_CODES = new Set([9, 10, 11, 12, 13, 0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0x85, 0xa0, 0x1680,
  0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a,
  0x2028, 0x2029, 0x202f, 0x205f, 0x3000]);
const WS_RUN = new RegExp(`[${WS_CLASS}]+`, "g");
const WS_RUN_SPLIT = new RegExp(`[${WS_CLASS}]+`);

export const isSpace = (code) => WS_CODES.has(code);

/** str.strip() */
export function strip(s) {
  let a = 0, b = s.length;
  while (a < b && WS_CODES.has(s.charCodeAt(a))) a++;
  while (b > a && WS_CODES.has(s.charCodeAt(b - 1))) b--;
  return s.slice(a, b);
}

/** str.split() with no arguments */
export function split(s) {
  return s.split(WS_RUN_SPLIT).filter((x) => x !== "");
}

/** " ".join(s.split()) */
export const oneLine = (s) => split(s).join(" ");

/** re.sub(r"\s+", " ", s) */
export const collapseWs = (s) => s.replace(WS_RUN, " ");

/** str.strip(chars) */
export function stripChars(s, chars) {
  let a = 0, b = s.length;
  while (a < b && chars.includes(s[a])) a++;
  while (b > a && chars.includes(s[b - 1])) b--;
  return s.slice(a, b);
}

/** str.rstrip(chars) */
export function rstripChars(s, chars) {
  let b = s.length;
  while (b > 0 && chars.includes(s[b - 1])) b--;
  return s.slice(0, b);
}

// ---------------------------------------------------------------------------------------------------
// len() and slicing count code points (a surrogate pair is one character, a lone surrogate is one too)

const SURR = /[\uD800-\uDFFF]/;

export function cpLen(s) {
  if (!SURR.test(s)) return s.length;
  let n = 0;
  for (const _ of s) n++;
  return n;
}

/** s[a:b] with non-negative a and b (b = undefined: to the end) */
export function cpSlice(s, a, b) {
  if (!SURR.test(s)) return s.slice(a, b);
  return Array.from(s).slice(a, b).join("");
}

// ---------------------------------------------------------------------------------------------------
// str() and repr() of parsed JSON values

const hex = (c, n) => c.toString(16).padStart(n, "0");

/** repr(s) for a str, as CPython writes it. */
export function reprStr(s) {
  const q = s.includes("'") && !s.includes('"') ? '"' : "'";
  let out = q;
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (ch === q || ch === "\\") out += "\\" + ch;
    else if (ch === "\t") out += "\\t";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (c < 0x20 || c === 0x7f) out += "\\x" + hex(c, 2);
    else if (c < 0x7f || isPrintable(c)) out += ch;
    else if (c <= 0xff) out += "\\x" + hex(c, 2);
    else if (c <= 0xffff) out += "\\u" + hex(c, 4);
    else out += "\\U" + hex(c, 8);
  }
  return out + q;
}

// A number as Python holds it after reading the JSON a page sends: an integral value below 1e21 is the int
// with the digits JSON.stringify writes (shortest round-trip digits padded with zeros, so 12345678901234567168
// is "12345678901234567000"); from 1e21 up JSON text can only say "1e+21", which Python reads as a float.
function numStr(v) {
  if (Number.isInteger(v) && Math.abs(v) < 1e21) return String(v);
  return pyFloatRepr(v);
}

/** str(holder[key]) for a value read from a file through parseLibJson: a big integer keeps the digits the file
 *  had and an integral float prints as a float ("3.0"); any other value is str(value). */
export function strAt(holder, key) {
  const v = pg(holder, key);
  if (typeof v === "number") {
    const exact = exactText(holder, key);
    if (exact !== null) return exact;
    if (isFloat(holder, key)) return pyFloatRepr(v);
  }
  return str(v);
}

/** repr(v) */
export function repr(v) {
  if (v === null || v === undefined) return "None";
  if (v === true) return "True";
  if (v === false) return "False";
  if (typeof v === "number") return numStr(v);
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "string") return reprStr(v);
  if (Array.isArray(v)) return "[" + v.map(repr).join(", ") + "]";
  if (isDict(v)) return "{" + Object.keys(v).map((k) => reprStr(k) + ": " + repr(v[k])).join(", ") + "}";
  return String(v);
}

/** str(v) (and f"{v}") */
export function str(v) {
  return typeof v === "string" ? v : repr(v);
}

// ---------------------------------------------------------------------------------------------------
// Unicode data from Python 3.13 (unicode.js, made by tests/web/test_store_unicode.mjs): JS engines carry their
// own Unicode version (node 26 and Chrome 155: 17; Python 3.13: 15.1), so \p{...}, toLowerCase() and the like
// would give other answers than library_store.py for the code points the versions disagree on.

/** A base-36 gap,run,gap,run... string -> sorted boundaries [start0, end0, start1, end1, ...] (end exclusive). */
function decodeSet(text) {
  const parts = text.split(",");
  const out = new Int32Array(parts.length);
  let at = 0;
  for (let i = 0; i < parts.length; i++) out[i] = at += parseInt(parts[i], 36);
  return out;
}

/** cp is in the set (binary search over the boundaries). */
function inSet(bounds, cp) {
  let lo = 0, hi = bounds.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (bounds[mid] <= cp) lo = mid + 1;
    else hi = mid;
  }
  return (lo & 1) === 1;
}

const lazy = (make) => {
  let v = null;
  return () => (v ??= make());
};
const nonPrint = lazy(() => decodeSet(U.NONPRINT));
const caseIgnorable = lazy(() => decodeSet(U.CASE_IGNORABLE));
const cased = lazy(() => decodeSet(U.CASED));

/** runs [first, count, offset, step = 1] or [cp, "str"] -> Map(cp -> str) */
function decodeRuns(runs) {
  const m = new Map();
  for (const r of runs) {
    if (typeof r[1] === "string") m.set(r[0], r[1]);
    else for (let i = 0, step = r[3] || 1; i < r[1]; i++) m.set(r[0] + i * step, String.fromCodePoint(r[0] + i * step + r[2]));
  }
  return m;
}
const lowerMap = lazy(() => decodeRuns(U.LOWER_RUNS));
const foldMap = lazy(() => decodeRuns(U.CASEFOLD_RUNS));

/** str.isprintable() of one code point (repr() writes it as it is). */
export const isPrintable = (cp) => !inSet(nonPrint(), cp);

/** str.lower() of a one-character string (U+03A3 alone lowers to U+03C3, as in Python). */
export function lowerCp(cp) {
  if (cp < 0x80) return String.fromCharCode(cp >= 65 && cp <= 90 ? cp + 32 : cp);
  return lowerMap().get(cp) ?? String.fromCodePoint(cp);
}

const NOT_ASCII = /[^\x00-\x7f]/;
const NON_ASCII_RUN = /[^\x00-\x7f]+/g;

/** The code point that ends just before UTF-16 index i, as [cp, its start], or null at the start. */
function cpBefore(s, i) {
  if (i <= 0) return null;
  const lo = s.charCodeAt(i - 1);
  if (lo >= 0xdc00 && lo <= 0xdfff && i >= 2) {
    const hi = s.charCodeAt(i - 2);
    if (hi >= 0xd800 && hi <= 0xdbff) return [(hi - 0xd800) * 0x400 + lo - 0xdc00 + 0x10000, i - 2];
  }
  return [lo, i - 1];
}

/** CPython's handle_capital_sigma for the U+03A3 at UTF-16 index i: \p{cased}\p{case-ignorable}* before it and
 *  not \p{case-ignorable}*\p{cased} after it -> final form U+03C2. */
function finalSigma(s, i) {
  const ci = caseIgnorable(), cs = cased();
  let b = cpBefore(s, i);
  while (b && inSet(ci, b[0])) b = cpBefore(s, b[1]);
  if (!b || !inSet(cs, b[0])) return false;
  for (let j = i + 1; j < s.length;) {
    const c = s.codePointAt(j);
    if (!inSet(ci, c)) return !inSet(cs, c);
    j += c > 0xffff ? 2 : 1;
  }
  return true;
}

/** str.lower(): per code point from Python's table, plus Final_Sigma (U+03A3 -> U+03C2 after a cased letter,
 *  case-ignorable ones skipped, unless a cased letter follows), as CPython's lower(). ASCII runs go through
 *  toLowerCase(), which is the same everywhere. */
export function lower(s) {
  if (!NOT_ASCII.test(s)) return s.toLowerCase();
  const m = lowerMap();
  let out = "", last = 0;
  NON_ASCII_RUN.lastIndex = 0;
  for (let r; (r = NON_ASCII_RUN.exec(s));) {
    out += s.slice(last, r.index).toLowerCase();
    const end = r.index + r[0].length;
    for (let j = r.index; j < end;) {
      const c = s.codePointAt(j);
      if (c === 0x3a3) out += finalSigma(s, j) ? "\u03c2" : "\u03c3";
      else out += m.get(c) ?? String.fromCodePoint(c);
      j += c > 0xffff ? 2 : 1;
    }
    last = end;
  }
  return out + s.slice(last).toLowerCase();
}

/** str.casefold() (per code point, so no final-sigma context, as Python) */
export function casefold(s) {
  const m = foldMap();
  let out = "";
  for (const ch of s) {
    const c = ch.codePointAt(0);
    out += m.get(c) ?? lowerCp(c);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------
// Decimal digits (\d in Python's re for str patterns, str.isdecimal(), int()): runs of ten from each zero

const hexEsc = (c) => "\\u{" + c.toString(16) + "}";
/** The contents of a RegExp character class (u flag) for Python's \d. */
export const DIGIT_CLASS = U.DIGIT_ZEROS.map((z) => (z === 0x30 ? "0-9" : hexEsc(z) + "-" + hexEsc(z + 9))).join("");
export const ND = new RegExp(`[${DIGIT_CLASS}]`, "u");

/** The value 0-9 of a Python decimal digit (any script); -1 for anything else. */
export function digitValue(ch) {
  const c = ch.codePointAt(0);
  if (c >= 0x30 && c <= 0x39) return c - 0x30;
  const z = U.DIGIT_ZEROS;
  let lo = 0, hi = z.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (z[mid] <= c) lo = mid + 1;
    else hi = mid;
  }
  return lo > 0 && c - z[lo - 1] < 10 ? c - z[lo - 1] : -1;
}

const INT_RE = new RegExp(`^[+-]?[${DIGIT_CLASS}]+(?:_[${DIGIT_CLASS}]+)*$`, "u");

/** int(s) for a str: Python whitespace around, a sign, Unicode digits, single underscores between digits.
 *  Returns a BigInt; ValueError (Python's message) otherwise. */
export function intParse(s) {
  const t = strip(s);
  if (!INT_RE.test(t) || cpLen(t.replace(/^[+-]/, "").replace(/_/g, "")) > 4300) {
    throw new ValueError(`invalid literal for int() with base 10: ${reprStr(s)}`);
  }
  let digits = "";
  for (const ch of t.replace(/^[+-]/, "")) if (ch !== "_") digits += String(digitValue(ch));
  const n = BigInt(digits);
  return t[0] === "-" ? -n : n;
}

/** int(v) for a JSON value (bool, int, float, str); TypeError / ValueError like Python. */
export function toInt(v) {
  if (typeof v === "boolean") return Number(v);
  if (typeof v === "number") {
    if (!Number.isFinite(v)) {
      if (v !== v) throw new ValueError("cannot convert float NaN to integer");
      throw new RangeError("cannot convert float infinity to integer");
    }
    return Math.trunc(v);
  }
  if (typeof v === "string") return Number(intParse(v));
  throw new TypeError(`int() argument must be a string, a bytes-like object or a real number, not '${typeName(v)}'`);
}

// ---------------------------------------------------------------------------------------------------
// datetime.fromisoformat(s).strftime("%Y-%m-%d %H:%M"), a port of CPython 3.13's C parser
// (_find_isoformat_datetime_separator, parse_isoformat_date, parse_isoformat_time, parse_hh_mm_ss_ff).
// Returns null where Python raises (TypeError / ValueError).

const isD = (c) => c >= 48 && c <= 57;

function digitsAt(s, p, n) {
  let v = 0;
  for (let i = 0; i < n; i++) {
    const c = s.charCodeAt(p + i);
    if (!isD(c)) return null;
    v = v * 10 + (c - 48);
  }
  return v;
}

function sepLocation(s) {
  const len = s.length;
  if (len === 7) return 7;
  const at = (i) => (i < len ? s[i] : "\0");
  if (at(4) === "-") {
    if (at(5) === "W") {
      if (len < 8) return -1;
      if (len > 8 && at(8) === "-") {
        if (len === 9) return -1;
        if (len > 10 && isD(s.charCodeAt(10))) return 8;
        return 10;
      }
      return 8;
    }
    return 10;
  }
  if (at(4) === "W") {
    let idx = 7;
    for (; idx < len; idx++) if (!isD(s.charCodeAt(idx))) break;
    if (idx < 9) return idx;
    return idx % 2 === 0 ? 7 : 8;
  }
  return 8;
}

const daysIn = (y, m) => [31, (y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0)) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];

function isoWeekToDate(y, w, d) {
  if (y < 1 || y > 9999) return null;
  const jan4 = new Date(Date.UTC(2000, 0, 4));
  jan4.setUTCFullYear(y);
  const isoWeekday = (jan4.getUTCDay() + 6) % 7; // Monday 0
  const lastWeek = (() => { // 53 weeks when Jan 1 is a Thursday, or a Wednesday in a leap year
    const j1 = new Date(Date.UTC(2000, 0, 1)); j1.setUTCFullYear(y);
    const wd = (j1.getUTCDay() + 6) % 7;
    const leap = daysIn(y, 2) === 29;
    return wd === 3 || (wd === 2 && leap) ? 53 : 52;
  })();
  if (w <= 0 || w > lastWeek || d <= 0 || d > 7) return null;
  const t = new Date(jan4.getTime() - isoWeekday * 864e5 + ((w - 1) * 7 + (d - 1)) * 864e5);
  return [t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()];
}

function parseDate(s, end) {
  // s is ASCII here; reads past `end` see the next characters (as the C code sees the string)
  let p = 0;
  const year = digitsAt(s, p, 4);
  if (year === null) return null;
  p += 4;
  const usesSep = s[p] === "-";
  if (usesSep) p++;
  if (s[p] === "W") {
    p++;
    const week = digitsAt(s, p, 2);
    if (week === null) return null;
    p += 2;
    let day = 1;
    if (p < end) {
      if (usesSep && s[p++] !== "-") return null;
      day = digitsAt(s, p, 1);
      if (day === null) return null;
    }
    return isoWeekToDate(year, week, day);
  }
  const month = digitsAt(s, p, 2);
  if (month === null) return null;
  p += 2;
  if (usesSep && s[p++] !== "-") return null;
  const day = digitsAt(s, p, 2);
  if (day === null) return null;
  return [year, month, day];
}

// [HH[:?MM[:?SS[.ffffff]]]] between p and end; returns {rv, vals} (rv 0 = end of string, 1 = more follows)
function parseHms(s, p, end) {
  const vals = [0, 0, 0];
  let hasSep = true;
  for (let i = 0; i < 3; i++) {
    const v = digitsAt(s, p, 2);
    if (v === null) return null;
    vals[i] = v;
    p += 2;
    const c = p < s.length ? s[p] : "\0";
    p++;
    if (i === 0) hasSep = c === ":";
    if (p >= end) return { rv: c !== "\0" ? 1 : 0, vals };
    if (hasSep && c === ":") continue;
    if (c === "." || c === ",") break;
    if (!hasSep) p--;
    else return null;
  }
  const remain = end - p;
  const toParse = Math.min(remain, 6);
  if (toParse <= 0 || digitsAt(s, p, toParse) === null) return null;
  p += toParse;
  while (p < s.length && isD(s.charCodeAt(p))) p++;
  return { rv: p < s.length && s[p] !== "\0" ? 1 : 0, vals }; // the C code stops at a NUL as at the end
}

/** datetime.fromisoformat(s).strftime("%Y-%m-%d %H:%M"), or null where Python raises. */
export function isoMinute(s) {
  if (typeof s !== "string") return null;
  let cps = Array.from(s);
  if (cps.length < 7) return null;
  for (const pos of [7, 8, 10]) { // a surrogate separator is read as "T"
    if (pos > cps.length) break;
    if (pos < cps.length && /^[\uD800-\uDFFF]$/.test(cps[pos])) { cps[pos] = "T"; break; }
  }
  // The C code works on the UTF-8 bytes (PyUnicode_AsUTF8AndSize; a lone surrogate left is an encode error), with
  // byte lengths, and stops where a NUL ends its C string. Here each byte is one char of a binary string; a byte
  // of 0x80 or more is never a digit or a separator, so a non-ASCII character fails wherever the C code reads it.
  if (cps.some((c) => c.length === 1 && c >= "\uD800" && c <= "\uDFFF")) return null;
  const bytes = new TextEncoder().encode(cps.join(""));
  let b = "";
  for (let i = 0; i < bytes.length; i += 8192) b += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
  const sep = sepLocation(b);
  if (sep < 0) return null;
  const ymd = parseDate(b, sep); // reads past the date see the separator and the time, as in C
  if (!ymd) return null;
  let hh = 0, mm = 0;
  if (b.length > sep) {
    const lead = b.charCodeAt(sep); // the separator is any one character, of 1 to 4 bytes
    const t = b.slice(sep + ((lead & 0x80) === 0 ? 1 : (lead & 0xf0) === 0xe0 ? 3 : (lead & 0xf0) === 0xf0 ? 4 : 2));
    let tz = 0;
    while (tz < t.length && !"Z+-".includes(t[tz])) tz++;
    const r = parseHms(t, 0, tz);
    if (!r) return null;
    if (tz === t.length) {
      if (r.rv === 1) return null;
    } else if (t[tz] === "Z") {
      if (tz + 1 < t.length && t[tz + 1] !== "\0") return null; // *(tzinfo_pos + 1) != '\0'
    } else {
      const z = parseHms(t, tz + 1, t.length);
      if (!z || z.rv) return null;
      const off = z.vals[0] * 3600 + z.vals[1] * 60 + z.vals[2];
      if (off >= 86400) return null;
    }
    [hh, mm] = r.vals;
    if (hh > 23 || mm > 59 || r.vals[2] > 59) return null;
  }
  const [y, mo, d] = ymd;
  if (y < 1 || y > 9999 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return null;
  const p2 = (n) => String(n).padStart(2, "0");
  return `${String(y).padStart(4, "0")}-${p2(mo)}-${p2(d)} ${p2(hh)}:${p2(mm)}`;
}

// ---------------------------------------------------------------------------------------------------
// base64.b64decode(s, validate=True): only the alphabet, correct padding; null where Python raises

const B64_STRICT = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export function b64decodeStrict(s) {
  if (typeof s !== "string" || !B64_STRICT.test(s)) return null;
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** re.escape-like escaping for building a RegExp (u-mode safe: only syntax characters). */
export const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
