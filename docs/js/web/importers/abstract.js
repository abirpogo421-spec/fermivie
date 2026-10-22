// Abstract cleaning from importers.py (WEB_CONTRACT.md section 6.2): JATS/HTML markup stripped, MathML and
// <tex-math> turned into $TeX$, TeX quotes/accents/dashes made typographic, \ensuremath unwrapped. Pure ES
// module; results equal Python's on every input (tests/web/test_imp_pure*.mjs).
//
// Exports (Python name in brackets): cleanAbstract [clean_abstract], cleanAbstractMarkup and its alias
// _cleanAbstract [_clean_abstract, the source parsers' cleaner], mathmlToTex [_mathml_to_tex],
// mmlTex [_mml_tex], xmlFromString [xml.etree.ElementTree.fromstring, for MathML islands], XmlParseError,
// unwrapEnsuremath, texResolve, tieEdges, tidyText, tidyMath, formulaLike, countDollars, ELEMENTS,
// TEX_ACCENTS, MATH_SPLIT, MML_RE, TEXMATH_RE, MML_OPS, MML_FUNCS, MML_MAX_LEVEL.
//
// The one input where Python's answer depends on its call stack: MathML nested deeper than Python's
// recursion limit falls back to plain text. Python 3.13 gets there when an element is more than 994
// levels below <math> for a direct clean_abstract() call from a script's top level (fewer when it is
// called from deeper code); MML_MAX_LEVEL reproduces the direct call.

import {
  re, ws, stripTags, stripMarkup, unescapeEntities, htmlUnescape, MARKUP_RE, pyStrip, pyRstrip, pyLower,
  pyStr, pyTruthy,
  pyIsAlpha, pyGet, cpLen, cpSlice, cpAt, cpIndex, utf16Index, isNameStartCp, isNameCharCp, normalize,
  PyValueError,
} from "./text.js";

// ---------------------------------------------------------------------------------------------------
// xml.etree.ElementTree.fromstring (expat in namespace mode, as Python 3.13 / expat 2.7 parse a string)
// -> {tag, attrib: Map, text: string|null, children: [...]}; throws XmlParseError where ET raises
// ParseError and PyValueError where Python can't encode the string (lone surrogates).

export class XmlParseError extends Error {
  constructor(msg) { super(msg); this.name = "ParseError"; }
}

const XML_NS = "http://www.w3.org/XML/1998/namespace";
const XMLNS_NS = "http://www.w3.org/2000/xmlns/";
const PREDEFINED = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

function xmlCharOk(cp) {
  return cp === 0x9 || cp === 0xa || cp === 0xd || (cp >= 0x20 && cp <= 0xd7ff)
    || (cp >= 0xe000 && cp <= 0xfffd) || (cp >= 0x10000 && cp <= 0x10ffff);
}

const isS = (c) => c === " " || c === "\t" || c === "\n" || c === "\r";

