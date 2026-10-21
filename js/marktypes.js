// Mark types: the colour palette, the registry (library.json "markTypes"), CSS variables per type,
// and the "Mark types" editor. Every view styles a mark through the class `mt-<id>`, which sets
//   --mt (base colour), --mt-ink (text colour, adapts to dark mode), --mt-tag (page marker colour),
//   --mt-wash (highlight), --mt-soft (box fill).
import { store } from "./store.js";
import { api } from "./api.js";
import * as ui from "./ui.js";

const { el, h } = ui;

// A calm palette with matched lightness, so no colour shouts over the others or over the interface.
export const PALETTE = {
  amber:  { name: "Amber",  base: "#d49a12", ink: "#8a5f00", inkDark: "#e7b84a" },
  rose:   { name: "Rose",   base: "#cf5683", ink: "#a2335f", inkDark: "#ec8db0" },
  teal:   { name: "Teal",   base: "#2a9c85", ink: "#1a6e5d", inkDark: "#5fc9b2" },
  blue:   { name: "Blue",   base: "#4c7dd3", ink: "#2d57a3", inkDark: "#8db0ee" },
  violet: { name: "Violet", base: "#8768cc", ink: "#5d45a3", inkDark: "#b9a3ec" },
  orange: { name: "Orange", base: "#d9793a", ink: "#a0501a", inkDark: "#f0a77a" },
  olive:  { name: "Olive",  base: "#7e9c36", ink: "#546e1c", inkDark: "#b4cf74" },
  slate:  { name: "Slate",  base: "#7b8595", ink: "#4c5463", inkDark: "#aeb6c3" },
};
const FALLBACK = { id: "", name: "", color: "slate", purpose: "", noteLabel: "Note", placeholder: "", suggest: false, hidden: false };

export function all() { return (store.lib && store.lib.markTypes) || []; }
export function visible() { return all().filter((t) => !t.hidden); }
export function get(id) { return all().find((t) => t.id === id) || { ...FALLBACK, id, name: id ? id[0].toUpperCase() + id.slice(1) : "Mark" }; }
// "mtype-" is a prefix nothing else in the app uses, so a type called "side" or "list" can't pick up other styles
export const cls = (id) => "mtype-" + String(id || "").replace(/[^a-z0-9-]/g, "");
// One-key marking in the reader: with text selected, a type's letter marks it. Each visible type gets the
// first letter of its name not already taken (J, K, G, N and F are reader keys). Kept here so the reader
// and the shortcuts list (Settings, ?) always agree. -> Map(letter -> type id)
export function quickKeys() {
  const used = new Set(["j", "k", "g", "n", "f"]), out = new Map();
  for (const t of visible()) {
    const letters = (t.name || t.id).toLowerCase().replace(/[^a-z]/g, "");
    const k = [...letters].find((c) => !used.has(c));
    if (k) { used.add(k); out.set(k, t.id); }
  }
  return out;
}
const RESERVED = new Set(["total", "error", "all", "constructor", "prototype"]);

