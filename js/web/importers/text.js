// Text helpers of importers.py (_ws, _strip_tags, _clean_text, _strip_markup, _unescape_entities) and the
// Python behaviour they rest on, for the browser port (WEB_CONTRACT.md section 6.2). Pure ES module.
//
// Python is the reference: every function here returns what the Python code returns for the same input,
// on any JavaScript engine. To get there without depending on the engine's Unicode version, the Unicode
// properties Python uses come from tables generated out of Python itself (entities.js), and every regular
// expression is written in Python syntax and translated by re() below, which gives \w \d \s \b, ".", "$",
// re.IGNORECASE and the rest Python's exact meaning (see the notes at re()).
//
// Exports (Python name in brackets):
//   ws [_ws]  stripTags [_strip_tags]  cleanText [_clean_text]  stripMarkup [_strip_markup]
//   unescapeEntities [_unescape_entities]  htmlUnescape [html.unescape]  WS_RE TAG_RE MARKUP_RE ENTITY_RE
//   MARKUP_NAMES
//   re(pattern, flags) -> PyRe with search/match/fullmatch/sub/subn/findall/finditer/split; PyMatch;
//   reEscape [re.escape]; REGISTRY (every pattern compiled, for the differential test)
//   Python str/number semantics: pyStr pyRepr pyInt pyFloatRepr pyTruthy isDict pyGet pyIter
//   pyLower pyUpper pyCapitalize pyIsUpper pyIsLower pyIsAlpha pyIsSpace pyIsAscii pyStrip pyLstrip
//   pyRstrip pySplit pyPartition pyRpartition pyCount pyStartsWith pyEndsWith normalize combining
//   cpLen cpSlice cpAt cpChars cpIndex utf16Index pyLjust
//   pyIndex (obj[i] for an int i)
//   Error classes: PyValueError PyTypeError PyOverflowError PyKeyError PyIndexError (Python's messages)
//   Unicode predicates: isWordCp isDigitCp isSpaceCp isAlphaCp isUpperCp isLowerCp isTitleCp
//   isUnassignedCp isPrintableCp isNameStartCp isNameCharCp decimalValue

import {
  R, DIGIT_ZEROS, ICASE, UPPER, TITLE, INVALID_CHARREFS, INVALID_CODEPOINTS, HTML5,
} from "./entities.js";

// ---------------------------------------------------------------------------------------------------
// Python exceptions (the type and message Python would raise; callers that mirror a Python
// "except ValueError" catch these by class)

export class PyValueError extends Error {
  constructor(msg) { super(msg); this.name = "ValueError"; }
}
export class PyTypeError extends Error {
  constructor(msg) { super(msg); this.name = "TypeError"; }
}
export class PyOverflowError extends Error {
  constructor(msg) { super(msg); this.name = "OverflowError"; }
}
export class PyKeyError extends Error {
  constructor(msg) { super(msg); this.name = "KeyError"; }
}
export class PyIndexError extends Error {
  constructor(msg) { super(msg); this.name = "IndexError"; }
}

// ---------------------------------------------------------------------------------------------------
// Unicode tables

const TABLES = new Map();

// "gap,len;gap,len;..." (base 36) -> Int32Array [start0, end0, start1, end1, ...]
function unpack(packed) {
  const parts = packed ? packed.split(";") : [];
  const out = new Int32Array(parts.length * 2);
  let prev = -1;
  for (let i = 0; i < parts.length; i++) {
    const comma = parts[i].indexOf(",");
    const start = prev + 1 + parseInt(parts[i].slice(0, comma), 36);
    const end = start + parseInt(parts[i].slice(comma + 1), 36);
    out[2 * i] = start;
    out[2 * i + 1] = end;
    prev = end;
  }
  return out;
}

function table(name) {
  let t = TABLES.get(name);
  if (!t) {
    t = unpack(R[name]);
    TABLES.set(name, t);
  }
  return t;
}

function inTable(name, cp) {
  const t = table(name);
  let lo = 0, hi = (t.length >> 1) - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cp < t[2 * mid]) hi = mid - 1;
    else if (cp > t[2 * mid + 1]) lo = mid + 1;
    else return true;
  }
  return false;
}

export const isWordCp = (cp) => inTable("word", cp);           // re \w
export const isDigitCp = (cp) => inTable("digit", cp);         // re \d, str.isdecimal
export const isSpaceCp = (cp) => inTable("ws", cp);            // re \s, str.isspace, str.split()
export const isAlphaCp = (cp) => inTable("alpha", cp);         // str.isalpha
export const isUpperCp = (cp) => inTable("upper", cp);         // Py_UNICODE_ISUPPER
export const isLowerCp = (cp) => inTable("lower", cp);         // Py_UNICODE_ISLOWER
export const isTitleCp = (cp) => inTable("title", cp);         // Py_UNICODE_ISTITLE (category Lt)
export const isUnassignedCp = (cp) => inTable("unassigned", cp);
export const isPrintableCp = (cp) => !inTable("nonprint", cp); // str.isprintable
export const isNameStartCp = (cp) => inTable("nameStart", cp); // expat (namespace mode: no ":")
export const isNameCharCp = (cp) => inTable("nameChar", cp);
export const combining = (cp) => inTable("combining", cp);     // unicodedata.combining(c) != 0

// Decimal value of a \d code point (Py_UNICODE_TODECIMAL), -1 when it is not a decimal digit.
export function decimalValue(cp) {
  if (cp >= 48 && cp <= 57) return cp - 48;
  if (!isDigitCp(cp)) return -1;
  let lo = 0, hi = DIGIT_ZEROS.length - 1, best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (DIGIT_ZEROS[mid] <= cp) { best = DIGIT_ZEROS[mid]; lo = mid + 1; } else hi = mid - 1;
  }
  return best < 0 ? -1 : cp - best;
}

// ---------------------------------------------------------------------------------------------------
// Code points. Python indexes strings by code point; JavaScript by UTF-16 unit. Use these wherever a
// Python length, index or slice could land on a character outside the Basic Multilingual Plane.

export function cpChars(s) {
  return Array.from(s);
}

export function cpLen(s) {
  let n = s.length;
  for (let i = 0; i < s.length - 1; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) { n--; i++; }
    }
  }
  return n;
}

function normIndex(i, n, dflt) {
  if (i === undefined || i === null) return dflt;
  if (i < 0) { i += n; if (i < 0) i = 0; }
  return i > n ? n : i;
}

// Python s[a:b] (code points, negative indices allowed)
export function cpSlice(s, a, b) {
  let ascii = true;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdfff) { ascii = false; break; }
  }
  if (ascii) {
    const n = s.length;
    const x = normIndex(a, n, 0), y = normIndex(b, n, n);
    return x < y ? s.slice(x, y) : "";
  }
  const cs = cpChars(s), n = cs.length;
  const x = normIndex(a, n, 0), y = normIndex(b, n, n);
  return x < y ? cs.slice(x, y).join("") : "";
}

// Python s[i] ("" when out of range instead of IndexError)
export function cpAt(s, i) {
  return cpSlice(s, i, i === -1 ? undefined : i + 1);
}

