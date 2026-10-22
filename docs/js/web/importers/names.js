// Names, dates, titles and META finalisation from importers.py (WEB_CONTRACT.md section 6.2). Pure ES
// module; results equal Python's on every input (tests/web/test_imp_pure*.mjs).
//
// Exports (Python name in brackets): fold [_fold], fixCase [_fix_case], splitName [_split_name],
// MONTHS, fmtDate [_fmt_date], parseDate [_parse_date], dateFromParts [_date_from_parts],
// normTitle [_norm_title], STR_FIELDS, TYPES, ARXIV_CAT_RE, emptyMeta [empty_meta],
// finalizeMeta [_finalize_meta], familyOf [_family_of], formatAuthorsShort [format_authors_short],
// STOPWORDS, titleWords [_title_words] (a Set), squash [_squash], PARTICLES, SUFFIXES.
// Python's None is null here; a missing date or year comes back as null.

import {
  re, ws, cleanText, pyStr, pyTruthy, pyGet, pyIter, pyInt, pyIndex, pyStrip, pyPartition, pyLower,
  pyCapitalize, pyIsUpper, pyIsLower, cpLen, cpSlice, isDict, normalize, combining,
  PyValueError, PyTypeError, PyKeyError, PyIndexError,
} from "./text.js";
import { splitArxivVersion } from "./parse.js";
import { cleanAbstract } from "./abstract.js";

const FOLD = new Map(Object.entries({
  "ß": "ss", "ø": "o", "Ø": "O", "æ": "ae", "Æ": "AE", "œ": "oe", "Œ": "OE",
  "ł": "l", "Ł": "L", "đ": "d", "Đ": "D", "ð": "d", "Ð": "D", "þ": "th",
  "Þ": "Th", "ı": "i", "ħ": "h", "ŋ": "ng",
}));

// _fold(s): ASCII-ish folding (translate table, NFKD, combining marks dropped)
export function fold(s) {
  let t = "";
  for (const ch of pyStr(pyTruthy(s) ? s : "")) t += FOLD.get(ch) ?? ch;
  t = normalize("NFKD", t);
  let out = "";
  for (const ch of t) if (!combining(ch.codePointAt(0))) out += ch;
  return out;
}

export const PARTICLES = new Set(["van", "von", "der", "den", "de", "del", "della", "degli", "di", "da",
  "du", "dos", "das", "do", "le", "la", "ter", "ten", "zu", "zur", "af",
  "av", "bin", "ibn", "al", "el", "y"]);
export const SUFFIXES = new Set(["jr", "jr.", "sr", "sr.", "ii", "iii", "iv"]);

// _fix_case(name): "MORIMOTO" -> "Morimoto"; initials and short tokens left alone
export function fixCase(name) {
  if (cpLen(name) > 3 && pyIsUpper(name)) {
    return name.split(" ").map((w) => (cpLen(w) > 2 ? pyCapitalize(w) : w)).join(" ");
  }
  return name;
}

// _split_name(name): "Last, First" or "First Middle Last" -> {given, family} or null
export function splitName(name) {
  name = pyTruthy(name) ? ws(cleanText(name)) : "";
  name = pyStrip(name, " ,;");
  if (!name) return null;
  if (name.includes(",")) {
    let [family, , given] = pyPartition(name, ",");
    given = pyStrip(given, " ,");
    if (SUFFIXES.has(pyLower(given)) && given.includes(",")) {
      let suffix;
      [suffix, , given] = pyPartition(given, ",");
      family = pyStrip(`${family} ${suffix}`);
    }
    return { given: fixCase(pyStrip(given)), family: fixCase(pyStrip(family)) };
  }
  const toks = name.split(" ");
  if (toks.length === 1) return { given: "", family: fixCase(toks[0]) };
  let suffix = "";
  if (toks.length > 2 && SUFFIXES.has(pyLower(toks[toks.length - 1]))) suffix = toks.pop();
  let i = toks.length - 1;
  while (i - 1 > 0 && PARTICLES.has(pyLower(toks[i - 1])) && pyIsLower(cpSlice(toks[i - 1], 0, 1))) i--;
  let given = toks.slice(0, i).join(" "), family = toks.slice(i).join(" ");
  if (suffix) family = `${family} ${suffix}`;
  return { given: fixCase(given), family: fixCase(family) };
}

export const MONTHS = Object.fromEntries(
  ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].map((m, i) => [m, i + 1]));