class XmlReader {
  constructor(text) {
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff && (text.charCodeAt(i + 1) & 0xfc00) === 0xdc00) { i++; continue; }
      if (c >= 0xd800 && c <= 0xdfff) {
        throw new PyValueError(`'utf-8' codec can't encode character '\\u${c.toString(16)}' in position `
          + `${cpIndex(text, i)}: surrogates not allowed`);
      }
    }
    for (const ch of text) if (!xmlCharOk(ch.codePointAt(0))) throw new XmlParseError("not well-formed (invalid token)");
    this.s = text.replace(/\r\n?/g, "\n");
    this.i = 0;
  }

  fail(msg = "not well-formed (invalid token)") { throw new XmlParseError(msg); }

  skipS() {
    const start = this.i;
    while (this.i < this.s.length && isS(this.s[this.i])) this.i++;
    return this.i > start;
  }

  cpAtPos() {
    const cp = this.s.codePointAt(this.i);
    return cp === undefined ? -1 : cp;
  }

  ncname() {
    let cp = this.cpAtPos();
    if (cp < 0 || !isNameStartCp(cp)) this.fail();
    const start = this.i;
    this.i += cp > 0xffff ? 2 : 1;
    for (;;) {
      cp = this.cpAtPos();
      if (cp < 0 || !isNameCharCp(cp)) break;
      this.i += cp > 0xffff ? 2 : 1;
    }
    return this.s.slice(start, this.i);
  }

  qname() {
    const a = this.ncname();
    if (this.s[this.i] !== ":") return a;
    this.i++;
    const b = this.ncname();
    if (this.s[this.i] === ":") this.fail();
    return a + ":" + b;
  }

  // a reference after "&": the replacement text
  reference() {
    const s = this.s;
    if (s[this.i] === "#") {
      this.i++;
      let digits = "", base = 10;
      if (s[this.i] === "x") { base = 16; this.i++; }
      const re0 = base === 16 ? /[0-9a-fA-F]/ : /[0-9]/;
      while (this.i < s.length && re0.test(s[this.i])) digits += s[this.i++];
      if (!digits || s[this.i] !== ";") this.fail();
      this.i++;
      const t = digits.replace(/^0+/, "");
      const v = t.length > 7 ? Infinity : t ? parseInt(t, base) : 0;
      if (!xmlCharOk(v)) this.fail("reference to invalid character number");
      return String.fromCodePoint(v);
    }
    const name = this.qname();
    if (s[this.i] !== ";") this.fail();
    this.i++;
    if (!Object.prototype.hasOwnProperty.call(PREDEFINED, name)) this.fail("undefined entity");
    return PREDEFINED[name];
  }

  attValue() {
    const q = this.s[this.i];
    if (q !== '"' && q !== "'") this.fail();
    this.i++;
    let v = "";
    for (;;) {
      if (this.i >= this.s.length) this.fail("unclosed token");
      const c = this.s[this.i];
      if (c === q) { this.i++; return v; }
      if (c === "<") this.fail();
      if (c === "&") { this.i++; v += this.reference(); continue; }
      v += c === "\n" || c === "\t" ? " " : c;
      this.i++;
    }
  }

  // "<" already consumed; returns {name, attrs: [[qname, value]], empty}
  startTag() {
    const name = this.qname();
    const attrs = [];
    for (;;) {
      const sp = this.skipS();
      if (this.s[this.i] === ">") { this.i++; return { name, attrs, empty: false }; }
      if (this.s.startsWith("/>", this.i)) { this.i += 2; return { name, attrs, empty: true }; }
      if (!sp) this.fail();
      const an = this.qname();
      this.skipS();
      if (this.s[this.i] !== "=") this.fail();
      this.i++;
      this.skipS();
      attrs.push([an, this.attValue()]);
    }
  }

  // "<!--" / "<?" / "<![CDATA[" at this.i: returns CDATA text, "" for comments and PIs
  misc() {
    const s = this.s;
    if (s.startsWith("<!--", this.i)) {
      const j = s.indexOf("--", this.i + 4);
      if (j < 0) this.fail("unclosed token");
      if (s[j + 2] !== ">") this.fail();
      this.i = j + 3;
      return "";
    }
    if (s.startsWith("<?", this.i)) {
      this.i += 2;
      const target = this.ncname();   // namespace mode: no colon in a PI target
      if (/^[xX][mM][lL]$/.test(target)) this.fail(target === "xml" ? "XML or text declaration not at start of entity" : undefined);
      if (s.startsWith("?>", this.i)) { this.i += 2; return ""; }
      if (!this.skipS()) this.fail();
      const j = s.indexOf("?>", this.i);
      if (j < 0) this.fail("unclosed token");
      this.i = j + 2;
      return "";
    }
    if (s.startsWith("<![CDATA[", this.i)) {
      const j = s.indexOf("]]>", this.i + 9);
      if (j < 0) this.fail("unclosed CDATA section");
      const t = s.slice(this.i + 9, j);
      this.i = j + 3;
      return t;
    }
    this.fail();
    return "";
  }
}