// Code point index of the UTF-16 offset u in s
export function cpIndex(s, u) {
  return cpLen(s.slice(0, u));
}

// UTF-16 offset of the code point index n in s (clamped to the string)
export function utf16Index(s, n) {
  let u = 0;
  for (let k = 0; k < n && u < s.length; k++) {
    const c = s.charCodeAt(u);
    u += c >= 0xd800 && c <= 0xdbff && u + 1 < s.length && (s.charCodeAt(u + 1) & 0xfc00) === 0xdc00 ? 2 : 1;
  }
  return u;
}

export function pyIsAscii(s) {
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 127) return false;
  return true;
}

// ---------------------------------------------------------------------------------------------------
// str methods

function codePoints(s) {
  const out = [];
  for (const ch of s) out.push(ch.codePointAt(0));
  return out;
}

export function pyIsSpace(s) {   // str.isspace()
  if (!s) return false;
  for (const ch of s) if (!isSpaceCp(ch.codePointAt(0))) return false;
  return true;
}

// str.strip / lstrip / rstrip: no chars -> Python's whitespace; chars -> that set of code points
function stripSet(chars) {
  if (chars === undefined || chars === null) return null;
  return new Set(codePoints(chars));
}

function stripImpl(s, chars, left, right) {
  const set = stripSet(chars);
  const keep = set ? (cp) => !set.has(cp) : (cp) => !isSpaceCp(cp);
  const cs = cpChars(s);
  let a = 0, b = cs.length;
  if (left) while (a < b && !keep(cs[a].codePointAt(0))) a++;
  if (right) while (b > a && !keep(cs[b - 1].codePointAt(0))) b--;
  return a === 0 && b === cs.length ? s : cs.slice(a, b).join("");
}

export const pyStrip = (s, chars) => stripImpl(s, chars, true, true);
export const pyLstrip = (s, chars) => stripImpl(s, chars, true, false);
export const pyRstrip = (s, chars) => stripImpl(s, chars, false, true);

// str.split() with no separator (runs of Python whitespace, no empty strings); with sep, str.split(sep)
export function pySplit(s, sep, maxsplit = -1) {
  if (sep !== undefined && sep !== null) {
    if (sep === "") throw new PyValueError("empty separator");
    const parts = s.split(sep);
    if (maxsplit < 0 || parts.length - 1 <= maxsplit) return parts;
    return parts.slice(0, maxsplit).concat([parts.slice(maxsplit).join(sep)]);
  }
  const out = [];
  let cur = "", n = 0;
  const cs = cpChars(s);
  let i = 0;
  while (i < cs.length) {
    while (i < cs.length && isSpaceCp(cs[i].codePointAt(0))) i++;
    if (i >= cs.length) break;
    if (maxsplit >= 0 && n >= maxsplit) {
      let j = cs.length;
      while (j > i && isSpaceCp(cs[j - 1].codePointAt(0))) j--;
      out.push(cs.slice(i, j).join(""));
      return out;
    }
    cur = "";
    while (i < cs.length && !isSpaceCp(cs[i].codePointAt(0))) cur += cs[i++];
    out.push(cur);
    n++;
  }
  return out;
}

// str.rsplit(sep, maxsplit)
export function pyRsplit(s, sep, maxsplit = -1) {
  const parts = s.split(sep);
  if (maxsplit < 0 || parts.length - 1 <= maxsplit) return parts;
  const k = parts.length - maxsplit;
  return [parts.slice(0, k).join(sep)].concat(parts.slice(k));
}

export function pyPartition(s, sep) {
  const i = s.indexOf(sep);
  return i < 0 ? [s, "", ""] : [s.slice(0, i), sep, s.slice(i + sep.length)];
}

export function pyRpartition(s, sep) {
  const i = s.lastIndexOf(sep);
  return i < 0 ? ["", "", s] : [s.slice(0, i), sep, s.slice(i + sep.length)];
}

// str.count(sub): non-overlapping occurrences; "" counts len + 1 like Python
export function pyCount(s, sub) {
  if (sub === "") return cpLen(s) + 1;
  let n = 0, i = 0;
  for (;;) {
    const j = s.indexOf(sub, i);
    if (j < 0) return n;
    n++;
    i = j + sub.length;
  }
}

export function pyStartsWith(s, prefixes) {
  return (Array.isArray(prefixes) ? prefixes : [prefixes]).some((p) => s.startsWith(p));
}

export function pyEndsWith(s, suffixes) {
  return (Array.isArray(suffixes) ? suffixes : [suffixes]).some((p) => s.endsWith(p));
}

export function pyLjust(s, width, fill = " ") {
  const n = cpLen(s);
  return n >= width ? s : s + fill.repeat(width - n);
}

// Apply an engine string transform to the runs of code points Python knows (category != Cn); code
// points Python leaves unassigned are passed through, as Python's case mapping and normalization do.
function onAssigned(s, fn) {
  let plain = true;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0x0370 && !(c >= 0x4e00 && c <= 0x9fff)) { plain = false; break; }
  }
  if (plain) return fn(s);
  let out = "", run = "";
  for (const ch of s) {
    if (isUnassignedCp(ch.codePointAt(0))) {
      if (run) { out += fn(run); run = ""; }
      out += ch;
    } else run += ch;
  }
  return run ? out + fn(run) : out;
}

const isCaseIgnorableCp = (cp) => inTable("caseIgnorable", cp);
const isCasedCp = (cp) => inTable("cased", cp);    // only asked of code points that are not case-ignorable
const engineLower = (x) => x.toLowerCase();

// Python's Final_Sigma context for the capital sigma cps[i]: a cased character before it and none after it,
// skipping case-ignorable ones both ways (handle_capital_sigma in unicodeobject.c), with Python's properties.
function finalSigma(cps, i) {
  let j = i - 1;
  while (j >= 0 && isCaseIgnorableCp(cps[j].codePointAt(0))) j--;
  if (j < 0 || !isCasedCp(cps[j].codePointAt(0))) return false;
  j = i + 1;
  while (j < cps.length && isCaseIgnorableCp(cps[j].codePointAt(0))) j++;
  return j === cps.length || !isCasedCp(cps[j].codePointAt(0));
}

// str.lower(): the engine's full lowercase mapping (equal to Python's for every code point Python assigns;
// checked code point by code point in tests/web/test_imp_pure_unicode.mjs), except for the capital sigma: its
// final form depends on the characters around it, which the engine judges with its own Unicode version
// (U+0295 and U+1171E changed in Unicode 16), so it is decided here from Python's tables.
export function pyLower(s) {
  if (!s.includes("\u03a3")) return onAssigned(s, engineLower);
  const cps = cpChars(s);
  let out = "", run = "";
  for (let i = 0; i < cps.length; i++) {
    if (cps[i] !== "\u03a3") {
      run += cps[i];
      continue;
    }
    if (run) {
      out += onAssigned(run, engineLower);
      run = "";
    }
    out += finalSigma(cps, i) ? "\u03c2" : "\u03c3";
  }
  return run ? out + onAssigned(run, engineLower) : out;
}

