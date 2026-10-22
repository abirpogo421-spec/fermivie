// PDF sniffing from importers.py (WEB_CONTRACT.md section 6.2): the DOI, arXiv id and title in a PDF's
// bytes. Pure ES module; results equal Python's on every input (tests/web/test_imp_pure*.mjs).
//
// Exports (Python name in brackets):
//   pdfIdentifiers(bytes) [pdf_identifiers] -> {doi, arxiv, title}; synchronous, never throws
//   sniffPdf(input, {maxBytes}) [sniff_pdf_file]: input is a Uint8Array/ArrayBuffer (result returned
//     directly) or a Blob/File (a Promise; only the head and tail are read, as Python reads the file)
//   sniffPdfFile(blob, {maxBytes}) -> Promise, always
//   arxivStamp [_arxiv_stamp], pdfUnescape [_pdf_unescape], pdfString [_pdf_string], pdfText [_pdf_text],
//   goodPdfTitle [_good_pdf_title], isPdfBytes [_is_pdf_bytes], isHtmlBytes [_is_html_bytes],
//   notPdfMessage [_not_pdf_message], humanSize [_human_size], MB,
//   zlibDecompress(bytes, maxLength) [zlib.decompressobj().decompress(raw, max_length)] -> Uint8Array,
//     throws ZlibError where Python raises zlib.error
//
// Streams are inflated by zlibDecompress below rather than DecompressionStream: Python returns the output
// of a truncated stream, stops at 4 MB, and raises only for the corruptions zlib detects (including some
// detected after the output is full), which DecompressionStream can't reproduce. It follows zlib's
// inflate state machine and is synchronous.

import { re, ws, cleanText, pySplit, cpLen, decodeUtf8, decodeLatin1 } from "./text.js";
import { cleanDoi, matchArxivExact, host } from "./parse.js";

export const MB = 1024 * 1024;

// ---------------------------------------------------------------------------------------------------
// zlib inflate (RFC 1950/1951), with zlib 1.2/1.3's error checks

export class ZlibError extends Error {
  constructor(msg) { super("Error -3 while decompressing data: " + msg); this.name = "zlib.error"; this.reason = msg; }
}

class Stop extends Error {}       // input ran out or output is full: return what we have
const STOP = new Stop();

const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131,
  163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537,
  2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

// inftrees.c: canonical Huffman table. type 0 = CODES, 1 = LENS, 2 = DISTS. Returns null when zlib's
// inflate_table() fails (over-subscribed, or incomplete where zlib doesn't allow it). The table maps the
// next `bits` input bits (LSB first) to sym << 5 | length, or -(length) - 1 for zlib's invalid-code entries.
function buildTable(lens, type) {
  const count = new Array(16).fill(0);
  for (const l of lens) count[l]++;
  let max = 15;
  while (max >= 1 && count[max] === 0) max--;
  if (max === 0) return { bits: 1, table: Int32Array.of(-2, -2), empty: true };   // "no symbols": invalid, 1 bit
  let left = 1;
  for (let len = 1; len <= 15; len++) {
    left = (left << 1) - count[len];
    if (left < 0) return null;
  }
  if (left > 0 && (type === 0 || max !== 1)) return null;
  const table = new Int32Array(1 << max).fill(-(max) - 1);
  const next = new Array(16).fill(0);
  let code = 0;
  count[0] = 0;
  for (let len = 1; len <= 15; len++) { code = (code + count[len - 1]) << 1; next[len] = code; }
  for (let sym = 0; sym < lens.length; sym++) {
    const len = lens[sym];
    if (!len) continue;
    let c = next[len]++, r = 0;
    for (let k = 0; k < len; k++) { r = (r << 1) | (c & 1); c >>= 1; }
    for (let i = r; i < table.length; i += 1 << len) table[i] = (sym << 5) | len;
  }
  return { bits: max, table, empty: false };
}

