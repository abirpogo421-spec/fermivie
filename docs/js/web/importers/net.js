// HTTP layer of the browser importers: port of the network part of importers.py (_fetch, _get_json,
// _describe, the per-host spacing and the 15-minute cache), WEB_CONTRACT.md section 6.2.
//
// Every request is a cross-origin fetch with credentials: "omit" and referrerPolicy: "no-referrer". Only
// hosts that answer web pages with CORS headers are ever contacted (REACHABLE below, the same list as
// the page's Content-Security-Policy connect-src); anything else fails at once with kind "unreachable"
// and no request is made. No e-mail address, cookie or library data is sent anywhere.
//
//   NetError(kind, message, {status, url, body, retryAfter})
//       kind: notfound | blocked | ratelimited | timeout | offline | network | http | badurl |
//             unreachable (host not readable from a web page) | cors (the request failed inside the
//             browser: refused by CORS, an error answer without CORS headers, or a dropped connection) |
//             noanswer (refused, and a "no-cors" probe got no answer either: a network failure)
//   fetchResp(url, {timeout, accept, maxBytes, retries, cache, headers}) -> Resp == _fetch
//   getJson(url, ctx, retries = 1) == _get_json
//   describe(err, service) == _describe
//   explainFetchError(err, url, {timedOut, timeout}): a refused fetch as the HTTP error Python would see
//   isReachable(url), reachableFirst(urls), host(url) == _host, pyQuote(s, safe) == urllib.parse.quote,
//   urlencode(pairs) == urllib.parse.urlencode, setFetch(fn) (tests only), clearCache()

import { host } from "./parse.js";

export { host };   // _host, from parse.js (Python's urlsplit rules)

export const MB = 1024 * 1024;

export const BLOCKED_SITE_MESSAGE = "That site doesn't let web pages read it. Paste the paper's DOI or "
  + "arXiv ID instead, or download the PDF and drop it here.";

