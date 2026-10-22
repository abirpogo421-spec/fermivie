// resolve(), search(), findPreprint() and downloadPdf() for the browser: port of importers.py's resolve
// section, routed only through hosts a web page can read (WEB_CONTRACT.md section 6.2).
//
// Same result shapes as Python:
//   resolve(text, {timeout}) -> {ok, error, meta, pdf_url, pdf_candidates, source, warnings} (+ candidates)
//   search(query, limit, {timeout}) -> {ok, error, results: [{input, title, authors, year, venue, type, doi,
//                                       arxiv, source}], warnings}
//   findPreprint(meta, {timeout}) -> arXiv id (no version) or ""
//   downloadPdf(url, {timeout, maxBytes}) -> {ok, error, bytes (Uint8Array), size, sha256, final_url,
//                                             content_type}
// None of them throws.
//
// Where Python reads a source a web page can't (the arXiv API and arxiv.org/abs, publisher pages, OpenReview,
// ACL Anthology), the browser uses: for arXiv ids, arXiv's DataCite record checked against arXiv itself (HEAD
// requests to arxiv.org/pdf and arxiv.org/html: DataCite lags a day behind arXiv), another version's own text from
// its HTML rendering at arxiv.org/html (the arXiv API answers per version), and for a paper DataCite doesn't have
// yet OpenAlex, Semantic Scholar, then the paper's rendering or PDF; a search of arXiv's records at DataCite for the arXiv API's searches (title phrase,
// author + title words, all words), with OpenAlex and Semantic Scholar only when DataCite can't be reached; the
// DOI for ACL Anthology; and for other pages the message BLOCKED_SITE_MESSAGE.
//
// PDF candidates are listed in Python's order, except that those a web page can download come first
// (reachableFirst): Python downloads repository and publisher copies a page can't, so trying those first would
// only spend the importer's six attempts. For the same reason a DOI whose only PDFs are on such hosts is looked
// up on arXiv by title, as Python does for a DOI with no PDF at all.

import { ws, cleanText } from "./text.js";
import {
  emptyMeta, finalizeMeta, normTitle, fold, titleWords, squash, formatAuthorsShort, familyOf, STOPWORDS, parseDate,
} from "./names.js";
import {
  parseInput, cleanInput, splitArxivVersion, matchArxivExact, arxivDoi, dedupeUrls, blockedMessage, titleFromFilename,
} from "./parse.js";
import { pdfIdentifiers, isPdfBytes, isHtmlBytes, notPdfMessage, humanSize, sniffPdf } from "./pdfsniff.js";
import {
  NetError, MB, BLOCKED_SITE_MESSAGE, fetchResp, getJson, describe, host, isReachable, reachableFirst, urlencode,
  pyQuote, splitUrl, explainFetchError, contentTypeOf, netFetch,
} from "./net.js";
import * as M from "./meta.js";
import { sha256Hex } from "../pyjson.js";

export const NO_OA_PDF_WARNING = "No open-access PDF found - attach the PDF yourself";
export { BLOCKED_SITE_MESSAGE, dedupeUrls, blockedMessage, titleFromFilename, isPdfBytes, isHtmlBytes, notPdfMessage, humanSize,
  reachableFirst };

const { truthy, or, get } = M;
const clock = () => (typeof performance !== "undefined" && performance.now ? performance.now() : Date.now());
const lower = (s) => String(s).toLowerCase();
const isNetError = (e) => e instanceof NetError;

// ---------------------------------------------------------------------------------------------------
// _Ctx: one lookup's time budget and warnings

export class Ctx {
  constructor(timeout) {
    const t = Number(timeout || 20);
    this.timeout = Number.isFinite(t) ? Math.max(3.0, t) : 20.0;
    this.start = clock();
    this.budget = Math.max(this.timeout * 3.0, 30.0);
    this.warnings = [];
    this.down = new Set();   // search services that failed in this lookup (not asked again by its later steps)
  }

  remaining() {
    return this.budget - (clock() - this.start) / 1000;
  }

  t() {
    return Math.max(2.0, Math.min(this.timeout, this.remaining()));
  }

  hasTime(need = 3.0) {
    return this.remaining() > need;
  }

  warn(msg) {
    if (msg && !this.warnings.includes(msg)) this.warnings.push(msg);
  }
}

/** _result(ctx, ok, meta, source, pdf_url, more_pdfs, error, **extra); the PDFs a page can download first. */
export function result(ctx, ok, meta, source, pdfUrl = null, morePdfs = [], error = null, extra = {}) {
  const cands = reachableFirst(dedupeUrls([pdfUrl, ...morePdfs]));
  const r = {
    ok: Boolean(ok),
    error: ok ? null : (error || "Something went wrong."),
    meta: finalizeMeta(meta),
    pdf_url: cands.length ? cands[0] : null,
    pdf_candidates: cands,
    source,
    warnings: [...ctx.warnings],
  };
  return Object.assign(r, extra);
}

/** _fail(ctx, error, meta, source, pdf_url, **extra) */
export function fail(ctx, error, { meta = null, source = "", pdfUrl = null, ...extra } = {}) {
  return result(ctx, false, meta || emptyMeta(), source, pdfUrl, [], error, extra);
}

// ---------------------------------------------------------------------------------------------------
// arXiv
//
// Python asks the arXiv API, which answers per version and knows a paper as soon as arXiv announces it. A page
// reads arXiv's DataCite record instead, which holds only its latest version's text and lags about a day behind
// arXiv, for new papers and for new versions alike. So arXiv itself is asked too (HEAD requests to arxiv.org/pdf and
// arxiv.org/html): whether a paper or version DataCite doesn't know exists, and whether a newer version than
// DataCite's is out. A version other than DataCite's gets its own title, abstract and authors from its HTML
// rendering at arxiv.org/html where they changed between the versions (versionText); a paper DataCite, OpenAlex and
// Semantic Scholar don't know yet gets them from its rendering or its PDF (arxivFromArxiv).

// The fields the arXiv API's entry always fixes. volume, issue and pages are cleared too: a backup source
// (OpenAlex, Semantic Scholar) may carry the journal version's, which don't belong with venue "arXiv" and never
// come from the arXiv API.
const ARXIV_FIXED = (base, ver) => ({
  venue: "arXiv", publisher: "arXiv", type: "preprint", arxiv: base, arxiv_version: ver,
  url: `https://arxiv.org/abs/${base}`, volume: "", issue: "", pages: "",
});

const HTML_DEC = new TextDecoder("utf-8");

/**
 * Does arXiv have this id (with or without a version)? true, false (arXiv answered 404 for its PDF, and its
 * rendering is not there either), or null (could not tell). HEAD requests: nothing is downloaded. A version
 * announced minutes ago can have its rendering before its PDF, so both are asked. probe: false = a refused request
 * counts as "could not tell" and costs no second request (net.js explainFetchError).
 */
export async function arxivHas(ctx, id, { probe = true } = {}) {
  if (!ctx.hasTime(2)) return null;
  const ask = async (url) => {
    try {
      await fetchResp(url, { method: "HEAD", timeout: Math.min(ctx.t(), 10.0), retries: 0, probe, cache: true });
      return true;
    } catch (e) {
      if (!isNetError(e)) throw e;
      return e.kind === "notfound" ? false : null;
    }
  };
  const [pdf, html] = await Promise.all([ask(`https://arxiv.org/pdf/${id}`), ask(`https://arxiv.org/html/${id}`)]);
  if (pdf || html) return true;
  return pdf === false ? false : null;
}

/** The latest version arXiv has, counting up from `known` (a version that exists): v<known+1>, v<known+2>, ...
 * until arXiv has none (arxivHas without the probe: a refused request ends the count). */
