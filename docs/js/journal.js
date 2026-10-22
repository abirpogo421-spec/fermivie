// "Get journal PDF": get the published version with whatever access the user's own browser has.
// 1) If a matching journal PDF is already in one of the folders listed in Settings > Library & import
//    ("Folders to check", Downloads and Desktop by default), it's added straight away.
// 2) Otherwise the journal's PDF opens in a new browser tab (campus network / institutional login work as
//    usual, nothing to sign into here). Once the user downloads it into one of those folders, it's picked
//    up, added as "Published version" and made the default. Nothing in those folders is moved.
//    With no folders to check, the journal's page still opens, but nothing is watched.
// In the browser version the folders are ones the user granted (Settings > Library & import); with none,
// a dialog offers to choose the Downloads folder (Chrome, Edge, Arc) or the downloaded PDF itself.
import { api } from "./api.js";
import { store } from "./store.js";
import * as ui from "./ui.js";

const watching = new Map();   // key -> stop()

export const hasPublished = (it) => (it.attachments || []).some((a) => /^published/i.test(a.label || "") && !/arxiv\.org/i.test(a.url || ""));
export const canGet = (it) => !!(it && it.doi && !/^10\.48550\//i.test(it.doi) && !hasPublished(it));

// the folders the server checks (null until the settings have loaded), and how to name where a file was found
const dirs = () => { const w = (store.about || {}).watching; return Array.isArray(w) ? w : null; };
const where = (f) => (f ? `your ${f} folder` : "a folder you check");
const folderName = (d) => String(d || "").replace(/[\\/]+$/, "").split(/[\\/]/).pop() || d;

export async function getJournalPdf(key, opts = {}) {
  const it = store.item(key);
  if (!it || !it.doi) { ui.toast("This paper has no DOI, so there's no journal version to look for.", { error: true }); return; }
  if (watching.has(key)) watching.get(key)();   // a new request replaces any watch still running for this paper
  // open the tab inside the click (popup blockers), point it at the journal once we know where
  const win = window.open("about:blank", "_blank");
  const since = Date.now() / 1000 - 5;
  try {
    const first = await api.findPublished(key);
    if (first.found) {
      if (win) win.close();
      done(first.item, opts, `Found the journal PDF in ${where(first.folder)} and added it.`);
      return;
    }
    const j = await api.journal(key);
    if (win) { win.opener = null; win.location.href = j.url; } else window.open(j.url, "_blank", "noopener");
  } catch (e) { if (win) win.close(); ui.toast(e.message, { error: true }); return; }
  const w = dirs();
  // the browser version can only read folders the user chose: ask for one, or for the PDF itself
  if (api.mode === "browser" && !(w && w.length)) { askForPdf(key, since, opts); return; }
  if (w && !w.length) {
    ui.toast("Opened the journal's page. No folders are being checked for downloads, so attach the PDF yourself, or add a folder in Settings > Library & import.", { ms: 9000 });
    return;
  }
  const names = w ? w.map(folderName).join(" or ") : "Downloads";
  ui.toast(`Download the PDF from the journal's page (⌘S or the download button). Once it's in ${names}, it'll be added here automatically.`, { ms: 9000 });
  watch(key, since, opts);
}

function watch(key, since, opts) {
  if (watching.has(key)) watching.get(key)();
  let n = 0, stopped = false;
  const stop = () => { stopped = true; watching.delete(key); };
  watching.set(key, stop);
  const tick = async () => {
    if (stopped) return;
    if (++n > 120) { stop(); return; }   // about 5 minutes
    try {
      const r = await api.findPublished(key, since);
      if (stopped) return;
      if (r.found) { stop(); done(r.item, opts, `Added the journal version from ${where(r.folder)} and made it the default.`); return; }
    } catch (_) {}
    setTimeout(tick, 2500);
  };
  setTimeout(tick, 2500);
}

function done(item, opts, msg) {
  store.setItem(item);
  ui.toast(msg + " Marks you made on another version stay with that version.", { ms: 6000 });
  if (opts.onFound) opts.onFound(item);
}

/* ---------------------------------------------------------------- browser version: no folder to watch */
const { h } = ui;
function askForPdf(key, since, opts) {
  const folders = typeof window.showDirectoryPicker === "function";
  dialog((d, close) => {
    d.append(h("h2", null, "Add the journal PDF"),
      h("p", null, folders
        ? "Download the PDF from the journal's page. Choose your Downloads folder and it's added as soon as it arrives, or choose the PDF yourself."
        : "Download the PDF from the journal's page, then choose it here."));
    const pdfBtn = h("button", { class: "btn" + (folders ? "" : " btn--primary"), onclick: () => { close(); choosePdf(key, opts); } }, "Choose PDF…");
    const acts = h("div", { class: "dialog__actions" }, h("button", { class: "btn", onclick: () => close() }, "Cancel"), pdfBtn);
    if (folders) acts.append(h("button", { class: "btn btn--primary", onclick: () => { close(); chooseWatch(key, since, opts); } }, "Choose Downloads Folder…"));
    d.append(acts);
  });
}
// remember a Downloads folder (the back end shows the folder picker), then watch it like the local app does
async function chooseWatch(key, since, opts) {
  try {
    const j = await api.profileAct("watchFolder", {});
    if (j && j.cancelled) return;
    await store.loadSettings();
  } catch (e) { if (e.name !== "AbortError") ui.toast(e.message, { error: true }); return; }
  const w = dirs() || [];
  ui.toast(`Once the PDF is in ${w.length ? w.map(folderName).join(" or ") : "that folder"}, it'll be added here automatically.`, { ms: 9000 });
  watch(key, since, opts);
}
// the downloaded PDF itself: added as "Published version" and made the default, like a found one
async function choosePdf(key, opts) {
  const file = await pickPdf();
  if (!file) return;
  if (watching.has(key)) watching.get(key)();
  // attach_local_published's own step for this file (attachment key "published"), never a plain upload:
  // an upload names the attachment after its label ("published-version", or "main" on a paper with none)
  try { done((await api.attachPublishedFile(key, file)).item, opts, "Added the journal PDF and made it the default."); }
  catch (e) { ui.toast(e.message, { error: true }); }
}
function pickPdf() {
  return new Promise((resolve) => {
    const inp = h("input", { type: "file", accept: ".pdf,application/pdf", hidden: true });
    const fin = (v) => { inp.remove(); resolve(v); };
    inp.addEventListener("change", () => fin((inp.files && inp.files[0]) || null));
    inp.addEventListener("cancel", () => fin(null));
    document.body.append(inp);
    inp.click();
  });
}
// a small modal with the shared .scrim / .dialog look (ui.confirmDialog has only two buttons)
function dialog(build) {
  const prev = document.activeElement;
  const s = ui.el("div", "scrim");
  const d = ui.el("div", "dialog"); d.setAttribute("role", "dialog"); d.setAttribute("aria-modal", "true");
  s.append(d);
  const onKey = (ev) => { if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); close(); } };
  const close = () => { s.remove(); document.removeEventListener("keydown", onKey, true); if (prev && prev.focus) prev.focus(); };
  document.addEventListener("keydown", onKey, true);
  s.addEventListener("pointerdown", (ev) => { if (ev.target === s) close(); });
  build(d, close);
  document.getElementById("overlay-root").append(s);
  const f = d.querySelector(".btn--primary") || d.querySelector("button");
  if (f) f.focus();
}
