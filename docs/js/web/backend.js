// The browser `api` (WEB_CONTRACT.md 3, 6.5): every method of js/api.js, answered in the page from the
// library folder (or browser storage) instead of the Python server.
//
//   const b = await createBrowserApi({fs, libraryId, name, kind}, {env, importers, profile});
//   Object.assign(api, b)   (js/api.js does this in browser mode)
//
// Each method builds the request js/api.js would send (same URL, same body) and runs it through
// backend_routes.js, a port of server.py's handler, so payloads, statuses and error messages are the server's.
// Errors are thrown as js/api.js's req() throws them: an Error with .status, .payload and .conflict.
// Synchronous URL methods: pdfUrl -> "pm-web:pdf/<key>/<att>" (for openPdf), cropUrl -> an object URL from a
// cache filled by getMarks / saveMarks (else a transparent pixel), bibtexUrl -> an object URL of the BibTeX
// built from the last library loaded (revoked after 60 s).
// opts (tests): env (backend_env.js shape), importers (replacements for network functions), profile module.

import { Library, StoreError, bad, KEY_RE, ATT_RE, CROP_RE, rx, itemMeta } from "./store/index.js";
import { keysOf } from "./store/libjson.js";
import * as py from "./store/py.js";
import * as realImporters from "./importers/index.js";
import { bibtex as bibtexEntry } from "./importers/bibtex.js";
import * as published from "./published.js";
import * as realProfile from "./profile.js";
import { pyCompare, pyDumps } from "./pyjson.js";
import { makeBody, bodyPdf, parseQs, errorResponse, ok } from "./backend_http.js";
import { handle, segKey } from "./backend_routes.js";
import { ProfileActions } from "./backend_profile.js";
import { browserEnv } from "./backend_env.js";

export const VERSION = "2.3 (web)";
export const BLANK_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

const enc = encodeURIComponent;
const qs = (o) => Object.entries(o).filter(([, v]) => v != null && v !== "").map(([k, v]) => `${k}=${enc(v)}`).join("&");

/** The Error js/api.js's req() throws for an error response. */
function apiError(status, payload) {
  const err = new Error(payload.error || `Server error ${status}`);
  err.status = status;
  err.payload = payload;
  err.conflict = status === 409 || !!payload.conflict;
  return err;
}

function abortError() {
  const e = new Error("The operation was aborted.");
  e.name = "AbortError";
  return e;
}

function later(fn, ms) {
  const t = setTimeout(fn, ms);
  if (t && typeof t.unref === "function") t.unref(); // node tests: never keep the process alive
  return t;
}

/** Library.bibtex over an already loaded library (synchronous, for bibtexUrl). */
function bibtexOf(L, lib, keys, project) {
  lib = lib || { version: 1, items: {}, projects: [], savedAt: null };
  let items;
  if (keys) {
    items = keys.map((k) => L.getItem(lib, k));
  } else if (project) {
    L._proj(lib, project);
    const tree = [project];
    for (let i = 0; i < tree.length; i++) {
      for (const p of lib.projects) if (py.eq(py.pg(p, "parent"), tree[i])) tree.push(py.req(p, "id"));
    }
    items = keysOf(lib.items).map((k) => lib.items[k])
      .filter((it) => !py.truthy(py.pg(it, "trashed")) && py.iterStrict(py.pg(it, "projects", [])).some((x) => tree.some((t) => py.eq(t, x))));
    items.sort((x, y) => pyCompare(py.req(x, "key"), py.req(y, "key")));
  } else {
    items = keysOf(lib.items).map((k) => lib.items[k]).filter((it) => !py.truthy(py.pg(it, "trashed")));
    items.sort((x, y) => pyCompare(py.req(x, "key"), py.req(y, "key")));
  }
  return items.map((it) => bibtexEntry(itemMeta(it), it.key)).join("\n");
}