export async function arxivLatest(ctx, base, known) {
  let n = known;
  while (n < known + 30 && ctx.hasTime(4) && (await arxivHas(ctx, `${base}v${n + 1}`, { probe: false }))) n++;
  return n;
}

/** One arXiv version's rendering at https://arxiv.org/html/<id>: {title, abstract, block (arxivHtmlAuthors)}, or
 * null when arXiv has none (or it could not be read in time). */
export async function arxivVersionText(ctx, id) {
  if (!ctx.hasTime(4)) return null;
  const url = `https://arxiv.org/html/${id}`;
  try {
    const resp = await fetchResp(url, { timeout: Math.min(ctx.t(), 15.0), accept: "text/html,*/*;q=0.8",
      maxBytes: 2 * MB, retries: 0, cache: true, probe: false });
    if (resp.url && resp.url.replace(/\/+$/, "") !== url) return null;   // redirected to another version
    const html = HTML_DEC.decode(resp.body);
    const t = M.arxivHtmlTitleAbstract(html);
    const block = M.arxivHtmlAuthors(html);
    return t.title || t.abstract || block ? { ...t, block } : null;
  } catch (e) {
    if (!isNetError(e)) throw e;
    return null;
  }
}

const squashSame = (a, b) => squash(a) === squash(b);
/** Two renderings' texts compared with their math left out (one LaTeXML release writes TeX differently from the
 * next) and whitespace collapsed; punctuation counts ("Schur-Decomposition" -> "Schur Decomposition"). */
const plain = (t) => ws(String(t || "").replace(/\$\$?[^$]*\$\$?/g, "$"));
const andList = (xs) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

/**
 * meta holds DataCite's text, which is version v<known>'s; ver is another version (older, or newer than DataCite
 * knows). Where ver's rendering reads differently from v<known>'s, the paper changed: take ver's title or abstract
 * (rendered text can differ from arXiv's metadata in small ways, so DataCite's exact text is kept wherever the two
 * renderings agree). When the author blocks differ, the authors this version's block doesn't name are left out and
 * the ones only it names are added. Each part taken from a rendering is named in a warning.
 */
export async function versionText(ctx, meta, base, ver, known) {
  const which = Number(ver.slice(1)) > known ? `arXiv version v${known}` : `the latest arXiv version (v${known})`;
  const [v, l] = await Promise.all([arxivVersionText(ctx, base + ver), arxivVersionText(ctx, `${base}v${known}`)]);
  if (!v) {
    ctx.warn(`The title and abstract are those of ${which}; ${ver}'s could not be read.`);
    return;
  }
  const changed = (part) => {
    if (!v[part]) return false;
    if (l && l[part]) return plain(v[part]) !== plain(l[part]);
    return !squashSame(v[part], meta[part]);
  };
  const taken = [];
  if (changed("title")) {
    meta.title = v.title;
    taken.push("title");
  }
  const inL = (a) => M.namedIn(a, l.block.words);
  if (v.block && l && l.block && v.block.words.join(" ") !== l.block.words.join(" ")
      && 2 * meta.authors.filter(inL).length >= meta.authors.length && meta.authors.length) {
    // at least half of DataCite's authors are found in v<known>'s block, so its names are written as namedIn
    // expects: an author it names and this version's block doesn't is left out (one neither names stays)
    const kept = meta.authors.filter((a) => !inL(a) || M.namedIn(a, v.block.words));
    const added = v.block.authors.filter((a) => !M.namedIn(a, l.block.words) && !kept.some((k) => M.namedIn(k, [
      ...normTitle(a.given).split(" "), ...normTitle(a.family).split(" ")].filter(Boolean))));
    if (kept.length && (kept.length < meta.authors.length || added.length)) {
      meta.authors = [...kept, ...added];
      taken.push("authors");
    }
  }
  if (changed("abstract")) {
    meta.abstract = v.abstract;
    taken.push("abstract");
  }
  if (taken.length) {
    ctx.warn(`The ${andList(taken)} of ${ver} ${taken.length > 1 ? "were" : "was"} read from the paper itself and may differ `
      + "slightly from arXiv's listing.");
  }
  if (!v.abstract && meta.abstract) ctx.warn(`The abstract is that of ${which}; ${ver}'s could not be read.`);
}

async function arxivFromOpenalex(ctx, base, ver) {
  const work = await M.openalexWork(ctx, arxivDoi(base));
  const meta = M.metaFromOpenalex(work, "");
  if (!meta.title) throw new NetError("http", "no metadata in OpenAlex");
  return Object.assign(meta, ARXIV_FIXED(base, ver));
}

async function arxivFromS2(ctx, base, ver) {
  const url = `https://api.semanticscholar.org/graph/v1/paper/arXiv:${pyQuote(base, "/")}?fields=${M.S2_FIELDS}`;
  const d = await getJson(url, ctx, 0);
  if (!d || !truthy(get(d, "title"))) throw new NetError("http", "no metadata in Semantic Scholar");
  const meta = M.metaFromS2(d, "");
  const ext = or(get(d, "externalIds"), {});
  meta.doi = or(get(ext, "DOI"), arxivDoi(base));
  return Object.assign(meta, ARXIV_FIXED(base, ver));
}

export const ARXIV_FROM_PAPER_WARNING = "arXiv's record of this paper can't be read from a web page yet (it usually "
  + "can a day after arXiv announces a paper), so its details were read from the paper itself. Check them.";
export const ARXIV_FROM_PAPER_DOWN_WARNING = "The services that hold arXiv's records could not be reached, so this "
  + "paper's details were read from the paper itself. Check them.";

/** A paper arXiv has (version n, 0 = unknown) that no record a page can read knows yet: title, authors and abstract
 * from its rendering, else the title from its PDF; the date from the id (yymm), as close as the id tells. */
async function arxivFromArxiv(ctx, base, n, lagging = true) {
  const idv = n ? `${base}v${n}` : base;
  const meta = emptyMeta();
  const v = await arxivVersionText(ctx, idv);
  if (v) {
    meta.title = v.title;
    meta.abstract = v.abstract;
    meta.authors = v.block ? v.block.authors : [];
  }
  if (!meta.title && ctx.hasTime(6)) {
    try {
      const resp = await fetchResp(`https://arxiv.org/pdf/${idv}`, { timeout: Math.min(ctx.t(), 20.0), accept: "application/pdf,*/*",
        maxBytes: 16 * MB, retries: 0, probe: false });
      if (!resp.truncated && isPdfBytes(resp.body)) meta.title = (await sniffPdf(resp.body)).title || "";
    } catch (e) {
      if (!isNetError(e)) throw e;
    }
  }
  const ym = /^(\d{2})(\d{2})\.\d{4,5}$/.exec(base) || /\/(\d{2})(\d{2})\d{3}$/.exec(base);
  if (ym) meta.date = parseDate(`${Number(ym[1]) < 91 ? 20 : 19}${ym[1]}-${ym[2]}`);
  meta.doi = arxivDoi(base);
  ctx.warn(lagging ? ARXIV_FROM_PAPER_WARNING : ARXIV_FROM_PAPER_DOWN_WARNING);
  return Object.assign(meta, ARXIV_FIXED(base, n ? `v${n}` : ""));
}

/**
 * _arxiv_api_meta + _resolve_arxiv's sources, for a page: {meta, notfound, versionMissing, errors}. DataCite's
 * record first, checked against arXiv (arxivHas, arxivLatest); then, for a paper DataCite doesn't have, OpenAlex,
 * Semantic Scholar and the paper itself (arxivFromArxiv). notfound only when arXiv itself says so (or for v0, v01,
 * which arXiv never has); DataCite's and OpenAlex's "no record" are not taken as an answer, as they lag behind arXiv.
 */
