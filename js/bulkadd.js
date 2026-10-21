// Add many papers at once: paste (or drop a file with) anything that has papers in it — one per line, a .bib
// file, a reference list copied from a paper — check what was found, then add them all with one click.
import { store } from "./store.js";
import * as ui from "./ui.js";

const { h, el } = ui;

/* ---------------------------------------------------------------- finding papers in text */
// APS reference style ("Phys. Rev. B 61, 5337 (2000)") maps straight to a DOI
const APS = [
  [/^phys\.?\s*rev\.?\s*lett\.?$/i, "PhysRevLett"], [/^phys\.?\s*rev\.?\s*x$/i, "PhysRevX"],
  [/^phys\.?\s*rev\.?\s*research$/i, "PhysRevResearch"], [/^phys\.?\s*rev\.?\s*applied$/i, "PhysRevApplied"],
  [/^phys\.?\s*rev\.?\s*materials$/i, "PhysRevMaterials"], [/^rev\.?\s*mod\.?\s*phys\.?$/i, "RevModPhys"],
  [/^phys\.?\s*rev\.?\s*([a-e])$/i, (m) => "PhysRev" + m[1].toUpperCase()], [/^phys\.?\s*rev\.?$/i, "PhysRev"],
];
const APS_REF = /\b((?:Phys\.?\s*Rev\.?\s*(?:Lett\.?|Research|Applied|Materials|[A-EX]\b)?)|Rev\.?\s*Mod\.?\s*Phys\.?)\s*(\d{1,3})\s*,\s*(L?\d{3,6})\b/;
const DOI_RE = /\b(10\.\d{4,9}\/[^\s"<>]+)/g;
const ARXIV_RE = /(?:arxiv[:\s]\s*|arxiv\.org\/(?:abs|pdf)\/)([a-z-]+(?:\.[A-Z]{2})?\/\d{7}(?:v\d+)?|\d{4}\.\d{4,5}(?:v\d+)?)/ig;
const BARE_ARXIV = /(?:^|[\s(\[,;])((?:0[7-9]|[12]\d|3[0-5])(?:0[1-9]|1[0-2])\.\d{4,5}(?:v\d+)?)(?=$|[\s)\],;.])/g;
const URL_RE = /https?:\/\/[^\s<>"]+/g;
const trimEnd = (s) => s.replace(/[.,;:)\]}>'"]+$/, "");

function apsDoi(line) {
  const m = APS_REF.exec(line); if (!m) return "";
  const j = m[1].replace(/\s+/g, " ").trim();
  for (const [re, code] of APS) { const mm = re.exec(j); if (mm) return `10.1103/${typeof code === "function" ? code(mm) : code}.${m[2]}.${m[3]}`; }
  return "";
}

function bibEntries(text) {
  const out = [];
  const re = /@(\w+)\s*\{\s*[^,]*,/g; let m;
  const starts = []; while ((m = re.exec(text))) if (!/^(comment|string|preamble)$/i.test(m[1])) starts.push(m.index);
  starts.forEach((s, i) => {
    const body = text.slice(s, starts[i + 1] || text.length);
    const f = (name) => { const mm = new RegExp(`\\b${name}\\s*=\\s*(?:\\{((?:[^{}]|\\{[^{}]*\\})*)\\}|"([^"]*)")`, "i").exec(body); return mm ? (mm[1] || mm[2] || "").replace(/[{}]/g, "").trim() : ""; };
    const doi = f("doi").replace(/^https?:\/\/(dx\.)?doi\.org\//i, ""), eprint = f("eprint"), url = f("url"), title = f("title").replace(/\s+/g, " ");
    const label = title || doi || eprint || url;
    if (doi) out.push({ kind: "DOI", input: doi, label });
    else if (eprint && /^(\d{4}\.\d{4,5}|[a-z-]+(\.[A-Z]{2})?\/\d{7})/i.test(eprint)) out.push({ kind: "arXiv", input: eprint, label });
    else if (url) out.push({ kind: "link", input: url, label });
    else if (title) out.push({ kind: "title", input: title, label });
  });
  return out;
}

export function parseEntries(text) {
  const out = [], seen = new Set();
  const add = (e) => { const k = e.input.toLowerCase().replace(/v\d+$/, ""); if (!seen.has(k)) { seen.add(k); out.push(e); } };
  text = String(text || "");
  if (/@\w+\s*\{/.test(text)) { bibEntries(text).forEach(add); if (out.length) return out; }
  for (let line of text.split(/\r?\n/)) {
    line = line.trim().replace(/^(\[\d+\]|\(\d+\)|\d+[.)]|[-*•])\s+/, "");
    if (!line) continue;
    const found = [];
    for (const m of line.matchAll(DOI_RE)) found.push({ kind: "DOI", input: trimEnd(m[1]) });
    if (!found.length) for (const m of line.matchAll(ARXIV_RE)) found.push({ kind: "arXiv", input: trimEnd(m[1]) });
    if (!found.length) for (const m of line.matchAll(URL_RE)) found.push({ kind: "link", input: trimEnd(m[0]) });
    if (!found.length) { const d = apsDoi(line); if (d) found.push({ kind: "DOI", input: d }); }
    if (!found.length) for (const m of line.matchAll(BARE_ARXIV)) found.push({ kind: "arXiv", input: m[1] });
    if (!found.length && (line.match(/[A-Za-z]{2,}/g) || []).length >= 4) {
      // a citation ("A. Author, Journal 12, 345 (2001)") or just a title: both go to the title search
      found.push({ kind: /\(\d{4}\)|\b(19|20)\d{2}\b.*\d|et al\./.test(line) ? "reference" : "title", input: line });
    }
    const label = found.length === 1 && found[0].kind !== "link" && line.length > found[0].input.length + 8 ? line : null;
    found.forEach((e) => add({ ...e, label: label || e.input }));
  }
  return out;
}

// is it already in the library? (by DOI or arXiv id; titles are left to the server)
function inLibrary(e) {
  const v = e.input.toLowerCase().replace(/v\d+$/, "");
  return store.items().find((it) => (e.kind === "DOI" && (it.doi || "").toLowerCase() === v)
    || (e.kind === "arXiv" && (it.arxiv || "").toLowerCase().replace(/v\d+$/, "") === v)) || null;
}

/* ---------------------------------------------------------------- the dialog */
// openBulkAdd({text, files, project, plain, onDone(keys)}): plain(title) turns TeX titles into text
export function openBulkAdd({ text = "", files = [], project = null, plain = (t) => t, onDone } = {}) {
  const pdfs = [...files], removed = new Set(), keys = [];
  let entries = [], running = false, stopped = false;
  const scrim = el("div", "scrim"), d = el("div", "dialog bulk");
  d.setAttribute("role", "dialog"); d.setAttribute("aria-modal", "true"); d.setAttribute("aria-label", "Add papers");
  scrim.append(d);
  const ta = h("textarea", { class: "textarea bulk__text", rows: 7, spellcheck: false, "aria-label": "Papers to add",
    placeholder: "One per line: arXiv IDs, DOIs, links or titles.\nOr paste a reference list, or a whole .bib file." });
  ta.value = text;
  const file = h("input", { type: "file", multiple: true, hidden: true, accept: ".bib,.txt,.ris,.md,.pdf,application/pdf,text/plain" });
  const choose = h("button", { class: "btn btn--small", onclick: () => file.click() }, "Choose files…");
  const projSel = h("select", { class: "select bulk__proj", "aria-label": "Project" },
    h("option", { value: "" }, "My Library (no project)"), ...store.lib.projects.map((p) => h("option", { value: p.id }, p.name)));
  projSel.value = project && store.project(project) ? project : "";
  const list = el("div", "bulk__list"), sum = el("p", "bulk__sum faint");
  const cancel = h("button", { class: "btn", onclick: () => (running ? stop() : close()) }, "Cancel");
  const retry = h("button", { class: "btn", hidden: true, onclick: () => run(entries.filter((e) => e.failed)) }, "Retry failed");
  const go = h("button", { class: "btn btn--primary", onclick: () => (go.dataset.done ? close() : run(entries)) }, "Add");
  const input = el("div", "bulk__input");
  input.append(ta, h("div", { class: "bulk__row" }, choose, el("span", "faint", ".bib, .txt or PDFs"), el("span", "grow"),
    el("span", "faint", "Add to"), projSel));
  d.append(h("h2", null, "Add papers"), input, list, sum, h("div", { class: "dialog__actions" }, retry, el("span", "grow"), cancel, go), file);

  const keyOf = (e) => e.kind + ":" + e.input;
  function parse() {
    entries = [...parseEntries(ta.value), ...pdfs.map((f) => ({ kind: "PDF", input: f.name, label: f.name, file: f }))]
      .filter((e) => !removed.has(keyOf(e)));
    list.textContent = "";
    for (const e of entries) {
      const have = e.file ? null : inLibrary(e);
      e.what = el("span", "bulk__what", have ? plain(have.title) : e.label);
      e.st = el("span", "bulk__st" + (have ? " is-ok" : ""), have ? "In your library" : "");
      const x = h("button", { class: "bulk__x", title: "Leave this one out", "aria-label": "Leave out " + e.label, onclick: () => { removed.add(keyOf(e)); if (e.file) pdfs.splice(pdfs.indexOf(e.file), 1); parse(); } }, "×");
      e.row = h("div", { class: "bulk__item" }, el("span", "bulk__kind", e.kind), e.what, e.st, x);
      list.append(e.row);
    }
    const n = entries.length;
    sum.textContent = n ? "" : ta.value.trim() ? "Nothing that looks like a paper yet. Use one paper per line." : "";
    go.textContent = n === 1 ? "Add 1 paper" : `Add ${n} papers`; go.disabled = !n;
  }
  ta.addEventListener("input", ui.debounce ? ui.debounce(parse, 250) : parse);
  file.addEventListener("change", async () => {
    for (const f of file.files) {
      if (f.type === "application/pdf" || /\.pdf$/i.test(f.name)) pdfs.push(f);
      else ta.value = (ta.value.trim() ? ta.value.trim() + "\n" : "") + await f.text();
    }
    file.value = ""; parse();
  });

  const status = (e, txt, cls) => { e.st.textContent = txt; e.st.className = "bulk__st" + (cls ? " is-" + cls : ""); };
  async function one(e) {
    const pid = projSel.value || null;
    e.failed = false; status(e, "Adding…");
    if (e.picks) { e.picks.remove(); e.picks = null; }
    try {
      const j = e.file ? await store.importFile(e.file, pid) : await store.import(e.input, pid);
      if (j.duplicate && pid && !(j.item.projects || []).includes(pid)) await store.bulk({ keys: [j.item.key], addProjects: [pid] }).catch(() => {});
      keys.push(j.item.key);
      e.what.textContent = plain(j.item.title) || e.label;
      const w = (j.warnings || []).find((x) => /arXiv preprint|No open-access|attach/i.test(x));
      status(e, j.duplicate ? "Already in your library" : w ? (/preprint/i.test(w) ? "Added (arXiv preprint)" : "Added, no PDF") : "Added", "ok");
    } catch (err) {
      e.failed = true;
      const cands = ((err.payload && err.payload.candidates) || []).filter((c) => c && c.input && c.title).slice(0, 4);
      if (!cands.length) { status(e, /title matches/i.test(err.message) ? "No exact title match. Use its DOI or arXiv ID." : err.message, "err"); return; }
      status(e, "Which one?", "err");
      e.picks = el("div", "bulk__picks");
      for (const c of cands) {
        const b = h("button", { class: "lib-add__pick", title: c.input }, el("span", "lib-add__pick-t", plain(c.title)),
          el("span", "lib-add__pick-m", [c.authors, c.year, c.venue].filter(Boolean).join(" · ")));
        b.onclick = () => { e.input = c.input; one(e).then(summary); };
        e.picks.append(b);
      }
      e.row.after(e.picks);
    }
  }
  function summary() {
    const ok = entries.filter((e) => e.st.classList.contains("is-ok")).length, bad = entries.filter((e) => e.failed).length;
    sum.textContent = `${ok} of ${entries.length} in your library` + (bad ? `, ${bad} couldn't be added.` : ".");
    retry.hidden = running || !bad;
  }
  async function run(todo) {
    todo = todo.filter((e) => !(e.st.classList.contains("is-ok")));
    if (!todo.length) { summary(); return; }
    running = true; stopped = false; input.hidden = true; d.querySelectorAll(".bulk__x").forEach((x) => (x.hidden = true));
    go.disabled = true; retry.hidden = true; cancel.textContent = "Stop";
    todo.forEach((e) => status(e, "Waiting…"));
    let i = 0;
    const worker = async () => { while (!stopped && i < todo.length) { const e = todo[i++]; await one(e); summary(); } };
    await Promise.all([worker(), worker(), worker()]);   // three at a time; the server spaces out requests to each site
    todo.filter((e) => e.st.textContent === "Waiting…").forEach((e) => { e.failed = true; status(e, "Stopped", "err"); });
    running = false; cancel.hidden = true; go.disabled = false; go.textContent = "Done"; go.dataset.done = "1";
    summary();
  }
  function stop() { stopped = true; cancel.disabled = true; cancel.textContent = "Stopping…"; }
  function close() {
    if (running) return;
    scrim.remove(); document.removeEventListener("keydown", onKey, true);
    if (keys.length && onDone) onDone([...new Set(keys)]);
  }
  const onKey = (ev) => {
    if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); if (!running) close(); }
    else if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey) && !go.disabled) { ev.preventDefault(); go.click(); }
  };
  document.addEventListener("keydown", onKey, true);
  document.getElementById("overlay-root").append(scrim);
  parse();
  setTimeout(() => (text ? go : ta).focus(), 0);
}
