// The request side of server.py's Handler for the browser back end (WEB_CONTRACT.md 6.5): how a request URL
// becomes path segments and query values (urlsplit + urllib.parse.unquote + parse_qs), how a body is read
// (_body_json, _body_pdf_to_tmp: the same checks, statuses and messages), the response shapes (_ok, _err,
// the 500 for anything unexpected) and the os.path helpers the routes use. Pure; runs in node and in pages.

import { StoreError, bad, isPdf } from "./store/index.js";
import * as py from "./store/py.js";

export const MAX_JSON = 20 * 1024 * 1024;
export const MAX_PDF = 300 * 1024 * 1024;

const MB = 1024 * 1024;
const tooLarge = (limit) => new StoreError(413, `Request too large (limit ${Math.floor(limit / MB)} MB).`);

// ---------------------------------------------------------------------------------------------------
// URLs

const HEX = /^[0-9A-Fa-f]{2}/;
const utf8Replace = () => new TextDecoder("utf-8", { ignoreBOM: true }); // errors="replace", BOM kept

/** urllib.parse.unquote_to_bytes for an ASCII string: %XX -> that byte, everything else as it is. */
function unquoteToBytes(s) {
  const parts = s.split("%");
  const out = [];
  const push = (t) => { for (let i = 0; i < t.length; i++) out.push(t.charCodeAt(i)); };
  push(parts[0]);
  for (let i = 1; i < parts.length; i++) {
    const item = parts[i];
    if (HEX.test(item)) {
      out.push(parseInt(item.slice(0, 2), 16));
      push(item.slice(2));
    } else {
      out.push(0x25);
      push(item);
    }
  }
  return Uint8Array.from(out);
}

/** urllib.parse.unquote(s) (UTF-8, errors="replace"): ASCII runs are unquoted, other characters kept. */
export function unquote(s) {
  if (!s.includes("%")) return s;
  const bits = s.split(/([\x00-\x7f]+)/);
  let res = bits[0];
  for (let i = 1; i < bits.length; i += 2) {
    res += utf8Replace().decode(unquoteToBytes(bits[i]));
    res += bits[i + 1] ?? "";
  }
  return res;
}

/** {k: v[0] for k, v in parse_qs(query, keep_blank_values=True).items()} as a Map (first value wins). */
export function parseQs(query) {
  const out = new Map();
  if (!query) return out;
  for (const nameValue of query.split("&")) {
    if (!nameValue) continue;
    const at = nameValue.indexOf("=");
    const nv = at < 0 ? [nameValue, ""] : [nameValue.slice(0, at), nameValue.slice(at + 1)];
    const name = unquote(nv[0].replace(/\+/g, " "));
    const value = unquote(nv[1].replace(/\+/g, " "));
    if (!out.has(name)) out.set(name, value);
  }
  return out;
}

/**
 * What the Python server sees for a request the page would send to `url` (a root-relative URL as js/api.js
 * builds it): the browser's URL parser normalises it first ("." and ".." segments, %2e), then _handle splits
 * the path. -> {error: [status, message]} or {segs, query}.
 */
export function splitRequest(url) {
  const u = new URL(url, "http://localhost/");
  const raw = u.pathname;
  if (raw.includes("\x00") || raw.includes("\\")) return { error: [400, "Bad path."] };
  const segs = raw.split("/").slice(1).map(unquote);
  for (const s of segs) {
    if (s === "." || s === ".." || s.includes("/") || s.includes("\\") || s.includes("\x00")) return { error: [403, "Bad path."] };
  }
  return { segs, query: parseQs(u.search.slice(1)) };
}

/** q.get(name, dflt) on the parsed query */
export const qget = (q, name, dflt = null) => (q.has(name) ? q.get(name) : dflt);

// ---------------------------------------------------------------------------------------------------
// Request bodies, as js/api.js's req() sends them

const enc = new TextEncoder();

/**
 * The body req(method, url, body) would send: a Blob or ArrayBuffer goes as application/pdf, anything else
 * defined as JSON text (JSON.stringify throws here for a BigInt or a cycle, as it does in req()).
 * -> null | {ctype: "application/pdf", data} | {ctype: "application/json", text, size}
 */
export function makeBody(body) {
  if (body === undefined) return null;
  if ((typeof Blob !== "undefined" && body instanceof Blob) || body instanceof ArrayBuffer) {
    return { ctype: "application/pdf", data: body };
  }
  const text = JSON.stringify(body);
  // raw: the caller's value, for the browser-only profile actions that take a File (importZip)
  return { ctype: "application/json", text, size: enc.encode(text).length, raw: body };
}

/** Handler._body_json: 415 unless JSON, 413 over 20 MB, 400 for anything but an object. */
export function bodyJson(body) {
  if (!body || body.ctype !== "application/json") throw new StoreError(415, "Send JSON (Content-Type: application/json).");
  if (body.size > MAX_JSON) throw tooLarge(MAX_JSON);
  let obj;
  try {
    obj = body.size ? JSON.parse(body.text) : {};
  } catch {
    throw bad("Bad JSON.");
  }
  if (!py.isDict(obj)) throw bad("Send a JSON object.");
  return obj;
}

/** Handler._body_pdf_to_tmp: the uploaded PDF's bytes after the same checks (415, 413, 400, 415). */
export async function bodyPdf(body) {
  if (!body || body.ctype !== "application/pdf") throw new StoreError(415, "Send the PDF as application/pdf.");
  const data = body.data;
  const n = data instanceof ArrayBuffer ? data.byteLength : data.size;
  if (n > MAX_PDF) throw tooLarge(MAX_PDF);
  if (n <= 0) throw bad("The upload is empty.");
  const bytes = data instanceof ArrayBuffer ? new Uint8Array(data.slice(0)) : new Uint8Array(await data.arrayBuffer());
  if (!isPdf(bytes.subarray(0, 1024))) throw new StoreError(415, "That file is not a PDF.");
  return bytes;
}

// ---------------------------------------------------------------------------------------------------
// Responses

/** _ok(**kw) */
export const ok = (kw = {}) => ({ status: 200, json: { ok: true, ...kw } });

/** _send(200, text, "text/plain; charset=utf-8") */
export const textResponse = (text) => ({ status: 200, text, ctype: "text/plain; charset=utf-8" });

/** _err(status, msg, **extra) for a StoreError; the 500 "Server error: Type: message" for anything else. */
export function errorResponse(e) {
  if (e instanceof StoreError) return { status: e.status, json: { ok: false, error: e.message, ...(e.extra || {}) } };
  const name = (e && e.name) || "Error";
  const msg = e && typeof e === "object" && "message" in e ? e.message : String(e);
  return { status: 500, json: { ok: false, error: `Server error: ${name}: ${msg}` } };
}

// ---------------------------------------------------------------------------------------------------
// os.path for the "/"-separated names the routes get

/** os.path.basename */
export const basename = (p) => p.slice(p.lastIndexOf("/") + 1);

/** os.path.splitext -> [root, ext] (leading dots are not an extension) */
export function splitext(p) {
  const sep = p.lastIndexOf("/");
  const dot = p.lastIndexOf(".");
  if (dot > sep) {
    for (let i = sep + 1; i < dot; i++) if (p[i] !== ".") return [p.slice(0, dot), p.slice(dot)];
  }
  return [p, ""];
}

/** "; ".join(dict.fromkeys(xs))[:n] (n code points) */
export const joinUnique = (xs, n = 300) => py.cpSlice([...new Set(xs)].join("; "), 0, n);