// str.upper(): Python's own table (engines with a newer Unicode give some letters new capitals)
export function pyUpper(s) {
  let out = "";
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (cp < 128) out += cp >= 97 && cp <= 122 ? String.fromCharCode(cp - 32) : ch;
    else out += UPPER.get(cp) ?? ch;
  }
  return out;
}

// str.capitalize() (Python 3.8+): title case of the first character, the rest lowercased
export function pyCapitalize(s) {
  if (!s) return s;
  const first = String.fromCodePoint(s.codePointAt(0));
  const cp = first.codePointAt(0);
  const head = TITLE.get(cp) ?? UPPER.get(cp) ?? (cp >= 97 && cp <= 122 ? first.toUpperCase() : first);
  return head + pyLower(s).slice(pyLower(first).length);
}

export function pyIsUpper(s) {   // str.isupper()
  const cps = codePoints(s);
  if (cps.length === 1) return isUpperCp(cps[0]);
  let cased = false;
  for (const cp of cps) {
    if (isLowerCp(cp) || isTitleCp(cp)) return false;
    if (!cased && isUpperCp(cp)) cased = true;
  }
  return cased;
}

export function pyIsLower(s) {   // str.islower()
  const cps = codePoints(s);
  if (cps.length === 1) return isLowerCp(cps[0]);
  let cased = false;
  for (const cp of cps) {
    if (isUpperCp(cp) || isTitleCp(cp)) return false;
    if (!cased && isLowerCp(cp)) cased = true;
  }
  return cased;
}

export function pyIsAlpha(s) {   // str.isalpha()
  const cps = codePoints(s);
  return cps.length > 0 && cps.every(isAlphaCp);
}

// unicodedata.normalize(form, s)
export function normalize(form, s) {
  return onAssigned(s, (x) => x.normalize(form));
}

// ---------------------------------------------------------------------------------------------------
// Python values. JSON-shaped data maps as: dict = plain object, list = array, str = string,
// int/float = number, bool = boolean, None = null (undefined is treated as None).

export function isDict(v) {
  return v !== null && typeof v === "object" && Object.prototype.toString.call(v) === "[object Object]";
}

// bool(v)
export function pyTruthy(v) {
  if (v === null || v === undefined || v === false || v === "") return false;
  if (typeof v === "number") return v !== 0;          // NaN is truthy in Python
  if (Array.isArray(v)) return v.length > 0;
  if (v instanceof Map || v instanceof Set) return v.size > 0;
  if (isDict(v)) return Object.keys(v).length > 0;
  return true;
}

// dict.get(key, dflt) on a plain object (own properties only)
export function pyGet(o, key, dflt = null) {
  if (!isDict(o)) return dflt;
  return Object.prototype.hasOwnProperty.call(o, key) && o[key] !== undefined ? o[key] : dflt;
}

function typeName(v) {
  if (v === null || v === undefined) return "NoneType";
  if (typeof v === "boolean") return "bool";
  if (typeof v === "number") return Number.isInteger(v) ? "int" : "float";
  if (typeof v === "string") return "str";
  if (Array.isArray(v)) return "list";
  if (isDict(v)) return "dict";
  return typeof v;
}

// iter(v): list items, str code points, dict keys; TypeError otherwise
export function pyIter(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === "string") return cpChars(v);
  if (isDict(v)) return Object.keys(v);
  if (v instanceof Map || v instanceof Set) return [...v.keys()];
  throw new PyTypeError(`'${typeName(v)}' object is not iterable`);
}

// obj[i] for an integer i: list item, str code point, IndexError / KeyError / TypeError like Python
export function pyIndex(obj, i) {
  if (Array.isArray(obj) || typeof obj === "string") {
    const seq = typeof obj === "string" ? cpChars(obj) : obj;
    const j = i < 0 ? i + seq.length : i;
    if (j < 0 || j >= seq.length) {
      throw new PyIndexError(typeof obj === "string" ? "string index out of range" : "list index out of range");
    }
    return seq[j];
  }
  if (isDict(obj)) throw new PyKeyError(String(i));
  throw new PyTypeError(`'${typeName(obj)}' object is not subscriptable`);
}

// repr(float): shortest round-trip digits; exponent form when the exponent is < -4 or >= 16
export function pyFloatRepr(x) {
  if (Number.isNaN(x)) return "nan";
  if (x === Infinity) return "inf";
  if (x === -Infinity) return "-inf";
  if (Number.isInteger(x)) return pyIntRepr(x);
  const sign = x < 0 ? "-" : "";
  const [mant, expStr] = Math.abs(x).toExponential().split("e");
  const digits = mant.replace(".", "");
  const exp = Number(expStr);
  if (exp < -4 || exp >= 16) {
    const m = digits.length > 1 ? digits[0] + "." + digits.slice(1) : digits;
    const e = Math.abs(exp);
    return `${sign}${m}e${exp < 0 ? "-" : "+"}${e < 10 ? "0" + e : e}`;
  }
  if (exp < 0) return `${sign}0.${"0".repeat(-exp - 1)}${digits}`;
  if (digits.length <= exp + 1) return `${sign}${digits}${"0".repeat(exp + 1 - digits.length)}.0`;
  return `${sign}${digits.slice(0, exp + 1)}.${digits.slice(exp + 1)}`;
}

function pyIntRepr(x) {
  if (Object.is(x, -0)) return "0";
  return Math.abs(x) < 1e21 ? String(x) : BigInt(x).toString();
}

function reprStr(s) {
  const quote = s.includes("'") && !s.includes('"') ? '"' : "'";
  let out = quote;
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (ch === quote || ch === "\\") out += "\\" + ch;
    else if (ch === "\t") out += "\\t";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (cp < 0x20 || cp === 0x7f) out += "\\x" + cp.toString(16).padStart(2, "0");
    else if (cp < 0x7f) out += ch;
    else if (isPrintableCp(cp) && !(cp >= 0xd800 && cp <= 0xdfff)) out += ch;
    else if (cp <= 0xff) out += "\\x" + cp.toString(16).padStart(2, "0");
    else if (cp <= 0xffff) out += "\\u" + cp.toString(16).padStart(4, "0");
    else out += "\\U" + cp.toString(16).padStart(8, "0");
  }
  return out + quote;
}

// repr(v)
export function pyRepr(v) {
  if (v === null || v === undefined) return "None";
  if (v === true) return "True";
  if (v === false) return "False";
  if (typeof v === "number") return Number.isInteger(v) ? pyIntRepr(v) : pyFloatRepr(v);
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "string") return reprStr(v);
  if (Array.isArray(v)) return "[" + v.map(pyRepr).join(", ") + "]";
  if (isDict(v)) return "{" + Object.keys(v).map((k) => pyRepr(k) + ": " + pyRepr(v[k])).join(", ") + "}";
  return String(v);
}

// str(v)
export function pyStr(v) {
  return typeof v === "string" ? v : pyRepr(v);
}

const INT_MAX_STR_DIGITS = 4300;

