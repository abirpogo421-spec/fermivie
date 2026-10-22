// parse_input and its helpers from importers.py (WEB_CONTRACT.md section 6.2): classify pasted text as an
// arXiv id, a DOI, a known site's URL, a PDF link or a web page, without touching the network. Pure ES
// module; results equal Python's on every input (tests/web/test_imp_pure*.mjs). Also the parts of
// urllib.parse (urlsplit, unquote, parse_qs) and ipaddress that this needs, with Python's exact rules.
//
// Exports (Python name in brackets): parseInput [parse_input], cleanInput [_clean_input],
// classifyUrl [_classify_url], classifyToken [_classify_token], findEmbedded [_find_embedded],
// label [_label], SITE_NAMES, host [_host], cleanDoi [_clean_doi], stripTrailing [_strip_trailing],
// matchArxivExact, arxivFromPath, arxivFromMatch, splitArxivVersion, arxivDoi, validNewCore,
// arxivIdInUrl [_arxiv_id_in_url], arxivResult, doiResult, urlResult, ARXIV_ARCHIVES, ARCH_ALT,
// ARXIV_ID_PAT, ARXIV_ID_RE, ARXIV_HOSTS, DOI_TAIL_PATS, DOMAINISH, PAIRS, CLOSERS,
// titleFromFilename [_title_from_filename], dedupeUrls [_dedupe_urls], blockedMessage [_blocked_message],
// urlsplit, unquote, unquotePlus, parseQsl, parseQs (a Map, in insertion order), SplitResult.

import {
  re, reEscape, ws, pyStr, pyTruthy, pyStrip, pyLstrip, pyRstrip, pySplit, pyPartition, pyRpartition,
  pyCount, pyLower, pyUpper, pyInt, cpLen, cpSlice, cpAt, cpIndex, pyIsAscii, normalize, decodeUtf8,
  PyValueError, isSpaceCp,
} from "./text.js";

// ---------------------------------------------------------------------------------------------------
// urllib.parse (Python 3.13)

const WHATWG_C0_CONTROL_OR_SPACE = Array.from({ length: 33 }, (_, i) => String.fromCharCode(i)).join("");
const SCHEME_CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+-.";

export class SplitResult {
  constructor(scheme, netloc, path, query, fragment) {
    this.scheme = scheme;
    this.netloc = netloc;
    this.path = path;
    this.query = query;
    this.fragment = fragment;
  }

  get hostinfo() {
    const hostinfo = pyRpartition(this.netloc, "@")[2];
    const [, haveOpenBr, bracketed] = pyPartition(hostinfo, "[");
    let hostname, port;
    if (haveOpenBr) {
      [hostname, , port] = pyPartition(bracketed, "]");
      port = pyPartition(port, ":")[2];
    } else {
      [hostname, , port] = pyPartition(hostinfo, ":");
    }
    return [hostname, port || null];
  }

  // .hostname: lowercased (the IPv6 zone after "%" keeps its case); null when empty
  get hostname() {
    const h = this.hostinfo[0];
    if (!h) return null;
    const [name, pct, zone] = pyPartition(h, "%");
    return pyLower(name) + pct + zone;
  }
}

function splitnetloc(url, start) {
  let delim = url.length;
  for (const c of "/?#") {
    const w = url.indexOf(c, start);
    if (w >= 0) delim = Math.min(delim, w);
  }
  return [url.slice(start, delim), url.slice(delim)];
}

function checknetloc(netloc) {
  if (!netloc || pyIsAscii(netloc)) return;
  const n = netloc.replaceAll("@", "").replaceAll(":", "").replaceAll("#", "").replaceAll("?", "");
  const netloc2 = normalize("NFKC", n);
  if (n === netloc2) return;
  for (const c of "/?#@:") {
    if (netloc2.includes(c)) {
      throw new PyValueError("netloc '" + netloc + "' contains invalid characters under NFKC normalization");
    }
  }
}

// ipaddress.IPv4Address / IPv6Address string validation (only validity matters here)
function ip4Ok(s) {
  if (!s || s.includes("/")) return false;
  const octets = s.split(".");
  if (octets.length !== 4) return false;
  for (const o of octets) {
    if (!o || !/^[0-9]+$/.test(o) || o.length > 3) return false;
    if (o !== "0" && o[0] === "0") return false;
    if (Number(o) > 255) return false;
  }
  return true;
}

const HEXTET = /^[0-9A-Fa-f]*$/;

