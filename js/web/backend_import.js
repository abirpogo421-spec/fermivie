// server.py's import helpers for the browser back end (WEB_CONTRACT.md 6.5): do_import, do_import_file,
// do_enrich, do_find_preprint, do_fetch_attachment, has_published, attach_local_published, _att_label,
// _pdf_candidates, _idents, _download_first, _title_from_name and _setting. Same steps in the same order,
// same results, statuses and messages. Network work happens outside the library lock, as in Python.
//
// ctx = {lib: Library, I: importers (resolve, downloadPdf, findPreprint, parseInput, citekey, sniffPdf,
//        emptyMeta, normTitle, NO_OA_PDF_WARNING), pub: published.js, watchDirs: async () => [LibFS]}
// Where Python has a temp file the browser has the PDF's bytes (a Uint8Array): the files written to the
// library are the same, and no temp file is ever left behind.

import { StoreError, bad, notFound } from "./store/index.js";
import * as py from "./store/py.js";
import { sha256Hex } from "./pyjson.js";
import { urlsplit } from "./importers/parse.js";
import { basename, splitext, joinUnique } from "./backend_http.js";

export const RESOLVE_TIMEOUT = 25;

const VERSION_END = new RegExp(`v[${py.DIGIT_CLASS}]+$`, "u");
const ARXIV_V = new RegExp(`v([${py.DIGIT_CLASS}]+)(?:\\.pdf)?(?=\\n?$)`, "u");
const HTTP = /^https?:\/\//iu;
const KNOWN = ["aps.org", "nature.com", "science.org", "acs.org", "wiley.com", "iop.org", "springer.com", "pnas.org",
  "sciencedirect.com", "elsevier.com", "tandfonline.com", "oup.com", "cambridge.org", "aip.org",
  "optica.org", "ieee.org", "mdpi.com", "frontiersin.org", "plos.org", "rsc.org", "annualreviews.org"];

const or = (v, d) => (py.truthy(v) ? v : d);
/** Python's `a or f()`: f only runs when a is falsy (it may make network calls). */
const orElse = async (v, f) => (py.truthy(v) ? v : await f());
const get = (d, k, dflt = null) => (py.isDict(d) ? py.pg(d, k, dflt) : dflt);

/** urlsplit(u).hostname (None -> null) */
function hostnameOf(u) {
  const h = urlsplit(u).hostname;
  return h === undefined ? null : h;
}

/** _att_label(res, url): what to call a downloaded PDF. */
export function attLabel(ctx, res, url) {
  const meta = or(get(res, "meta"), {});
  if (py.truthy(url) && !ctx.pub.isPreprintUrl(url) && py.truthy(py.pg(meta, "doi"))) {
    // the publisher's own site is the published version; a copy from a repository may be the accepted manuscript
    const host = or(hostnameOf(url), "");
    const pub = new Set([...ctx.pub.journalPdfUrls(meta.doi), or(py.pg(meta, "url"), "")].filter((u) => py.truthy(u)).map(hostnameOf));
    if (pub.has(host) || KNOWN.some((k) => host === k || host.endsWith("." + k))) return "Published version";
    return "Open-access copy";
  }
  if (py.truthy(py.pg(meta, "arxiv")) && (url || "").includes("arxiv.org")) {
    let v = or(py.pg(meta, "arxiv_version"), "");
    const m = ARXIV_V.exec(url || "");
    if (m) v = "v" + m[1];
    return py.strip(`arXiv ${v}`);
  }
  return "PDF";
}

/** _pdf_candidates(res) */
export function pdfCandidates(res) {
  const out = [];
  for (const u of [py.pg(res, "pdf_url"), ...py.iter(py.pg(res, "pdf_candidates"))]) {
    if (py.truthy(u) && !py.inList(out, u)) out.push(u);
  }
  return out;
}

/** _idents(meta, doi, arxiv, sha) -> Set */
export function idents(meta = null, { doi = "", arxiv = "", sha = "" } = {}) {
  meta = or(meta, {});
  const out = new Set();
  const d = py.lower(py.strip(or(doi, or(py.pg(meta, "doi"), ""))));
  const a = py.lower(py.strip(or(arxiv, or(py.pg(meta, "arxiv"), "")))).replace(VERSION_END, "");
  if (d) out.add("doi:" + d);
  if (a) out.add("arxiv:" + a);
  if (py.truthy(sha)) out.add("sha:" + sha);
  return out;
}

/** _download_first(cands): try each URL (at most 6) -> [bytes, result, url] or [null, errors, null]. */
export async function downloadFirst(ctx, cands) {
  const errors = [];
  for (const u of cands.slice(0, 6)) {
    const r = await ctx.I.downloadPdf(u);
    if (r && r.ok) return [r.bytes, r, u];
    errors.push(or(r && r.error, "download failed"));
  }
  return [null, errors, null];
}