function intDigitsLimit(ndigits) {
  if (ndigits > INT_MAX_STR_DIGITS) {
    throw new PyValueError(`Exceeds the limit (${INT_MAX_STR_DIGITS} digits) for integer string conversion: `
      + `value has ${ndigits} digits; use sys.set_int_max_str_digits() to increase the limit`);
  }
}

// int(v) for a str (base 10, as Python parses it), number, bool; the result is a JS number
export function pyInt(v) {
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number") {
    if (Number.isNaN(v)) throw new PyValueError("cannot convert float NaN to integer");
    if (!Number.isFinite(v)) throw new PyOverflowError("cannot convert float infinity to integer");
    return Math.trunc(v) || 0;
  }
  if (typeof v !== "string") {
    throw new PyTypeError("int() argument must be a string, a bytes-like object or a real number, "
      + `not '${typeName(v)}'`);
  }
  // _PyUnicode_TransformDecimalAndSpaceToASCII, then PyLong_FromString(base 10)
  let ascii = "";
  for (const ch of v) {
    const cp = ch.codePointAt(0);
    if (cp < 127) { ascii += ch; continue; }
    if (isSpaceCp(cp)) { ascii += " "; continue; }
    const d = decimalValue(cp);
    if (d < 0) { ascii += "?"; break; }
    ascii += String.fromCharCode(48 + d);
  }
  const m = /^[ \t\n\v\f\r]*([+-]?)([0-9](?:_?[0-9])*)[ \t\n\v\f\r]*$/.exec(ascii);
  if (!m) throw new PyValueError(`invalid literal for int() with base 10: ${reprStr(v)}`);
  const digits = m[2].replace(/_/g, "");
  intDigitsLimit(digits.length);
  const n = Number(digits);
  return m[1] === "-" ? -n : n;
}

// ---------------------------------------------------------------------------------------------------
// Regular expressions with Python's semantics.
//
// re(pattern, flags) compiles a pattern written in Python syntax (copy it verbatim from importers.py,
// as String.raw) into a JavaScript RegExp (code unit mode, see below) with the same meaning:
//   \d \w \s (and \D \W \S, inside and outside classes) match exactly the code points Python's re does
//   (tables from Python, not the engine's), \b is Python's word boundary, "." excludes only "\n",
//   "$" also matches before a final "\n" (as Python's does), \A \Z, ^ and $ under re.M use only "\n",
//   (?P<name>..) and (?P=name) work, {,n} works, and re.IGNORECASE matches what Python matches
//   (for ASCII letters that includes U+0130 U+0131 for i, U+212A for k, U+017F for s).
// flags: any of "I" (re.I), "S" (re.S), "M" (re.M); "B" makes it a bytes pattern (\d \w \s \b and
// re.I ASCII only) to run on latin-1 strings (one char per byte); "D" records group spans.
// Positions in match objects are UTF-16 offsets into the string searched (slice with them freely; use
// cpIndex() where Python does arithmetic on positions).
// Not supported (throws when compiled): \B, backreferences by number, possessive quantifiers,
// re.X, re.ASCII, conditional groups, and a cased non-ASCII literal under re.I.
// finditer / sub / split follow Python 3.7+ around empty matches: after an empty match at p, a non-empty
// match starting at p comes next if there is one (re.findall("|a", "a") == ["", "a", ""]).
// Known difference, flagged as PyRe#emptyLoop: a quantifier over something that can match the empty string,
// such as (a|)* or ($|x)?. JavaScript drops an iteration that matched nothing; Python keeps it (with its
// groups) and stops repeating. No importer pattern has one (tests/web/test_imp_pure_fix_r1.mjs checks).

const MAXCP = 0x10ffff;

function normSet(items) {
  const rs = items.map((r) => [r[0], r[1]]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out = [];
  for (const r of rs) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1] + 1) { if (r[1] > last[1]) last[1] = r[1]; } else out.push(r);
  }
  return out;
}

function complement(set) {
  const out = [];
  let next = 0;
  for (const [a, b] of set) {
    if (a > next) out.push([next, a - 1]);
    next = b + 1;
  }
  if (next <= MAXCP) out.push([next, MAXCP]);
  return out;
}

const CAT_CACHE = new Map();

function categorySet(c, bytes) {
  const key = c + (bytes ? "b" : "u");
  let set = CAT_CACHE.get(key);
  if (set) return set;
  const lc = c.toLowerCase();
  if (bytes) {
    set = lc === "d" ? [[48, 57]] : lc === "w" ? [[48, 57], [65, 90], [95, 95], [97, 122]] : [[9, 13], [32, 32]];
  } else {
    const t = table(lc === "d" ? "digit" : lc === "w" ? "word" : "ws");
    set = [];
    for (let i = 0; i < t.length; i += 2) set.push([t[i], t[i + 1]]);
  }
  if (c !== lc) set = complement(set);
  CAT_CACHE.set(key, set);
  return set;
}

// The RegExps are compiled WITHOUT the "u" flag: they work on UTF-16 code units, and every code point outside
// the BMP is spelled as its surrogate pair. JavaScriptCore (Safari) has bugs in "u" mode around surrogate pairs:
// its regex JIT, after a failed attempt that read a pair, restarts one code point too far on (/[a-z\u{1d465}]A/u
// misses "x\u{1d465}A" at 1), and it reads a class holding both BMP and astral code points wrongly when matching
// backwards (/(?<=[a-z\u{1d465}])~/u fails on "\u{1d465}~"). The code unit mode has neither, and the fragments
// below make every class and "." consume exactly one code point, as Python's re does: a whole pair, or a lone
// surrogate (one not completing a pair), the way "u" mode and Python treat them.
const unit = (u) => "\\u" + u.toString(16).padStart(4, "0");
const HI = "[\\ud800-\\udbff]", LO = "[\\udc00-\\udfff]";

function unitClass(set) {   // code unit ranges (all <= 0xffff) -> [..]
  let s = "[";
  for (const [a, b] of set) s += a === b ? unit(a) : unit(a) + "-" + unit(b);
  return s + "]";
}

function clip(set, lo, hi) {
  const out = [];
  for (const [a, b] of set) if (b >= lo && a <= hi) out.push([Math.max(a, lo), Math.min(b, hi)]);
  return out;
}