function nsElement(tag, attrs, scopes) {
  const scope = new Map(scopes[scopes.length - 1]);
  const seen = new Set();
  const plain = [];
  for (const [an, value] of attrs) {
    if (seen.has(an)) throw new XmlParseError("duplicate attribute");
    seen.add(an);
    if (an === "xmlns") {
      if (value.includes("}")) throw new XmlParseError("syntax error");
      if (value === XML_NS || value === XMLNS_NS) throw new XmlParseError("reserved namespace");
      scope.set("", value);
    } else if (an.startsWith("xmlns:")) {
      const prefix = an.slice(6);
      if (prefix === "xmlns") throw new XmlParseError("reserved prefix (xmlns) must not be declared or undeclared");
      // expat (addBinding) refuses a namespace name holding the separator ElementTree gives it, "}", because
      // "{uri}local" could not be split again; "}" is not a URI character, so expat's exception for ":" doesn't apply
      if (value.includes("}")) throw new XmlParseError("syntax error");
      if (prefix === "xml") {
        if (value !== XML_NS) throw new XmlParseError("reserved prefix (xml) must not be undeclared or bound to another namespace name");
      } else {
        if (value === "") throw new XmlParseError("must not undeclare prefix");
        if (value === XML_NS || value === XMLNS_NS) throw new XmlParseError("reserved namespace");
      }
      scope.set(prefix, value);
    } else plain.push([an, value]);
  }
  const expand = (qn, isAttr) => {
    const k = qn.indexOf(":");
    if (k < 0) {
      const d = isAttr ? "" : scope.get("") || "";
      return d ? `{${d}}${qn}` : qn;
    }
    const prefix = qn.slice(0, k), local = qn.slice(k + 1);
    if (prefix === "xmlns") throw new XmlParseError("reserved prefix (xmlns) must not be declared or undeclared");
    const uri = prefix === "xml" ? XML_NS : scope.get(prefix);
    if (!uri) throw new XmlParseError("unbound prefix");
    return `{${uri}}${local}`;
  };
  const attrib = new Map();
  for (const [an, value] of plain) {
    const key = expand(an, true);
    if (attrib.has(key)) throw new XmlParseError("duplicate attribute");
    attrib.set(key, value);
  }
  return { el: { tag: expand(tag, false), attrib, text: null, children: [] }, scope };
}

export function xmlFromString(text) {
  const r = new XmlReader(text);
  const s = r.s;
  const stack = [];      // [{el, qname}]
  const scopes = [new Map()];
  let root = null;
  // prolog: whitespace, comments, processing instructions (no DOCTYPE / XML declaration support needed)
  for (;;) {
    r.skipS();
    if (s.startsWith("<!--", r.i) || (s.startsWith("<?", r.i))) { r.misc(); continue; }
    break;
  }
  if (s[r.i] !== "<" || s[r.i + 1] === "/" || s[r.i + 1] === "!") r.fail(r.i >= s.length ? "no element found" : "syntax error");
  for (;;) {
    if (r.i >= s.length) r.fail(root ? "no element found" : "no element found");
    const c = s[r.i];
    if (c === "<") {
      if (s[r.i + 1] === "/") {
        r.i += 2;
        const name = r.qname();
        r.skipS();
        if (s[r.i] !== ">") r.fail();
        r.i++;
        const top = stack.pop();
        if (!top || top.qname !== name) r.fail("mismatched tag");
        scopes.pop();
        if (!stack.length) break;
        continue;
      }
      if (s[r.i + 1] === "!" || s[r.i + 1] === "?") {
        const t = r.misc();
        if (t && stack.length) appendText(stack[stack.length - 1].el, t);
        continue;
      }
      r.i++;
      const st = r.startTag();
      const { el, scope } = nsElement(st.name, st.attrs, scopes);
      if (stack.length) stack[stack.length - 1].el.children.push(el);
      else root = el;
      if (!st.empty) {
        stack.push({ el, qname: st.name });
        scopes.push(scope);
      } else if (!stack.length) break;
      continue;
    }
    if (!stack.length) r.fail("junk after document element");
    if (c === "&") {
      r.i++;
      appendText(stack[stack.length - 1].el, r.reference());
      continue;
    }
    let j = r.i;
    while (j < s.length && s[j] !== "<" && s[j] !== "&") j++;
    const t = s.slice(r.i, j);
    if (t.includes("]]>")) r.fail();
    appendText(stack[stack.length - 1].el, t);
    r.i = j;
  }
  // epilog: whitespace, comments, processing instructions
  for (;;) {
    r.skipS();
    if (r.i >= s.length) break;
    if (s.startsWith("<!--", r.i) || s.startsWith("<?", r.i)) { r.misc(); continue; }
    r.fail("junk after document element");
  }
  return root;
}

function appendText(el, t) {
  if (!t || el.children.length) return;     // text after a child is that child's tail (not used here)
  el.text = (el.text ?? "") + t;
}

