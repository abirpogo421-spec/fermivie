// "Get journal PDF": get the published version with whatever access the user's own browser has.
// 1) If a matching journal PDF is already in one of the folders listed in Settings > Library & import
//    ("Folders to check", Downloads and Desktop by default), it's added straight away.
// 2) Otherwise the journal's PDF opens in a new browser tab (campus network / institutional login work as
//    usual, nothing to sign into here). Once the user downloads it into one of those folders, it's picked
//    up, added as "Published version" and made the default. Nothing in those folders is moved.
//    With no folders to check, the journal's page still opens, but nothing is watched.
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
