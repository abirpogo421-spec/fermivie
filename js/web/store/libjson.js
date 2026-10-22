// library.json as Python reads and writes it, kept byte-identical through a JS round trip.
//
// Three things JSON.parse loses that Python keeps:
//  - Integers beyond 2**53 (Python keeps every digit; JS rounds them). The exact digits are kept and
//    written back while the value is unchanged.
//  - Python floats with an integral value. patch_project stores placement ranks as float(r), so Python
//    writes "rank": 1.0 for the rank 1 the UI sends; JS would read 1 and write it back as 1.
//  - Key order of integer-like keys ("123"): JS objects list them first, Python dicts keep insertion order.
// parseLibJson records both in side tables keyed by the object holding the value (WeakMaps, so the parsed
// objects stay plain objects with plain numbers for every other module), and dumpsLib / dumpLibJson write
// them back exactly. Code that changes library data goes through assign / remove (Python's d[k] = v and
// del d[k]), which keeps the side tables right. A float mark is also tied to the value it was made for,
// so a plain JS assignment of a different number can never be written as a float.
//
//   parseLibJson(text) -> value         json.loads(text), with Python's error messages (via pyLoads)
//   dumpsLib(obj, {indent = 1, ensureAscii = false}) -> str     json.dumps(obj, indent, ensure_ascii)
//   dumpLibJson(obj) -> Uint8Array      library_store.dump_json(obj)
//   markFloat(holder, key)              holder[key] (a number) is a Python float
//   assign(obj, key, value), remove(obj, key), keysOf(obj), deepCopy(value), dictCopy(obj)
//   asJson(value)                       a caller's argument as a JSON request body carries it

import { pyLoads, pyFloatRepr, utf8 } from "../pyjson.js";

const FLOATS = new WeakMap(); // holder -> Map(key -> the number that is a Python float)
const EXACT = new WeakMap(); // holder -> Map(key -> [the rounded number, the integer's exact digits])
const ORDER = new WeakMap(); // object -> its keys in Python order (kept only when JS order differs)

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** A key JS lists before the others (a canonical array index). */
export function isIndexKey(k) {
  return /^(?:0|[1-9][0-9]{0,9})$/.test(k) && Number(k) < 4294967295;
}

export function markFloat(holder, key) {
  const k = String(key);
  let m = FLOATS.get(holder);
  if (!m) FLOATS.set(holder, (m = new Map()));
  m.set(k, holder[k]);
}

function unmark(holder, key) {
  const k = String(key);
  FLOATS.get(holder)?.delete(k);
  EXACT.get(holder)?.delete(k);
}

/** holder[key] is an integer beyond 2**53 whose exact digits are text. */
export function markExact(holder, key, text) {
  const k = String(key);
  let m = EXACT.get(holder);
  if (!m) EXACT.set(holder, (m = new Map()));
  m.set(k, [holder[k], text]);
}

/** The exact digits of holder[key] when it is a big integer read from text (and unchanged since), else null. */
export function exactText(holder, key) {
  const e = EXACT.get(holder)?.get(String(key));
  return e && Object.is(e[0], holder[String(key)]) ? e[1] : null;
}

/** holder[key] is a number Python holds as a float with an integral value (written "1.0"). */
export function isFloat(holder, key) {
  const m = FLOATS.get(holder);
  if (!m) return false;
  const k = String(key);
  return m.has(k) && Object.is(m.get(k), holder[k]);
}

/** The object's keys in Python's order. */
export function keysOf(obj) {
  const rec = ORDER.get(obj);
  const own = Object.keys(obj);
  if (!rec) return own;
  const ownSet = new Set(own);
  const out = rec.filter((k) => ownSet.has(k));
  const seen = new Set(out);
  for (const k of own) if (!seen.has(k)) out.push(k);
  return out;
}

