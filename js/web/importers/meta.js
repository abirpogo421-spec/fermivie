// Metadata from the scholarly APIs a web page can read: port of importers.py's source-specific builders
// (_crossref_message, _meta_from_crossref, _crossref_oa_links, _datacite_meta, _openalex_work,
// _openalex_abstract, _arxiv_id_in_url, _openalex_pdf_info, _meta_from_openalex) plus the mappings that
// sit inside _resolve_s2, _resolve_europepmc and _resolve_inspire, split out as pure functions so they can
// be compared with Python on the same JSON. arxivMetaFromDatacite is the browser's stand-in for
// _arxiv_entry_meta (the arXiv API is not readable from a web page; arXiv deposits the same record,
// with every version, at DataCite). dataciteArxivId reads the arXiv id of a DataCite search hit;
// arxivHtmlTitleAbstract reads one version's title and abstract from its HTML rendering at arxiv.org/html
// (DataCite keeps only the latest version's).
//
// Every mapper returns the same dict Python returns (not finalized; resolve() finalizes), with the same
// keys in the same order.

import { ws, cleanText, pyLower, htmlUnescape } from "./text.js";
import { cleanAbstractMarkup } from "./abstract.js";
import { emptyMeta, splitName, fixCase, parseDate, dateFromParts, normTitle, fold } from "./names.js";
import { arxivIdInUrl, cleanDoi, arxivDoi, matchArxivExact, splitArxivVersion } from "./parse.js";
import { NetError, getJson, pyQuote } from "./net.js";
import { pyFloatRepr } from "../pyjson.js";

// ---------------------------------------------------------------------------------------------------
// Python truthiness and dict access, so `a or b` and `d.get(k, default)` read the same as in Python

export function truthy(v) {
  if (v === null || v === undefined || v === false || v === 0 || v === "" || Number.isNaN(v)) return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype) return Object.keys(v).length > 0;
  return true;
}

/** Python's `a or b or c`: the first truthy value, else the last one. */
export function or(...vals) {
  for (let i = 0; i < vals.length - 1; i++) if (truthy(vals[i])) return vals[i];
  return vals[vals.length - 1];
}

const isDict = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** dict.get(k, d) (d when the key is missing; a stored null stays null). */
export function get(o, k, d = null) {
  return isDict(o) && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : d;
}

/** str(x) for the JSON values the APIs send. */
export function pyStr(v) {
  if (v === null || v === undefined) return "None";
  if (v === true) return "True";
  if (v === false) return "False";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : pyFloatRepr(v);
  if (typeof v === "string") return v;
  return JSON.stringify(v);
}

const lower = (s) => pyLower(String(s));

export { arxivIdInUrl };   // _arxiv_id_in_url, from parse.js

// ---------------------------------------------------------------------------------------------------
// Crossref

export const CROSSREF_TYPES = {
  "journal-article": "article", "proceedings-article": "inproceedings",
  "book": "book", "monograph": "book", "edited-book": "book", "reference-book": "book",
  "book-set": "book", "dissertation": "thesis", "posted-content": "preprint",
};
export const SERIES_PREFIXES = ["lecture notes in", "communications in computer", "advances in intelligent",
  "springer proceedings", "smart innovation", "lecture notes of the"];

/** _crossref_message: the "message" of https://api.crossref.org/works/<doi>. */
export async function crossrefMessage(ctx, doi) {
  const url = "https://api.crossref.org/works/" + pyQuote(doi, "/()");
  const data = await getJson(url, ctx);
  const msg = isDict(data) ? get(data, "message") : null;
  if (!isDict(msg)) throw new NetError("http", "unexpected Crossref answer");
  return msg;
}