export async function createBrowserApi(storage, opts = {}) {
  const { fs, libraryId = "" } = storage;
  const kind = storage.kind || fs.kind;
  const env = { ...browserEnv(), ...(opts.env || {}) };
  const I = { ...realImporters, ...(opts.importers || {}) };
  const P = opts.profile || realProfile;
  const lib = await Library.open(fs, { libraryId });
  const ctx = { lib, fs, libraryId, name: storage.name || fs.name, kind, I, pub: published, P, env };
  const prof = new ProfileActions(ctx);
  let dirty = false; // a change the profile folder may not have yet
  ctx.changed = () => { dirty = true; P.changed(lib); };
  ctx.profileRoute = (m, s, body) => prof.route(m, s, body);
  ctx.watchDirs = async () => (await prof.granted()).map((w) => w.fs);
  ctx.about = async () => ({ library: fs.name, version: VERSION, port: null, home: "", watching: await prof.watchNames(),
    storage: kind, persisted: !!(await env.persisted()) });
  await prof.reconnect();
  const keeper = typeof env.keeper === "function" ? await env.keeper() : null;
  if (typeof env.onHide === "function") {
    env.onHide(() => {
      P.flush();
      // the page may be going away before that save is done: the service worker saves the profile too
      const st = storageDesc(), pd = profileDesc();
      if (keeper && dirty && st && pd) {
        dirty = false;
        post({ op: "profile", storage: st, profile: pd });
      }
    });
  }

  // ---- saves started while the page is leaving (keepalive): finished by backend_sw.js ---------------
  const isHandle = (h) => !!h && typeof FileSystemDirectoryHandle === "function" && h instanceof FileSystemDirectoryHandle;
  /** the library's storage as the service worker can open it, or null (then the page does the work) */
  function storageDesc() {
    if (fs.readOnly) return null;
    if (fs.kind === "idb" && typeof fs.dbName === "string") return { kind: "idb", dbName: fs.dbName, name: fs.name, libraryId };
    if ((fs.kind === "opfs" || fs.kind === "folder") && isHandle(fs.handle)) return { kind: fs.kind, handle: fs.handle, name: fs.name, libraryId };
    return null;
  }
  function profileDesc() {
    const c = typeof P.connection === "function" ? P.connection() : null;
    return c && c.fs && !c.fs.readOnly && isHandle(c.fs.handle) ? { handle: c.fs.handle, name: c.fs.name } : null;
  }
  function post(msg) {
    try { return keeper.post(msg); } catch (e) { console.warn("Paper Marker:", e); return null; }
  }
  /** the answer of the service worker for a keepalive request, or null when the page must do it */
  async function viaKeeper(method, url, body) {
    const st = keeper ? storageDesc() : null;
    if (!st || (typeof Blob !== "undefined" && body instanceof Blob)) return null;
    const pd = profileDesc();
    const r = await post({ op: "call", storage: st, method, url, body: body === undefined ? null : body, profile: pd });
    if (!r || typeof r.status !== "number" || r.status >= 500) return null; // the worker couldn't: the page tries
    if (pd && r.status < 400) dirty = false; // the worker saves the profile after it
    return r;
  }

  /** req(method, url, body, opts) of js/api.js, answered here */
  async function call(method, url, body, o = {}) {
    if (o.signal && o.signal.aborted) throw abortError();
    const r = (o.keepalive && (await viaKeeper(method, url, body))) || (await handle(ctx, method, url, makeBody(body)));
    if (o.signal && o.signal.aborted) throw abortError();
    if (r.text !== undefined) return r.text;
    const j = JSON.parse(JSON.stringify(r.json)); // what the page gets back over HTTP: plain data, a copy
    if (r.status >= 400 || j.ok === false) throw apiError(r.status, j);
    return j;
  }

  // ---- crops: object URLs the reader can show synchronously ------------------------------------------
  const crops = new Map(); // "<key>/<name>" -> {url, sig}
  const cropRuns = new Map(); // "<key>/<name>" -> the last refresh of it (one at a time, so no URL is lost)
  function cacheCrop(key, name, force = false) {
    if (typeof key !== "string" || typeof name !== "string" || !rx(KEY_RE, key) || !rx(CROP_RE, name)) return Promise.resolve();
    const id = `${key}/${name}`;
    const run = (cropRuns.get(id) || Promise.resolve()).then(() => refreshCrop(id, `items/${key}/crops/${name}`, force));
    const tail = run.catch(() => {});
    cropRuns.set(id, tail);
    tail.then(() => { if (cropRuns.get(id) === tail) cropRuns.delete(id); });
    return run;
  }
  async function refreshCrop(id, path, force) {
    let st = null;
    try { st = await fs.stat(path); } catch { st = null; }
    const old = crops.get(id);
    if (!st || st.kind !== "file") {
      if (old) { URL.revokeObjectURL(old.url); crops.delete(id); }
      return;
    }
    const sig = `${st.size}:${st.mtime}`;
    if (old && old.sig === sig && !force) return;
    const bytes = await fs.readBytes(path);
    if (!bytes) return;
    crops.set(id, { url: URL.createObjectURL(new Blob([bytes], { type: "image/png" })), sig });
    if (old) URL.revokeObjectURL(old.url);
  }
  async function fillCrops(key, marks, sent = null) {
    if (!Array.isArray(marks)) return;
    const want = new Map(); // crop name -> read it again even when its size and time look the same
    marks.forEach((m, i) => {
      if (!py.isDict(m) || typeof m.crop !== "string") return;
      const fresh = !!(sent && py.isDict(sent[i]) && typeof sent[i].cropData === "string");
      want.set(m.crop, want.get(m.crop) || fresh);
    });
    const jobs = [...want];
    let next = 0;
    const worker = async () => {
      while (next < jobs.length) {
        const [name, fresh] = jobs[next++];
        try {
          await cacheCrop(key, name, fresh);
        } catch (e) {
          console.warn("Paper Marker crops:", e);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(6, jobs.length) }, worker));
  }

  // ---- PDFs --------------------------------------------------------------------------------------
  const pdfUrl = (key, att) => `pm-web:pdf/${key}/${att}`;
  function pdfOptions() {
    const base = env.baseURI();
    return { isEvalSupported: false, cMapPacked: true, cMapUrl: new URL("vendor/cmaps/", base).href,
      standardFontDataUrl: new URL("vendor/standard_fonts/", base).href };
  }
  /** GET /files/<key>/<att>.pdf: the PDF's bytes, or null (a 404) */
  async function readPdf(key, att) {
    if (typeof key !== "string" || typeof att !== "string" || !rx(KEY_RE, key) || !rx(ATT_RE, att)) return null;
    try {
      const st = await fs.stat(`items/${key}/${att}.pdf`);
      if (!st || st.kind !== "file") return null;
      return await fs.readBytes(`items/${key}/${att}.pdf`);
    } catch (e) {
      if (e && e.name === "FsError" && (e.code === "bad-path" || e.code === "not-found")) return null;
      throw e;
    }
  }
  function openPdf(key, att) {
    const url = pdfUrl(key, att);
    let task = null, destroyed = false;
    const promise = (async () => {
      const data = await readPdf(key, att);
      if (!data) {
        const e = new Error(`Missing PDF "${url}".`);
        e.name = "MissingPDFException";
        throw e;
      }
      if (destroyed) throw new Error("Loading was cancelled.");
      task = globalThis.pdfjsLib.getDocument({ ...pdfOptions(), data });
      return task.promise;
    })();
    promise.catch(() => {}); // a task destroyed before anyone waited on it must not report an unhandled error
    return { promise, destroy: () => { destroyed = true; return task ? task.destroy() : Promise.resolve(); } };
  }

  // ---- Get journal PDF > Choose PDF…: attach_local_published for a file the user chose --------------
  async function attachPublishedFile(key, file) {
    let r;
    try {
      if (typeof key !== "string") throw new StoreError(404, "No such paper.");
      segKey(key);
      lib.getItem(await lib.load(), key);
      if (!(typeof Blob !== "undefined" && file instanceof Blob)) throw bad("The upload is empty.");
      const pdf = await bodyPdf({ ctype: "application/pdf", data: file });
      const [, att] = await lib.addAttachmentBytes(key, pdf, "Published version", { source: "file", url: "", prefer: "published" });
      const item = await lib.patchItem(key, { primary: att.key });
      ctx.changed();
      r = ok({ item, attachment: att });
    } catch (e) {
      r = errorResponse(e);
    }
    const j = JSON.parse(JSON.stringify(r.json));
    if (r.status >= 400) throw apiError(r.status, j);
    return j;
  }

  // ---- BibTeX as a link (an <a download> needs a URL right away) -------------------------------------
  function bibtexUrl({ keys, project } = {}) {
    const q = parseQs(qs({ keys: keys && keys.join(","), project }));
    const ks = (q.get("keys") || "").split(",").filter((k) => k);
    let blob;
    try {
      blob = new Blob([bibtexOf(lib, lib.lastLib, ks.length ? ks : null, q.get("project") || null)], { type: "text/plain;charset=utf-8" });
    } catch (e) {
      blob = new Blob([pyDumps(errorResponse(e).json, { indent: null, ensureAscii: false })], { type: "application/json" });
    }
    const url = URL.createObjectURL(blob);
    later(() => URL.revokeObjectURL(url), 60000);
    return url;
  }

  const out = {
    mode: "browser",
    libraryId,
    getSettings: () => call("GET", "/api/settings"),
    putSettings: (b) => call("PUT", "/api/settings", b),
    library: () => call("GET", "/api/library"),
    import: (input, project) => call("POST", "/api/import", { input, project: project || undefined }),
    importFile: (file, project) => call("POST", "/api/import/file?" + qs({ name: file.name, project }), file),
    createItem: (meta, project) => call("POST", "/api/items", { meta, project: project || undefined }),
    patchItem: (key, patch) => call("PATCH", `/api/items/${enc(key)}`, patch),
    enrich: (key, input, overwrite = false) => call("POST", `/api/items/${enc(key)}/enrich`, { input, overwrite }),
    trash: (key) => call("POST", `/api/items/${enc(key)}/trash`),
    restore: (key) => call("POST", `/api/items/${enc(key)}/restore`),
    emptyTrash: () => call("POST", "/api/trash/empty"),
    bulk: (body) => call("POST", "/api/items/bulk", body),
    addAttachmentFile: (key, file, label) => call("POST", `/api/items/${enc(key)}/attachments?` + qs({ name: file.name, label }), file),
    fetchAttachment: (key, url, label) => call("POST", `/api/items/${enc(key)}/attachments/fetch`, { url, label }),
    renameAttachment: (key, att, label) => call("PATCH", `/api/items/${enc(key)}/attachments/${enc(att)}`, { label }),
    removeAttachment: (key, att) => call("POST", `/api/items/${enc(key)}/attachments/${enc(att)}/remove`),
    getMarks: async (key, att) => {
      const j = await call("GET", `/api/items/${enc(key)}/attachments/${enc(att)}/marks`);
      await fillCrops(key, j.marks);
      return j;
    },
    saveMarks: async (key, att, marks, baseRev, force = false, o = {}) => {
      let j;
      try {
        j = await call("POST", `/api/items/${enc(key)}/attachments/${enc(att)}/marks`, { marks, baseRev, force }, o);
      } catch (e) {
        // a 409 carries the marks saved elsewhere: the reader shows them (and their crops) next
        if (e && e.status === 409 && e.payload) await fillCrops(key, e.payload.marks);
        throw e;
      }
      await fillCrops(key, j.marks, Array.isArray(marks) ? marks : null);
      return j;
    },
    getNotes: (key) => call("GET", `/api/items/${enc(key)}/notes`),
    saveNotes: (key, text, baseRev, force = false, o = {}) => call("POST", `/api/items/${enc(key)}/notes`, { text, baseRev, force }, o),
    getProjectNotes: (id) => call("GET", `/api/projects/${enc(id)}/notes`),
    saveProjectNotes: (id, text, baseRev, force = false, o = {}) => call("POST", `/api/projects/${enc(id)}/notes`, { text, baseRev, force }, o),
    journal: (key) => call("GET", `/api/items/${enc(key)}/journal`),
    profile: () => call("GET", "/api/profile"),
    profileAct: (act, body = {}) => call("POST", `/api/profile/${act}`, body),
    findPreprint: (key) => call("POST", `/api/items/${enc(key)}/find-preprint`, {}),
    findPublished: (key, since) => call("POST", `/api/items/${enc(key)}/find-published`, since ? { since } : {}),
    attachPublishedFile,
    markTypes: () => call("GET", "/api/mark-types"),
    saveMarkTypes: (types, baseRev, force = false) => call("PUT", "/api/mark-types", { types, baseRev, force }),
    createProject: (name, parent) => call("POST", "/api/projects", { name, parent: parent || null }),
    patchProject: (id, patch) => call("PATCH", `/api/projects/${enc(id)}`, patch),
    deleteProject: (id) => call("POST", `/api/projects/${enc(id)}/delete`),
    search: (q, signal) => call("GET", "/api/search?" + qs({ q }), undefined, { signal }),
    bibtexUrl,
    bibtex: ({ keys, project } = {}) => call("GET", "/api/export/bibtex?" + qs({ keys: keys && keys.join(","), project })),
    pdfUrl,
    cropUrl: (key, name) => (crops.get(`${key}/${name}`) || {}).url || BLANK_PNG,
    openPdf,
    lsKey: (name) => (libraryId && String(name).startsWith("pm2:") ? "pm2:" + libraryId + ":" + String(name).slice(4) : name),
  };
  // for tests and the integrator: the store, the request handler and the profile actions behind this api
  // (not enumerable, so Object.assign(api, b) in js/api.js leaves it out)
  Object.defineProperty(out, "_internals", { value: { lib, ctx, prof, handle: (m, url, body) => handle(ctx, m, url, makeBody(body)) } });
  return out;
}
