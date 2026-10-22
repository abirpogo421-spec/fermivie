// The journal (published) version of a paper: port of published.py (WEB_CONTRACT.md section 6.3).
//
// - journalPdfUrls(doi): where a journal serves the PDF for a DOI (opened in a new tab with the user's own
//   access; the web version can only download the ones a web page may read, see importers/net.js).
// - findLocalPdf(item, {since, dirs, sniffLimit}): a PDF of this paper the user already has in one of the
//   folders they granted (their Downloads folder, say), matched by DOI in the file name or inside the PDF.
//   Files are only read, never moved. Returns {fs, path, name, folder, mtime, size} or null, where `fs` is the
//   folder's LibFS and `path` the file's path in it (Python returns the file's absolute path).

import { normTitle } from "./importers/names.js";
import { pyStrip, pyLower } from "./importers/text.js";
import { sniffPdf } from "./importers/pdfsniff.js";
import { sha256Hex, pyCompare } from "./pyjson.js";

export const APS = {
  physrevlett: "prl", physrevb: "prb", physreva: "pra", physrevc: "prc", physrevd: "prd",
  physreve: "pre", physrevx: "prx", physrevresearch: "prresearch", physrevapplied: "prapplied",
  physrevmaterials: "prmaterials", physrevfluids: "prfluids", physrevaccelbeams: "prab",
  physrevphyseducres: "prper", prxquantum: "prxquantum", revmodphys: "rmp", physrev: "pr",
};

const strip = (s) => pyStrip(String(s ?? ""));
const lower = (s) => pyLower(String(s ?? ""));
const afterSlash = (s) => (s.includes("/") ? s.slice(s.indexOf("/") + 1) : "");

/** journal_pdf_urls(doi): best-guess PDF links on the publisher's own site, most specific first. */
export function journalPdfUrls(doi) {
  doi = strip(doi);
  if (!lower(doi).startsWith("10.")) return [];
  const low = lower(doi);
  const out = [];
  if (low.startsWith("10.1103/")) {
    const j = afterSlash(low).split(".")[0];
    if (Object.prototype.hasOwnProperty.call(APS, j)) out.push(`https://journals.aps.org/${APS[j]}/pdf/${doi}`);
  } else if (low.startsWith("10.1038/")) {
    out.push(`https://www.nature.com/articles/${afterSlash(doi)}.pdf`);
  } else if (low.startsWith("10.1126/")) {
    out.push(`https://www.science.org/doi/pdf/${doi}`);
  } else if (low.startsWith("10.1021/")) {
    out.push(`https://pubs.acs.org/doi/pdf/${doi}`);
  } else if (low.startsWith("10.1002/") || low.startsWith("10.1111/")) {
    out.push(`https://onlinelibrary.wiley.com/doi/pdfdirect/${doi}`);
  } else if (low.startsWith("10.1088/") || low.startsWith("10.1149/")) {
    out.push(`https://iopscience.iop.org/article/${doi}/pdf`);
  } else if (low.startsWith("10.1007/") || low.startsWith("10.1186/")) {
    out.push(`https://link.springer.com/content/pdf/${doi}.pdf`);
  } else if (low.startsWith("10.1073/")) {
    out.push(`https://www.pnas.org/doi/pdf/${doi}`);
  }
  return out;
}

/** journal_open_url(doi): the journal's PDF if its pattern is known, else the DOI page. */
export function journalOpenUrl(doi) {
  const u = journalPdfUrls(doi);
  return u.length ? u[0] : (doi ? `https://doi.org/${doi}` : "");
}

/** _norm(s) */
export function norm(s) {
  return lower(s || "").replace(/[^a-z0-9]/g, "");
}

/** _name_keys(doi): file-name fragments that identify a DOI ('physrevb615337', the whole DOI, ...). */
export function nameKeys(doi) {
  doi = strip(doi);
  if (!doi) return [];
  const suffix = doi.includes("/") ? afterSlash(doi) : doi;
  const keys = [...new Set([norm(suffix), norm(doi)])];
  return keys.filter((k) => k.length >= 8);
}

/** is_preprint_url(url) */
export function isPreprintUrl(url) {
  return lower(url || "").includes("arxiv.org");
}