export async function arxivLookup(ctx, base, ver) {
  const errors = [];
  const out = (meta, notfound = false, versionMissing = false) => ({ meta, notfound, versionMissing, errors });
  // arXiv knows v1, v2, ...: not v0, nor a number written with leading zeros (v01)
  const n = /^v[1-9]\d*$/.test(ver) ? Number(ver.slice(1)) : 0;
  if (ver && !n) return out(null, true, true);
  let data = null;
  let dcMissing = false;   // DataCite answered: no record (yet)
  try {
    data = await getJson(M.dataciteUrl(arxivDoi(base)), ctx);
  } catch (e) {
    if (!isNetError(e)) throw e;
    dcMissing = e.kind === "notfound";
    errors.push(describe(e, "DataCite"));
  }
  const known = data ? M.dataciteLatestVersion(data) : 0;
  let exists = data ? true : null;
  if (!data || (n && known && n > known)) {
    exists = await arxivHas(ctx, base + ver);
    if (exists === false) return out(null, true, Boolean(data && ver));
    if (data && exists === null) {   // a version after DataCite's latest that arXiv could not be asked about
      errors.push(`DataCite knows versions up to v${known} and arxiv.org could not be reached`);
      return out(null);
    }
  }
  // the version the answer is for: the one asked for, else the latest arXiv has (0: unknown)
  const want = n || (exists ? await arxivLatest(ctx, base, known || 1) : 0);
  const verOut = ver || (want ? `v${want}` : "");
  if (data) {
    const meta = M.arxivMetaFromDatacite(data, base, ver);
    if (want && known && want !== known) await versionText(ctx, meta, base, `v${want}`, known);
    if (verOut) meta.arxiv_version = verOut;
    return out(meta);
  }
  for (const [name, source] of [["OpenAlex", arxivFromOpenalex], ["Semantic Scholar", arxivFromS2]]) {
    if (!ctx.hasTime()) break;
    try {
      return out(await source(ctx, base, verOut));
    } catch (e) {
      if (!isNetError(e)) throw e;
      if (e.kind !== "notfound") errors.push(describe(e, name));
    }
  }
  if (exists) return out(await arxivFromArxiv(ctx, base, want, dcMissing));
  return out(null);
}

/** _arxiv_api_meta's stand-in: arXiv metadata for base (+ requested version); NetError "notfound" (with
 * versionMissing for a version arXiv doesn't have) or "http" when it can't be read. */
export async function arxivMeta(ctx, base, ver) {
  const r = await arxivLookup(ctx, base, ver);
  if (r.meta) return r.meta;
  if (r.notfound) throw Object.assign(new NetError("notfound", "arXiv returned no entry", { status: 404 }), { versionMissing: r.versionMissing });
  throw new NetError("http", r.errors.join("; ") || "no metadata");
}

/** _resolve_arxiv(ctx, aid) */
export async function resolveArxiv(ctx, aid) {
  const [base, ver] = splitArxivVersion(aid);
  const { meta, notfound, errors } = await arxivLookup(ctx, base, ver);
  if (meta === null) {
    if (notfound) {
      const what = ver ? `version ${ver} of arXiv:${base}` : `arXiv:${base}`;
      return fail(ctx, `arXiv has no paper ${what}. Check the id.`, { source: "arxiv" });
    }
    const why = errors.length ? errors.slice(0, 2).join("; ") : "DataCite has no record of it and arxiv.org could not be reached";
    return fail(ctx, "Could not load arXiv:" + aid + " (" + why + ").", { source: "arxiv" });
  }
  if (errors.length && !ctx.warnings.includes(ARXIV_FROM_PAPER_WARNING) && !ctx.warnings.includes(ARXIV_FROM_PAPER_DOWN_WARNING)) {
    ctx.warn("arXiv API was unavailable; details came from a backup source");
  }
  return result(ctx, true, meta, "arxiv", `https://arxiv.org/pdf/${base}${ver}`);
}

/** _arxiv_abstract: fill meta's abstract from the arXiv summary (math kept as TeX), or replace an OpenAlex one. */
export async function arxivAbstract(ctx, meta, replace = false) {
  if ((meta.abstract && !replace) || !meta.arxiv || !ctx.hasTime()) return false;
  const [base, ver] = splitArxivVersion(meta.arxiv);
  const r = await arxivLookup(ctx, base, ver);
  const ab = (r.meta && r.meta.abstract) || "";
  if (ab) meta.abstract = ab;
  return Boolean(ab);
}

// ---------------------------------------------------------------------------------------------------
// difflib.SequenceMatcher(None, a, b).ratio(), exactly (autojunk on, no isjunk)

function longestMatch(a, b, b2j, alo, ahi, blo, bhi) {
  let besti = alo;
  let bestj = blo;
  let bestsize = 0;
  let j2len = new Map();
  for (let i = alo; i < ahi; i++) {
    const newj2len = new Map();
    for (const j of b2j.get(a[i]) || []) {
      if (j < blo) continue;
      if (j >= bhi) break;
      const k = (j2len.get(j - 1) || 0) + 1;
      newj2len.set(j, k);
      if (k > bestsize) {
        besti = i - k + 1;
        bestj = j - k + 1;
        bestsize = k;
      }
    }
    j2len = newj2len;
  }
  while (besti > alo && bestj > blo && a[besti - 1] === b[bestj - 1]) {
    besti--; bestj--; bestsize++;
  }
  while (besti + bestsize < ahi && bestj + bestsize < bhi && a[besti + bestsize] === b[bestj + bestsize]) bestsize++;
  return [besti, bestj, bestsize];
}

/** SequenceMatcher(None, a, b).ratio() */
export function seqRatio(a, b) {
  a = Array.from(String(a));
  b = Array.from(String(b));
  const la = a.length;
  const lb = b.length;
  if (la + lb === 0) return 1.0;
  const b2j = new Map();
  b.forEach((ch, j) => {
    if (!b2j.has(ch)) b2j.set(ch, []);
    b2j.get(ch).push(j);
  });
  if (lb >= 200) {
    const ntest = Math.floor(lb / 100) + 1;
    for (const [ch, idxs] of [...b2j]) if (idxs.length > ntest) b2j.delete(ch);
  }
  const queue = [[0, la, 0, lb]];
  const blocks = [];
  while (queue.length) {
    const [alo, ahi, blo, bhi] = queue.pop();
    const [i, j, k] = longestMatch(a, b, b2j, alo, ahi, blo, bhi);
    if (k) {
      blocks.push([i, j, k]);
      if (alo < i && blo < j) queue.push([alo, i, blo, j]);
      if (i + k < ahi && j + k < bhi) queue.push([i + k, ahi, j + k, bhi]);
    }
  }
  const matches = blocks.reduce((s, x) => s + x[2], 0);
  return la + lb ? (2.0 * matches) / (la + lb) : 1.0;
}

// ---------------------------------------------------------------------------------------------------
// finding the arXiv version of a published paper. Python searches the arXiv API; here the same records are
// searched at DataCite, where arXiv deposits them (titles, authors, versions), and their answer stands as the
// arXiv API's does. OpenAlex, then Semantic Scholar, are asked only when DataCite can't be reached.

const OA_SELECT = "id,doi,display_name,title,publication_year,publication_date,authorships,primary_location,"
  + "locations,best_oa_location,open_access,biblio,type,type_crossref";
const S2_SEARCH_FIELDS = "title,authors,year,venue,externalIds,publicationTypes,journal,publicationDate";

