// What the browser back end needs from the page (WEB_CONTRACT.md 6.5): folder pickers, remembered handles,
// downloads, reload, storage persistence. browserEnv() gives the real ones; node tests pass their own to
// createBrowserApi(storage, {env}) with the same shape:
//
//   memory: {get(slot), set(slot, value), del(slot)}   IndexedDB "pm-web" / "handles" (fs.js)
//   canOpenFolders() -> bool                         showDirectoryPicker exists (Chrome, Edge, Arc)
//   chooseFolder({mode, id, startIn}) -> {fs, handle, name, listOnly?} | null (cancelled)
//   openHandle(handle, {mode, name}) -> LibFS | null  a remembered folder, when the page may still read it
//   sameEntry(a, b), isInside(libraryFs, entry)      folder identity checks
//   download(blob, name), reload(), persisted() -> bool, baseURI() -> string, onHide(fn)
//   keeper() -> {post(msg)} | null                  the service worker of backend_sw.js (optional)
//
// Test switch (WEB_CONTRACT.md 10): with ?testfs=1 in the URL the pickers return window.__PM_TEST_HANDLE__.

import { DirFS, ListFS, permissionOf, rememberHandle, recallHandle, forgetHandle, storagePersisted, supportsFolders } from "./fs.js";

const hasWindow = typeof window !== "undefined";
const TEST_FS = hasWindow && typeof location !== "undefined" && new URLSearchParams(location.search).get("testfs") === "1";
const testHandle = () => (TEST_FS && window.__PM_TEST_HANDLE__) || null;

/** <input type=file webkitdirectory>: the chosen folder's files, or null when cancelled. */
function pickDirectoryFiles() {
  return new Promise((resolve) => {
    const inp = document.createElement("input");
    inp.type = "file";
    inp.hidden = true;
    inp.webkitdirectory = true;
    inp.setAttribute("webkitdirectory", "");
    const done = (v) => { inp.remove(); resolve(v); };
    inp.addEventListener("change", () => done(inp.files && inp.files.length ? inp.files : null));
    inp.addEventListener("cancel", () => done(null));
    document.body.append(inp);
    inp.click();
  });
}

const isAbort = (e) => e && e.name === "AbortError";

/** The folder a NodeFS (tests) or DirFS sits on, for isInside. */
const rootOf = (fs) => (fs && typeof fs.rootDir === "string" ? fs.rootDir : null);

export function browserEnv() {
  return {
    memory: {
      get: async (slot) => {
        try { return await recallHandle(slot); } catch { return null; }
      },
      set: (slot, value) => rememberHandle(slot, value),
      del: async (slot) => {
        try { await forgetHandle(slot); } catch { /* nothing remembered */ }
      },
    },

    canOpenFolders: () => supportsFolders() || !!testHandle(),

    async chooseFolder({ mode = "readwrite", id = "pm-profile", startIn } = {}) {
      let handle = testHandle();
      if (!handle && supportsFolders()) {
        try {
          handle = await window.showDirectoryPicker({ id, mode, ...(startIn ? { startIn } : {}) });
        } catch (e) {
          if (isAbort(e)) return null;
          throw e;
        }
      }
      if (!handle) { // no folder access in this browser: the files of a chosen folder, read only
        const files = await pickDirectoryFiles();
        if (!files) return null;
        const fs = new ListFS(files);
        return { fs, handle: null, name: fs.name, listOnly: true };
      }
      const fs = await DirFS.fromHandle(handle, { kind: "folder", name: handle.name });
      return { fs, handle, name: handle.name };
    },

    async openHandle(handle, { mode = "read", name } = {}) {
      if (!handle || handle.kind !== "directory") return null;
      const nm = name || handle.name;
      if ((await permissionOf(handle, mode)) === "granted") return new DirFS(handle, { kind: "folder", name: nm, readOnly: mode !== "readwrite" });
      if (mode === "readwrite" && (await permissionOf(handle, "read")) === "granted") return new DirFS(handle, { kind: "folder", name: nm, readOnly: true });
      return null;
    },

    async sameEntry(a, b) {
      if (!a || !b) return false;
      if (a === b) return true;
      try { return typeof a.isSameEntry === "function" ? await a.isSameEntry(b) : false; } catch { return false; }
    },

    // Python: a profile folder inside the library folder (or the library folder itself) is refused
    async isInside(libFs, entry) {
      const lh = libFs && libFs.handle, eh = entry && entry.handle;
      if (lh && eh && typeof lh.resolve === "function") {
        try { return (await lh.resolve(eh)) !== null; } catch { return false; }
      }
      const a = rootOf(libFs), b = rootOf(entry && entry.fs);
      if (a && b) return b === a || b.startsWith(a.endsWith("/") ? a : a + "/");
      return false;
    },

    download(blob, name) {
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      a.rel = "noopener";
      a.hidden = true;
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    },

    reload() { location.reload(); },

    // the page is going away or out of sight: run fn (a pending profile save)
    onHide(fn) {
      if (!hasWindow) return;
      window.addEventListener("pagehide", () => fn());
      document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") fn(); });
    },

    persisted: () => storagePersisted(),

    // A service worker that finishes saves a leaving page starts (backend_sw.js). Resolves to
    // {post(message) -> Promise of the answer | null} once the worker is active (at most 3 s), or null where
    // there are no service workers or registering fails (then everything runs in the page, as before).
    async keeper() {
      const sws = hasWindow && typeof navigator !== "undefined" ? navigator.serviceWorker : null;
      if (!sws || typeof sws.register !== "function" || typeof MessageChannel !== "function") return null;
      try {
        const reg = await sws.register(new URL("./backend_sw.js", import.meta.url).href,
          { type: "module", scope: new URL("./", import.meta.url).href });
        if (!reg.active) {
          await new Promise((res) => {
            const w = reg.installing || reg.waiting;
            if (!w) return res();
            const t = setTimeout(res, 3000);
            w.addEventListener("statechange", () => {
              if (w.state === "activated" || w.state === "redundant") { clearTimeout(t); res(); }
            });
          });
        }
        return {
          post(msg) {
            const w = reg.active;
            if (!w) return null;
            const ch = new MessageChannel();
            const answer = new Promise((res) => { ch.port1.onmessage = (e) => { ch.port1.close(); res(e.data); }; });
            w.postMessage(msg, [ch.port2]);
            return answer;
          },
        };
      } catch (e) {
        console.warn("Paper Marker: saves on leaving the page stay in the page:", e);
        return null;
      }
    },

    baseURI: () => (typeof document !== "undefined" && document.baseURI) || (typeof location !== "undefined" ? location.href : "http://localhost/"),
  };
}