// ---------------------------------------------------------------------------------------------------
// MathML / <tex-math> -> $TeX$

export const MML_RE = re(String.raw`<(?:\w+:)?math\b[^>]*>.*?</(?:\w+:)?math>`, "SI");
export const TEXMATH_RE = re(String.raw`<(?:\w+:)?tex-math\b[^>]*>(.*?)</(?:\w+:)?tex-math>`, "SI");
export const MML_OPS = new Map([["{", "\\{"], ["}", "\\}"], ["#", "\\#"], ["%", "\\%"], ["&", "\\&"], ["_", "\\_"],
  ["⁡", ""], ["⁢", ""], ["⁣", ""], [" ", " "]]);
export const MML_FUNCS = new Set(["sin", "cos", "tan", "exp", "log", "ln", "det", "max", "min", "lim", "Re", "Im", "tr", "Tr"]);
export const MML_MAX_LEVEL = 994;

class MmlRecursion extends Error {}

const localTag = (e) => pyLower(e.tag.split("}").pop());

// _mml_tex(e): MathML element -> TeX, or null when it uses something unsupported
export function mmlTex(e, level = 0) {
  if (level > MML_MAX_LEVEL) throw new MmlRecursion("maximum recursion depth exceeded");
  const tag = localTag(e);
  const kids = e.children;
  const txt = ws(e.text);
  if (tag === "mi" || tag === "mn" || tag === "mo" || tag === "ms") {
    let t = "";
    for (const c of txt) t += MML_OPS.get(c) ?? c;
    if (tag === "mi" && MML_FUNCS.has(txt)) {
      return !["Re", "Im", "tr", "Tr"].includes(txt) ? "\\" + txt : "\\mathrm{" + txt + "}";
    }
    if (tag === "mi" && cpLen(txt) > 1 && pyIsAlpha(txt)) return "\\mathrm{" + t + "}";
    return t;
  }
  if (tag === "mtext") return txt ? "\\text{" + txt.replaceAll("{", "").replaceAll("}", "") + "}" : " ";
  if (tag === "mspace" || tag === "none" || tag === "mprescripts") return tag === "mspace" ? " " : "";
  if (tag === "semantics") {
    for (const k of kids) {
      if (localTag(k) === "annotation" && pyLower(k.attrib.get("encoding") || "").includes("tex") && ws(k.text)) {
        return ws(k.text);
      }
    }
    return kids.length ? mmlTex(kids[0], level + 1) : "";
  }
  const parts = [];
  for (const k of kids) {
    const kt = localTag(k);
    if (kt !== "annotation" && kt !== "annotation-xml") parts.push(mmlTex(k, level + 1));
  }
  if (parts.some((p) => p === null)) return null;
  const g = parts.map((p) => "{" + p + "}");
  if (["math", "mrow", "mstyle", "mpadded", "mphantom", "merror", "menclose", "mtd"].includes(tag)) return parts.join("");
  if (tag === "msub" && g.length === 2) return g[0] + "_" + g[1];
  if (tag === "msup" && g.length === 2) return g[0] + "^" + g[1];
  if (tag === "msubsup" && g.length === 3) return g[0] + "_" + g[1] + "^" + g[2];
  if (tag === "mfrac" && g.length === 2) return "\\frac" + g[0] + g[1];
  if (tag === "msqrt") return "\\sqrt{" + parts.join("") + "}";
  if (tag === "mroot" && g.length === 2) return "\\sqrt[" + parts[1] + "]" + g[0];
  if ((tag === "mover" || tag === "munder" || tag === "munderover") && g.length >= 2) {
    if (tag === "mover" && ["¯", "‾", "―", "-", "−"].includes(parts[1])) return "\\bar" + g[0];
    if (tag === "mover" && ["˜", "~"].includes(parts[1])) return "\\tilde" + g[0];
    if (tag === "mover" && ["^", "ˆ"].includes(parts[1])) return "\\hat" + g[0];
    if (tag === "mover" && ["→", "⃗"].includes(parts[1])) return "\\vec" + g[0];
    if (tag === "mover" && ["˙", "."].includes(parts[1])) return "\\dot" + g[0];
    if (tag === "munder") return "\\underset" + g[1] + g[0];
    if (tag === "mover") return "\\overset" + g[1] + g[0];
    return g.length === 3 ? "\\overset" + g[2] + "{\\underset" + g[1] + g[0] + "}" : null;
  }
  if (tag === "mfenced") {
    const o = e.attrib.has("open") ? e.attrib.get("open") : "(";
    const c = e.attrib.has("close") ? e.attrib.get("close") : ")";
    const esc = (b) => ("{}".includes(b) ? "\\" + b : b);
    return "\\left" + (esc(o) || ".") + parts.join(",") + "\\right" + (esc(c) || ".");
  }
  if (tag === "mmultiscripts") return parts.join("");
  return null;
}