/** _setting(section, key, default): a saved setting, or the default when settings.json can't be read. */
export async function setting(ctx, section, key, dflt) {
  let st;
  try {
    st = await ctx.lib.getSettings();
  } catch (e) {
    if (e instanceof StoreError) return dflt;
    throw e;
  }
  return py.pg(py.pg(st, section, {}), key, dflt);
}

/** _title_from_name(name) */
export function titleFromName(name) {
  const stem = splitext(basename(or(name, "")))[0];
  return py.strip(stem.replace(/_+/g, " ")) || "Untitled";
}

/** has_published(item) */
export function hasPublished(ctx, item) {
  return py.iterStrict(py.pg(item, "attachments", [])).some((a) => !ctx.pub.isPreprintUrl(py.pg(a, "url"))
    && py.lower(py.str(or(py.pg(a, "label"), ""))).startsWith("published"));
}

/** attach_local_published(key, since, make_default) -> [item, folder] or [null, ""]. */
export async function attachLocalPublished(ctx, key, { since = null, makeDefault = true } = {}) {
  const L = ctx.lib;
  const it = L.getItem(await L.load(), key);
  const found = await ctx.pub.findLocalPdf(it, { since, dirs: await ctx.watchDirs() });
  if (!found) return [null, ""];
  const folder = found.folder || "Downloads";
  let item, att;
  try { // no url: where the file was found never goes into library.json
    const data = (await found.fs.readFile(found.path)) || (await found.fs.readBytes(found.path));
    if (!data) return [null, ""];
    [item, att] = await L.addAttachmentBytes(key, data, "Published version", { source: "file", url: "", prefer: "published" });
  } catch (e) {
    if (e instanceof StoreError) return [null, ""];
    throw e;
  }
  if (!makeDefault) return [item, folder];
  return [await L.patchItem(key, { primary: att.key }), folder];
}

/** store.add_to_project(dup, project) or store.get_item(store.load(), dup) */
async function dupItem(L, dup, project) {
  return (await L.addToProject(dup, project)) || L.getItem(await L.load(), dup);
}

/** do_import(inp, project) */
export async function doImport(ctx, inp, project) {
  const { lib: L, I, pub } = ctx;
  if (typeof inp !== "string" || !py.strip(inp)) throw bad("Paste an arXiv ID, DOI, or link.");
  let lib = await L.load();
  if (py.truthy(project) && !L.projectIds(lib).has(py.hashable(project))) throw bad("That project does not exist.");
  const p = I.parseInput(inp);
  let dup = L.findDuplicate(lib, { doi: py.pg(p, "doi"), arxiv: py.pg(p, "arxiv") });
  if (dup) return { item: await dupItem(L, dup, project), duplicate: true, warnings: [] };
  const res = await I.resolve(inp, { timeout: RESOLVE_TIMEOUT });
  if (!py.truthy(py.pg(res, "ok"))) {
    throw new StoreError(422, or(py.pg(res, "error"), "Couldn't find that paper."), { candidates: or(py.pg(res, "candidates"), []) });
  }
  const meta = or(py.pg(res, "meta"), {});
  let warnings = [...py.iter(py.pg(res, "warnings"))];
  const ids = idents(meta);
  let key;
  [key, dup] = await L.reserve(ids, I.citekey(meta));
  if (dup) return { item: await dupItem(L, dup, project), duplicate: true, warnings: [] };
  try {
    let cands = pdfCandidates(res);
    const preferJournal = py.truthy(await setting(ctx, "library", "preferJournal", true));
    if (py.truthy(py.pg(meta, "doi"))) {
      const jurls = pub.journalPdfUrls(meta.doi).filter((u) => !cands.includes(u));
      cands = preferJournal ? [...jurls, ...cands] : [...cands, ...jurls];
    }
    let [pdf, dl, url] = [null, [], null];
    if (cands.length) [pdf, dl, url] = await downloadFirst(ctx, cands);
    if (!pdf && py.pg(meta, "type") !== "preprint" && py.truthy(await setting(ctx, "library", "preprintFallback", true))) {
      // the journal won't hand over its PDF (paywall) and no preprint was listed: look for one on arXiv
      const aid = await orElse(py.pg(meta, "arxiv"), () => I.findPreprint(meta, { timeout: RESOLVE_TIMEOUT }));
      const apdf = py.truthy(aid) ? `https://arxiv.org/pdf/${py.str(aid)}` : "";
      if (apdf && !cands.includes(apdf)) {
        const pdup = L.findDuplicate(await L.load(), { arxiv: aid });
        if (pdup) {
          return { item: await dupItem(L, pdup, project), duplicate: true,
            warnings: ["The arXiv version of this paper is already in your library."] };
        }
        let dl2;
        [pdf, dl2, url] = await downloadFirst(ctx, [apdf]);
        if (pdf) {
          dl = dl2;
          meta.arxiv = or(py.pg(meta, "arxiv"), aid);
          warnings = warnings.filter((w) => w !== I.NO_OA_PDF_WARNING && !w.includes("Attach it yourself")
            && !w.includes("published version may differ"));
          warnings.push(`The journal's PDF isn't open to download, so this is the arXiv preprint `
            + `(arXiv ${py.str(aid)}); it may differ from the published version.`);
        }
      }
    }
    if (pdf) {
      lib = await L.load();
      const sdup = L.findDuplicate(lib, { sha: py.pg(dl, "sha256") });
      if (sdup) return { item: await dupItem(L, sdup, project), duplicate: true, warnings: [] };
    } else if (cands.length) {
      warnings.push("Couldn't download the PDF (" + joinUnique(dl) + "). Attach it yourself.");
    } else if (!warnings.includes(I.NO_OA_PDF_WARNING)) {
      warnings.push(I.NO_OA_PDF_WARNING);
    }
    let item = await L.createItem(meta, { project, key });
    if (pdf) {
      const final = or(py.pg(dl, "final_url"), url);
      [item] = await L.addAttachmentBytes(key, pdf, attLabel(ctx, res, final), { source: "url", url: final, prefer: "main" });
    }
    // already downloaded the journal version (e.g. through your library's access)? use it
    if (!hasPublished(ctx, item)) {
      const [got, folder] = await attachLocalPublished(ctx, key,
        { makeDefault: preferJournal || !py.truthy(py.pg(item, "attachments")) });
      if (got) {
        item = got;
        warnings = warnings.filter((w) => !w.includes("preprint") && w !== I.NO_OA_PDF_WARNING);
        warnings.push(`Used the journal PDF from your ${folder} folder.`);
      }
    }
    return { item, duplicate: false, warnings };
  } finally {
    await L.release(ids, key);
  }
}