let FIXED = null;
function fixedTables() {
  if (!FIXED) {
    const l = new Array(288);
    for (let i = 0; i < 144; i++) l[i] = 8;
    for (let i = 144; i < 256; i++) l[i] = 9;
    for (let i = 256; i < 280; i++) l[i] = 7;
    for (let i = 280; i < 288; i++) l[i] = 8;
    FIXED = { len: buildTable(l, 1), dist: buildTable(new Array(32).fill(5), 2) };
  }
  return FIXED;
}

function adler32(buf, n) {
  let a = 1, b = 0;
  for (let i = 0; i < n;) {
    const end = Math.min(n, i + 3800);
    for (; i < end; i++) { a += buf[i]; b += a; }
    a %= 65521;
    b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

class Inflate {
  constructor(input, maxLength) {
    this.in = input;
    this.pos = 0;
    this.bitbuf = 0;
    this.bitcnt = 0;
    this.max = maxLength;
    this.out = new Uint8Array(Math.min(maxLength, Math.max(1024, input.length * 4)));
    this.n = 0;
  }

  need(k) {   // NEEDBITS(k), k <= 24; Stop when the input runs out
    while (this.bitcnt < k) {
      if (this.pos >= this.in.length) throw STOP;
      this.bitbuf |= this.in[this.pos++] << this.bitcnt;
      this.bitcnt += 8;
    }
  }

  bits(k) {
    this.need(k);
    const v = this.bitbuf & ((1 << k) - 1);
    this.bitbuf >>>= k;
    this.bitcnt -= k;
    return v;
  }

  // decode one symbol: as soon as the code's own bits are available (zlib pads missing bits with zeros)
  decode(t) {
    for (;;) {
      const e = t.table[this.bitbuf & ((1 << t.bits) - 1)];
      const len = e < 0 ? -e - 1 : e & 31;
      if (len <= this.bitcnt) {
        this.bitbuf >>>= len;
        this.bitcnt -= len;
        return e < 0 ? -1 : e >> 5;
      }
      if (this.pos >= this.in.length) throw STOP;
      this.bitbuf |= this.in[this.pos++] << this.bitcnt;
      this.bitcnt += 8;
    }
  }

  room(k) {   // grow the output buffer for k more bytes (never past max)
    if (this.n + k <= this.out.length) return;
    let size = this.out.length;
    while (size < this.n + k) size *= 2;
    const next = new Uint8Array(Math.min(this.max, size));
    next.set(this.out.subarray(0, this.n));
    this.out = next;
  }

  run() {
    try {
      this.header();
      let last = false;
      while (!last) {
        last = this.bits(1) === 1;
        const type = this.bits(2);
        if (type === 0) this.stored();
        else if (type === 1) this.codes(fixedTables().len, fixedTables().dist);
        else if (type === 2) this.dynamic();
        else throw new ZlibError("invalid block type");
      }
      // CHECK: byte align, then the big-endian Adler-32 of everything written
      this.bitbuf >>>= this.bitcnt & 7;
      this.bitcnt -= this.bitcnt & 7;
      let check = 0;
      for (let k = 0; k < 4; k++) check = check * 256 + this.bits(8);
      if (check !== adler32(this.out, this.n)) throw new ZlibError("incorrect data check");
    } catch (e) {
      if (e !== STOP) throw e;
    }
    return this.out.slice(0, this.n);
  }

  header() {
    this.need(16);
    const cmf = this.bitbuf & 0xff, flg = (this.bitbuf >>> 8) & 0xff;
    if (((cmf << 8) + flg) % 31) throw new ZlibError("incorrect header check");
    if ((cmf & 0x0f) !== 8) throw new ZlibError("unknown compression method");
    if ((cmf >> 4) + 8 > 15) throw new ZlibError("invalid window size");
    this.bits(16);
    if (flg & 0x20) {              // preset dictionary: zlib asks for it (Z_NEED_DICT), Python raises
      this.need(16);
      this.bits(16);
      this.need(16);
      throw new ZlibErrorNeedDict();
    }
  }

  stored() {
    this.bitbuf >>>= this.bitcnt & 7;
    this.bitcnt -= this.bitcnt & 7;
    this.pos -= this.bitcnt >> 3;  // whole bytes still in the bit buffer go back to the input
    this.bitbuf = 0;
    this.bitcnt = 0;
    if (this.pos + 4 > this.in.length) { this.pos = this.in.length; throw STOP; }
    const len = this.in[this.pos] | (this.in[this.pos + 1] << 8);
    const nlen = this.in[this.pos + 2] | (this.in[this.pos + 3] << 8);
    this.pos += 4;
    if (len !== (nlen ^ 0xffff)) throw new ZlibError("invalid stored block lengths");
    let left = len;
    while (left > 0) {
      const copy = Math.min(left, this.in.length - this.pos, this.max - this.n);
      if (copy === 0) throw STOP;
      this.room(copy);
      this.out.set(this.in.subarray(this.pos, this.pos + copy), this.n);
      this.n += copy;
      this.pos += copy;
      left -= copy;
    }
  }

  dynamic() {
    this.need(14);
    const nlen = this.bits(5) + 257, ndist = this.bits(5) + 1, ncode = this.bits(4) + 4;
    if (nlen > 286 || ndist > 30) throw new ZlibError("too many length or distance symbols");
    const cl = new Array(19).fill(0);
    for (let i = 0; i < ncode; i++) cl[ORDER[i]] = this.bits(3);
    const ct = buildTable(cl, 0);
    if (!ct) throw new ZlibError("invalid code lengths set");
    const lens = [];
    while (lens.length < nlen + ndist) {
      // CODELENS: zlib reads the symbol (even from an empty code-length code: symbol 0, one bit)
      let sym;
      for (;;) {
        const e = ct.table[this.bitbuf & ((1 << ct.bits) - 1)];
        const len = e < 0 ? -e - 1 : e & 31;
        if (len <= this.bitcnt) { sym = e < 0 ? 0 : e >> 5; this.symLen = len; break; }
        if (this.pos >= this.in.length) throw STOP;
        this.bitbuf |= this.in[this.pos++] << this.bitcnt;
        this.bitcnt += 8;
      }
      if (sym < 16) {
        this.bitbuf >>>= this.symLen;
        this.bitcnt -= this.symLen;
        lens.push(sym);
        continue;
      }
      const extra = sym === 16 ? 2 : sym === 17 ? 3 : 7;
      this.need(this.symLen + extra);
      this.bitbuf >>>= this.symLen;
      this.bitcnt -= this.symLen;
      let len = 0;
      if (sym === 16) {
        if (!lens.length) throw new ZlibError("invalid bit length repeat");
        len = lens[lens.length - 1];
      }
      const copy = (sym === 16 ? 3 : sym === 17 ? 3 : 11) + this.bits(extra);
      if (lens.length + copy > nlen + ndist) throw new ZlibError("invalid bit length repeat");
      for (let k = 0; k < copy; k++) lens.push(len);
    }
    if (lens[256] === 0) throw new ZlibError("invalid code -- missing end-of-block");
    const lt = buildTable(lens.slice(0, nlen), 1);
    if (!lt) throw new ZlibError("invalid literal/lengths set");
    const dt = buildTable(lens.slice(nlen), 2);
    if (!dt) throw new ZlibError("invalid distances set");
    this.codes(lt, dt);
  }

  codes(lt, dt) {
    for (;;) {
      const sym = this.decode(lt);
      if (sym < 0 || sym > 285) throw new ZlibError("invalid literal/length code");
      if (sym < 256) {
        if (this.n >= this.max) throw STOP;          // LIT with a full output buffer
        this.room(1);
        this.out[this.n++] = sym;
        continue;
      }
      if (sym === 256) return;
      const li = sym - 257;
      let length = LEN_BASE[li] + (LEN_EXTRA[li] ? this.bits(LEN_EXTRA[li]) : 0);
      const ds = this.decode(dt);
      if (ds < 0 || ds > 29) throw new ZlibError("invalid distance code");
      const dist = DIST_BASE[ds] + (DIST_EXTRA[ds] ? this.bits(DIST_EXTRA[ds]) : 0);
      if (dist > this.n) throw new ZlibError("invalid distance too far back");
      while (length > 0) {                            // MATCH
        if (this.n >= this.max) throw STOP;
        const copy = Math.min(length, this.max - this.n);
        this.room(copy);
        const o = this.out;
        for (let k = 0; k < copy; k++, this.n++) o[this.n] = o[this.n - dist];
        length -= copy;
      }
    }
  }
}

class ZlibErrorNeedDict extends ZlibError {
  constructor() { super("need dictionary"); this.message = "Error 2 while decompressing data"; }
}

// zlib.decompressobj().decompress(data, maxLength)
export function zlibDecompress(data, maxLength = 4 * MB) {
  return new Inflate(data, maxLength).run();
}

// ---------------------------------------------------------------------------------------------------
// PDF strings and text. Byte strings are handled as latin-1 JS strings (one char per byte) and the
// byte patterns are compiled as bytes patterns ("B": ASCII \s \w \d, as Python's bytes regexes).

const PDF_LIT = String.raw`\((?:\\.|[^\\()]|\((?:\\.|[^\\()])*\))*\)`;
const PDF_LIT_RE = re(PDF_LIT, "BS");
const PDF_SHOW_RE = re(String.raw`\[((?:` + PDF_LIT + String.raw`|[^\]()])*)\]\s*TJ|(` + PDF_LIT
  + String.raw`)\s*(?:Tj|'|")`, "BS");
const ESC = { n: 10, r: 13, t: 9, b: 8, f: 12, "(": 40, ")": 41, "\\": 92 };

// _pdf_unescape(b) on a latin-1 string
export function pdfUnescape(b) {
  let out = "";
  const n = b.length;
  let i = 0;
  while (i < n) {
    const c = b.charCodeAt(i);
    if (c === 92 && i + 1 < n) {
      const d = b.charCodeAt(i + 1);
      const dc = b[i + 1];
      if (Object.prototype.hasOwnProperty.call(ESC, dc)) {
        out += String.fromCharCode(ESC[dc]);
        i += 2;
        continue;
      }
      if (d >= 48 && d <= 55) {
        let j = i + 1;
        while (j < n && j < i + 4 && b.charCodeAt(j) >= 48 && b.charCodeAt(j) <= 55) j++;
        out += String.fromCharCode(parseInt(b.slice(i + 1, j), 8) & 0xff);
        i = j;
        continue;
      }
      if (d === 10 || d === 13) {
        i += 2;
        continue;
      }
      out += b[i + 1];
      i += 2;
      continue;
    }
    out += b[i];
    i++;
  }
  return out;
}

function utf16beReplace(s, start) {   // bytes.decode("utf-16-be", "replace") of s[start:] (latin-1 string)
  let out = "";
  let q = start;
  const e = s.length;
  while (e - q >= 2) {
    const ch = (s.charCodeAt(q) << 8) | s.charCodeAt(q + 1);
    q += 2;
    if (ch < 0xd800 || ch > 0xdfff) { out += String.fromCharCode(ch); continue; }
    if (ch >= 0xdc00) { out += "�"; continue; }                 // lone low surrogate
    if (e - q < 2) { out += "�"; return out; }                   // unexpected end of data
    const ch2 = (s.charCodeAt(q) << 8) | s.charCodeAt(q + 1);
    if (ch2 < 0xdc00 || ch2 > 0xdfff) { out += "�"; continue; }  // illegal surrogate: reread ch2
    q += 2;
    out += String.fromCharCode(ch, ch2);
  }
  if (q < e) out += "�";                                         // truncated data
  return out;
}

function latin1Bytes(s) {
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
  return b;
}

const HEX_JUNK = re("[^0-9A-Fa-f]", "B");

// _pdf_string(token): decode a PDF literal "(..)" or hex "<..>" string
export function pdfString(token) {
  token = bstrip(token);
  let raw;
  if (token.startsWith("<")) {
    let hexs = HEX_JUNK.sub("", token);
    if (hexs.length % 2) hexs += "0";
    raw = "";
    for (let i = 0; i < hexs.length; i += 2) raw += String.fromCharCode(parseInt(hexs.slice(i, i + 2), 16));
  } else {
    raw = pdfUnescape(token.slice(1, -1));
  }
  if (raw.startsWith("\xfe\xff")) return utf16beReplace(raw, 2);
  if (raw.startsWith("\xef\xbb\xbf")) return decodeUtf8(latin1Bytes(raw.slice(3)));
  return raw;
}

function bstrip(s) {   // bytes.strip(): ASCII whitespace
  let a = 0, b = s.length;
  const isWs = (c) => c === 32 || (c >= 9 && c <= 13);
  while (a < b && isWs(s.charCodeAt(a))) a++;
  while (b > a && isWs(s.charCodeAt(b - 1))) b--;
  return s.slice(a, b);
}

// _pdf_text(content): the text shown by Tj / TJ / ' / " operators, latin-1
export function pdfText(content) {
  const parts = [];
  for (const m of PDF_SHOW_RE.finditer(content)) {
    if (m.group(1) !== null) parts.push(PDF_LIT_RE.findall(m.group(1)).map((x) => pdfUnescape(x.slice(1, -1))).join(""));
    else parts.push(pdfUnescape(m.group(2).slice(1, -1)));
  }
  return parts.join(" ");
}

const BAD_TITLE = re(String.raw`\.(?:dvi|docx?|tex|pdf|indd|qxd|rtf)\b|microsoft word|untitled|^arxiv|template|`
  + String.raw`^\s*paper\s*\d*\s*$`, "I");

export function goodPdfTitle(t) {
  t = ws(t);
  if (pySplit(t).length < 3 || cpLen(t) > 300) return false;
  return !BAD_TITLE.search(t);
}

const STAMP_NEW = re(String.raw`arXiv:\s*(\d{4}\.\d{4,5})(v\d+)?\s*\[[a-z\-]+(?:\.[A-Za-z\-]+)?\]`);
const STAMP_OLD = re(String.raw`arXiv:\s*([a-z\-]+(?:\.[A-Za-z\-]+)?/\d{7})(v\d+)?\s*\[[a-z\-]+(?:\.[A-Za-z\-]+)?\]`);

// _arxiv_stamp(text): arXiv's margin stamp "arXiv:1706.03762v7  [cs.CL]  2 Aug 2023" -> "1706.03762v7"
export function arxivStamp(text) {
  const mm = STAMP_NEW.search(text) || STAMP_OLD.search(text);
  if (!mm) return "";
  return matchArxivExact(mm.group(1) + (mm.group(2) || ""));
}

// ---------------------------------------------------------------------------------------------------
// pdf_identifiers / sniff_pdf_file

const P = {
  xmp: re("<x:xmpmeta.*?</x:xmpmeta>", "BS"),
  streamStart: re(String.raw`(?<!end)stream\r?\n`, "B"),
  skipHdr: re(String.raw`/Subtype\s*/Image|/FontFile|/Length1|/Subtype\s*/(?:Type1C|CIDFontType0C|OpenType|XML)`
    + String.raw`|/Type\s*/XRef|/ICCBased|/N\s+[34]\b`, "B"),
  xmpDoi: [String.raw`<prism:doi>\s*([^<]+?)\s*</prism:doi>`, String.raw`prism:doi=\"([^\"]+)\"`,
    String.raw`<pdfx:doi>\s*([^<]+?)\s*<`, String.raw`pdfx:doi=\"([^\"]+)\"`,
    String.raw`<crossmark:DOI>\s*([^<]+?)\s*<`, String.raw`crossmark:DOI=\"([^\"]+)\"`,
    String.raw`<dc:identifier>\s*(?:<[^>]+>\s*)*(?:doi:\s*|https?://(?:dx\.)?doi\.org/)?(10\.\d{4,9}/[^<\s]+)`]
    .map((p) => re(p, "I")),
  xmpTitle: re(String.raw`<dc:title>.*?<rdf:li[^>]*>(.*?)</rdf:li>`, "S"),
  dict: re(String.raw`<<((?:(?!<<|>>).){0,4000}?)>>`, "BS"),
  infoDoi: re(String.raw`/(?:doi|DOI)\s*(` + PDF_LIT + String.raw`|<[0-9A-Fa-f\s]+>)`, "B"),
  infoTitle: re(String.raw`/Title\s*(` + PDF_LIT + String.raw`|<[0-9A-Fa-f\s]+>)`, "B"),
};

function toBytes(data) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return null;
}

// _is_pdf_bytes(body)
export function isPdfBytes(body) {
  const b = toBytes(body);
  return b ? decodeLatin1(b.subarray(0, 1024)).includes("%PDF") : false;
}

// _is_html_bytes(body)
export function isHtmlBytes(body) {
  const b = toBytes(body);
  if (!b) return false;
  let head = decodeLatin1(b.subarray(0, 2048));
  let a = 0;
  while (a < head.length && (head.charCodeAt(a) === 32 || (head.charCodeAt(a) >= 9 && head.charCodeAt(a) <= 13))) a++;
  head = head.slice(a).replace(/[A-Z]+/g, (x) => x.toLowerCase());
  return ["<!doctype html", "<html", "<head", "<!--", "<?xml"].some((p) => head.startsWith(p)) || head.includes("<html");
}

// _human_size(n)
export function humanSize(n) {
  if (n >= MB) {
    const x = n / MB, f = Math.floor(x), d = x - f;
    const r = d > 0.5 ? f + 1 : d < 0.5 ? f : (f % 2 ? f + 1 : f);   // format(".0f"): half to even
    return `${r} MB`;
  }
  return `${Math.max(1, Math.floor(n / 1024))} KB`;
}

// _not_pdf_message(head, final_url)
export function notPdfMessage(head, finalUrl) {
  const h = host(finalUrl) || "The server";
  if (isHtmlBytes(head)) {
    return `${h} sent a web page instead of a PDF (usually a login, paywall or `
      + "bot-check page). Open the link in your browser and attach the PDF yourself.";
  }
  return `${h} did not send a PDF file.`;
}

function rfind(s, sub, lo, hi) {   // bytes.rfind(sub, lo, hi)
  if (hi - lo < sub.length) return -1;
  const i = s.lastIndexOf(sub, hi - sub.length);
  return i >= lo ? i : -1;
}

// pdf_identifiers(data): a DOI, an arXiv id (from arXiv's margin stamp) and a title in PDF bytes.
// -> {doi, arxiv, title}; never throws
export function pdfIdentifiers(data) {
  const out = { doi: "", arxiv: "", title: "" };
  try {
    const bytes = toBytes(data);
    if (!bytes || !isPdfBytes(bytes.subarray(0, 1024))) return out;
    const s = decodeLatin1(bytes);
    const xmps = [];
    for (const m of P.xmp.finditer(s.slice(0, 8 * MB))) {
      if (xmps.length >= 4) break;
      xmps.push(m.group(0));
    }
    const infos = [s];
    const texts = [];
    const starts = [...P.streamStart.finditer(s)].map((m) => [m.index, m.index + m.group(0).length]);
    const order = starts.slice(-30).reverse().concat(starts.slice(0, Math.max(0, starts.length - 30)));
    let budget = 64 * MB;
    for (let n = 0; n < order.length; n++) {
      if (n >= 600 || budget <= 0 || (out.arxiv && texts.length >= 8)) break;
      const [mStart, mEnd] = order[n];
      const k = rfind(s, "obj", Math.max(0, mStart - 1500), mStart);
      const hdr = s.slice(k >= 0 ? k : Math.max(0, mStart - 1500), mStart);
      if (!hdr.includes("FlateDecode")) continue;
      if (P.skipHdr.search(hdr)) continue;
      const end = s.indexOf("endstream", mEnd);
      const raw = end < 0 ? bytes.subarray(mEnd) : bytes.subarray(mEnd, Math.max(mEnd, end));
      let dec;
      try {
        dec = zlibDecompress(raw, 4 * MB);
      } catch (e) {
        if (e instanceof ZlibError) continue;
        throw e;
      }
      budget -= dec.length;
      const ds = decodeLatin1(dec);
      if (ds.includes("xmpmeta")) xmps.push(ds);
      else if (hdr.includes("/ObjStm")) infos.push(ds);
      else if (ds.includes("Tj") || ds.includes("TJ")) {
        const t = pdfText(ds);
        texts.push(t);
        if (!out.arxiv) out.arxiv = arxivStamp(t);
      }
    }
    for (const x of xmps) {
      const xs = decodeUtf8(latin1Bytes(x));
      if (!out.doi) {
        for (const pat of P.xmpDoi) {
          const mm = pat.search(xs);
          if (mm) {
            const d = cleanDoi(mm.group(1));
            if (d) {
              out.doi = d;
              break;
            }
          }
        }
      }
      if (!out.title) {
        const mm = P.xmpTitle.search(xs);
        if (mm && goodPdfTitle(cleanText(mm.group(1)))) out.title = cleanText(mm.group(1));
      }
    }
    for (const blob of infos) {
      for (const dm of P.dict.finditer(blob)) {
        const body = dm.group(1);
        if (!body.includes("/Producer") && !body.includes("/CreationDate") && !body.includes("/Creator")) continue;
        if (!out.doi) {
          const mm = P.infoDoi.search(body);
          if (mm) out.doi = cleanDoi(pdfString(mm.group(1)));
        }
        if (!out.title) {
          const mm = P.infoTitle.search(body);
          if (mm) {
            const t = ws(pdfString(mm.group(1)));
            if (goodPdfTitle(t)) out.title = t;
          }
        }
      }
    }
  } catch {
    // like Python's "except Exception: pass": keep what was found
  }
  return out;
}

const NEWLINE = Uint8Array.of(10);

function joinHeadTail(head, tail) {
  const b = new Uint8Array(head.length + 1 + tail.length);
  b.set(head, 0);
  b.set(NEWLINE, head.length);
  b.set(tail, head.length + 1);
  return b;
}

// sniff_pdf_file(path, max_bytes): pdf_identifiers of the first max_bytes plus the last 512 KB
export function sniffPdf(input, { maxBytes = 8 * MB } = {}) {
  const empty = () => ({ doi: "", arxiv: "", title: "" });
  if (typeof Blob !== "undefined" && input instanceof Blob) return sniffPdfFile(input, { maxBytes });
  const bytes = toBytes(input);
  if (!bytes) return empty();
  const size = bytes.length;
  const head = bytes.subarray(0, maxBytes);
  const tail = size > maxBytes ? bytes.subarray(Math.max(maxBytes, size - 512 * 1024)) : new Uint8Array(0);
  return pdfIdentifiers(joinHeadTail(head, tail));
}

export async function sniffPdfFile(blob, { maxBytes = 8 * MB } = {}) {
  try {
    if (!(typeof Blob !== "undefined" && blob instanceof Blob)) return sniffPdf(blob, { maxBytes });
    const size = blob.size;
    const head = new Uint8Array(await blob.slice(0, maxBytes).arrayBuffer());
    const tail = size > maxBytes ? new Uint8Array(await blob.slice(Math.max(maxBytes, size - 512 * 1024)).arrayBuffer())
      : new Uint8Array(0);
    return pdfIdentifiers(joinHeadTail(head, tail));
  } catch {
    return { doi: "", arxiv: "", title: "" };
  }
}