// astral code point ranges -> alternatives "high[lows]", consecutive highs with the same lows merged
function astralSrc(set) {
  const byHigh = [];   // [high, [[lo, hi], ...]]
  const add = (h, l0, l1) => {
    const last = byHigh[byHigh.length - 1];
    if (last && last[0] === h) last[1].push([l0, l1]);
    else byHigh.push([h, [[l0, l1]]]);
  };
  for (const [a, b] of set) {
    const ha = 0xd800 + ((a - 0x10000) >> 10), la = 0xdc00 + ((a - 0x10000) & 0x3ff);
    const hb = 0xd800 + ((b - 0x10000) >> 10), lb = 0xdc00 + ((b - 0x10000) & 0x3ff);
    if (ha === hb) { add(ha, la, lb); continue; }
    add(ha, la, 0xdfff);
    for (let h = ha + 1; h < hb; h++) add(h, 0xdc00, 0xdfff);
    add(hb, 0xdc00, lb);
  }
  const alts = [], highs = [];
  for (let i = 0; i < byHigh.length;) {
    const lows = unitClass(byHigh[i][1]);
    let j = i;
    while (j + 1 < byHigh.length && byHigh[j + 1][0] === byHigh[j][0] + 1 && unitClass(byHigh[j + 1][1]) === lows) j++;
    highs.push([byHigh[i][0], byHigh[j][0]]);
    alts.push((i === j ? unit(byHigh[i][0]) : unitClass([[byHigh[i][0], byHigh[j][0]]])) + lows);
    i = j + 1;
  }
  return alts.length > 2 ? `(?=${unitClass(highs)})(?:${alts.join("|")})` : alts.join("|");
}

// A set of code points -> a fragment that matches exactly one code point of the set (forwards and, inside a
// lookbehind, backwards). Its alternatives exclude each other, so their order changes nothing but speed.
function classSrc(set) {
  const parts = [];
  const bmp = clip(set, 0, 0xd7ff).concat(clip(set, 0xe000, 0xffff));
  if (bmp.length) parts.push(unitClass(bmp));
  const astral = clip(set, 0x10000, MAXCP);
  if (astral.length) parts.push(astralSrc(astral));
  const hi = clip(set, 0xd800, 0xdbff), lo = clip(set, 0xdc00, 0xdfff);
  if (hi.length) parts.push(unitClass(hi) + `(?!${LO})`);
  if (lo.length) parts.push(`(?<!${HI})` + unitClass(lo));
  if (!parts.length) return "[]";
  return parts.length === 1 && bmp.length ? parts[0] : "(?:" + parts.join("|") + ")";
}

const ANY = classSrc([[0, MAXCP]]);
const NOT_NL = classSrc(complement([[10, 10]]));

function litSrc(cp) {
  if ((cp >= 48 && cp <= 57) || (cp >= 65 && cp <= 90) || (cp >= 97 && cp <= 122)) return String.fromCharCode(cp);
  if (cp < 0xd800 || (cp > 0xdfff && cp <= 0xffff)) return unit(cp);
  if (cp <= 0xffff) return classSrc([[cp, cp]]);
  return "(?:" + unit(0xd800 + ((cp - 0x10000) >> 10)) + unit(0xdc00 + ((cp - 0x10000) & 0x3ff)) + ")";
}

const HEX = /^[0-9a-fA-F]+$/;

class Translator {
  constructor(pattern, flags) {
    this.src = pattern;
    this.p = Array.from(pattern);
    this.i = 0;
    this.I = flags.includes("I");
    this.S = flags.includes("S");
    this.M = flags.includes("M");
    this.B = flags.includes("B");
    this.groups = 0;
    this.names = [];
    this.w = 0;        // most code points the construct just parsed can match (Infinity when unbounded)
    this.mw = 0;       // fewest code points it can match
    this.emptyLoop = false;   // a quantifier repeats something that can match the empty string (see PyRe)
    this.reach = 0;    // most code points any assertion can look back from the match start (sum of lookbehinds)
  }


  fail(msg) {
    throw new Error(`re(): ${msg} at position ${this.i} in ${JSON.stringify(this.src)}`);
  }

  peek(k = 0) { return this.p[this.i + k]; }

  parse() {
    for (;;) {   // leading inline flags (?ims)
      const m = /^\(\?([aiLmsux]+)\)/.exec(this.p.slice(this.i, this.i + 12).join(""));
      if (!m) break;
      for (const f of m[1]) {
        if (f === "i") this.I = true;
        else if (f === "s") this.S = true;
        else if (f === "m") this.M = true;
        else this.fail(`inline flag ${f} not supported`);
      }
      this.i += m[0].length;
    }
    const out = this.alt();
    if (this.i < this.p.length) this.fail("unbalanced parenthesis");
    return out;
  }

  alt() {
    let out = this.seq(), w = this.w, mw = this.mw;
    while (this.peek() === "|") {
      this.i++;
      out += "|" + this.seq();
      w = Math.max(w, this.w);
      mw = Math.min(mw, this.mw);
    }
    this.w = w;
    this.mw = mw;
    return out;
  }

  seq() {
    let out = "", w = 0, mw = 0;
    while (this.i < this.p.length && this.peek() !== "|" && this.peek() !== ")") {
      const atom = this.atom();
      out += atom + this.quant();
      w += this.w;
      mw += this.mw;
    }
    this.w = w;
    this.mw = mw;
    return out;
  }

  // the quantifier after an atom of widths this.w / this.mw; leaves the quantified widths there
  quant() {
    const c = this.peek(), aw = this.w, amw = this.mw;
    const upTo = (n) => (n === Infinity ? (aw ? Infinity : 0) : n === 0 ? 0 : aw * n);
    let q = "";
    if (c === "*" || c === "+" || c === "?") {
      this.i++;
      q = c;
      this.w = c === "?" ? aw : upTo(Infinity);
      this.mw = c === "+" ? amw : 0;
    } else if (c === "{") {   // re/_parser.py: anything but {m} {m,} {,n} {m,n} {,} is a literal "{"
      if (this.peek(1) === "}") return "";
      let j = this.i + 1, lo = "", hi = "";
      while (/^[0-9]$/.test(this.p[j] ?? "")) lo += this.p[j++];
      if (this.p[j] === ",") {
        j++;
        while (/^[0-9]$/.test(this.p[j] ?? "")) hi += this.p[j++];
      } else hi = lo;
      if (this.p[j] !== "}") return "";
      this.i = j + 1;
      const min = lo === "" ? "0" : lo;
      if (hi !== "" && Number(hi) < Number(min)) this.fail("min repeat greater than max repeat");
      q = hi === "" ? `{${min},}` : `{${min},${hi}}`;
      this.w = upTo(hi === "" ? Infinity : Number(hi));
      this.mw = amw * Number(min);
    } else return "";
    if (!amw) this.emptyLoop = true;
    if (this.peek() === "?") { this.i++; q += "?"; } else if (this.peek() === "+") this.fail("possessive quantifier");
    return q;
  }

  atom() {
    const c = this.p[this.i++];
    this.w = this.mw = 1;
    switch (c) {
      case "(": return this.group();
      case "[": return this.cls();
      case ".":
        return this.S ? ANY : NOT_NL;
      case "^":   // JavaScript's ^ without the m flag is the start of the input, like Python's ^ without re.M
        this.w = this.mw = 0;
        if (!this.M) return "^";
        this.reach += 1;
        return "(?:^|(?<=\\n))";
      case "$":
        this.w = this.mw = 0;
        return this.M ? "(?=\\n|(?![\\s\\S]))" : "(?=\\n?(?![\\s\\S]))";
      case "\\": return this.escape();
      case "*": case "+": case "?": this.fail("nothing to repeat"); break;
      default: return this.lit(c.codePointAt(0));
    }
    return "";
  }

