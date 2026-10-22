// A registry of everything the user can do, so the ⌘K palette can list and run it.
// Each view registers its own commands (and removes them with the returned function if needed).
//   register({ id, title, section, keys, when, run, keywords })
//     id        unique string ("reader.next-paper")
//     title     what the palette shows ("Next paper")
//     section   group shown in the palette ("Reader", "Library", "Go to", "App")
//     keys      optional shortcut label ("⌥↓")
//     when      optional () => bool: only offered when true (e.g. a paper is open)
//     run       () => void | Promise
//     keywords  optional extra search words
const list = new Map();

export function register(cmd) {
  if (!cmd || !cmd.id || !cmd.title || typeof cmd.run !== "function") throw new Error("bad command");
  list.set(cmd.id, cmd);
  return () => list.delete(cmd.id);
}
export function registerAll(cmds) { const offs = cmds.map(register); return () => offs.forEach((f) => f()); }
export function available() {
  return [...list.values()].filter((c) => { try { return !c.when || c.when(); } catch (_) { return false; } });
}
export function all() { return [...list.values()]; }
export function run(id) { const c = list.get(id); if (c) return c.run(); }