const X = {
  alternatives: re(String.raw`<(?:\w+:)?alternatives\b[^>]*>(.*?)</(?:\w+:)?alternatives>`, "SI"),
  texPreamble: re(String.raw`\\(?:documentclass|usepackage)(?:\[[^\]]*\])?\{[^}]*\}|\\(?:begin|end)\{document\}|`
    + String.raw`\\pagestyle\{[^}]*\}|\\setlength\{[^}]*\}\{[^}]*\}`),
  dollars: re(String.raw`^\$+|\$+$`),
  delims: re(String.raw`^\\\(|\\\)$|^\\\[|\\\]$`),
  alttext: re(String.raw`\balttext\s*=\s*\"([^\"]*)\"`),
  prefixTag: re(String.raw`<(/?)[\w.\-]+:`),
  prefixAttr: re(String.raw`\s[\w.\-]+:[\w.\-]+\s*=\s*(\"[^\"]*\"|'[^']*')`),
  xmlnsAttr: re(String.raw`\sxmlns\s*=\s*(\"[^\"]*\"|'[^']*')`),
  amp: re(String.raw`&(?!(?:lt|gt|amp|quot|apos|#\d+|#x[0-9a-fA-F]+);)(\w+;)?`),
};

function texIsland(m) {
  let t = htmlUnescape(m.group(1));
  t = X.texPreamble.sub("", t);
  t = pyStrip(ws(t));
  t = pyStrip(X.dollars.sub("", t));
  t = pyStrip(X.delims.sub("", t));
  return t ? "$" + t + "$" : "";
}

function mmlIsland(m) {
  let x = m.group(0);
  const alt = X.alttext.search(x);
  x = X.prefixTag.sub("<\\1", x);
  x = X.prefixAttr.sub("", x);
  x = X.xmlnsAttr.sub("", x);
  let tex = null;
  try {
    x = X.amp.sub((e) => (e.group(1) ? htmlUnescape(e.group(0)) : "&amp;"), x);
    tex = mmlTex(xmlFromString(x));
  } catch (err) {
    if (!(err instanceof XmlParseError || err instanceof MmlRecursion || err instanceof PyValueError)) throw err;
    tex = null;
  }
  if (tex === null && alt && alt.group(1).includes("\\")) tex = htmlUnescape(alt.group(1));
  if (tex === null) return " " + ws(stripTags(m.group(0))) + " ";
  tex = ws(tex);
  return tex ? "$" + tex + "$" : "";
}

// _mathml_to_tex(s): <mml:math> / <tex-math> islands -> $TeX$ (or their plain text when unparseable)
export function mathmlToTex(s) {
  s = X.alternatives.sub((m) => {
    const t = TEXMATH_RE.search(m.group(1));
    return t ? t.group(0) : m.group(1);
  }, s);
  s = TEXMATH_RE.sub(texIsland, s);
  return MML_RE.sub(mmlIsland, s);
}

// ---------------------------------------------------------------------------------------------------
// _clean_abstract: plain-text abstract from JATS/HTML; paragraphs separated by blank lines

