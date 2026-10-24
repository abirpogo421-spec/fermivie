// Thin wrappers over the HTTP API in CONTRACT.md §3. Every call resolves to the parsed JSON
// payload or throws an Error whose message is the server's human-readable error.
// Two back ends (WEB_CONTRACT.md §3): "server" (the Python server, these wrappers) and "browser" (the whole
// app in the page, js/web/backend.js, over a folder the user chose or the browser's own storage).
// api.ready() picks one; app.js awaits it before anything else.
// the Error every api method throws: the message, plus .status, .payload and .conflict like req() sets them
function apiError(status, message, extra = {}) {
  const err = new Error(message);
  err.status = status; err.payload = { ok: false, error: message, ...extra }; err.conflict = status === 409 || !!extra.conflict;
  return err;
}
async function req(method, url, body, opts = {}) {
  // never send /api requests before the back end is known (on GitHub Pages there is no server to ask)
  if (api.mode !== "server") {
    const err = new Error(api.mode === "browser" ? "That isn't available in the web version." : "Paper Marker is still starting. Try again in a moment.");
    err.status = api.mode === "browser" ? 501 : 503; err.payload = { ok: false, error: err.message }; err.conflict = false;
    throw err;
  }
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
  mode: "",            // "server" | "browser", set by api.ready()
  libraryId: "",       // "" in server mode; a stable id per opened library in browser mode
  ready: () => readyP || (readyP = pickBackend()),
  getSettings: () => req("GET", "/api/settings"),
  putSettings: (b) => req("PUT", "/api/settings", b),
  library: () => req("GET", "/api/library"),
  import: (input, project) => req("POST", "/api/import", { input, project: project || undefined }),
  importFile: (file, project) => req("POST", "/api/import/file?" + qs({ name: file.name, project }), file),
  createItem: (meta, project) => req("POST", "/api/items", { meta, project: project || undefined }),
  createItems: (items) => req("POST", "/api/items/batch", { items }),
  // [{key, file, label, marks?}] -> {results: [{key, attachment, marks?} | {key, error, duplicate?}]}. The local
  // server takes PDFs one per request (each is quick there); the browser back end saves a whole batch at once.
  addAttachments: async (entries) => {
    const results = new Array(entries.length);
    let i = 0;
    const run = async () => {
      while (i < entries.length) {
        const n = i++, e = entries[n];
        try {
          const j = await api.addAttachmentFile(e.key, e.file, e.label || "");
          const r = { key: e.key, attachment: j.attachment };
          if (e.marks && e.marks.length) r.marks = (await api.saveMarks(e.key, j.attachment.key, e.marks, 0)).marks.length;
          results[n] = r;
        } catch (err) {
          if (err.status >= 500 || !err.status) throw err;
          results[n] = { key: e.key, error: err.message, duplicate: !!(err.payload && err.payload.duplicate) };
        }
      }
    };
    await Promise.all([run(), run(), run(), run()]);
    return { ok: true, results };
  },
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
  // Get journal PDF > Choose PDF… (browser version, no Downloads folder granted): the PDF the user chose is
  // added exactly as server.py's attach_local_published adds one it found in a watched folder:
  // add_attachment_file(key, file, "Published version", source="file", url="", prefer="published",
  // move=False), then patch_item(key, {primary: att.key}) -> {ok, item, attachment}; the upload route's checks
  // first (404 "No such paper.", 413 over 300 MB, 400 "The upload is empty.", 415 "That file is not a PDF.").
  // The local app finds downloads itself, so there is no route for it; the browser back end provides it
  // (pickBackend supplies it over js/web/store when a back end doesn't).
  attachPublishedFile: () => Promise.reject(apiError(501, "That's only available in the web version.")),
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
  // a pdf.js loading task ({promise, destroy()}) for one attachment
  openPdf: (key, att) => pdfjsLib.getDocument(api.pdfSrc(api.pdfUrl(key, att))),
  // the same for PDF bytes that aren't in the library yet (a file being imported)
  openPdfData: (data) => { const { url, ...src } = api.pdfSrc(""); return pdfjsLib.getDocument({ ...src, data, isEvalSupported: false }); },
  // localStorage key for data that belongs to one library (marks safety net, open tabs, per-paper view)
  lsKey: (name) => (api.mode === "browser" && api.libraryId && String(name).startsWith("pm2:") ? "pm2:" + api.libraryId + ":" + String(name).slice(4) : name),
};

