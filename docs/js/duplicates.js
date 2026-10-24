// Duplicate papers: the same DOI, arXiv ID, or title and year. groups() finds them; merge() keeps the oldest
// copy, gives it everything the others have (fields, tags, projects, PDFs with their marks, notes) and moves
// the others to the Trash, where they can still be restored.
import { store } from "./store.js";
import { api } from "./api.js";

const norm = (s) => String(s || "").normalize("NFKD").replace(/\p{M}/gu, "").replace(/\\[a-zA-Z]+|[{}$\\]/g, " ")
  .toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
function idKeys(it) {
  const out = [];
  if (it.doi) out.push("doi:" + it.doi.toLowerCase());
  if (it.arxiv) out.push("arxiv:" + it.arxiv.toLowerCase().replace(/v\d+$/, ""));
  const t = norm(it.title);
  if (t.length >= 20) out.push("t:" + t + ":" + (it.year || ""));
  return out;
}

// Map(itemKey -> group id) for every paper that has a twin; papers in the Trash don't count
let cache = null, cacheLib = null, cacheSig = "";
export function groups() {
  const items = store.items();
  const sig = items.length + ":" + items.reduce((s, it) => s + (it.modified || ""), "");
  if (cache && cacheLib === store.lib && cacheSig === sig) return cache;
  const parent = new Map(items.map((it) => [it.key, it.key]));
  const find = (k) => { while (parent.get(k) !== k) { parent.set(k, parent.get(parent.get(k))); k = parent.get(k); } return k; };
  const seen = new Map();
  for (const it of items) for (const id of idKeys(it)) {
    if (seen.has(id)) parent.set(find(it.key), find(seen.get(id)));
    else seen.set(id, it.key);
  }
  const size = new Map();
  for (const it of items) { const r = find(it.key); size.set(r, (size.get(r) || 0) + 1); }
  cache = new Map();
  for (const it of items) { const r = find(it.key); if (size.get(r) > 1) cache.set(it.key, r); }
  cacheLib = store.lib; cacheSig = sig;
  return cache;
}

const FIELDS = ["title", "authors", "year", "date", "venue", "volume", "issue", "pages", "doi", "arxiv", "url", "publisher", "abstract"];
export async function merge(keys) {
  const items = keys.map((k) => store.item(k)).filter(Boolean)
    .sort((a, b) => (b.attachments || []).length - (a.attachments || []).length || String(a.added).localeCompare(String(b.added)));
  if (items.length < 2) return null;
  const [keep, ...rest] = items;
  const patch = {};
  for (const f of FIELDS) {
    const empty = (v) => v == null || v === "" || (Array.isArray(v) && !v.length);
    if (empty(keep[f])) { const from = rest.find((it) => !empty(it[f])); if (from) patch[f] = from[f]; }
  }
  const tags = [...new Set(items.flatMap((it) => it.tags || []))], projects = [...new Set(items.flatMap((it) => it.projects || []))];
  if (tags.length > (keep.tags || []).length) patch.tags = tags;
  if (projects.length > (keep.projects || []).length) patch.projects = projects;
  if (Object.keys(patch).length) await api.patchItem(keep.key, patch);
  // PDFs come across with their marks; the same file twice is left out
  const have = new Set((keep.attachments || []).map((a) => a.sha256).filter(Boolean));
  for (const it of rest) for (const a of it.attachments || []) {
    if (a.sha256 && have.has(a.sha256)) continue;
    const doc = await api.openPdf(it.key, a.key).promise;
    let bytes;
    try { bytes = await doc.getData(); } finally { doc.destroy(); }
    const name = (a.file || a.key + ".pdf").replace(/^.*\//, "");
    const j = await api.addAttachmentFile(keep.key, new File([bytes], name, { type: "application/pdf" }), a.label || "");
    if (a.sha256) have.add(a.sha256);
    const mk = await api.getMarks(it.key, a.key);
    // a crop picture lives in the other paper's folder, so the moved mark goes without it
    if ((mk.marks || []).length) await api.saveMarks(keep.key, j.attachment.key, mk.marks.map(({ crop, ...m }) => m), 0);
  }
  const notes = [];
  for (const it of rest) { const n = await api.getNotes(it.key); if ((n.text || "").trim()) notes.push(n.text.trim()); }
  if (notes.length) {
    const cur = await api.getNotes(keep.key);
    const add = notes.filter((n) => !(cur.text || "").includes(n));
    if (add.length) await api.saveNotes(keep.key, [cur.text || "", ...add].filter((s) => s.trim()).join("\n\n"), cur.rev || 0);
  }
  await api.bulk({ keys: rest.map((it) => it.key), trash: true });
  await store.load();
  return keep.key;
}