const C = {
  wsRun: re(String.raw`\s+`),
  xref: re(String.raw`<(?:jats:)?xref\b[^>]*>.*?</(?:jats:)?xref>`, "SI"),
  sup: re(String.raw`<(?:jats:)?sup\b[^>]*>(.*?)</(?:jats:)?sup>`, "SI"),
  citeOnly: re(String.raw`[\d\s,;–—\-]+`),
  citeRange: re(String.raw`[,;–—\-]`),
  titleAbstract: re(String.raw`<(?:jats:)?title\b[^>]*>\s*(?:abstract|summary|graphical abstract)\s*`
    + String.raw`</(?:jats:)?title>`, "SI"),
  title: re(String.raw`<(?:jats:)?title\b[^>]*>(.*?)</(?:jats:)?title>`, "SI"),
  para: re(String.raw`</?(?:jats:)?p(?:\s+[\w:.\-]+\s*=\s*(?:\"[^\"]*\"|'[^']*'|[^\s\"'<>]+))*\s*/?>`, "I"),
  br: re(String.raw`<br\s*/?>`, "I"),
  paraSplit: re(String.raw`\n\s*\n`),
  colonBreak: re(String.raw`:\s*\n\n`),
  spaceBeforePunct: re(String.raw` +([,.;)\]])`),
  abstractWord: re(String.raw`^Abstract\b[\s:.\-–]*(?=[A-Z0-9])`),
};

function supRepl(m) {
  const inner = ws(stripMarkup(m.group(1)));
  const s = m.string;
  const startCp = cpIndex(s, m.index);
  const from = utf16Index(s, Math.max(0, startCp - 120));
  const before = cpSlice(pyRstrip(stripMarkup(s.slice(from, m.index))), -3);
  if (!inner) return "";
  if (C.citeOnly.fullmatch(inner)) {
    if (C.citeRange.search(inner)) return "";                       // citation range "1-4", "5,6"
    if (cpLen(before) >= 2 && pyIsAlpha(cpAt(before, -1)) && pyIsAlpha(cpAt(before, -2))) return "";
    if ([".", ")", "]", ","].includes(cpSlice(before, -1))) return "";
  }
  return !inner.includes(" ") ? "^" + inner : "^(" + inner + ")";
}

export function cleanAbstractMarkup(s) {
  if (!pyTruthy(s)) return "";
  s = pyStr(s);
  if (MARKUP_RE.search(s)) {
    s = C.wsRun.sub(" ", s);   // whitespace inside markup is not significant
    s = mathmlToTex(s);        // MathML / <tex-math> -> $TeX$ before the tags go
  }
  s = C.xref.sub("", s);
  s = C.sup.sub(supRepl, s);
  s = C.titleAbstract.sub("\n\n", s);
  s = C.title.sub((m) => "\n\n" + ws(stripMarkup(m.group(1))) + ": ", s);
  s = C.para.sub("\n\n", s);
  s = C.br.sub("\n\n", s);
  s = stripMarkup(unescapeEntities(stripMarkup(s)));
  const paras = C.paraSplit.split(s).map(ws);
  s = paras.filter((p) => p).join("\n\n");
  s = C.colonBreak.sub(": ", s);
  s = C.spaceBeforePunct.sub("\\1", s);
  s = C.abstractWord.sub("", s);
  return pyStrip(s);
}
export const _cleanAbstract = cleanAbstractMarkup;

// ---------------------------------------------------------------------------------------------------
// clean_abstract: readable abstract, markup stripped, TeX quotes/accents typographic, \ensuremath
// unwrapped, math kept as TeX between $...$. Idempotent.

export const ELEMENTS = new Set((
  "H He Li Be B C N O F Ne Na Mg Al Si P S Cl Ar K Ca Sc Ti V Cr Mn Fe Co Ni Cu Zn Ga Ge As Se "
  + "Br Kr Rb Sr Y Zr Nb Mo Tc Ru Rh Pd Ag Cd In Sn Sb Te I Xe Cs Ba La Ce Pr Nd Pm Sm Eu Gd Tb Dy "
  + "Ho Er Tm Yb Lu Hf Ta W Re Os Ir Pt Au Hg Tl Pb Bi Po At Rn Fr Ra Ac Th Pa U Np Pu").split(" "));
export const TEX_ACCENTS = {
  "'": "́", "`": "̀", "^": "̂", '"': "̈", "~": "̃",
  "=": "̄", ".": "̇", c: "̧", v: "̌", u: "̆", H: "̋",
};
export const MATH_SPLIT = re(String.raw`(\$\$.+?\$\$|(?<!\\)\$(?:\\.|[^$\\])+?\$|\\\(.+?\\\)|\\\[.+?\\\])`, "S");