const isNoneOrEmpty = (v) => v === null || v === undefined || v === "";
const pad = (n, w) => String(n).padStart(w, "0");

function intOrThrow(v) {   // int(v), letting OverflowError through like Python
  return pyInt(v);
}

// _fmt_date(y, mo, d): "YYYY", "YYYY-MM" or "YYYY-MM-DD", or null
export function fmtDate(y, mo = null, d = null) {
  try {
    y = intOrThrow(y);
  } catch (e) {
    if (e instanceof PyTypeError || e instanceof PyValueError) return null;
    throw e;
  }
  if (!(y >= 1000 && y <= 2999)) return null;
  try {
    mo = !isNoneOrEmpty(mo) ? intOrThrow(mo) : null;
    d = !isNoneOrEmpty(d) ? intOrThrow(d) : null;
  } catch (e) {
    if (!(e instanceof PyTypeError || e instanceof PyValueError)) throw e;
    mo = d = null;
  }
  if (mo === null || !(mo >= 1 && mo <= 12)) return pad(y, 4);
  if (d === null || !(d >= 1 && d <= 31)) return `${pad(y, 4)}-${pad(mo, 2)}`;
  return `${pad(y, 4)}-${pad(mo, 2)}-${pad(d, 2)}`;
}

const D = {
  lead: re(String.raw`^(\d{4})(?:[-/.](\d{1,2})(?:[-/.](\d{1,2}))?)?(?!\d)`),
  letter: re(String.raw`[A-Za-z]`),
  year: re(String.raw`(?<!\d)(1[5-9]\d\d|2[0-2]\d\d)(?!\d)`),
  month: re(String.raw`\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?`, "I"),
  day: re(String.raw`(?<!\d)(\d{1,2})(?:st|nd|rd|th)?(?!\d)`),
};

const isPyInt = (v) => typeof v === "boolean" || (typeof v === "number" && Number.isInteger(v));

// _parse_date(s): "2017/06/12", "2019/6", "2021 Jul 15", "2016-07-07T..", "July 2016" ...
export function parseDate(s) {
  if (s === null || s === undefined) return null;
  if (isPyInt(s)) return fmtDate(s);
  s = ws(s);
  if (!s) return null;
  const m = D.lead.match(s);
  if (m && (m.group(2) || !D.letter.search(cpSlice(s, 4)))) return fmtDate(m.group(1), m.group(2), m.group(3));
  const ym = D.year.search(s);
  if (!ym) return null;
  const mm = D.month.search(s);
  let mo = null;
  if (mm) {
    const key = pyLower(mm.group(1));
    if (!Object.prototype.hasOwnProperty.call(MONTHS, key)) throw new PyKeyError(`'${key}'`);
    mo = MONTHS[key];
  }
  let d = null;
  if (mo) {
    const rest = s.slice(0, ym.index) + " " + s.slice(ym.index + ym.m[0].length);
    const dm = D.day.search(rest);
    d = dm ? dm.group(1) : null;
  }
  return fmtDate(ym.group(1), mo, d);
}

// _date_from_parts(obj): Crossref {"date-parts": [[y, m, d]]} -> date string or null
export function dateFromParts(obj) {
  try {
    const o = pyTruthy(obj) ? obj : {};
    if (!isDict(o)) return null;                            // AttributeError: no .get
    let parts = pyGet(o, "date-parts");
    if (!pyTruthy(parts)) parts = [];
    const p = pyTruthy(parts) ? pyIndex(parts, 0) : [];
    if (!pyTruthy(p) || pyIndex(p, 0) === null) return null;
    const args = [...pyIter(p), null, null].slice(0, 3);
    return fmtDate(...args);
  } catch (e) {
    if (e instanceof PyTypeError || e instanceof PyValueError || e instanceof PyIndexError) return null;
    throw e;
  }
}

const AZ09 = re("[a-z0-9]+");

// _norm_title(s): lowercase ASCII words joined by single spaces
export function normTitle(s) {
  return AZ09.findall(pyLower(fold(cleanText(s)))).join(" ");
}

// ---------------------------------------------------------------------------------------------------
// META

export const STR_FIELDS = ["title", "venue", "volume", "issue", "pages", "doi", "arxiv",
  "arxiv_version", "abstract", "url", "publisher", "type", "journal_ref"];
export const TYPES = new Set(["article", "preprint", "inproceedings", "book", "thesis", "misc"]);
export const ARXIV_CAT_RE = re(String.raw`^[a-z\-]+(?:\.[A-Za-z\-]+)?$`);

