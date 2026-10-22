// /api/profile for the browser back end (server.py's do_profile; WEB_CONTRACT.md 6.4, 6.5), the folders
// "Get journal PDF" checks, and Settings > About's `about`.
//
// Folders are handles the browser granted, not paths. `choose` opens the folder picker (or, where pages can't
// open folders, a folder upload: read only) and answers {path: "handle:<id>"}; preview / load / connect take
// those tokens where Python takes a path. The connected profile folder is remembered in IndexedDB ("profile":
// {handle, name, libraryId}), never in settings.json, which the downloadable version may share. Browser-only
// actions: exportZip (a download), importZip ({file}), watchFolder, forgetWatch, changeLibrary.

import { StoreError, bad, notFound } from "./store/index.js";
import * as py from "./store/py.js";
import { bodyJson } from "./backend_http.js";

export const ZIP_NAME = "Paper Marker Profile.zip";
const NO_PROFILE = "There's no Paper Marker profile (paper-marker-profile.json) there.";

/** (path or "").strip().strip('"').strip("'") */
const cleanPath = (v) => py.stripChars(py.stripChars(py.strip(py.truthy(v) ? py.str(v) : ""), '"'), "'");

export class ProfileActions {
  constructor(ctx) {
    this.ctx = ctx;
    this.tokens = new Map(); // "handle:<id>" -> {fs, handle, name, listOnly}
    this.seq = 0;
    this.watch = null; // [{handle, name, fs}] once read from memory
  }

  get P() { return this.ctx.P; }
  get env() { return this.ctx.env; }

  register(entry) {
    const rnd = Math.random().toString(36).slice(2, 8);
    const token = `handle:${++this.seq}${rnd}`;
    this.tokens.set(token, entry);
    return token;
  }

  entryOf(path) {
    return this.tokens.get(cleanPath(path)) || null;
  }

  /** Reconnect the remembered profile folder when the page may still write to it. Never throws. */
  async reconnect() {
    try {
      if (this.P.connection()) return;
      const saved = await this.env.memory.get("profile");
      if (!saved || !saved.handle) return;
      if (saved.libraryId && saved.libraryId !== this.ctx.libraryId) return;
      const fs = await this.env.openHandle(saved.handle, { mode: "readwrite", name: saved.name });
      if (!fs || fs.readOnly) return;
      const token = this.register({ fs, handle: saved.handle, name: saved.name || fs.name });
      this.P.connect(this.ctx.lib, fs, { token });
      await this.P.statusOf(this.ctx.lib);
    } catch (e) {
      console.warn("Paper Marker profile:", e);
    }
  }

  async remember(entry) {
    if (!entry.handle) return;
    try {
      await this.env.memory.set("profile", { handle: entry.handle, name: entry.name, libraryId: this.ctx.libraryId });
    } catch (e) {
      console.warn("Paper Marker profile:", e);
    }
  }

  // ---- watch folders (Get journal PDF) -------------------------------------------------------------
  async watchList() {
    if (!this.watch) {
      const saved = await this.env.memory.get("watch");
      this.watch = (Array.isArray(saved) ? saved : []).filter((w) => w && w.handle).map((w) => ({ handle: w.handle, name: w.name || w.handle.name || "" }));
    }
    return this.watch;
  }

  /** [{name, fs}] for the watch folders the page may read right now */
  async granted() {
    const out = [];
    for (const w of await this.watchList()) {
      let fs = null;
      try {
        fs = await this.env.openHandle(w.handle, { mode: "read", name: w.name });
      } catch {
        fs = null;
      }
      if (!fs) continue;
      if (!w.fs || w.fs.handle !== fs.handle) w.fs = fs; // the same LibFS each time keeps published.js's sniff cache
      out.push({ name: w.name, fs: w.fs, item: w });
    }
    return out;
  }

  async saveWatch() {
    await this.env.memory.set("watch", this.watch.map((w) => ({ handle: w.handle, name: w.name })));
  }

  async watchNames() {
    return (await this.granted()).map((w) => w.name);
  }

  // ---- the route ---------------------------------------------------------------------------------
  /** do_profile(m, s, b): b is read from the request body for POST, as Python does before dispatching. */
  async route(m, s, body) {
    const browserFile = m === "POST" && s.length === 1 && s[0] === "importZip";
    const b = m === "POST" && !browserFile ? bodyJson(body) : {};
    const { lib: L } = this.ctx;
    if (m === "GET" && s.length === 0) return { profile: await this.P.statusOf(L) };
    if (m !== "POST" || s.length !== 1) throw notFound("Not found.");
    const act = s[0];
    switch (act) {
      case "save": return { profile: await this.P.save(L) };
      case "disconnect":
        await L.setSettings({ profile: { folder: "" } }); // as server.py does (the downloadable version's folder too)
        this.P.disconnect();
        await this.env.memory.del("profile");
        return { profile: await this.P.statusOf(L) };
      case "preview": return { preview: await this.P.preview(this.sourceOf(py.pg(b, "path"))) };
      case "load": return this.load(b);
      case "connect": return this.connect(b);
      case "choose": return this.choose(b);
      case "exportZip": return this.exportZip();
      case "importZip": return this.importZip(body);
      case "watchFolder": return this.watchFolder();
      case "forgetWatch": return this.forgetWatch(b);
      case "changeLibrary": return this.changeLibrary();
      default: throw notFound("Not found.");
    }
  }