// Hosts a page served from the GitHub Pages site can read (checked with an Origin header
// on 2026-10-21; error answers checked too). Crossref, OpenAlex, INSPIRE and Europe PMC send
// "Access-Control-Allow-Origin: *" on 200 and 404; DataCite echoes the origin on 200 and 404 (its search,
// /dois?query=..., too). The others send the header on success only, so a page never sees their error
// answers: the fetch is refused like a dropped connection. `refusal` records the status those hosts answer
// without the header (curl, 2026-10-21):
//   api.semanticscholar.org  429 (its frequent rate limit)
//   arxiv.org/pdf, export.arxiv.org/pdf  404 (no such paper or version, a withdrawn latest version, v0)
//   journals.aps.org/<journal>/pdf  403 (a Cloudflare challenge, "cf-mitigated: challenge", to every request
//       a page can make: no cookies are sent, so off campus its PDFs never download from a page; the challenge
//       also sends "Cross-Origin-Resource-Policy: same-origin", which makes the browser drop even a "no-cors"
//       answer, so it can't be probed: a refused request there is taken as that 403)
//   arxiv.org/html  404 (no such version, or no HTML rendering of it); read for one version's title, authors and
//       abstract (any failure there just means "not available"), and asked (HEAD) whether a version exists
// `probe`: when the fetch is refused, one more request in "no-cors" mode tells an answer without the header
// (the recorded status) from no answer at all (a network failure). Semantic Scholar is not probed (a second
// request would only spend its rate limit), nor APS (see above).
// Not readable: export.arxiv.org/api/query, arxiv.org/abs, doi.org, publisher pages and most publisher
// PDFs, api.openreview.net, aclanthology.org, NCBI PMC.
export const REACHABLE = [
  { host: "api.crossref.org", path: /^\// },
  { host: "api.openalex.org", path: /^\// },
  { host: "api.datacite.org", path: /^\// },
  { host: "api.semanticscholar.org", path: /^\//, refusal: 429 },
  { host: "www.ebi.ac.uk", path: /^\/europepmc\/webservices\/rest\// },
  { host: "inspirehep.net", path: /^\/api\// },
  { host: "arxiv.org", path: /^\/pdf\//, refusal: 404, probe: true },
  { host: "arxiv.org", path: /^\/html\//, refusal: 404, probe: true },
  { host: "export.arxiv.org", path: /^\/pdf\//, refusal: 404, probe: true },
  { host: "journals.aps.org", path: /^\/[^/]+\/pdf\//, refusal: 403 },
];

// Per-host politeness, as _HOST_INTERVAL (seconds between the end of one request and the next).
export const HOST_INTERVAL = {
  "export.arxiv.org": 3.0,
  "api.crossref.org": 0.3,
  "api.openalex.org": 0.15,
  "api.datacite.org": 0.2,
  "inspirehep.net": 0.4,
  "www.ebi.ac.uk": 0.2,
  "api2.openreview.net": 0.5,
  "api.openreview.net": 0.5,
  "api.semanticscholar.org": 1.1,
};

export class NetError extends Error {
  constructor(kind, message, { status = null, url = "", body = null, retryAfter = null } = {}) {
    super(message);
    this.name = "NetError";
    this.kind = kind;
    this.status = status;
    this.url = url;
    this.body = body || new Uint8Array(0);
    this.retryAfter = retryAfter;
  }
}

export const sleep = (ms) => new Promise((res) => setTimeout(res, Math.max(0, ms)));
const clock = () => (typeof performance !== "undefined" && performance.now ? performance.now() : Date.now());

// ---------------------------------------------------------------------------------------------------
// URLs

/** urlsplit-like parse; null when the text is not an absolute URL. */
export function splitUrl(url) {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/** The REACHABLE entry for a URL, or null when a web page can't read it. */
export function reachableEntry(url) {
  const u = splitUrl(String(url || ""));
  if (!u || u.protocol !== "https:" || u.username || u.password || u.port) return null;
  const h = u.hostname.toLowerCase();
  return REACHABLE.find((r) => r.host === h && r.path.test(u.pathname)) || null;
}

/** true when a web page can read this URL (REACHABLE). */
export function isReachable(url) {
  return reachableEntry(url) !== null;
}

/** The URLs a web page can download first, then the others, each group in its given order. */
export function reachableFirst(urls) {
  const list = [...urls];
  return [...list.filter((u) => isReachable(u)), ...list.filter((u) => !isReachable(u))];
}

const ALWAYS_SAFE = /[A-Za-z0-9_.\-~]/;
const ENC = new TextEncoder();

/** urllib.parse.quote(s, safe): percent-encode the UTF-8 bytes of everything but [A-Za-z0-9_.-~] + safe. */
export function pyQuote(s, safe = "/") {
  let out = "";
  for (const ch of String(s)) {
    if ((ch.length === 1 && ALWAYS_SAFE.test(ch)) || safe.includes(ch)) {
      out += ch;
      continue;
    }
    for (const b of ENC.encode(ch)) out += "%" + b.toString(16).toUpperCase().padStart(2, "0");
  }
  return out;
}

/** urllib.parse.quote_plus(s): like pyQuote with safe "", spaces as "+". */
export function pyQuotePlus(s) {
  return String(s).split(" ").map((part) => pyQuote(part, "")).join("+");
}

/** urllib.parse.urlencode(dict) for string values: [[k, v], ...] or {k: v}. */
export function urlencode(pairs) {
  const list = Array.isArray(pairs) ? pairs : Object.entries(pairs);
  return list.map(([k, v]) => pyQuotePlus(k) + "=" + pyQuotePlus(v)).join("&");
}

// ---------------------------------------------------------------------------------------------------
// fetch, the per-host gate and the cache

let fetchImpl = null;

/** Tests only: replace fetch (e.g. by a fixture server in node). null restores globalThis.fetch. */
export function setFetch(fn) {
  fetchImpl = typeof fn === "function" ? fn : null;
}

/** fetch() as the importers use it (the test replacement when one is set). */
export function netFetch(url, init) {
  const f = fetchImpl || globalThis.fetch;
  return f(url, init);
}

const doFetch = netFetch;

const gates = new Map();

/** _host_gate: requests to a gated host run one at a time, `interval` seconds apart. */
export function gate(hostName, fn) {
  const interval = HOST_INTERVAL[hostName];
  if (!interval) return fn();
  let g = gates.get(hostName);
  if (!g) {
    g = { last: -Infinity, chain: Promise.resolve() };
    gates.set(hostName, g);
  }
  const run = g.chain.then(async () => {
    const wait = g.last + interval * 1000 - clock();
    if (wait > 0) await sleep(wait);
    try {
      return await fn();
    } finally {
      g.last = clock();
    }
  });
  g.chain = run.then(() => {}, () => {});
  return run;
}

const CACHE = new Map();
const CACHE_TTL = 900 * 1000;
const CACHE_MAX = 256;

function cacheGet(key) {
  const hit = CACHE.get(key);
  if (hit && hit.expires > clock()) return hit.resp;
  CACHE.delete(key);
  return null;
}

function cachePut(key, resp) {
  if (CACHE.size >= CACHE_MAX) {
    const old = [...CACHE.entries()].sort((a, b) => a[1].expires - b[1].expires).slice(0, CACHE_MAX / 4);
    for (const [k] of old) CACHE.delete(k);
  }
  CACHE.set(key, { expires: clock() + CACHE_TTL, resp });
}

/** Forget every cached answer (tests; or after going back online). */
export function clearCache() {
  CACHE.clear();
}

// ---------------------------------------------------------------------------------------------------
// one request

function concat(chunks, total) {
  const n = total ?? chunks.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(n);
  let off = 0;
  for (const c of chunks) {
    out.set(c.subarray(0, Math.min(c.length, n - off)), off);
    off += c.length;
    if (off >= n) break;
  }
  return out;
}

/** _read_capped: [body, truncated]; reads at most maxBytes (+ one chunk) and cancels the rest. */
export async function readCapped(response, maxBytes) {
  if (!response.body || typeof response.body.getReader !== "function") {
    const buf = new Uint8Array(await response.arrayBuffer());
    return buf.length > maxBytes ? [buf.slice(0, maxBytes), true] : [buf, false];
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return [concat(chunks, total), false];
    chunks.push(value);
    total += value.length;
    if (total > maxBytes) {
      try { await reader.cancel(); } catch { /* already closed */ }
      return [concat(chunks, maxBytes), true];
    }
  }
}

function retryAfterOf(headers) {
  const v = headers && headers.get ? headers.get("Retry-After") : null;
  if (v == null) return null;
  const n = Number(String(v).trim());
  return String(v).trim() !== "" && Number.isFinite(n) ? n : null;
}

/** Content type as email.message's get_content_type(): "type/subtype" lower-cased, "text/plain" if absent. */
export function contentTypeOf(headers) {
  const raw = (headers && headers.get ? headers.get("Content-Type") : "") || "";
  const t = raw.split(";")[0].trim().toLowerCase();
  return t && t.includes("/") ? t : "text/plain";
}

/** _do_request's kind for an HTTP error status. */
export function statusKind(status) {
  if (status === 404 || status === 410) return "notfound";
  if (status === 429) return "ratelimited";
  if ([401, 403, 405, 406, 451].includes(status)) return "blocked";
  return "http";
}

/** The NetError _do_request raises for an HTTP error status. */
export function statusError(status, url, retryAfter = null) {
  return new NetError(statusKind(status), `HTTP ${status}`, { status, url, retryAfter });
}

/**
 * A fetch() rejection -> NetError, without further requests. The browser hides why a fetch was refused (a CORS
 * refusal and a network failure look alike): hosts that send CORS headers on every answer were not reached
 * ("cors"); a host with a recorded refusal and no probe answered with it (Semantic Scholar's 429, APS's 403;
 * REACHABLE). explainFetchError adds the probe for the others.
 */
export function classifyFetchError(err, url, timedOut) {
  if (timedOut || (err && err.name === "AbortError")) return new NetError("timeout", "timed out", { url });
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    return new NetError("offline", "could not look up the host name", { url });
  }
  if (err instanceof NetError) return err;
  const entry = reachableEntry(url);
  if (entry && entry.refusal && !entry.probe) return statusError(entry.refusal, url);
  return new NetError("cors", "the request was refused or the connection failed", { url });
}

/** One "no-cors" GET: true when the server answered (any status), false when nothing came back, null when
 * the probe itself timed out. The body is not read. */
async function probeAnswered(url, timeout, method = "GET") {
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, Math.max(1, Math.min(Number(timeout) || 10, 10)) * 1000);
  try {
    await doFetch(url, {
      method, headers: { Accept: "*/*" }, credentials: "omit", referrerPolicy: "no-referrer", mode: "no-cors",
      redirect: "follow", signal: ctrl.signal,
    });
    return true;
  } catch {
    return timedOut ? null : false;
  } finally {
    clearTimeout(timer);
    try { ctrl.abort(); } catch { /* nothing left to stop */ }
  }
}

/**
 * A fetch() rejection -> NetError, as Python would have seen it. For hosts whose error answers carry no CORS
 * header (REACHABLE `refusal`), a "no-cors" probe tells which happened: the server answered (the recorded
 * status: 404 "notfound" for arXiv) or nothing came back ("noanswer"). Other hosts as classifyFetchError
 * (Semantic Scholar's refusals are its 429, APS's its 403, without a probe).
 */
export async function explainFetchError(err, url, { timedOut = false, timeout = 10, probe = true, method = "GET" } = {}) {
  const base = classifyFetchError(err, url, timedOut);
  if (base.kind !== "cors") return base;
  const entry = reachableEntry(url);
  if (!probe || !entry || !entry.refusal || !entry.probe) return base;
  const answered = await probeAnswered(url, timeout, method);
  if (answered === true) return statusError(entry.refusal, url);
  if (answered === false) return new NetError("noanswer", "no answer", { url });
  return base;
}

async function doRequest(url, headers, timeout, maxBytes, method = "GET", probe = true) {
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, Math.max(1, timeout) * 1000);
  try {
    let r;
    try {
      r = await doFetch(url, {
        method, headers, credentials: "omit", referrerPolicy: "no-referrer", mode: "cors",
        redirect: "follow", signal: ctrl.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      throw await explainFetchError(e, url, { timedOut, timeout, probe, method });
    }
    const final = r.url || url;
    if (r.status >= 400) {
      let body = new Uint8Array(0);
      try { [body] = await readCapped(r, 512 * 1024); } catch { /* keep the status */ }
      const err = statusError(r.status, final, retryAfterOf(r.headers));
      err.body = body;
      throw err;
    }
    let body, truncated;
    if (method === "HEAD") return { status: r.status || 200, url: final, headers: r.headers, ctype: contentTypeOf(r.headers),
      body: new Uint8Array(0), truncated: false };
    try {
      [body, truncated] = await readCapped(r, maxBytes);
    } catch (e) {
      throw timedOut ? new NetError("timeout", "timed out", { url }) : new NetError("network", `${e && e.name || "Error"}: ${e && e.message || e}`, { url });
    }
    return { status: r.status || 200, url: final, headers: r.headers, ctype: contentTypeOf(r.headers), body, truncated };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * _fetch: GET a URL from a reachable host. Returns {status, url (final), headers, ctype, body (Uint8Array),
 * truncated}; throws NetError. Transient failures (rate limits, time-outs, dropped connections, HTTP 5xx)
 * are retried `retries` times (default 1), waiting Retry-After (when the host exposes it) or 1.5 s, at
 * most 5 s. cache: keep 200 answers for 15 minutes. method: "GET" or "HEAD" (no body read). probe: false leaves out
 * the "no-cors" probe of a refused fetch (explainFetchError), so a refusal stays "cors" (unknown).
 */
export async function fetchResp(url, { timeout = 20, accept = "*/*", maxBytes = 8 * MB, retries = null,
  cache = false, headers = null, method = "GET", probe = true } = {}) {
  url = String(url ?? "");
  const parts = splitUrl(url);
  if (!parts) {
    if (/^https?:\/\//i.test(url)) throw new NetError("badurl", `not a valid link: ${url}`);
    throw new NetError("badurl", `not a web link: ${url}`);
  }
  if (!["http:", "https:"].includes(parts.protocol) || !parts.hostname) {
    throw new NetError("badurl", `not a web link: ${url}`);
  }
  if (!isReachable(url)) {
    throw new NetError("unreachable", `${host(url) || "that site"} can't be read from a web page`, { url });
  }
  const extra = Object.entries(headers || {}).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  method = method === "HEAD" ? "HEAD" : "GET";
  const key = JSON.stringify(method === "GET" ? [url, accept, extra] : [url, accept, extra, method]);
  if (cache) {
    const hit = cacheGet(key);
    if (hit) return hit;
  }
  const hdrs = { Accept: accept };
  for (const [k, v] of extra) hdrs[k] = v;
  const attempts = 1 + (retries ?? 1);
  const hostName = parts.hostname.toLowerCase();
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const resp = await gate(hostName, () => doRequest(url, hdrs, timeout, maxBytes, method, probe));
      if (cache && resp.status === 200 && !resp.truncated) cachePut(key, resp);
      return resp;
    } catch (e) {
      if (!(e instanceof NetError)) throw e;
      const transient = ["ratelimited", "timeout", "network", "cors", "noanswer"].includes(e.kind)
        || (e.kind === "http" && [500, 502, 503, 504].includes(e.status));
      if (transient && attempt + 1 < attempts) {
        await sleep(Math.min(e.retryAfter || 1.5 * (attempt + 1), 5.0) * 1000);
        continue;
      }
      throw e;
    }
  }
  throw new NetError("network", "request failed", { url });
}

const DEC = new TextDecoder("utf-8");

/** _get_json(url, ctx, retries): JSON from a reachable API (cached 15 minutes). timeout: seconds, default ctx.t(). */
export async function getJson(url, ctx, retries = 1, timeout = null) {
  const resp = await fetchResp(url, { timeout: timeout ?? ctx.t(), accept: "application/json", cache: true, retries });
  try {
    return JSON.parse(DEC.decode(resp.body));
  } catch {
    const h = splitUrl(url);
    throw new NetError("http", `unreadable answer from ${h ? h.hostname.toLowerCase() : ""}`);
  }
}

/** _describe: a short reason for a failed lookup, naming the service. */
export function describe(err, service) {
  const k = err && err.kind || "";
  if (k === "timeout") return `${service} took too long to answer`;
  if (k === "offline") return `could not reach ${service} (are you online?)`;
  if (k === "ssl") return `secure connection to ${service} failed`;
  if (k === "ratelimited") return `${service} is rate-limiting requests; try again in a minute`;
  if (k === "blocked") return `${service} refused the request (HTTP ${err.status})`;
  if (k === "notfound") return `${service} has no record of it`;
  if (k === "badurl") return String(err.message);
  if (k === "unreachable") return `${service} can't be read from a web page`;
  if (k === "cors") return `${service} refused the request or could not be reached`;
  if (k === "noanswer") return `${service} could not be reached`;
  return `${service}: ${err && err.message !== undefined ? err.message : err}`;
}
