// "Logical order" of papers: a project's sections in the user's order, each paper by its rank.
// Same rules as the library's project view: papers never placed go to the first section when they
// have marks, otherwise the last, oldest first.
import { store } from "./store.js";

export const DEFAULT_SECTIONS = [{ id: "mark", name: "To mark" }, { id: "ref", name: "Reference" }];

export function sectionsOf(pid) {
  const p = store.project(pid) || {};
  return p.sections && p.sections.length ? p.sections : DEFAULT_SECTIONS;
}
function placeOf(it, sections, placement) {
  const pl = placement[it.key];
  if (pl && sections.some((x) => x.id === pl.section)) return pl;
  const sec = store.markCounts(it.key).total > 0 ? sections[0].id : sections[sections.length - 1].id;
  return { section: sec, rank: 1e6 + (Date.parse(it.added || 0) || 0) / 1e12 };
}
// -> [{id, name, items: [item]}] for a project (subprojects included, trash excluded)
export function projectOrder(pid) {
  const p = store.project(pid); if (!p) return [];
  const ids = store.projectTree(pid);
  const items = store.items().filter((it) => (it.projects || []).some((x) => ids.includes(x)));
  const sections = sectionsOf(pid), placement = p.placement || {};
  const by = new Map(sections.map((x) => [x.id, []]));
  for (const it of items) by.get(placeOf(it, sections, placement).section).push(it);
  for (const arr of by.values()) arr.sort((a, b) => placeOf(a, sections, placement).rank - placeOf(b, sections, placement).rank);
  return sections.map((x) => ({ ...x, items: by.get(x.id) }));
}
// the project to use as context for a paper: the one last open in the library if it holds the paper,
// else the paper's first project
export function contextProject(key) {
  const it = store.item(key); if (!it) return null;
  let last = null;
  try { const m = /#\/library\/project\/([^/]+)/.exec(sessionStorage.getItem("pm2:libroute") || localStorage.getItem("pm2:libroute") || ""); last = m && decodeURIComponent(m[1]); } catch (_) {}
  const mine = (it.projects || []).filter((p) => store.project(p));
  if (last && mine.some((p) => store.projectTree(last).includes(p))) return last;
  return mine[0] || null;
}
// flat list of keys in logical order around a paper (its project first, then everything else by recency)
export function orderedKeys(key) {
  const pid = contextProject(key);
  const inProject = pid ? projectOrder(pid).flatMap((g) => g.items.map((i) => i.key)) : [];
  const rest = store.items().filter((it) => !inProject.includes(it.key))
    .sort((a, b) => (b.opened || "").localeCompare(a.opened || "") || (a.title || "").localeCompare(b.title || ""))
    .map((i) => i.key);
  return { pid, inProject, rest };
}
// Stable sequence for ⌥↓ / ⌥↑: the paper's project in logical order, or, for a paper in no project, the
// unfiled papers oldest-added first. Never by recency: opening a paper changes `opened`, so a recency
// list puts the paper you just opened first and ⌥↓ bounces back to where you came from. (`rest` above
// stays by recency on purpose: the paper switcher lists recent papers first.)
export function stepKeys(key) {
  const { pid, inProject } = orderedKeys(key);
  if (pid && inProject.includes(key)) return { pid, seq: inProject };
  const seq = store.items().filter((it) => !(it.projects || []).some((p) => store.project(p)))
    .sort((a, b) => (a.added || "").localeCompare(b.added || "") || (a.title || "").localeCompare(b.title || "") || a.key.localeCompare(b.key))
    .map((i) => i.key);
  return { pid: null, seq };
}