/** obj[key] = value with Python dict semantics (an existing key keeps its place, a new one goes last). */
export function assign(obj, key, value) {
  const k = String(key);
  const isNew = !Object.hasOwn(obj, k);
  if (isNew && !Array.isArray(obj) && isIndexKey(k) && !ORDER.has(obj)) ORDER.set(obj, Object.keys(obj));
  if (k === "__proto__") Object.defineProperty(obj, k, { value, writable: true, enumerable: true, configurable: true });
  else obj[k] = value;
  unmark(obj, k);
  const rec = ORDER.get(obj);
  if (rec && isNew) {
    const i = rec.indexOf(k);
    if (i >= 0) rec.splice(i, 1);
    rec.push(k);
  }
  return value;
}

/** del obj[key] */
export function remove(obj, key) {
  const k = String(key);
  delete obj[k];
  unmark(obj, k);
  const rec = ORDER.get(obj);
  if (rec) {
    const i = rec.indexOf(k);
    if (i >= 0) rec.splice(i, 1);
  }
}

/** copy.deepcopy for parsed JSON values, side tables included. */
export function deepCopy(v) {
  if (v === null || typeof v !== "object") return v;
  if (ArrayBuffer.isView(v)) return v.slice();
  let out;
  if (Array.isArray(v)) out = v.map(deepCopy);
  else {
    out = {};
    for (const k of Object.keys(v)) {
      if (k === "__proto__") Object.defineProperty(out, k, { value: deepCopy(v[k]), writable: true, enumerable: true, configurable: true });
      else out[k] = deepCopy(v[k]);
    }
    const rec = ORDER.get(v);
    if (rec) ORDER.set(out, rec.slice());
  }
  const fm = FLOATS.get(v);
  if (fm) FLOATS.set(out, new Map(fm));
  const em = EXACT.get(v);
  if (em) EXACT.set(out, new Map(em));
  return out;
}

/** A shallow copy (Python's dict(d)) that keeps the key order keysOf reports. */
export function dictCopy(obj) {
  const out = {};
  for (const k of keysOf(obj)) assign(out, k, obj[k]);
  return out;
}

// ---------------------------------------------------------------------------------------------------
// Arguments as a JSON request body carries them

const FRESH = new WeakSet(); // copies asJson made that no store code has taken yet

/**
 * v as Python receives it through the server: json.loads(JSON.stringify(v)), the body js/api.js sends. A key
 * set to undefined (or a function) is left out, so d.get(k) gives None; undefined in a list and NaN, Infinity
 * become null; -0 becomes 0; toJSON() is used (a Date becomes its ISO text). Objects and lists come back as a
 * fresh deep copy, so the store works on what the caller passed at call time and never on the caller's own
 * objects (which a page may go on changing while a save is under way). A copy asJson made is handed through
 * once without copying again (a public method normalises, then its *Unlocked twin is called with the copy).
 * BigInt and circular values throw TypeError, as JSON.stringify does.
 */
export function asJson(v) {
  switch (typeof v) {
    case "string":
    case "boolean":
      return v;
    case "number":
      return Number.isFinite(v) ? v + 0 : null; // -0 + 0 is 0
    case "undefined":
    case "function":
    case "symbol":
      return null;
    default:
  }
  if (v === null) return null;
  if (typeof v === "object" && FRESH.has(v)) {
    FRESH.delete(v);
    return v;
  }
  const text = JSON.stringify(v); // TypeError for a BigInt or a cycle
  const out = text === undefined ? null : JSON.parse(text);
  if (out !== null && typeof out === "object") FRESH.add(out);
  return out;
}

// ---------------------------------------------------------------------------------------------------
// Parsing

let reviverSource = null;

/** JSON.parse hands revivers the source text (Chrome 114+, Firefox 135+, node 21+)? */
function hasReviverSource() {
  if (reviverSource === null) {
    try {
      let src = null;
      JSON.parse("[1.0]", function (k, v, ctx) { if (k === "0") src = ctx?.source; return v; });
      reviverSource = src === "1.0";
    } catch {
      reviverSource = false;
    }
  }
  return reviverSource;
}

/** Tests only: behave like a browser whose JSON.parse gives revivers no source text (true), or detect it (false). */
export function setNoReviverSource(on) {
  reviverSource = on ? false : null;
}

function floatReviver(k, v, ctx) {
  if (typeof v === "number" && Number.isInteger(v) && ctx) {
    if (/[.eE]/.test(ctx.source)) markFloat(this, k);
    else if (!Number.isSafeInteger(v)) markExact(this, k, ctx.source);
  }
  return v;
}