function ip6Ok(s) {
  if (s.includes("/")) return false;
  const [addr0, sep, scope] = pyPartition(s, "%");
  if (sep && (!scope || scope.includes("%"))) return false;
  let addr = addr0;
  if (!addr || cpLen(addr) > 45) return false;
  let parts = addr.split(":");
  if (parts.length > 10) parts = parts.slice(0, 9).concat([parts.slice(9).join(":")]);
  if (parts.length < 3) return false;
  if (parts[parts.length - 1].includes(".")) {
    if (!ip4Ok(parts.pop())) return false;
    parts.push("0", "0");
  }
  if (parts.length > 9) return false;
  let skip = null;
  for (let i = 1; i < parts.length - 1; i++) {
    if (!parts[i]) {
      if (skip !== null) return false;
      skip = i;
    }
  }
  let hi, lo;
  if (skip !== null) {
    hi = skip;
    lo = parts.length - skip - 1;
    if (!parts[0]) { hi--; if (hi) return false; }
    if (!parts[parts.length - 1]) { lo--; if (lo) return false; }
    if (8 - (hi + lo) < 1) return false;
  } else {
    if (parts.length !== 8 || !parts[0] || !parts[parts.length - 1]) return false;
    hi = parts.length;
    lo = 0;
  }
  const used = parts.slice(0, hi).concat(lo ? parts.slice(parts.length - lo) : []);
  return used.every((h) => HEXTET.test(h) && h.length <= 4 && h.length > 0);
}

const IPVFUTURE = re(String.raw`\Av[a-fA-F0-9]+\..+\Z`);

function checkBracketedHost(hostname) {
  if (hostname.startsWith("v")) {
    if (!IPVFUTURE.match(hostname)) throw new PyValueError("IPvFuture address is invalid");
    return;
  }
  if (ip4Ok(hostname)) throw new PyValueError("An IPv4 address cannot be in brackets");
  if (!ip6Ok(hostname)) throw new PyValueError(`'${hostname}' does not appear to be an IPv4 or IPv6 address`);
}

function checkBracketedNetloc(netloc) {
  const hostAndPort = pyRpartition(netloc, "@")[2];
  const [before, haveOpenBr, bracketed] = pyPartition(hostAndPort, "[");
  let hostname;
  if (haveOpenBr) {
    if (before) throw new PyValueError("Invalid IPv6 URL");
    let port;
    [hostname, , port] = pyPartition(bracketed, "]");
    if (port && !port.startsWith(":")) throw new PyValueError("Invalid IPv6 URL");
  } else {
    hostname = pyPartition(hostAndPort, ":")[0];
  }
  checkBracketedHost(hostname);
}

// urllib.parse.urlsplit(url): throws PyValueError where Python raises ValueError
export function urlsplit(url, scheme = "", allowFragments = true) {
  url = pyLstrip(url, WHATWG_C0_CONTROL_OR_SPACE);
  scheme = pyStrip(scheme, WHATWG_C0_CONTROL_OR_SPACE);
  for (const b of ["\t", "\r", "\n"]) {
    url = url.replaceAll(b, "");
    scheme = scheme.replaceAll(b, "");
  }
  let netloc = "", query = "", fragment = "";
  const i = url.indexOf(":");
  if (i > 0 && /^[A-Za-z]/.test(url)) {
    let ok = true;
    for (const c of url.slice(0, i)) if (!SCHEME_CHARS.includes(c)) { ok = false; break; }
    if (ok) {
      scheme = url.slice(0, i).toLowerCase();
      url = url.slice(i + 1);
    }
  }
  if (url.slice(0, 2) === "//") {
    [netloc, url] = splitnetloc(url, 2);
    if ((netloc.includes("[") && !netloc.includes("]")) || (netloc.includes("]") && !netloc.includes("["))) {
      throw new PyValueError("Invalid IPv6 URL");
    }
    if (netloc.includes("[") && netloc.includes("]")) checkBracketedNetloc(netloc);
  }
  if (allowFragments && url.includes("#")) [url, fragment] = splitOnce(url, "#");
  if (url.includes("?")) [url, query] = splitOnce(url, "?");
  checknetloc(netloc);
  return new SplitResult(scheme, netloc, url, query, fragment);
}

function splitOnce(s, sep) {
  const i = s.indexOf(sep);
  return [s.slice(0, i), s.slice(i + sep.length)];
}

const HEXDIG = "0123456789ABCDEFabcdef";