export function emptyMeta() {
  return {
    title: "", authors: [], year: null, date: null, venue: "",
    volume: "", issue: "", pages: "", doi: "", arxiv: "",
    arxiv_version: "", abstract: "", url: "", publisher: "",
    type: "misc", categories: [], journal_ref: "",
  };
}

const M = {
  date: re(String.raw`\d{4}(?:-\d{2}(?:-\d{2})?)?`),
  pages: re(String.raw`\s*[\-‐-―]+\s*`),
  doi: re(String.raw`^(?:https?://(?:dx\.)?doi\.org/|doi:\s*)`, "I"),
};

const getOr = (o, k) => (o[k] === undefined ? null : o[k]);

// _finalize_meta(m): a META dict with every field present and normalised (never throws on odd values
// where Python doesn't)
export function finalizeMeta(m) {
  const out = emptyMeta();
  if (isDict(m)) {
    for (const k of Object.keys(m)) if (!k.startsWith("_")) out[k] = m[k];
  }
  for (const k of STR_FIELDS) {
    const v = getOr(out, k);
    if (v === null) out[k] = "";
    else if (k === "abstract") out[k] = cleanAbstract(v);
    else out[k] = ws(v);
  }
  const authors = [];
  const rawAuthors = getOr(out, "authors");
  for (const a of pyIter(pyTruthy(rawAuthors) ? rawAuthors : [])) {
    if (isDict(a)) {
      let given = ws(pyGet(a, "given")), family = ws(pyGet(a, "family"));
      if (!family && given) [family, given] = [given, ""];
      if (family) authors.push({ given, family });
    } else if (typeof a === "string") {
      const sa = splitName(a);
      if (sa) authors.push(sa);
    }
  }
  out.authors = authors;
  let d = getOr(out, "date");
  d = typeof d === "string" && M.date.fullmatch(d) ? d : parseDate(d);
  let y = getOr(out, "year");
  try {
    y = !isNoneOrEmpty(y) ? intOrThrow(y) : null;
  } catch (e) {
    if (!(e instanceof PyTypeError || e instanceof PyValueError)) throw e;
    y = null;
  }
  if (y !== null && !(y >= 1000 && y <= 2999)) y = null;
  if (d && y === null) y = pyInt(cpSlice(d, 0, 4));
  if (y !== null && !d) d = String(y);
  out.date = d;
  out.year = y;
  if (!TYPES.has(out.type)) out.type = "misc";
  const cats = [];
  const rawCats = getOr(out, "categories");
  for (let c of pyIter(pyTruthy(rawCats) ? rawCats : [])) {
    c = ws(c);
    if (c && !cats.includes(c)) cats.push(c);
  }
  out.categories = cats;
  out.pages = pyStrip(M.pages.sub("-", out.pages), "-");
  out.doi = M.doi.sub("", out.doi);
  if (out.arxiv) {
    const [base, ver] = splitArxivVersion(out.arxiv);
    out.arxiv = base;
    if (ver && !out.arxiv_version) out.arxiv_version = ver;
  }
  return out;
}

// _family_of(a)
export function familyOf(a) {
  if (isDict(a)) {
    const f = pyGet(a, "family");
    const g = pyGet(a, "given");
    return ws(pyTruthy(f) ? f : pyTruthy(g) ? g : "");
  }
  if (typeof a === "string") {
    const sa = splitName(a);
    return sa ? sa.family : "";
  }
  return "";
}

// format_authors_short(authors): "Morimoto", "Morimoto & Nagaosa", "Vaswani et al."
export function formatAuthorsShort(authors) {
  const names = pyIter(pyTruthy(authors) ? authors : []).map(familyOf).filter((n) => n);
  if (!names.length) return "";
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} & ${names[1]}`;
  return `${names[0]} et al.`;
}

export const STOPWORDS = new Set(["a", "an", "the", "on", "of", "in", "for", "to", "and", "with", "from",
  "towards", "toward"]);

// _title_words(t): set of significant title words (a Set; Python's set order is not defined either)
export function titleWords(t) {
  return new Set(normTitle(t).split(" ").filter((w) => w && cpLen(w) > 1 && !STOPWORDS.has(w)));
}

const NOT_AZ09 = re("[^a-z0-9]");

// _squash(t)
export function squash(t) {
  return NOT_AZ09.sub("", normTitle(t));
}