  icaseSet(cp) {
    if (!this.I) return [cp];
    if (cp < 128) {
      if (this.B) {
        if (cp >= 65 && cp <= 90) return [cp, cp + 32];
        if (cp >= 97 && cp <= 122) return [cp, cp - 32];
        return [cp];
      }
      return ICASE[cp] ? [cp, ...ICASE[cp]] : [cp];
    }
    if (this.B) return [cp];
    const ch = String.fromCodePoint(cp);
    if (ch.toLowerCase() !== ch || ch.toUpperCase() !== ch) this.fail("cased non-ASCII literal under re.I");
    return [cp];
  }

  lit(cp) {
    const set = this.icaseSet(cp);
    return set.length > 1 ? classSrc(normSet(set.map((x) => [x, x]))) : litSrc(cp);
  }

  wordBoundary() {
    const set = categorySet("w", this.B);
    const w = classSrc(set);
    this.reach += 1;
    return `(?:(?<=${w})(?!${w})|(?<!${w})(?=${w}))`;
  }

  escape() {
    const c = this.p[this.i++];
    if (c === undefined) this.fail("bad escape (end of pattern)");
    if ("dDwWsS".includes(c)) return classSrc(categorySet(c, this.B));
    if ("bAZ".includes(c)) this.w = this.mw = 0;
    if (c === "b") return this.wordBoundary();
    if (c === "A") return "^";
    if (c === "Z") return "(?![\\s\\S])";
    if (c === "B") this.fail("\\B is not supported");
    return this.lit(this.charEscape(c, false));
  }

  hexDigits(n) {
    const s = this.p.slice(this.i, this.i + n).join("");
    if (s.length !== n || !HEX.test(s)) this.fail("bad hex escape");
    this.i += n;
    return parseInt(s, 16);
  }

  charEscape(c, inClass) {
    switch (c) {
      case "n": return 10;
      case "t": return 9;
      case "r": return 13;
      case "f": return 12;
      case "v": return 11;
      case "a": return 7;
      case "x": return this.hexDigits(2);
      case "u": if (!this.B) return this.hexDigits(4); break;
      case "U": if (!this.B) { const v = this.hexDigits(8); if (v > MAXCP) this.fail("bad escape"); return v; } break;
      case "0": {
        let s = "";
        while (s.length < 2 && /[0-7]/.test(this.peek() ?? "")) s += this.p[this.i++];
        return parseInt("0" + s, 8);
      }
      case "b": if (inClass) return 8; break;
      default: break;
    }
    if (/[0-9]/.test(c)) this.fail("numbered backreference or octal escape");
    if (/[A-Za-z]/.test(c)) this.fail("bad escape \\" + c);
    return c.codePointAt(0);
  }

  icaseRange(lo, hi) {
    if (!this.I) return [[lo, hi]];
    if (hi - lo > 0x400) {
      for (let cp = lo; cp <= hi && cp < 128; cp++) if (this.icaseSet(cp).length > 1) this.fail("large re.I range");
      if (!this.B && hi >= 128) this.fail("large non-ASCII range under re.I");
      return [[lo, hi]];
    }
    const out = [];
    for (let cp = lo; cp <= hi; cp++) for (const x of this.icaseSet(cp)) out.push([x, x]);
    return out;
  }

  cls() {
    let neg = false;
    if (this.peek() === "^") { neg = true; this.i++; }
    const items = [];
    let first = true;
    for (;;) {
      if (this.i >= this.p.length) this.fail("unterminated character set");
      const c = this.p[this.i++];
      if (c === "]" && !first) break;
      first = false;
      let lo;
      if (c === "\\") {
        const e = this.p[this.i++];
        if (e === undefined) this.fail("bad escape (end of pattern)");
        if ("dDwWsS".includes(e)) {
          if (this.peek() === "-" && this.peek(1) !== "]") this.fail("bad character range");
          items.push(...categorySet(e, this.B));
          continue;
        }
        lo = this.charEscape(e, true);
      } else lo = c.codePointAt(0);
      if (this.peek() === "-" && this.peek(1) !== undefined && this.peek(1) !== "]") {
        this.i++;
        const d = this.p[this.i++];
        let hi;
        if (d === "\\") {
          const e = this.p[this.i++];
          if (e === undefined || "dDwWsS".includes(e)) this.fail("bad character range");
          hi = this.charEscape(e, true);
        } else hi = d.codePointAt(0);
        if (hi < lo) this.fail("bad character range");
        items.push(...this.icaseRange(lo, hi));
      } else items.push(...this.icaseRange(lo, lo));
    }
    const set = normSet(items);
    return classSrc(neg ? complement(set) : set);
  }

  group() {
    if (this.peek() !== "?") {
      this.groups++;
      return "(" + this.alt() + this.close();
    }
    this.i++;
    const c = this.p[this.i++];
    if (c === ":") return "(?:" + this.alt() + this.close();
    if (c === "=" || c === "!") {
      const body = this.alt();
      this.w = this.mw = 0;
      return "(?" + c + body + this.close();
    }
    if (c === "<") {
      const d = this.p[this.i++];
      if (d === "=" || d === "!") {
        const body = this.alt();
        this.reach += this.w;
        this.w = this.mw = 0;
        return "(?<" + d + body + this.close();
      }
      this.fail("unknown extension ?<" + d);
    }
    if (c === "P") {
      const d = this.p[this.i++];
      let name = "";
      const end = d === "<" ? ">" : ")";
      while (this.i < this.p.length && this.peek() !== end) name += this.p[this.i++];
      if (this.p[this.i++] !== end || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) this.fail("bad group name");
      if (d === "<") {
        this.groups++;
        this.names.push(name);
        return "(?<" + name + ">" + this.alt() + this.close();
      }
      if (d === "=") {
        this.w = Infinity;
        this.mw = 0;
        return "\\k<" + name + ">";
      }
    }
    if (c === "#") {
      while (this.i < this.p.length && this.peek() !== ")") this.i++;
      this.i++;
      this.w = this.mw = 0;
      return "(?:)";
    }
    this.fail("unsupported group (?" + c);
    return "";
  }

  close() {
    if (this.p[this.i] !== ")") this.fail("missing ), unterminated subpattern");
    this.i++;
    return ")";
  }
}

// Every pattern compiled through re(), with its flags (tests/web/test_imp_pure_regex.mjs runs each one
// against Python's re on the same inputs).
export const REGISTRY = [];
const RE_CACHE = new Map();

export function re(pattern, flags = "") {
  const key = flags + "\u0000" + pattern;
  let r = RE_CACHE.get(key);
  if (!r) {
    r = new PyRe(pattern, flags);
    RE_CACHE.set(key, r);
    REGISTRY.push({ pattern, flags });
  }
  return r;
}

// re.escape (Python 3.7+)
export function reEscape(s) {
  let out = "";
  for (const ch of s) out += "()[]{}?*+-|^$\\.&~# \t\n\r\v\f".includes(ch) ? "\\" + ch : ch;
  return out;
}