function unquoteAscii(run) {   // _unquote_impl(run).decode("utf-8", "replace") for an ASCII run
  const bits = run.split("%");
  if (bits.length === 1) return run;
  const bytes = [];
  const push = (s) => { for (let i = 0; i < s.length; i++) bytes.push(s.charCodeAt(i)); };
  push(bits[0]);
  for (const item of bits.slice(1)) {
    if (item.length >= 2 && HEXDIG.includes(item[0]) && HEXDIG.includes(item[1])) {
      bytes.push(parseInt(item.slice(0, 2), 16));
      push(item.slice(2));
    } else {
      bytes.push(37);
      push(item);
    }
  }
  return decodeUtf8(Uint8Array.from(bytes));
}

// urllib.parse.unquote(s) (utf-8, errors="replace")
export function unquote(s) {
  if (!s.includes("%")) return s;
  let out = "", ascii = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 128) { ascii += s[i]; continue; }
    if (ascii) { out += unquoteAscii(ascii); ascii = ""; }
    out += s[i];
  }
  return ascii ? out + unquoteAscii(ascii) : out;
}

export function unquotePlus(s) {
  return unquote(s.replaceAll("+", " "));
}

// urllib.parse.parse_qsl(qs) with the defaults (blank values dropped, errors ignored)
export function parseQsl(qs) {
  if (!qs) return [];
  const r = [];
  for (const nameValue of qs.split("&")) {
    if (!nameValue) continue;
    const [name, , value] = pyPartition(nameValue, "=");
    if (value) r.push([unquotePlus(name), unquotePlus(value)]);
  }
  return r;
}