const T = {
  elementRun: re("[A-Z][a-z]?"),
  dollar: re(String.raw`(?<!\\)\$`),
  cmd: re(String.raw`\\[A-Za-z]+|\S?`),
  ifmmode: re(String.raw`\\ifmmode\s*(.*?)\s*\\else\s*(.*?)\s*\\fi(?:\{\})?`, "S"),
  blankSpace: re(String.raw`\\[hv]?phantom\s*\{(?:[^{}]|\{(?:[^{}]|\{[^{}]*\})*\})*\}`
    + String.raw`|\\rule\s*(?:\[[^\]]*\])?\s*\{[^{}]*\}\s*\{[^{}]*\}`),
  periodCentered: re(String.raw`\\textperiodcentered(?:\{\})?`),
  tieStart: re(String.raw`^~(?=[^\s~])`),
  tieEnd: re(String.raw`(?<=[^\s/~\\])~$`),
  singleQuotes: re("`([^`'\\n]{1,80})'"),
  enDash: re(String.raw`(?<!-)--(?!-)`),
  accBraced: re(String.raw`\{\\([\'\`^\"~=.])\{?([A-Za-z])\}?\}`),
  accBare: re(String.raw`\\([\'\`^\"~=.])\{?([A-Za-z])\}?`),
  accLetter: re(String.raw`\\([cvuH])\{([A-Za-z])\}`),
  textCmd: re(String.raw`\\(?:emph|textit|textbf|textrm|textsf|texttt|textsc|textup|text|mbox)\{([^{}]*)\}`),
  fontSwitch: re(String.raw`\{\\(?:it|bf|em|rm|sc|sf|tt)\s+([^{}]*)\}`),
  group: re(String.raw`(\\[A-Za-z]+\s*)?(?<!\\)\{([^{}\\$]*)\}`),
  escaped: re(String.raw`\\([&%_#])`),
  tie: re(String.raw`(?<=[^\s/~\\])~(?=[^\s~])`),
  dots: re(String.raw`\\l?dots\b`),
  formula: re(String.raw`\b([A-Z][A-Za-z]{1,9}) (\d{1,2})(?=[\s,.;:)\]]|$)`),
  spaceBefore: re(String.raw`[ \t]+([,.;:!?)\]])`),
  spaceAfter: re(String.raw`([(\[])[ \t]+`),
  mathPunct: re(String.raw`^(.*?)\s*([,.;:])$`, "S"),
  paraSplit: re(String.raw`\n\s*\n`),
  wsRun: re(String.raw`\s+`),
};

// _formula_like(tok): MoS, WSe, GaAs: two or more chemical element symbols run together
export function formulaLike(tok) {
  const parts = T.elementRun.findall(tok);
  return parts.length >= 2 && parts.join("") === tok && parts.every((p) => ELEMENTS.has(p));
}

export function countDollars(s) {
  return T.dollar.findall(s).length;
}

export class PyRecursionError extends Error {
  constructor() { super("maximum recursion depth exceeded"); this.name = "RecursionError"; }
}
// Python raises RecursionError for \ensuremath{ nested this deep (direct call, warm regex cache)
export const ENSUREMATH_MAX_LEVEL = 994;

// _unwrap_ensuremath(s): \ensuremath{X} -> X inside math, $X$ outside it
export function unwrapEnsuremath(s, level = 0) {
  if (!s.includes("\\ensuremath")) return s;
  if (level > ENSUREMATH_MAX_LEVEL) throw new PyRecursionError();
  const out = [];
  let i = 0;
  for (;;) {
    const j = s.indexOf("\\ensuremath", i);
    if (j < 0) {
      out.push(s.slice(i));
      break;
    }
    out.push(s.slice(i, j));
    let k = j + "\\ensuremath".length;
    while (k < s.length && s[k] === " ") k++;
    let inner, end;
    if (k < s.length && s[k] === "{") {
      let depth = 0, e = k;
      while (e < s.length) {
        const c = s[e];
        if (c === "\\") { e += 2; continue; }
        if (c === "{") depth++;
        else if (c === "}") {
          depth--;
          if (depth === 0) break;
        }
        e++;
      }
      inner = s.slice(k + 1, e);
      end = e + 1;
    } else {
      inner = T.cmd.match(s.slice(k)).group(0);
      end = k + inner.length;
    }
    inner = unwrapEnsuremath(inner, level + 1);
    out.push(countDollars(out.join("")) % 2 ? inner : "$" + inner + "$");
    i = end;
  }
  return out.join("");
}

