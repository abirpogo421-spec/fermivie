// The module-level part of library_store.py: constants, StoreError, settings validation, mark types,
// item metadata normalisation, marks.md and mark counts. Same names in camelCase (WEB_CONTRACT.md 6.1).
//
// Regexes are Python-compatible: Python's "$" also matches just before a final "\n", so each anchored
// pattern accepts one trailing newline exactly where re.match would (KEY_RE.test("abc\n") is true).
// Use rx(re, value) to test like re.match(pattern, value or "").

import { nowIso } from "../pyjson.js";
import { fold, splitName } from "../importers/names.js";
import * as py from "./py.js";
import { deepCopy, assign, isFloat, exactText, markFloat, markExact } from "./libjson.js";

export const KEY_RE = /^[a-z0-9]{1,80}\n?$/;
export const ATT_RE = /^[a-z0-9-]{1,64}\n?$/;
export const PROJECT_RE = /^[a-z0-9_-]{1,64}\n?$/;
export const CROP_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,200}\.png\n?$/;
export const MARK_TYPE_ID = /^[a-z][a-z0-9-]{0,23}\n?$/;
const SECTION_ID = /^[a-z0-9-]{1,24}\n?$/;
const SETTING_KEY = /^[A-Za-z][A-Za-z0-9]{0,40}\n?$/;
const DRIVE_PATH = /^[A-Za-z]:[\\/]|^\\\\/;

/** re.match(pattern, value or "") for a str value (TypeError for anything else, as Python). */
export function rx(re, v) {
  const s = py.truthy(v) ? v : "";
  if (typeof s !== "string") throw new TypeError("expected string or bytes-like object, got '" + py.typeName(s) + "'");
  return re.test(s);
}

const deepFreeze = (o) => {
  for (const v of Object.values(o)) if (v && typeof v === "object") deepFreeze(v);
  return Object.freeze(o);
};

export const TYPES = Object.freeze(["article", "preprint", "inproceedings", "book", "thesis", "manuscript", "misc"]);
export const READ_STATES = Object.freeze(["unread", "reading", "read"]);
export const STR_FIELDS = Object.freeze(["title", "date", "venue", "volume", "issue", "pages", "doi", "arxiv",
  "arxiv_version", "url", "publisher", "abstract"]);
export const META_FIELDS = Object.freeze(["type", "title", "authors", "year", "date", "venue", "volume", "issue",
  "pages", "doi", "arxiv", "arxiv_version", "url", "publisher", "abstract", "categories"]);
export const EDITABLE = Object.freeze([...META_FIELDS, "tags", "projects", "read", "primary", "opened"]);
export const HISTORY_KEEP = 50;
export const SEARCH_MAX_HITS = 500;
export const MARK_TYPES = Object.freeze(["question", "remark", "explain"]);
export const TYPE_NAME = Object.freeze({ question: "Question", remark: "Remark", explain: "Explain" });
export const PALETTE = Object.freeze(["amber", "rose", "teal", "blue", "violet", "orange", "olive", "slate"]);
export const WINDOWS_RESERVED = Object.freeze(new Set(["con", "prn", "aux", "nul",
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`), ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`)]));
export const RESERVED_TYPE_IDS = Object.freeze(new Set(["total", "error", "all", "constructor", "prototype",
  "toString", "hasOwnProperty"]));

export const DEFAULT_MARK_TYPES = deepFreeze([
  { id: "question", name: "Question", color: "amber",
    purpose: "You don't follow why something is true or how one step leads to the next. Ask it in your own words.",
    noteLabel: "Your question", placeholder: "e.g. Why does the sign flip here?", suggest: false, hidden: false },
  { id: "remark", name: "Remark", color: "rose",
    purpose: "Something in the text should change: the wording, a number, a claim. Mostly for drafts you are writing or reviewing.",
    noteLabel: "What should change", placeholder: "e.g. Too long, cut the second clause", suggest: true, hidden: false },
  { id: "explain", name: "Explain", color: "teal",
    purpose: "A concept or term you want explained from the ground up, by a collaborator or by yourself later. The note can be left blank.",
    noteLabel: "What's unclear (optional)", placeholder: "Leave blank if the whole idea is unclear", suggest: false, hidden: false },
  { id: "highlight", name: "Highlight", color: "olive",
    purpose: "Worth keeping. No note needed; these are collected as the paper's highlights.",
    noteLabel: "Note (optional)", placeholder: "", suggest: false, hidden: false },
  { id: "cite", name: "Cite", color: "violet",
    purpose: "A claim or result you may cite in your own writing. Exported with the paper's citation key and page.",
    noteLabel: "Where you'd use it (optional)", placeholder: "e.g. Intro, background paragraph", suggest: false, hidden: false },
]);