// the UTF-16 index of the code point before index i (i > 0)
function advanceBack(s, i) {
  return i > 1 && (s.charCodeAt(i - 1) & 0xfc00) === 0xdc00 && (s.charCodeAt(i - 2) & 0xfc00) === 0xd800 ? i - 2 : i - 1;
}

function advanceIndex(s, i) {
  const c = s.charCodeAt(i);
  return c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00 ? i + 2 : i + 1;
}

export class PyMatch {
  constructor(m, string, rx) {
    this.m = m;
    this.string = string;
    this.re = rx;
  }

  // m.group(id) -> string or null (unmatched group)
  group(id = 0) {
    let v;
    if (typeof id === "number") {
      if (id < 0 || id > this.re.groupCount) throw new Error("IndexError: no such group");
      v = this.m[id];
    } else {
      if (!this.re.groupNames.includes(id)) throw new Error("IndexError: no such group");
      v = this.m.groups[id];
    }
    return v === undefined ? null : v;
  }

  get 0() { return this.m[0]; }

  groups(dflt = null) {
    const out = [];
    for (let i = 1; i <= this.re.groupCount; i++) out.push(this.m[i] === undefined ? dflt : this.m[i]);
    return out;
  }

  get index() { return this.m.index; }

  start(id = 0) {
    if (id === 0) return this.m.index;
    if (!this.m.indices) throw new Error("re(): compile with flag D for group spans");
    const sp = typeof id === "number" ? this.m.indices[id] : this.m.indices.groups[id];
    return sp ? sp[0] : -1;
  }

  end(id = 0) {
    if (id === 0) return this.m.index + this.m[0].length;
    if (!this.m.indices) throw new Error("re(): compile with flag D for group spans");
    const sp = typeof id === "number" ? this.m.indices[id] : this.m.indices.groups[id];
    return sp ? sp[1] : -1;
  }
}

export class PyRe {
  constructor(pattern, flags = "") {
    const t = new Translator(pattern, flags);
    this.pattern = pattern;
    this.flags = flags;
    this.source = t.parse();
    this.groupCount = t.groups;
    this.groupNames = t.names;
    this.reach = t.reach;
    this.emptyLoop = t.emptyLoop;
    this._g = this._y = this._f = this._ne = null;
  }

  get g() { return this._g ??= new RegExp(this.source, this.flags.includes("D") ? "gd" : "g"); }
  get y() { return this._y ??= new RegExp(this.source, this.flags.includes("D") ? "yd" : "y"); }
  get f() { return this._f ??= new RegExp("^(?:" + this.source + ")$", this.flags.includes("D") ? "d" : ""); }

  // The global RegExp's next match at or after pos. In code unit mode the engine also tries the position
  // between the two halves of a surrogate pair, where only a match that consumes nothing first can start
  // ((?![\s\S]) on "a\u{1d465}" matches at 2); Python has no such position, so those are skipped.
  exec(s, pos) {
    const g = this.g;
    g.lastIndex = pos;
    for (;;) {
      const m = g.exec(s);
      if (!m) return null;
      const i = m.index;
      if (i > 0 && i < s.length && (s.charCodeAt(i) & 0xfc00) === 0xdc00 && (s.charCodeAt(i - 1) & 0xfc00) === 0xd800) {
        g.lastIndex = i + 1;
        continue;
      }
      return m;
    }
  }

  search(s, pos = 0) {
    const m = this.exec(s, pos);
    return m ? new PyMatch(m, s, this) : null;
  }

  match(s, pos = 0) {
    const y = this.y;
    y.lastIndex = pos;
    const m = y.exec(s);
    return m ? new PyMatch(m, s, this) : null;
  }

  fullmatch(s) {
    const m = this.f.exec(s);
    return m ? new PyMatch(m, s, this) : null;
  }

  test(s) {
    return this.search(s) !== null;
  }

  // A non-empty match starting exactly at pos, or null: the match must not end at code unit u of the string
  // searched, which a lookbehind of exactly u code units from its start expresses. That lookbehind is as long
  // as the text before pos, so the search runs on s cut a little before pos: as many code points as the pattern
  // can look back from where a match starts (this.reach, the sum of its lookbehind widths), plus one so that ^
  // and \A never see the cut. Only a lookbehind without a bound (Python never compiles one) needs all of s.
  nonEmptyAt(s, pos) {
    let start = 0;
    if (Number.isFinite(this.reach)) {
      start = pos;
      for (let k = 0; start > 0 && k <= this.reach; k++) start = advanceBack(s, start);
    }
    const rx = this.ne(pos - start);
    rx.lastIndex = pos - start;
    const m = rx.exec(start ? s.slice(start) : s);
    if (!m) return null;
    if (start) {
      m.index += start;
      m.input = s;
      if (m.indices) for (const sp of m.indices) if (sp) { sp[0] += start; sp[1] += start; }
    }
    return m;
  }

  ne(u) {
    const cache = this._ne ??= new Map();
    let rx = cache.get(u);
    if (!rx) {
      rx = new RegExp("(?:" + this.source + ")(?<!^[\\s\\S]{" + u + "})", this.flags.includes("D") ? "yd" : "y");
      if (cache.size < 64) cache.set(u, rx);
    }
    return rx;
  }

  // Python 3.7+ order: after an empty match at p, a non-empty match starting at p comes next if there is one
  // ("must advance"), else the search goes on from the next character.
  * finditer(s) {
    let pos = 0;
    while (pos <= s.length) {
      const m = this.exec(s, pos);
      if (!m) return;
      yield new PyMatch(m, s, this);
      if (m[0].length) {
        pos = m.index + m[0].length;
        continue;
      }
      const m2 = m.index < s.length ? this.nonEmptyAt(s, m.index) : null;
      if (m2 && m2[0].length) {   // never empty; checked so that no engine fault can stop the loop advancing
        yield new PyMatch(m2, s, this);
        pos = m2.index + m2[0].length;
      } else pos = advanceIndex(s, m.index);
    }
  }

  // re.sub: repl is a function (PyMatch -> string) or a Python replacement template ("\\1", "\\g<name>")
  subn(repl, s, count = 0) {
    const fn = typeof repl === "function" ? repl : this.template(repl);
    let out = "", last = 0, n = 0;
    for (const m of this.finditer(s)) {
      out += s.slice(last, m.index) + fn(m);
      last = m.index + m.m[0].length;
      n++;
      if (count && n >= count) break;
    }
    return [n ? out + s.slice(last) : s, n];
  }

  sub(repl, s, count = 0) {
    return this.subn(repl, s, count)[0];
  }

  findall(s) {
    const out = [];
    for (const m of this.finditer(s)) {
      if (this.groupCount === 0) out.push(m.m[0]);
      else if (this.groupCount === 1) out.push(m.m[1] ?? "");
      else out.push(m.groups(""));
    }
    return out;
  }

  split(s, maxsplit = 0) {
    const out = [];
    let last = 0, n = 0;
    for (const m of this.finditer(s)) {
      if (maxsplit && n >= maxsplit) break;
      out.push(s.slice(last, m.index), ...m.groups(null));
      last = m.index + m.m[0].length;
      n++;
    }
    out.push(s.slice(last));
    return out;
  }