// _IFMMODE.sub(fn, s) without the hopeless searches. A match needs a "\ifmmode", a "\else" after it and a
// "\fi" after that. When the first "\ifmmode" left has no such pair, no later one has (each later one sees
// fewer), so the search stops there; re.sub would instead retry both lazy groups from every start, which is
// cubic (Python runs for minutes on "\ifmmode a \else " repeated 588 times). From a start that can match, the
// regex itself finds the match, so the groups and the text replaced are exactly re.sub's.
function ifmmodeSub(s, fn) {
  let out = "", last = 0;
  for (;;) {
    const p = s.indexOf("\\ifmmode", last);
    if (p < 0) break;
    const q = s.indexOf("\\else", p + 8);
    if (q < 0 || s.indexOf("\\fi", q + 5) < 0) break;
    const m = T.ifmmode.match(s, p);
    if (!m) return out + T.ifmmode.sub(fn, s.slice(last));   // not reached: the pattern has no lookbehind
    out += s.slice(last, p) + fn(m);
    last = m.end();
  }
  return last ? out + s.slice(last) : s;
}

// APS-style TeX nothing downstream knows: keep the \ifmmode branch for where it sits and turn
// spacing-only \phantom{..} / \rule{..}{..} into a thin space.
export function texResolve(s, math) {
  if (!s.includes("\\")) return s;
  s = ifmmodeSub(s, (m) => (math ? m.group(1) : m.group(2)));
  return math ? T.blankSpace.sub(String.raw`\\,`, s) : T.periodCentered.sub("·", s);
}

// a TeX tie against a math segment: $T_c$~K, Fig.~$2$
export function tieEdges(x, i, n) {
  if (i > 0) x = T.tieStart.sub(" ", x);
  return i < n - 1 ? T.tieEnd.sub(" ", x) : x;
}

const accent = (m) => normalize("NFC", m.group(2) + TEX_ACCENTS[m.group(1)]);

export function tidyText(t) {
  t = t.replaceAll("``", "“").replaceAll("''", "”");
  t = T.singleQuotes.sub((m) => "‘" + m.group(1) + "’", t);
  t = t.replaceAll("---", "—");
  t = T.enDash.sub("–", t);
  t = T.accBraced.sub(accent, t);
  t = T.accBare.sub(accent, t);
  t = T.accLetter.sub(accent, t);
  for (let k = 0; k < 2; k++) t = T.textCmd.sub("\\1", t);
  t = T.fontSwitch.sub("\\1", t);
  for (let k = 0; k < 2; k++) t = T.group.sub((m) => (m.group(1) ? m.group(0) : m.group(2)), t);
  t = T.escaped.sub("\\1", t);
  t = T.tie.sub(" ", t);
  t = T.dots.sub("…", t);
  t = T.formula.sub((m) => (formulaLike(m.group(1)) ? m.group(1) + m.group(2) : m.group(0)), t);
  t = T.spaceBefore.sub("\\1", t);
  t = T.spaceAfter.sub("\\1", t);
  return t;
}

export function tidyMath(m) {
  if (!m.startsWith("$") || m.startsWith("$$")) return m;
  const body = pyStrip(cpSlice(m, 1, -1));
  const mm = T.mathPunct.match(body);
  if (mm && pyStrip(mm.group(1)) && !mm.group(1).endsWith("\\")) return "$" + pyStrip(mm.group(1)) + "$" + mm.group(2);
  return body ? "$" + body + "$" : "";
}

// clean_abstract(text)
export function cleanAbstract(text) {
  if (!pyTruthy(text)) return "";
  let s = pyStr(text);
  if (!MARKUP_RE.search(s)) s = unescapeEntities(s);   // &lt;110&gt; in a plain abstract
  if (MARKUP_RE.search(s)) s = cleanAbstractMarkup(mathmlToTex(T.wsRun.sub(" ", s)));
  s = unwrapEnsuremath(s);
  const paras = [];
  for (let p of T.paraSplit.split(s)) {
    p = ws(p);
    if (!p) continue;
    const segs = MATH_SPLIT.split(p);
    p = segs.map((x, i) => (i % 2 ? tidyMath(texResolve(x, true))
      : tidyText(tieEdges(texResolve(x, false), i, segs.length)))).join("");
    paras.push(ws(p));
  }
  return paras.join("\n\n");
}