/** os.path.splitext(name)[0] */
function stem(name) {
  const i = name.lastIndexOf(".");
  if (i <= 0) return name;
  if (/^\.+$/.test(name.slice(0, i))) return name;
  return name.slice(0, i);
}

/** _candidates: recent PDFs (> 10 kB, at most maxAgeDays old) directly in the folders, newest first. */
export async function candidates(dirs, { maxFiles = 400, maxAgeDays = 730 } = {}) {
  const files = [];
  const cutoff = Date.now() / 1000 - maxAgeDays * 86400;
  for (const fs of dirs || []) {
    let entries;
    try {
      entries = await fs.list("");
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.kind !== "file" || !lower(e.name).endsWith(".pdf")) continue;
      let st;
      try {
        st = await fs.stat(e.name);
      } catch {
        continue;
      }
      if (!st || st.kind !== "file") continue;
      const mtime = st.mtime / 1000;
      if (mtime >= cutoff && st.size > 10000) {
        files.push({ mtime, size: st.size, fs, path: e.name, name: e.name, sortKey: `${fs.name}/${e.name}` });
      }
    }
  }
  files.sort((a, b) => (b.mtime - a.mtime) || -pyCompare(a.sortKey, b.sortKey) || (b.size - a.size));
  return files.slice(0, maxFiles);
}

const sniffCache = new WeakMap();   // fs -> Map(path -> {sig, ids})

/** _sniff: sniff_pdf_file() for a file in a granted folder, cached by (mtime, size). Never throws. */
export async function sniff(fs, path, mtime, size) {
  let byPath = sniffCache.get(fs);
  if (!byPath) {
    byPath = new Map();
    sniffCache.set(fs, byPath);
  }
  const sig = `${mtime}:${size}`;
  const hit = byPath.get(path);
  if (hit && hit.sig === sig) return hit.ids;
  let ids;
  try {
    // sniff_pdf_file: the head (8 MB) and the tail; a Blob is read in slices, never whole
    const blob = typeof fs.readFile === "function" ? await fs.readFile(path) : null;
    ids = (await sniffPdf(blob || (await fs.readBytes(path)) || new Uint8Array(0))) || {};
  } catch {
    ids = { doi: "", arxiv: "", title: "" };
  }
  byPath.set(path, { sig, ids });
  return ids;
}

async function fileSha(fs, path) {
  const blob = typeof fs.readFile === "function" ? await fs.readFile(path) : null;
  const data = blob || (await fs.readBytes(path));
  if (!data) throw new Error("missing");
  return sha256Hex(data);
}

/**
 * find_local_pdf(item, since, sniff_limit) over the granted folders `dirs` (LibFS objects).
 * A file name match is enough; otherwise the PDF's own DOI must match (or, with no identifier in the PDF, its
 * title word for word). Preprints are ignored: the point is the journal version. since: seconds since 1970.
 */
export async function findLocalPdf(item, { since = null, dirs = [], sniffLimit = 60 } = {}) {
  const doi = strip((item && item.doi) || "");
  if (!doi || lower(doi).startsWith("10.48550/")) return null;
  const keys = nameKeys(doi);
  let title = normTitle((item && item.title) || "");
  title = title && title.split(" ").length >= 4 ? title : "";   // too short to prove anything
  const own = new Set(((item && item.attachments) || []).map((a) => a && a.sha256));
  let sniffed = 0;
  for (const f of await candidates(dirs)) {
    if (since && f.mtime < since) continue;
    const base = norm(stem(f.name));
    let hit = keys.some((k) => base.includes(k));
    if (!hit && sniffed < sniffLimit) {
      sniffed += 1;
      const ids = await sniff(f.fs, f.path, f.mtime, f.size);
      hit = lower(ids.doi || "") === lower(doi);
      // no readable DOI: the PDF's own title, word for word, is the next best proof
      if (!hit && !ids.doi && !ids.arxiv && ids.title && title) hit = normTitle(ids.title) === title;
    }
    if (hit) {
      let sha;
      try {
        sha = await fileSha(f.fs, f.path);
      } catch {
        continue;
      }
      if (own.has(sha)) continue;
      return { fs: f.fs, path: f.path, name: f.name, folder: f.fs.name, mtime: f.mtime, size: f.size };
    }
  }
  return null;
}