  template(tpl) {
    const parts = [];   // strings and group references (numbers / names)
    let lit = "";
    const cs = Array.from(tpl);
    for (let i = 0; i < cs.length; i++) {
      const c = cs[i];
      if (c !== "\\") { lit += c; continue; }
      const d = cs[++i];
      if (d === undefined) throw new Error("re(): bad escape (end of template)");
      if (d === "g") {
        const close = cs.indexOf(">", i);
        if (cs[i + 1] !== "<" || close < 0) throw new Error("re(): missing group name");
        const name = cs.slice(i + 2, close).join("");
        parts.push(lit, /^[0-9]+$/.test(name) ? Number(name) : name);
        lit = "";
        i = close;
      } else if (/[1-9]/.test(d)) {
        let num = d;
        if (/[0-9]/.test(cs[i + 1] ?? "")) num += cs[++i];
        parts.push(lit, Number(num));
        lit = "";
      } else {
        const esc = { n: "\n", t: "\t", r: "\r", f: "\f", v: "\v", a: "\x07", b: "\b", "\\": "\\" }[d];
        if (esc !== undefined) lit += esc;
        else if (/[A-Za-z0-9]/.test(d)) throw new Error("re(): bad escape \\" + d + " in template");
        else lit += "\\" + d;
      }
    }
    parts.push(lit);
    return (m) => {
      let out = "";
      for (let i = 0; i < parts.length; i++) out += i % 2 ? m.group(parts[i]) ?? "" : parts[i];
      return out;
    };
  }
}

// ---------------------------------------------------------------------------------------------------
// html.unescape (HTML5 rules: named references with and without ";", longest-prefix matching, numeric
// references with the HTML5 replacements for invalid code points)

const CHARREF = re(String.raw`&(#[0-9]+;?|#[xX][0-9a-fA-F]+;?|[^\t\n\f <&#;]{1,32};?)`);

function charrefNumber(digits, base) {
  if (base === 10) intDigitsLimit(digits.length);
  const t = digits.replace(/^0+/, "");
  return t.length > 8 ? Infinity : t === "" ? 0 : parseInt(t, base);
}

function replaceCharref(s) {
  if (s[0] === "#") {
    const num = s[1] === "x" || s[1] === "X"
      ? charrefNumber(s.slice(2).replace(/;+$/, ""), 16)
      : charrefNumber(s.slice(1).replace(/;+$/, ""), 10);
    if (INVALID_CHARREFS.has(num)) return INVALID_CHARREFS.get(num);
    if ((num >= 0xd800 && num <= 0xdfff) || num > 0x10ffff) return "�";
    if (INVALID_CODEPOINTS.has(num)) return "";
    return String.fromCodePoint(num);
  }
  if (HTML5.has(s)) return HTML5.get(s);
  const cs = Array.from(s);
  for (let x = cs.length - 1; x > 1; x--) {
    const head = cs.slice(0, x).join("");
    if (HTML5.has(head)) return HTML5.get(head) + cs.slice(x).join("");
  }
  return "&" + s;
}

export function htmlUnescape(s) {
  if (!s.includes("&")) return s;
  return CHARREF.sub((m) => replaceCharref(m.group(1)), s);
}

// ---------------------------------------------------------------------------------------------------
// importers.py text helpers

export const WS_RE = re(String.raw`\s+`);
export const TAG_RE = re(String.raw`</?[A-Za-z][\w:.\-]*(?:\s[^<>]*)?/?>`);

function needStr(s) {
  if (typeof s !== "string") throw new PyTypeError("expected string or bytes-like object, got '" + typeName(s) + "'");
  return s;
}

// _ws(s): str(s), whitespace runs -> one space, stripped (None -> "")
export function ws(s) {
  return pyStrip(WS_RE.sub(" ", pyStr(s === null || s === undefined ? "" : s)));
}

// _strip_tags(s)
export function stripTags(s) {
  return TAG_RE.sub("", pyTruthy(s) ? needStr(s) : "");
}

// _clean_text(s): strip HTML/MathML tags and entities from a title-like string
export function cleanText(s) {
  if (!pyTruthy(s)) return "";
  return ws(stripTags(htmlUnescape(stripTags(pyStr(s)))));
}

// Abstract markup: only real JATS / HTML / MathML tags (a known name, or any prefixed name such as
// jats:p or mml:mi, with name="value" attributes). Plain-text inequalities stay as written.
export const MARKUP_NAMES = (
  "p|br|hr|sub|sup|i|b|u|s|em|strong|small|big|span|div|font|a|tt|code|q|cite|abbr|mark|del|ins|strike|"
  + "h[1-6]|ul|ol|li|dl|dt|dd|blockquote|pre|img|table|thead|tbody|tfoot|tr|td|th|caption|figure|"
  + "italic|bold|underline|overline|roman|sc|monospace|sans-serif|xref|title|sec|abstract|trans-abstract|"
  + "label|list|list-item|fn|fig|graphic|inline-graphic|media|ext-link|uri|email|named-content|"
  + "styled-content|inline-formula|disp-formula|tex-math|alternatives|math|semantics|annotation|"
  + "annotation-xml|m(?:i|n|o|s|text|row|sub|sup|subsup|frac|sqrt|root|over|under|underover|fenced|style|"
  + "space|padded|phantom|enclose|table|tr|td|multiscripts|prescripts|error|glyph)|none|break|"
  + "chem-struct|chem-struct-wrap|disp-quote|attrib|def-list|def-item|term|def|statement|boxed-text|p-group");
export const MARKUP_RE = re(
  String.raw`</?(?:[A-Za-z][\w.\-]*:[A-Za-z][\w.\-]*|(?:` + MARKUP_NAMES + String.raw`))`
  + String.raw`(?:\s+[A-Za-z_:][\w:.\-]*\s*=\s*(?:\"[^\"]*\"|'[^']*'|[^\s\"'<>]+))*\s*/?>`, "I");
export const ENTITY_RE = re(String.raw`&(?:[A-Za-z][A-Za-z0-9]{1,31}|#[0-9]{1,7}|#[xX][0-9A-Fa-f]{1,6});`);

// _strip_markup(s)
export function stripMarkup(s) {
  return MARKUP_RE.sub("", pyTruthy(s) ? needStr(s) : "");
}

// _unescape_entities(s): &lt; &amp; &#x3c7; ... -> characters (only complete entities with a semicolon)
export function unescapeEntities(s) {
  return s.includes("&") ? ENTITY_RE.sub((m) => htmlUnescape(m.group(0)), s) : s;
}

// bytes.decode("utf-8", "replace") / bytes.decode("latin-1") for Uint8Array input (Python keeps a BOM)
let UTF8_DECODER = null;
export function decodeUtf8(bytes) {
  UTF8_DECODER ??= new TextDecoder("utf-8", { fatal: false, ignoreBOM: true });
  return UTF8_DECODER.decode(bytes);
}

export function decodeLatin1(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return out;
}