// urllib.parse.parse_qs(qs) -> Map name -> [values] (Map keeps Python's dict order for any key)
export function parseQs(qs) {
  const out = new Map();
  for (const [name, value] of parseQsl(qs)) {
    if (out.has(name)) out.get(name).push(value);
    else out.set(name, [value]);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------
// arXiv ids

export const ARXIV_ARCHIVES = [
  "acc-phys", "adap-org", "alg-geom", "ao-sci", "astro-ph", "atom-ph", "bayes-an",
  "chao-dyn", "chem-ph", "cmp-lg", "comp-gas", "cond-mat", "cs", "dg-ga",
  "funct-an", "gr-qc", "hep-ex", "hep-lat", "hep-ph", "hep-th", "math",
  "math-ph", "mtrl-th", "nlin", "nucl-ex", "nucl-th", "patt-sol", "physics",
  "plasm-ph", "q-alg", "q-bio", "q-fin", "quant-ph", "solv-int", "stat",
  "supr-con",
];
// sorted((re.escape(a) for a in _ARXIV_ARCHIVES), key=len, reverse=True): stable, longest first
export const ARCH_ALT = ARXIV_ARCHIVES.map(reEscape).map((a, i) => [a, i])
  .sort((x, y) => cpLen(y[0]) - cpLen(x[0]) || x[1] - y[1]).map((x) => x[0]).join("|");
export const ARXIV_ID_PAT = String.raw`(?:(?P<new>\d{4}\.\d{4,5})(?P<nv>v\d+)?(?!\d)`
  + String.raw`|(?P<arch>` + ARCH_ALT + String.raw`)(?:\.[A-Za-z][A-Za-z\-]*)?/(?P<num>\d{7})(?P<ov>v\d+)?(?!\d))`;
export const ARXIV_ID_RE = re(ARXIV_ID_PAT, "I");
export const ARXIV_HOSTS = new Set(["arxiv.org", "export.arxiv.org", "ar5iv.org", "ar5iv.labs.arxiv.org",
  "alphaxiv.org", "browse.arxiv.org", "lanl.arxiv.org", "xxx.lanl.gov"]);

export function validNewCore(core) {
  const [yymm, num] = core.split(".");
  const yy = pyInt(cpSlice(yymm, 0, 2)), mm = pyInt(cpSlice(yymm, 2));
  if (!(mm >= 1 && mm <= 12)) return false;
  if (cpLen(num) === 4) return (yy > 7 || (yy === 7 && mm >= 4)) && yy <= 14;
  return yy >= 15;
}

export function arxivFromMatch(m) {
  if (m.group("new")) {
    if (!validNewCore(m.group("new"))) return "";
    return m.group("new") + pyLower(m.group("nv") || "");
  }
  return `${pyLower(m.group("arch"))}/${m.group("num")}${pyLower(m.group("ov") || "")}`;
}

export function matchArxivExact(s) {
  const m = ARXIV_ID_RE.fullmatch(pyStrip(s || ""));
  return m ? arxivFromMatch(m) : "";
}

export function arxivFromPath(rest) {
  const m = ARXIV_ID_RE.match(rest || "");
  return m ? arxivFromMatch(m) : "";
}

const SPLIT_VERSION = re(String.raw`^(.*?)(v\d+)?$`);

// _split_arxiv_version(aid) -> [base, version]
export function splitArxivVersion(aid) {
  const m = SPLIT_VERSION.match(aid || "");
  return m ? [m.group(1), m.group(2) || ""] : [aid || "", ""];
}

export function arxivDoi(base) {
  return `10.48550/arXiv.${base}`;
}

// ---------------------------------------------------------------------------------------------------
// DOIs

export const DOI_TAIL_PATS = [
  String.raw`/(?:suppl(?:_file)?|supplementary|supplemental|suppinfo|figures?|tables?|`
    + String.raw`media|assets?|attachments?|downloads?)(?:/.*)?$`,
  String.raw`\.full\.pdf(?:\+html)?$`, String.raw`\.full(?:-text)?$`, String.raw`\.abstract$`,
  String.raw`\.pdf$`, String.raw`\+html$`, String.raw`\.html?$`,
  String.raw`/(?:full|abstract|abs|summary|pdf|epdf|pdfdirect|pdfft|meta|fulltext|full-text|`
    + String.raw`html|references|citedby|cited-by|metrics|reader|view|info|comments|text|`
    + String.raw`issuetoc|toc|bibtex|ris|citation)$`,
].map((p) => re(p, "I"));

const DOI_URL_PREFIX = re(String.raw`^(?:https?://)?(?:dx\.)?doi\.org/`, "I");
const DOI_SCHEME_PREFIX = re(String.raw`^(?:doi\s*:?\s*|info:doi/|urn:doi:)`, "I");
const DOT_PDF_END = re(String.raw`\.pdf$`, "I");
const VERSION_END = re(String.raw`v\d+$`);
const DOI_FULL = re(String.raw`10\.\d{4,9}/\S+`);

export function cleanDoi(raw, fromUrl = false) {
  let d = pyStrip(pyStr(pyTruthy(raw) ? raw : ""));
  if (fromUrl || pyLower(d).includes("%2f") || pyLower(d).includes("%3a")) d = unquote(d);
  d = DOI_URL_PREFIX.sub("", d);
  d = pyStrip(DOI_SCHEME_PREFIX.sub("", d));
  if (fromUrl) d = d.split("?")[0].split("#")[0];
  const words = pySplit(d);
  d = stripTrailing(words.length ? words[0] : "");
  let changed = true;
  while (changed && fromUrl) {
    changed = false;
    for (const pat of DOI_TAIL_PATS) {
      const m = pat.search(d);
      if (m && cpIndex(d, m.index) > 8) {
        d = d.slice(0, m.index);
        changed = true;
      }
    }
    d = pyRstrip(d, "/.,;:");
  }
  if (!fromUrl) d = DOT_PDF_END.sub("", d);
  if (pyLower(d).startsWith("10.1101/")) d = VERSION_END.sub("", d);
  return DOI_FULL.fullmatch(d) ? d : "";
}

// ---------------------------------------------------------------------------------------------------
// Cleaning pasted text

const ZW = new Set(["​", "‌", "‍", "⁠", "﻿"]);
export const PAIRS = {
  "<": ">", "(": ")", "[": "]", "{": "}", '"': '"', "'": "'",
  "“": "”", "‘": "’", "`": "`", "«": "»",
};
export const CLOSERS = { ")": "(", "]": "[", "}": "{" };
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

const TRAILING = new Set([...".,;:!?'\"”’>`»"]);

// _strip_trailing(s), in one pass from the end: e is where the kept text ends, and the bracket counts of
// s[:e] are taken once (when a closer is first met) and kept up to date as characters are cut, so that a long
// run of trailing punctuation costs linear time like Python's memcpy-backed slices rather than quadratic.
export function stripTrailing(s) {
  const lastStart = (e) => (e > 1 && (s.charCodeAt(e - 1) & 0xfc00) === 0xdc00
    && (s.charCodeAt(e - 2) & 0xfc00) === 0xd800 ? e - 2 : e - 1);
  let e = s.length, counts = null;
  while (e > 0) {
    let k = lastStart(e);
    const c = s.slice(k, e);
    let cut = TRAILING.has(c);
    if (!cut && has(CLOSERS, c)) {
      if (!counts) {
        counts = { "(": 0, ")": 0, "[": 0, "]": 0, "{": 0, "}": 0 };
        for (let i = 0; i < e; i++) if (has(counts, s[i])) counts[s[i]]++;
      }
      cut = counts[CLOSERS[c]] < counts[c];
    }
    if (!cut) break;
    if (counts && has(counts, c)) counts[c]--;
    e = k;
    while (e > 0) {   // .rstrip()
      k = lastStart(e);
      if (!isSpaceCp(s.codePointAt(k))) break;
      e = k;
    }
  }
  return e === s.length ? s : s.slice(0, e);
}

export function cleanInput(text) {
  if (text === null || text === undefined) return "";
  let s = pyStr(text);
  let t = "";
  for (const ch of s) if (!ZW.has(ch)) t += ch;
  s = pyStrip(t.replaceAll(" ", " "));
  for (let k = 0; k < 5; k++) {
    const before = s;
    const first = cpAt(s, 0);
    if (cpLen(s) >= 2 && has(PAIRS, first) && cpAt(s, -1) === PAIRS[first]) s = pyStrip(cpSlice(s, 1, -1));
    const f2 = cpSlice(s, 0, 1);
    if (["<", "(", "[", "{"].includes(f2) && pyCount(s, f2) > pyCount(s, PAIRS[f2])) s = pyStrip(cpSlice(s, 1));
    if (['"', "'", "“", "‘", "`"].includes(cpSlice(s, 0, 1))) s = pyStrip(cpSlice(s, 1));
    s = stripTrailing(s);
    if (s === before) break;
  }
  return s;
}

// ---------------------------------------------------------------------------------------------------
// Classification

export const DOMAINISH = re(
  String.raw`^(?:www\.[a-z0-9.\-]+\.[a-z]{2,24}(?::\d+)?(?:[/?#]|$)`
  + String.raw`|(?:[a-z0-9](?:[a-z0-9\-]*[a-z0-9])?\.)+[a-z]{2,24}(?::\d+)?/)`, "I");

export function arxivResult(aid, url = "", doi = "") {
  return { kind: "arxiv", arxiv: aid, doi, url: url || `https://arxiv.org/abs/${aid}`, site: "arxiv", id: aid };
}

const ARXIV_DOI_RE = re(String.raw`^10\.48550/arxiv\.(.+)$`, "I");

export function doiResult(doi, url = "", site = "") {
  const m = ARXIV_DOI_RE.match(doi);
  if (m) {
    const aid = matchArxivExact(m.group(1));
    if (aid) return arxivResult(aid, url, arxivDoi(splitArxivVersion(aid)[0]));
  }
  return { kind: "doi", arxiv: "", doi, url: url || `https://doi.org/${doi}`, site: site || "doi", id: doi };
}

export function urlResult(kind, url, site = "", ident = "") {
  return { kind, arxiv: "", doi: "", url, site, id: ident };
}

const U = {
  arxivPath: re(String.raw`/(?:abs|pdf|html|format|ps|src|e-print|papers|overview|v)/(.+)$`),
  hfPapers: re(String.raw`^/papers/(.+)$`),
  natureArticles: re(String.raw`/articles/([a-z][a-z0-9\-._]*?)(?:\.pdf)?/?$`, "I"),
  natureOld: re(String.raw`/(?:full|abs|pdf|fp)/([a-z]+\d[\w\-]*?)(?:_[a-z]+)?\.(?:html|pdf)$`, "I"),
  openreviewId: re(String.raw`[A-Za-z0-9_\-]{5,40}`),
  acl: re(String.raw`/(?:anthology/)?([A-Z]\d{2}-\d{4}|\d{4}\.[a-z0-9]+(?:-[a-z0-9]+)*\.\d+)`
    + String.raw`(?:v\d+)?(?:\.pdf|\.bib|\.xml)?/?$`),
  pmc: re(String.raw`(PMC\d{3,10})`, "I"),
  pubmed: re(String.raw`^/(\d{4,9})/?$`),
  ncbiPubmed: re(String.raw`^/pubmed/(\d{4,9})/?$`),
  europeMed: re(String.raw`^/(?:article|abstract)/MED/(\d{4,9})`, "I"),
  s2Arxiv: re(String.raw`/arxiv/(.+)$`),
  s2Id: re(String.raw`(?<![0-9a-f])([0-9a-f]{40})(?![0-9a-f])`),
  ads: re(String.raw`/abs/([0-9]{4}[A-Za-z0-9.&]{14}[A-Za-z.])(?:/|$)`),
  adsArxiv: re(String.raw`^(\d{4})arXiv(\d{4})\.?(\d{4,5})[A-Z.]$`),
  inspire: re(String.raw`^/(?:api/)?(?:literature|record)/(\d+)`),
  pii: re(String.raw`(?:pii/|PII|fulltext/|abstract/|retrieve/pii/)(S?[\dX][\dX\-()]{14,24}[\dX])`, "I"),
  piiJunk: re(String.raw`[^0-9X]`),
  biorxivDoi: re(String.raw`/content/(10\.1101/[^?#]+)`),
  biorxivId: re(String.raw`(?<![\d.])(\d{4}\.\d{2}\.\d{2}\.\d{6})(?![\d])`),
  pathDoi: re(String.raw`(10\.\d{4,9}/[^\s?#]+)`),
  queryDoi: re(String.raw`(10\.\d{4,9}/\S+)`),
};

export function classifyUrl(url) {
  let p, host;
  try {
    p = urlsplit(url);
    host = pyLower(p.hostname || "");
  } catch (e) {
    if (e instanceof PyValueError) return null;
    throw e;
  }
  const scheme = pyLower(p.scheme);
  if ((scheme !== "http" && scheme !== "https") || !host || !host.includes(".")) return null;
  if (scheme === "http" && host.endsWith("arxiv.org")) url = "https" + cpSlice(url, 4);
  const h = host.startsWith("www.") ? cpSlice(host, 4) : host;
  const path = unquote(p.path || "");
  const qs = parseQs(p.query);
  let m;

  // arXiv and mirrors
  if (ARXIV_HOSTS.has(h) || h.endsWith(".arxiv.org")) {
    m = U.arxivPath.search(path);
    const aid = m ? arxivFromPath(m.group(1)) : "";
    if (aid) return arxivResult(aid, url);
    return urlResult("url", url, "arxiv");
  }
  if (h === "huggingface.co") {
    m = U.hfPapers.match(path);
    const aid = m ? arxivFromPath(m.group(1)) : "";
    if (aid) return arxivResult(aid, url);
  }

  // doi.org resolver links
  if (h === "doi.org" || h === "dx.doi.org" || h.endsWith(".doi.org")) {
    const d = cleanDoi(pyLstrip(path, "/"), true);
    if (d) return doiResult(d, url, "doi");
  }

  // Nature: /articles/<id> is DOI 10.1038/<id>
  if (h === "nature.com" || h.endsWith(".nature.com")) {
    m = U.natureArticles.search(path);
    if (!m) m = U.natureOld.search(path);
    if (m) return doiResult(`10.1038/${m.group(1)}`, url, "nature");
  }

  if (h === "openreview.net") {
    const oid = pyStrip((qs.get("id") || qs.get("noteId") || [""])[0]);
    if (U.openreviewId.fullmatch(oid)) return urlResult("url", `https://openreview.net/forum?id=${oid}`, "openreview", oid);
    return urlResult("url", url, "openreview");
  }

  if (h === "aclanthology.org" || h === "aclweb.org" || h === "aclanthology.info") {
    m = U.acl.search(path);
    if (m) {
      const aid = m.group(1);
      return urlResult("url", `https://aclanthology.org/${aid}/`, "acl", aid);
    }
  }

  if (h === "pmc.ncbi.nlm.nih.gov" || h === "ncbi.nlm.nih.gov" || h === "europepmc.org" || h.endsWith(".ncbi.nlm.nih.gov")) {
    m = U.pmc.search(path);
    if (m && (h !== "ncbi.nlm.nih.gov" || path.includes("/pmc/"))) {
      const pmc = pyUpper(m.group(1));
      return urlResult("url", `https://pmc.ncbi.nlm.nih.gov/articles/${pmc}/`, "pmc", pmc);
    }
    m = h === "pubmed.ncbi.nlm.nih.gov" ? U.pubmed.match(path)
      : h === "ncbi.nlm.nih.gov" ? U.ncbiPubmed.match(path)
        : h === "europepmc.org" ? U.europeMed.match(path) : null;
    if (m) {
      const pmid = m.group(1);
      return urlResult("url", `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`, "pubmed", pmid);
    }
  }

  if (h === "semanticscholar.org" || h === "api.semanticscholar.org") {
    m = U.s2Arxiv.search(path);
    const aid = m ? arxivFromPath(m.group(1)) : "";
    if (aid) return arxivResult(aid, url);
    m = U.s2Id.search(path);
    if (m) return urlResult("url", url, "s2", m.group(1));
  }

  if (h === "ui.adsabs.harvard.edu" || h === "adsabs.harvard.edu" || h === "articles.adsabs.harvard.edu") {
    m = U.ads.search(path);
    if (m) {
      const bib = m.group(1);
      const am = U.adsArxiv.match(bib);
      if (am) {
        const aid = matchArxivExact(`${am.group(2)}.${am.group(3)}`);
        if (aid) return arxivResult(aid, url);
      }
      return urlResult("url", url, "ads", bib);
    }
  }

  if (h === "inspirehep.net") {
    m = U.inspire.match(path);
    if (m) {
      const rid = m.group(1);
      return urlResult("url", `https://inspirehep.net/literature/${rid}`, "inspire", rid);
    }
  }

  if (h === "sciencedirect.com" || h === "cell.com" || h === "thelancet.com" || h === "linkinghub.elsevier.com"
      || h.endsWith(".sciencedirect.com") || h.endsWith(".cell.com")) {
    m = U.pii.search(path);
    if (m) {
      let pii = U.piiJunk.sub("", pyUpper(m.group(1)));
      pii = !pii.startsWith("S") ? "S" + pii : pii;
      if (cpLen(pii) >= 15) return urlResult("url", url, "elsevier", pii);
    }
  }

  if (h === "biorxiv.org" || h === "medrxiv.org") {
    m = U.biorxivDoi.search(path);
    if (m) {
      const d = cleanDoi(m.group(1), true);
      if (d) return doiResult(d, url, h.split(".")[0]);
    }
    m = U.biorxivId.search(path);
    if (m) return doiResult(`10.1101/${m.group(1)}`, url, h.split(".")[0]);
  }

  // Generic: a DOI in the path or in a query value
  m = U.pathDoi.search(path);
  if (m) {
    const d = cleanDoi(m.group(1), true);
    if (d) return doiResult(d, url, h);
  }
  for (const vals of qs.values()) {
    for (const v of vals) {
      m = U.queryDoi.search(v);
      if (m) {
        const d = cleanDoi(m.group(1), true);
        if (d) return doiResult(d, url, h);
      }
    }
  }

  if (pyLower(path).endsWith(".pdf")) return urlResult("pdf_url", url, h);
  return urlResult("url", url, h);
}

const T = {
  arxivPrefix: re(String.raw`^arxiv\s*:\s*(.+)$`, "I"),
  doiPrefix: re(String.raw`^(?:doi\s*:?\s*|info:doi/|urn:doi:)(10\.\S+)$`, "I"),
  bareDoi: re(String.raw`^10\.\d{4,9}/\S+$`),
  http: re(String.raw`^https?://`, "I"),
  space: re(String.raw`\s`),
  embUrl: re(String.raw`https?://[^\s<>\"'“”]+`, "I"),
  embArxiv: re(String.raw`arxiv\s*:\s*(` + ARXIV_ID_PAT + String.raw`)`, "I"),
  embDoi: re(String.raw`(?<![\w.])10\.\d{4,9}/[^\s\"'<>]+`),
  embId: re(String.raw`(?<![\w./])` + ARXIV_ID_PAT, "I"),
};

export function classifyToken(s) {
  if (!s) return null;
  let m = T.arxivPrefix.match(s);
  if (m) {
    const aid = matchArxivExact(pyStrip(m.group(1)));
    if (aid) return arxivResult(aid);
  }
  const aid = matchArxivExact(s);
  if (aid) return arxivResult(aid);
  m = T.doiPrefix.match(s);
  if (m) {
    const d = cleanDoi(m.group(1));
    if (d) return doiResult(d);
  }
  if (T.bareDoi.match(s)) {
    const d = cleanDoi(s);
    if (d) return doiResult(d);
  }
  if (T.http.match(s)) return classifyUrl(s);
  if (!s.includes(" ") && DOMAINISH.match(s)) return classifyUrl("https://" + s);
  return null;
}

// Pull an identifier out of free text such as a pasted citation.
export function findEmbedded(s) {
  let m = T.embUrl.search(s);
  if (m) {
    const r = classifyToken(stripTrailing(m.group(0)));
    if (r) return r;
  }
  m = T.embArxiv.search(s);
  if (m) {
    const aid = arxivFromMatch(ARXIV_ID_RE.match(m.group(1)));
    if (aid) return arxivResult(aid);
  }
  m = T.embDoi.search(s);
  if (m) {
    const d = cleanDoi(stripTrailing(m.group(0)));
    if (d) return doiResult(d);
  }
  if (pyLower(s).includes("arxiv") || pySplit(s).length <= 3) {
    for (const mm of T.embId.finditer(s)) {
      const aid = arxivFromMatch(mm);
      if (aid) return arxivResult(aid);
    }
  }
  return null;
}

export const SITE_NAMES = {
  openreview: "OpenReview", acl: "ACL Anthology", pmc: "PubMed Central",
  pubmed: "PubMed", inspire: "INSPIRE", elsevier: "ScienceDirect",
  s2: "Semantic Scholar", ads: "NASA ADS",
};

// _host(url): lowercased hostname without "www.", "" when the URL can't be split
export function host(url) {
  let h;
  try {
    h = pyLower(urlsplit(url).hostname || "");
  } catch (e) {
    if (e instanceof PyValueError) return "";
    throw e;
  }
  return h.startsWith("www.") ? cpSlice(h, 4) : h;
}

export function label(r) {
  const k = r.kind;
  if (k === "arxiv") return `arXiv ${r.arxiv}`;
  if (k === "doi") return `DOI ${r.doi}`;
  if (k === "pdf_url") return `PDF link (${host(r.url)})`;
  if (k === "url") {
    if (has(SITE_NAMES, r.site) && r.id) return `${SITE_NAMES[r.site]} ${r.id}`;
    return `Web page (${host(r.url)})`;
  }
  return "";
}

function unknown() {
  return { kind: "unknown", arxiv: "", doi: "", url: "", site: "", id: "", label: "" };
}

// parse_input(text): classify pasted text without touching the network; never throws.
// -> {kind: "arxiv"|"doi"|"url"|"pdf_url"|"unknown", arxiv, doi, url, site, id, label}
export function parseInput(text) {
  let out = unknown();
  try {
    const s = cleanInput(text);
    if (!s) return out;
    let r = classifyToken(s);
    if (r === null && T.space.search(s)) r = findEmbedded(s);
    if (r) Object.assign(out, r);
    out.label = label(out);
  } catch {
    out = unknown();
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------
// Small pure helpers the network code uses

const ARXIV_DOI_ANY = re(String.raw`10\.48550/arxiv\.(.+)$`, "I");

// _arxiv_id_in_url(u): the arXiv id (no version) in an arXiv URL or arXiv DOI, else ""
export function arxivIdInUrl(u) {
  if (!u || !pyLower(u).includes("arxiv")) return "";
  const r = classifyUrl(u.startsWith("http") ? u : "https://" + u);
  if (r && r.kind === "arxiv") return splitArxivVersion(r.arxiv)[0];
  const m = ARXIV_DOI_ANY.search(u);
  return m ? splitArxivVersion(matchArxivExact(m.group(1)))[0] : "";
}

const PDF_EXT = re(String.raw`\.pdf$`, "I");
const UNDERSCORES = re(String.raw`[_+]+`);
const THREE_LETTERS = re(String.raw`[A-Za-z]{3}`);

// _title_from_filename(url)
export function titleFromFilename(url) {
  let name;
  try {
    name = unquote(pyRstrip(urlsplit(url).path, "/").split("/").pop());
  } catch (e) {
    if (!(e instanceof PyValueError)) throw e;
    name = "";
  }
  name = PDF_EXT.sub("", name);
  let t = UNDERSCORES.sub(" ", name);
  if (pyCount(t, "-") >= 2 && THREE_LETTERS.search(t)) t = t.replaceAll("-", " ");
  t = ws(t);
  if (t && t === pyLower(t) && t.includes(" ")) t = pyUpper(cpAt(t, 0)) + cpSlice(t, 1);
  return t || "Untitled PDF";
}

// _dedupe_urls(urls): http(s) strings only, first occurrence kept
export function dedupeUrls(urls) {
  const out = [];
  for (const u of urls) {
    if (typeof u === "string" && (u.startsWith("http://") || u.startsWith("https://")) && !out.includes(u)) out.push(u);
  }
  return out;
}

// _blocked_message(url)
export function blockedMessage(url) {
  const h = host(url) || "This site";
  return `${h} blocks automated access, so the paper could not be loaded `
    + "from that link. Paste its DOI or arXiv id instead, or download the "
    + "PDF in your browser and attach it.";
}