  sourceOf(path) {
    const e = this.entryOf(path);
    if (!e) throw notFound(NO_PROFILE);
    return e.fs;
  }

  async load(b) {
    const { lib: L } = this.ctx;
    const path = cleanPath(py.pg(b, "path"));
    const e = this.entryOf(path);
    if (!e) throw notFound(NO_PROFILE);
    const conn = py.pg(b, "connect", true) !== false;
    const summary = await this.P.load(L, e.fs, { connect: conn, token: path, download: (url) => this.ctx.I.downloadPdf(url) });
    if (conn && !e.fs.readOnly) await this.remember(e);
    await L.getSettings(); // apply_settings(store.get_settings()): fails the same way when settings.json can't be read
    return { summary, profile: await this.P.statusOf(L) };
  }

  async connect(b) {
    const { lib: L } = this.ctx;
    const raw = cleanPath(py.pg(b, "folder"));
    if (!raw) throw bad("Choose a folder for your profile.");
    const e = this.entryOf(raw);
    if (!e) throw bad("Choose a folder for your profile.");
    if (e.listOnly || !this.env.canOpenFolders()) throw bad("This browser can't save into folders. Use Download Profile instead.");
    if (e.fs.readOnly) throw bad("Paper Marker can't save into that folder. Choose a folder it may write to.");
    if (await this.env.isInside(L.fs, e)) throw bad("Choose a folder outside the library folder.");
    if ((await this.P.hasProfile(e.fs)) && !py.truthy(py.pg(b, "replace"))) {
      // never overwrite someone's profile by accident: the app asks whether to load it or replace it
      throw new StoreError(409, "That folder already has a Paper Marker profile.", { preview: await this.P.preview(e.fs) });
    }
    const patch = {};
    for (const k of ["includePdfs", "git", "push"]) if (typeof py.pg(b, k) === "boolean") patch[k] = b[k];
    if (Object.keys(patch).length) await L.setSettings({ profile: patch });
    this.P.connect(L, e.fs, { token: raw });
    await this.remember(e); // Python stores the folder before the first save, so a failed save stays connected
    return { profile: await this.P.save(L) };
  }

  async choose() {
    const picked = await this.env.chooseFolder({ mode: "readwrite", id: "pm-profile" });
    if (!picked) return { cancelled: true };
    return { path: this.register(picked) };
  }

  async exportZip() {
    const blob = await this.P.exportZip(this.ctx.lib);
    this.env.download(blob, ZIP_NAME);
    return { name: ZIP_NAME, bytes: blob.size };
  }

  async importZip(body) {
    const raw = body && body.raw;
    const file = py.isDict(raw) ? raw.file : null;
    if (!(typeof Blob !== "undefined" && file instanceof Blob)) throw bad("Choose a zip file.");
    let zfs;
    try {
      zfs = await this.P.openZip(file, { name: file.name || "Zip file" }); // leaves out unsafe names, as importSource needs
    } catch (e) {
      if (e && e.name === "FsError") throw bad(e.message);
      throw e;
    }
    const summary = await this.P.importSource(this.ctx.lib, zfs, { download: (url) => this.ctx.I.downloadPdf(url) });
    return { summary, profile: await this.P.statusOf(this.ctx.lib) };
  }

  async watchFolder() {
    if (!this.env.canOpenFolders()) throw bad("This browser can't open folders. Choose the downloaded PDF instead.");
    const picked = await this.env.chooseFolder({ mode: "read", id: "pm-downloads", startIn: "downloads" });
    if (!picked) return { cancelled: true };
    const list = await this.watchList();
    let found = false;
    for (const w of list) {
      if (await this.env.sameEntry(w.handle, picked.handle)) {
        w.handle = picked.handle;
        w.fs = picked.fs;
        found = true;
      }
    }
    if (!found) list.push({ handle: picked.handle, name: picked.name, fs: picked.fs });
    await this.saveWatch();
    return { watching: await this.watchNames() };
  }

  async forgetWatch(b) {
    const list = await this.watchList();
    const granted = await this.granted();
    const index = py.pg(b, "index"), name = py.pg(b, "name");
    // index counts the folders Settings lists (the granted ones); fall back to the name
    let target = py.isInt(index) && index >= 0 && index < granted.length ? granted[index] : null;
    if (target && name !== null && target.name !== name) target = null;
    if (!target && typeof name === "string") {
      const item = list.find((w) => w.name === name);
      target = granted.find((w) => w.name === name) || (item ? { item } : null);
    }
    if (!target) throw notFound("That folder isn't being checked.");
    const at = list.indexOf(target.item);
    if (at >= 0) list.splice(at, 1);
    await this.saveWatch();
    return { watching: await this.watchNames() };
  }

  async changeLibrary() {
    try {
      await this.P.flush(); // a pending save belongs to this library and its folder
    } catch { /* reported on the Profile page; nothing to keep here */ }
    this.P.disconnect();
    await this.env.memory.del("profile");
    await this.env.memory.del("library");
    this.env.reload();
    return {};
  }
}