/** I.resolve(text, {timeout}) as `try: res = importers.resolve(...) except Exception: res = {"ok": False}` */
async function resolveQuietly(I, text, timeout) {
  try {
    return await I.resolve(text, { timeout });
  } catch {
    return { ok: false };
  }
}

/** do_import_file(pdf, name, project): pdf is the uploaded PDF's bytes (after the upload checks). */
export async function doImportFile(ctx, pdf, name, project) {
  const { lib: L, I } = ctx;
  const lib = await L.load();
  if (py.truthy(project) && !L.projectIds(lib).has(py.hashable(project))) throw bad("That project does not exist.");
  const sha = await sha256Hex(pdf);
  let dup = L.findDuplicate(lib, { sha });
  if (dup) return { item: await dupItem(L, dup, project), duplicate: true, warnings: [] };
  const warnings = [];
  let idsFound = (await I.sniffPdf(pdf)) || {};
  let meta = I.emptyMeta();
  meta.title = or(py.pg(idsFound, "title"), titleFromName(name));
  let byTitle = null;
  let res;
  if (!(py.truthy(py.pg(idsFound, "arxiv")) || py.truthy(py.pg(idsFound, "doi"))) && py.truthy(py.pg(idsFound, "title"))) {
    // many journal PDFs carry a good title but no DOI we can read: look the title up and
    // take the result only when its title is exactly the PDF's
    res = await resolveQuietly(I, idsFound.title, 15);
    const m = or(get(res, "meta"), {});
    if (py.truthy(get(res, "ok")) && py.truthy(py.pg(m, "title")) && I.normTitle(m.title) === I.normTitle(idsFound.title)) {
      byTitle = res;
      idsFound = { ...idsFound, doi: or(py.pg(m, "doi"), ""), arxiv: or(py.pg(m, "arxiv"), "") };
    }
  }
  if (py.truthy(py.pg(idsFound, "arxiv")) || py.truthy(py.pg(idsFound, "doi"))) {
    dup = L.findDuplicate(lib, { doi: py.pg(idsFound, "doi"), arxiv: py.pg(idsFound, "arxiv") });
    if (dup) return { item: await dupItem(L, dup, project), duplicate: true, warnings: ["The same paper is already in your library."] };
    const q = or(py.pg(idsFound, "arxiv"), py.pg(idsFound, "doi"));
    res = byTitle || (await resolveQuietly(I, q, 15));
    if (py.truthy(get(res, "ok")) && py.truthy(get(res, "meta"))) {
      meta = res.meta;
    } else {
      meta.arxiv = or(py.pg(idsFound, "arxiv"), "");
      meta.doi = or(py.pg(idsFound, "doi"), "");
      if (py.truthy(py.pg(idsFound, "arxiv"))) meta.type = "preprint";
      warnings.push("Couldn't fetch the metadata online; fill it in or use Fetch metadata.");
    }
  }
  const ids = idents(meta, { sha });
  let key;
  [key, dup] = await L.reserve(ids, I.citekey(meta));
  if (dup) return { item: await dupItem(L, dup, project), duplicate: true, warnings: [] };
  try {
    await L.createItem(meta, { project, key });
    const label = basename(or(name, "")) || "PDF";
    const [item] = await L.addAttachmentBytes(key, pdf, label, { source: "file", prefer: "main" });
    return { item, duplicate: false, warnings };
  } finally {
    await L.release(ids, key);
  }
}

