// The browser back end's "keepalive" (WEB_CONTRACT.md 6.5, CONTRACT.md 9 "Flush on leave"): a module service
// worker that finishes saves a page starts while it is going away.
//
// In server mode a save sent on pagehide uses fetch(..., {keepalive: true}) and the server finishes it after
// the tab is gone. In browser mode the page itself writes the files, and a page that is closing or navigating
// is torn down before its storage calls finish. So js/web/backend.js hands such a save to this worker, which
// outlives the page (event.waitUntil), runs the same route (backend_routes.js over the same Library code)
// and answers on the message port when the page is still there to hear it. It also saves the connected
// profile folder when the page went away with a profile save still pending.
//
// It never handles fetches (no fetch listener: pages are not controlled, nothing is cached) and is registered
// with the scope of this folder. Writes take the same Web Locks as the page, so the two never interleave.
//
// Messages (each with a MessagePort for the answer):
//   {op: "call", storage, method, url, body, profile?} -> {status, json} | {status, text, ctype}
//   {op: "profile", storage, profile}                   -> {saved: true} | {error}
//   storage = {kind: "folder"|"opfs", handle, name, libraryId} | {kind: "idb", dbName, name, libraryId}
//   profile = {handle, name}: the connected profile folder, saved 300 ms after the last change it hears of

import { Library, StoreError } from "./store/index.js";
import { DirFS, IdbFS } from "./fs.js";
import { handle } from "./backend_routes.js";
import { makeBody, errorResponse } from "./backend_http.js";
import * as published from "./published.js";
import * as P from "./profile.js";
import * as I from "./importers/index.js";

const sw = globalThis;

sw.addEventListener("install", () => { sw.skipWaiting(); });
sw.addEventListener("activate", (e) => { e.waitUntil(Promise.resolve()); });

/** The LibFS a page described (handles survive postMessage). */
export function openStorage(st) {
  if (!st || typeof st !== "object") throw new TypeError("No storage given.");
  if (st.kind === "idb") return new IdbFS(st.dbName, { name: st.name });
  return new DirFS(st.handle, { kind: st.kind === "opfs" ? "opfs" : "folder", name: st.name });
}

// one job at a time, in the order the messages came (a profile save runs after the save that needs it)
let chain = Promise.resolve();
function enqueue(fn) {
  const run = chain.then(fn);
  chain = run.catch(() => {});
  return run;
}

/** The context backend_routes.js needs, for the routes a leaving page sends (saves of marks and notes). */
function contextFor(lib, fs, st) {
  return {
    lib, fs, libraryId: st.libraryId || "", name: st.name || fs.name, kind: fs.kind, I, pub: published, P,
    env: { persisted: async () => false },
    changed: () => {},
    profileRoute: () => { throw new StoreError(404, "Not found."); },
    watchDirs: async () => [],
    about: async () => ({}),
  };
}

async function runCall(d) {
  let fs;
  try {
    fs = openStorage(d.storage);
  } catch (e) {
    return errorResponse(e);
  }
  const lib = await Library.open(fs, { libraryId: d.storage.libraryId || "" });
  const r = await handle(contextFor(lib, fs, d.storage), d.method, d.url, makeBody(d.body));
  return r;
}

// the profile save: the latest request wins, 300 ms after the last one, after every queued call
let pendingProfile = null;
let profileRun = null;
function scheduleProfile(storage, profile) {
  pendingProfile = { storage, profile };
  if (!profileRun) {
    profileRun = new Promise((res) => setTimeout(res, 300)).then(() => enqueue(async () => {
      const job = pendingProfile;
      pendingProfile = null;
      profileRun = null;
      const fs = openStorage(job.storage);
      const lib = await Library.open(fs, { libraryId: job.storage.libraryId || "" });
      const pfs = new DirFS(job.profile.handle, { kind: "folder", name: job.profile.name });
      await P.save(lib, pfs);
      return { saved: true };
    }));
  }
  return profileRun;
}

const errorText = (e) => String((e && e.message) || e);

sw.addEventListener("message", (e) => {
  const d = e.data || {};
  const port = e.ports && e.ports[0];
  const answer = (v) => { try { if (port) port.postMessage(v); } catch { /* the page is gone */ } };
  let job;
  if (d.op === "call") {
    job = enqueue(() => runCall(d)).then((r) => {
      answer(JSON.parse(JSON.stringify(r)));
      const changed = r && r.status < 400 && d.method !== "GET" && !String(d.url).startsWith("/api/profile");
      if (changed && d.profile && d.profile.handle) return scheduleProfile(d.storage, d.profile).catch(() => {});
      return null;
    }, (err) => answer({ status: 500, json: { ok: false, error: errorText(err) } }));
  } else if (d.op === "profile" && d.profile && d.profile.handle) {
    job = scheduleProfile(d.storage, d.profile).then((v) => answer(v), (err) => answer({ error: errorText(err) }));
  } else {
    answer({ error: "Unknown message." });
    return;
  }
  e.waitUntil(job);
});