// an integer-like key may be in the text, its digits written as they are or as \u0030-\u0039 escapes
const INDEX_KEY_TEXT = /"(?:[0-9]|\\u003[0-9]){1,10}"\s*:/;
// a number with a fraction or exponent, or with 16 or more digits, may be in the text
const FLOAT_TEXT = /[:[,]\s*-?(?:0|[1-9][0-9]*)(?:\.[0-9]|[eE])|[:[,]\s*-?[0-9]{16}/;

class SlowFail extends Error {}

/** json.loads(text) keeping integral floats and Python key order (see the top of this file). */
export function parseLibJson(text) {
  if (typeof text !== "string") throw new TypeError("parseLibJson() needs a string");
  if (text.charCodeAt(0) !== 0xfeff && !INDEX_KEY_TEXT.test(text)) {
    try {
      if (hasReviverSource()) return JSON.parse(text, floatReviver);
      if (!FLOAT_TEXT.test(text)) return JSON.parse(text);
    } catch {
      // not plain JSON: the slow parser or pyLoads decides
    }
  }
  try {
    return parseSlow(text);
  } catch (e) {
    if (!(e instanceof SlowFail)) throw e;
  }
  return pyLoads(text); // throws Python's JSONDecodeError for bad input
}

const STR_RE = /"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/y;
const NUM_RE = /-?(?:0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/y;

/** A JSON parser for what Python accepts (plus NaN / Infinity), recording floats and key order. */
function parseSlow(s) {
  let i = 0;
  const n = s.length;
  const fail = () => { throw new SlowFail(); };
  const ws = () => {
    while (i < n) {
      const c = s.charCodeAt(i);
      if (c === 32 || c === 9 || c === 10 || c === 13) i++;
      else break;
    }
  };
  const string = () => {
    STR_RE.lastIndex = i;
    const m = STR_RE.exec(s);
    if (!m) fail();
    i += m[0].length;
    return JSON.parse(m[0]);
  };
  function value(holder, key) {
    ws();
    if (i >= n) fail();
    const c = s[i];
    if (c === "{") return object();
    if (c === "[") return array();
    if (c === '"') return string();
    if (s.startsWith("null", i)) { i += 4; return null; }
    if (s.startsWith("true", i)) { i += 4; return true; }
    if (s.startsWith("false", i)) { i += 5; return false; }
    if (s.startsWith("NaN", i)) { i += 3; return NaN; }
    if (s.startsWith("Infinity", i)) { i += 8; return Infinity; }
    if (s.startsWith("-Infinity", i)) { i += 9; return -Infinity; }
    NUM_RE.lastIndex = i;
    const m = NUM_RE.exec(s);
    if (!m) fail();
    i += m[0].length;
    const v = Number(m[0]);
    if (Number.isInteger(v) && (m[1] || m[2])) holder.__floats.push(key);
    else if (!m[1] && !m[2] && !Number.isSafeInteger(v)) holder.__exact.push([key, m[0]]);
    return v;
  }
  function settle(container, holder) {
    for (const k of holder.__floats) markFloat(container, k);
    for (const [k, text] of holder.__exact) markExact(container, k, text);
  }
  function object() {
    i++;
    const obj = {};
    const order = [];
    const floats = [];
    const holder = { __floats: floats, __exact: [] };
    ws();
    if (s[i] === "}") { i++; return obj; }
    for (;;) {
      ws();
      if (s[i] !== '"') fail();
      const k = string();
      ws();
      if (s[i] !== ":") fail();
      i++;
      const fi = floats.indexOf(k);
      if (fi >= 0) floats.splice(fi, 1); // a repeated key: the last value wins, in the first key's place
      holder.__exact = holder.__exact.filter((e) => e[0] !== k);
      const v = value(holder, k);
      if (!Object.hasOwn(obj, k)) order.push(k);
      if (k === "__proto__") Object.defineProperty(obj, k, { value: v, writable: true, enumerable: true, configurable: true });
      else obj[k] = v;
      ws();
      if (s[i] === ",") { i++; continue; }
      if (s[i] === "}") { i++; break; }
      fail();
    }
    settle(obj, holder);
    const js = Object.keys(obj);
    if (js.some((k, j) => k !== order[j])) ORDER.set(obj, order);
    return obj;
  }
  function array() {
    i++;
    const arr = [];
    const holder = { __floats: [], __exact: [] };
    ws();
    if (s[i] === "]") { i++; return arr; }
    for (;;) {
      arr.push(value(holder, String(arr.length)));
      ws();
      if (s[i] === ",") { i++; continue; }
      if (s[i] === "]") { i++; break; }
      fail();
    }
    settle(arr, holder);
    return arr;
  }
  const root = { __floats: [], __exact: [] };
  const v = value(root, "");
  ws();
  if (i !== n) fail();
  return v;
}

// ---------------------------------------------------------------------------------------------------
// Writing: json.dumps(obj, indent=indent, ensure_ascii=ensureAscii), same escapes as pyjson.pyDumps

const ESC = /[\x00-\x1f"\\]/g;
const ESC_ASCII = /[^\x20\x21\x23-\x5b\x5d-\x7e]/g;
const SHORT = { '"': '\\"', "\\": "\\\\", "\n": "\\n", "\r": "\\r", "\t": "\\t", "\b": "\\b", "\f": "\\f" };
const escChar = (c) => SHORT[c] ?? "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0");
const encStr = (s, ascii) => '"' + s.replace(ascii ? ESC_ASCII : ESC, escChar) + '"';

function encNum(x, float) {
  if (x !== x) return "NaN";
  if (x === Infinity) return "Infinity";
  if (x === -Infinity) return "-Infinity";
  if (float) return pyFloatRepr(x);
  // A number that did not come from a file's text (those keep their own digits through exactText / isFloat)
  // is written as Python holds it after reading the JSON a page sends: JSON.stringify gives an integral value
  // below 1e21 as its shortest round-trip digits padded with zeros ("12345678901234567000", which Python
  // reads as that int), and from 1e21 up only as "1e+21", which Python reads as a float.
  if (Number.isInteger(x) && Math.abs(x) < 1e21) return String(x);
  return pyFloatRepr(x);
}

function notSerializable(v) {
  const name = v === undefined ? "undefined" : typeof v === "function" ? "function" : v?.constructor?.name || typeof v;
  return new TypeError(`Object of type ${name} is not JSON serializable`);
}

/** json.dumps(obj, indent=indent, ensure_ascii=ensureAscii) honouring the side tables. */
export function dumpsLib(obj, { indent = 1, ensureAscii = false } = {}) {
  const ind = indent === null || indent === undefined ? null : " ".repeat(indent);
  const itemSep = ind === null ? ", " : ",";
  const out = [];
  const seen = new Set();
  function enc(v, level, holder, key) {
    if (v === null) { out.push("null"); return; }
    switch (typeof v) {
      case "string": out.push(encStr(v, ensureAscii)); return;
      case "boolean": out.push(v ? "true" : "false"); return;
      case "number": out.push(holder !== null && exactText(holder, key) || encNum(v, holder !== null && isFloat(holder, key))); return;
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
      for (let j = 0; j < v.length; j++) {
        out.push(j ? itemSep + nl : nl);
        enc(v[j], level + 1, v, j);
      }
    } else {
      const keys = keysOf(v);
      if (keys.length === 0) { out.push("{}"); return; }
      seen.add(v);
      out.push("{");
      for (let j = 0; j < keys.length; j++) {
        out.push((j ? itemSep + nl : nl) + encStr(keys[j], ensureAscii) + ": ");
        enc(v[keys[j]], level + 1, v, keys[j]);
      }
    }
    if (ind !== null) out.push("\n" + ind.repeat(level));
    out.push(isArr ? "]" : "}");
    seen.delete(v);
  }
  enc(obj, 0, null, null);
  return out.join("");
}

/** library_store.dump_json(obj) for library data: (json.dumps(obj, indent=1, ensure_ascii=False) + "\n") as UTF-8. */
export function dumpLibJson(obj) {
  return utf8(dumpsLib(obj, { indent: 1, ensureAscii: false }) + "\n");
}