/** _meta_from_crossref(msg, doi_hint) */
export function metaFromCrossref(msg, doiHint = "") {
  const meta = emptyMeta();
  let title = cleanText(or(get(msg, "title"), [""])[0]);
  const sub = truthy(get(msg, "subtitle")) ? cleanText(or(get(msg, "subtitle"), [""])[0]) : "";
  if (sub && !lower(title).includes(lower(sub))) title = title ? `${title}: ${sub}` : sub;
  const people = or(get(msg, "author"), get(msg, "editor"), []);
  const authors = [];
  for (const a of people) {
    const fam = cleanText(or(get(a, "family"), get(a, "name"), ""));
    const giv = cleanText(or(get(a, "given"), ""));
    if (fam || giv) authors.push({ given: fixCase(giv), family: fam ? fixCase(or(fam, giv)) : giv });
  }
  const ctype = or(get(msg, "type"), "");
  const containers = (or(get(msg, "container-title"), [])).filter(truthy).map((c) => cleanText(c));
  let venue = "";
  if (containers.length) {
    venue = containers.length > 1 && SERIES_PREFIXES.some((p) => lower(containers[0]).startsWith(p))
      ? containers[containers.length - 1] : containers[0];
  }
  if (ctype === "posted-content" || (ctype === "dissertation" && !venue)) {
    let inst = or(get(msg, "institution"), []);
    if (isDict(inst)) inst = [inst];
    venue = or(venue, inst.length ? get(inst[0], "name", "") : "", get(msg, "group-title", ""));
  }
  let typ = get(CROSSREF_TYPES, ctype, "misc");
  if (ctype === "posted-content" && or(get(msg, "subtype"), "preprint") !== "preprint") typ = "misc";
  if (["book-chapter", "book-part", "book-section"].includes(ctype)
      && /proceedings|conference|workshop|symposium|lecture notes/i.test(containers.join(" "))) typ = "inproceedings";
  let date = null;
  for (const k of ["issued", "published-print", "published-online", "posted", "created"]) {
    date = dateFromParts(get(msg, k));
    if (date) break;
  }
  let doi = or(get(msg, "DOI"), doiHint);
  if (doiHint && doi && lower(doiHint) === lower(doi)) doi = doiHint;
  Object.assign(meta, {
    title, authors, date, venue,
    volume: pyStr(or(get(msg, "volume"), "")), issue: pyStr(or(get(msg, "issue"), "")),
    pages: pyStr(or(get(msg, "page"), get(msg, "article-number"), "")),
    doi, abstract: cleanAbstractMarkup(or(get(msg, "abstract"), "")),
    url: doi ? `https://doi.org/${doi}` : "", publisher: cleanText(or(get(msg, "publisher"), "")),
    type: typ, categories: (or(get(msg, "subject"), [])).map((s) => cleanText(s)).slice(0, 8),
  });
  return meta;
}

/** _crossref_oa_links: PDF links from Crossref that are explicitly openly licensed. */
export function crossrefOaLinks(msg) {
  const licensed = (or(get(msg, "license"), [])).some((l) => or(get(l, "URL"), "").includes("creativecommons.org"));
  if (!licensed) return [];
  const out = [];
  for (const l of or(get(msg, "link"), [])) {
    const u = or(get(l, "URL"), "");
    if (or(get(l, "content-type"), "").includes("pdf") && u.startsWith("http")
        && !/api\.elsevier\.com|harvest\.aps\.org|api\.wiley\.com|tdm/.test(u)) out.push(u);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------
// DataCite

export const DATACITE_TYPES = {
  Preprint: "preprint", JournalArticle: "article", ConferencePaper: "inproceedings",
  ConferenceProceeding: "inproceedings", Book: "book", Dissertation: "thesis",
};

function dataciteAttributes(data) {
  const a = or(get(or(get(or(data, {}), "data"), {}), "attributes"), {});
  if (!truthy(a)) throw new NetError("notfound", "DataCite has no record", { status: 404 });
  return a;
}

/** The URL _datacite_meta reads. */
export function dataciteUrl(doi) {
  return "https://api.datacite.org/dois/" + pyQuote(doi, "/()");
}

/** _datacite_meta(ctx, doi): fetch + dataciteMetaFromData. */
export async function dataciteMeta(ctx, doi) {
  return dataciteMetaFromData(await getJson(dataciteUrl(doi), ctx), doi);
}

/** The mapping half of _datacite_meta (throws NetError "notfound" for an empty record). */
export function dataciteMetaFromData(data, doi) {
  const a = dataciteAttributes(data);
  const meta = emptyMeta();
  const titles = or(get(a, "titles"), []);
  const authors = [];
  for (const c of or(get(a, "creators"), [])) {
    if (truthy(get(c, "familyName"))) {
      authors.push({ given: or(get(c, "givenName"), ""), family: c.familyName });
    } else if (truthy(get(c, "name"))) {
      authors.push(get(c, "nameType") !== "Organizational" ? splitName(c.name) : { given: "", family: c.name });
    }
  }
  let date = null;
  for (const want of ["Issued", "Submitted", "Available", "Created"]) {
    for (const d of or(get(a, "dates"), [])) {
      if (get(d, "dateType") === want && truthy(get(d, "date"))) {
        date = parseDate(d.date);
        break;
      }
    }
    if (date) break;
  }
  let publisher = or(get(a, "publisher"), "");
  if (isDict(publisher)) publisher = get(publisher, "name", "");
  const container = or(get(or(get(a, "container"), {}), "title"), "");
  const rtype = or(get(or(get(a, "types"), {}), "resourceTypeGeneral"), "");
  let abstract = "";
  for (const d of or(get(a, "descriptions"), [])) {
    if (truthy(get(d, "description")) && get(d, "descriptionType", "Abstract") === "Abstract") {
      abstract = d.description;
      break;
    }
  }
  const cats = [];
  for (const s of or(get(a, "subjects"), [])) {
    const m = /\(([a-z-]+(?:\.[A-Za-z-]+)?)\)\s*$/.exec(or(get(s, "subject"), ""));
    if (m && get(s, "subjectScheme") === "arXiv") cats.push(m[1]);
  }
  Object.assign(meta, {
    title: cleanText(titles.length ? get(titles[0], "title") : ""),
    authors: authors.filter(truthy), date: or(date, get(a, "publicationYear")),
    venue: or(container, publisher), publisher, doi: or(get(a, "doi"), doi),
    abstract: cleanAbstractMarkup(abstract), url: `https://doi.org/${doi}`,
    type: get(DATACITE_TYPES, rtype, "misc"), categories: cats,
  });
  if (lower(doi) === lower(or(get(a, "doi"), ""))) meta.doi = doi;
  return meta;
}

const ARXIV_CAT_RE = /^[a-z-]+(?:\.[A-Za-z-]+)?$/;

function b64ToText(b64) {
  try {
    const bin = atob(String(b64).replace(/\s+/g, ""));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder("utf-8").decode(bytes);
  } catch {
    return "";
  }
}

function xmlUnescape(s) {
  return s.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (m, e) => (
    e === "lt" ? "<" : e === "gt" ? ">" : e === "amp" ? "&" : e === "quot" ? '"' : e === "apos" ? "'"
      : String.fromCodePoint(e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10))));
}

