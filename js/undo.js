// One undo history for the whole app (⌘Z / ⌘⇧Z). Text fields keep the browser's own undo.
// Entries: {label, undo: async () => void, redo: async () => void}. While an entry is being undone or
// redone, nothing new is recorded (the store calls that the entry makes would otherwise record again).
import * as ui from "./ui.js";

const done = [], undone = [];
let busy = false;

export function record(entry) {
  if (busy || !entry) return;
  done.push(entry);
  if (done.length > 200) done.shift();
  undone.length = 0;
}
export const recording = () => !busy;
// Cut the history at an action that can't be undone (Empty Trash, deleting a project): older entries
// would only refer to papers or projects that are gone.
export function clear() { if (busy) return; done.length = 0; undone.length = 0; }

async function run(from, to, fn, verb) {
  const e = from.pop();
  if (!e) { ui.toast(verb === "Undid" ? "Nothing to undo." : "Nothing to redo."); return; }
  busy = true;
  try { await e[fn](); to.push(e); ui.toast(`${verb} ${e.label}.`); }
  catch (err) {
    // The server refused it (the paper or project is gone, …): retrying can never work, so the entry is
    // dropped and the next ⌘Z reaches older ones. Anything else (server down, "open that PDF", an unsaved
    // note in the way) stays on the stack to try again.
    const gone = err && err.status >= 400 && err.status < 500;
    if (!gone) from.push(e);
    ui.toast(`Couldn't ${verb === "Undid" ? "undo" : "redo"} ${e.label}: ${err.message}`, { error: true });
  }
  finally { busy = false; }
}
// One at a time: a second ⌘Z (double tap, key repeat) waits for the first to finish, so `busy` stays true
// for an entry's whole run and the store calls it makes can never record a new entry or clear `undone`.
let chain = Promise.resolve();
const queue = (f) => (chain = chain.then(f, f));
export const undo = () => queue(() => run(done, undone, "undo", "Undid"));
export const redo = () => queue(() => run(undone, done, "redo", "Redid"));
