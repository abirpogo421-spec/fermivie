// Library view: collections, item table, item pane (CONTRACT.md §5.1).
import * as mt from "./marktypes.js";
import * as journal from "./journal.js";
import * as commands from "./commands.js";
import * as undoLog from "./undo.js";
import { openBulkAdd } from "./bulkadd.js";
const LS = {
  widths: "pm2:lib:widths", cols: "pm2:lib:cols", sort: "pm2:lib:sort", open: "pm2:lib:expanded", abs: "pm2:lib:abstract",
};
const lsGet = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch (_) { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) {} };

const COLS = [
  { id: "title", label: "Title", w: 220, min: 120 },
  { id: "authors", label: "Authors", w: 150, min: 60 },
  { id: "year", label: "Year", w: 52, min: 40 },
  { id: "venue", label: "Venue", w: 130, min: 50 },
  { id: "marks", label: "Marks", w: 78, min: 44 },
  { id: "added", label: "Added", w: 86, min: 50 },
];
const ARXIV_RE = /\b(\d{4}\.\d{4,5})(v\d+)?\b/;
const DOI_RE = /\b10\.\d{4,9}\/[^\s"<>]+/;

/* ---------------------------------------------------------------- abstracts: clean text + math
   Same rules as importers.clean_abstract (so abstracts stored before it existed read cleanly too):
   markup stripped, \ensuremath unwrapped, TeX quotes/accents/dashes made typographic, math kept as
   $TeX$ and drawn with KaTeX (vendor/katex, loaded only when an abstract has math). */
const ELEMENTS = new Set(("H He Li Be B C N O F Ne Na Mg Al Si P S Cl Ar K Ca Sc Ti V Cr Mn Fe Co Ni Cu Zn Ga Ge As Se " +
  "Br Kr Rb Sr Y Zr Nb Mo Tc Ru Rh Pd Ag Cd In Sn Sb Te I Xe Cs Ba La Ce Pr Nd Pm Sm Eu Gd Tb Dy " +
  "Ho Er Tm Yb Lu Hf Ta W Re Os Ir Pt Au Hg Tl Pb Bi Po At Rn Fr Ra Ac Th Pa U Np Pu").split(" "));
// "MoS" + "2" (from "MoS 2"): two or more element symbols run together
const formulaLike = (tok) => { const p = tok.match(/[A-Z][a-z]?/g) || []; return p.length >= 2 && p.join("") === tok && p.every((x) => ELEMENTS.has(x)); };
// "MoS2", "Bi2Se3", "YBa2Cu3O7": element symbols with counts, ending in a count
const chemLike = (tok) => /\d$/.test(tok) && formulaLike(tok.replace(/\d+/g, ""));
const ACC = { "'": "́", "`": "̀", "^": "̂", '"': "̈", "~": "̃", "=": "̄", ".": "̇", c: "̧", v: "̌", u: "̆", H: "̋" };
const MATH_SPLIT = /(\$\$[\s\S]+?\$\$|(?<!\\)\$(?:\\.|[^$\\])+?\$|\\\([\s\S]+?\\\)|\\\[[\s\S]+?\\\])/;
// Only real JATS / HTML / MathML tags count as markup (a known name, or a prefixed one like jats:p);
// plain-text inequalities such as "k<k_F and k>k_F" or a decoded "&lt;x&gt;" stay as written.
const MARKUP_NAMES = "p|br|hr|sub|sup|i|b|u|s|em|strong|small|big|span|div|font|a|tt|code|q|cite|abbr|mark|del|ins|strike|" +
  "h[1-6]|ul|ol|li|dl|dt|dd|blockquote|pre|img|table|thead|tbody|tfoot|tr|td|th|caption|figure|" +
  "italic|bold|underline|overline|roman|sc|monospace|sans-serif|xref|title|sec|abstract|trans-abstract|" +
  "label|list|list-item|fn|fig|graphic|inline-graphic|media|ext-link|uri|email|named-content|" +
  "styled-content|inline-formula|disp-formula|tex-math|alternatives|math|semantics|annotation|" +
  "annotation-xml|m(?:i|n|o|s|text|row|sub|sup|subsup|frac|sqrt|root|over|under|underover|fenced|style|" +
  "space|padded|phantom|enclose|table|tr|td|multiscripts|prescripts|error|glyph)|none|break|" +
  "chem-struct|chem-struct-wrap|disp-quote|attrib|def-list|def-item|term|def|statement|boxed-text|p-group";
const TAG_SRC = `</?(?:[A-Za-z][\\w.-]*:[A-Za-z][\\w.-]*|(?:${MARKUP_NAMES}))(?:\\s+[A-Za-z_:][\\w:.-]*\\s*=\\s*(?:"[^"]*"|'[^']*'|[^\\s"'<>]+))*\\s*/?>`;
const TAG_RE = new RegExp(TAG_SRC, "i");
const stripTags = (s) => s.replace(new RegExp(TAG_SRC, "gi"), "");
// complete entities only (&lt; &amp; &#x3c7;), decoded without running any markup
const ENTITY_RE = /&(?:[A-Za-z][A-Za-z0-9]{1,31}|#[0-9]{1,7}|#[xX][0-9A-Fa-f]{1,6});/g;
let entityBox = null;
function unescapeEntities(s) {
  if (!s.includes("&")) return s;
  entityBox = entityBox || document.createElement("textarea");
  return s.replace(ENTITY_RE, (e) => { entityBox.innerHTML = e; return entityBox.value; });
}

function unwrapEnsuremath(s) {
  if (!s.includes("\\ensuremath")) return s;
  let out = "", i = 0;
  for (;;) {
    const j = s.indexOf("\\ensuremath", i);
    if (j < 0) { out += s.slice(i); break; }
    out += s.slice(i, j);
    let k = j + 11, inner, end;
    while (s[k] === " ") k++;
    if (s[k] === "{") {
      let depth = 0, e = k;
      for (; e < s.length; e++) {
        if (s[e] === "\\") { e++; continue; }
        if (s[e] === "{") depth++;
        else if (s[e] === "}" && --depth === 0) break;
      }
      inner = s.slice(k + 1, e); end = e + 1;
    } else { inner = (/^\\[A-Za-z]+|^\S?/.exec(s.slice(k)) || [""])[0]; end = k + inner.length; }
    inner = unwrapEnsuremath(inner);
    out += ((out.match(/(?<!\\)\$/g) || []).length % 2) ? inner : "$" + inner + "$";
    i = end;
  }
  return out;
}
// APS-style TeX that KaTeX and the fallbacks don't know: keep the \ifmmode branch for where it sits
// (math: \cdot, text: \v{c}) and turn spacing-only \phantom{..} / \rule{..}{..} into a thin space.
const IFMMODE = /\\ifmmode\s*([\s\S]*?)\s*\\else\s*([\s\S]*?)\s*\\fi(?:\{\})?/g;
const BLANK_SPACE = /\\[hv]?phantom\s*\{(?:[^{}]|\{(?:[^{}]|\{[^{}]*\})*\})*\}|\\rule\s*(?:\[[^\]]*\])?\s*\{[^{}]*\}\s*\{[^{}]*\}/g;
function texResolve(s, math) {
  if (!s.includes("\\")) return s;
  s = s.replace(IFMMODE, (_, m, t) => (math ? m : t));
  return math ? s.replace(BLANK_SPACE, "\\,") : s.replace(/\\textperiodcentered(?:\{\})?/g, "·");
}
// a TeX tie against a math segment: $T_c$~K, Fig.~$2$
function tieEdges(x, i, n) {
  if (i > 0) x = x.replace(/^~(?=[^\s~])/, " ");
  return i < n - 1 ? x.replace(/(?<=[^\s/~\\])~$/, " ") : x;
}
function tidyText(t) {
  const acc = (_, a, ch) => (ch + ACC[a]).normalize("NFC");
  t = t.replace(/``/g, "“").replace(/''/g, "”").replace(/`([^`'\n]{1,80})'/g, "‘$1’");
  t = t.replace(/---/g, "—").replace(/(?<!-)--(?!-)/g, "–");
  t = t.replace(/\{\\(['`^"~=.])\{?([A-Za-z])\}?\}/g, acc).replace(/\\(['`^"~=.])\{?([A-Za-z])\}?/g, acc).replace(/\\([cvuH])\{([A-Za-z])\}/g, acc);
  for (let n = 0; n < 2; n++) t = t.replace(/\\(?:emph|textit|textbf|textrm|textsf|texttt|textsc|textup|text|mbox)\{([^{}]*)\}/g, "$1");
  t = t.replace(/\{\\(?:it|bf|em|rm|sc|sf|tt)\s+([^{}]*)\}/g, "$1");
  // TeX grouping braces in running text: {MoS}$_2$ -> MoS$_2$ (\cmd{...} is kept)
  for (let n = 0; n < 2; n++) t = t.replace(/(\\[A-Za-z]+\s*)?(?<!\\)\{([^{}\\$]*)\}/g, (m, cmd, x) => (cmd ? m : x));
  t = t.replace(/\\([&%_#])/g, "$1").replace(/\\l?dots\b/g, "…");
  t = t.replace(/(?<=[^\s/~\\])~(?=[^\s~])/g, " ");   // TeX tie: 300~K, Ref.~[3] (not ~10 or /~user)
  t = t.replace(/\b([A-Z][A-Za-z]{1,9}) (\d{1,2})(?=[\s,.;:)\]]|$)/g, (m, a, b) => (formulaLike(a) ? a + b : m));
  return t.replace(/[ \t]+([,.;:!?)\]])/g, "$1").replace(/([(\[])[ \t]+/g, "$1");
}
function tidyMath(m) {
  if (!m.startsWith("$") || m.startsWith("$$")) return m;
  const body = m.slice(1, -1).trim();
  const mm = /^([\s\S]*?)\s*([,.;:])$/.exec(body);
  if (mm && mm[1].trim() && !mm[1].endsWith("\\")) return "$" + mm[1].trim() + "$" + mm[2];
  return body ? "$" + body + "$" : "";
}
function stripMarkup(s) {
  s = s.replace(/\s+/g, " ").replace(/<(?:\w+:)?(?:xref)\b[^>]*>[\s\S]*?<\/(?:\w+:)?xref>/gi, "")
    .replace(/<(?:\w+:)?title\b[^>]*>\s*(?:abstract|summary)\s*<\/(?:\w+:)?title>/gi, "\n\n")
    .replace(/<\/?(?:\w+:)?p(?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'<>]+))*\s*\/?>|<br\s*\/?>/gi, "\n\n")
    .replace(/<(?:\w+:)?sup\b[^>]*>([\s\S]*?)<\/(?:\w+:)?sup>/gi, (m, x) => "^" + stripTags(x).trim());
  s = stripTags(unescapeEntities(stripTags(s)));   // twice: escaped markup (&lt;i&gt;) is markup too
  return s.replace(/^\s*Abstract\b[\s:.\-–]*(?=[A-Z0-9])/, "");
}
export function cleanAbstract(text) {
  if (!text) return "";
  let s = String(text);
  if (!TAG_RE.test(s)) s = unescapeEntities(s);   // &lt;110&gt; in a plain abstract
  if (TAG_RE.test(s)) s = stripMarkup(s);
  s = unwrapEnsuremath(s);
  return s.split(/\n\s*\n/).map((p) => p.replace(/\s+/g, " ").trim()).filter(Boolean)
    .map((p) => p.split(MATH_SPLIT).map((x, i, a) => (i % 2 ? tidyMath(texResolve(x, true)) : tidyText(tieEdges(texResolve(x, false), i, a.length)))).join("").replace(/\s+/g, " ").trim())
    .join("\n\n");
}

const SYM = {
  alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ϵ", varepsilon: "ε", zeta: "ζ", eta: "η", theta: "θ", vartheta: "ϑ",
  iota: "ι", kappa: "κ", lambda: "λ", mu: "μ", nu: "ν", xi: "ξ", pi: "π", rho: "ρ", sigma: "σ", tau: "τ", upsilon: "υ",
  phi: "ϕ", varphi: "φ", chi: "χ", psi: "ψ", omega: "ω", Gamma: "Γ", Delta: "Δ", Theta: "Θ", Lambda: "Λ", Xi: "Ξ", Pi: "Π",
  Sigma: "Σ", Upsilon: "Υ", Phi: "Φ", Psi: "Ψ", Omega: "Ω", hbar: "ℏ", ell: "ℓ", pm: "±", mp: "∓", times: "×", cdot: "·",
  approx: "≈", sim: "∼", simeq: "≃", le: "≤", leq: "≤", ge: "≥", geq: "≥", ne: "≠", neq: "≠", ll: "≪", gg: "≫", infty: "∞",
  partial: "∂", nabla: "∇", to: "→", rightarrow: "→", leftarrow: "←", leftrightarrow: "↔", propto: "∝", langle: "⟨", rangle: "⟩",
  circ: "∘", prime: "′", int: "∫", sum: "∑", prod: "∏", parallel: "∥", perp: "⊥", in: "∈", ldots: "…", cdots: "⋯", dots: "…",
  equiv: "≡", uparrow: "↑", downarrow: "↓", degree: "°", AA: "Å", Re: "Re", Im: "Im", quad: " ", qquad: "  ",
};
const SUB = { 0: "₀", 1: "₁", 2: "₂", 3: "₃", 4: "₄", 5: "₅", 6: "₆", 7: "₇", 8: "₈", 9: "₉", "+": "₊", "-": "₋", "=": "₌", "(": "₍", ")": "₎" };
const SUP = { 0: "⁰", 1: "¹", 2: "²", 3: "³", 4: "⁴", 5: "⁵", 6: "⁶", 7: "⁷", 8: "⁸", 9: "⁹", "+": "⁺", "-": "⁻", "=": "⁼", "(": "⁽", ")": "⁾", n: "ⁿ", i: "ⁱ" };

// TeX -> DOM nodes without KaTeX: Greek letters, sub/superscripts, bold; unknown commands show their name
function texNodes(tex) {
  let i = 0;
  const txt = (s) => document.createTextNode(s);
  const group = () => { const f = document.createDocumentFragment(); while (i < tex.length) { if (tex[i] === "}") { i++; break; } f.append(atom()); } return f; };
  const arg = () => { while (tex[i] === " ") i++; if (tex[i] === "{") { i++; return group(); } return i < tex.length ? atom() : txt(""); };
  function atom() {
    const c = tex[i];
    if (c === "{") { i++; return group(); }
    if (c === "}") { i++; return txt(""); }
    if (c === "_" || c === "^") { i++; const e = document.createElement(c === "_" ? "sub" : "sup"); e.append(arg()); return e; }
    if (c !== "\\") { i++; return txt(c === "~" ? " " : c === "-" ? "−" : c); }
    const m = /^\\([A-Za-z]+|.)/.exec(tex.slice(i)) || ["\\", ""]; i += m[0].length;
    const n = m[1];
    if (/^(mathbf|boldsymbol|bm|textbf)$/.test(n)) { const b = document.createElement("b"); b.append(arg()); return b; }
    if (/^(mathit|mathrm|mathsf|mathtt|mathcal|mathbb|mathscr|text|textrm|textit|emph|mbox|operatorname|ensuremath|hat|tilde|bar|vec|dot|ddot|overline|underline|widetilde|widehat|left|right|big|Big|bigl|bigr|Bigl|Bigr)$/.test(n)) return /^(left|right|big|Big|bigl|bigr|Bigl|Bigr)$/.test(n) ? txt("") : arg();
    if (n === "frac") { const f = document.createDocumentFragment(); const a = arg(), b = arg(); f.append(a, "/", b); return f; }
    if (n === "sqrt") { const f = document.createDocumentFragment(); f.append("√(", arg(), ")"); return f; }
    if (SYM[n]) return txt(SYM[n]);
    if (/^[,;: !>]$/.test(n)) return txt(" ");
    if (/^[{}%$&#_|]$/.test(n)) return txt(n);
    return txt(n);
  }
  const out = document.createDocumentFragment();
  while (i < tex.length) out.append(atom());
  return out;
}
// TeX -> a plain string for one-line places (titles in the table): χ₂, WTe₂, k·p
export function texPlain(s) {
  if (!s || !/[$\\]/.test(s)) return s || "";
  return String(s).split(MATH_SPLIT).map((x, i, a) => {
    if (!(i % 2)) return tieEdges(texResolve(x, false), i, a.length).replace(/\\([&%_#$])/g, "$1");
    const tex = texResolve(x.replace(/^\$\$?|\$\$?$|^\\[([]|\\[)\]]$/g, ""), true).replace(/\\[,;: >]/g, " ").replace(/\\!/g, "");
    const map = (str, tbl) => [...str].every((ch) => tbl[ch]) ? [...str].map((ch) => tbl[ch]).join("") : null;
    let t = tex.replace(/\\([A-Za-z]+)/g, (m, n) => SYM[n] || (/^(math\w+|text\w*|operatorname|mbox|left|right|ensuremath|boldsymbol)$/.test(n) ? "" : n));
    // sub/superscripts with a Unicode form (WTe₂, χ⁽²⁾); the rest as plain text: T_c -> Tc, k_F -> kF, e^{ikx} -> e^(ikx)
    t = t.replace(/([_^])\{([^{}]*)\}|([_^])(\S)/g, (m, a, b, c, d) => {
      const op = a || c, v = (b ?? d).replace(/\s+/g, "");
      const u = map(v, op === "_" ? SUB : SUP);
      if (u != null) return u;
      return op === "_" || /^[*†‡′″]+$/.test(v) ? v : "^" + (v.length > 1 ? "(" + v + ")" : v);
    });
    return t.replace(/[{}]/g, "").replace(/\\/g, "").replace(/-/g, "−");
  }).join("");
}
// TeX -> DOM for one-line titles: real sub/superscripts (T<sub>c</sub>, WTe<sub>2</sub>) where the text has math
export function texRich(s) {
  const f = document.createDocumentFragment();
  if (!s || !/[$\\]/.test(s)) { f.append(s || ""); return f; }
  String(s).split(MATH_SPLIT).forEach((x, i, a) => {
    if (!(i % 2)) { f.append(tieEdges(texResolve(x, false), i, a.length).replace(/\\([&%_#$])/g, "$1")); return; }
    const tex = texResolve(x.replace(/^\$\$?|\$\$?$/g, "").replace(/^\\[([]|\\[)\]]$/g, ""), true);
    const span = document.createElement("span");
    span.className = "tex-inline";
    span.append(texNodes(tex));
    f.append(span);
  });
  return f;
}

let katexP = null;
export function loadKatex() {
  if (window.katex) return Promise.resolve(window.katex);
  if (katexP) return katexP;
  const onload = (node) => new Promise((res, rej) => { node.onload = res; node.onerror = () => rej(new Error("Couldn't load " + (node.src || node.href))); });
  const css = Object.assign(document.createElement("link"), { rel: "stylesheet", href: "vendor/katex/katex.min.css" });
  const js = Object.assign(document.createElement("script"), { src: "vendor/katex/katex.min.js", async: true });
  const both = Promise.all([onload(css), onload(js)]);
  document.head.append(css, js);
  katexP = both.then(async () => {
    if (!window.katex) throw new Error("KaTeX did not load");
    // wait (briefly) for the main fonts so the swap from plain text happens once, without a second reflow
    const fonts = document.fonts ? Promise.all(["16px KaTeX_Main", "italic 16px KaTeX_Math"].map((f) => document.fonts.load(f))) : null;
    if (fonts) await Promise.race([fonts, new Promise((r) => setTimeout(r, 600))]).catch(() => {});
    return window.katex;
  }).catch((e) => { katexP = null; css.remove(); js.remove(); throw e; });
  return katexP;
}
const KATEX_OPTS = { throwOnError: true, strict: "ignore", trust: false, maxExpand: 200, macros: { "\\ensuremath": "#1", "\\textperiodcentered": "\\cdot" } };
const hasMath = (s) => MATH_SPLIT.test(s);

// plain text with chemical formulas (WTe2 -> WTe₂) and ^powers (10^5) set as sub/superscripts
function textNodes(t) {
  const f = document.createDocumentFragment();
  const re = /\b((?:[A-Z][a-z]?\d*){2,8})(?![\w])|\^(\([^)]{1,30}\)|[\w+\-−]{1,12})/g;
  let last = 0, m;
  while ((m = re.exec(t))) {
    if (m[1] && !chemLike(m[1])) continue;
    f.append(t.slice(last, m.index));
    if (m[1]) for (const part of m[1].split(/(\d+)/)) { if (!part) continue; if (/^\d/.test(part)) { const s = document.createElement("sub"); s.textContent = part; f.append(s); } else f.append(part); }
    else { const s = document.createElement("sup"); s.textContent = m[2].replace(/^\((.*)\)$/, "$1"); f.append(s); }
    last = m.index + m[0].length;
  }
  f.append(t.slice(last));
  return f;
}
function mathNode(seg, katex) {
  const display = seg.startsWith("$$") || seg.startsWith("\\[");
  const tex = seg.replace(/^\$\$?|\$\$?$/g, "").replace(/^\\[([]|\\[)\]]$/g, "").trim();
  // $\mathit{actual}$ is emphasis in the running text, not maths
  const word = /^\\(?:mathit|textit|emph|it|mathrm|textrm|text|mbox)\s*\{([A-Za-z][A-Za-z \-]{2,})\}$/.exec(tex);
  if (word) { const e = document.createElement(/^\\(?:mathrm|textrm|text|mbox)/.test(tex) ? "span" : "em"); e.textContent = word[1]; return e; }
  const span = document.createElement("span");
  span.className = "ab-math" + (display ? " ab-math--display" : "");
  if (katex) {
    try { katex.render(tex, span, { ...KATEX_OPTS, displayMode: display }); span.classList.add("is-tex"); return span; }
    catch (_) { span.textContent = ""; }
  }
  span.append(texNodes(tex));
  span.title = tex;
  return span;
}
// Fill `box` with the abstract as paragraphs. Math is drawn with KaTeX once it has loaded (plain until then).
export function renderAbstract(box, raw) {
  const text = cleanAbstract(raw);
  const draw = (katex) => {
    const frag = document.createDocumentFragment();
    for (const para of text.split("\n\n")) {
      const p = document.createElement("p");
      p.className = "ip-abs__p";
      para.split(MATH_SPLIT).forEach((seg, i) => p.append(i % 2 ? mathNode(seg, katex) : textNodes(seg.replace(/\\\$/g, "$"))));
      frag.append(p);
    }
    box.replaceChildren(frag);
  };
  box.dataset.src = text;
  if (!hasMath(text) || window.katex) { draw(window.katex || null); return; }
  draw(null);
  loadKatex().then((k) => { if (box.isConnected && box.dataset.src === text) draw(k); })
    .catch((e) => console.warn("KaTeX unavailable; abstracts stay as plain text.", e && e.message));
}
// a one-line plain version (no markup, math as χ₂-style text) for snippets and tooltips
export function abstractPlain(raw) { return texPlain(cleanAbstract(raw)).replace(/\n\n/g, " "); }

export function mountLibrary(rootEl, ctx) {
  const { store, api, ui } = ctx;
  const { el, h, icon } = ui;

  /* ---------------------------------------------------------------- state */
  let route = { name: "library", filter: "all" };
  let sel = new Set();          // selected item keys
  let cursor = null;            // keyboard focus row key
  let anchor = null;            // shift-click anchor
  let rows = [];                // visible item keys in order
  let query = "";
  let ftHits = new Map();       // key -> Set("notes" | "marks")
  let ftSeq = 0, ftAbort = null;
  const tagFilter = new Set();
  let sort = lsGet(LS.sort, { col: "added", dir: -1 });
  const colW = Object.assign(Object.fromEntries(COLS.map((c) => [c.id, c.w])), lsGet(LS.cols, {}));
  const widths = Object.assign({ side: 220, pane: 340 }, lsGet(LS.widths, {}));
  const expanded = lsGet(LS.open, {});
  let paneKey = null;           // what the item pane shows (key | "multi" | "none:<proj>")
  let visible = false;
  let narrowPane = false, narrowSide = false;   // toggled open in narrow windows

  /* ---------------------------------------------------------------- layout */
  const wrap = el("div", "lib");
  const tb = el("div", "toolbar lib-toolbar");
  const bSide = h("button", { class: "ibtn lib-only-narrow-side", title: "Show collections", "aria-label": "Show collections", onclick: () => toggleNarrow("side") }, icon("sidebar-left"));
  const bNewProj = h("button", { class: "ibtn", title: "New Project", "aria-label": "New Project", onclick: () => newProject(null) }, icon("folder-plus"));
  // labels sit in spans so a narrow library can show the buttons as icons (css: .is-narrow-side);
  // the lib-tb__nic icons show only then, the others always
  const tbLabel = (t) => h("span", { class: "lib-tb__label" }, t);
  const bAdd = h("button", { class: "btn", title: "Add Paper", "aria-label": "Add Paper", onclick: () => openAdd() }, icon("plus"), tbLabel("Add Paper"));
  const bTypes = h("button", { class: "btn", title: "What each kind of mark is for", "aria-label": "Mark Types", onclick: () => mt.openEditor() }, icon("sliders"), tbLabel("Mark Types"));
  const bEmpty = h("button", { class: "btn", hidden: true, title: "Empty Trash", "aria-label": "Empty Trash", onclick: () => emptyTrash() }, icon("trash", "lib-tb__nic"), tbLabel("Empty Trash…"));
  const bOrder = h("button", { class: "btn", hidden: true, title: "Show the project's own sections and order again", "aria-label": "Project order", onclick: () => { psort[route.id] = "custom"; lsSet(LSP.psort, psort); renderHead(); renderTable(); } }, icon("restore", "lib-tb__nic"), tbLabel("Project order"));
  const bSection = h("button", { class: "btn", hidden: true, title: "Add a section to this project", "aria-label": "New Section", onclick: () => newSection(null) }, icon("outline", "lib-tb__nic"), tbLabel("New Section"));
  const searchIn = h("input", { class: "input", type: "search", placeholder: "Search titles, authors, notes, marks", "aria-label": "Search library", spellcheck: false });
  const search = h("label", { class: "search lib-search" }, icon("search"), searchIn);
  const bPane = h("button", { class: "ibtn lib-only-narrow-pane", title: "Show item pane", "aria-label": "Show item pane", onclick: () => toggleNarrow("pane") }, icon("sidebar-right"));
  tb.append(bSide, bNewProj, bAdd, bEmpty, bSection, bOrder, el("div", "grow"), bTypes, search, bPane);

  const body = el("div", "lib-body");
  const side = el("div", "lib-side");
  const collEl = el("div", "lib-coll"); collEl.setAttribute("role", "tree"); collEl.setAttribute("aria-label", "Collections");
  const tagsEl = el("div", "lib-tags");
  side.append(collEl, tagsEl);
  const split1 = el("div", "splitter");
  const main = el("div", "lib-main");
  const thead = el("div", "lib-thead"); thead.setAttribute("role", "row");
  const tbody = el("div", "lib-tbody"); tbody.tabIndex = 0; tbody.setAttribute("role", "grid"); tbody.setAttribute("aria-label", "Papers"); tbody.setAttribute("aria-multiselectable", "true");
  main.append(thead, tbody);
  const split2 = el("div", "splitter");
  const pane = el("div", "lib-pane");
  body.append(side, split1, main, split2, pane);
  wrap.append(tb, body);
  rootEl.textContent = "";   // drop the shell's "still loading" placeholder
  rootEl.append(wrap);

  function applyWidths() {
    side.style.width = widths.side + "px";
    pane.style.width = widths.pane + "px";
  }
  // When the list is narrower than its columns, drop the least useful ones (Venue, then Added, Year,
  // Authors) instead of cutting them off behind a sideways scroll.
  const DROP = ["venue", "added", "year", "authors"];
  let hiddenCols = new Set();
  function applyCols() {
    const avail = main.clientWidth;
    const titleMin = COLS[0].min;
    hiddenCols = new Set();
    // Venue and Added go before Title drops below its preferred width; Year and Authors (what tells
    // papers apart) stay until Title would drop below its minimum
    let others = COLS.reduce((s, c) => s + (c.id === "title" ? 0 : colW[c.id]), 0);
    if (avail > 0) for (const id of DROP) {
      if ((id === "venue" || id === "added" ? colW.title : titleMin) + others <= avail) continue;
      hiddenCols.add(id); others -= colW[id];
    }
    const shown = COLS.filter((c) => !hiddenCols.has(c.id));
    const titleW = avail > 0 ? Math.max(titleMin, Math.min(colW.title, avail - others)) : colW.title;
    const tpl = shown.map((c) => (c.id === "title" ? `minmax(${titleW}px, 1fr)` : colW[c.id] + "px")).join(" ");
    main.style.setProperty("--lib-cols", tpl);
    main.style.setProperty("--lib-minw", titleW + others + "px");
    for (const c of COLS) main.classList.toggle("hide-" + c.id, hiddenCols.has(c.id));
  }
  applyWidths(); applyCols();

  function dragSplit(splitter, which) {
    splitter.addEventListener("pointerdown", (ev) => {
      ev.preventDefault();
      splitter.setPointerCapture(ev.pointerId);
      splitter.classList.add("dragging");
      const x0 = ev.clientX, w0 = widths[which];
      const move = (e) => {
        const dx = e.clientX - x0;
        widths[which] = ui.clamp(which === "side" ? w0 + dx : w0 - dx, which === "side" ? 150 : 260, which === "side" ? 420 : 640);
        applyWidths();
      };
      const up = () => { splitter.classList.remove("dragging"); splitter.removeEventListener("pointermove", move); splitter.removeEventListener("pointerup", up); lsSet(LS.widths, widths); };
      splitter.addEventListener("pointermove", move);
      splitter.addEventListener("pointerup", up);
    });
  }
  dragSplit(split1, "side"); dragSplit(split2, "pane");

  /* ---------------------------------------------------------------- narrow windows */
  // measured on the library itself (not the window), so vertical tabs or a split screen count too
  const mqPane = { matches: false }, mqSide = { matches: false };
  function applyNarrow() {
    const w = wrap.clientWidth;
    if (w > 0) { mqPane.matches = w < 1000; mqSide.matches = w < 720; }
    wrap.classList.toggle("is-narrow-pane", mqPane.matches);
    wrap.classList.toggle("is-narrow-side", mqSide.matches);
    wrap.classList.toggle("show-pane", mqPane.matches && narrowPane);
    wrap.classList.toggle("show-side", mqSide.matches && narrowSide);
    bPane.setAttribute("aria-pressed", String(narrowPane));
    bSide.setAttribute("aria-pressed", String(narrowSide));
  }
  // the narrow overlays close on a click outside them (a row click keeps the item pane: it follows the selection)
  wrap.addEventListener("mousedown", (ev) => {
    const t = ev.target;
    if (narrowPane && mqPane.matches && !pane.contains(t) && !bPane.contains(t) && !t.closest(".lib-row")) { narrowPane = false; applyNarrow(); }
    if (narrowSide && mqSide.matches && !side.contains(t) && !bSide.contains(t)) { narrowSide = false; applyNarrow(); }
  });
  function toggleNarrow(which) {
    if (which === "pane") narrowPane = !narrowPane; else narrowSide = !narrowSide;
    applyNarrow();
  }
  let lastW = -1, lastMain = -1;
  const libRO = new ResizeObserver(() => {
    const w = wrap.clientWidth, mw = main.clientWidth;
    if (w !== lastW) { lastW = w; applyNarrow(); }
    if (mw !== lastMain) { lastMain = mw; applyCols(); }
  });
  libRO.observe(wrap); libRO.observe(main);
  applyNarrow();

  /* ---------------------------------------------------------------- scope + filtering */
  const isTrash = () => route.filter === "trash";
  function inScope(it, r = route) {
    if (r.filter === "trash") return !!it.trashed;
    if (it.trashed) return false;
    switch (r.filter) {
      case "unfiled": return !(it.projects || []).length;
      case "recent": return !!it.opened;
      case "marked": return store.markCounts(it.key).total > 0;
      case "project": { const ids = store.projectTree(r.id); return (it.projects || []).some((p) => ids.includes(p)); }
      default: return true;
    }
  }
  const scopeItems = (r = route) => Object.values(store.lib.items).filter((it) => inScope(it, r));
  // titles as the table shows them (WTe$_2$ -> WTe₂) and without accents, sub/superscripts folded
  // (NFKD: ₂ -> 2, á -> a), so WTe2, WTe₂ and Kormanyos find what is on screen; "k · p" also as k·p and kp
  const fold = (s) => String(s == null ? "" : s).normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
  function matchesQuery(it, q) {
    const shown = texPlain(it.title), dots = /\s*[·⋅∙]\s*/g;
    const hay = fold([it.title, shown, shown.replace(dots, "·"), shown.replace(dots, ""), ui.authorsFull(it.authors), (it.authors || []).map((a) => a.family).join(" "), it.venue, it.year, (it.tags || []).join(" "), it.doi, it.arxiv].join(" "));
    return fold(q).split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
  }
  function visibleItems() {
    const q = query.trim().toLowerCase();
    let list = scopeItems();
    if (tagFilter.size) list = list.filter((it) => [...tagFilter].every((t) => (it.tags || []).includes(t)));
    if (q) list = list.filter((it) => matchesQuery(it, q) || ftHits.has(it.key));
    return sortItems(list);
  }
  const firstAuthor = (it) => ((it.authors || [])[0] || {}).family || ((it.authors || [])[0] || {}).given || "";
  function sortVal(it, col) {
    switch (col) {
      case "title": return (it.title || "").toLowerCase();
      case "authors": return firstAuthor(it).toLowerCase();
      case "year": return it.year || 0;
      case "venue": return (it.venue || "").toLowerCase();
      case "marks": return store.markCounts(it.key).total;
      case "added": return it.added || "";
      case "opened": return it.opened || "";
      default: return "";
    }
  }
  // Recently Opened lists papers by when they were last opened (newest first) until a column is clicked there
  let recentByCol = false;
  const sortNow = () => (route.filter === "recent" && !recentByCol ? { col: "opened", dir: -1 } : sort);
  function sortItems(list) {
    const { col, dir } = sortNow();
    return list.sort((a, b) => {
      const x = sortVal(a, col), y = sortVal(b, col);
      let c = typeof x === "number" ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true, sensitivity: "base" });
      if (!c) c = (a.title || "").localeCompare(b.title || "");
      return c * dir;
    });
  }

  /* ---------------------------------------------------------------- project sections
     A project keeps its papers in sections of the user's own (default: To mark, Reference) and in a
     custom order inside each, which is its priority. Stored on the project as sections + placement. */
  const DEFAULT_SECTIONS = [{ id: "mark", name: "To mark" }, { id: "ref", name: "Reference" }];
  const LSP = { psort: "pm2:lib:psort", collapsed: "pm2:lib:collapsed" };
  let psort = lsGet(LSP.psort, {});            // pid -> "custom" | "sorted"
  let collapsed = lsGet(LSP.collapsed, {});    // pid:sid -> true
  const projectMode = () => route.filter === "project" && !isTrash() && store.project(route.id);
  const customOrder = () => projectMode() && (psort[route.id] || "custom") === "custom";
  function layoutOf(pid) {
    const p = store.project(pid) || {};
    const sections = p.sections && p.sections.length ? p.sections : DEFAULT_SECTIONS;
    return { sections, placement: p.placement || {} };
  }
  function placeOf(it, L) {
    const pl = L.placement[it.key];
    if (pl && L.sections.some((x) => x.id === pl.section)) return pl;
    // not placed yet: papers with marks start in the first section, the rest in the last
    const sec = store.markCounts(it.key).total > 0 ? L.sections[0].id : L.sections[L.sections.length - 1].id;
    return { section: sec, rank: 1e6 + (Date.parse(it.added || 0) || 0) / 1e12 };
  }
  // the project's papers grouped by section, in order
  function grouped(list) {
    const L = layoutOf(route.id);
    const by = new Map(L.sections.map((x) => [x.id, []]));
    for (const it of list) by.get(placeOf(it, L).section).push(it);
    for (const [sid, arr] of by) {
      if (customOrder()) arr.sort((a, b) => placeOf(a, L).rank - placeOf(b, L).rank);
      else sortItems(arr);
    }
    return L.sections.map((x) => ({ ...x, items: by.get(x.id) }));
  }
  // write a new order: groups = [{id, keys:[...]}] for every section
  async function saveLayout(sections, groups) {
    const placement = {};
    for (const g of groups) g.keys.forEach((k, i) => { placement[k] = { section: g.id, rank: i + 1 }; });
    try { await store.setProjectLayout(route.id, { sections: sections.map(({ id, name }) => ({ id, name })), placement }); }
    catch (e) { ui.toast(e.message, { error: true }); }
  }
  function currentGroups() {
    const all = scopeItems();
    return grouped(all).map((g) => ({ id: g.id, name: g.name, keys: g.items.map((i) => i.key) }));
  }
  async function moveKeys(keys, sid, index) {
    // index: position inside section sid (after removing the moved keys); -1 = end
    const L = layoutOf(route.id), groups = currentGroups();
    for (const g of groups) g.keys = g.keys.filter((k) => !keys.includes(k));
    const g = groups.find((x) => x.id === sid) || groups[0];
    const at = index < 0 || index > g.keys.length ? g.keys.length : index;
    g.keys.splice(at, 0, ...keys);
    await saveLayout(L.sections, groups);
  }
  // a search or tag filter hides papers, so ranks and ⌥↑/⌥↓ must use the full section order
  function filtering() { return !!(query.trim() || tagFilter.size); }
  // a paper moved into a collapsed section opens it, so the paper stays in view (and selected)
  function openSection(sid) {
    const ck = route.id + ":" + sid;
    if (collapsed[ck]) { delete collapsed[ck]; lsSet(LSP.collapsed, collapsed); }
  }
  async function nudge(key, dir) {
    if (!customOrder()) { ui.toast("Switch to the project's own order to move papers (click “Project order”)."); return; }
    if (filtering()) { ui.toast("Clear the search and tag filters to reorder papers."); return; }
    const groups = currentGroups();
    const g = groups.find((x) => x.keys.includes(key)); if (!g) return;
    const i = g.keys.indexOf(key), j = i + dir;
    if (j < 0 || j >= g.keys.length) {
      // past the edge: into the neighbouring section
      const gi = groups.indexOf(g) + dir; if (gi < 0 || gi >= groups.length) return;
      g.keys.splice(i, 1); dir < 0 ? groups[gi].keys.push(key) : groups[gi].keys.unshift(key);
      openSection(groups[gi].id);   // before saveLayout: its "layout" re-render must list the key, or the selection drops it
    } else { g.keys.splice(i, 1); g.keys.splice(j, 0, key); }
    await saveLayout(layoutOf(route.id).sections, groups);
  }
  async function newSection(after) {
    const name = await ui.promptDialog({ title: "New section", message: "Sections group a project's papers, e.g. To mark, Reading next, Background, Cited.", placeholder: "Section name", ok: "Add" });
    if (!name || !name.trim()) return;
    const L = layoutOf(route.id), groups = currentGroups();
    const ids = new Set(L.sections.map((x) => x.id));
    let id = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 20) || "section", n = 2;
    while (ids.has(id)) id = id.slice(0, 20) + "-" + n++;
    const secs = [...L.sections];
    const at = after ? secs.findIndex((x) => x.id === after) + 1 : secs.length;
    secs.splice(at, 0, { id, name: name.trim() });
    groups.splice(at, 0, { id, name: name.trim(), keys: [] });
    await saveLayout(secs, groups);
  }
  function sectionMenu(sec, at) {
    const L = layoutOf(route.id), i = L.sections.findIndex((x) => x.id === sec.id);
    const swap = async (j) => {
      const secs = [...L.sections], groups = currentGroups();
      [secs[i], secs[j]] = [secs[j], secs[i]]; [groups[i], groups[j]] = [groups[j], groups[i]];
      await saveLayout(secs, groups);
    };
    ui.menu([
      { label: "Rename…", action: async () => {
        const name = await ui.promptDialog({ title: "Rename section", value: sec.name, ok: "Rename" });
        if (!name || !name.trim()) return;
        await saveLayout(L.sections.map((x) => x.id === sec.id ? { ...x, name: name.trim() } : x), currentGroups());
      } },
      { label: "New Section Below…", action: () => newSection(sec.id) },
      "-",
      { label: "Move Section Up", disabled: i <= 0, action: () => swap(i - 1) },
      { label: "Move Section Down", disabled: i >= L.sections.length - 1, action: () => swap(i + 1) },
      "-",
      { label: "Delete Section…", disabled: L.sections.length <= 1, action: async () => {
        const groups = currentGroups(), g = groups[i], to = groups[i === 0 ? 1 : 0];
        if (g.keys.length) {
          const ok = await ui.confirmDialog({ title: `Delete “${sec.name}”?`, message: `Its ${g.keys.length} ${g.keys.length === 1 ? "paper moves" : "papers move"} to “${to.name}”. Nothing is removed from the project.`, ok: "Delete Section" });
          if (!ok) return;
        }
        to.keys.push(...g.keys);
        await saveLayout(L.sections.filter((x) => x.id !== sec.id), groups.filter((x) => x !== g));
      } },
    ], at);
  }
  function sectionHeader(g, count) {
    const hd = el("div", "lib-section");
    hd.setAttribute("role", "row"); hd.dataset.sid = g.id;
    const ck = route.id + ":" + g.id, closed = !!collapsed[ck];
    const tw = h("button", { class: "lib-section__tw", "aria-label": closed ? "Expand section" : "Collapse section", "aria-expanded": String(!closed),
      onclick: () => { collapsed[ck] = !closed; if (!collapsed[ck]) delete collapsed[ck]; lsSet(LSP.collapsed, collapsed); renderTable(); } }, icon(closed ? "chev-right" : "chev-down"));
    hd.append(tw, el("span", "lib-section__name", g.name), el("span", "lib-section__n num", String(count)));
    if (customOrder()) hd.append(el("span", "lib-section__hint", count || filtering() ? "" : "Drag papers here"));
    const more = h("button", { class: "ibtn lib-section__more", title: "Section options", "aria-label": "Section options", onclick: (ev) => sectionMenu(g, ev.currentTarget) }, icon("more"));
    hd.append(el("span", "grow"), more);
    hd.addEventListener("contextmenu", (ev) => { ev.preventDefault(); sectionMenu(g, { x: ev.clientX, y: ev.clientY }); });
    return hd;
  }

  /* ---------------------------------------------------------------- collections */
  const sameRoute = (a, b) => a.filter === b.filter && (a.filter !== "project" || a.id === b.id);
  function collRow(r, label, ic, count, depth = 0, opts = {}) {
    const row = el("div", "coll-row");
    row.setAttribute("role", "treeitem"); row.tabIndex = -1;
    row.style.paddingLeft = 8 + depth * 14 + "px";
    if (sameRoute(r, route)) { row.classList.add("is-sel"); row.setAttribute("aria-selected", "true"); }
    const tw = el("span", "coll-twisty");
    if (opts.kids) {
      tw.append(icon(opts.open ? "chev-down" : "chev-right"));
      tw.addEventListener("click", (ev) => { ev.stopPropagation(); expanded[r.id] = !opts.open; lsSet(LS.open, expanded); renderColl(); });
      row.setAttribute("aria-expanded", String(!!opts.open));
    }
    row.append(tw, icon(ic), el("span", "coll-label", label));
    if (count != null) row.append(el("span", "coll-count num", count ? String(count) : ""));
    row.addEventListener("click", () => { closeNarrowSide(); ctx.openLibrary(r); });
    if (r.filter === "project") {
      row.dataset.pid = r.id;
      row.addEventListener("contextmenu", (ev) => { ev.preventDefault(); projectMenu(r.id, { x: ev.clientX, y: ev.clientY }); });
      row.addEventListener("dragover", (ev) => {
        if (![...ev.dataTransfer.types].includes("application/x-pm-keys")) return;
        ev.preventDefault(); ev.dataTransfer.dropEffect = "copy"; row.classList.add("is-drop");
      });
      row.addEventListener("dragleave", () => row.classList.remove("is-drop"));
      row.addEventListener("drop", async (ev) => {
        row.classList.remove("is-drop");
        const raw = ev.dataTransfer.getData("application/x-pm-keys");
        if (!raw) return;
        ev.preventDefault(); ev.stopPropagation();
        try {
          const keys = JSON.parse(raw);
          await store.bulk({ keys, addProjects: [r.id] });
          const p = store.project(r.id);
          ui.toast(keys.length === 1 ? `Added to ${p ? p.name : "project"}.` : `Added ${keys.length} papers to ${p ? p.name : "project"}.`);
        } catch (e) { ui.toast(e.message, { error: true }); }
      });
    }
    return row;
  }
  function closeNarrowSide() { if (narrowSide) { narrowSide = false; applyNarrow(); } }
  function countFor(r) { return scopeItems(r).length; }
  function renderColl() {
    const hadFocus = collEl.contains(document.activeElement), sideTop = side.scrollTop;
    collEl.textContent = "";
    collEl.append(
      collRow({ name: "library", filter: "all" }, "My Library", "library", countFor({ filter: "all" })),
      collRow({ name: "library", filter: "unfiled" }, "Unfiled", "inbox", null),
      collRow({ name: "library", filter: "recent" }, "Recently Opened", "clock", null),
      collRow({ name: "library", filter: "marked" }, "With Marks", "mark", null),
      collRow({ name: "library", filter: "trash" }, "Trash", "trash", null),
    );
    const head = el("div", "coll-head");
    head.append(el("span", "grow", "Projects"), h("button", { class: "ibtn coll-add", title: "New Project", "aria-label": "New Project", onclick: () => newProject(null) }, icon("plus")));
    collEl.append(head);
    const walk = (parent, depth) => {
      const kids = store.childrenOf(parent).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
      for (const p of kids) {
        const sub = store.childrenOf(p.id).length > 0;
        const open = expanded[p.id] !== false;
        collEl.append(collRow({ name: "library", filter: "project", id: p.id }, p.name, "folder", countFor({ filter: "project", id: p.id }), depth, { kids: sub, open }));
        if (sub && open) walk(p.id, depth + 1);
      }
    };
    walk(null, 0);
    if (!store.lib.projects.length) collEl.append(el("div", "coll-hint", "No projects yet."));
    const selRow = collEl.querySelector(".coll-row.is-sel") || collEl.querySelector(".coll-row");
    if (selRow) selRow.tabIndex = 0;                   // one tab stop for the whole tree
    if (hadFocus && selRow) selRow.focus({ preventScroll: true });   // keep keyboard focus across re-renders
    renderTags();
    side.scrollTop = sideTop;
  }
  // ↑ ↓ move through the collections, → ← open / close a project, ↵ or ⇥ go to the paper list
  collEl.addEventListener("keydown", (ev) => {
    const all = [...collEl.querySelectorAll(".coll-row")];
    const cur = ev.target.closest(".coll-row"); if (!cur) return;
    const i = all.indexOf(cur);
    if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
      ev.preventDefault();
      const nx = all[ui.clamp(i + (ev.key === "ArrowDown" ? 1 : -1), 0, all.length - 1)];
      if (nx && nx !== cur) { nx.focus(); nx.click(); }
    } else if ((ev.key === "ArrowRight" || ev.key === "ArrowLeft") && cur.dataset.pid && cur.hasAttribute("aria-expanded")) {
      ev.preventDefault();
      const open = cur.getAttribute("aria-expanded") === "true";
      if (open !== (ev.key === "ArrowRight")) { expanded[cur.dataset.pid] = !open; lsSet(LS.open, expanded); renderColl(); }
    } else if (ev.key === "Enter") {
      ev.preventDefault(); tbody.focus(); if (rows.length && !sel.size) selectOnly(rows[0]);
    }
  });
  function renderTags() {
    registerTagCommands();
    tagsEl.textContent = "";
    const tags = store.allTags(scopeItems());
    for (const t of [...tagFilter]) if (!tags.some(([n]) => n === t)) tagFilter.delete(t);
    if (!tags.length) return;
    tagsEl.append(el("div", "coll-head", "Tags"));
    const box = el("div", "tag-cloud");
    for (const [t] of tags) {
      const b = h("button", { class: "tag-link" + (tagFilter.has(t) ? " is-on" : ""), "aria-pressed": String(tagFilter.has(t)) }, t);
      b.addEventListener("click", () => { tagFilter.has(t) ? tagFilter.delete(t) : tagFilter.add(t); renderTags(); renderTable(); });
      box.append(b);
    }
    tagsEl.append(box);
  }

  /* ---------------------------------------------------------------- projects */
  async function newProject(parent) {
    const name = await ui.promptDialog({ title: parent ? "New subproject" : "New project", label: "Project name", placeholder: "Project name", ok: "Create" });
    if (!name || !name.trim()) return;
    try {
      const p = await store.createProject(name.trim(), parent);
      if (parent) { expanded[parent] = true; lsSet(LS.open, expanded); }
      ctx.openLibrary({ name: "library", filter: "project", id: p.id });
    } catch (e) { ui.toast(e.message, { error: true }); }
  }
  function projectMenu(id, at) {
    const p = store.project(id); if (!p) return;
    ui.menu([
      { label: "Rename…", action: async () => {
        const name = await ui.promptDialog({ title: "Rename project", value: p.name, ok: "Rename" });
        if (name && name.trim() && name.trim() !== p.name) { try { await store.renameProject(id, name.trim()); } catch (e) { ui.toast(e.message, { error: true }); } }
      } },
      { label: "New Subproject…", action: () => newProject(id) },
      { label: "Export BibTeX", action: () => {
        const a = h("a", { href: api.bibtexUrl({ project: id }), download: (p.name || "project").replace(/[^\w.-]+/g, "_") + ".bib" });
        document.body.append(a); a.click(); a.remove();
      } },
      "-",
      { label: "Delete Project…", action: async () => {
        const ok = await ui.confirmDialog({ title: `Delete “${p.name}”?`, message: "The papers stay in My Library. Its subprojects move up a level.", ok: "Delete Project", danger: true });
        if (!ok) return;
        try {
          const wasHere = route.filter === "project" && store.projectTree(id).includes(route.id);
          await store.deleteProject(id);
          undoLog.clear();
          if (wasHere) ctx.openLibrary({ name: "library", filter: "all" });
        } catch (e) { ui.toast(e.message, { error: true }); }
      } },
    ], at);
  }
  function currentProject() { return route.filter === "project" && route.id && store.project(route.id) ? route.id : null; }

  /* ---------------------------------------------------------------- table */
  function renderHead() {
    thead.textContent = "";
    for (const c of COLS) {
      const cell = el("div", "th th--" + c.id);
      cell.setAttribute("role", "columnheader");
      cell.append(el("span", "th__label", c.label));
      if (sortNow().col === c.id && !customOrder()) { cell.classList.add("is-sorted"); cell.append(icon("chev-down", "th__dir" + (sort.dir > 0 ? " is-asc" : ""))); cell.setAttribute("aria-sort", sort.dir > 0 ? "ascending" : "descending"); }
      cell.addEventListener("click", () => {
        if (cell.dataset.resized) { delete cell.dataset.resized; return; }
        const fresh = { col: c.id, dir: ["added", "marks", "year"].includes(c.id) ? -1 : 1 };
        if (customOrder()) { psort[route.id] = "sorted"; lsSet(LSP.psort, psort); sort = fresh; }
        else if (route.filter === "recent" && !recentByCol) { recentByCol = true; sort = fresh; }
        else sort = sort.col === c.id ? { col: c.id, dir: -sort.dir } : { col: c.id, dir: ["added", "marks", "year"].includes(c.id) ? -1 : 1 };
        lsSet(LS.sort, sort); renderHead(); renderTable();
      });
      const grip = el("div", "th__grip");
      grip.addEventListener("pointerdown", (ev) => {
        ev.preventDefault(); ev.stopPropagation();
        grip.setPointerCapture(ev.pointerId);
        const x0 = ev.clientX, w0 = c.id === "title" ? cell.getBoundingClientRect().width : colW[c.id];
        const move = (e) => { colW[c.id] = Math.round(ui.clamp(w0 + e.clientX - x0, c.min, 900)); cell.dataset.resized = "1"; applyCols(); };
        const up = () => { grip.removeEventListener("pointermove", move); grip.removeEventListener("pointerup", up); lsSet(LS.cols, colW); setTimeout(() => delete cell.dataset.resized, 0); };
        grip.addEventListener("pointermove", move); grip.addEventListener("pointerup", up);
      });
      grip.addEventListener("click", (ev) => ev.stopPropagation());
      cell.append(grip);
      thead.append(cell);
    }
  }
  function cell(cls, text, title) { const c = el("div", "td td--" + cls, text); if (title) c.title = title; return c; }
  function markCell(key) {
    const m = store.markCounts(key);
    const c = el("div", "td td--marks num");
    if (m.total) {
      // the total, plus a thin bar showing how the marks split across types
      c.append(el("span", "mk-n", String(m.total)));
      const bar = el("span", "mk-bar");
      const parts = [];
      const ids = mt.all().map((t) => t.id);
      Object.keys(m).forEach((k) => { if (k !== "total" && k !== "error" && typeof m[k] === "number" && !ids.includes(k)) ids.push(k); });
      for (const id of ids) if (m[id] > 0) {
        const seg = el("span", "mk-seg " + mt.cls(id));
        seg.style.flexGrow = String(m[id]);
        bar.append(seg);
        parts.push(`${m[id]} ${mt.get(id).name}`);
      }
      bar.title = parts.join(", ");
      c.append(bar);
    }
    return c;
  }
  function rowFor(it, rank) {
    const r = el("div", "lib-row");
    r.setAttribute("role", "row"); r.dataset.key = it.key; r.draggable = true;
    if (sel.has(it.key)) { r.classList.add("is-sel"); r.setAttribute("aria-selected", "true"); }
    if (cursor === it.key) r.classList.add("is-cursor");
    if (it.trashed) r.classList.add("is-trashed");
    if (it.read === "unread" && !it.opened) r.classList.add("is-unread");
    const t = el("div", "td td--title");
    const shown = texPlain(it.title);
    t.title = shown;
    if (rank) t.append(el("span", "td__rank num", String(rank)));
    const tt = el("span", "td__text");
    if (shown) tt.append(texRich(it.title)); else tt.textContent = "Untitled";
    t.append(tt);
    if (!(it.attachments || []).length) t.append(el("span", "td__note", "no PDF"));
    const hit = ftHits.get(it.key);
    if (hit && query.trim() && !matchesQuery(it, query.trim().toLowerCase())) t.append(el("span", "td__note", "in " + [...hit].join(", ")));
    else if (hit && query.trim()) t.append(el("span", "td__note", "also in " + [...hit].join(", ")));
    r.append(
      t,
      cell("authors", ui.authorsShort(it.authors), ui.authorsFull(it.authors)),
      cell("year num", it.year ? String(it.year) : ""),
      cell("venue", it.venue || "", it.venue || ""),
      markCell(it.key),
      cell("added num", ui.dateShort(it.added), ui.dateLong(it.added)),
    );
    return r;
  }
  function emptyText() {
    if (query.trim() || tagFilter.size) return "No papers match.";
    switch (route.filter) {
      case "project": return "No papers in this project yet. Add one with Add Paper or drop a PDF here.";
      case "unfiled": return "Every paper is in at least one project.";
      case "recent": return "Papers you open will show up here.";
      case "marked": return "Papers with marks will show up here.";
      case "trash": return "The trash is empty.";
      default: return "Your library is empty. Add a paper with Add Paper or drop a PDF here.";
    }
  }
  function renderTable() {
    const list = visibleItems();
    rows = list.map((it) => it.key);
    // keep the selection to what is visible
    for (const k of [...sel]) if (!rows.includes(k)) sel.delete(k);
    if (cursor && !rows.includes(cursor)) cursor = null;
    const st = tbody.scrollTop;
    tbody.textContent = "";
    // a filter that matches nothing says so (not empty section headers inviting a drag)
    if (projectMode() && scopeItems().length && (list.length || !filtering())) {
      const frag = document.createDocumentFragment();
      rows = [];
      const full = customOrder() && filtering() ? currentGroups() : null;   // a filtered row keeps its real rank
      for (const g of grouped(list)) {
        frag.append(sectionHeader(g, g.items.length));
        if (collapsed[route.id + ":" + g.id]) continue;
        const order = full && (full.find((x) => x.id === g.id) || {}).keys;
        g.items.forEach((it, i) => { frag.append(rowFor(it, customOrder() ? (order ? order.indexOf(it.key) + 1 : i + 1) : 0)); rows.push(it.key); });
      }
      tbody.append(frag);
      for (const k of [...sel]) if (!rows.includes(k)) sel.delete(k);
    } else if (!list.length) {
      const e = el("div", "empty", emptyText());
      if (!store.items().length && !store.items({ trashed: true }).length) {   // a brand-new library: offer the profile
        e.append(el("br"), h("button", { class: "btn lib-empty__btn", onclick: async () => {
          const s = await import("./settings.js");
          const j = await api.profileAct("choose", { prompt: "Choose your Paper Marker profile folder" }).catch((err) => { ui.toast(err.message, { error: true }); return {}; });
          if (j.path) s.loadProfile(j.path);
        } }, "Load your profile…"));
      }
      tbody.append(e);
    }
    else { const frag = document.createDocumentFragment(); list.forEach((it) => frag.append(rowFor(it))); tbody.append(frag); }
    tbody.querySelectorAll(".lib-row").forEach((r, i) => { if (i % 2) r.classList.add("is-alt"); });
    tbody.scrollTop = st;
    bEmpty.hidden = !isTrash();
    bOrder.hidden = !(projectMode() && !customOrder());
    bSection.hidden = !projectMode();
    renderPane();
  }
  function refreshSel() {
    for (const r of tbody.querySelectorAll(".lib-row")) {
      const on = sel.has(r.dataset.key);
      r.classList.toggle("is-sel", on);
      on ? r.setAttribute("aria-selected", "true") : r.removeAttribute("aria-selected");
      r.classList.toggle("is-cursor", r.dataset.key === cursor);
    }
    renderPane();
  }
  function scrollToKey(key) {
    const r = tbody.querySelector(`.lib-row[data-key="${CSS.escape(key)}"]`);
    if (r) r.scrollIntoView({ block: "nearest" });
  }
  function selectOnly(key) { sel = new Set(key ? [key] : []); cursor = key; anchor = key; refreshSel(); if (key) scrollToKey(key); }

  tbody.addEventListener("mousedown", (ev) => {
    const r = ev.target.closest(".lib-row");
    if (!r) { if (ev.target === tbody || ev.target.classList.contains("empty")) { sel.clear(); cursor = null; refreshSel(); } return; }
    const k = r.dataset.key;
    if (ev.button === 2) { if (!sel.has(k)) selectOnly(k); return; }
    if (ev.shiftKey && anchor && rows.includes(anchor)) {
      const a = rows.indexOf(anchor), b = rows.indexOf(k);
      const range = rows.slice(Math.min(a, b), Math.max(a, b) + 1);
      sel = new Set(ev.metaKey || ev.ctrlKey ? [...sel, ...range] : range); cursor = k;
      refreshSel();
    } else if (ev.metaKey || ev.ctrlKey) {
      sel.has(k) ? sel.delete(k) : sel.add(k); cursor = k; anchor = k; refreshSel();
    } else if (!sel.has(k) || sel.size === 1) selectOnly(k);
    else { cursor = k; r.dataset.pending = "1"; }
  });
  tbody.addEventListener("click", (ev) => {
    const r = ev.target.closest(".lib-row");
    if (r && r.dataset.pending) { delete r.dataset.pending; if (!ev.metaKey && !ev.ctrlKey && !ev.shiftKey) selectOnly(r.dataset.key); }
  });
  tbody.addEventListener("dblclick", (ev) => { const r = ev.target.closest(".lib-row"); if (r) openItem(r.dataset.key); });
  tbody.addEventListener("dragstart", (ev) => {
    const r = ev.target.closest(".lib-row"); if (!r) return;
    delete r.dataset.pending;
    const keys = sel.has(r.dataset.key) ? rows.filter((k) => sel.has(k)) : [r.dataset.key];
    ev.dataTransfer.setData("application/x-pm-keys", JSON.stringify(keys));
    ev.dataTransfer.setData("text/plain", keys.map((k) => (store.item(k) || {}).title || k).join("\n"));
    ev.dataTransfer.effectAllowed = "copyMove";
    const ghost = el("div", "lib-drag-ghost", keys.length === 1 ? ui.shortTitle((store.item(keys[0]) || {}).title, 50) : `${keys.length} papers`);
    document.body.append(ghost); ev.dataTransfer.setDragImage(ghost, 10, 10); setTimeout(() => ghost.remove(), 0);
  });
  // drop target inside the table: before/after a row, or into a section (its end)
  function dropTarget(ev) {
    const r = ev.target.closest(".lib-row, .lib-section");
    if (!r) return null;
    if (r.classList.contains("lib-section")) return { el: r, sid: r.dataset.sid, index: 0, cls: "is-drop-into" };
    const L = layoutOf(route.id), it = store.item(r.dataset.key); if (!it) return null;
    const sid = placeOf(it, L).section;
    const g = currentGroups().find((x) => x.id === sid);
    const box = r.getBoundingClientRect(), after = ev.clientY > box.top + box.height / 2;
    return { el: r, sid, key: r.dataset.key, after, index: g.keys.indexOf(r.dataset.key) + (after ? 1 : 0), cls: after ? "is-drop-after" : "is-drop-before" };
  }
  let dropEl = null;
  const clearDrop = () => { if (dropEl) dropEl.classList.remove("is-drop-before", "is-drop-after", "is-drop-into"); dropEl = null; };
  tbody.addEventListener("dragover", (ev) => {
    if (!customOrder() || ![...ev.dataTransfer.types].includes("application/x-pm-keys")) return;
    const t = dropTarget(ev); clearDrop(); if (!t) return;
    ev.preventDefault(); ev.dataTransfer.dropEffect = "move";
    dropEl = t.el; dropEl.classList.add(t.cls);
  });
  tbody.addEventListener("dragleave", (ev) => { if (!tbody.contains(ev.relatedTarget)) clearDrop(); });
  tbody.addEventListener("drop", async (ev) => {
    if (!customOrder()) return;
    const raw = ev.dataTransfer.getData("application/x-pm-keys"); const t = dropTarget(ev); clearDrop();
    if (!raw || !t) return;
    ev.preventDefault(); ev.stopPropagation();
    const keys = JSON.parse(raw).filter((k) => scopeItems().some((i) => i.key === k));
    if (!keys.length) return;
    // the target index counts the moved keys that sit above it in the same section
    const g = currentGroups().find((x) => x.id === t.sid);
    const above = g ? g.keys.slice(0, t.index).filter((k) => keys.includes(k)).length : 0;
    await moveKeys(keys, t.sid, t.el.classList.contains("lib-section") ? -1 : t.index - above);
  });
  tbody.addEventListener("dragend", clearDrop);

  tbody.addEventListener("contextmenu", (ev) => {
    const r = ev.target.closest(".lib-row"); if (!r) return;
    ev.preventDefault();
    if (!sel.has(r.dataset.key)) selectOnly(r.dataset.key);
    itemMenu(rows.filter((k) => sel.has(k)), { x: ev.clientX, y: ev.clientY });
  });

  tbody.addEventListener("keydown", (ev) => listKey(ev));
  // the list's keys; returns true when the key was used
  function listKey(ev) {
    const mod = ev.metaKey || ev.ctrlKey;
    if ((ev.key === "ArrowDown" || ev.key === "ArrowUp") && !ev.altKey) {
      ev.preventDefault();
      if (!rows.length) return;
      const i = cursor ? rows.indexOf(cursor) : -1;
      const j = ui.clamp(i < 0 ? 0 : i + (ev.key === "ArrowDown" ? 1 : -1), 0, rows.length - 1);
      const k = rows[j];
      if (ev.shiftKey && anchor) {
        const a = rows.indexOf(anchor);
        sel = new Set(rows.slice(Math.min(a, j), Math.max(a, j) + 1)); cursor = k; refreshSel(); scrollToKey(k);
      } else selectOnly(k);
    } else if (ev.key === "Home" || ev.key === "End") {
      ev.preventDefault(); if (rows.length) selectOnly(ev.key === "Home" ? rows[0] : rows[rows.length - 1]);
    } else if (ev.key === "Enter") {
      ev.preventDefault(); const k = cursor && sel.has(cursor) ? cursor : rows.find((x) => sel.has(x)); if (k) openItem(k);
    } else if (ev.key === "Delete" || ev.key === "Backspace") {
      ev.preventDefault(); const keys = rows.filter((k) => sel.has(k)); if (keys.length && !isTrash()) trashKeys(keys);
    } else if (mod && ev.key.toLowerCase() === "a") {
      ev.preventDefault(); sel = new Set(rows); refreshSel();
    } else if (mod && ev.key.toLowerCase() === "c" && sel.size && String(window.getSelection() || "").trim() === "") {
      ev.preventDefault(); const keys = rows.filter((k) => sel.has(k)); ev.shiftKey ? copyCite(keys) : copyBib(keys);
    } else if (ev.altKey && (ev.key === "ArrowUp" || ev.key === "ArrowDown") && projectMode() && sel.size === 1) {
      ev.preventDefault(); const k = [...sel][0]; nudge(k, ev.key === "ArrowUp" ? -1 : 1).then(() => { cursor = k; refreshSel(); scrollToKey(k); });
    } else if (ev.key === "Escape" && query) { ev.preventDefault(); clearSearch(); }
    else return false;
    return true;
  }
  // Back in the Library (⌥1, the Library tab, first load) focus is often on <body> or the tab bar:
  // the list still answers its keys, and Escape closes the narrow-window overlays.
  const overlayOpen = () => { const o = document.getElementById("overlay-root"); return !!(o && o.children.length) || !!document.querySelector("dialog[open], .scrim"); };
  const LIST_KEYS = new Set(["ArrowDown", "ArrowUp", "Home", "End", "Enter", "Delete", "Backspace"]);
  // focus that fell to <body> out of the item pane (a control rebuilt under the keyboard, a dialog
  // closed after its opener was rebuilt) was not on the list: ⌫ / ↵ must not trash or open the paper
  let focusFromPane = false;
  document.addEventListener("focusin", (ev) => { focusFromPane = pane.contains(ev.target); }, true);
  document.addEventListener("keydown", (ev) => {
    if (ev.defaultPrevented || !libShown() || overlayOpen()) return;
    const a = document.activeElement;
    const idle = !a || a === document.body || a === document.documentElement;
    if (ev.key === "Escape" && (wrap.classList.contains("show-pane") || wrap.classList.contains("show-side")) && (idle || wrap.contains(a))) {
      ev.preventDefault(); narrowPane = false; narrowSide = false; applyNarrow();
      if (idle || pane.contains(a) || side.contains(a)) tbody.focus({ preventScroll: true });
      return;
    }
    if (!idle) return;
    if (focusFromPane && (ev.key === "Delete" || ev.key === "Backspace" || ev.key === "Enter")) return;
    const mod = ev.metaKey || ev.ctrlKey;
    if ((LIST_KEYS.has(ev.key) && !mod) || (mod && !ev.altKey && /^[ac]$/i.test(ev.key))) {
      tbody.focus({ preventScroll: true });
      listKey(ev);
    }
  });
  function focusList() {
    const a = document.activeElement;
    if (!libShown() || overlayOpen()) return;
    // only take focus that nobody else holds: <body>, the tab bar, or an element of a hidden view
    if (a && a !== document.body && !a.closest("#tabbar, .tabbar") && a.offsetParent !== null) return;
    tbody.focus({ preventScroll: true });
  }

  /* ---------------------------------------------------------------- item actions */
  function openItem(key, attKey) {
    const it = store.item(key); if (!it) return;
    const att = attKey ? (it.attachments || []).find((a) => a.key === attKey) : store.primaryAtt(it);
    if (!att) { ui.toast("This paper has no PDF yet. Add one in the Attachments section.", { error: true }); return; }
    ctx.openReader(key, att.key);
  }
  async function trashKeys(keys) {
    if (keys.length > 1) {
      const ok = await ui.confirmDialog({ title: `Move ${keys.length} papers to the Trash?`, message: "You can restore them from the Trash.", ok: "Move to Trash" });
      if (!ok) return;
    }
    // the row after the first trashed one (or the new last row), worked out before the list re-renders
    const before = rows.slice(), i = Math.min(...keys.map((k) => before.indexOf(k)).filter((x) => x >= 0));
    const rest = before.filter((k) => !keys.includes(k));
    try {
      await store.bulk({ keys, trash: true });
      const next = rest[Math.max(0, Math.min(i, rest.length - 1))];
      if (next && rows.includes(next)) selectOnly(next);
      ui.toast(keys.length === 1 ? "Moved to the Trash." : `Moved ${keys.length} papers to the Trash.`);
    } catch (e) { ui.toast(e.message, { error: true }); }
  }
  async function restoreKeys(keys) {
    try { await store.bulk({ keys, restore: true }); ui.toast(keys.length === 1 ? "Restored." : `Restored ${keys.length} papers.`); }
    catch (e) { ui.toast(e.message, { error: true }); }
  }
  async function copyBib(keys) {
    try { const t = await api.bibtex({ keys }); await ui.copyText(typeof t === "string" ? t : (t.bibtex || "")); ui.toast("BibTeX copied."); }
    catch (e) { ui.toast(e.message, { error: true }); }
  }
  // the papers shown in the list right now (view + search + tag filter), as a .bib file
  async function exportList() {
    const keys = visibleItems().map((it) => it.key);
    if (!keys.length) { ui.toast("There are no papers in this list to export."); return; }
    const pid = currentProject(), p = pid && store.project(pid);
    const names = { all: "library", unfiled: "unfiled", recent: "recently-opened", marked: "with-marks", trash: "trash" };
    const base = (p ? p.name : names[route.filter] || "library") + (query.trim() || tagFilter.size ? "-filtered" : "");
    try {
      const t = await api.bibtex({ keys });
      const url = URL.createObjectURL(new Blob([typeof t === "string" ? t : t.bibtex || ""], { type: "text/plain" }));
      const a = h("a", { href: url, download: base.replace(/[^\w.-]+/g, "_") + ".bib" });
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      ui.toast(keys.length === 1 ? "Exported 1 paper." : `Exported ${keys.length} papers.`);
    } catch (e) { ui.toast(e.message, { error: true }); }
  }
  async function copyCite(keys) {
    await ui.copyText(keys.map((k) => ui.citation(store.item(k))).join("\n"));
    ui.toast(keys.length === 1 ? "Citation copied." : "Citations copied.");
  }
  async function setRead(keys, read) {
    try {
      if (keys.length === 1) await store.patchItem(keys[0], { read });
      else await store.bulk({ keys, read });
    } catch (e) { ui.toast(e.message, { error: true }); }
  }
  function projectSubmenu(keys, adding) {
    const out = [];
    const walk = (parent, depth) => {
      for (const p of store.childrenOf(parent).sort((a, b) => a.name.localeCompare(b.name))) {
        const all = keys.every((k) => ((store.item(k) || {}).projects || []).includes(p.id));
        out.push({ label: " ".repeat(depth) + p.name, checked: adding ? all : undefined, disabled: adding && all, action: async () => {
          try { await store.bulk({ keys, addProjects: [p.id] }); ui.toast(`Added to ${p.name}.`); } catch (e) { ui.toast(e.message, { error: true }); }
        } });
        walk(p.id, depth + 1);
      }
    };
    walk(null, 0);
    if (!out.length) out.push({ label: "No projects yet", disabled: true });
    out.push("-", { label: "New Project…", action: async () => {
      const name = await ui.promptDialog({ title: "New project", placeholder: "Project name", ok: "Create" });
      if (!name || !name.trim()) return;
      try { const p = await store.createProject(name.trim(), null); await store.bulk({ keys, addProjects: [p.id] }); ui.toast(`Added to ${p.name}.`); }
      catch (e) { ui.toast(e.message, { error: true }); }
    } });
    return out;
  }
  function itemMenu(keys, at) {
    if (!keys.length) return;
    const one = keys.length === 1 ? store.item(keys[0]) : null;
    const atts = one ? one.attachments || [] : [];
    const anyUnread = keys.some((k) => (store.item(k) || {}).read !== "read");
    const items = [];
    if (isTrash()) {
      items.push({ label: keys.length === 1 ? "Restore" : `Restore ${keys.length} Papers`, action: () => restoreKeys(keys) });
      items.push("-", { label: "Copy BibTeX", action: () => copyBib(keys) });
    } else {
      items.push({ label: "Open", disabled: !one || !atts.length, kbd: "↩", action: () => openItem(keys[0]) });
      if (one && atts.length > 1) items.push({ label: "Open Version", submenu: atts.map((a) => ({ label: a.label || a.key, action: () => openItem(one.key, a.key) })) });
      items.push("-", { label: "Add to Project", submenu: projectSubmenu(keys, true) });
      const pid = currentProject();
      if (pid && projectMode()) {
        const L = layoutOf(pid);
        items.push({ label: "Move to Section", submenu: L.sections.map((x) => ({ label: x.name, action: () => { openSection(x.id); return moveKeys(keys, x.id, -1); } })) });
        if (customOrder()) items.push({ label: "Move to Top of Section", action: () => { const it = store.item(keys[0]); moveKeys(keys, placeOf(it, L).section, 0); } });
      }
      // the project view lists its subprojects' papers too, so they leave the whole tree
      if (pid) items.push({ label: "Remove from Project", action: async () => {
        try { await store.bulk({ keys, removeProjects: store.projectTree(pid) }); } catch (e) { ui.toast(e.message, { error: true }); }
      } });
      items.push({ label: anyUnread ? "Mark as Read" : "Mark as Unread", action: () => setRead(keys, anyUnread ? "read" : "unread") });
      items.push("-", { label: "Copy BibTeX", action: () => copyBib(keys) }, { label: "Copy Citation", action: () => copyCite(keys) });
      items.push("-", { label: keys.length === 1 ? "Move to Trash" : `Move ${keys.length} Papers to Trash`, kbd: "⌫", action: () => trashKeys(keys) });
    }
    ui.menu(items, at);
  }
  async function emptyTrash() {
    const n = store.items({ trashed: true }).length;
    if (!n) { ui.toast("The trash is already empty."); return; }
    const ok = await ui.confirmDialog({ title: `Empty the Trash (${n} ${n === 1 ? "paper" : "papers"})?`, message: "The papers and their PDFs, marks and notes are moved to library/_deleted, not erased. They no longer appear in the app.", ok: "Empty Trash", danger: true });
    if (!ok) return;
    try { await api.emptyTrash(); undoLog.clear(); await store.load(); ui.toast("Trash emptied."); }
    catch (e) { ui.toast(e.message, { error: true }); }
  }

  /* ---------------------------------------------------------------- add popover */
  // many at once: the bulk dialog, then show what was added
  function bulk(text = "", files = []) {
    openBulkAdd({ text, files, project: currentProject(), plain: texPlain,
      onDone: (keys) => store.emit("reveal", { keys }) });
  }
  ctx.bulkAdd = bulk;

  function openAdd() {
    const box = el("div", "lib-add");
    const inp = h("textarea", { class: "textarea lib-add__input", rows: 1, placeholder: "arXiv ID, DOI, link, or title", "aria-label": "arXiv ID, DOI, link, or title", spellcheck: false });
    const file = h("input", { type: "file", accept: "application/pdf,.pdf", multiple: true, hidden: true });
    const choose = h("button", { class: "btn", onclick: () => file.click() }, "Choose PDF…");
    const go = h("button", { class: "btn btn--primary", onclick: () => submit() }, "Add");
    const list = el("div", "lib-add__list");
    const proj = currentProject() && store.project(currentProject());
    box.append(
      h("div", { class: "lib-add__row" }, inp, go),
      h("div", { class: "lib-add__row" }, choose,
        h("button", { class: "btn", title: "Paste a list, a reference list or a .bib file", onclick: () => { const t = inp.value; pop.close(); bulk(t); } }, "Add many…"),
        el("span", "faint lib-add__hint", "or drop PDFs anywhere.")),
    );
    if (proj) box.append(el("div", "faint lib-add__hint", `New papers go into ${proj.name}.`));
    box.append(list);
    const pop = ui.popover(bAdd, box, {});
    const grow = () => { inp.style.height = "auto"; inp.style.height = Math.min(120, inp.scrollHeight + 2) + "px"; pop.place(); };
    inp.addEventListener("input", grow);
    inp.addEventListener("keydown", (ev) => { if (ev.key === "Enter" && !ev.shiftKey) { ev.preventDefault(); submit(); } });
    file.addEventListener("change", () => {
      const files = [...file.files]; file.value = "";
      if (!files.length) return;
      pop.close();
      ctx.importFiles(files, currentProject());
    });
    box.append(file);
    setTimeout(() => inp.focus(), 0);
    async function submit() {
      const lines = inp.value.split(/\n+/).map((s) => s.trim()).filter(Boolean);
      if (!lines.length) return;
      if (lines.length > 1) { const t = inp.value; pop.close(); bulk(t); return; }   // a list: review it first
      inp.value = ""; grow();
      const keys = [];
      for (const line of lines) { const k = await addLine(line); if (k) keys.push(k); }
      if (keys.length) store.emit("reveal", { keys });
    }
    // one import, with its own progress row; returns the item key (or null)
    async function addLine(line, label) {
      const pid = currentProject();
      label = label || (/^\d{4}\.\d{4,5}(v\d+)?$/.test(line) ? "arXiv " + line : line);
      const st = el("span", "lib-add__st", "Fetching…");
      const row = h("div", { class: "lib-add__item" }, el("span", "lib-add__what", label), st);
      list.append(row); pop.place();
      try {
        const j = await store.import(line, pid);
        const it = j.item;
        if (j.duplicate) {
          st.textContent = "Already in your library";
          if (pid && !(it.projects || []).includes(pid)) await store.bulk({ keys: [it.key], addProjects: [pid] }).catch(() => {});
        } else st.textContent = "Added" + ((j.warnings || []).length ? " — " + j.warnings[0] : "");
        st.classList.add("is-ok");
        row.querySelector(".lib-add__what").textContent = texPlain(it.title) || label;
        pop.place();
        return it.key;
      } catch (e) {
        // a title search that matched nothing exactly: list the server's matches when it sends them
        const cands = ((e.payload && e.payload.candidates) || []).filter((c) => c && c.input && c.title).slice(0, 6);
        st.classList.add("is-err");
        if (cands.length) {
          st.textContent = "Pick the paper:";
          const picks = el("div", "lib-add__picks");
          for (const c of cands) {
            const meta = [c.authors, c.year, c.venue].filter(Boolean).join(" · ");
            const b = h("button", { class: "lib-add__pick", title: c.input }, el("span", "lib-add__pick-t", texPlain(c.title)), meta ? el("span", "lib-add__pick-m", meta) : "");
            b.addEventListener("click", async () => { picks.remove(); row.remove(); const k = await addLine(c.input, c.title); if (k) store.emit("reveal", { keys: [k] }); });
            picks.append(b);
          }
          row.after(picks);
        } else st.textContent = /title matches/i.test(e.message) ? "No paper with exactly that title. Paste its arXiv ID, DOI or link." : e.message;
        pop.place();
        return null;
      }
    }
  }

  /* ---------------------------------------------------------------- search */
  const runFullText = ui.debounce(async () => {
    const q = query.trim();
    const seq = ++ftSeq;
    if (ftAbort) ftAbort.abort();
    if (q.length < 2) { ftHits = new Map(); renderTable(); return; }
    ftAbort = new AbortController();
    try {
      const j = await api.search(q, ftAbort.signal);
      if (seq !== ftSeq) return;
      const m = new Map();
      for (const hit of j.hits || []) {
        if (!hit.key || !store.item(hit.key)) continue;
        if (hit.where !== "notes" && hit.where !== "marks") continue;
        if (!m.has(hit.key)) m.set(hit.key, new Set());
        m.get(hit.key).add(hit.where);
      }
      ftHits = m; renderTable();
    } catch (_) { /* aborted or server down: keep client-side results */ }
  }, 250);
  searchIn.addEventListener("input", () => { query = searchIn.value; renderTable(); runFullText(); });
  searchIn.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); clearSearch(); tbody.focus(); }
    else if (ev.key === "ArrowDown" || ev.key === "Enter") { ev.preventDefault(); tbody.focus(); if (rows.length && !sel.size) selectOnly(rows[0]); }
  });
  function clearSearch() { searchIn.value = ""; query = ""; ftHits = new Map(); ftSeq++; renderTable(); }

  /* ---------------------------------------------------------------- item pane */
  let absOpen = lsGet(LS.abs, true);
  function section(title, cls, opts = {}) {
    const s = el("section", "ip-sec " + (cls || ""));
    const hd = el("div", "ip-sec__head");
    const t = el("h3", "ip-sec__title", title);
    hd.append(t);
    if (opts.toggle) {
      t.prepend(icon(opts.open ? "chev-down" : "chev-right", "ip-sec__tw"));
      hd.classList.add("is-toggle"); hd.tabIndex = 0;
      const flip = () => opts.toggle(); hd.addEventListener("click", flip);
      hd.addEventListener("keydown", (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); flip(); } });
    }
    if (opts.extra) hd.append(opts.extra);
    s.append(hd);
    return s;
  }
  function renderPane() {
    const keys = rows.filter((k) => sel.has(k));
    const id = keys.length === 1 ? keys[0] : keys.length > 1 ? "multi:" + keys.join(",") : "none:" + (currentProject() || "");
    if (keys.length === 1 && paneKey === id) { refreshSingle(); return; }
    if (paneKey === id && keys.length !== 1) {
      // the project pane refreshes its name and count in place: rebuilding it would drop the notes'
      // focus and could load the notes before the save of what was just typed has landed
      if (keys.length > 1) renderMulti(keys);
      else if (!refreshNone()) { flushNotes(); pane.textContent = ""; renderNone(); }
      return;
    }
    flushNotes();
    paneKey = id;
    pane.textContent = "";
    pane.scrollTop = 0;
    if (keys.length === 1) renderSingle(store.item(keys[0]));
    else if (keys.length > 1) renderMulti(keys);
    else renderNone();
  }
  function renderNone() {
    const pid = currentProject(); const p = pid && store.project(pid);
    if (!p) {
      const n = rows.length;
      pane.append(el("div", "ip-hint", n ? "Select a paper to see its details, notes and PDFs." : "Nothing selected."));
      return;
    }
    const box = el("div", "ip");
    noneHead = { title: el("div", "ip-title ip-title--static"), meta: el("div", "ip-meta") };
    box.append(noneHead.title, noneHead.meta);
    const s = section("Project notes", "ip-notes");
    const ta = h("textarea", { class: "textarea ip-notes__ta", rows: 10, placeholder: "Notes for this project", "aria-label": "Project notes" });
    const status = el("div", "ip-notes__st faint");
    s.append(ta, status); box.append(s); pane.append(box);
    refreshNone();   // after pane.append(box): it checks the header is on screen
    setupNotes("project", pid, ta, status);
  }
  let noneHead = null;   // the project pane's name + count, refreshed in place (see renderPane)
  function refreshNone() {
    const pid = currentProject(); const p = pid && store.project(pid);
    if (!p || !noneHead || !pane.contains(noneHead.title)) return false;
    noneHead.title.textContent = p.name;
    const n = scopeItems().length;
    noneHead.meta.textContent = n === 1 ? "1 paper" : `${n} papers`;
    return true;
  }
  function renderMulti(keys) {
    pane.textContent = "";
    const box = el("div", "ip");
    box.append(el("div", "ip-title ip-title--static", `${keys.length} papers selected`));
    const btns = el("div", "ip-actions ip-actions--wrap");
    if (isTrash()) btns.append(h("button", { class: "btn", onclick: () => restoreKeys(keys) }, icon("restore"), "Restore"));
    else {
      const addP = h("button", { class: "btn", onclick: () => ui.menu(projectSubmenu(keys, true), addP) }, icon("folder"), "Add to Project");
      const addT = h("button", { class: "btn", onclick: async () => {
        const t = await ui.promptDialog({ title: "Add tag", message: `Adds the tag to ${keys.length} papers.`, placeholder: "Tag", ok: "Add Tag" });
        if (t && t.trim()) { try { await store.bulk({ keys, addTags: [t.trim()] }); } catch (e) { ui.toast(e.message, { error: true }); } }
      } }, icon("tag"), "Add Tag");
      btns.append(addP, addT,
        h("button", { class: "btn", onclick: () => copyBib(keys) }, "Copy BibTeX"),
        h("button", { class: "btn btn--danger", onclick: () => trashKeys(keys) }, icon("trash"), "Move to Trash"));
    }
    box.append(btns);
    const ul = el("ul", "ip-multi");
    for (const k of keys.slice(0, 40)) { const it = store.item(k); if (it) ul.append(el("li", null, texPlain(it.title) || "Untitled")); }
    if (keys.length > 40) ul.append(el("li", "faint", `and ${keys.length - 40} more`));
    box.append(ul);
    pane.append(box);
  }

  // single item: header + sections; notes are built once per item and kept across refreshes
  let single = null;   // {key, header, info, abs, atts, tags, projs, notes}
  function renderSingle(it) {
    if (!it) return;
    const box = el("div", "ip");
    single = { key: it.key, box, header: el("div", "ip-head"), info: el("div"), abs: el("div"), atts: el("div"), notes: el("div"), tags: el("div"), projs: el("div") };
    box.append(single.header, single.info, single.abs, single.atts, single.notes, single.tags, single.projs);
    pane.append(box);
    buildNotes(it);
    refreshSingle();
  }
  // what the pane shows depends on the item, its mark counts, the projects and the mark types
  const paneSig = (it) => JSON.stringify([it, store.stats[it.key] || null, store.lib.projects.map((p) => [p.id, p.name, p.parent]), mt.all().map((t) => [t.id, t.name]), store.allTags().length]);
  function refreshSingle(force = false) {
    if (!single) return;
    const it = store.item(single.key); if (!it) return;
    const keepFocus = pane.contains(document.activeElement) && document.activeElement.closest(".ip-edit, .ip-tags__add");
    if (keepFocus) { single.stale = true; return; }   // user is typing in the pane; caught up when focus leaves
    const sig = paneSig(it);
    if (!force && sig === single.sig) return;          // nothing changed: keep the DOM (no flicker, no scroll jump, focus kept)
    single.sig = sig; single.stale = false;
    const st = pane.scrollTop;
    const ref = paneFocusRef();   // a rebuild detaches the focused control: keep the keyboard where it was
    buildHeader(it); buildInfo(it); buildAbstract(it); buildAtts(it); buildTags(it); buildProjects(it);
    restorePaneFocus(ref);
    pane.scrollTop = st;
  }
  // the focused control of a rebuilt part, by its field / project id, else by its position in that part
  const PANE_FOCUSABLE = "a[href], button:not([disabled]), input:not([hidden]), select, textarea, [tabindex]:not([tabindex='-1'])";
  const PANE_PARTS = ["header", "info", "abs", "atts", "tags", "projs"];
  function paneFocusRef() {
    const a = document.activeElement;
    const part = a && single && PANE_PARTS.find((p) => single[p].contains(a));
    if (!part) return null;
    const sel = a.dataset.field ? `[data-field="${CSS.escape(a.dataset.field)}"]` : a.dataset.pid ? `[data-pid="${CSS.escape(a.dataset.pid)}"]` : null;
    return { el: a, part, sel, i: [...single[part].querySelectorAll(PANE_FOCUSABLE)].indexOf(a) };
  }
  function restorePaneFocus(r) {
    if (!r || r.el.isConnected || !single || single.box.contains(document.activeElement)) return;   // untouched, or a builder (abstract toggle) refocused
    const box = single[r.part], all = [...box.querySelectorAll(PANE_FOCUSABLE)];
    const t = (r.sel && box.querySelector(r.sel)) || (r.i >= 0 ? all[Math.min(r.i, all.length - 1)] : null);
    if (t) t.focus({ preventScroll: true });
  }
  pane.addEventListener("focusout", () => setTimeout(() => {
    if (single && single.stale && !(pane.contains(document.activeElement) && document.activeElement.closest(".ip-edit, .ip-tags__add"))) refreshSingle(true);
  }, 0));

  // click-to-edit value; onSave(newText) returns a promise
  function editable(value, { multiline = false, placeholder = "", cls = "", onSave, display, field }) {
    const v = el("div", "ip-val " + cls);
    if (field) v.dataset.field = field;
    const show = () => {
      v.textContent = "";
      v.classList.remove("is-editing");
      if (value) v.append(display ? display(value) : document.createTextNode(value));
      else v.append(el("span", "ip-empty", placeholder || "—"));
    };
    show();
    v.tabIndex = 0;
    const start = () => {
      if (v.classList.contains("is-editing")) return;
      v.classList.add("is-editing");
      v.textContent = "";
      const inp = multiline ? h("textarea", { class: "textarea ip-edit", rows: Math.max(2, String(value).split("\n").length + 1) }) : h("input", { class: "input ip-edit", spellcheck: false });
      inp.value = value || ""; inp.placeholder = placeholder;
      v.append(inp); inp.focus(); if (!multiline) inp.select();
      let done = false;
      // refocus (Enter / Escape): keyboard focus goes back to this field, which the refresh may have rebuilt
      const finish = async (save, refocus = false) => {
        if (done) return; done = true;
        const nv = inp.value.trim();
        if (refocus) v.focus({ preventScroll: true });   // off the input first, so the pane counts as idle
        let failed = false;
        if (save && nv !== String(value || "").trim()) {
          try { value = nv; await onSave(nv); } catch (e) { failed = true; ui.toast(e.message, { error: true }); }
        }
        show();
        refreshSingle(failed || !!(single && single.stale));   // a failed save shows the stored value again
        if (!refocus) return;
        const again = field && single ? single.box.querySelector(`.ip-val[data-field="${field}"]`) : null;
        (again && again.isConnected ? again : v).focus({ preventScroll: true });
      };
      inp.addEventListener("keydown", (ev) => {
        keepKeys(ev);
        if (ev.key === "Escape") { ev.preventDefault(); finish(false, true); }
        else if (ev.key === "Enter" && (!multiline || ev.metaKey || ev.ctrlKey)) { ev.preventDefault(); finish(true, true); }
      });
      inp.addEventListener("blur", () => finish(true));
    };
    v.addEventListener("click", (ev) => { if (!ev.target.closest("a, button")) start(); });
    v.addEventListener("keydown", (ev) => { if (ev.key === "Enter" && ev.target === v) { ev.preventDefault(); start(); } });
    return v;
  }
  const patch = (key, p) => store.patchItem(key, p);
  // typing in the pane's fields: plain keys stay in the field, but ⌘/Ctrl shortcuts (⌘K search, ⌘P, ⌘,) still work
  const keepKeys = (ev) => { if (!(ev.metaKey || ev.ctrlKey)) ev.stopPropagation(); };

  function buildHeader(it) {
    const hd = single.header; hd.textContent = "";
    hd.append(editable(it.title, { field: "title", cls: "ip-title", multiline: false, placeholder: "Untitled", display: (v) => texRich(v), onSave: (t) => patch(it.key, { title: t }) }));
    if ((it.authors || []).length) hd.append(el("div", "ip-authors", ui.authorsFull(it.authors)));
    const vy = [it.venue, it.year].filter(Boolean).join(" · ");
    if (vy) hd.append(el("div", "ip-meta", vy));
    if (it.trashed) hd.append(el("div", "ip-meta", "In the Trash since " + ui.dateLong(it.trashed)));
    const acts = el("div", "ip-actions");
    const att = store.primaryAtt(it);
    acts.append(h("button", { class: "btn btn--primary", disabled: !att, onclick: () => openItem(it.key) }, icon("pdf"), "Open PDF"));
    const cite = h("button", { class: "btn", onclick: () => ui.menu([
      { label: "Copy BibTeX", action: () => copyBib([it.key]) },
      { label: "Copy Citation", action: () => copyCite([it.key]) },
    ], cite) }, icon("quote"), "Cite");
    acts.append(cite);
    if (it.trashed) acts.append(h("button", { class: "btn", onclick: () => restoreKeys([it.key]) }, icon("restore"), "Restore"));
    hd.append(acts);
  }
  function infoRow(grid, label, valueEl) { grid.append(el("div", "ip-k", label), valueEl); }
  function linkVal(href) { return (v) => { const a = h("a", { href: href(v), target: "_blank", rel: "noopener noreferrer", class: "ip-link" }, v); return a; }; }
  function buildInfo(it) {
    const s = section("Info", "ip-info", { extra: h("button", { class: "btn btn--small", onclick: () => fetchMeta(it.key) }, "Fetch metadata…") });
    const g = el("div", "ip-grid");
    const typ = h("select", { class: "select ip-select", "aria-label": "Item type", dataset: { field: "type" } }, ...ui.ITEM_TYPES.map(([v, l]) => h("option", { value: v }, l)));
    typ.value = it.type || "misc";
    typ.addEventListener("change", () => patch(it.key, { type: typ.value }).catch((e) => ui.toast(e.message, { error: true })));
    infoRow(g, "Item type", typ);
    infoRow(g, "Authors", editable(ui.authorsToLines(it.authors), { field: "authors", multiline: true, placeholder: "Family, Given (one per line)", display: (v) => document.createTextNode(v.split("\n").join("; ")),
      onSave: (t) => patch(it.key, { authors: ui.parseAuthors(t) }) }));
    infoRow(g, "Date", editable(it.date, { field: "date", placeholder: "YYYY-MM-DD", onSave: (t) => { const y = /^(\d{4})/.exec(t); return patch(it.key, { date: t, year: y ? +y[1] : null }); } }));
    for (const [f, l] of [["venue", "Venue"], ["volume", "Volume"], ["issue", "Issue"], ["pages", "Pages"]]) infoRow(g, l, editable(it[f], { field: f, onSave: (t) => patch(it.key, { [f]: t }) }));
    infoRow(g, "DOI", editable(it.doi, { field: "doi", display: linkVal((v) => "https://doi.org/" + v), onSave: (t) => patch(it.key, { doi: t }) }));
    infoRow(g, "arXiv", editable(it.arxiv, { field: "arxiv", display: linkVal((v) => "https://arxiv.org/abs/" + v), onSave: (t) => patch(it.key, { arxiv: t }) }));
    infoRow(g, "URL", editable(it.url, { field: "url", display: linkVal((v) => (/^https?:\/\//i.test(v) ? v : "https://" + v)), onSave: (t) => patch(it.key, { url: t }) }));
    infoRow(g, "Added", el("div", "ip-val ip-val--ro num", ui.dateLong(it.added)));
    infoRow(g, "Modified", el("div", "ip-val ip-val--ro num", ui.dateLong(it.modified)));
    s.append(g);
    single.info.replaceChildren(s);
  }
  async function fetchMeta(key) {
    const it = store.item(key); if (!it) return;
    const asked = ui.promptDialog({ title: "Fetch metadata", message: "Paste a DOI, arXiv ID or link. Fields that are empty get filled in.", value: it.doi || it.arxiv || "", placeholder: "10.1103/… or 1706.03762", ok: "Fetch" });
    // an abstract imported without its formulas (OpenAlex) is only repaired by fetching it again:
    // offered as a check box in the same dialog (the dialog is on screen once promptDialog returns)
    let swapAbs = null;
    const dlg = it.abstract ? [...document.querySelectorAll(".scrim .dialog")].pop() : null;
    const acts = dlg && dlg.querySelector(".dialog__actions");
    if (acts) { swapAbs = h("input", { type: "checkbox" }); acts.before(h("label", { class: "lib-check" }, swapAbs, "Replace the abstract")); }
    const input = await asked;
    if (!input || !input.trim()) return;
    const replace = !!(swapAbs && swapAbs.checked);
    const doEnrich = async (inp) => {
      ui.toast("Fetching metadata…", { ms: 30000 });
      const j = await enrichItem(key, inp, replace);
      if (j.item) store.setItem(j.item);
      ui.toast((j.warnings || [])[0] || (replace && !j.replaced ? "Metadata updated. No other abstract was found; the old one is kept." : "Metadata updated."));
    };
    try { await doEnrich(input.trim()); }
    catch (e) { retryWithPick(e, (inp) => doEnrich(inp).catch((e2) => ui.toast(e2.message, { error: true })), () => single && single.key === key && single.info.querySelector(".ip-sec__head .btn")); }
  }
  // enrich fills only empty fields; to replace just the abstract it is emptied first (an undoable edit:
  // ⌘Z brings the old one back) and put back when the lookup fails or finds none. The server's
  // overwrite flag is not used: it would also replace venue, type and DOI with the preprint's.
  async function enrichItem(key, input, replaceAbstract) {
    const old = (store.item(key) || {}).abstract || "";
    if (!replaceAbstract || !old) return api.enrich(key, input);
    await store.patchItem(key, { abstract: "" });
    let j = null;
    try { j = await api.enrich(key, input); }
    finally {
      const now = (j && j.item && j.item.abstract) || "";
      if (!now) {
        const back = await api.patchItem(key, { abstract: old }).catch(() => null);
        if (back && back.item) { if (j) j.item = back.item; else store.setItem(back.item); }
      }
      if (j) j.replaced = !!now && now !== old;
    }
    return j;
  }
  // a title that matched nothing exactly: offer the server's matches (when it sends them) as a menu
  function retryWithPick(e, run, anchor) {
    const cands = ((e.payload && e.payload.candidates) || []).filter((c) => c && c.input && c.title).slice(0, 6);
    if (!cands.length) { ui.toast(/title matches/i.test(e.message) ? "No paper with exactly that title. Paste its arXiv ID, DOI or link." : e.message, { error: true }); return; }
    ui.toast("Pick the paper from the list.");
    const a = anchor && anchor();
    ui.menu(cands.map((c) => {
      const meta = [c.authors, c.year].filter(Boolean).join(", ");
      return { label: ui.shortTitle(texPlain(c.title), 80) + (meta ? " — " + meta : ""), action: () => run(c.input) };
    }), a && a.isConnected ? a : { x: Math.max(16, innerWidth / 2 - 200), y: innerHeight / 3 });
  }
  function buildAbstract(it) {
    if (!it.abstract) { single.abs.replaceChildren(); return; }
    const s = section("Abstract", "ip-abs", { toggle: () => { absOpen = !absOpen; lsSet(LS.abs, absOpen); buildAbstract(store.item(it.key)); }, open: absOpen });
    if (absOpen) { const box = el("div", "ip-abs__text"); renderAbstract(box, it.abstract); s.append(box); }
    const hadFocus = single.abs.contains(document.activeElement);
    single.abs.replaceChildren(s);
    if (hadFocus) s.querySelector(".ip-sec__head").focus({ preventScroll: true });   // keep the keyboard on the toggle
  }

  function buildAtts(it) {
    const file = h("input", { type: "file", accept: "application/pdf,.pdf", hidden: true });
    const s = section("Attachments", "ip-atts");
    const list = el("div", "ip-att-list");
    const atts = it.attachments || [];
    if (!atts.length) list.append(el("div", "ip-empty ip-pad", "No PDF yet."));
    for (const a of atts) {
      const m = store.markCounts(it.key, a.key);
      const row = h("button", { class: "ip-att" + (a.key === (store.primaryAtt(it) || {}).key ? " is-primary" : ""), title: "Open " + (a.label || a.key) });
      row.append(icon("pdf"), el("span", "ip-att__label", a.label || a.key));
      const meta = el("span", "ip-att__meta num");
      if (a.pages) meta.append(`${a.pages} pp`);
      if (m.total) { meta.append((a.pages ? " · " : "") + m.total + (m.total === 1 ? " mark" : " marks")); }
      row.append(meta);
      row.addEventListener("click", () => openItem(it.key, a.key));
      row.addEventListener("contextmenu", (ev) => {
        ev.preventDefault();
        ui.menu([
          { label: "Open", action: () => openItem(it.key, a.key) },
          { label: "Rename…", action: async () => {
            const l = await ui.promptDialog({ title: "Rename PDF", value: a.label || a.key, ok: "Rename" });
            if (l == null || !l.trim()) return;
            try { const j = await api.renameAttachment(it.key, a.key, l.trim()); if (j.item) store.setItem(j.item); else await store.load(); } catch (e) { ui.toast(e.message, { error: true }); }
          } },
          "-",
          { label: "Remove…", action: async () => {
            const ok = await ui.confirmDialog({ title: `Remove “${a.label || a.key}”?`, message: m.total ? `Its ${m.total} marks go with it. The file is kept in the library's history folder, not erased.` : "The file is kept in the library's history folder, not erased.", ok: "Remove", danger: true });
            if (!ok) return;
            try { const j = await api.removeAttachment(it.key, a.key); if (j.item) store.setItem(j.item); else await store.load(); } catch (e) { ui.toast(e.message, { error: true }); }
          } },
        ], { x: ev.clientX, y: ev.clientY });
      });
      list.append(row);
    }
    file.addEventListener("change", async () => {
      const f = file.files[0]; file.value = ""; if (!f) return;
      ui.toast(`Adding ${f.name}…`, { ms: 60000 });
      try { const j = await api.addAttachmentFile(it.key, f, f.name.replace(/\.pdf$/i, "")); if (j.item) store.setItem(j.item); else await store.load(); ui.toast("PDF added."); }
      catch (e) { ui.toast(e.message, { error: true }); }
    });
    const btns = el("div", "ip-actions ip-actions--small");
    if (journal.canGet(it)) {
      const onlyPreprint = atts.length && atts.every((a) => /arxiv\.org/i.test(a.url || "") || /^arxiv/i.test(a.label || ""));
      if (onlyPreprint) list.append(el("div", "ip-empty ip-pad", "Only the arXiv preprint is here."));
      btns.append(h("button", { class: "btn btn--small", title: "Opens the journal's PDF in your browser with your own access, then adds it when you download it", onclick: () => journal.getJournalPdf(it.key) }, "Get journal PDF"));
    }
    if (it.type !== "preprint" && !atts.some((a) => /arxiv\.org/i.test(a.url || "") || /^arxiv/i.test(a.label || ""))) {
      const fb = h("button", { class: "btn btn--small", title: "Look for this paper's arXiv preprint and add it", onclick: async () => {
        fb.disabled = true; ui.toast("Looking for the arXiv version…", { ms: 30000 });
        try {
          const j = await api.findPreprint(it.key);
          if (j.item) store.setItem(j.item); else await store.load();
          ui.toast(`Added the arXiv preprint (arXiv ${j.arxiv}).`);
        } catch (e) { ui.toast(e.message, { error: true, ms: 9000 }); }
        finally { fb.disabled = false; }
      } }, "Find arXiv version");
      btns.append(fb);
    }
    btns.append(
      h("button", { class: "btn btn--small", onclick: () => file.click() }, "Add PDF…"),
      h("button", { class: "btn btn--small", dataset: { act: "add-link" }, onclick: async () => {
        const url = await ui.promptDialog({ title: "Add PDF from link", message: "A direct PDF link, an arXiv ID, or a paper page.", placeholder: "https://…", ok: "Add" });
        if (!url || !url.trim()) return;
        const run = async (u) => {
          ui.toast("Downloading…", { ms: 60000 });
          const j = await api.fetchAttachment(it.key, u); if (j.item) store.setItem(j.item); else await store.load(); ui.toast("PDF added.");
        };
        try { await run(url.trim()); }
        catch (e) { retryWithPick(e, (u) => run(u).catch((e2) => ui.toast(e2.message, { error: true })), () => single && single.key === it.key && single.atts.querySelector('[data-act="add-link"]')); }
      } }, "Add from link…"),
      file,
    );
    s.append(list, btns);
    single.atts.replaceChildren(s);
  }

  function buildTags(it) {
    const s = section("Tags", "ip-tags");
    const list = el("div", "ip-tag-list");
    for (const t of it.tags || []) {
      const row = el("div", "ip-tag");
      const removeTag = async (ev) => {
        const kb = ev.detail === 0, i = [...list.children].indexOf(row);   // detail 0: Enter / Space, not a click
        try { await patch(it.key, { tags: (store.item(it.key).tags || []).filter((x) => x !== t) }); } catch (e) { ui.toast(e.message, { error: true }); return; }
        if (!kb || !single || single.key !== it.key) return;
        const xs = single.tags.querySelectorAll(".ip-tag__x");   // keyboard stays on the next tag's × (or the add field)
        (xs[Math.min(i, xs.length - 1)] || single.tags.querySelector(".ip-tags__add")).focus({ preventScroll: true });
      };
      row.append(el("span", null, t), h("button", { class: "ibtn ip-tag__x", title: `Remove tag ${t}`, "aria-label": `Remove tag ${t}`, onclick: removeTag }, icon("x")));
      list.append(row);
    }
    const dl = h("datalist", { id: "pm2-tags-dl" }, ...store.allTags().map(([t]) => h("option", { value: t })));
    const add = h("input", { class: "input ip-tags__add", placeholder: "Add tag", "aria-label": "Add tag", list: "pm2-tags-dl" });
    add.addEventListener("keydown", async (ev) => {
      keepKeys(ev);
      if (ev.key === "Escape") { add.value = ""; add.blur(); return; }
      if (ev.key !== "Enter") return;
      ev.preventDefault();
      const t = add.value.trim(); if (!t) return;
      const cur = store.item(it.key).tags || [];
      add.value = "";
      if (cur.includes(t)) return;
      try { await patch(it.key, { tags: [...cur, t] }); } catch (e) { ui.toast(e.message, { error: true }); }
      add.blur(); refreshSingle(true);
      const again = single && single.tags.querySelector(".ip-tags__add"); again && again.focus();
    });
    s.append(list, add, dl);
    single.tags.replaceChildren(s);
  }
  function buildProjects(it) {
    const s = section("Projects", "ip-projs");
    if (!store.lib.projects.length) s.append(el("div", "ip-empty ip-pad", "No projects yet."));
    const walk = (parent, depth) => {
      for (const p of store.childrenOf(parent).sort((a, b) => a.name.localeCompare(b.name))) {
        const cb = h("input", { type: "checkbox", checked: (it.projects || []).includes(p.id), dataset: { pid: p.id } });
        cb.addEventListener("change", () => store.bulk(cb.checked ? { keys: [it.key], addProjects: [p.id] } : { keys: [it.key], removeProjects: [p.id] }).catch((e) => ui.toast(e.message, { error: true })));
        const lab = h("label", { class: "ip-proj", style: { paddingLeft: depth * 16 + "px" } }, cb, p.name);
        s.append(lab);
        walk(p.id, depth + 1);
      }
    };
    walk(null, 0);
    single.projs.replaceChildren(s);
  }

  /* ---------------------------------------------------------------- notes (item + project), rev-checked */
  let notes = null;   // {kind, id, ta, status, rev, loaded, gen, savedGen, saving, again}
  function buildNotes(it) {
    const s = section("Notes", "ip-notes");
    const ta = h("textarea", { class: "textarea ip-notes__ta", rows: 8, placeholder: "Notes on this paper (shared by all its PDFs)", "aria-label": "Notes" });
    const status = el("div", "ip-notes__st faint");
    s.append(ta, status);
    single.notes.replaceChildren(s);
    setupNotes("item", it.key, ta, status);
  }
  const saveSoon = ui.debounce(() => notes && saveNotes(notes), 600);
  // a rebuilt notes box loads its document only after a save of that document still in flight has
  // landed (else it shows the old text with a stale rev, and the next save 409s and overwrites)
  const inflight = new Map();   // "kind:id" -> promise of that doc's save in flight
  async function settled(k) { let p; while ((p = inflight.get(k))) await p; }
  function setupNotes(kind, id, ta, status) {
    const n = { kind, id, ta, status, rev: 0, loaded: false, gen: 0, savedGen: 0, saving: false, again: false };
    notes = n;
    ta.readOnly = true; status.textContent = "Loading…";
    settled(kind + ":" + id).then(() => (kind === "item" ? api.getNotes(id) : api.getProjectNotes(id))).then((j) => {
      n.rev = j.rev || 0; n.loaded = true;
      if (n.gen === 0) ta.value = j.text || "";
      ta.readOnly = false;
      status.textContent = j.savedAt ? "Saved " + ui.timeShort(j.savedAt) : "";
    }).catch((e) => { status.textContent = "Couldn't load notes: " + e.message; });
    ta.addEventListener("input", () => { if (!n.loaded) return; n.gen++; status.textContent = "Editing…"; saveSoon(); });
    ta.addEventListener("keydown", keepKeys);
    ta.addEventListener("blur", () => { if (n.gen !== n.savedGen) { saveSoon.cancel(); saveNotes(n); } });
  }
  async function saveNotes(n, opts = {}) {
    if (!n || !n.loaded || n.gen === n.savedGen) return;
    if (n.saving) { n.again = true; return; }
    const gen = n.gen, text = n.ta.value;
    const fn = n.kind === "item" ? api.saveNotes : api.saveProjectNotes;
    n.saving = true;
    const k = n.kind + ":" + n.id;   // set synchronously, so a setupNotes() right after flushNotes() waits for it
    let done; const p = new Promise((r) => { done = r; }); inflight.set(k, p);
    let j = null;
    try { j = await fn(n.id, text, n.rev, false, opts); }
    catch (e) {
      if (e.conflict) {
        try { j = await fn(n.id, text, null, true, opts); ui.toast("Notes changed in another window; yours were saved and the other version is in history."); }
        catch (e2) { n.status.textContent = "Not saved: " + e2.message; }
      } else n.status.textContent = "Not saved: " + e.message;
    } finally { n.saving = false; if (inflight.get(k) === p) inflight.delete(k); done(); }
    if (j) {
      if (typeof j.rev === "number") n.rev = j.rev;
      n.savedGen = Math.max(n.savedGen, gen);
      if (notes === n && n.gen === n.savedGen) n.status.textContent = "Saved " + ui.timeShort(j.savedAt || new Date().toISOString());
      if (n.kind === "item" && store.stats[n.id]) store.stats[n.id].hasNotes = !!text.trim();
    }
    if (n.again || (j && n.gen !== n.savedGen)) { n.again = false; if (notes === n) saveSoon(); else saveNotes(n, opts); }
  }
  function flushNotes(keepalive = false) {
    saveSoon.cancel();
    if (notes && notes.gen !== notes.savedGen) saveNotes(notes, keepalive ? { keepalive: true } : {});
  }
  addEventListener("pagehide", () => flushNotes(true));
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flushNotes(true); });

  /* ---------------------------------------------------------------- PDF enrichment after local imports */
  const looksLikeFilename = (t, it) => {
    if (!t || !t.trim()) return true;
    if (/\.pdf$/i.test(t) || /^[\w.-]+$/.test(t) && !/\s/.test(t) && t.length > 12) return true;
    const norm = (x) => String(x || "").replace(/\.pdf$/i, "").replace(/[_.\-]+/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
    return (it.attachments || []).some((a) => norm(a.label) === norm(t) || norm(a.file) === norm(t));
  };
  const enriching = new Set();
  async function enrichFromPdf(key) {
    const it = store.item(key); const att = store.primaryAtt(it);
    if (!it || !att || enriching.has(key) || !window.pdfjsLib) return;
    if (!looksLikeFilename(it.title, it) && (it.authors || []).length) return;
    enriching.add(key);
    let doc = null;
    try {
      doc = await pdfjsLib.getDocument(api.pdfSrc(api.pdfUrl(key, att.key))).promise;
      const meta = await doc.getMetadata().catch(() => ({}));
      const info = (meta && meta.info) || {};
      let text = "", lines = [];
      for (let p = 1; p <= Math.min(2, doc.numPages); p++) {
        const page = await doc.getPage(p);
        const tc = await page.getTextContent();
        text += tc.items.map((x) => x.str).join(" ") + "\n";
        if (p === 1) lines = tc.items.filter((x) => x.str && x.str.trim().length > 3).map((x) => ({ s: x.str.trim(), size: Math.abs(x.transform[3]) || x.height || 0 }));
        page.cleanup();
      }
      const ax = ARXIV_RE.exec(text), dx = DOI_RE.exec(text);
      const id = ax ? ax[1] : dx ? dx[0].replace(/[.,;)\]]+$/, "") : null;
      if (id) {
        try { const j = await api.enrich(key, id); if (j.item) store.setItem(j.item); return; } catch (_) { /* fall back to metadata */ }
      }
      const p = {};
      let title = (info.Title || "").trim();
      if (!title || looksLikeFilename(title, it) || /^untitled|microsoft word/i.test(title)) {
        const max = Math.max(0, ...lines.map((l) => l.size));
        title = lines.filter((l) => l.size >= max - 0.5).map((l) => l.s).join(" ").replace(/\s+/g, " ").trim().slice(0, 300);
      }
      if (title && looksLikeFilename(it.title, it)) p.title = title;
      if (info.Author && !(it.authors || []).length) p.authors = ui.parseAuthors(String(info.Author).replace(/\s+and\s+|,\s*(?=[A-Z][a-z]+\s+[A-Z])/g, ";"));
      if (Object.keys(p).length) await store.patchItem(key, p);
    } catch (e) { console.warn("enrich failed", key, e); }
    finally { enriching.delete(key); if (doc) doc.destroy(); }
  }

  /* ---------------------------------------------------------------- store events */
  const renderAll = () => { renderColl(); renderHead(); renderTable(); };   // the header shows sorting only outside project order
  store.on("library", renderAll);   // a project pane refreshes its name/count in place (renderPane -> refreshNone)
  store.on("item", ({ key }) => {
    const it = store.item(key);
    const r = tbody.querySelector(`.lib-row[data-key="${CSS.escape(key)}"]`);
    // re-render when the edit moves the row (sorting) or drops it (scope, tag filter, search)
    const vis = r && it ? visibleItems().map((x) => x.key) : [];
    const moved = projectMode() ? !vis.includes(key) : vis.length !== rows.length || vis.some((k, i) => k !== rows[i]);
    if (!it || !r || moved) { renderAll(); return; }
    const rk = r.querySelector(".td__rank");
    const nr = rowFor(it, rk ? +rk.textContent : 0);
    nr.classList.toggle("is-alt", r.classList.contains("is-alt"));
    r.replaceWith(nr);
    renderColl();
    if (sel.size === 1 && sel.has(key)) refreshSingle();
  });
  store.on("stats", () => { renderAll(); });
  store.on("marktypes", () => { renderAll(); });
  store.on("layout", ({ id }) => { if (route.filter === "project" && route.id === id) renderTable(); });   // names/colours in the Marks column follow the registry
  store.on("reveal", ({ keys, enrich } = {}) => {
    keys = (keys || []).filter((k) => store.item(k));
    if (!keys.length) return;
    const hidden = keys.some((k) => !inScope(store.item(k)));
    if (hidden) { tagFilter.clear(); if (query) { searchIn.value = ""; query = ""; ftHits = new Map(); } }
    sel = new Set(keys); cursor = keys[0]; anchor = keys[0];
    if (hidden) {   // e.g. imported while the Trash or Recently Opened was showing
      route = { name: "library", filter: keys.every((k) => store.item(k).trashed) ? "trash" : "all" };
      recentByCol = false;
      ctx.openLibrary(route);
    }
    renderAll();
    scrollToKey(keys[0]);
    if (enrich) keys.forEach((k) => enrichFromPdf(k));
  });

  /* ---------------------------------------------------------------- commands (⌘K palette) */
  const selKeys = () => rows.filter((k) => sel.has(k));
  const libShown = () => visible && !rootEl.hidden;
  const frame = () => new Promise((r) => requestAnimationFrame(r));
  // make sure the library is on screen, showing route r (commands can be run from a reader tab)
  async function ensureLibrary(r = route) {
    if (libShown() && sameRoute(route, r)) return;
    ctx.openLibrary(r);
    for (let n = 0; n < 30 && !(libShown() && sameRoute(route, r)); n++) await frame();
  }
  const goto = (filter) => () => ctx.openLibrary({ name: "library", filter });
  const readingKey = () => { const m = /^#\/read\/([^/]+)\//.exec(location.hash); return m ? decodeURIComponent(m[1]) : null; };
  commands.registerAll([
    { id: "library.add-paper", title: "Add paper from arXiv ID, DOI or link", section: "Library", keywords: "import new paste url",
      run: async () => { await ensureLibrary(); openAdd(); } },
    { id: "library.add-many", title: "Add many papers at once…", section: "Library", keywords: "bulk import list bibtex bib references several multiple batch",
      run: async () => { await ensureLibrary(); bulk(); } },
    { id: "library.add-pdf", title: "Add PDF from a file…", section: "Library", keywords: "import upload choose local",
      run: () => { const f = h("input", { type: "file", accept: "application/pdf,.pdf", multiple: true, hidden: true });
        f.addEventListener("change", () => { const files = [...f.files]; f.remove(); if (files.length) ctx.importFiles(files, currentProject()); });
        document.body.append(f); f.click(); } },
    { id: "library.new-project", title: "New project…", section: "Library", keywords: "folder collection create", run: () => newProject(null) },
    { id: "library.new-subproject", title: "New subproject in this project…", section: "Library", when: () => !!currentProject(), run: () => newProject(currentProject()) },
    { id: "library.rename-project", title: "Rename this project…", section: "Library", when: () => !!currentProject(), run: () => {
      const p = store.project(currentProject()); if (!p) return;
      ui.promptDialog({ title: "Rename project", value: p.name, ok: "Rename" }).then((name) => {
        if (name && name.trim() && name.trim() !== p.name) store.renameProject(p.id, name.trim()).catch((e) => ui.toast(e.message, { error: true }));
      }); } },
    { id: "library.new-section", title: "New section in this project…", section: "Library", keywords: "group heading", when: () => !!projectMode(), run: () => newSection(null) },
    { id: "library.project-order", title: "Show the project's own order", section: "Library", keywords: "sections sort custom", when: () => !!projectMode() && !customOrder(),
      run: () => { psort[route.id] = "custom"; lsSet(LSP.psort, psort); renderHead(); renderTable(); } },
    { id: "library.mark-types", title: "Mark types…", section: "Marking", keywords: "question remark explain colours edit", run: () => mt.openEditor() },
    { id: "library.open-selected", title: "Open selected paper", section: "Library", keys: "↵", when: () => libShown() && sel.size >= 1, run: () => openItem(cursor && sel.has(cursor) ? cursor : selKeys()[0]) },
    { id: "library.copy-bibtex", title: "Copy BibTeX of selected papers", section: "Library", keys: "⌘C", keywords: "cite citation export", when: () => libShown() && sel.size > 0, run: () => copyBib(selKeys()) },
    { id: "library.copy-citation", title: "Copy citation of selected papers", section: "Library", keys: "⌘⇧C", keywords: "cite reference", when: () => libShown() && sel.size > 0, run: () => copyCite(selKeys()) },
    { id: "library.toggle-read", title: "Mark selected papers as read / unread", section: "Library", when: () => libShown() && sel.size > 0 && !isTrash(),
      run: () => { const keys = selKeys(); setRead(keys, keys.some((k) => (store.item(k) || {}).read !== "read") ? "read" : "unread"); } },
    { id: "library.fetch-metadata", title: "Fetch metadata for selected paper…", section: "Library", keywords: "doi arxiv enrich update", when: () => libShown() && sel.size === 1, run: () => fetchMeta(selKeys()[0]) },
    { id: "library.trash-selected", title: "Move selected papers to Trash", section: "Library", keys: "⌫", keywords: "delete remove", when: () => libShown() && sel.size > 0 && !isTrash(), run: () => trashKeys(selKeys()) },
    { id: "library.restore-selected", title: "Restore selected papers", section: "Library", when: () => libShown() && sel.size > 0 && isTrash(), run: () => restoreKeys(selKeys()) },
    { id: "library.empty-trash", title: "Empty Trash…", section: "Library", keywords: "delete", when: () => store.items({ trashed: true }).length > 0, run: () => emptyTrash() },
    { id: "library.export-bibtex", title: "Export BibTeX of the papers in this list", section: "Library", keywords: "bib download project save file", run: () => exportList() },
    { id: "library.filter", title: "Filter papers in this list", section: "Library", keys: "⌘F", keywords: "find search", run: async () => { await ensureLibrary(); searchIn.focus(); searchIn.select(); } },
    { id: "library.clear-filters", title: "Clear the search and tag filters", section: "Library", when: () => !!(query || tagFilter.size), run: () => { tagFilter.clear(); clearSearch(); renderTags(); } },
    { id: "library.toggle-abstract", title: "Show / hide abstracts", section: "Library", run: () => { absOpen = !absOpen; lsSet(LS.abs, absOpen); if (single) buildAbstract(store.item(single.key)); } },
    { id: "library.reveal-current", title: "Show this paper in the Library", section: "Library", keywords: "reveal locate find", when: () => !!readingKey(),
      run: async () => { const k = readingKey(); await ensureLibrary({ name: "library", filter: "all" }); store.emit("reveal", { keys: [k] }); } },
    { id: "library.go-unfiled", title: "Unfiled papers", section: "Go to", keywords: "show library", run: goto("unfiled") },
    { id: "library.go-recent", title: "Recently opened papers", section: "Go to", keywords: "show library history", run: goto("recent") },
    { id: "library.go-marked", title: "Papers with marks", section: "Go to", keywords: "show library annotated", run: goto("marked") },
    { id: "library.go-trash", title: "Trash", section: "Go to", keywords: "show library deleted", run: goto("trash") },
  ]);
  // one "Tag: …" command per tag, kept in step with the library
  let tagCmds = () => {}, tagSig = "";
  function registerTagCommands() {
    const tags = store.allTags().map(([t]) => t), sig = tags.join("\n");
    if (sig === tagSig) return;
    tagSig = sig; tagCmds();
    tagCmds = commands.registerAll(tags.map((t) => ({ id: "library.tag:" + t, title: "Tag: " + t, section: "Go to", keywords: "filter tagged",
      run: async () => { await ensureLibrary(route.filter === "trash" ? { name: "library", filter: "all" } : route); tagFilter.clear(); tagFilter.add(t); searchIn.value = ""; query = ""; ftHits = new Map(); ftSeq++; renderTags(); renderTable(); } })));
  }

  /* ---------------------------------------------------------------- public interface */
  renderHead();
  renderAll();
  return {
    show() { visible = true; requestAnimationFrame(() => requestAnimationFrame(focusList)); },
    hide() { visible = false; flushNotes(); },
    route(r) {
      const next = r && r.name === "library" ? { name: "library", filter: r.filter || "all", id: r.id } : { name: "library", filter: "all" };
      if (next.filter === "project" && !store.project(next.id) && store.loaded) next.filter = "all";
      const changed = !sameRoute(next, route);
      route = next;
      if (changed) { tagFilter.clear(); paneKey = null; recentByCol = false; }
      renderAll();
    },
    focusSearch() { searchIn.focus(); searchIn.select(); },
    currentProject,
  };
}