/** The journal DOI arXiv deposited (relatedIdentifier IsVersionOf), with its original letter case: the JSON
 * form lower-cases DOIs, the deposited XML (attributes.xml, base64) keeps them as the authors typed them. */
export function dataciteJournalDoi(a) {
  const rel = (or(get(a, "relatedIdentifiers"), [])).filter((r) => get(r, "relationType") === "IsVersionOf"
    && lower(or(get(r, "relatedIdentifierType"), "")) === "doi" && truthy(get(r, "relatedIdentifier")));
  if (!rel.length) return "";
  let doi = String(rel[0].relatedIdentifier);
  const xml = truthy(get(a, "xml")) ? b64ToText(a.xml) : "";
  const re = /<relatedIdentifier\b([^>]*)>([^<]*)<\/relatedIdentifier>/g;
  let m;
  while ((m = re.exec(xml))) {
    const v = xmlUnescape(m[2]).trim();
    if (/relationType\s*=\s*["']IsVersionOf["']/.test(m[1]) && lower(v) === lower(doi)) {
      doi = v;
      break;
    }
  }
  return doi;
}

/**
 * arXiv metadata from arXiv's DataCite record (https://api.datacite.org/dois/10.48550/arXiv.<base>), shaped
 * exactly like _arxiv_entry_meta(entry, requested_ver): title and abstract whitespace-collapsed, authors
 * split from "Given Family" as the arXiv API writes them, date = first-version submission date, version =
 * the requested one or the latest, doi = the journal DOI if arXiv knows one, else the arXiv DOI.
 * Not available here: journal_ref (stays "").
 */
export function arxivMetaFromDatacite(data, base, requestedVer = "") {
  const a = dataciteAttributes(data);
  const meta = emptyMeta();
  const titles = or(get(a, "titles"), []);
  let abstract = "";
  for (const d of or(get(a, "descriptions"), [])) {
    if (truthy(get(d, "description")) && get(d, "descriptionType", "Abstract") === "Abstract") {
      abstract = d.description;
      break;
    }
  }
  const authors = [];
  for (const c of or(get(a, "creators"), [])) {
    const given = ws(or(get(c, "givenName"), ""));
    const family = ws(or(get(c, "familyName"), ""));
    let name = "";
    if (family) name = given ? `${given} ${family}` : family;
    else if (truthy(get(c, "name"))) {
      name = String(c.name);
      const parts = name.split(",");
      if (get(c, "nameType") !== "Organizational" && parts.length === 2 && parts[1].trim()) {
        name = `${parts[1].trim()} ${parts[0].trim()}`;
      }
    }
    const sa = splitName(name);
    if (sa) authors.push(sa);
  }
  const dates = or(get(a, "dates"), []);
  const submitted = dates.filter((d) => get(d, "dateType") === "Submitted" && truthy(get(d, "date")));
  const first = submitted.find((d) => get(d, "dateInformation") === "v1")
    || submitted.slice().sort((x, y) => (String(x.date) < String(y.date) ? -1 : 1))[0];
  let date = first ? parseDate(first.date) : null;
  for (const want of ["Available", "Issued"]) {
    if (date) break;
    const d = dates.find((x) => get(x, "dateType") === want && truthy(get(x, "date")));
    if (d) date = parseDate(d.date);
  }
  let latest = "";
  const v = pyStr(or(get(a, "version"), ""));
  if (/^\d+$/.test(v)) latest = "v" + Number(v);
  for (const d of dates) {
    const m = /^v(\d+)$/.exec(or(get(d, "dateInformation"), ""));
    if (m && (!latest || Number(m[1]) > Number(latest.slice(1)))) latest = "v" + Number(m[1]);
  }
  const cats = [];
  for (const s of or(get(a, "subjects"), [])) {
    const m = /\(([a-z-]+(?:\.[A-Za-z-]+)?)\)\s*$/.exec(or(get(s, "subject"), ""));
    if (m && get(s, "subjectScheme") === "arXiv" && !cats.includes(m[1]) && ARXIV_CAT_RE.test(m[1])) cats.push(m[1]);
  }
  // The arXiv API answers per version, and the journal DOI is usually added with the last version: for an
  // older version than the latest, keep the arXiv DOI as Python would get it.
  const older = requestedVer && latest && Number(requestedVer.slice(1)) < Number(latest.slice(1));
  const jdoi = older ? "" : dataciteJournalDoi(a);
  Object.assign(meta, {
    title: ws(titles.length ? get(titles[0], "title") : ""), abstract: ws(abstract),
    venue: "arXiv", publisher: "arXiv", type: "preprint", arxiv: base,
    arxiv_version: requestedVer || latest, url: `https://arxiv.org/abs/${base}`,
  });
  meta.authors = authors;
  meta.date = date || (truthy(get(a, "publicationYear")) ? parseDate(pyStr(a.publicationYear)) : null);
  const tok = jdoi ? jdoi.split(/\s+/).filter(Boolean)[0] || "" : "";
  meta.doi = (tok ? cleanDoi(tok) : "") || arxivDoi(base);
  meta.journal_ref = "";
  meta.categories = cats;
  return meta;
}

/** The latest version number DataCite knows for an arXiv record (0 when it says nothing). */
export function dataciteLatestVersion(data) {
  const a = or(get(or(get(or(data, {}), "data"), {}), "attributes"), {});
  let n = 0;
  const v = pyStr(or(get(a, "version"), ""));
  if (/^\d+$/.test(v)) n = Number(v);
  for (const d of or(get(a, "dates"), [])) {
    const m = /^v(\d+)$/.exec(or(get(d, "dateInformation"), ""));
    if (m) n = Math.max(n, Number(m[1]));
  }
  return n;
}

/** The arXiv id (no version) of one of arXiv's DataCite records, e.g. a hit of /dois?query=prefix:10.48550 ...:
 * its "arXiv" identifier, else its arxiv.org URL, else its DOI. "" when it has none. */
export function dataciteArxivId(rec) {
  const a = or(get(or(rec, {}), "attributes"), {});
  for (const i of or(get(a, "identifiers"), [])) {
    if (lower(or(get(i, "identifierType"), "")) !== "arxiv") continue;
    const aid = matchArxivExact(pyStr(or(get(i, "identifier"), "")));
    if (aid) return splitArxivVersion(aid)[0];
  }
  const fromUrl = arxivIdInUrl(pyStr(or(get(a, "url"), "")));
  if (fromUrl) return fromUrl;
  const m = /^10\.48550\/arxiv\.(.+)$/i.exec(pyStr(or(get(a, "doi"), "")));
  const aid = m ? matchArxivExact(m[1]) : "";
  return aid ? splitArxivVersion(aid)[0] : "";
}

// arXiv's HTML renderings are made by LaTeXML: the title is <h1 class="ltx_title ltx_title_document">, the
// abstract <div class="ltx_abstract"> (a heading, then paragraphs); math is MathML whose alttext is the TeX.
const LTX_TITLE_RE = /<h1\b[^>]*\bclass\s*=\s*["'][^"']*\bltx_title_document\b[^"']*["'][^>]*>/i;
const LTX_ABSTRACT_RE = /<div\b[^>]*\bclass\s*=\s*["'][^"']*\bltx_abstract\b[^"']*["'][^>]*>/i;
const TAG_TOKEN_RE = /<!--[\s\S]*?-->|<(\/?)([A-Za-z][\w:.-]*)((?:"[^"]*"|'[^']*'|[^'">])*)>/g;
const VOID_TAGS = new Set(["br", "hr", "img", "input", "meta", "link", "wbr", "col", "area", "base", "source"]);
const BREAK_TAGS = new Set(["br", "p", "div", "li", "tr", "td", "th", "table", "h1", "h2", "h3", "h4", "h5", "h6"]);
// left out: notes and footnote marks (\thanks), headings ("Abstract"), equation numbers
const SKIP_CLASS_RE = /(?:^|\s)(?:ltx_note|ltx_pubnote|ltx_author_notes|ltx_title|ltx_tag)[\w-]*(?:\s|$)/;
// citations (\cite) are left out of an abstract: arXiv's own abstract is plain text typed into a form, without them
const CITE_CLASS_RE = /(?:^|\s)ltx_cite(?:\s|$)/;
const CITE_MARK = "\u0000";
const LTX_AUTHORS_RE = /<div\b[^>]*\bclass\s*=\s*["'][^"']*\bltx_authors\b[^"']*["'][^>]*>/i;
const PERSONNAME_RE = /<span\b[^>]*\bclass\s*=\s*["'][^"']*\bltx_personname\b[^"']*["'][^>]*>/gi;

function attrOf(attrs, name) {
  const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i").exec(attrs || "");
  return m ? (m[1] ?? m[2] ?? m[3]) : null;
}

/** The inner HTML of the first element matching openRe (an opening <name ...> tag), or null when absent or cut off. */
function elementInner(html, openRe, name) {
  const m = openRe.exec(html);
  if (!m) return null;
  const start = m.index + m[0].length;
  const re = new RegExp(`<(/?)${name}\\b[^>]*>`, "gi");
  re.lastIndex = start;
  let depth = 1;
  let t;
  while ((t = re.exec(html))) {
    depth += t[1] ? -1 : 1;
    if (depth === 0) return html.slice(start, t.index);
  }
  return null;
}

/** LaTeXML markup -> text: math as $TeX$ (its alttext), notes and headings left out, entities decoded,
 * whitespace collapsed. dropCites: citations left out too, with the space or brackets they leave behind. */
function ltxText(html, { dropCites = false } = {}) {
  let out = "";
  let skip = 0;
  const stack = [];
  let last = 0;
  TAG_TOKEN_RE.lastIndex = 0;
  let m;
  while ((m = TAG_TOKEN_RE.exec(html))) {
    if (!skip) out += html.slice(last, m.index);
    last = m.index + m[0].length;
    if (!m[2]) continue;   // a comment
    const name = m[2].toLowerCase();
    const attrs = m[3] || "";
    if (m[1]) {
      const at = stack.map((e) => e.name).lastIndexOf(name);
      if (at >= 0) for (const e of stack.splice(at)) if (e.skips) skip--;
      if (BREAK_TAGS.has(name)) out += " ";
      continue;
    }
    if (BREAK_TAGS.has(name)) out += " ";
    let skips = false;
    if (name === "math") {
      const alt = attrOf(attrs, "alttext");
      if (!skip && alt !== null) out += attrOf(attrs, "display") === "block" ? ` $$${alt}$$ ` : `$${alt}$`;
      skips = true;
    } else if (SKIP_CLASS_RE.test(attrOf(attrs, "class") || "")) {
      skips = true;
    } else if (dropCites && name === "cite" && CITE_CLASS_RE.test(attrOf(attrs, "class") || "")) {
      if (!skip) out += CITE_MARK;
      skips = true;
    }
    if (VOID_TAGS.has(name) || /\/\s*$/.test(attrs)) continue;
    stack.push({ name, skips });
    if (skips) skip++;
  }
  if (!skip) out += html.slice(last);
  if (!dropCites) return ws(htmlUnescape(out));
  const t = ws(htmlUnescape(out).replace(/[([]\s*(?:\u0000[\s,;]*)+[)\]]/g, CITE_MARK));
  return ws(t.replace(/\s*\u0000\s*(?=[,.;:!?)\]]|$)/g, "").replace(/\u0000/g, " "));
}

/** A rendering's ltx_personname (inner HTML) -> the names in it: the first line only (affiliations and
 * addresses follow a line break), marks and notes left out, split at commas and "and". */
function personNames(inner) {
  const firstLine = inner.split(/<br\b[^>]*>/i)[0].replace(/<sup\b[^>]*>[\s\S]*?<\/sup>/gi, " ");
  const out = [];
  for (let part of ltxText(firstLine).split(/\s*(?:,|;|&|\band\b)\s*/i)) {
    part = ws(part.replace(/[*\u2020\u2021\u00a7\u00b6\u2016#0-9]+/g, " "));
    const words = part ? part.split(" ") : [];
    if (words.length < 2 || words.length > 5 || /[@:/()\[\]]/.test(part)) continue;
    const a = splitName(part);
    if (a) out.push(a);
  }
  return out;
}

/** {title, abstract} of an arXiv HTML rendering (https://arxiv.org/html/<id>v<n>); "" for a part not found.
 * The abstract leaves out citations (arXiv's abstract is plain text without them). */
export function arxivHtmlTitleAbstract(html) {
  const text = String(html || "");
  const t = elementInner(text, LTX_TITLE_RE, "h1");
  const a = elementInner(text, LTX_ABSTRACT_RE, "div");
  return { title: t === null ? "" : ltxText(t), abstract: a === null ? "" : ltxText(a, { dropCites: true }) };
}

/** A rendering's author block: {words (normTitle words of the names, notes and affiliations left out), authors
 * (names read from it, splitName dicts)}; null when it has none. */
export function arxivHtmlAuthors(html) {
  const text = String(html || "");
  const block = elementInner(text, LTX_AUTHORS_RE, "div");
  if (block === null) return null;
  const authors = [];
  PERSONNAME_RE.lastIndex = 0;
  let m;
  while ((m = PERSONNAME_RE.exec(block))) {
    const inner = elementInner(block.slice(m.index), /<span\b[^>]*>/i, "span");
    if (inner !== null) authors.push(...personNames(inner));
  }
  return { words: normTitle(ltxText(block.replace(/<sup\b[^>]*>[\s\S]*?<\/sup>/gi, " "))).split(" ").filter(Boolean), authors };
}

/** Is the author a ({given, family}) named in a rendering's author words (arxivHtmlAuthors)? The family name's
 * words, with the given name (or its initial) just before them; middle initials may come in between. */
export function namedIn(a, words) {
  const fam = normTitle(fold((a && a.family) || "")).split(" ").filter(Boolean);
  const giv = normTitle(fold((a && a.given) || "")).split(" ").filter(Boolean);
  if (!fam.length) return false;
  for (let i = 0; i + fam.length <= words.length; i++) {
    if (!fam.every((w, k) => words[i + k] === w)) continue;
    if (!giv.length) return true;
    let j = i - 1;
    while (j >= 0 && words[j].length === 1 && !(giv[0].length === 1 && words[j] === giv[0])) j--;
    if (j < 0) continue;
    const g = words[j];
    if (g === giv[0] || (g.length === 1 && g === giv[0][0]) || (giv[0].length === 1 && g[0] === giv[0])) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------------------------------
// OpenAlex

/** The URL _openalex_work reads. */
export function openalexUrl(doi) {
  return "https://api.openalex.org/works/doi:" + pyQuote(doi, "/()");
}

/** _openalex_work(ctx, doi) */
export async function openalexWork(ctx, doi) {
  const data = await getJson(openalexUrl(doi), ctx);
  if (!isDict(data) || !truthy(get(data, "id"))) throw new NetError("notfound", "OpenAlex has no record", { status: 404 });
  return data;
}

/** _openalex_abstract(work): the abstract rebuilt from OpenAlex's inverted word index. */
export function openalexAbstract(work) {
  const inv = or(get(work, "abstract_inverted_index"), {});
  if (!isDict(inv) || !truthy(inv)) return "";
  const pos = new Map();
  for (const [word, idxs] of Object.entries(inv)) {
    for (const i of or(idxs, [])) if (Number.isInteger(i)) pos.set(i, word);
  }
  return ws([...pos.keys()].sort((x, y) => x - y).map((i) => pos.get(i)).join(" "));
}

/** _openalex_pdf_info(work) -> [pdf candidates (arXiv ones as arxiv.org/pdf/<id>, first), first arXiv id]. */
export function openalexPdfInfo(work) {
  const best = or(get(work, "best_oa_location"), {});
  const locs = [best, ...(or(get(work, "locations"), [])).filter(truthy)];
  const arx = [];
  const others = [];
  let firstArxiv = "";
  for (const loc of locs) {
    const pdf = or(get(loc, "pdf_url"), "");
    const aid = or(arxivIdInUrl(pdf), arxivIdInUrl(or(get(loc, "landing_page_url"), "")),
      arxivIdInUrl(or(get(loc, "doi"), "")));
    if (aid && !firstArxiv) firstArxiv = aid;
    if (pdf.startsWith("http")) {
      if (aid) arx.push(`https://arxiv.org/pdf/${aid}`);
      else others.push(pdf);
    }
  }
  const oaUrl = or(get(or(get(work, "open_access"), {}), "oa_url"), "");
  if (lower(oaUrl).endsWith(".pdf") && !others.includes(oaUrl)) others.push(oaUrl);
  return [[...arx, ...others], firstArxiv];
}

export const OPENALEX_TYPES = {
  article: "article", preprint: "preprint", book: "book", dissertation: "thesis", "book-chapter": "misc",
};

/** _meta_from_openalex(work, doi_hint) */
export function metaFromOpenalex(work, doiHint = "") {
  const meta = emptyMeta();
  const loc = or(get(work, "primary_location"), {});
  const src = or(get(loc, "source"), {});
  const biblio = or(get(work, "biblio"), {});
  const fp = or(get(biblio, "first_page"), "");
  const lp = or(get(biblio, "last_page"), "");
  let typ = or(get(CROSSREF_TYPES, or(get(work, "type_crossref"), ""), ""), get(OPENALEX_TYPES, or(get(work, "type"), ""), "misc"));
  if (typ === "article" && get(src, "type") === "conference") typ = "inproceedings";
  if (typ === "article" && get(src, "type") === "repository") typ = "preprint";
  let doi = or(String(or(get(work, "doi"), "")).replace(/^https?:\/\/doi\.org\//i, ""), doiHint);
  if (doiHint && lower(doi) === lower(doiHint)) doi = doiHint;
  Object.assign(meta, {
    title: cleanText(or(get(work, "display_name"), get(work, "title"), "")),
    authors: (or(get(work, "authorships"), [])).map((x) => splitName(or(get(x, "raw_author_name"),
      get(or(get(x, "author"), {}), "display_name")))).filter(truthy),
    date: or(get(work, "publication_date"), get(work, "publication_year")),
    venue: cleanText(or(get(src, "display_name"), "")), volume: pyStr(or(get(biblio, "volume"), "")),
    issue: pyStr(or(get(biblio, "issue"), "")), pages: fp + (lp && lp !== fp ? `-${lp}` : ""),
    doi, abstract: openalexAbstract(work), url: doi ? `https://doi.org/${doi}` : "",
    publisher: cleanText(or(get(src, "host_organization_name"), "")), type: typ,
  });
  return meta;
}

// ---------------------------------------------------------------------------------------------------
// Semantic Scholar, Europe PMC, INSPIRE (the mapping parts of _resolve_s2, _resolve_europepmc, _resolve_inspire)

export const S2_FIELDS = "externalIds,title,authors,year,venue,abstract,openAccessPdf,publicationDate,journal,publicationTypes";

/** The open-access PDF Semantic Scholar lists (_resolve_s2's `late`). */
export function s2OpenPdfs(d) {
  const oa = or(get(or(get(d, "openAccessPdf"), {}), "url"), "");
  return String(oa).startsWith("http") ? [oa] : [];
}

/** _resolve_s2's own META when neither the DOI nor the arXiv id resolves. */
export function metaFromS2(d, url) {
  const j = or(get(d, "journal"), {});
  const types = or(get(d, "publicationTypes"), []);
  const meta = emptyMeta();
  Object.assign(meta, {
    title: cleanText(d.title),
    authors: (or(get(d, "authors"), [])).map((x) => splitName(get(x, "name"))).filter(truthy),
    date: or(get(d, "publicationDate"), get(d, "year")), venue: or(get(j, "name"), get(d, "venue"), ""),
    volume: pyStr(or(get(j, "volume"), "")), pages: ws(or(get(j, "pages"), "")),
    abstract: cleanAbstractMarkup(or(get(d, "abstract"), "")), url,
    type: types.includes("JournalArticle") ? "article" : types.includes("Conference") ? "inproceedings" : "misc",
  });
  return meta;
}

/** Europe PMC's open PDF links for a search result (_resolve_europepmc's `epmc`). */
export function europepmcPdfs(r0) {
  const out = [];
  for (const u of or(get(or(get(r0, "fullTextUrlList"), {}), "fullTextUrl"), [])) {
    if (get(u, "documentStyle") === "pdf" && ["OA", "F"].includes(get(u, "availabilityCode")) && truthy(get(u, "url"))) out.push(u.url);
  }
  return out;
}

/** _resolve_europepmc's own META (used when the record has no DOI, or the DOI does not resolve). */
export function metaFromEuropepmc(r0, canonical) {
  const meta = emptyMeta();
  const j = or(get(r0, "journalInfo"), {});
  const authors = [];
  for (const a of or(get(or(get(r0, "authorList"), {}), "author"), [])) {
    if (truthy(get(a, "lastName"))) authors.push({ given: or(get(a, "firstName"), get(a, "initials"), ""), family: a.lastName });
    else if (truthy(get(a, "collectiveName"))) authors.push({ given: "", family: a.collectiveName });
  }
  Object.assign(meta, {
    title: cleanText(or(get(r0, "title"), "")).replace(/\.+$/, ""), authors,
    date: or(get(r0, "firstPublicationDate"), get(r0, "pubYear")),
    venue: or(get(or(get(j, "journal"), {}), "title"), ""), volume: or(get(j, "volume"), ""),
    issue: or(get(j, "issue"), ""), pages: or(get(r0, "pageInfo"), ""), doi: or(get(r0, "doi"), ""),
    abstract: cleanAbstractMarkup(or(get(r0, "abstractText"), "")), url: canonical, type: "article",
  });
  return meta;
}

/** _resolve_inspire's mapping: {meta, arxiv, doi} from an INSPIRE literature record, or null when the record
 * has no title ("INSPIRE returned an empty record."). */
export function metaFromInspire(data, rid) {
  const m = or(get(or(data, {}), "metadata"), {});
  if (!truthy(get(m, "titles"))) return null;
  const pubs = or(get(m, "publication_info"), []);
  const pub = pubs.find((p) => get(p, "material") === "publication" && truthy(get(p, "journal_title")))
    || pubs.find((p) => truthy(get(p, "journal_title")) && !["erratum", "reprint"].includes(get(p, "material")))
    || pubs.find((p) => truthy(get(p, "journal_title"))) || {};
  const dois = or(get(m, "dois"), []);
  const pubDoi = dois.find((d) => get(d, "material") === "publication");
  const doi = or(pubDoi ? pubDoi.value : "", dois.length ? dois[0].value : "");
  const eprints = or(get(m, "arxiv_eprints"), []);
  const arxiv = eprints.length ? get(eprints[0], "value", "") : "";
  const doc = (or(get(m, "document_type"), [])).join(" ");
  let typ;
  if (truthy(get(pub, "journal_title"))) typ = "article";
  else if (doc.includes("conference")) typ = "inproceedings";
  else if (doc.includes("thesis")) typ = "thesis";
  else if (doc.includes("book")) typ = "book";
  else if (arxiv) typ = "preprint";
  else typ = "misc";
  let pages = or(get(pub, "page_start"), get(pub, "artid"), "");
  if (truthy(get(pub, "page_start")) && truthy(get(pub, "page_end"))) pages = `${pyStr(pub.page_start)}-${pyStr(pub.page_end)}`;
  const date = truthy(get(pub, "year")) ? pyStr(pub.year) : or(get(m, "preprint_date"), get(m, "earliest_date"));
  const abstracts = or(get(m, "abstracts"), []);
  const meta = emptyMeta();
  Object.assign(meta, {
    title: ws(get(m.titles[0], "title", "")),
    authors: (or(get(m, "authors"), [])).map((x) => splitName(get(x, "full_name"))).filter(truthy),
    date, venue: or(get(pub, "journal_title"), typ === "preprint" ? "arXiv" : ""),
    volume: or(get(pub, "journal_volume"), ""), issue: or(get(pub, "journal_issue"), ""), pages,
    doi: or(doi, arxiv ? arxivDoi(arxiv) : ""), arxiv,
    abstract: abstracts.length ? cleanAbstractMarkup(get(abstracts[0], "value", "")) : "",
    url: `https://inspirehep.net/literature/${rid}`, type: typ,
    categories: eprints.length ? [...or(get(eprints[0], "categories"), [])] : [],
  });
  return { meta, arxiv, doi };
}
