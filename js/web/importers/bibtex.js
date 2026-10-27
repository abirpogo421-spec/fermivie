// citekey and BibTeX from importers.py (WEB_CONTRACT.md section 6.2). Pure ES module; results equal
// Python's on every input (tests/web/test_imp_pure*.mjs).
//
// Exports (Python name in brackets): citekey [citekey], bibtex [bibtex], bibEscapePlain [_bib_escape_plain],
// bibEscape [_bib_escape], protectCaps [_protect_caps], protectSegment [_protect_segment],
// bibName [_bib_name], MATH_RE [_MATH_RE], LATEX_CMD_RE [_LATEX_CMD_RE].
// Known limit shared with the rest of the port: a float year such as 2016.0 is the number 2016 in
// JavaScript, so it gives "2016" where Python's str(2016.0) gives "2016.0" (no Fermivie code makes one).

import {
  re, ws, cleanText, pyStr, pyTruthy, pyGet, pyIter, pyLower, pyIsUpper, pyRsplit, pyLjust, cpLen, cpSlice,
  cpChars, isDict, isUpperCp,
} from "./text.js";
import { fold, familyOf, finalizeMeta, STOPWORDS, SUFFIXES, ARXIV_CAT_RE } from "./names.js";

const K = {
  words: re("[a-z0-9]+"),
  year: re(String.raw`\d{4}`),
  cmd: re(String.raw`\\[A-Za-z]+`),
  junk: re("[^a-z0-9]"),
};

// citekey(meta): first-author family + year + first significant title word, [a-z0-9] only
export function citekey(meta) {
  const m = isDict(meta) ? meta : {};
  let fam = "";
  const authors = pyGet(m, "authors");
  for (const a of pyIter(pyTruthy(authors) ? authors : [])) {
    fam = familyOf(a);
    if (fam) break;
  }
  let words = K.words.findall(pyLower(fold(fam)));
  if (words.length > 3) words = words.filter((w) => !STOPWORDS.has(w)).slice(0, 1);
  const name = words.join("") || "anon";
  let year = pyGet(m, "year");
  const date = pyGet(m, "date");
  if (!pyTruthy(year) && typeof date === "string") year = cpSlice(date, 0, 4);
  year = K.year.fullmatch(pyStr(pyTruthy(year) ? year : "")) ? pyStr(year) : "nd";
  const titleRaw = pyGet(m, "title");
  const title = K.cmd.sub(" ", cleanText(pyTruthy(titleRaw) ? titleRaw : ""));
  const tw = K.words.findall(pyLower(fold(title))).find((w) => !STOPWORDS.has(w)) ?? "";
  return K.junk.sub("", name + year + tw);
}

export const MATH_RE = re(String.raw`(?<!\\)\$[^$\n]+?(?<!\\)\$`);
export const LATEX_CMD_RE = re(String.raw`\\(?:[A-Za-z]+|[\"'` + "`" + String.raw`^~=.])`);

const B = {
  special: re(String.raw`(?<!\\)([&%#_$])`),
  braces: re(String.raw`(?<!\\)([{}])`),
  token: re(String.raw`^([^\w]*)([\w][\w\-'.]*?)([^\w]*)$`),
  keyJunk: re(String.raw`[^A-Za-z0-9_:\-.]`),
  idJunk: re(String.raw`[\s{}]`),
};

export function bibEscapePlain(s, keepBraces) {
  s = B.special.sub(String.raw`\\\1`, s);
  if (!keepBraces) s = B.braces.sub(String.raw`\\\1`, s);
  return s;
}

// _bib_escape(s): escape & % $ # _ { } for BibTeX; inline $math$ kept verbatim; braces left alone when
// the text already contains LaTeX commands
export function bibEscape(s) {
  s = ws(s);
  const out = [];
  let pos = 0;
  const outside = MATH_RE.sub(" ", s);
  const keep = LATEX_CMD_RE.search(outside) !== null;
  for (const m of MATH_RE.finditer(s)) {
    out.push(bibEscapePlain(s.slice(pos, m.index), keep));
    out.push(m.group(0));
    pos = m.index + m.group(0).length;
  }
  out.push(bibEscapePlain(s.slice(pos), keep));
  return out.join("");
}

