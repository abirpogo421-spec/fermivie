// Thin wrappers over the HTTP API in CONTRACT.md §3. Every call resolves to the parsed JSON
// payload or throws an Error whose message is the server's human-readable error.
async function req(method, url, body, opts = {}) {
  const init = { method, headers: {} };
  if (body instanceof Blob || body instanceof ArrayBuffer) {
    init.body = body;
    init.headers["Content-Type"] = "application/pdf";
  } else if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers["Content-Type"] = "application/json";
  }
  if (opts.signal) init.signal = opts.signal;
  if (opts.keepalive) init.keepalive = true;
  let r;
  try { r = await fetch(url, init); }
  catch (e) { throw new Error("Can't reach the Paper Marker server. Is it running?"); }
  const ct = r.headers.get("Content-Type") || "";
  if (!ct.includes("json")) {
    if (!r.ok) throw new Error(`Server error ${r.status}`);
    return r.text();
  }
  const j = await r.json().catch(() => ({ ok: false, error: `Bad response (${r.status})` }));
  if (!r.ok || j.ok === false) {
    const err = new Error(j.error || `Server error ${r.status}`);
    err.status = r.status; err.payload = j; err.conflict = r.status === 409 || !!j.conflict;
    throw err;
  }
  return j;
}
const enc = encodeURIComponent;
const qs = (o) => Object.entries(o).filter(([, v]) => v != null && v !== "").map(([k, v]) => `${k}=${enc(v)}`).join("&");

export const api = {
  library: () => req("GET", "/api/library"),
  import: (input, project) => req("POST", "/api/import", { input, project: project || undefined }),
  importFile: (file, project) => req("POST", "/api/import/file?" + qs({ name: file.name, project }), file),
  createItem: (meta, project) => req("POST", "/api/items", { meta, project: project || undefined }),
  patchItem: (key, patch) => req("PATCH", `/api/items/${enc(key)}`, patch),
  enrich: (key, input, overwrite = false) => req("POST", `/api/items/${enc(key)}/enrich`, { input, overwrite }),
  trash: (key) => req("POST", `/api/items/${enc(key)}/trash`),
  restore: (key) => req("POST", `/api/items/${enc(key)}/restore`),
  emptyTrash: () => req("POST", "/api/trash/empty"),
  bulk: (body) => req("POST", "/api/items/bulk", body),
  addAttachmentFile: (key, file, label) => req("POST", `/api/items/${enc(key)}/attachments?` + qs({ name: file.name, label }), file),
  fetchAttachment: (key, url, label) => req("POST", `/api/items/${enc(key)}/attachments/fetch`, { url, label }),
  renameAttachment: (key, att, label) => req("PATCH", `/api/items/${enc(key)}/attachments/${enc(att)}`, { label }),
  removeAttachment: (key, att) => req("POST", `/api/items/${enc(key)}/attachments/${enc(att)}/remove`),
  getMarks: (key, att) => req("GET", `/api/items/${enc(key)}/attachments/${enc(att)}/marks`),
  saveMarks: (key, att, marks, baseRev, force = false, opts = {}) => req("POST", `/api/items/${enc(key)}/attachments/${enc(att)}/marks`, { marks, baseRev, force }, opts),
  getNotes: (key) => req("GET", `/api/items/${enc(key)}/notes`),
  saveNotes: (key, text, baseRev, force = false, opts = {}) => req("POST", `/api/items/${enc(key)}/notes`, { text, baseRev, force }, opts),
  getProjectNotes: (id) => req("GET", `/api/projects/${enc(id)}/notes`),
  saveProjectNotes: (id, text, baseRev, force = false, opts = {}) => req("POST", `/api/projects/${enc(id)}/notes`, { text, baseRev, force }, opts),
  journal: (key) => req("GET", `/api/items/${enc(key)}/journal`),
  profile: () => req("GET", "/api/profile"),
  profileAct: (act, body = {}) => req("POST", `/api/profile/${act}`, body),
  findPreprint: (key) => req("POST", `/api/items/${enc(key)}/find-preprint`, {}),
  findPublished: (key, since) => req("POST", `/api/items/${enc(key)}/find-published`, since ? { since } : {}),
  markTypes: () => req("GET", "/api/mark-types"),
  saveMarkTypes: (types, baseRev, force = false) => req("PUT", "/api/mark-types", { types, baseRev, force }),
  createProject: (name, parent) => req("POST", "/api/projects", { name, parent: parent || null }),
  patchProject: (id, patch) => req("PATCH", `/api/projects/${enc(id)}`, patch),
  deleteProject: (id) => req("POST", `/api/projects/${enc(id)}/delete`),
  search: (q, signal) => req("GET", "/api/search?" + qs({ q }), undefined, { signal }),
  bibtexUrl: ({ keys, project } = {}) => "/api/export/bibtex?" + qs({ keys: keys && keys.join(","), project }),
  bibtex: (o) => req("GET", api.bibtexUrl(o)),
  pdfUrl: (key, att) => `/files/${enc(key)}/${enc(att)}.pdf`,
  // what to hand pdfjsLib.getDocument: the PDF plus pdf.js's own fonts / character maps (for PDFs that don't
  // embed them). isEvalSupported:false closes CVE-2024-4367 (a crafted PDF running script) in this pdf.js.
  pdfSrc: (url) => ({
    url, isEvalSupported: false, cMapPacked: true,
    cMapUrl: new URL("vendor/cmaps/", document.baseURI).href,
    standardFontDataUrl: new URL("vendor/standard_fonts/", document.baseURI).href,
  }),
  cropUrl: (key, name) => `/files/${enc(key)}/crops/${enc(name)}`,
};