/** do_enrich(key, body) */
export async function doEnrich(ctx, key, body) {
  const { lib: L, I } = ctx;
  const inp = py.pg(body, "input");
  if (typeof inp !== "string" || !py.strip(inp)) throw bad("Give a DOI, arXiv ID or link.");
  L.getItem(await L.load(), key);
  const res = await I.resolve(inp, { timeout: RESOLVE_TIMEOUT });
  if (!py.truthy(py.pg(res, "ok"))) {
    throw new StoreError(422, or(py.pg(res, "error"), "Couldn't find metadata for that."), { candidates: or(py.pg(res, "candidates"), []) });
  }
  const item = await L.applyMeta(key, or(py.pg(res, "meta"), {}), { overwrite: py.truthy(py.pg(body, "overwrite")) });
  return { item, warnings: [...py.iter(py.pg(res, "warnings"))] };
}

/** do_fetch_attachment(key, body): download a PDF link (or what an arXiv id / DOI resolves to) as a new attachment. */
export async function doFetchAttachment(ctx, key, body) {
  const { lib: L, I } = ctx;
  const url = py.pg(body, "url");
  const label = py.pg(body, "label");
  if (typeof url !== "string" || !py.strip(url)) throw bad("Give a link to a PDF, an arXiv ID or a DOI.");
  if (label !== null && typeof label !== "string") throw bad("label must be text.");
  L.getItem(await L.load(), key);
  let [pdf, dl, used, res] = [null, [], null, {}];
  const u = py.strip(url);
  if (HTTP.test(u)) [pdf, dl, used] = await downloadFirst(ctx, [u]);
  if (!pdf) {
    res = await I.resolve(u, { timeout: RESOLVE_TIMEOUT });
    if (!py.truthy(py.pg(res, "ok"))) {
      throw new StoreError(422, or(py.pg(res, "error"), dl.length ? dl[0] : "Couldn't find a PDF there."),
        { candidates: or(py.pg(res, "candidates"), []) });
    }
    const cands = pdfCandidates(res);
    if (!cands.length) throw new StoreError(422, I.NO_OA_PDF_WARNING);
    [pdf, dl, used] = await downloadFirst(ctx, cands);
    if (!pdf) throw new StoreError(422, "Couldn't download the PDF: " + joinUnique(dl));
  }
  const final = or(py.pg(dl, "final_url"), used);
  const lab = py.strip(or(label, "")) || (py.truthy(res) ? attLabel(ctx, res, final) : "PDF");
  const [item, att] = await L.addAttachmentBytes(key, pdf, lab, { source: "url", url: final });
  return { item, attachment: att };
}

/** do_find_preprint(key): attach the arXiv preprint of a paper that's already in the library. */
export async function doFindPreprint(ctx, key) {
  const { lib: L, I, pub } = ctx;
  const it = L.getItem(await L.load(), key);
  if (py.iterStrict(py.pg(it, "attachments", [])).some((a) => pub.isPreprintUrl(py.pg(a, "url")))) {
    throw new StoreError(409, "The arXiv version is already attached.");
  }
  const aid = await orElse(py.pg(it, "arxiv"), () => I.findPreprint(
    { title: py.pg(it, "title"), authors: py.pg(it, "authors"), year: py.pg(it, "year") }, { timeout: RESOLVE_TIMEOUT }));
  if (!py.truthy(aid)) {
    throw notFound("No arXiv version of this paper was found, so there's no free copy to add. "
      + "Use Get journal PDF to download it with your own access, or Add PDF.");
  }
  const out = await doFetchAttachment(ctx, key, { url: `https://arxiv.org/pdf/${py.str(aid)}`, label: "arXiv" });
  if (!py.truthy(py.pg(it, "arxiv"))) out.item = await L.patchItem(key, { arxiv: aid });
  out.arxiv = aid;
  return out;
}
