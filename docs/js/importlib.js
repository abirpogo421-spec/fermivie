// Import a whole library from another app: the folder Zotero, Mendeley, EndNote, JabRef, Paperpile, Citavi and
// others export (a .rdf, .bib, .ris, .xml or .json file next to the PDFs), or just a folder of PDFs.
// Papers, PDFs, notes, tags and collections (as projects) come across, and highlights and comments saved inside
// the PDFs become marks. It all runs in the page through `api`, so the web version and the local app do the same.
import { store } from "./store.js";
import { api } from "./api.js";
import * as ui from "./ui.js";
import * as undoLog from "./undo.js";

const { h, el } = ui;

/* ---------------------------------------------------------------- small helpers */
const clean = (s) => String(s == null ? "" : s).replace(/\s+/g, " ").trim();
const baseName = (p) => String(p).split(/[\\/]/).pop();
const normPath = (p) => String(p).replace(/\\/g, "/").replace(/^file:\/\/(localhost)?/i, "").replace(/^\/+/, "").toLowerCase();
// "M&nbsp;= Mo" in a title Zotero saved from a web page
function unentity(s) { if (!/&#?\w+;/.test(s)) return s; const t = document.createElement("textarea"); t.innerHTML = s; return clean(t.value); }
const isPdfName = (p) => /\.pdf$/i.test(String(p));
const normTitle = (s) => String(s || "").normalize("NFKD").replace(/\p{M}/gu, "").replace(/\\[a-zA-Z]+|[{}$\\]/g, " ")
  .toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const ARXIV_IN = /arxiv\.org\/(?:abs|pdf)\/([a-z-]+(?:\.[A-Z]{2})?\/\d{7}|\d{4}\.\d{4,5})|arxiv[:\s.]+(\d{4}\.\d{4,5}|[a-z-]+\/\d{7})|10\.48550\/arxiv\.(\d{4}\.\d{4,5})/i;
const DOI_IN = /\b(10\.\d{4,9}\/[^\s"<>]+)/;
function arxivOf(...strs) { for (const s of strs) { const m = ARXIV_IN.exec(s || ""); if (m) return m[1] || m[2] || m[3]; } return ""; }
function doiOf(...strs) { for (const s of strs) { const m = DOI_IN.exec(s || ""); if (m) return m[1].replace(/[.,;)\]]+$/, ""); } return ""; }

// "Family, Given", "Given Family" or {Organisation}
function person(s) {
  s = clean(s);
  if (!s) return null;
  if (/^\{.*\}$/.test(s)) return { given: "", family: s.slice(1, -1) };
  if (s.includes(",")) { const [f, ...g] = s.split(","); return { given: clean(g.join(" ")), family: clean(f) }; }
  const parts = s.split(" ");
  return parts.length === 1 ? { given: "", family: s } : { given: parts.slice(0, -1).join(" "), family: parts[parts.length - 1] };
}
const TYPE_MAP = [[/journal|article|jour|periodical/i, "article"], [/preprint|report|unpb|manuscript/i, "preprint"],
  [/conf|proceed|cpaper|inproc/i, "inproceedings"], [/thesis|phd|master/i, "thesis"], [/book|chap|incollection/i, "book"]];
const itemType = (t) => (TYPE_MAP.find(([re]) => re.test(t || "")) || [null, "misc"])[1];

// a Zotero note is HTML: keep the words, paragraphs, lists and emphasis
function htmlToText(html) {
  if (!/<[a-z!]/i.test(html || "")) return String(html || "").trim();
  const doc = new DOMParser().parseFromString(html, "text/html");
  const walk = (n) => {
    if (n.nodeType === 3) return n.nodeValue.replace(/\s+/g, " ");
    const t = (n.tagName || "").toLowerCase(), inner = [...n.childNodes].map(walk).join("");
    if (/^h[1-6]$/.test(t)) return "\n\n## " + inner.trim() + "\n\n";
    if (t === "p" || t === "div" || t === "blockquote") return "\n\n" + inner.trim() + "\n\n";
    if (t === "br") return "\n";
    if (t === "li") return "\n- " + inner.trim();
    if (t === "b" || t === "strong") return inner.trim() ? "**" + inner.trim() + "** " : "";
    if (t === "i" || t === "em") return inner.trim() ? "*" + inner.trim() + "* " : "";
    if (t === "a" && n.getAttribute("href") && !inner.includes(n.getAttribute("href"))) return inner + " (" + n.getAttribute("href") + ")";
    return inner;
  };
  return walk(doc.body).replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/* ---------------------------------------------------------------- records
   Every format is read into the same shape:
   {meta, tags, autoTags, notes: [text], files: [path as written in the export], fileLabels, collections: [id]}
   collections: Map(id -> {name, parent}) */
const record = () => ({ meta: { title: "", authors: [], year: null, date: "", venue: "", volume: "", issue: "", pages: "", doi: "", arxiv: "", url: "", publisher: "", abstract: "", type: "misc" },
  tags: [], autoTags: [], notes: [], files: [], fileLabels: {}, collections: [] });
function finish(r) {
  const m = r.meta;
  m.title = unentity(clean(m.title)); m.venue = unentity(clean(m.venue));
  if (!m.year && m.date) { const y = /\b(1[89]\d\d|20\d\d)\b/.exec(m.date); if (y) m.year = +y[1]; }
  if (m.year && !/^\d{4}/.test(m.date || "")) m.date = String(m.year);
  m.doi = (m.doi || doiOf(m.url)).replace(/^https?:\/\/(dx\.)?doi\.org\//i, "").replace(/^doi:\s*/i, "");
  if (!m.arxiv) m.arxiv = arxivOf(m.url, m.doi, ...r.files);
  if (/^10\.48550\//i.test(m.doi)) m.doi = "";
  r.tags = [...new Set(r.tags.map(clean).filter(Boolean))];
  r.autoTags = [...new Set(r.autoTags.map(clean).filter(Boolean))].filter((t) => !r.tags.includes(t));
  r.notes = r.notes.map((n) => n.trim()).filter(Boolean);
  return r;
}

/* ---------------------------------------------------------------- Zotero RDF */
const NS = { rdf: "http://www.w3.org/1999/02/22-rdf-syntax-ns#" };
function parseRdf(text) {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (doc.querySelector("parsererror")) throw new Error("The .rdf file couldn't be read.");
  const top = [...doc.documentElement.children];
  const about = (n) => n.getAttributeNS(NS.rdf, "about") || n.getAttribute("rdf:about") || "";
  const res = (n) => n.getAttributeNS(NS.rdf, "resource") || n.getAttribute("rdf:resource") || "";
  const kids = (n, name) => [...n.children].filter((c) => c.localName === name);
  const kid = (n, name) => kids(n, name)[0];
  const txt = (n, name) => { const k = kid(n, name); return k ? clean(k.textContent) : ""; };
  const byId = new Map(top.map((n) => [about(n), n]));
  const deref = (n) => (res(n) ? byId.get(res(n)) : n.firstElementChild) || null;

  const linked = new Set(), records = new Map(), collections = new Map();
  for (const n of top) for (const l of [...kids(n, "link"), ...kids(n, "isReferencedBy")]) linked.add(res(l));
  const isItem = (n) => { const t = txt(n, "itemType"); return t && t !== "attachment" && t !== "note"; };
  const pdfPath = (a) => { const p = kid(a, "path"); const path = p ? res(p) || clean(p.textContent) : ""; return path && (isPdfName(path) || txt(a, "type") === "application/pdf") ? path : ""; };

  for (const n of top) {
    const id = about(n);
    if (isItem(n)) {
      const r = record(), m = r.meta;
      m.type = itemType(txt(n, "itemType"));
      m.title = txt(n, "title");
      m.date = txt(n, "date");
      m.abstract = txt(n, "abstract");
      m.pages = txt(n, "pages");
      m.volume = txt(n, "volume");
      m.issue = txt(n, "number");
      const authors = kid(n, "authors");
      if (authors) for (const p of authors.querySelectorAll("*")) {
        if (p.localName === "Person") m.authors.push({ given: txt(p, "givenName"), family: txt(p, "surname") });
        else if (p.localName === "Organization" && p.parentElement.localName === "li") m.authors.push({ given: "", family: txt(p, "name") });
      }
      const pub = kid(n, "publisher"); if (pub) m.publisher = clean(pub.textContent);
      const ids = [];
      const readIds = (x) => {
        for (const d of kids(x, "identifier")) {
          const uri = d.querySelector("*");
          if (uri && uri.localName === "URI") { if (!m.url) m.url = clean(uri.textContent); }
          else ids.push(clean(d.textContent));
        }
      };
      readIds(n);
      const part = kid(n, "isPartOf"), box = part && deref(part);
      if (box) {
        m.venue = txt(box, "title");
        m.volume = m.volume || txt(box, "volume");
        m.issue = m.issue || txt(box, "number");
        readIds(box);
      }
      for (const s of ids) { const d = /^DOI\s+(.+)$/i.exec(s); if (d) m.doi = d[1]; }
      if (!m.arxiv) m.arxiv = arxivOf(m.url, ...ids, txt(n, "extra"), txt(n, "description"));
      for (const s of kids(n, "subject")) {
        const auto = s.querySelector("*");
        if (auto && auto.localName === "AutomaticTag") r.autoTags.push(auto.textContent);
        else r.tags.push(s.textContent);
      }
      for (const l of kids(n, "link")) {
        const a = byId.get(res(l)); if (!a) continue;
        const p = pdfPath(a); if (p) { r.files.push(p); r.fileLabels[p] = txt(a, "title"); }
      }
      for (const l of kids(n, "isReferencedBy")) { const memo = byId.get(res(l)); if (memo) r.notes.push(htmlToText(txt(memo, "value") && kid(memo, "value").textContent)); }
      records.set(id, finish(r));
    } else if (n.localName === "Attachment" && !linked.has(id) && pdfPath(n)) {
      // a PDF on its own in Zotero, not attached to any paper
      const r = record(), p = pdfPath(n);
      r.meta.title = txt(n, "title").replace(/\.pdf$/i, "") || baseName(p).replace(/\.pdf$/i, "");
      r.files.push(p); r.standalone = true;
      records.set(id, finish(r));
    } else if (n.localName === "Collection") collections.set(id, { name: txt(n, "title") || "Untitled", parent: null });
  }
  for (const n of top) {
    if (n.localName !== "Collection") continue;
    for (const p of kids(n, "hasPart")) {
      const target = res(p);
      if (collections.has(target)) collections.get(target).parent = about(n);
      else if (records.has(target)) records.get(target).collections.push(about(n));
    }
  }
  return { format: "Zotero RDF", source: "Zotero", records: [...records.values()], collections };
}

/* ---------------------------------------------------------------- BibTeX / BibLaTeX
   Zotero, JabRef, Mendeley, Paperpile, Citavi, Bookends, BibDesk. `file` fields differ:
   Zotero "Label:files/2/x.pdf:application/pdf;…", JabRef ":papers/x.pdf:PDF" (\: and \; escaped),
   Mendeley ":Users/me/x.pdf:pdf", Paperpile "All Papers/A/x.pdf", Bookends just "x.pdf". */
const ACCENT = { '"': "̈", "'": "́", "`": "̀", "^": "̂", "~": "̃", "=": "̄", ".": "̇",
  u: "̆", v: "̌", H: "̋", c: "̧", r: "̊", k: "̨" };
const LETTER = { ss: "ß", o: "ø", O: "Ø", aa: "å", AA: "Å", ae: "æ", AE: "Æ", oe: "œ", OE: "Œ", l: "ł", L: "Ł", i: "ı", j: "ȷ" };
function untex(s) {
  // math stays as TeX ($…$), the rest becomes plain text
  return String(s || "").split(/(\$[^$]*\$)/).map((seg, i) => i % 2 ? seg : seg
    .replace(/\\([`'^"~=.])\s*\{?\\?([a-zA-Z])\}?/g, (_, a, ch) => (ch + ACCENT[a]).normalize("NFC"))
    .replace(/\\([uvHcrk])\s*\{\\?([a-zA-Z])\}/g, (_, a, ch) => (ch + ACCENT[a]).normalize("NFC"))
    .replace(/\\(ss|aa|AA|ae|AE|oe|OE|o|O|l|L|i|j)\b\s*/g, (_, l) => LETTER[l])
    .replace(/\\(?:textit|textbf|emph|textrm|textsc|mathrm|url)\s*/g, "")
    .replace(/\\([&%_#$])/g, "$1").replace(/---/g, "—").replace(/--/g, "–").replace(/~/g, " ")
    .replace(/[{}]/g, "")).join("").replace(/\s+/g, " ").trim();
}
function bibEntries(text) {
  const out = [], comments = [];
  let i = 0;
  while ((i = text.indexOf("@", i)) !== -1) {
    const m = /^@\s*(\w+)\s*([{(])/.exec(text.slice(i, i + 64));
    if (!m) { i++; continue; }
    const open = m[2], close = open === "{" ? "}" : ")";
    let j = i + m[0].length, depth = 1, inQ = false;
    for (; j < text.length && depth; j++) {
      const ch = text[j];
      if (ch === "\\") { j++; continue; }
      if (ch === '"' && depth === 1 && open === "{") inQ = !inQ;
      else if (!inQ && (ch === "{" || (open === "(" && ch === "("))) depth++;
      else if (!inQ && (ch === close || (ch === "}" && open === "{"))) depth--;
    }
    const type = m[1].toLowerCase(), body = text.slice(i + m[0].length, j - 1);
    i = j;
    if (type === "comment") { comments.push(body); continue; }
    if (type === "string" || type === "preamble") continue;
    const comma = body.indexOf(",");
    const fields = {};
    let k = comma + 1;
    while (k < body.length) {
      const fm = /^\s*([\w:.-]+)\s*=\s*/.exec(body.slice(k));
      if (!fm) break;
      k += fm[0].length;
      let val = "";
      for (;;) {
        while (/\s/.test(body[k] || "")) k++;
        if (body[k] === "{") {
          let d = 0, s = k;
          for (; k < body.length; k++) { if (body[k] === "\\") { k++; continue; } if (body[k] === "{") d++; else if (body[k] === "}" && !--d) break; }
          val += body.slice(s + 1, k); k++;
        } else if (body[k] === '"') {
          let s = ++k;
          for (; k < body.length && body[k] !== '"'; k++) if (body[k] === "\\") k++;
          val += body.slice(s, k); k++;
        } else { const w = /^[^,#}\s]+/.exec(body.slice(k)); if (w) { val += w[0]; k += w[0].length; } }
        while (/\s/.test(body[k] || "")) k++;
        if (body[k] === "#") { k++; continue; }
        break;
      }
      fields[fm[1].toLowerCase()] = val;
      while (k < body.length && body[k] !== ",") k++;
      k++;
    }
    out.push({ type, key: clean(body.slice(0, comma)), fields });
  }
  return { entries: out, comments };
}
function splitEsc(s, sep) {
  const out = []; let cur = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\" && (s[i + 1] === sep || s[i + 1] === "\\")) { cur += s[i + 1]; i++; }
    else if (s[i] === sep) { out.push(cur); cur = ""; }
    else cur += s[i];
  }
  out.push(cur);
  return out;
}
function bibFiles(v) {
  const out = [];
  for (const part of splitEsc(v, ";")) {
    if (!part.trim()) continue;
    const bits = splitEsc(part, ":");
    let label = "", path = part;
    if (bits.length >= 3) { label = bits[0]; path = bits.slice(1, -1).join(":"); }
    else if (bits.length === 2 && !/^[a-z]$/i.test(bits[0])) { label = bits[0]; path = bits[1]; }
    path = path.replace(/\{|\}/g, "").trim();
    if (path && (isPdfName(path) || /pdf/i.test(bits[bits.length - 1] || ""))) out.push({ path, label: clean(label) });
  }
  return out;
}
// JabRef's group tree: @Comment{jabref-meta: grouping: 0 AllEntriesGroup:; 1 StaticGroup:Name\;0\;…; 2 …}
function jabrefGroups(comments) {
  const tree = new Map();
  for (const c of comments) {
    const m = /jabref-meta:\s*(?:grouping|groupstree):([\s\S]*)/.exec(c); if (!m) continue;
    const stack = [];
    for (const line of splitEsc(m[1], ";").map((s) => s.trim()).filter(Boolean)) {
      const g = /^(\d+)\s+(\w+):(.*)$/.exec(line); if (!g) continue;
      const level = +g[1], name = clean(splitEsc(g[3], ";")[0].split("\\;")[0].replace(/\\(.)/g, "$1"));
      if (!name || g[2] === "AllEntriesGroup") { stack[level] = null; continue; }
      stack[level] = name; stack.length = level + 1;
      tree.set(name, { name, parent: level > 1 ? stack[level - 1] || null : null });
    }
  }
  return tree;
}
function parseBib(text) {
  const { entries, comments } = bibEntries(text);
  const collections = jabrefGroups(comments);
  let source = /jabref-meta/.test(text) ? "JabRef" : /mendeley-(groups|tags)/.test(text) ? "Mendeley" : /Bdsk-File/.test(text) ? "BibDesk" : "";
  const records = [];
  for (const e of entries) {
    const f = e.fields, r = record(), m = r.meta, g = (...ks) => { for (const k of ks) if (f[k]) return f[k]; return ""; };
    if (!source && /^files\//.test(f.file || "")) source = "Zotero";
    m.type = itemType(e.type === "misc" && /arxiv/i.test(g("eprinttype", "archiveprefix", "journal")) ? "preprint" : e.type);
    m.title = untex(g("title"));
    m.authors = splitAnd(g("author") || g("editor")).map(untex).map(person).filter(Boolean);
    m.date = g("date") || [g("year"), monthNum(g("month"))].filter(Boolean).join("-");
    m.year = /^\d{4}$/.test(g("year")) ? +g("year") : null;
    m.venue = untex(g("journal", "journaltitle", "booktitle", "school", "institution"));
    m.volume = g("volume"); m.issue = g("number", "issue"); m.pages = g("pages").replace(/--/g, "-");
    m.doi = g("doi"); m.url = g("url"); m.publisher = untex(g("publisher"));
    m.abstract = untex(g("abstract"));
    m.arxiv = /arxiv/i.test(g("eprinttype", "archiveprefix")) || /^\d{4}\.\d{4,5}/.test(g("eprint")) ? g("eprint").replace(/^arxiv:/i, "") : arxivOf(g("arxiv", "arxivid"), m.url, g("journal"));
    for (const k of ["keywords", "mendeley-tags", "tags"]) if (f[k]) r.tags.push(...f[k].split(/[,;]/).map(untex));
    for (const k of ["groups", "mendeley-groups"]) if (f[k]) for (const name of f[k].split(",").map(clean).filter(Boolean)) {
      if (!collections.has(name)) collections.set(name, { name, parent: null });
      r.collections.push(name);
    }
    for (const k of ["annote", "annotation", "comment", "review"]) if (f[k]) r.notes.push(htmlToText(f[k].replace(/\{|\}/g, "")));
    for (const x of bibFiles(g("file", "pdf", "local-url"))) { r.files.push(x.path); r.fileLabels[x.path] = x.label; }
    records.push(finish(r));
  }
  return { format: "BibTeX", source, records, collections };
}
function splitAnd(s) {
  const out = []; let d = 0, cur = "";
  const words = String(s || "").split(/(\s+and\s+)/i);
  for (const w of words) {
    if (/^\s+and\s+$/i.test(w) && !d) { out.push(cur); cur = ""; continue; }
    for (const ch of w) d += ch === "{" ? 1 : ch === "}" ? -1 : 0;
    cur += w;
  }
  if (cur.trim()) out.push(cur);
  return out.filter((x) => x.trim() && !/^others$/i.test(x.trim()));
}
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
function monthNum(s) { const i = MONTHS.indexOf(String(s || "").slice(0, 3).toLowerCase()); return i >= 0 ? String(i + 1).padStart(2, "0") : /^\d{1,2}$/.test(s) ? s.padStart(2, "0") : ""; }

/* ---------------------------------------------------------------- RIS (EndNote, Mendeley, ReadCube, Paperpile, Zotero, Sciwheel, RefWorks) */
function parseRis(text) {
  const records = [];
  let r = null, last = "";
  for (const line of text.split(/\r?\n/)) {
    const m = /^([A-Z][A-Z0-9])  -\s?(.*)$/.exec(line);
    if (!m) { if (r && last && line.trim()) r.raw[last][r.raw[last].length - 1] += " " + line.trim(); continue; }
    const [, tag, val] = m;
    if (tag === "TY") { r = { raw: {} }; }
    if (!r) continue;
    if (tag === "ER") { records.push(risRecord(r.raw)); r = null; continue; }
    (r.raw[tag] = r.raw[tag] || []).push(val.trim()); last = tag;
  }
  return { format: "RIS", source: "", records, collections: new Map() };
}
function risRecord(x) {
  const r = record(), m = r.meta, g = (...ks) => { for (const k of ks) if (x[k] && x[k][0]) return x[k][0]; return ""; };
  m.type = itemType(g("TY")); m.title = g("TI", "T1", "CT");
  for (const k of ["AU", "A1"]) for (const a of x[k] || []) m.authors.push(person(a));
  m.authors = m.authors.filter(Boolean);
  const d = g("DA", "PY", "Y1"); m.date = d.replace(/\/+$/, "").replace(/\//g, "-");
  m.venue = g("T2", "JO", "JF", "JA", "BT"); m.volume = g("VL"); m.issue = g("IS");
  m.pages = [g("SP"), g("EP")].filter(Boolean).join("-");
  m.doi = g("DO"); m.url = g("UR"); m.abstract = g("AB", "N2"); m.publisher = g("PB");
  r.tags.push(...(x.KW || []));
  for (const n of x.N1 || []) r.notes.push(htmlToText(n));
  for (const k of ["L1", "L4", "LK"]) for (const v of x[k] || []) for (const p of v.split(/;|,(?=\s*(?:file:|internal-pdf:|\/))/)) if (isPdfName(p.trim())) r.files.push(p.trim());
  return finish(r);
}

/* ---------------------------------------------------------------- EndNote XML */
function parseEndnoteXml(text) {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (doc.querySelector("parsererror")) throw new Error("The .xml file couldn't be read.");
  const t = (n, sel) => { const e = n.querySelector(sel); return e ? clean(e.textContent) : ""; };
  const records = [];
  for (const rec of doc.querySelectorAll("records > record")) {
    const r = record(), m = r.meta;
    const rt = rec.querySelector("ref-type"); m.type = itemType(rt && (rt.getAttribute("name") || rt.textContent));
    m.title = t(rec, "titles > title");
    m.venue = t(rec, "titles > secondary-title") || t(rec, "periodical > full-title");
    for (const a of rec.querySelectorAll("contributors > authors > author")) m.authors.push(person(a.textContent));
    m.authors = m.authors.filter(Boolean);
    m.date = t(rec, "dates > year"); m.volume = t(rec, "volume"); m.issue = t(rec, "number"); m.pages = t(rec, "pages");
    m.doi = doiOf(t(rec, "electronic-resource-num")); m.abstract = t(rec, "abstract"); m.publisher = t(rec, "publisher");
    m.url = t(rec, "urls > related-urls > url");
    for (const k of rec.querySelectorAll("keywords > keyword")) r.tags.push(k.textContent);
    for (const s of ["notes", "research-notes"]) { const n = t(rec, s); if (n) r.notes.push(n); }
    for (const u of rec.querySelectorAll("urls > pdf-urls > url")) r.files.push(clean(u.textContent));
    records.push(finish(r));
  }
  return { format: "EndNote XML", source: "EndNote", records, collections: new Map() };
}

/* ---------------------------------------------------------------- CSL JSON (Zotero, Paperpile, Mendeley, Better BibTeX) */
function parseCslJson(text) {
  let data = JSON.parse(text);
  if (data && !Array.isArray(data)) data = data.items || [];
  const records = [];
  for (const x of data) {
    if (!x || !x.title) continue;
    const r = record(), m = r.meta;
    m.type = itemType(x.type); m.title = x.title; m.venue = x["container-title"] || "";
    m.authors = (x.author || []).map((a) => (a.literal ? { given: "", family: a.literal } : { given: a.given || "", family: a.family || "" })).filter((a) => a.family);
    const dp = x.issued && x.issued["date-parts"] && x.issued["date-parts"][0];
    if (dp) m.date = dp.map((v, i) => (i ? String(v).padStart(2, "0") : String(v))).join("-");
    m.volume = String(x.volume || ""); m.issue = String(x.issue || ""); m.pages = String(x.page || "");
    m.doi = x.DOI || ""; m.url = x.URL || ""; m.abstract = x.abstract || ""; m.publisher = x.publisher || "";
    if (x.keyword) r.tags.push(...String(x.keyword).split(/[,;]/));
    for (const a of x.attachments || []) if (a.path && isPdfName(a.path)) r.files.push(a.path);
    for (const n of x.notes || []) r.notes.push(htmlToText(typeof n === "string" ? n : n.note || ""));
    records.push(finish(r));
  }
  return { format: "CSL JSON", source: "", records, collections: new Map() };
}

/* ---------------------------------------------------------------- reading the chosen folder */
const pdfSniff = new WeakMap();
async function isPdf(x) {
  if (!pdfSniff.has(x.file)) pdfSniff.set(x.file, (await x.file.slice(0, 1024).text()).includes("%PDF-"));
  return pdfSniff.get(x.file);
}
// a PDF saved without ".pdf" gets the extension, so the library stores it like any other
const asPdf = (f) => (isPdfName(f.name) ? f : new File([f], (f.name === "undefined" ? "document" : f.name) + ".pdf", { type: "application/pdf" }));
// files: [{file: File, path: "files/2/x.pdf"}] with paths relative to the chosen folder
export async function readFolder(files) {
  const metaFiles = files.filter(({ path }) => /\.(rdf|bib|bibtex|ris|xml|json|txt)$/i.test(path) && !/(^|\/)\./.test(path));
  const others = files.filter((x) => !metaFiles.includes(x) && !/(^|\/)\./.test(x.path));
  const parsed = [];
  for (const mf of metaFiles) {
    const text = await mf.file.text();
    let p = null;
    try {
      if (/\.rdf$/i.test(mf.path) || /zotero\.org\/namespaces\/export/.test(text.slice(0, 4000))) p = parseRdf(text);
      else if (/@\s*\w+\s*[{(]/.test(text)) p = parseBib(text);
      else if (/^TY  - /m.test(text)) p = parseRis(text);
      else if (/<records>\s*<record>/.test(text)) p = parseEndnoteXml(text);
      else if (/\.json$/i.test(mf.path) && /"title"/.test(text)) p = parseCslJson(text);
    } catch (e) { console.warn("import:", mf.path, e); }
    if (p && p.records.length) parsed.push({ ...p, path: mf.path });
  }
  // the richest format wins when an app exported the same library twice (Zotero RDF + BibTeX in one folder)
  const rank = { "Zotero RDF": 4, "EndNote XML": 3, BibTeX: 2, RIS: 1, "CSL JSON": 0 };
  parsed.sort((a, b) => rank[b.format] - rank[a.format] || b.records.length - a.records.length);
  let use = parsed;
  if (parsed.length > 1 && parsed.every((p) => p.records.length === parsed[0].records.length)) use = [parsed[0]];
  // several files: each was probably one collection exported on its own
  const records = [], collections = new Map();
  for (const p of use) {
    for (const [id, c] of p.collections) collections.set(p.path + "#" + id, { name: c.name, parent: c.parent ? p.path + "#" + c.parent : null });
    const own = use.length > 1 ? p.path + "#file" : null;
    if (own) collections.set(own, { name: baseName(p.path).replace(/\.\w+$/, ""), parent: null });
    for (const r of p.records) { r.collections = r.collections.map((c) => p.path + "#" + c); if (own) r.collections.push(own); records.push(r); }
  }
  const source = (use[0] && use[0].source) || "";
  // match each record's files to the folder: the exact path, then the end of the path, then the file name.
  // Any file can be the PDF (Zotero sometimes exports one as "undefined"); its first bytes decide.
  const byPath = new Map(others.map((x) => [normPath(x.path), x]));
  const byName = new Map();
  for (const x of others) { const k = baseName(x.path).toLowerCase(); byName.set(k, byName.has(k) ? null : x); }
  const find = (ref) => {
    const p = normPath(String(ref).replace(/^internal-pdf:\/\//i, "pdf/"));
    if (byPath.has(p)) return byPath.get(p);
    for (const [k, x] of byPath) if (p.endsWith("/" + k) || k.endsWith("/" + p)) return x;
    return byName.get(baseName(p)) || null;
  };
  const used = new Set();
  for (const r of records) {
    r.pdfs = [];
    for (const ref of r.files) {
      const x = find(ref);
      if (x && !used.has(x) && await isPdf(x)) { used.add(x); r.pdfs.push({ file: asPdf(x.file), label: r.fileLabels[ref] || "" }); }
    }
  }
  const pdfs = [];
  for (const x of others) if (!used.has(x) && !/\.(html?|txt|png|jpe?g|gif|epub|docx?|zip)$/i.test(x.path) && await isPdf(x)) pdfs.push({ ...x, file: asPdf(x.file) });
  // PDFs the export didn't point to (Bookends, BibDesk, a plain folder): match by title, else a paper of their own
  const loose = pdfs;
  for (const r of records) {
    if (r.pdfs.length || r.meta.title.length < 12) continue;
    const t = normTitle(r.meta.title).split(" ").slice(0, 6).join(" ");
    const i = loose.findIndex((x) => normTitle(baseName(x.path)).includes(t));
    if (i >= 0) { r.pdfs.push({ file: loose[i].file, label: "" }); loose.splice(i, 1); }
  }
  // a folder of PDFs only: subfolders become projects
  const extra = loose.map((x) => {
    const dirs = x.path.split("/").slice(0, -1);
    return { file: x.file, path: x.path, folder: records.length ? null : dirs.join("/") || null };
  });
  if (!records.length) for (const x of extra) if (x.folder) {
    const parts = x.folder.split("/");
    parts.forEach((name, i) => { const id = "dir:" + parts.slice(0, i + 1).join("/"); if (!collections.has(id)) collections.set(id, { name, parent: i ? "dir:" + parts.slice(0, i).join("/") : null }); });
  }
  return { format: parsed.length ? use.map((p) => p.format).join(" + ") : "PDFs", source, records, collections, loose: extra, metaFiles: use.map((p) => p.path) };
}

/* ---------------------------------------------------------------- annotations inside a PDF -> marks */
// highlight colours become mark types named after the colour (hidden from the marking toolbar, shown on the page)
const COLORS = [["red", "Red", "rose"], ["orange", "Orange", "orange"], ["yellow", "Yellow", "amber"], ["green", "Green", "olive"],
  ["blue", "Blue", "blue"], ["purple", "Purple", "violet"], ["magenta", "Magenta", "rose"], ["gray", "Gray", "slate"]];
function colorName(rgb) {
  if (!rgb || rgb.length < 3) return null;
  const [r, g, b] = [...rgb].map((v) => v / 255), mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
  const s = mx === mn ? 0 : (mx - mn) / (1 - Math.abs(2 * l - 1));
  if (s < 0.15) return "gray";
  let hue = mx === r ? ((g - b) / (mx - mn)) % 6 : mx === g ? (b - r) / (mx - mn) + 2 : (r - g) / (mx - mn) + 4;
  hue = (hue * 60 + 360) % 360;
  return hue < 15 || hue >= 345 ? "red" : hue < 40 ? "orange" : hue < 70 ? "yellow" : hue < 170 ? "green" : hue < 250 ? "blue" : hue < 290 ? "purple" : "magenta";
}
const TEXT_KINDS = new Set(["Highlight", "Underline", "StrikeOut", "Squiggly"]);
const BOX_KINDS = new Set(["Square", "Circle", "Polygon", "PolyLine", "Ink", "Line", "Text", "FreeText", "Stamp", "Caret"]);
const newId = () => "im" + Date.now().toString(36).slice(-5) + Math.random().toString(36).slice(2, 8);

export async function marksFromPdf(file, typeFor) {
  const doc = await api.openPdfData(new Uint8Array(await file.arrayBuffer())).promise;
  const marks = [];
  try {
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const anns = (await page.getAnnotations()).filter((a) => TEXT_KINDS.has(a.subtype) || BOX_KINDS.has(a.subtype));
      if (!anns.length) continue;
      const vp = page.getViewport({ scale: 1 });
      const frac = (r) => {
        const [x0, y0, x1, y1] = vp.convertToViewportRectangle(r);
        return { p, x: Math.min(x0, x1) / vp.width, y: Math.min(y0, y1) / vp.height, w: Math.abs(x1 - x0) / vp.width, h: Math.abs(y1 - y0) / vp.height };
      };
      let words = null;
      const textIn = async (rects) => {
        if (!words) {
          const tc = await page.getTextContent();
          words = tc.items.filter((it) => it.str && it.str.trim()).map((it) => {
            const [, , , , e, f] = it.transform, hgt = it.height || Math.hypot(it.transform[2], it.transform[3]);
            return { str: it.str, r: frac([e, f, e + it.width, f + hgt]) };
          });
        }
        const out = [];
        for (const rc of rects) {
          const line = [];
          for (const w of words) {
            const cy = w.r.y + w.r.h / 2;
            if (cy < rc.y - rc.h * 0.2 || cy > rc.y + rc.h * 1.2) continue;
            const a = Math.max(w.r.x, rc.x), b = Math.min(w.r.x + w.r.w, rc.x + rc.w);
            if (b <= a) continue;
            // whole words: a word counts when most of it (by its share of the run's width) is inside the box
            const n = w.str.length, parts = w.str.split(/(\s+)/);
            let at = 0, s = "";
            for (const part of parts) {
              const x0 = w.r.x + (at / n) * w.r.w, x1 = w.r.x + ((at + part.length) / n) * w.r.w;
              at += part.length;
              if (!part.trim()) { if (s) s += " "; continue; }
              if (Math.min(x1, rc.x + rc.w) - Math.max(x0, rc.x) >= 0.5 * (x1 - x0)) s += part;
            }
            if (s.trim()) line.push({ x: a, s: s.trim() });
          }
          out.push(line.sort((u, v) => u.x - v.x).map((x) => x.s).join(" "));
        }
        return out.join(" ").replace(/\s+/g, " ").trim();
      };
      for (const a of anns) {
        const text = TEXT_KINDS.has(a.subtype);
        let rects = [];
        const q = a.quadPoints;
        if (text && q && q.length) {
          // pdf.js 3: [[{x,y}×4], …]; pdf.js 4: a flat array, 8 numbers per quad
          const quads = typeof q[0] === "number" ? Array.from({ length: q.length / 8 }, (_, i) => Array.from({ length: 4 }, (_, j) => ({ x: q[i * 8 + j * 2], y: q[i * 8 + j * 2 + 1] }))) : q;
          rects = quads.map((pts) => frac([Math.min(...pts.map((t) => t.x)), Math.min(...pts.map((t) => t.y)), Math.max(...pts.map((t) => t.x)), Math.max(...pts.map((t) => t.y))]));
        } else rects = [frac(a.rect)];
        rects = rects.filter((r) => r.w > 0 && r.h > 0);
        if (!rects.length) continue;
        const note = clean((a.contentsObj && a.contentsObj.str) || a.contents || "");
        const quote = await textIn(rects);
        if (text && !quote && !note) continue;
        const m = { id: newId(), num: 0, type: typeFor(colorName(a.color)), kind: text ? "text" : "box", page: p, y: rects[0].y, quote, note,
          suggest: "", context: "", rects, created: pdfDate(a.modificationDate) || new Date().toISOString(), imported: a.subtype };
        if (!text && rects[0].w * rects[0].h > 0.0004) m.cropData = await crop(page, rects[0]).catch(() => undefined);
        marks.push(m);
      }
      page.cleanup();
    }
  } finally { doc.destroy(); }
  marks.sort((a, b) => a.page - b.page || a.y - b.y);
  marks.forEach((m, i) => (m.num = i + 1));
  return marks;
}
function pdfDate(s) {
  const m = /D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?/.exec(s || "");
  if (!m) return "";
  const d = new Date(Date.UTC(+m[1], (+m[2] || 1) - 1, +m[3] || 1, +m[4] || 0, +m[5] || 0, +m[6] || 0));
  return isNaN(d) ? "" : d.toISOString();
}
async function crop(page, r) {
  const vp = page.getViewport({ scale: 2 });
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(r.w * vp.width)); c.height = Math.max(1, Math.round(r.h * vp.height));
  await page.render({ canvasContext: c.getContext("2d"), viewport: vp, transform: [1, 0, 0, 1, -r.x * vp.width, -r.y * vp.height] }).promise;
  return c.toDataURL("image/png");
}

/* ---------------------------------------------------------------- writing into this library */
function libraryIndex() {
  const idx = new Map();
  for (const it of store.items()) for (const k of idKeys(it)) idx.set(k, it);
  return idx;
}
function idKeys(m) {
  const out = [];
  if (m.doi) out.push("doi:" + m.doi.toLowerCase());
  if (m.arxiv) out.push("arxiv:" + m.arxiv.toLowerCase().replace(/v\d+$/, ""));
  const t = normTitle(m.title);
  if (t.length >= 20) out.push("t:" + t + ":" + (m.year || ""));
  // a short title counts with its year and first author ("lect_kondo_rev2" saved on its own)
  if (t) out.push("ta:" + t + ":" + (m.year || "") + ":" + normTitle(((m.authors || [])[0] || {}).family || ""));
  return out;
}
// the same paper twice in the export (Zotero's Duplicate Items): one record with everything from both
function mergeDuplicates(records) {
  const seen = new Map(), out = [];
  for (const r of records) {
    const hit = idKeys(r.meta).map((k) => seen.get(k)).find(Boolean);
    if (!hit) { out.push(r); idKeys(r.meta).forEach((k) => seen.set(k, r)); continue; }
    for (const [k, v] of Object.entries(r.meta)) if (!hit.meta[k] || (Array.isArray(v) && v.length > hit.meta[k].length)) hit.meta[k] = v;
    hit.tags = [...new Set([...hit.tags, ...r.tags])]; hit.autoTags = [...new Set([...hit.autoTags, ...r.autoTags])];
    hit.notes.push(...r.notes.filter((n) => !hit.notes.includes(n)));
    hit.collections = [...new Set([...hit.collections, ...r.collections])];
    hit.pdfs.push(...r.pdfs); hit.merged = (hit.merged || 0) + 1;
  }
  return out;
}

async function ensureMarkTypes(colors, source) {
  const types = (store.lib.markTypes || []).map((t) => ({ ...t }));
  const map = new Map();
  let changed = false;
  for (const c of colors) {
    if (!c) continue;
    const [id, name, color] = COLORS.find((x) => x[0] === c);
    const have = types.find((t) => t.id === id || t.name.toLowerCase() === name.toLowerCase());
    if (have) { map.set(c, have.id); continue; }
    if (types.length >= 24) continue;
    types.push({ id, name, color, purpose: `Highlights that were ${c} in ${source || "the app you imported from"}.`, noteLabel: "Note (optional)", placeholder: "", suggest: false, hidden: true });
    map.set(c, id); changed = true;
  }
  if (changed) {
    const j = await api.saveMarkTypes(types, store.lib.markTypesRev || 0);
    store.lib.markTypes = j.types; store.lib.markTypesRev = j.rev; store.emit("marktypes");
  }
  return map;
}

// run the jobs (functions returning promises) n at a time
async function runPool(jobs, n) {
  let i = 0;
  const one = async () => { while (i < jobs.length) await jobs[i++](); };
  await Promise.all(Array.from({ length: Math.min(n, jobs.length) }, one));
}

/* ---------------------------------------------------------------- the dialog */
export function openImportLibrary({ onDone } = {}) {
  let plan = null, running = false, stopped = false;
  const keys = [];
  const scrim = el("div", "scrim"), d = el("div", "dialog bulk implib");
  d.setAttribute("role", "dialog"); d.setAttribute("aria-modal", "true"); d.setAttribute("aria-label", "Import a library");
  scrim.append(d);
  const pick = h("input", { type: "file", hidden: true, multiple: true });
  pick.webkitdirectory = true; pick.setAttribute("webkitdirectory", "");
  const choose = h("button", { class: "btn btn--primary", onclick: () => pick.click() }, "Choose folder…");
  const drop = h("div", { class: "implib__drop" },
    el("p", null, "Export your library from your reference manager with its PDFs, then choose the folder it made."),
    h("p", { class: "faint" }, "Zotero: File › Export Library…, format Zotero RDF, with Export Notes, Export Files and Include Annotations ticked. ",
      "Mendeley, EndNote, JabRef, Paperpile and others: export as BibTeX, RIS or EndNote XML into a folder with the PDFs. A folder of PDFs works too."),
    h("div", { class: "bulk__row" }, choose, el("span", "faint", "or drop the folder here")));
  const opts = el("div", "implib__opts");
  const optProjects = h("input", { type: "checkbox", checked: true }), optAuto = h("input", { type: "checkbox" });
  opts.append(
    h("label", null, optProjects, " Make each collection a project"),
    h("label", null, optAuto, " Include automatic tags (publisher keywords)"));
  opts.hidden = true;
  const list = el("div", "bulk__list"), sum = el("p", "bulk__sum faint");
  const cancel = h("button", { class: "btn", onclick: () => (running ? stop() : close()) }, "Cancel");
  const copyMissing = h("button", { class: "btn", hidden: true, title: "Copy the titles and DOIs of the papers without a PDF", onclick: () => copyList() }, "Copy List");
  const findPdfs = h("button", { class: "btn", hidden: true, title: "Download free copies (arXiv, open access) of the papers without a PDF", onclick: () => fetchMissing() }, "Find PDFs Online");
  const go = h("button", { class: "btn btn--primary", disabled: true, onclick: () => (go.dataset.done ? close() : run()) }, "Import");
  d.append(h("h2", null, "Import a library"), drop, opts, sum, list, h("div", { class: "dialog__actions" }, copyMissing, findPdfs, el("span", "grow"), cancel, go), pick);

  pick.addEventListener("change", () => {
    const files = [...pick.files].map((f) => ({ file: f, path: (f.webkitRelativePath || f.name).split("/").slice(1).join("/") || f.name }));
    pick.value = ""; load(files);
  });
  d.addEventListener("dragover", (ev) => { ev.preventDefault(); d.classList.add("is-drop"); });
  d.addEventListener("dragleave", () => d.classList.remove("is-drop"));
  d.addEventListener("drop", async (ev) => {
    ev.preventDefault(); d.classList.remove("is-drop");
    if (running || plan) return;
    const entries = [...ev.dataTransfer.items].map((i) => i.webkitGetAsEntry && i.webkitGetAsEntry()).filter(Boolean);
    const files = [];
    const walk = async (entry, prefix) => {
      if (entry.isFile) { const f = await new Promise((ok, no) => entry.file(ok, no)); files.push({ file: f, path: prefix + f.name }); return; }
      const rd = entry.createReader();
      for (;;) {
        const batch = await new Promise((ok, no) => rd.readEntries(ok, no));
        if (!batch.length) break;
        for (const e of batch) await walk(e, prefix + entry.name + "/");
      }
    };
    for (const e of entries) await walk(e, "");
    // one folder dropped: paths relative to it
    const roots = new Set(files.map((x) => x.path.split("/")[0]));
    if (roots.size === 1 && files.every((x) => x.path.includes("/"))) files.forEach((x) => (x.path = x.path.split("/").slice(1).join("/")));
    load(files);
  });

  async function load(files) {
    if (!files.length) return;
    sum.textContent = "Reading the folder…";
    try { plan = await readFolder(files); }
    catch (e) { sum.textContent = e.message; plan = null; return; }
    const lib = libraryIndex();
    plan.records = mergeDuplicates(plan.records);
    for (const r of plan.records) r.have = idKeys(r.meta).map((k) => lib.get(k)).find(Boolean) || null;
    const n = plan.records.length + plan.loose.length;
    if (!n) { sum.textContent = "There are no papers or PDFs in that folder."; plan = null; return; }
    drop.hidden = true; opts.hidden = !plan.records.length;
    optAuto.parentElement.hidden = !plan.records.some((r) => r.autoTags.length);
    const withPdf = plan.records.filter((r) => r.pdfs.length).length + plan.loose.length;
    const have = plan.records.filter((r) => r.have).length, dup = plan.records.reduce((s, r) => s + (r.merged || 0), 0);
    const from = plan.source ? `${plan.source} (${plan.format})` : plan.format;
    sum.textContent = [`${n} papers from ${from}`, `${withPdf} with a PDF`,
      plan.collections.size ? `${plan.collections.size} ${plan.collections.size === 1 ? "collection" : "collections"}` : "",
      have ? `${have} already in your library` : "", dup ? `${dup} duplicates merged` : ""].filter(Boolean).join(", ") + ".";
    list.textContent = "";
    for (const r of plan.records) {
      r.st = el("span", "bulk__st" + (r.have ? " is-ok" : ""), r.have ? "In your library" : r.pdfs.length ? "" : "No PDF");
      r.row = h("div", { class: "bulk__item" }, el("span", "bulk__kind", r.pdfs.length ? "PDF" : ""), el("span", "bulk__what", r.meta.title || "Untitled"), r.st);
      list.append(r.row);
    }
    for (const x of plan.loose) {
      x.st = el("span", "bulk__st", "");
      x.row = h("div", { class: "bulk__item" }, el("span", "bulk__kind", "PDF"), el("span", "bulk__what", x.path), x.st);
      list.append(x.row);
    }
    go.disabled = false; go.textContent = n === 1 ? "Import 1 paper" : `Import ${n} papers`;
  }

  const status = (r, txt, cls) => { r.st.textContent = txt; r.st.className = "bulk__st" + (cls ? " is-" + cls : ""); };
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  let counts = null;
  // what this import changed, for ⌘Z
  const undoState = { created: [], patched: [], projects: [], attached: [] };
  async function run() {
    running = true; stopped = false; go.disabled = true; go.textContent = "Importing…"; cancel.textContent = "Stop"; opts.hidden = true;
    counts = { added: 0, have: 0, pdfs: 0, marks: 0, notes: 0, failed: 0 };
    const t0 = performance.now();
    try {
      // 1. projects, parents before children; an existing project with the same name is reused
      const projectOf = new Map();
      if (optProjects.checked || !plan.records.length) {
        const make = async (id) => {
          if (projectOf.has(id)) return projectOf.get(id);
          const c = plan.collections.get(id); if (!c) return null;
          const parent = c.parent ? await make(c.parent) : null;
          let p = store.lib.projects.find((x) => x.name === c.name && (x.parent || null) === parent);
          if (!p) {
            p = (await api.createProject(c.name, parent)).project;
            store.lib.projects.push(p);
            undoState.projects.push({ id: p.id, name: p.name, parent, members: [] });
          }
          projectOf.set(id, p.id);
          return p.id;
        };
        for (const id of plan.collections.keys()) await make(id);
      }
      const tagsOf = (r) => [...r.tags, ...(optAuto.checked ? r.autoTags : [])];
      const projOf = (r) => [...new Set(r.collections.map((c) => projectOf.get(c)).filter(Boolean))];

      // 2. the highlights inside every PDF, four PDFs at a time (fast: nothing is written yet)
      const pdfJobs = [];
      for (const r of plan.records) if (!(r.have && (r.have.attachments || []).length)) for (const pdf of r.pdfs) pdfJobs.push(pdf);
      for (const x of plan.loose) pdfJobs.push(x);
      const colors = new Set();
      let read = 0;
      await runPool(pdfJobs.map((pdf) => async () => {
        if (stopped) return;
        pdf.marks = await marksFromPdf(pdf.file, (c) => { if (c) colors.add(c); return c || ""; }).catch(() => []);
        read++; sum.textContent = `Reading highlights… ${read} of ${pdfJobs.length}`;
      }), 4);
      if (stopped) return;
      if (colors.size) {
        const map = await ensureMarkTypes([...colors], plan.source);
        for (const pdf of pdfJobs) for (const m of pdf.marks || []) m.type = (m.type && map.get(m.type)) || "highlight";
      }

      // 3. every new paper, with its tags, projects and notes, in one request per 250
      const fresh = plan.records.filter((r) => !r.have);
      for (let i = 0; i < fresh.length && !stopped; i += 250) {
        const part = fresh.slice(i, i + 250);
        sum.textContent = `Adding papers… ${Math.min(i + 250, fresh.length)} of ${fresh.length}`;
        try {
          const items = (await api.createItems(part.map((r) => ({ meta: r.meta, tags: tagsOf(r), projects: projOf(r),
            notes: r.notes.length ? r.notes.join("\n\n") : undefined })))).items;
          part.forEach((r, k) => {
            r.key = items[k].key; r.pdfOk = false; keys.push(r.key); undoState.created.push(r.key);
            counts.added++; counts.notes += r.notes.length;
            status(r, r.pdfs.length ? "Added, adding PDF…" : "Added, no PDF", r.pdfs.length ? "" : "ok");
          });
        } catch (e) { part.forEach((r) => { counts.failed++; status(r, e.message, "err"); }); }
      }
      // papers already here get only the tags, projects and notes they don't have
      for (const r of plan.records.filter((x) => x.have)) {
        if (stopped) break;
        let item = r.have;
        counts.have++;
        const t = [...new Set([...(item.tags || []), ...tagsOf(r)])], p = [...new Set([...(item.projects || []), ...projOf(r)])];
        const patch = {};
        if (t.length > (item.tags || []).length) patch.tags = t;
        if (p.length > (item.projects || []).length) patch.projects = p;
        try {
          if (Object.keys(patch).length) {
            undoState.patched.push({ key: item.key, before: { tags: item.tags || [], projects: item.projects || [] }, after: { tags: t, projects: p } });
            item = (await api.patchItem(item.key, patch)).item;
          }
          if (r.notes.length) {
            const cur = await api.getNotes(item.key);
            const add = r.notes.filter((n) => !(cur.text || "").includes(n));
            if (add.length) { await api.saveNotes(item.key, [cur.text || "", ...add].filter(Boolean).join("\n\n"), cur.rev || 0); counts.notes += add.length; }
          }
        } catch (e) { status(r, e.message, "err"); continue; }
        r.key = item.key; r.pdfOk = !!(item.attachments || []).length; keys.push(r.key);
        status(r, r.pdfOk || !r.pdfs.length ? "Already here" : "Already here, adding PDF…", r.pdfOk || !r.pdfs.length ? "ok" : "");
      }
      for (const pr of undoState.projects) pr.members = plan.records.filter((r) => r.key && projOf(r).includes(pr.id)).map((r) => r.key);

      // 4. the PDFs, with their marks: twelve to a request, so Stop takes effect between requests
      const todo = [];
      for (const r of plan.records) if (r.key && !r.pdfOk) for (const pdf of r.pdfs) todo.push({ r, pdf });
      let sent = 0;
      for (let i = 0; i < todo.length && !stopped; i += 12) {
        const part = todo.slice(i, i + 12);
        sum.textContent = `Adding PDFs… ${sent} of ${todo.length}`;
        let res;
        try { res = (await api.addAttachments(part.map(({ r, pdf }) => ({ key: r.key, file: pdf.file, label: pdf.label || "", marks: pdf.marks || [] })))).results; }
        catch (e) { part.forEach(({ r }) => { counts.failed++; status(r, e.message, "err"); }); continue; }
        part.forEach(({ r }, k) => {
          const x = res[k];
          if (x.attachment) {
            r.pdfOk = true; counts.pdfs++; r.nMarks = (r.nMarks || 0) + (x.marks || 0); counts.marks += x.marks || 0;
            if (r.have) undoState.attached.push({ key: r.key, att: x.attachment.key, file: part[k].pdf.file, label: part[k].pdf.label || "", marks: part[k].pdf.marks || [] });
          }
          else if (!x.duplicate) { r.pdfErr = x.error; counts.failed++; }
        });
        sent += part.length;
        for (const { r } of part) {
          if (r.pdfErr) { status(r, r.pdfErr, "err"); continue; }
          status(r, [r.have ? "Already here" : "Added", "PDF", r.nMarks ? plural(r.nMarks, "mark", "marks") : ""].filter(Boolean).join(", "), "ok");
        }
      }

      // 5. a folder of PDFs only: each PDF names its paper (title, DOI) the way Add PDF does
      let loose = 0;
      await runPool(plan.loose.map((x) => async () => {
        if (stopped) return;
        status(x, "Adding…");
        try {
          const j = await api.importFile(x.file, x.folder ? projectOf.get("dir:" + x.folder) : null);
          keys.push(j.item.key);
          if (j.duplicate) { counts.have++; status(x, "Already in your library", "ok"); return; }
          undoState.created.push(j.item.key);
          counts.added++; counts.pdfs++;
          const att = (j.item.attachments || [])[0];
          if (att && x.marks && x.marks.length) { await api.saveMarks(j.item.key, att.key, x.marks, 0); counts.marks += x.marks.length; }
          status(x, ["Added", "PDF", x.marks && x.marks.length ? plural(x.marks.length, "mark", "marks") : ""].filter(Boolean).join(", "), "ok");
        } catch (e) { counts.failed++; status(x, e.message, "err"); }
        loose++; sum.textContent = `Adding PDFs… ${loose} of ${plan.loose.length}`;
      }), 4);
    } finally {
      for (const r of plan.records) if (r.key && !r.pdfOk && r.pdfs.length && !r.pdfErr) status(r, r.have ? "Already here, no PDF" : "Added, no PDF", "ok");
      for (const r of plan.records) if (!r.key && !r.st.classList.contains("is-err") && stopped) status(r, "Not imported", "err");
      running = false;
      recordUndo();
      await store.load().catch(() => {});
      finishSummary(performance.now() - t0);
      cancel.hidden = true; go.disabled = false; go.textContent = "Done"; go.dataset.done = "1";
    }
  }
  function finishSummary(ms) {
    const missing = plan.records.filter((r) => r.key && !r.pdfOk);
    const parts = [plural(counts.added, "paper added", "papers added"), counts.have ? `${counts.have} already here` : "",
      plural(counts.pdfs, "PDF", "PDFs"), counts.marks ? plural(counts.marks, "mark", "marks") : "", counts.notes ? plural(counts.notes, "note", "notes") : "",
      counts.failed ? `${counts.failed} failed` : ""].filter(Boolean);
    const nothing = !counts.added && !counts.pdfs && !counts.failed && counts.have;
    sum.textContent = (stopped ? "Stopped. " : "") + (nothing ? `All ${plural(counts.have, "paper is", "papers are")} already in your library.` : parts.join(", ") + (ms ? ` in ${(ms / 1000).toFixed(1)} s.` : "."))
      + (missing.length ? ` ${plural(missing.length, "paper has", "papers have")} no PDF.` : "") + (undoState.created.length ? " ⌘Z undoes the import." : "");
    copyMissing.hidden = !missing.length;
    findPdfs.hidden = !missing.some((r) => r.meta.arxiv || r.meta.doi);
  }
  // ⌘Z moves the imported papers to the Trash and takes back the projects and tags it added; ⌘⇧Z puts it all back
  function recordUndo() {
    const U = undoState;
    if (!U.created.length && !U.patched.length && !U.projects.length && !U.attached.length) return;
    const n = U.created.length;
    const reload = () => store.load();
    undoLog.record({
      label: n ? `the import of ${plural(n, "paper", "papers")}` : "the import",
      // the colour mark types stay (they are hidden, and the trashed papers' marks still use them)
      undo: async () => {
        try {
          if (U.created.length) await api.bulk({ keys: U.created, trash: true });
          for (const a of U.attached) await api.removeAttachment(a.key, a.att);
          for (const p of U.patched) await api.patchItem(p.key, p.before);
          for (const pr of [...U.projects].reverse()) await api.deleteProject(pr.id);
        } finally { await reload(); }
      },
      redo: async () => {
        try {
          if (U.created.length) await api.bulk({ keys: U.created, restore: true });
          if (U.attached.length) {
            const res = (await api.addAttachments(U.attached.map((a) => ({ key: a.key, file: a.file, label: a.label, marks: a.marks })))).results;
            U.attached.forEach((a, i) => { if (res[i].attachment) a.att = res[i].attachment.key; });
          }
          const idMap = new Map();
          for (const pr of U.projects) {
            const p = (await api.createProject(pr.name, pr.parent ? idMap.get(pr.parent) || pr.parent : null)).project;
            idMap.set(pr.id, p.id);
          }
          const remap = (ids) => ids.map((x) => idMap.get(x) || x);
          for (const p of U.patched) { p.after.projects = remap(p.after.projects); await api.patchItem(p.key, p.after); }
          for (const pr of U.projects) {
            const members = pr.members.filter((k) => !U.patched.some((p) => p.key === k));
            if (members.length) await api.bulk({ keys: members, addProjects: [idMap.get(pr.id)] });
          }
          for (const pr of U.projects) { pr.parent = pr.parent ? idMap.get(pr.parent) || pr.parent : null; pr.id = idMap.get(pr.id); }
        } finally { await reload(); }
      },
    });
  }
  async function fetchMissing() {
    const todo = plan.records.filter((r) => r.key && !r.pdfOk && (r.meta.arxiv || r.meta.doi));
    findPdfs.disabled = true; go.disabled = true; running = true; stopped = false;
    cancel.hidden = false; cancel.disabled = false; cancel.textContent = "Stop";
    let i = 0, done = 0, got = 0;
    const worker = async () => {
      while (!stopped && i < todo.length) {
        const r = todo[i++];
        status(r, "Looking for a PDF…");
        try { await api.fetchAttachment(r.key, r.meta.arxiv || r.meta.doi, r.meta.arxiv ? "arXiv preprint" : "PDF"); r.pdfOk = true; got++; counts.pdfs++; status(r, "Added, PDF downloaded", "ok"); }
        catch (_) { status(r, r.have ? "Already here, no free PDF found" : "Added, no free PDF found", "ok"); }
        done++; sum.textContent = `Looking for free PDFs… ${done} of ${todo.length}, ${got} found`;
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    for (const r of todo) if (r.st.textContent === "Looking for a PDF…") status(r, r.have ? "Already here, no PDF" : "Added, no PDF", "ok");
    running = false;
    await store.load().catch(() => {});
    finishSummary(0);
    sum.textContent = `${got} of ${todo.length} PDFs found online. ` + sum.textContent;
    cancel.hidden = true; go.disabled = false; findPdfs.disabled = false;
  }
  async function copyList() {
    const lines = plan.records.filter((r) => r.key && !r.pdfOk).map((r) => [r.meta.title, r.meta.doi ? "doi:" + r.meta.doi : r.meta.arxiv ? "arXiv:" + r.meta.arxiv : r.meta.url].filter(Boolean).join("  "));
    ui.toast((await ui.copyText(lines.join("\n"))) ? `Copied ${lines.length} papers.` : "Couldn't copy to the clipboard.");
  }
  function stop() { stopped = true; cancel.disabled = true; cancel.textContent = "Stopping…"; }
  function close() {
    if (running) return;
    scrim.remove(); document.removeEventListener("keydown", onKey, true);
    if (keys.length && onDone) onDone([...new Set(keys)]);
  }
  const onKey = (ev) => { if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); if (!running) close(); } };
  document.addEventListener("keydown", onKey, true);
  document.getElementById("overlay-root").append(scrim);
  setTimeout(() => choose.focus(), 0);
  return { load };
}