const filterText = (s) => ws(String(s || "").replace(/[,|:"()!]/g, " "));
const nWords = (s) => (s ? s.split(" ").length : 0);

// the fields of a DataCite search hit arxivMetaFromDatacite reads
const DC_FIELDS = "doi,identifiers,url,titles,creators,dates,publicationYear,version,descriptions,subjects,relatedIdentifiers";

/** A phrase or word for DataCite's query syntax (Elasticsearch query_string): quoted, " and \ escaped. */
export function dcQuote(s) {
  return '"' + String(s).replace(/[\\"]/g, (c) => "\\" + c) + '"';
}

/** The DataCite search URL for arXiv's records matching `query`, most relevant first. */
export function dataciteSearchUrl(query, size) {
  return "https://api.datacite.org/dois?" + urlencode([["query", "prefix:10.48550 AND " + query],
    ["page[size]", String(size)], ["sort", "relevance"], ["fields[dois]", DC_FIELDS]]);
}

/** arXiv's records at DataCite matching `query` (query_string syntax), most relevant first, as
 * {arxiv, title, authors, meta}: the arXiv API search's stand-in. Throws NetError when DataCite can't answer. */
export async function dataciteArxivHits(ctx, query, size, timeout = null) {
  const data = await getJson(dataciteSearchUrl(query, size), ctx, 0, timeout);
  const recs = or(get(or(data, {}), "data"), []);
  if (!Array.isArray(recs)) throw new NetError("http", "unexpected DataCite answer");
  const out = [];
  for (const rec of recs) {
    const aid = M.dataciteArxivId(rec);
    if (!aid) continue;
    let meta;
    try {
      meta = M.arxivMetaFromDatacite({ data: rec }, aid, "");
    } catch (e) {
      if (!isNetError(e)) throw e;
      continue;
    }
    out.push({ arxiv: aid, title: meta.title, authors: meta.authors, meta });
  }
  return out;
}

function workArxiv(w) {
  return M.openalexPdfInfo(w)[1] || M.arxivIdInUrl(String(or(get(w, "doi"), "")));
}

function s2Arxiv(d) {
  const aid = matchArxivExact(String(or(get(or(get(d, "externalIds"), {}), "ArXiv"), "")));
  return aid ? splitArxivVersion(aid)[0] : "";
}

/** OpenAlex works matching a filter, as {arxiv, title, authors, work}. */
async function openalexHits(ctx, filter, perPage, timeout) {
  const url = "https://api.openalex.org/works?" + urlencode([["filter", filter], ["per-page", String(perPage)], ["select", OA_SELECT]]);
  const data = await getJson(url, ctx, 0, timeout);
  return (or(get(data, "results"), [])).filter((w) => w && typeof w === "object").map((w) => {
    const m = M.metaFromOpenalex(w, "");
    return { arxiv: workArxiv(w), title: m.title, authors: m.authors, work: w, meta: m };
  });
}

/** Semantic Scholar relevance search, as {arxiv, title, authors, paper}. */
async function s2Hits(ctx, query, limit, timeout) {
  const url = "https://api.semanticscholar.org/graph/v1/paper/search?"
    + urlencode([["query", query], ["limit", String(limit)], ["fields", S2_SEARCH_FIELDS]]);
  const data = await getJson(url, ctx, 0, timeout);
  return (or(get(data, "data"), [])).filter((d) => d && typeof d === "object" && truthy(get(d, "title"))).map((d) => {
    const m = M.metaFromS2(d, "");
    return { arxiv: s2Arxiv(d), title: m.title, authors: m.authors, paper: d, meta: m };
  });
}

/** One search service's answer; a service that failed earlier in this lookup is not asked again (NetError). */
async function askSource(ctx, name, fn) {
  if (ctx.down.has(name)) throw new NetError("unreachable", `${name} failed earlier in this lookup`);
  try {
    return await fn();
  } catch (e) {
    if (isNetError(e) && e.kind !== "notfound") ctx.down.add(name);
    throw e;
  }
}

/** _arxiv_by_title: the arXiv preprint of a published paper, exact title (squashed) + first author. Python's
 * query ti:"<phrase>" (5 results) is asked of arXiv's DataCite records; OpenAlex and Semantic Scholar only when
 * DataCite can't be reached. */
export async function arxivByTitle(ctx, title, authors) {
  if (nWords(normTitle(title)) < 3) return "";
  const phrase = ws(cleanText(title).replace(/["():]/g, " "));
  const fam = authors && authors.length ? normTitle(familyOf(authors[0])) : "";
  const timeout = () => Math.min(ctx.t(), 12.0);
  const sources = [
    ["datacite", () => dataciteArxivHits(ctx, "titles.title:" + dcQuote(phrase), 5, timeout())],
    ["openalex", () => openalexHits(ctx, "title.search:" + filterText(phrase), 5, timeout())],
    ["s2", () => s2Hits(ctx, phrase, 5, timeout())],
  ];
  for (const [i, [name, source]] of sources.entries()) {
    if (i > 0 && !ctx.hasTime()) break;
    let hits;
    try {
      hits = await askSource(ctx, name, source);
    } catch (e) {
      if (!isNetError(e)) throw e;
      continue;
    }
    for (const h of hits) {
      if (!h.arxiv || squash(h.title) !== squash(title)) continue;   // "Bi 2 Se 3" (journal) == "Bi2Se3" (arXiv)
      if (fam && !h.authors.some((a) => normTitle(a.family) === fam)) continue;
      return h.arxiv;
    }
    if (i === 0 || !ctx.hasTime()) break;   // arXiv's own records answered: no match is the answer
  }
  return "";
}

/** _arxiv_close_title: for titles reworded between preprint and journal: first author plus the title's longest
 * words, accepted when most title words agree. (Python's date check never applies: _arxiv_entry_meta leaves
 * "year" None, so it is left out here too.) DataCite first; OpenAlex, then Semantic Scholar, when it fails. */
export async function arxivCloseTitle(ctx, title, authors, year = null) {
  const words = new Set(titleWords(title));
  const fam = authors && authors.length ? fold(familyOf(authors[0])) : "";
  const famN = normTitle(fam);
  if (words.size < 3 || !famN) return "";
  let best = "";
  let bestSim = 0.0;
  const last = famN.split(" ").pop();
  for (const n of [4, 2]) {
    const key = [...words].sort((x, y) => y.length - x.length).slice(0, n);
    if (!ctx.hasTime(4)) break;
    const timeout = () => Math.min(ctx.t(), 12.0);
    // Python: au:<last> AND ti:<w1> AND ti:<w2> ... (10 results)
    const sources = [
      ["datacite", () => dataciteArxivHits(ctx, `creators.name:${dcQuote(last)}` + key.map((w) => ` AND titles.title:${dcQuote(w)}`).join(""), 10, timeout())],
      ["openalex", () => openalexHits(ctx, `raw_author_name.search:${filterText(last)},title.search:${filterText(key.join(" "))}`, 10, timeout())],
      ["s2", () => s2Hits(ctx, `${last} ${key.join(" ")}`, 10, timeout())],
    ];
    let hits = null;
    for (const [i, [name, source]] of sources.entries()) {
      if (i > 0 && !ctx.hasTime(4)) break;
      try {
        hits = await askSource(ctx, name, source);
        break;
      } catch (e) {
        if (!isNetError(e)) throw e;
      }
    }
    if (hits === null) continue;
    for (const h of hits) {
      if (!h.arxiv) continue;
      if (!h.authors.some((a) => normTitle(fold(a.family || "")) === famN)) continue;
      const other = new Set(titleWords(h.title));
      let inter = 0;
      for (const w of words) if (other.has(w)) inter++;
      const union = new Set([...words, ...other]).size;
      const sim = Math.max(inter / Math.max(1, union), seqRatio(squash(title), squash(h.title)) - 0.25);
      if (sim > bestSim) {
        best = h.arxiv;
        bestSim = sim;
      }
    }
    if (bestSim >= 0.6) return best;
  }
  return "";
}

/** find_preprint(meta, timeout): arXiv id of the preprint of a published paper (exact title + first author,
 * then a close title), or "". Never throws. */
export async function findPreprint(meta, { timeout = 15 } = {}) {
  try {
    meta = meta || {};
    const title = meta.title || "";
    const authors = meta.authors || [];
    if (!title) return "";
    const ctx = new Ctx(timeout);
    return (await arxivByTitle(ctx, title, authors)) || (await arxivCloseTitle(ctx, title, authors, meta.year));
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------------------------------
// DOIs

/** _resolve_doi(ctx, doi, extra_candidates, late_candidates) */
export async function resolveDoi(ctx, doi, extraCandidates = [], lateCandidates = []) {
  const am = /^10\.48550\/arxiv\.(.+)$/i.exec(doi);
  if (am && matchArxivExact(am[1])) return resolveArxiv(ctx, matchArxivExact(am[1]));
  let meta = null;
  let source = "";
  let msg = null;
  let crNotfound = false;
  let crError = null;
  try {
    msg = await M.crossrefMessage(ctx, doi);
    meta = M.metaFromCrossref(msg, doi);
    source = "crossref";
  } catch (e) {
    if (!isNetError(e)) throw e;
    if (e.kind === "notfound") crNotfound = true;
    else crError = e;
  }
  if (meta === null && crNotfound && ctx.hasTime()) {
    try {
      meta = await M.dataciteMeta(ctx, doi);
      source = "datacite";
    } catch (e) {
      if (!isNetError(e)) throw e;
    }
  }
  let work = null;
  if (ctx.hasTime()) {
    try {
      work = await M.openalexWork(ctx, doi);
    } catch (e) {
      if (!isNetError(e)) throw e;
      if (e.kind !== "notfound" && meta !== null) {
        ctx.warn("Could not check OpenAlex for open-access PDFs (" + describe(e, "OpenAlex") + ")");
      }
    }
  }
  if (meta !== null && work !== null && !meta.title) meta.title = cleanText(or(get(work, "display_name"), get(work, "title"), ""));
  if (meta === null && work !== null) {
    meta = M.metaFromOpenalex(work, doi);
    source = "openalex";
    if (crError !== null) ctx.warn("Crossref was unavailable (" + describe(crError, "Crossref") + "); details came from OpenAlex");
  }
  if (meta === null) {
    if (crError === null) return fail(ctx, `DOI ${doi} was not found. Check it for typos.`, { source: "crossref" });
    return fail(ctx, `Could not look up DOI ${doi}: ` + describe(crError, "Crossref") + ".", { source: "crossref" });
  }
  let cands = [...extraCandidates];
  // OpenAlex's abstract is a word index with every formula dropped; the arXiv summary keeps the math
  let oaAbstract = source === "openalex" && Boolean(meta.abstract);
  if (work !== null) {
    const [oaCands, oaArxiv] = M.openalexPdfInfo(work);
    if (oaArxiv && !meta.arxiv) meta.arxiv = oaArxiv;
    cands.push(...oaCands);
  }
  await arxivAbstract(ctx, meta, oaAbstract);
  if (!meta.abstract && work !== null) {
    meta.abstract = M.openalexAbstract(work);
    oaAbstract = Boolean(meta.abstract);
  }
  if (meta.arxiv) cands.push(`https://arxiv.org/pdf/${meta.arxiv}`);
  if (msg !== null) {
    cands.push(...M.crossrefOaLinks(msg));
    const rel = or(get(msg, "relation"), {});
    for (const item of or(get(rel, "is-preprint-of"), [])) {
      if (get(item, "id-type") === "doi" && truthy(get(item, "id"))) {
        ctx.warn(`This preprint has a published version: DOI ${item.id}`);
        break;
      }
    }
  }
  cands.push(...lateCandidates);
  // Python looks for the arXiv version when there is no PDF at all; a page has none when no candidate is on a
  // host it can download from (an ACL Anthology or repository PDF, say)
  if (!cands.some((c) => isReachable(c)) && !meta.arxiv && meta.type !== "preprint" && ctx.hasTime(8)) {
    const aid = await arxivByTitle(ctx, meta.title || "", meta.authors || []);
    if (aid) {
      meta.arxiv = aid;
      cands.push(`https://arxiv.org/pdf/${aid}`);
      await arxivAbstract(ctx, meta, oaAbstract);
    }
  }
  // the journal's own PDF first (open access, or the published version), the arXiv preprint after; in a web
  // page, the PDFs it can download before those it can't
  const arx = cands.filter((c) => typeof c === "string" && c.includes("arxiv.org/pdf/"));
  const ordered = reachableFirst(dedupeUrls([...cands.filter((c) => !arx.includes(c)), ...arx]));
  if (!ordered.length) ctx.warn(NO_OA_PDF_WARNING);
  else if (ordered[0].includes("arxiv.org/pdf/") && meta.type !== "preprint") {
    ctx.warn("The PDF is the arXiv preprint; the published version may differ");
  }
  return result(ctx, true, meta, source, null, ordered);
}

// ---------------------------------------------------------------------------------------------------
// sites

/** _resolve_openreview: OpenReview's API and pages can't be read from a web page. */
export async function resolveOpenreview(ctx, oid) {
  const forum = `https://openreview.net/forum?id=${oid}`;
  const pdf = `https://openreview.net/pdf?id=${oid}`;
  const meta = emptyMeta();
  Object.assign(meta, { url: forum, venue: "OpenReview" });
  return fail(ctx, BLOCKED_SITE_MESSAGE, { meta, source: "page", pdfUrl: pdf });
}

/** _resolve_acl: the landing page can't be read from a web page, so straight to Python's fallback, the DOI
 * 10.18653/v1/<id>. Papers without such a DOI (ACL Anthology ids before 2016) only Python can read, from the
 * page: they fail with the blocked-site message. */
export async function resolveAcl(ctx, aid) {
  const pdf = `https://aclanthology.org/${aid}.pdf`;
  if (ctx.hasTime()) {
    const r = await resolveDoi(ctx, `10.18653/v1/${aid}`, [pdf]);
    if (r.ok) return r;
  }
  return fail(ctx, BLOCKED_SITE_MESSAGE, { source: "page", pdfUrl: pdf });
}

/** _resolve_europepmc(ctx, query, canonical) */
export async function resolveEuropepmc(ctx, query, canonical) {
  const url = "https://www.ebi.ac.uk/europepmc/webservices/rest/search?"
    + urlencode([["query", query], ["format", "json"], ["resultType", "core"], ["pageSize", "1"]]);
  let data;
  try {
    data = await getJson(url, ctx);
  } catch (e) {
    if (!isNetError(e)) throw e;
    return fail(ctx, "Could not look this up in Europe PMC (" + describe(e, "Europe PMC") + ").", { source: "europepmc" });
  }
  const results = or(get(or(get(or(data, {}), "resultList"), {}), "result"), []);
  if (!results.length) return fail(ctx, "Europe PMC has no record of this article.", { source: "europepmc" });
  const r0 = results[0];
  const epmc = M.europepmcPdfs(r0);
  if (truthy(get(r0, "doi"))) {
    const res = await resolveDoi(ctx, r0.doi, [], epmc);
    if (res.ok) return res;
  }
  const meta = M.metaFromEuropepmc(r0, canonical);
  if (!epmc.length) ctx.warn(NO_OA_PDF_WARNING);
  return result(ctx, true, meta, "europepmc", null, epmc);
}

/** _resolve_inspire(ctx, rid) */
export async function resolveInspire(ctx, rid) {
  let data;
  try {
    data = await getJson(`https://inspirehep.net/api/literature/${rid}`, ctx);
  } catch (e) {
    if (!isNetError(e)) throw e;
    return fail(ctx, "Could not load the INSPIRE record (" + describe(e, "INSPIRE") + ").", { source: "inspire" });
  }
  const mapped = M.metaFromInspire(data, rid);
  if (!mapped) return fail(ctx, "INSPIRE returned an empty record.", { source: "inspire" });
  const { meta, arxiv, doi } = mapped;
  let cands = arxiv ? [`https://arxiv.org/pdf/${arxiv}`] : [];
  if (!cands.length && doi && ctx.hasTime()) {
    try {
      [cands] = M.openalexPdfInfo(await M.openalexWork(ctx, doi));
    } catch (e) {
      if (!isNetError(e)) throw e;
    }
  }
  if (!cands.length) ctx.warn(NO_OA_PDF_WARNING);
  return result(ctx, true, meta, "inspire", null, cands);
}

/** _resolve_elsevier(ctx, pii, url): the DOI of a ScienceDirect article from Crossref's alternative ids. */
export async function resolveElsevier(ctx, pii, url) {
  const q = "https://api.crossref.org/works?" + urlencode([["filter", `alternative-id:${pii}`], ["rows", "2"], ["select", "DOI,title"]]);
  let items;
  try {
    items = or(get(or(get(or(await getJson(q, ctx, 2), {}), "message"), {}), "items"), []);
  } catch (e) {
    if (!isNetError(e)) throw e;
    return fail(ctx, "Could not look up this ScienceDirect article (" + describe(e, "Crossref")
      + "). Paste its DOI instead.", { source: "crossref" });
  }
  if (items.length && truthy(get(items[0], "DOI"))) return resolveDoi(ctx, items[0].DOI);
  return fail(ctx, blockedMessage(url), { source: "page" });
}

/** _resolve_s2(ctx, pid, url) */
export async function resolveS2(ctx, pid, url) {
  const api = `https://api.semanticscholar.org/graph/v1/paper/${pid}?fields=${M.S2_FIELDS}`;
  let d;
  try {
    d = await getJson(api, ctx, 1);
  } catch (e) {
    if (!isNetError(e)) throw e;
    return fail(ctx, "Could not load this Semantic Scholar paper (" + describe(e, "Semantic Scholar")
      + "). Paste its DOI or arXiv id instead.", { source: "page" });
  }
  const ext = or(get(d, "externalIds"), {});
  const late = M.s2OpenPdfs(d);
  if (truthy(get(ext, "DOI")) && !lower(M.pyStr(ext.DOI)).startsWith("10.48550/")) {
    const r = await resolveDoi(ctx, ext.DOI, [], late);
    if (r.ok) return r;
  }
  if (truthy(get(ext, "ArXiv"))) {
    const r = await resolveArxiv(ctx, M.pyStr(ext.ArXiv));
    if (r.ok) return r;
  }
  if (!truthy(get(d, "title"))) return fail(ctx, "Semantic Scholar returned no details for this paper.", { source: "page" });
  const meta = M.metaFromS2(d, url);
  if (!late.length) ctx.warn(NO_OA_PDF_WARNING);
  return result(ctx, true, meta, "page", null, late);
}

// ---------------------------------------------------------------------------------------------------
// PDF links

async function pdfResult(ctx, url, head) {
  const ids = pdfIdentifiers(head);
  if (ids.arxiv && ctx.hasTime()) {
    const r = await resolveArxiv(ctx, ids.arxiv);
    if (r.ok) {
      r.pdf_candidates = dedupeUrls([url, ...r.pdf_candidates]);
      r.pdf_url = url;
      r.warnings.push(`Identified from the PDF: arXiv ${ids.arxiv}`);
      return r;
    }
  }
  if (ids.doi && ctx.hasTime()) {
    const r = await resolveDoi(ctx, ids.doi);
    if (r.ok) {
      r.pdf_candidates = dedupeUrls([url, ...r.pdf_candidates]);
      r.pdf_url = url;
      r.warnings = r.warnings.filter((w) => w !== NO_OA_PDF_WARNING);
      r.warnings.push(`Identified from the PDF: DOI ${ids.doi}`);
      return r;
    }
  }
  const meta = emptyMeta();
  Object.assign(meta, { title: ids.title || titleFromFilename(url), url, type: "misc" });
  ctx.warn("Only the PDF was found; fill in the title, authors and year");
  return result(ctx, true, meta, "pdf", url);
}

/** _resolve_pdf(ctx, url): only PDFs on hosts a web page can read (arxiv.org/pdf, journals.aps.org/.../pdf). */
export async function resolvePdf(ctx, url) {
  if (!isReachable(url)) return fail(ctx, BLOCKED_SITE_MESSAGE, { source: "pdf" });
  let resp;
  try {
    resp = await fetchResp(url, { timeout: ctx.t(), accept: "application/pdf,*/*;q=0.8", maxBytes: 768 * 1024, retries: 0 });
  } catch (e) {
    if (!isNetError(e)) throw e;
    if (e.kind === "notfound") return fail(ctx, `That PDF link is broken (HTTP ${e.status}).`, { source: "pdf" });
    if (e.kind === "blocked") {
      return fail(ctx, `${host(url)} refused to send the PDF (HTTP ${e.status}). Download it in `
        + "your browser and attach it.", { source: "pdf" });
    }
    if (e.kind === "badurl") return fail(ctx, String(e.message), { source: "pdf" });
    ctx.warn("Could not check the PDF link (" + describe(e, host(url)) + ")");
    const meta = emptyMeta();
    Object.assign(meta, { title: titleFromFilename(url), url });
    return result(ctx, true, meta, "pdf", url);
  }
  if (isPdfBytes(resp.body)) {
    let data = resp.body;
    const ids = pdfIdentifiers(data);
    const total = Number(resp.headers && resp.headers.get ? resp.headers.get("Content-Length") : 0) || 0;
    if (!(ids.arxiv || ids.doi) && resp.truncated && total > data.length && ctx.hasTime(6)) {
      // identifiers often sit at the end (arXiv's stamp, XMP/Info updates); explicit ranges only
      const start = Math.max(data.length, total - 512 * 1024);
      try {
        const tail = await fetchResp(resp.url, { timeout: ctx.t(), accept: "application/pdf,*/*;q=0.8",
          maxBytes: 512 * 1024 + 1024, retries: 0, headers: { Range: `bytes=${start}-${total - 1}` } });
        if (tail.status === 206) {
          const joined = new Uint8Array(data.length + 1 + tail.body.length);
          joined.set(data, 0);
          joined[data.length] = 0x0a;
          joined.set(tail.body, data.length + 1);
          data = joined;
        }
      } catch (e) {
        if (!isNetError(e)) throw e;
      }
    }
    return pdfResult(ctx, resp.url, data);
  }
  return fail(ctx, "The link did not return a PDF (the server sent a web page, often a login or "
    + "paywall page). Download it in your browser and attach it.", { source: "pdf" });
}

// ---------------------------------------------------------------------------------------------------
// routing

/** _resolve_page: publisher and other web pages can't be read from a web page. */
export async function resolvePage(ctx, url) { // eslint-disable-line no-unused-vars
  return fail(ctx, BLOCKED_SITE_MESSAGE, { source: "page" });
}

/** _route_parsed(ctx, p) */
export async function routeParsed(ctx, p) {
  const { kind, site } = p;
  if (kind === "arxiv") return resolveArxiv(ctx, p.arxiv);
  if (kind === "doi") return resolveDoi(ctx, p.doi);
  if (kind === "pdf_url") return resolvePdf(ctx, p.url);
  if (kind === "url") {
    if (site === "openreview" && p.id) return resolveOpenreview(ctx, p.id);
    if (site === "acl" && p.id) return resolveAcl(ctx, p.id);
    if (site === "pmc" && p.id) return resolveEuropepmc(ctx, `PMCID:${p.id}`, p.url);
    if (site === "pubmed" && p.id) return resolveEuropepmc(ctx, `EXT_ID:${p.id} AND SRC:MED`, p.url);
    if (site === "inspire" && p.id) return resolveInspire(ctx, p.id);
    if (site === "elsevier" && p.id) return resolveElsevier(ctx, p.id, p.url);
    if (site === "s2" && p.id) return resolveS2(ctx, p.id, p.url);
    if (site === "ads" && p.id) {
      return fail(ctx, "NASA ADS pages can't be read without an ADS API token. Paste the DOI or "
        + "arXiv id shown on the ADS page instead.", { source: "page" });
    }
    return resolvePage(ctx, p.url);
  }
  return null;
}

async function resolveInner(text, timeout) {
  const ctx = new Ctx(timeout);
  const p = parseInput(text);
  let r = await routeParsed(ctx, p);
  if (r !== null) return r;
  const q = ws(cleanInput(text));
  if (nWords(q) >= 3 && Array.from(q).length <= 400 && /[A-Za-z]{3}/.test(q)) {
    const found = await searchInner(ctx, q, 6);
    const nq = normTitle(q);
    const exact = found.filter((c) => normTitle(c.title) === nq);
    if (exact.length) {
      r = await routeParsed(ctx, parseInput(exact[0].input));
      if (r !== null && r.ok) {
        r.warnings.unshift("Matched by title - check this is the right paper");
        return r;
      }
    }
    return fail(ctx, "No arXiv id, DOI or link found. Pick one of the title matches, or paste "
      + "an identifier.", { candidates: found });
  }
  return fail(ctx, "Paste an arXiv id (e.g. 2401.12345), a DOI (10.xxxx/...), or a link to the paper.");
}

/** resolve(text, {timeout}): look a paper up online. Never throws. */
export async function resolve(text, { timeout = 20 } = {}) {
  try {
    return await resolveInner(text, timeout);
  } catch (e) {
    const ctx = new Ctx(timeout);
    return fail(ctx, `Unexpected error while importing: ${(e && e.name) || "Error"}: ${(e && e.message) || e}`);
  }
}

// ---------------------------------------------------------------------------------------------------
// search()

/** _candidate(meta, ident, source) */
export function candidate(meta, ident, source) {
  const m = finalizeMeta(meta);
  return {
    input: ident, title: m.title, authors: formatAuthorsShort(m.authors), year: m.year, venue: m.venue,
    type: m.type, doi: m.doi, arxiv: m.arxiv, source,
  };
}

function arxivCandidate(h) {
  const meta = Object.assign({ ...h.meta }, ARXIV_FIXED(h.arxiv, ""));
  meta.doi = h.meta.doi || arxivDoi(h.arxiv);
  return candidate(meta, `arXiv:${h.arxiv}`, "arxiv");
}

/**
 * _search(ctx, query, limit): Python asks the arXiv API (the title phrase, then all the words when that gave
 * fewer than three) and Crossref. Here the arXiv API's queries go to arXiv's records at DataCite; only when
 * DataCite can't be reached, OpenAlex (works with an arXiv copy become "arXiv:<id>" candidates), then Semantic
 * Scholar, take its place, and works they know only by DOI come after Crossref's, so a paper both list keeps
 * Crossref's entry. Crossref is asked exactly as Python asks it. Same ranking and de-duplication as Python.
 * (A DataCite hit's journal DOI is lower-cased: DataCite's search leaves out the XML that keeps its case.)
 */
export async function searchInner(ctx, query, limit) {
  const q = Array.from(ws(query)).slice(0, 300).join("");
  if (!q) return [];
  const arxivOut = [];
  const doiOut = [];
  const phrase = ws(q.replace(/["():]/g, " "));
  const seen = new Set();
  const per = Math.min(limit, 10);
  const take = (hits, source) => {
    for (const h of hits) {
      if (h.arxiv) {
        if (!seen.has(h.arxiv)) {
          seen.add(h.arxiv);
          arxivOut.push(source === "datacite" ? candidate(h.meta, `arXiv:${h.arxiv}`, "arxiv") : arxivCandidate(h));
        }
      } else if (h.meta.doi && h.meta.title) {
        doiOut.push(candidate(h.meta, h.meta.doi, source));
      }
    }
  };
  // Python: ti:"<phrase>", then all:<w1> AND all:<w2> ... (up to 8 words of 3+ letters, no stop words)
  const words = (fold(phrase).match(/[A-Za-z0-9]{3,}/g) || []).filter((w) => !STOPWORDS.has(w.toLowerCase())).slice(0, 8);
  const queries = ["titles.title:" + dcQuote(phrase)];
  if (words.length >= 2) queries.push(words.map(dcQuote).join(" AND "));
  let arxivDown = null;
  for (const sq of queries) {
    if (arxivOut.length >= 3 || !ctx.hasTime(6)) break;
    try {
      take(await dataciteArxivHits(ctx, sq, per, ctx.t()), "datacite");
    } catch (e) {
      if (!isNetError(e)) throw e;
      arxivDown = e;
      break;
    }
  }
  if (arxivDown && ctx.hasTime(6)) {
    try {
      const url = "https://api.openalex.org/works?" + urlencode([["search", phrase], ["per-page", String(per)], ["select", OA_SELECT]]);
      const data = await getJson(url, ctx, 1);
      take((or(get(data, "results"), [])).filter((w) => w && typeof w === "object").map((w) => {
        const m = M.metaFromOpenalex(w, "");
        return { arxiv: workArxiv(w), title: m.title, authors: m.authors, meta: m };
      }), "openalex");
    } catch (e) {
      if (!isNetError(e)) throw e;
      ctx.warn("OpenAlex search unavailable (" + describe(e, "OpenAlex") + ")");
    }
    if (arxivOut.length + doiOut.length < 3 && ctx.hasTime(6)) {
      try {
        take(await s2Hits(ctx, phrase, per, ctx.t()), "s2");
      } catch (e) {
        if (!isNetError(e)) throw e;
        ctx.warn("Semantic Scholar search unavailable (" + describe(e, "Semantic Scholar") + ")");
      }
    }
    if (!arxivOut.length) ctx.warn("arXiv search unavailable (" + describe(arxivDown, "DataCite") + ")");
  }
  const crOut = [];
  if (ctx.hasTime()) {
    try {
      const url = "https://api.crossref.org/works?" + urlencode([
        ["query.bibliographic", q], ["rows", String(Math.min(2 * limit, 20))],
        ["select", "DOI,title,subtitle,author,issued,container-title,type,publisher,posted"]]);
      const items = or(get(or(get(or(await getJson(url, ctx, 2), {}), "message"), {}), "items"), []);
      for (const it of items) {
        if (["peer-review", "component", "grant", "other", "journal-issue"].includes(get(it, "type"))) continue;
        if (truthy(get(it, "DOI")) && truthy(get(it, "title"))) crOut.push(candidate(M.metaFromCrossref(it, it.DOI), it.DOI, "crossref"));
      }
    } catch (e) {
      if (!isNetError(e)) throw e;
      ctx.warn("Crossref search unavailable (" + describe(e, "Crossref") + ")");
    }
  }
  const out = [...arxivOut, ...crOut, ...doiOut];
  const nqt = normTitle(q);
  const nq = new Set(nqt ? nqt.split(" ") : []);
  const scored = out.map((c) => {
    const t = normTitle(c.title);
    const words = new Set(t ? t.split(" ") : []);
    let inter = 0;
    for (const w of words) if (nq.has(w)) inter++;
    const union = new Set([...words, ...nq]).size;
    return { c, exact: t === nqt ? 1 : 0, overlap: inter / Math.max(1, union) };
  });
  scored.sort((a, b) => (b.exact - a.exact) || (b.overlap - a.overlap));
  const seenTitles = new Set();
  const ranked = [];
  for (const { c } of scored) {
    const k = normTitle(c.title);
    if (k && !seenTitles.has(k)) {
      seenTitles.add(k);
      ranked.push(c);
    }
  }
  return ranked.slice(0, limit);
}

/** search(query, limit, {timeout}): title/keyword search. Never throws. */
export async function search(query, limit = 8, { timeout = 20 } = {}) {
  const ctx = new Ctx(timeout);
  try {
    // int(limit or 8): whole numbers (or strings of one); anything else fails with Python's ValueError text
    const raw = limit || 8;
    const n = typeof raw === "string" ? (/^\s*[+-]?\d+\s*$/.test(raw) ? Number(raw) : NaN) : Math.trunc(Number(raw));
    if (!Number.isFinite(n)) {
      const e = new Error(`invalid literal for int() with base 10: '${raw}'`);
      e.name = "ValueError";
      throw e;
    }
    const res = await searchInner(ctx, query, Math.max(1, n));
    return { ok: true, error: null, results: res, warnings: ctx.warnings };
  } catch (e) {
    return { ok: false, error: `Search failed: ${(e && e.name) || "Error"}: ${(e && e.message) || e}`, results: [],
      warnings: ctx.warnings };
  }
}

// ---------------------------------------------------------------------------------------------------
// downloadPdf()

/** download_pdf's message for an HTTP error status. */
function httpErrorMessage(code, finalUrl) {
  if (code === 404 || code === 410) return `The PDF link is broken (HTTP ${code}).`;
  if (code === 401 || code === 403) {
    return `${host(finalUrl)} refused the download (HTTP ${code}). Download the PDF in your browser and attach it.`;
  }
  if (code === 429) return "The server is rate-limiting downloads; try again in a minute.";
  return `Download failed (HTTP ${code}).`;
}

/**
 * download_pdf(url, dest_path, timeout, max_bytes) for the browser: the PDF's bytes instead of a file.
 * -> {ok, error, bytes: Uint8Array | null, size, sha256, final_url, content_type}. Rejects anything that does
 * not start with %PDF (login pages, paywalls, bot checks), anything over maxBytes, and hosts a web page
 * can't download from (no request is made to those). Never throws.
 */
export async function downloadPdf(url, { timeout = 60, maxBytes = 300 * 1024 * 1024 } = {}) {
  const res = { ok: false, error: null, bytes: null, size: 0, sha256: "", final_url: "", content_type: "" };
  try {
    url = ws(url);
    const parts = splitUrl(url);
    if (!parts || !["http:", "https:"].includes(parts.protocol) || !parts.hostname) {
      res.error = "Not a web link to a PDF.";
      return res;
    }
    const h = parts.hostname.toLowerCase();
    if (h.endsWith("arxiv.org") && parts.protocol === "http:") url = "https" + url.slice(4);
    if (h.endsWith("arxiv.org")) url = url.replace(/(arxiv\.org)\/abs\//, "$1/pdf/");
    let t = Number(timeout || 60);
    t = Number.isFinite(t) ? Math.max(5.0, t) : 60.0;
    if (!isReachable(url)) {
      res.final_url = url;
      res.error = `${host(url) || "That site"} doesn't let web pages download its PDFs. Download the PDF in `
        + "your browser and attach it.";
      return res;
    }
    const ctrl = new AbortController();
    let timedOut = false;
    let stalled = false;
    const abort = () => { timedOut = true; ctrl.abort(); };
    const connectTimer = setTimeout(abort, t * 1000);
    const deadlineTimer = setTimeout(abort, Math.max(t * 10, 120) * 1000);
    // like the socket timeout Python's reads have: no data for `t` seconds ends the download
    let stallTimer = null;
    const armStall = () => {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => { stalled = true; ctrl.abort(); }, t * 1000);
    };
    try {
      let r;
      try {
        r = await netFetch(url, {
          method: "GET", headers: { Accept: "application/pdf,*/*;q=0.8" }, credentials: "omit",
          referrerPolicy: "no-referrer", mode: "cors", redirect: "follow", signal: ctrl.signal,
        });
      } catch (e) {
        clearTimeout(connectTimer);
        // a refused fetch: the HTTP error Python would have seen (an arXiv 404, an APS 403), or no answer at all
        const err = await explainFetchError(e, url, { timedOut, timeout: t });
        if (err.status) {
          res.final_url = url;
          res.error = httpErrorMessage(err.status, url);
          return res;
        }
        res.error = "Download failed: " + describe(err, host(url) || "the server") + ".";
        return res;
      } finally {
        clearTimeout(connectTimer);
      }
      res.final_url = r.url || url;
      if (r.status >= 400) {
        try { await r.body?.cancel(); } catch { /* ignore */ }
        res.error = httpErrorMessage(r.status, res.final_url);
        return res;
      }
      res.content_type = contentTypeOf(r.headers);
      const clenRaw = r.headers.get("Content-Length");
      const clen = clenRaw != null && /^\s*\d+\s*$/.test(clenRaw) ? Number(clenRaw) : -1;
      if (clen > maxBytes) {
        try { await r.body?.cancel(); } catch { /* ignore */ }
        res.error = `The PDF is larger than the ${humanSize(maxBytes)} limit.`;
        return res;
      }
      const reader = r.body.getReader();
      const chunks = [];
      let total = 0;
      let head = new Uint8Array(0);
      let checked = false;
      for (;;) {
        let step;
        armStall();
        try {
          step = await reader.read();
        } catch (e) {
          if (timedOut) throw new NetError("timeout", "download took too long");
          if (stalled) {
            res.error = "Download failed: the server stopped responding.";
            return res;
          }
          res.error = `Download interrupted (${(e && e.name) || "Error"}); try again.`;
          return res;
        }
        if (step.done) break;
        const chunk = step.value;
        if (!checked) {
          const need = 1024 - head.length;
          const merged = new Uint8Array(head.length + Math.min(need, chunk.length));
          merged.set(head, 0);
          merged.set(chunk.subarray(0, need), head.length);
          head = merged;
          if (head.length >= 1024) {
            checked = true;
            if (!isPdfBytes(head)) {
              try { await reader.cancel(); } catch { /* ignore */ }
              res.error = notPdfMessage(head, res.final_url);
              return res;
            }
          }
        }
        total += chunk.length;
        if (total > maxBytes) {
          try { await reader.cancel(); } catch { /* ignore */ }
          res.error = `The PDF is larger than the ${humanSize(maxBytes)} limit.`;
          return res;
        }
        chunks.push(chunk);
      }
      clearTimeout(stallTimer);
      if (total === 0) {
        res.error = "The server sent an empty file.";
        return res;
      }
      if (!isPdfBytes(head)) {
        res.error = notPdfMessage(head, res.final_url);
        return res;
      }
      if (clen >= 0 && total < clen) {
        res.error = `Download incomplete (${total} of ${clen} bytes); try again.`;
        return res;
      }
      const data = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) {
        data.set(c, off);
        off += c.length;
      }
      res.sha256 = await sha256Hex(data);
      Object.assign(res, { ok: true, bytes: data, size: total });
      return res;
    } finally {
      clearTimeout(connectTimer);
      clearTimeout(deadlineTimer);
      clearTimeout(stallTimer);
    }
  } catch (e) {
    if (isNetError(e)) {
      res.error = "Download failed: " + describe(e, host(url) || "the server") + ".";
      return res;
    }
    res.error = `Download failed: ${(e && e.name) || "Error"}: ${(e && e.message) || e}`;
    return res;
  }
}