function rgba(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

// (re)write the stylesheet that gives every type its colours
export function applyStyles() {
  let st = document.getElementById("mt-styles");
  if (!st) { st = document.createElement("style"); st.id = "mt-styles"; document.head.appendChild(st); }
  const ids = new Set(all().map((t) => t.id));
  // types that only exist on old marks still get a (neutral) style
  const rules = [], dark = [];
  const one = (id, color) => {
    const c = PALETTE[color] || PALETTE.slate;
    rules.push(`.${cls(id)}{--mt:${c.base};--mt-ink:${c.ink};--mt-tag:${c.ink};--mt-wash:${rgba(c.base, 0.26)};--mt-soft:${rgba(c.base, 0.08)}}`);
    dark.push(`.${cls(id)}{--mt-ink:${c.inkDark}}`);
  };
  all().forEach((t) => one(t.id, t.color));
  for (const id of ["question", "remark", "explain"]) if (!ids.has(id)) one(id, { question: "amber", remark: "rose", explain: "teal" }[id]);
  // dark ink: when the Settings theme forces dark, or the system is dark and the theme isn't forced light
  st.textContent = rules.join("\n") + "\n" + dark.map((r) => ':root[data-theme="dark"] ' + r).join("")
    + `\n@media (prefers-color-scheme: dark){${dark.map((r) => ':root:not([data-theme="light"]) ' + r).join("")}}`;
}
store.on("library", applyStyles);
store.on("marktypes", applyStyles);

async function save(types) {
  const j = await api.saveMarkTypes(types, store.lib.markTypesRev || 0);
  store.lib.markTypes = j.types;
  store.lib.markTypesRev = j.rev;
  store.emit("marktypes");
  return j.types;
}

const slug = (s) => String(s || "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").replace(/^[^a-z]+/, "").slice(0, 24);

/* ---------------------------------------------------------------- editor */
// Master–detail dialog: the list of types on the left, the selected type's settings on the right.
export function openEditor(opts = {}) {
  const draft = all().map((t) => ({ ...t, _new: false }));
  const usage = Object.create(null);
  for (const s of Object.values(store.stats || {})) for (const [k, v] of Object.entries((s && s.marks) || {})) if (!RESERVED.has(k) && typeof v === "number") usage[k] = (usage[k] || 0) + v;
  // marks whose type isn't in the registry any more get a (hidden) row, so the type can be named again
  for (const [k, n] of Object.entries(usage)) if (n && /^[a-z][a-z0-9-]{0,23}$/.test(k) && !draft.some((t) => t.id === k)) draft.push({ ...get(k), hidden: true, _new: false });
  let sel = Math.max(0, draft.findIndex((t) => t.id === opts.select));
  const builtin = new Set(["question", "remark", "explain"]);

  return new Promise((resolve) => {
    const prev = document.activeElement;
    const scrim = el("div", "scrim");
    const dlg = el("div", "dialog mte-editor"); dlg.setAttribute("role", "dialog"); dlg.setAttribute("aria-modal", "true"); dlg.setAttribute("aria-label", "Mark types");
    scrim.appendChild(dlg);
    const close = (v) => { scrim.remove(); document.removeEventListener("keydown", onKey, true); prev && prev.focus && prev.focus(); resolve(v); };
    const onKey = (ev) => { if (ev.key === "Escape" && !ev.target.closest(".menu")) { ev.preventDefault(); ev.stopPropagation(); close(null); } };
    document.addEventListener("keydown", onKey, true);

    const list = el("div", "mte-list"); list.setAttribute("role", "listbox"); list.setAttribute("aria-label", "Mark types");
    const form = el("div", "mte-form");
    const err = el("p", "mte-err"); err.hidden = true;

    function renderList() {
      list.textContent = "";
      draft.forEach((t, i) => {
        const r = el("button", "mte-row " + cls(t.id || "new-" + i));
        r.setAttribute("role", "option");
        r.setAttribute("aria-selected", String(i === sel));
        const nm = el("span", "mte-row__name", t.name || "Untitled");
        r.append(el("span", "mte-row__rule"), nm);
        if (t.hidden) r.append(el("span", "mte-row__meta", "hidden"));
        else if (usage[t.id]) r.append(el("span", "mte-row__meta num", String(usage[t.id])));
        r.onclick = () => { sel = i; renderList(); renderForm(); };
        list.appendChild(r);
      });
      // new (unsaved) types still need colours in the list
      draft.forEach((t, i) => { const r = list.children[i]; const c = PALETTE[t.color] || PALETTE.slate; r.style.setProperty("--mt", c.base); r.style.setProperty("--mt-ink", (document.documentElement.dataset.theme === "dark" || (document.documentElement.dataset.theme !== "light" && matchMedia("(prefers-color-scheme: dark)").matches)) ? c.inkDark : c.ink); });
    }

    function field(label, input, hint) {
      const w = el("label", "mte-field");
      w.append(el("span", "mte-field__lbl", label), input);
      if (hint) w.append(el("span", "mte-field__hint", hint));
      return w;
    }

    function renderForm() {
      form.textContent = "";
      const t = draft[sel]; if (!t) return;
      const name = h("input", { class: "input", value: t.name, maxlength: 30, "aria-label": "Name" });
      name.oninput = () => { t.name = name.value; renderList(); };
      const sw = el("div", "mte-swatches"); sw.setAttribute("role", "radiogroup"); sw.setAttribute("aria-label", "Colour");
      for (const [k, c] of Object.entries(PALETTE)) {
        const b = el("button", "mte-swatch"); b.type = "button";
        b.style.setProperty("--sw", c.base);
        b.title = c.name; b.setAttribute("role", "radio"); b.setAttribute("aria-checked", String(t.color === k)); b.setAttribute("aria-label", c.name);
        b.onclick = () => { t.color = k; renderList(); renderForm(); };
        sw.appendChild(b);
      }
      const purpose = h("textarea", { class: "textarea", rows: 3, maxlength: 600, "aria-label": "What it's for", placeholder: "e.g. A step the authors skip. Write out the missing algebra." });
      purpose.value = t.purpose || "";
      purpose.oninput = () => { t.purpose = purpose.value; };
      const noteLabel = h("input", { class: "input", value: t.noteLabel || "", maxlength: 60, placeholder: "Note" });
      noteLabel.oninput = () => { t.noteLabel = noteLabel.value; };
      const ph = h("input", { class: "input", value: t.placeholder || "", maxlength: 120, placeholder: "Example text shown in the empty note" });
      ph.oninput = () => { t.placeholder = ph.value; };
      const sug = h("input", { type: "checkbox", checked: !!t.suggest });
      sug.onchange = () => { t.suggest = sug.checked; };
      const shown = h("input", { type: "checkbox", checked: !t.hidden });
      shown.onchange = () => { t.hidden = !shown.checked; renderList(); };

      const up = h("button", { class: "btn btn--small", type: "button", disabled: sel === 0, onclick: () => { draft.splice(sel - 1, 0, draft.splice(sel, 1)[0]); sel--; renderList(); renderForm(); } }, "Move up");
      const down = h("button", { class: "btn btn--small", type: "button", disabled: sel === draft.length - 1, onclick: () => { draft.splice(sel + 1, 0, draft.splice(sel, 1)[0]); sel++; renderList(); renderForm(); } }, "Move down");
      const inUse = usage[t.id] || 0;
      const canRemove = !builtin.has(t.id) && !inUse;
      const rm = h("button", { class: "btn btn--small btn--danger", type: "button", disabled: !canRemove,
        title: builtin.has(t.id) ? "Built-in types can be hidden but not removed." : inUse ? `${inUse} marks use this type. Hide it instead.` : "",
        onclick: () => { draft.splice(sel, 1); sel = Math.max(0, sel - 1); renderList(); renderForm(); } }, "Remove");

      form.append(
        field("Name", name),
        field("Colour", sw),
        field("What it's for", purpose, "Shown when you make this kind of mark, and written at the top of each .marks.md file so anyone reading your notes knows what each type means."),
        el("div", "mte-two"),
      );
      form.lastChild.append(field("Note prompt", noteLabel), field("Example note", ph));
      const checks = el("div", "mte-checks");
      const c1 = el("label", "mte-check"); c1.append(sug, document.createTextNode(" Ask for suggested wording"));
      const c2 = el("label", "mte-check"); c2.append(shown, document.createTextNode(" Show in the mark picker"));
      checks.append(c1, c2);
      const row = el("div", "mte-formfoot"); row.append(up, down, el("span", "grow"), rm);
      form.append(checks, row);
      if (inUse) form.append(el("p", "mte-field__hint", `${inUse} ${inUse === 1 ? "mark uses" : "marks use"} this type.`));
    }

    const add = h("button", { class: "btn btn--small", type: "button", onclick: () => {
      if (draft.length >= 24) { err.textContent = "That's the most types you can have (24)."; err.hidden = false; return; }
      const usedColors = new Set(draft.map((t) => t.color));
      const color = Object.keys(PALETTE).find((k) => !usedColors.has(k)) || "slate";
      draft.push({ id: "", name: "New type", color, purpose: "", noteLabel: "Note", placeholder: "", suggest: false, hidden: false, _new: true });
      sel = draft.length - 1; renderList(); renderForm();
      setTimeout(() => { const i = form.querySelector("input"); i && (i.focus(), i.select()); }, 0);
    } }, ui.icon("plus"), "Add type");

    const saveBtn = h("button", { class: "btn btn--primary", type: "button" }, "Save");
    saveBtn.onclick = async () => {
      err.hidden = true;
      const ids = new Set(draft.filter((t) => !t._new).map((t) => t.id));
      const names = new Set();
      const out = [];
      for (const t of draft) {
        const name = (t.name || "").replace(/\s+/g, " ").trim();
        if (!name) { err.textContent = "Every type needs a name."; err.hidden = false; return; }
        if (names.has(name.toLowerCase())) { err.textContent = `Two types are called “${name}”. Give each its own name.`; err.hidden = false; return; }
        names.add(name.toLowerCase());
        let id = t.id;
        if (t._new) {
          let base = slug(name) || "type";
          if (RESERVED.has(base)) base += "-type";
          id = base; let n = 2;
          while (ids.has(id) || RESERVED.has(id)) id = (base.slice(0, 21) + "-" + n++);
          ids.add(id);
        }
        const { _new, ...rest } = t;
        out.push({ ...rest, id, name });
      }
      saveBtn.disabled = true;
      try { await save(out); ui.toast("Mark types saved."); close(out); }
      catch (e) {
        err.textContent = e.message; err.hidden = false; saveBtn.disabled = false;
        if (e.conflict) store.load().catch(() => {});   // pick up the other window's types for next time
      }
    };

    const head = el("div", "mte-head");
    head.append(h("h2", null, "Mark types"), h("p", null, "What each kind of mark is for. Your marks keep their type; renaming or recolouring a type updates every mark that uses it."));
    const side = el("div", "mte-side"); side.append(list, el("div", "mte-sidefoot"));
    side.lastChild.append(add);
    const body = el("div", "mte-body"); body.append(side, form);
    const foot = el("div", "dialog__actions"); foot.append(err, el("span", "grow"), h("button", { class: "btn", type: "button", onclick: () => close(null) }, "Cancel"), saveBtn);
    dlg.append(head, body, foot);
    scrim.addEventListener("pointerdown", (ev) => { if (ev.target === scrim) close(null); });
    document.getElementById("overlay-root").appendChild(scrim);
    renderList(); renderForm();
    setTimeout(() => { const s = list.querySelector('[aria-selected="true"]'); s && s.focus(); }, 0);
  });
}