/* ---------------------------------------------------------------- choosing the back end (WEB_CONTRACT §3)
   1. ?backend=server|browser (tests); 2. settings written into the page by the Python server
   (js/boot.js sets window.__PM_SETTINGS__) -> server; 3. on localhost, ask GET api/settings (1.5 s) -> server
   when it answers {ok: true}; 4. otherwise the browser back end. No /api request ever goes to another host. */
let readyP = null;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
async function probeServer() {
  const ctl = typeof AbortController === "function" ? new AbortController() : null;
  const t = setTimeout(() => ctl && ctl.abort(), 1500);
  try {
    const r = await fetch("api/settings", { cache: "no-store", credentials: "same-origin", signal: ctl ? ctl.signal : undefined });
    if (!r.ok || !(r.headers.get("Content-Type") || "").includes("json")) return false;
    const j = await r.json();
    return !!(j && j.ok === true);
  } catch (_) { return false; }
  finally { clearTimeout(t); }
}
function whichBackend() {
  const forced = new URLSearchParams(location.search).get("backend");
  if (forced === "browser") return forced;
  if (forced === "server" && LOCAL_HOSTS.has(location.hostname)) return forced;   // never /api on another host
  if ("__PM_SETTINGS__" in window) return "server";
  return LOCAL_HOSTS.has(location.hostname) ? "probe" : "browser";
}
async function pickBackend() {
  const root = document.documentElement;
  try {
    let mode = whichBackend();
    if (mode === "probe") mode = (await probeServer()) ? "server" : "browser";
    if (mode === "server") { api.mode = "server"; return api; }
    // browser: open the library's storage (the setup screen shows when the user has to choose or re-grant
    // access), then swap in the in-page implementation; modules holding `api` keep working
    const setup = await import("./web/setup.js");
    const { createBrowserApi } = await import("./web/backend.js");
    // a storage the back end can't open (a folder on a read-only disk, say) sends the user back to the
    // setup screen with the reason, to try again or choose another; never a dead end, even after a reload
    let storage = await setup.chooseStorage(), b;
    for (;;) {
      try { b = await createBrowserApi(storage); break; }
      catch (e) { console.warn("Paper Marker couldn't open the library:", e); storage = await setup.chooseStorage({ failed: storage, error: e }); }
    }
    const keep = api.ready;
    Object.assign(api, b);
    api.ready = keep;
    if (typeof b.attachPublishedFile !== "function") api.attachPublishedFile = (key, file) => attachPublishedHere(storage, key, file);
    api.mode = "browser";
    if (!api.libraryId) api.libraryId = storage.libraryId || "";
    return api;
  } finally {
    root.removeAttribute("data-pm-booting");
  }
}

/* ---------------------------------------------------------------- attachPublishedFile over js/web/store
   For a browser back end without its own attachPublishedFile (see the api entry above). The same store
   calls as server.py's attach_local_published, so the files on disk are what the local app writes; the
   connected profile folder is told afterwards, as the back end does after every change. */
const MAX_PDF = 300 * 1024 * 1024;
async function attachPublishedHere(storage, key, file) {
  const S = await import("./web/store/index.js");
  try {
    if (typeof key !== "string" || !S.KEY_RE.test(key)) throw new S.StoreError(404, "No such paper.");   // _seg_key
    const lib = new S.Library(storage.fs, { libraryId: storage.libraryId });
    lib.getItem(await lib.load(), key);                                // the route's store.get_item: 404 first
    if (!(file instanceof Blob)) throw S.bad("The upload is empty.");
    if (file.size > MAX_PDF) throw new S.StoreError(413, `Request too large (limit ${MAX_PDF / (1024 * 1024)} MB).`);
    if (file.size <= 0) throw S.bad("The upload is empty.");
    if (!S.isPdf(new Uint8Array(await file.slice(0, 1024).arrayBuffer()))) throw new S.StoreError(415, "That file is not a PDF.");
    const [, att] = await lib.addAttachmentBytes(key, file, "Published version", { source: "file", url: "", prefer: "published" });
    const item = await lib.patchItem(key, { primary: att.key });
    import("./web/profile.js").then((P) => { if (typeof P.changed === "function") P.changed(lib); }).catch(() => {});
    return { ok: true, item, attachment: att };
  } catch (e) {
    if (e instanceof S.StoreError) throw apiError(e.status, e.message, e.extra || {});
    throw apiError(500, (e && e.message) || String(e));
  }
}