// _protect_caps(s): brace words like BERT, AlphaFold, SARS-CoV-2 so styles keep their case
export function protectCaps(s) {
  const out = [];
  let pos = 0;
  for (const m of MATH_RE.finditer(s)) {
    out.push(protectSegment(s.slice(pos, m.index)));
    out.push(m.group(0));
    pos = m.index + m.group(0).length;
  }
  out.push(protectSegment(s.slice(pos)));
  return out.join("");
}

function fixToken(tok) {
  if (!tok || tok.includes("\\") || tok.includes("{") || tok.includes("}")) return tok;
  const mm = B.token.match(tok);
  if (!mm) return tok;
  const [pre, core, post] = mm.groups();
  const rest = cpChars(core).slice(1);
  if (rest.some((c) => isUpperCp(c.codePointAt(0)))
      || (cpLen(core) === 1 && pyIsUpper(core) && core !== "A" && core !== "I")) {
    return `${pre}{${core}}${post}`;
  }
  return tok;
}

export function protectSegment(seg) {
  return seg.split(" ").map(fixToken).join(" ");
}

// _bib_name(a): "Family, Given", {Organisation Name}, "King, Jr., Martin"
export function bibName(a) {
  const fam = bibEscape(pyGet(a, "family", "")), giv = bibEscape(pyGet(a, "given", ""));
  if (!giv) return fam.includes(" ") ? `{${fam}}` : fam;
  const lastWord = pyLower(fam).split(" ").pop();
  if (SUFFIXES.has(lastWord) && fam.includes(" ")) {
    const [base, suf] = pyRsplit(fam, " ", 1);
    return `${base}, ${suf}, ${giv}`;
  }
  return `${fam}, ${giv}`;
}

// bibtex(meta, key): a clean BibTeX entry for meta under the given key
export function bibtex(meta, key) {
  const m = finalizeMeta(isDict(meta) ? meta : {});
  key = B.keyJunk.sub("", pyStr(pyTruthy(key) ? key : "")) || citekey(m);
  const typ = m.type, venue = m.venue;
  const isArxiv = Boolean(m.arxiv);
  let etype;
  if (typ === "article" && venue && pyLower(venue) !== "arxiv") etype = "article";
  else if (typ === "inproceedings" && venue) etype = "inproceedings";
  else if (typ === "book") etype = "book";
  else if (typ === "thesis") etype = "phdthesis";
  else etype = "misc";
  const fields = [];
  const add = (name, value, raw = false) => {
    value = ws(value);
    if (value) fields.push([name, raw ? value : bibEscape(value)]);
  };
  if (m.title) fields.push(["title", protectCaps(bibEscape(m.title))]);
  if (m.authors.length) fields.push(["author", m.authors.map(bibName).join(" and ")]);
  if (etype === "article") add("journal", venue);
  else if (etype === "inproceedings") add("booktitle", venue);
  else if (etype === "phdthesis") add("school", venue || m.publisher);
  else if (etype === "misc" && venue && pyLower(venue) !== "arxiv") add("howpublished", venue);
  if (etype !== "phdthesis") {
    add("volume", m.volume);
    add("number", m.issue);
    if (m.pages) fields.push(["pages", bibEscape(m.pages).replaceAll("-", "--")]);
  }
  if (m.year) fields.push(["year", String(m.year)]);
  if (etype === "book" || etype === "inproceedings") add("publisher", m.publisher);
  if (m.doi) fields.push(["doi", B.idJunk.sub("", m.doi)]);
  if (isArxiv) {
    fields.push(["eprint", m.arxiv]);
    fields.push(["archivePrefix", "arXiv"]);
    if (m.categories.length && ARXIV_CAT_RE.match(m.categories[0])) fields.push(["primaryClass", m.categories[0]]);
  }
  if (m.url) fields.push(["url", B.idJunk.sub("", m.url)]);
  const width = Math.max(...fields.map(([n]) => cpLen(n)), 9);
  const lines = [`@${etype}{${key},`];
  fields.forEach(([n, v], i) => lines.push(`  ${pyLjust(n, width)} = {${v}}` + (i < fields.length - 1 ? "," : "")));
  lines.push("}");
  return lines.join("\n") + "\n";
}