// ---------------------------------------------------------------------------------------------------
// Errors

/** An error with an HTTP status and an optional extra payload (Python's StoreError(status, message, **extra)). */
export class StoreError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.name = "StoreError";
    this.status = status;
    this.message = message;
    this.extra = extra ?? {};
  }
}

export const bad = (msg) => new StoreError(400, msg);
export const notFound = (msg) => new StoreError(404, msg);

// ---------------------------------------------------------------------------------------------------
// Mark types

export const defaultMarkTypes = () => deepCopy(DEFAULT_MARK_TYPES);

/** Validate a list of mark types from the client. Throws bad() with a readable message. */
export function cleanMarkTypes(types) {
  if (!Array.isArray(types) || !types.length) throw bad("There must be at least one mark type.");
  if (types.length > 24) throw bad("That's too many mark types (24 at most).");
  const out = [], seen = new Set(), names = new Set();
  for (const t of types) {
    if (!py.isDict(t)) throw bad("Bad mark type.");
    const tidV = py.pg(t, "id");
    const tid = py.strip(py.truthy(tidV) ? py.strAt(t, "id") : "");
    if (!MARK_TYPE_ID.test(tid)) throw bad(`'${tid}' isn't a valid type id (lowercase letters, digits and dashes).`);
    if (RESERVED_TYPE_IDS.has(tid)) throw bad(`'${tid}' is reserved; pick another name.`);
    if (seen.has(tid)) throw bad(`Two types share the id '${tid}'.`);
    seen.add(tid);
    const nameV = py.pg(t, "name");
    const name = py.oneLine(py.truthy(nameV) ? py.strAt(t, "name") : "");
    if (!name || py.cpLen(name) > 30) throw bad("Each mark type needs a name of at most 30 characters.");
    if (names.has(py.casefold(name))) throw bad(`Two types are called '${name}'. Give each type its own name.`);
    names.add(py.casefold(name));
    const color = PALETTE.includes(py.pg(t, "color")) ? py.pg(t, "color") : "slate";
    const txt = (k, n) => {
      const v = py.pg(t, k);
      return typeof v === "string" ? py.cpSlice(v, 0, n) : "";
    };
    out.push({ id: tid, name, color, purpose: txt("purpose", 600), noteLabel: txt("noteLabel", 60) || "Note",
      placeholder: txt("placeholder", 120), suggest: py.truthy(py.pg(t, "suggest")), hidden: py.truthy(py.pg(t, "hidden")) });
  }
  if (out.every((t) => t.hidden)) throw bad("At least one mark type has to stay visible.");
  return out;
}

/** library_store.slug(s, maxlen=32, sep="-") */
export function slug(s, maxlen = 32, sep = "-") {
  let t = py.lower(fold(py.str(py.truthy(s) ? s : "")));
  t = py.stripChars(t.replace(/[^a-z0-9]+/gu, sep), sep);
  return py.stripChars(t.slice(0, maxlen), sep);
}

/** data[:1024] holds "%PDF-" (Uint8Array or ArrayBuffer). */
export function isPdf(data) {
  const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
  const head = u8.subarray(0, 1024);
  for (let i = 0; i + 5 <= head.length; i++) {
    if (head[i] === 0x25 && head[i + 1] === 0x50 && head[i + 2] === 0x44 && head[i + 3] === 0x46 && head[i + 4] === 0x2d) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------------------------------
// App settings (library/settings.json, CONTRACT.md 10.3)

export const DEFAULT_SETTINGS = deepFreeze({
  theme: "system", tabs: "horizontal", density: "comfortable",
  reader: { defaultZoom: "width", pageTheme: "normal", showFlags: true, selectionToolbar: true,
    quickKeys: true, smoothScroll: true },
  marks: { confirmDelete: true },
  library: { preferJournal: true, preprintFallback: true, watchDirs: ["~/Downloads", "~/Desktop"],
    newProjectSections: ["To mark", "Reference"] },
  profile: { folder: "", includePdfs: true, git: false, push: false },
});
export const SETTING_CHOICES = deepFreeze({
  theme: ["system", "light", "dark"],
  tabs: ["horizontal", "vertical"],
  density: ["comfortable", "compact"],
  "reader.pageTheme": ["normal", "dim", "dark"],
});

export const defaultSettings = () => deepCopy(DEFAULT_SETTINGS);

/** Python's _str_items: a list of text, stripped, deduplicated, checked against maxN entries of maxLen. */
export function strItems(v, what, maxN, maxLen) {
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) throw bad(`${what} must be a list of text.`);
  const out = [];
  for (let x of v) {
    x = py.strip(x);
    if (x && !out.includes(x)) {
      if (py.cpLen(x) > maxLen) throw bad(`${what}: “${py.cpSlice(x, 0, 40)}…” is too long.`);
      out.push(x);
    }
  }
  if (out.length > maxN) throw bad(`${what}: at most ${maxN} entries.`);
  return out;
}

const fullPath = (d) => d.startsWith("~") || d.startsWith("/") || DRIVE_PATH.test(d);

/** Validate one value against the type of its default; returns the cleaned value. */
/** Python's _setting_value: validate one settings value against its default; returns the cleaned value.
 *  holder[key] is where v was read from (str() of a file's 150.0 is "150.0", as in Python). */
export function settingValue(path, cur, v, holder = null, key = null) {
  if (Object.hasOwn(SETTING_CHOICES, path)) {
    if (!SETTING_CHOICES[path].includes(v)) throw bad(`${path} must be one of: ` + SETTING_CHOICES[path].join(", ") + ".");
    return v;
  }
  if (path === "reader.defaultZoom") {
    if (v === "width" || v === "page") return v;
    let n;
    try {
      n = py.intParse(py.rstripChars(holder !== null ? py.strAt(holder, key) : py.str(v), "%"));
    } catch (e) {
      if (e instanceof py.ValueError) throw bad("reader.defaultZoom must be width, page or a percentage.");
      throw e;
    }
    if (!(n >= 25n && n <= 800n)) throw bad("reader.defaultZoom must be between 25 and 800 %.");
    return n.toString();
  }
  if (path === "library.watchDirs") {
    const dirs = strItems(v, "Folders to watch", 20, 500);
    for (const d of dirs) {
      if (!fullPath(d)) throw bad(`“${d}” isn't a full folder path (start it with /, ~ or a drive letter).`);
    }
    return dirs;
  }
  if (path === "profile.folder") {
    if (typeof v !== "string" || py.cpLen(v) > 500) throw bad("The profile folder must be a path.");
    v = py.strip(v);
    if (v && !fullPath(v)) throw bad("Give the profile folder's full path (starting with /, ~ or a drive letter).");
    return v;
  }
  if (path === "library.newProjectSections") {
    const secs = strItems(v, "Sections for new projects", 20, 80);
    if (!secs.length) throw bad("Sections for new projects: keep at least one section.");
    return secs;
  }
  if (typeof cur === "boolean") {
    if (typeof v !== "boolean") throw bad(`${path} must be true or false.`);
    return v;
  }
  // a key added later by a view (not in the defaults): accept plain scalar values only
  if (typeof v === "boolean" || (typeof v === "number" && Math.abs(v) < 1e9) || (typeof v === "string" && py.cpLen(v) <= 200)) {
    return v;
  }
  throw bad(`${path} has an unsupported value.`);
}

/** Deep-merge a (partial) settings patch into base after validating every known key.
 *  Unknown top-level keys are dropped; unknown keys inside a known section must be plain values. */
export function mergeSettings(base, patch) {
  if (!py.isDict(patch)) throw bad("settings must be an object.");
  const out = deepCopy(base);
  for (const k of Object.keys(patch)) {
    const v = patch[k];
    if (!Object.hasOwn(DEFAULT_SETTINGS, k)) continue;
    const d = DEFAULT_SETTINGS[k];
    if (py.isDict(d)) {
      if (!py.isDict(v)) throw bad(`${k} must be an object.`);
      const sec = py.isDict(py.pg(out, k)) ? out[k] : {};
      for (const sk of Object.keys(v)) {
        if (!SETTING_KEY.test(sk)) continue;
        putSetting(sec, sk, settingValue(`${k}.${sk}`, py.pg(d, sk), v[sk], v, sk), v, sk);
      }
      py.setOwn(out, k, sec);
    } else {
      putSetting(out, k, settingValue(k, d, v, patch, k), patch, k);
    }
  }
  return out;
}

/** dst[k] = val; a number kept as it was read (src[sk]) stays a float or keeps its file digits, as in Python. */
function putSetting(dst, k, val, src, sk) {
  assign(dst, k, val); // also drops what was known about the value it replaces
  if (typeof val !== "number" || !Object.is(val, src[sk])) return;
  if (isFloat(src, sk)) markFloat(dst, k);
  else if (exactText(src, sk) !== null) markExact(dst, k, exactText(src, sk));
}

/** Stored settings on top of the defaults (stored values that no longer validate fall back). */
export function fillSettings(stored) {
  let out = defaultSettings();
  if (!py.isDict(stored)) return out;
  for (const k of Object.keys(stored)) {
    const v = stored[k];
    try {
      out = mergeSettings(out, { [k]: v });
    } catch (e) {
      if (!(e instanceof StoreError)) throw e;
      if (py.isDict(v) && py.isDict(Object.hasOwn(DEFAULT_SETTINGS, k) ? DEFAULT_SETTINGS[k] : null)) {
        for (const sk of Object.keys(v)) {
          try {
            const one = {};
            putSetting(one, sk, v[sk], v, sk);
            out = mergeSettings(out, { [k]: one });
          } catch (e2) {
            if (!(e2 instanceof StoreError)) throw e2;
          }
        }
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------
// Item normalisation

export function cleanAuthors(v) {
  const out = [];
  for (const a of py.iter(v)) {
    if (py.isDict(a)) {
      const g = py.pg(a, "given"), f = py.pg(a, "family");
      let given = py.strip(py.truthy(g) ? py.strAt(a, "given") : "");
      let family = py.strip(py.truthy(f) ? py.strAt(a, "family") : "");
      if (!family && given) [family, given] = [given, ""];
      if (family) out.push({ given, family });
    } else if (typeof a === "string" && py.strip(a)) {
      const sa = splitName(a);
      if (py.truthy(sa)) out.push(sa);
    }
  }
  return out;
}

/** library_store._year: a year 1000-2999 or null */
export function year(v) {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "boolean") return null; // bool is an int in Python, and never in range
  let y;
  if (py.isInt(v)) y = v;
  else {
    const s = py.cpSlice(py.strip(py.str(v)), 0, 4);
    try {
      y = Number(py.intParse(s));
    } catch (e) {
      if (e instanceof py.ValueError) return null;
      throw e;
    }
  }
  return y >= 1000 && y <= 2999 ? y : null;
}

export function strList(v) {
  const out = [];
  for (const x of py.iter(v)) {
    if (typeof x === "string" && py.strip(x) && !out.includes(py.strip(x))) out.push(py.strip(x));
  }
  return out;
}

const YEAR_START = new RegExp(`^[${py.DIGIT_CLASS}]{4}`, "u"); // re.match(r"^\d{4}", ...)
const ARXIV_VER = new RegExp(`^([^\\n]*?)(v[${py.DIGIT_CLASS}]+)\\n?$`, "u"); // re.match(r"^(.*?)(v\d+)$", ...)

/** Importer META (or a client dict) -> the metadata fields of an item, all present. */
export function cleanMeta(meta) {
  const m = py.isDict(meta) ? meta : {};
  const out = {};
  for (const k of STR_FIELDS) {
    const v = py.pg(m, k);
    out[k] = v === null ? "" : py.strAt(m, k);
  }
  const t = py.pg(m, "type");
  out.type = TYPES.includes(t) ? t : "misc";
  out.authors = cleanAuthors(py.pg(m, "authors"));
  out.year = year(py.pg(m, "year"));
  if (out.year === null && YEAR_START.test(out.date)) out.year = year(py.cpSlice(out.date, 0, 4));
  out.categories = strList(py.pg(m, "categories"));
  if (out.arxiv) {
    const mm = ARXIV_VER.exec(out.arxiv);
    if (mm && py.ND.test(mm[1])) {
      out.arxiv = mm[1];
      out.arxiv_version = out.arxiv_version || mm[2];
    }
  }
  return out;
}

export function newItem(key, meta, projects = [], tags = []) {
  const t = nowIso();
  return {
    key, ...cleanMeta(meta),
    tags: strList(tags), projects: [...projects], read: "unread",
    added: t, modified: t, opened: null, primary: "", attachments: [], trashed: null,
  };
}

/** Item -> META for importers bibtex / citekey. */
export function itemMeta(item) {
  const m = {};
  for (const k of META_FIELDS) m[k] = py.pg(item, k);
  if (m.type === "manuscript") m.type = "misc";
  return m;
}

// ---------------------------------------------------------------------------------------------------
// marks.md and mark counts

/** Counts per mark type id (any type, built-in or custom) plus the total. */
export function countMarks(marks) {
  const c = { question: 0, remark: 0, explain: 0, total: 0 };
  for (const m of py.iter(marks)) {
    const t = py.isDict(m) ? py.pg(m, "type") : null;
    // assign keeps Python's key order for a type id JS would list first ("5")
    if (typeof t === "string" && t && !RESERVED_TYPE_IDS.has(t)) assign(c, t, (Object.hasOwn(c, t) ? c[t] : 0) + 1);
    c.total += 1;
  }
  return c;
}

const typeIn = (t, map) => { py.hashable(t); return typeof t === "string" && map.has(t); };

/** The original marks.md layout plus a first line naming the item and attachment, and a legend saying
 *  what each mark type used here is for. */
export function marksMd(itemTitle, attLabel, key, att, doc, data, types = null) {
  const all = py.pg(data, "marks", []);
  const keyed = py.iterStrict(all).map((m, i) => {
    const page = py.pg(m, "page", 0), y = py.pg(m, "y", 0);
    return { m, k: [py.truthy(page) ? page : 0, py.truthy(y) ? y : 0], i };
  });
  keyed.sort((a, b) => py.cmpKeys(a.k, b.k) || a.i - b.i);
  const marks = keyed.map((x) => x.m);
  const savedV = py.pg(data, "savedAt");
  const saved = py.truthy(savedV) ? savedV : nowIso();
  const savedS = py.isoMinute(saved) ?? (py.truthy(savedV) ? py.strAt(data, "savedAt") : py.str(saved));
  const L = [`Item: ${py.str(py.truthy(itemTitle) ? itemTitle : key)} | Attachment: ${py.str(py.truthy(attLabel) ? attLabel : att)} (library/items/${py.str(key)}/${py.str(att)}.pdf)`,
    `# Marks on ${py.str(doc)}`, "",
    `Saved ${savedS} | ${marks.length} marks`, ""];
  types = py.truthy(types) ? types : DEFAULT_MARK_TYPES;
  const tmap = new Map();
  for (const t of types) tmap.set(py.req(t, "id"), t);
  const used = types.filter((t) => marks.some((m) => py.eq(py.pg(m, "type"), t.id)));
  const strayIds = new Set();
  for (const m of marks) {
    const t = py.pg(m, "type");
    if (typeof t === "string" && t && !tmap.has(t)) strayIds.add(t);
  }
  for (const i of py.sortStrings([...strayIds])) used.push({ id: i, name: i, purpose: "" });
  const oneLine = (x) => py.oneLine(py.str(py.truthy(x) ? x : ""));
  const legend = used.length ? used : types.filter((t) => MARK_TYPES.includes(t.id));
  for (const t of legend) {
    const n = marks.filter((m) => py.eq(py.pg(m, "type"), t.id)).length;
    L.push(`- ${oneLine(py.req(t, "name"))}: ${n}` + (py.truthy(py.pg(t, "purpose")) ? ` — ${oneLine(t.purpose)}` : ""));
  }
  L.push("");
  for (const m of marks) {
    const mt = py.pg(m, "type");
    const tname = typeIn(mt, tmap) ? py.req(tmap.get(mt), "name")
      : (typeof mt === "string" && Object.hasOwn(TYPE_NAME, mt) ? TYPE_NAME[mt] : (py.truthy(mt) ? mt : "Mark"));
    L.push(`## #${py.strAt(m, "num")} ${py.str(tname)} (p. ${py.strAt(m, "page")})`);
    if (py.truthy(py.pg(m, "quote"))) {
      const q = py.strAt(m, "quote");
      const lines = q.split("\n").map((x) => py.strip(x)).filter((x) => x);
      const eq = py.truthy(py.pg(m, "eq")) ? m.eq
        : (py.pg(m, "kind") !== "box" && lines.length >= 3 && py.cpLen(py.split(q).join("")) / lines.length < 10);
      L.push(py.truthy(eq) && py.truthy(py.pg(m, "crop")) ? "> (equation: see the picture below)" : "> " + py.oneLine(q));
    }
    if (py.truthy(py.pg(m, "note"))) L.push(`\n**Note:** ${py.strAt(m, "note")}`);
    if (py.truthy(py.pg(m, "suggest"))) L.push(`\n**Suggested wording:** ${py.strAt(m, "suggest")}`);
    if (py.truthy(py.pg(m, "crop"))) L.push(`\n![crop](crops/${py.strAt(m, "crop")})`);
    L.push("");
  }
  return L.join("\n");
}
