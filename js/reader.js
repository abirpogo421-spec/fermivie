// Reader view: PDF.js reader with marks of every type (see CONTRACT.md §5.2).
import * as ui from "./ui.js";
import * as mt from "./marktypes.js";
import * as journal from "./journal.js";
import * as undoLog from "./undo.js";
import * as order from "./order.js";
import * as commands from "./commands.js";

const TEMPLATE = "<div class=\"rd\" id=\"rd-root\">\n  <div class=\"toolbar rd-bar\">\n    <button class=\"ibtn\" id=\"rd-sideBtn\" aria-pressed=\"false\" title=\"Outline\" aria-label=\"Show outline\">SIDEIC</button>\n    <button class=\"rd-title\" id=\"rd-title\" aria-haspopup=\"listbox\" title=\"Switch paper (\u2318P)\"></button>\n    <select class=\"select rd-version\" id=\"rd-docSelect\" aria-label=\"PDF version\" hidden></select>\n    <button class=\"btn btn--small rd-journal\" id=\"rd-journalBtn\" hidden title=\"Opens the journal's PDF in your browser with your access. Download it there to add it here.\">Get journal PDF</button>\n    <span class=\"grow\"></span>\n    <div class=\"segctl\" role=\"group\" aria-label=\"Zoom\">\n      <button class=\"segctl__btn segctl__btn--icon\" id=\"rd-zoomOut\" aria-label=\"Zoom out\" title=\"Zoom out (\u2318\u2212)\">ZOUT</button>\n      <div class=\"zoomwrap\">\n        <button class=\"segctl__btn rd-zoomval\" id=\"rd-zoomVal\" aria-haspopup=\"menu\" aria-expanded=\"false\" title=\"Zoom options\">100%</button>\n        <div class=\"rd-zmenu\" id=\"rd-zoomMenu\" role=\"menu\" hidden>\n          <button role=\"menuitem\" data-fit=\"width\">Fit width <kbd>\u23180</kbd></button>\n          <button role=\"menuitem\" data-fit=\"page\">Fit page</button>\n          <hr>\n          <button role=\"menuitem\" data-z=\"0.5\">50%</button>\n          <button role=\"menuitem\" data-z=\"0.75\">75%</button>\n          <button role=\"menuitem\" data-z=\"1\">100%</button>\n          <button role=\"menuitem\" data-z=\"1.25\">125%</button>\n          <button role=\"menuitem\" data-z=\"1.5\">150%</button>\n          <button role=\"menuitem\" data-z=\"2\">200%</button>\n          <button role=\"menuitem\" data-z=\"3\">300%</button>\n          <button role=\"menuitem\" data-z=\"4\">400%</button>\n          <p class=\"rd-zmenu__tip\">Pinch or \u2318 + scroll to zoom at the cursor</p>\n        </div>\n      </div>\n      <button class=\"segctl__btn segctl__btn--icon\" id=\"rd-zoomIn\" aria-label=\"Zoom in\" title=\"Zoom in (\u2318+)\">ZIN</button>\n    </div>\n    <label class=\"pageind\" title=\"Go to page\">\n      <span class=\"sr\">Page</span>\n      <input class=\"input\" id=\"rd-pageIn\" inputmode=\"numeric\" autocomplete=\"off\" value=\"\u2013\" aria-label=\"Current page\">\n      <span id=\"rd-pageTot\" class=\"muted\">of \u2013</span>\n    </label>\n    <span class=\"grow\"></span>\n    <span class=\"rd-save\" id=\"rd-saveState\" role=\"status\" aria-live=\"polite\"></span>\n    <div class=\"segctl\" role=\"group\" aria-label=\"Tool\">\n      <button class=\"segctl__btn\" id=\"rd-toolSelect\" aria-pressed=\"true\" title=\"Select and read (Esc)\">CURSORIC Select</button>\n      <button class=\"segctl__btn\" id=\"rd-markBtn\" aria-pressed=\"false\" title=\"Annotate: select text or drag a box over an equation or figure (`)\">MARKIC Annotate</button>\n      <button class=\"segctl__btn\" id=\"rd-pinBtn\" aria-pressed=\"false\" title=\"Pin: drag a box over a figure or text to keep it at the side while you read (P)\">PINIC Pin</button>\n    </div>\n    <button class=\"ibtn\" id=\"rd-marksBtn\" aria-pressed=\"true\" title=\"Marks and notes (N)\" aria-label=\"Show marks and notes\">PANELIC<span id=\"rd-notesCount\" hidden></span></button>\n    <button class=\"ibtn\" id=\"rd-notesBtn\" hidden aria-hidden=\"true\" tabindex=\"-1\"></button>\n  </div>\n  <div class=\"rd-layout\">\n    <aside class=\"rd-side\" id=\"rd-side\" hidden aria-label=\"Outline\"><div class=\"rd-side__head\">Outline</div><div class=\"rd-outline\" id=\"rd-outline\"></div></aside>\n    <div class=\"viewwrap\">\n      <div class=\"banner\" id=\"rd-banner\" hidden>Select text, or drag a box over an equation or figure (hold Shift to force a box). Esc returns to Select.</div>\n      <main class=\"viewer\" id=\"rd-viewer\" tabindex=\"-1\" aria-label=\"Paper\">\n        <div class=\"pages\" id=\"rd-pages\"><div class=\"state\" id=\"rd-loadState\">Loading the paper\u2026</div></div>\n      </main>\n      <button class=\"btn rd-backbtn\" id=\"rd-backBtn\" hidden title=\"Back to where you were\">BACKIC <span id=\"rd-backLbl\">Back</span></button>\n      <aside class=\"pinboard\" id=\"rd-pins\" hidden aria-label=\"Pinned\"><div class=\"pinboard__grip\" id=\"rd-pinGrip\" title=\"Drag to resize\"></div><div class=\"pinboard__list\" id=\"rd-pinList\"></div></aside>\n    </div>\n    <aside class=\"panel\" id=\"rd-panel\" aria-label=\"Side panel\">\n      <div class=\"panel__head\">\n        <div class=\"tabs\" role=\"tablist\" aria-label=\"Panel\">\n          <button role=\"tab\" id=\"rd-tabMarks\" aria-selected=\"true\">Marks <span id=\"rd-tabMarksCount\" class=\"num faint\">0</span></button>\n          <button role=\"tab\" id=\"rd-tabNotes\" aria-selected=\"false\">Notes</button>\n        </div>\n        <button class=\"ibtn\" id=\"rd-panelClose\" aria-label=\"Hide side panel\" title=\"Hide (N)\">XIC</button>\n      </div>\n      <section class=\"pview\" id=\"rd-viewMarks\" role=\"tabpanel\">\n        <div class=\"chips\" id=\"rd-filters\" role=\"tablist\" aria-label=\"Filter by type\"></div>\n        <input class=\"input rd-search\" id=\"rd-search\" type=\"search\" placeholder=\"Search quotes and notes\" aria-label=\"Search marks\">\n        <div class=\"list\" id=\"rd-list\"></div>\n        <div class=\"panel__foot\"><div class=\"handoff\">Saved to <code id=\"rd-notesPath\">library/items/\u2026</code></div></div>\n      </section>\n      <section class=\"pview\" id=\"rd-viewNotes\" role=\"tabpanel\" hidden>\n        <p class=\"gn__lede\">Notes on this paper, shared by all its PDF versions. Saved as you type.</p>\n        <textarea id=\"rd-gnText\" class=\"textarea gn__text\" spellcheck=\"true\" aria-label=\"Paper notes\" placeholder=\"Anything that isn't tied to one spot in the paper.\"></textarea>\n        <div class=\"gn__bar\">\n          <button class=\"btn btn--small\" id=\"rd-gnPage\" title=\"Insert the page you're looking at\">Insert page ref</button>\n          <span class=\"grow\"></span>\n          <span class=\"gn__save\" id=\"rd-gnSave\" role=\"status\" aria-live=\"polite\"></span>\n        </div>\n        <div class=\"panel__foot\"><div class=\"handoff\">Saved to <code id=\"rd-gnPath\">library/items/\u2026/notes.md</code></div></div>\n      </section>\n    </aside>\n  </div>\n  <div class=\"composer\" id=\"rd-composer\" role=\"dialog\" aria-modal=\"false\" aria-labelledby=\"rd-cmpTitle\" hidden>\n    <div class=\"cmp__meta\">\n      <span class=\"chip\" id=\"rd-cmpTitle\">p. 1</span>\n      <span class=\"chip chip--kind\" id=\"rd-cmpKind\">text</span>\n      <span class=\"chip chip--num\" id=\"rd-cmpNum\" hidden>#1</span>\n    </div>\n    <blockquote class=\"cmp__quote\" id=\"rd-cmpQuote\"></blockquote>\n    <img class=\"cmp__crop\" id=\"rd-cmpCrop\" alt=\"Marked region\" hidden>\n    <div class=\"tpick\" role=\"radiogroup\" aria-label=\"Mark type\" id=\"rd-seg\"></div>\n    <p class=\"seg__hint\" id=\"rd-segHint\"></p>\n    <label class=\"fld\">\n      <span class=\"fld__lbl\" id=\"rd-noteLbl\">Your question</span>\n      <textarea class=\"textarea\" id=\"rd-noteIn\" rows=\"3\"></textarea>\n    </label>\n    <label class=\"fld\" id=\"rd-suggestWrap\" hidden>\n      <span class=\"fld__lbl\">Suggested wording <span class=\"opt\">optional</span></span>\n      <textarea class=\"textarea\" id=\"rd-suggestIn\" rows=\"3\" placeholder=\"Your version of this text\"></textarea>\n    </label>\n    <div class=\"cmp__actions\">\n      <button class=\"btn btn--danger\" id=\"rd-cmpDelete\" hidden>Delete</button>\n      <span class=\"grow\"></span>\n      <button class=\"btn\" id=\"rd-cmpCancel\">Cancel</button>\n      <button class=\"btn btn--primary\" id=\"rd-cmpSave\">Save <kbd>\u2318\u21b5</kbd></button>\n    </div>\n  </div>\n  <div class=\"preview\" id=\"rd-preview\" hidden aria-hidden=\"true\">\n    <div class=\"pv__img\" id=\"rd-pvImg\"></div>\n    <div class=\"pv__lbl\" id=\"rd-pvLabel\"></div>\n  </div>\n</div>\n";

export function mountReader(root, ctx) {
  "use strict";
  const { api, store } = ctx;
  root.innerHTML = TEMPLATE;
  for (const [ph, name] of [["SIDEIC", "sidebar-left"], ["CURSORIC", "cursor"], ["PANELIC", "sidebar-right"], ["ZOUT", "minus"], ["ZIN", "plus"], ["MARKIC", "mark"], ["QUOTEIC", "quote"], ["NOTEIC", "note"], ["BACKIC", "back"], ["XIC", "x"], ["PINIC", "pin"]]) {
    root.querySelectorAll("button").forEach((b) => {
      for (const n of [...b.childNodes]) if (n.nodeType === 3 && n.nodeValue.includes(ph)) {
        const [pre, post] = n.nodeValue.split(ph);
        n.before(document.createTextNode(pre), ui.icon(name)); n.nodeValue = post;
      }
    });
  }
  let visible = false;
  let needRestore = false;        // the paper finished loading while the Reader was hidden
  let cur = null;                 // {key, att} of the open PDF

  // TeX fonts without ToUnicode put ligatures at these code points (ff, fi, fl, ffi, ffl)
  const LIG = { "\u001b": "ff", "\u001c": "fi", "\u001d": "fl", "\u001e": "ffi", "\u001f": "ffl", "ﬀ": "ff", "ﬁ": "fi", "ﬂ": "fl", "ﬃ": "ffi", "ﬄ": "ffl" };
  const clean = (t) => (t || "").replace(/[\u001b-\u001fﬀ-ﬄ]/g, (c) => LIG[c]).replace(/ /g, " ");
  // A PDF's text layer gives an equation back as stacked fragments ("∂ρ(N )\nmp\n∂t + i\nħ\n["). Such a selection
  // is shown as the picture of the marked area; ordinary text is joined back into one line (de-hyphenated).
  const MATH_CH = /[=+−×·∂∇∑∫∏√∞≈≡≠≤≥±∓ħℏ⟨⟩‖^_[\]{}|α-ωϑϕϵΑ-Ω]/g;
  function looksLikeMath(q) {
    const t = (q || "").trim(); if (!t) return false;
    const lines = t.split(/\n+/).map((l) => l.trim()).filter(Boolean);
    const n = t.replace(/\s+/g, "").length, sym = (t.match(MATH_CH) || []).length;
    if (lines.length >= 3 && n / lines.length < 10) return true;          // a column of short fragments
    return n <= 160 && sym / Math.max(1, n) > 0.25;                       // mostly symbols
  }
  const tidyQuote = (q) => (q || "").replace(/(\w)[-\u00ad]\n(?=[a-z])/g, "$1").replace(/\s*\n\s*/g, " ").replace(/[ \t]+/g, " ").trim();
  const isEq = (m) => !!m && m.kind !== "box" && (m.eq || looksLikeMath(m.quote));
  const liveCrops = new Map();   // mark id -> promise of a picture, for older equation marks saved without one
  const $ = (id) => document.getElementById("rd-" + id);
  const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

  const ZMIN = 0.25, ZMAX = 5;
  const STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];
  // Largest canvas we draw in one piece (Safari refuses canvases over 16.7M pixels).
  // Past this, the page gets a capped base canvas plus a full-resolution canvas for the visible part.
  const MAX_PX = 16e6;
  const BASE_PX = 6e6;            // base canvas size when a detail canvas covers the visible part (keeps zooming fast)

  const S = {
    doc: null, pdf: null, pages: [], scale: 1, fitMode: "width", marks: [], mark: false,
    filter: "all", query: "", lastType: "question", draft: null, editing: null, confirmDel: null,
    renderGen: 0, tab: "marks",
  };
  try { S.lastType = localStorage.getItem(api.lsKey("pm2:lastType")) || "question"; } catch (_) {}

  /* ---------------------------------------------------------------- load */
  function setLoad(msg, err) {
    const s = $("loadState"); if (!s) return;
    s.textContent = msg; s.classList.toggle("err", !!err);
  }

  let openSeq = 0, loadTask = null;
  // Open documents stay loaded (PDF, pages, their text and nearby low-res copies), so switching back to a
  // tab is instant (CONTRACT §5.2: about 6 kept, least recently used dropped first).
  const docs = new Map(), MAX_DOCS = 6;   // "key/att" -> { task, pdf, pages }, oldest first
  function dropDoc(id) {
    const D = docs.get(id); if (!D) return;
    docs.delete(id);
    (D.pages || []).forEach((P) => { releasePage(P, true); P.div = P.tl = P.lk = P.ov = P.fl = null; P.tlBuilt = false; });
    D.task.destroy().catch(() => {});
  }
  function evictDocs() {
    for (const id of [...docs.keys()]) { if (docs.size <= MAX_DOCS) break; if (id !== S.doc) dropDoc(id); }
  }
  // switching away: the page keeps its PDFPageProxy and text; near the page you were on it also keeps its
  // low-res copy (shown at once when you come back); far pages give their decoded images back
  function detachPage(P, keepThumb) {
    releasePage(P, !keepThumb);
    if (P.thumbTask) { try { P.thumbTask.cancel(); } catch (_) {} P.thumbTask = null; }
    if (P.thumb) P.thumb.remove();
    if (!keepThumb) { try { P.page.cleanup(); } catch (_) {} }
    P.div = P.tl = P.lk = P.ov = P.fl = null; P.tlBuilt = false;
  }

  $("journalBtn").onclick = () => {
    if (!cur) return;
    const key = cur.key;
    journal.getJournalPdf(key, { onFound: (item) => {
      // switch to the journal version only if the user is still looking at this paper (never pull them
      // out of the Library or another view: `cur` stays set while the reader is hidden)
      if (visible && cur && cur.key === key && !draftDirty() && item.primary) ctx.openReader(key, item.primary, { replace: true });
    } });
  };
  function fillVersions(it, att) {
    $("journalBtn").hidden = !journal.canGet(it);
    const sel = $("docSelect");
    sel.textContent = "";
    (it.attachments || []).forEach((a) => { const o = el("option", null, a.label || a.file || a.key); o.value = a.key; sel.appendChild(o); });
    sel.value = att;
    sel.hidden = (it.attachments || []).length < 2;
  }
  $("docSelect").addEventListener("change", () => {
    const sel = $("docSelect");
    if (!cur) return;
    if (draftDirty()) { sel.value = cur.att; nudgeComposer(); return; }
    ctx.openReader(cur.key, sel.value, { replace: true });
  });

  async function openDoc(key, att) {
    const seq = ++openSeq;
    needRestore = false;
    flushView(); flushSave(); flushNotes();      // while the outgoing paper is still laid out and current
    closeComposer();
    ++S.renderGen; cancelRender();
    const it = store.item(key);
    const a = it && (it.attachments || []).find((x) => x.key === att);
    if (!it || !a) throw new Error("This PDF isn't in the library.");
    // the outgoing document stays in `docs`; its pages give up their canvases and DOM
    if (S.pages.length) {
      const n0 = $("viewer").clientHeight ? currentPage() : (parseInt($("pageIn").value, 10) || 1);
      S.pages.forEach((P) => detachPage(P, Math.abs(P.n - n0) <= 12));
    }
    S.pages = []; S.pdf = null; loadTask = null;
    cur = { key, att };
    S.doc = key + "/" + att;
    S.readOnly = false;
    setTitleText(it);
    fillVersions(it, att);
    ctx.setTitle(key, att, it.title || key);
    $("notesPath").textContent = "library/items/" + key + "/" + att + ".marks.md";
    $("gnPath").textContent = "library/items/" + key + "/notes.md";
    const id = S.doc;
    let D = docs.get(id);
    if (D) { docs.delete(id); docs.set(id, D); }            // most recently used
    else { D = { task: api.openPdf(key, att), pdf: null, pages: null }; docs.set(id, D); evictDocs(); }
    loadTask = D.task;
    $("pages").innerHTML = D.pages ? "" : '<div class="state" id="rd-loadState">Loading the paper…</div>';
    $("pageTot").textContent = "of –"; $("pageIn").value = "–";
    destCache.clear(); backStack.length = 0; histDepth = 0; showBack(); hidePreview(); pvCache.clear();
    pageText.clear(); hits = []; hitAt = -1; ++findSeq; finding = false; markCursor = null; hideSelTb(); if (!find.hidden) fN.textContent = "";
    loadNotes(key);
    pins = []; renderPins();
    await loadMarks();                           // the PDF (when not kept) downloads meanwhile
    if (seq !== openSeq) return;
    renderMarksPanel();
    markOpened(key);
    try { D.pdf = await D.task.promise; }
    catch (e) { if (docs.get(id) === D) dropDoc(id); if (seq === openSeq) { loadTask = null; setLoad("Could not open this PDF: " + e.message, true); } return; }
    if (!D.pages) {
      const pages = [];
      try {
        const all = await Promise.all(Array.from({ length: D.pdf.numPages }, (_, k) => D.pdf.getPage(k + 1)));
        for (const page of all) {
          const vp1 = page.getViewport({ scale: 1 });
          pages.push({ n: page.pageNumber, page, tc: null, text: "", tlBuilt: false, w1: vp1.width, h1: vp1.height, div: null, canvas: null, baseKey: null, detail: null, task: null, dtask: null });
        }
      } catch (e) { if (seq === openSeq) setLoad("Could not read this PDF: " + e.message, true); return; }
      if (docs.get(id) === D && !D.pages) D.pages = pages;
    }
    if (seq !== openSeq || !D.pages) return;
    S.pdf = D.pdf;
    S.pages = D.pages;
    buildPages();
    loadPins();
    // loaded while the reader was hidden (the user went back to the Library): there is no layout to restore
    // the page or fit the zoom against, and nothing should render; show() does it when the reader is back
    if (visible) restoreView(); else needRestore = true;
    renderMarksPanel();
    loadOutline(seq);
    if (pendingJump) setTimeout(() => applyJump(pendingJump), 0);
  }
  // Recently Opened; opening a paper also takes it out of "unread". Bookkeeping, not an edit: no undo entry.
  function markOpened(key) {
    const it = store.item(key), patch = { opened: new Date().toISOString() };
    if (it && it.read === "unread") patch.read = "reading";
    api.patchItem(key, patch).then((j) => { if (j && j.item) store.setItem(j.item); }).catch(() => {});
  }

  // Outline from the PDF's bookmarks; a click jumps like a link (with Back)
  async function loadOutline(seq) {
    const box = $("outline");
    box.textContent = "";
    let ol = null;
    try { ol = await S.pdf.getOutline(); } catch (_) {}
    if (seq !== openSeq) return;
    if (!ol || !ol.length) { box.append(el("p", "rd-outline__none", "This PDF has no outline.")); return; }
    const build = (items, depth) => {
      for (const o of items) {
        const b = el("button", "rd-ol", (o.title || "").replace(/\s+/g, " ").trim() || "Untitled");
        b.style.paddingLeft = 8 + depth * 14 + "px";
        b.title = b.textContent;
        b.onclick = () => {
          if (o.dest) followDest(typeof o.dest === "string" ? o.dest : JSON.stringify(o.dest));
          else if (o.url) window.open(o.url, "_blank", "noopener");
        };
        box.append(b);
        if (o.items && o.items.length) build(o.items, depth + 1);
      }
    };
    build(ol, 0);
  }
  function setSide(open) {
    $("side").hidden = !open;
    $("sideBtn").setAttribute("aria-pressed", String(open));
    try { localStorage.setItem("pm2:rdside", open ? "1" : "0"); } catch (_) {}
    if (S.fitMode && S.pages.length) setTimeout(() => fit(S.fitMode), 0); else scheduleRender(0);
  }
  $("sideBtn").onclick = () => setSide($("side").hidden);

  // Text layers are built lazily (only for pages near the viewport): long papers open fast and zoom stays cheap.
  function ensureTextLayer(P) {
    if (P.tlBuilt || !P.tl) return;
    P.tlBuilt = true;
    const tl = P.tl;      // S.doc alone can't tell A -> B -> back to A apart: compare the layer itself
    (P.tc ? Promise.resolve(P.tc) : P.page.getTextContent()).then((tc) => {
      P.tc = tc;          // kept with the page: switching back rebuilds the layer without the worker
      P.text = clean(tc.items.map((it) => it.str + (it.hasEOL ? "\n" : "")).join(""));
      if (P.tl !== tl) return;
      pdfjsLib.renderTextLayer({ textContentSource: tc, container: tl, viewport: P.page.getViewport({ scale: S.scale }), textDivs: [] });
      tl.appendChild(el("div", "endOfContent"));
    }).catch(() => { if (P.tl === tl) P.tlBuilt = false; });
  }

  /* ---------------------------------------------------------------- pages */
  function buildPages() {
    const host = $("pages");
    host.innerHTML = "";
    for (const P of S.pages) {
      const div = el("div", "page");
      div.dataset.n = P.n;
      div.appendChild(el("span", "page__num", "p. " + P.n));
      const tl = el("div", "textLayer"); div.appendChild(tl);
      if (P.thumb) div.insertBefore(P.thumb, tl);   // kept from the last visit: shows at once
      const lk = el("div", "links"); div.appendChild(lk);
      const ov = el("div", "overlay"); div.appendChild(ov);
      // find hits get their own layer (after the marks, so they paint on top): redrawing marks never wipes them
      const fl = el("div", "findlayer"); div.appendChild(fl);
      host.appendChild(div);
      P.div = div; P.tl = tl; P.ov = ov; P.lk = lk; P.fl = fl;
      loadLinks(P, S.doc);
      sizePage(P);
    }
    $("pageTot").textContent = "of " + S.pages.length;
    drawAllMarks();
  }

  // Pages are whole CSS pixels. The browser snaps a canvas to whole CSS pixels when it draws it, so a page
  // 530.5px tall got its sharp bitmap stretched to 531 and resampled: blurry text at most zooms (any zoom
  // can land on a fraction; whole-number sizes at 100%, 200%... were why those looked fine).
  const pageW = (P) => Math.max(1, Math.round(P.w1 * S.scale)), pageH = (P) => Math.max(1, Math.round(P.h1 * S.scale));
  function sizePage(P) {
    P.div.style.width = pageW(P) + "px";
    P.div.style.height = pageH(P) + "px";
    P.div.style.setProperty("--scale-factor", S.scale);
    layoutFlags(P);
  }

  /* ---------------------------------------------------------------- rendering
     Every zoom re-renders the visible pages at (zoom × screen pixel density), so text stays sharp
     at any zoom. The old bitmap stays stretched in place until the new one is ready (no white flash). */
  // Rendering is throttled, not debounced: while you scroll it keeps drawing every ~80 ms instead of
  // waiting for the scroll to stop. Every page also keeps a small low-resolution copy ("thumb"), drawn in
  // the background, so a page is never blank while its sharp version is on the way.
  let renderPending = null, lastScrollTop = 0, scrollDir = 1;
  function scheduleRender(delay) {
    if (renderPending) return;
    renderPending = setTimeout(() => { renderPending = null; renderVisible(); }, delay || 0);
    scheduleThumbs();      // the low-res pass keeps going while you scroll (it used to die on the first scroll tick)
  }
  function cancelRender() { clearTimeout(renderPending); renderPending = null; clearTimeout(thumbT); thumbT = null; }

  async function renderVisible() {
    if (!S.pages.length || !visible) return;               // hidden reader: every page rect is 0x0, so nothing to aim at
    const gen = ++S.renderGen;
    const vEl = $("viewer"), v = vEl.getBoundingClientRect();
    if (vEl.scrollTop !== lastScrollTop) { scrollDir = vEl.scrollTop > lastScrollTop ? 1 : -1; lastScrollTop = vEl.scrollTop; }
    const want = [];
    for (const P of S.pages) {
      const r = P.div.getBoundingClientRect();
      const above = r.bottom < v.top, below = r.top > v.bottom;
      const dist = above ? v.top - r.bottom : below ? r.top - v.bottom : 0;
      // look further ahead in the direction of travel
      const reach = v.height * ((below && scrollDir > 0) || (above && scrollDir < 0) ? 2.5 : 1.2);
      if (dist <= reach) want.push({ P, dist, ov: Math.min(r.bottom, v.bottom) - Math.max(r.top, v.top) });
      else if (dist > v.height * 6) releasePage(P);         // keep memory bounded; the thumb stays
      else if (P.task) { try { P.task.cancel(); } catch (_) {} P.task = null; P.taskKey = null; }   // scrolled past: free the worker
    }
    want.sort((a, b) => a.dist - b.dist || b.ov - a.ov);   // on-screen pages first, the one filling most of the screen first
    const vis = want.filter((w) => w.dist === 0).map((w) => w.P), near = want.filter((w) => w.dist > 0).map((w) => w.P);
    near.forEach(dropDetail);
    // The pages on screen come first, so a light page never waits behind figure-heavy neighbours in the
    // single pdf.js worker: a quick low-res copy if it has none, then sharp, then its text (text extraction
    // shares that worker, so it never goes ahead of the pixels).
    for (const P of vis) if (!P.thumb) { await renderThumb(P); if (gen !== S.renderGen) return; }
    for (const P of vis) { await renderDetail(P); if (gen !== S.renderGen) return; }
    for (const P of vis) { await renderBase(P); ensureTextLayer(P); if (gen !== S.renderGen) return; }
    // then the neighbours: never blank (low-res copy), then sharp, then text
    for (const P of near) if (!P.thumb) { await renderThumb(P); if (gen !== S.renderGen) return; }
    for (const P of near) { await renderBase(P); ensureTextLayer(P); if (gen !== S.renderGen) return; }
    scheduleThumbs();
  }

  // low-res copies of the rest of the document, nearest first, one at a time; runs on its own (also while
  // you scroll), so pages ahead already have something to show when they arrive
  const THUMB_SCALE = 0.6, THUMB_MAX_PAGES = 160;
  let thumbT = null, thumbBusy = false;
  function scheduleThumbs() { if (thumbT || thumbBusy) return; thumbT = setTimeout(thumbStep, 0); }
  async function thumbStep() {
    thumbT = null;
    if (!S.pages.length || !visible) return;
    const cur = currentPage();
    const next = S.pages.filter((P) => P.div && !P.thumb && !P.thumbTask && Math.abs(P.n - cur) < THUMB_MAX_PAGES / 2)
      .sort((a, b) => Math.abs(a.n - cur) - Math.abs(b.n - cur))[0];
    if (!next) return;
    thumbBusy = true;
    try { await renderThumb(next); } finally { thumbBusy = false; }
    scheduleThumbs();                                      // thumbStep re-checks the document and visibility itself
  }
  async function renderThumb(P) {
    if (P.thumb || P.thumbTask) return P.thumbTask && P.thumbTask.promise.catch(() => {});
    if (!P.div) return;
    const div = P.div;
    const vp = P.page.getViewport({ scale: THUMB_SCALE });
    const c = el("canvas", "thumb");
    c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
    const task = P.page.render({ annotationMode: annMode(), canvasContext: c.getContext("2d", { alpha: false }), viewport: vp });
    P.thumbTask = task;
    try { await task.promise; } catch (_) { if (P.thumbTask === task) P.thumbTask = null; return; }
    if (P.thumbTask !== task || P.div !== div) return;
    P.thumbTask = null;
    P.thumb = c;
    P.div.insertBefore(c, P.div.querySelector("canvas") || P.tl);
  }

  function outScale(P) {
    const dpr = window.devicePixelRatio || 1;
    const want = S.scale * dpr;
    const area = P.w1 * P.h1;
    const capped = want * want * area > MAX_PX * 1.02;
    return { want, out: capped ? Math.sqrt(BASE_PX / area) : want, capped };
  }

  async function renderBase(P) {
    const { out, capped } = outScale(P);
    const key = out.toFixed(4);
    if (P.baseKey === key && P.canvas) return;
    if (P.task && P.taskKey === key) { try { await P.task.promise; } catch (_) {} return; }
    if (P.task) { try { P.task.cancel(); } catch (_) {} }
    const vp = P.page.getViewport({ scale: out });
    const c = el("canvas", "base");
    // one canvas pixel per screen pixel of the (whole-pixel) page; the drawing is stretched by the rounding
    // (under a pixel) so it fills the canvas exactly
    const dpr = window.devicePixelRatio || 1;
    c.width = capped ? Math.round(vp.width) : Math.round(pageW(P) * dpr); c.height = capped ? Math.round(vp.height) : Math.round(pageH(P) * dpr);
    const task = P.page.render({ annotationMode: annMode(), canvasContext: c.getContext("2d", { alpha: false }), viewport: vp, transform: [c.width / vp.width, 0, 0, c.height / vp.height, 0, 0] });
    P.task = task; P.taskKey = key;
    const div = P.div;
    // a failed render must not stay pinned as "in progress", or the page never sharpens again at this zoom
    try { await task.promise; } catch (_) { if (P.task === task) { P.task = null; P.taskKey = null; } return; }
    if (P.task !== task) return;
    P.task = null; P.taskKey = null;
    if (!P.div || P.div !== div) return;                   // the page's DOM was rebuilt meanwhile (document switch)
    if (P.canvas) P.canvas.replaceWith(c); else P.div.insertBefore(c, P.detail || P.tl);
    P.canvas = c; P.baseKey = key;
  }

  // Full-resolution render of just the visible part of a page, for zooms the base canvas can't reach.
  async function renderDetail(P) {
    const { want, capped } = outScale(P);
    if (!capped) { dropDetail(P); return; }
    const dpr = window.devicePixelRatio || 1;
    const v = $("viewer").getBoundingClientRect(), r = P.div.getBoundingClientRect();
    const vis = { x0: Math.max(0, v.left - r.left), y0: Math.max(0, v.top - r.top), x1: Math.min(r.width, v.right - r.left), y1: Math.min(r.height, v.bottom - r.top) };
    if (vis.x1 <= vis.x0 || vis.y1 <= vis.y0) return;
    // m = how close the view may get to a detail's edge before the next one starts (the old one stays up meanwhile)
    const covers = (D, m) => D && D.scale === S.scale && D.x0 <= vis.x0 && D.x1 >= vis.x1 &&
      D.y0 <= Math.max(0, vis.y0 - m) && D.y1 >= Math.min(r.height, vis.y1 + m);
    if (P.detail && covers(P.detailRect, P.detailRect.m)) return;
    // a render that will cover the view is already on its way: wait for it instead of restarting it
    // (restarting on every scroll tick meant none ever finished while you scrolled)
    if (P.dtask && covers(P.dpend, 0)) { try { await P.dtask.promise; } catch (_) {} return; }
    // pad one viewer height above and below (not this page's visible height, which is tiny for a page just
    // entering) and 20% sideways, within the pixel cap
    let py = v.height, px = (vis.x1 - vis.x0) * 0.2;
    let x0, y0, x1, y1;
    for (;;) {
      x0 = Math.max(0, vis.x0 - px); y0 = Math.max(0, vis.y0 - py); x1 = Math.min(r.width, vis.x1 + px); y1 = Math.min(r.height, vis.y1 + py);
      if ((x1 - x0) * (y1 - y0) * dpr * dpr <= MAX_PX || py < 1) break;
      py *= 0.7; px *= 0.7;
    }
    // whole CSS pixels of the page, like the page itself, so this canvas isn't resampled either
    x0 = Math.floor(x0); y0 = Math.floor(y0); x1 = Math.min(pageW(P), Math.ceil(x1)); y1 = Math.min(pageH(P), Math.ceil(y1));
    const k = r.width / pageW(P);                             // 1 unless a pinch preview is in progress
    if (Math.abs(k - 1) > 0.001) return;
    const c = el("canvas", "detail");
    c.width = Math.round((x1 - x0) * dpr); c.height = Math.round((y1 - y0) * dpr);
    if (P.dtask) { try { P.dtask.cancel(); } catch (_) {} }
    const vp = P.page.getViewport({ scale: want });
    const kx = (pageW(P) * dpr) / vp.width, ky = (pageH(P) * dpr) / vp.height;   // the page's rounding, as in renderBase
    const task = P.page.render({ annotationMode: annMode(), canvasContext: c.getContext("2d", { alpha: false }), viewport: vp, transform: [kx, 0, 0, ky, -x0 * dpr, -y0 * dpr] });
    P.dtask = task; P.dpend = { x0, y0, x1, y1, scale: S.scale, m: py * 0.4 };
    const sc = S.scale, div = P.div;
    try { await task.promise; } catch (_) { if (P.dtask === task) P.dtask = null; return; }
    if (P.dtask !== task) return;
    P.dtask = null;
    if (!P.div || P.div !== div || sc !== S.scale) return;
    const W = pageW(P), H = pageH(P);
    Object.assign(c.style, { left: (x0 / W) * 100 + "%", top: (y0 / H) * 100 + "%", width: ((x1 - x0) / W) * 100 + "%", height: ((y1 - y0) / H) * 100 + "%" });
    if (P.detail) P.detail.replaceWith(c); else P.div.insertBefore(c, P.tl);
    P.detail = c; P.detailRect = P.dpend;                   // P.dpend belongs to this render (P.dtask was still this task)
  }

  function dropDetail(P) {
    P.dpend = null;
    if (P.dtask) { try { P.dtask.cancel(); } catch (_) {} P.dtask = null; }
    if (P.detail) { P.detail.width = P.detail.height = 0; P.detail.remove(); P.detail = null; P.detailRect = null; }
  }
  // full = also drop the low-res copy (closing / switching documents)
  function releasePage(P, full) {
    if (P.task) { try { P.task.cancel(); } catch (_) {} P.task = null; P.taskKey = null; }
    if (P.canvas) { P.canvas.width = P.canvas.height = 0; P.canvas.remove(); P.canvas = null; }
    P.baseKey = null;
    dropDetail(P);
    if (full) {
      if (P.thumbTask) { try { P.thumbTask.cancel(); } catch (_) {} P.thumbTask = null; }
      if (P.thumb) { P.thumb.width = P.thumb.height = 0; P.thumb.remove(); P.thumb = null; }
    }
  }

  // Screen density changes (browser zoom, moving to another monitor): re-render at the new density.
  (function watchDpr() {
    const mq = matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
    mq.addEventListener("change", () => { scheduleRender(50); watchDpr(); }, { once: true });
  })();

  /* ---------------------------------------------------------------- zoom */
  const pct = (s) => Math.round(s * 100) + "%";
  function fitScale(mode) {
    const v = $("viewer"), P = S.pages[0];
    if (!P) return S.scale;
    const w = (v.clientWidth - 72) / P.w1;   // room for the margin flags on both sides
    const s = mode === "page" ? Math.min(w, (v.clientHeight - 40) / P.h1) : w;
    return clamp(s, ZMIN, ZMAX);
  }

  // Change the zoom while keeping the point under `anchor` (client coords; default: viewer centre) still.
  function setScale(s, anchor, fitMode) {
    s = clamp(s, ZMIN, ZMAX);
    S.fitMode = fitMode || null;
    if (!S.pages.length) { S.scale = s; return; }
    const v = $("viewer"), vr = v.getBoundingClientRect();
    const ax = anchor ? anchor.x : vr.left + vr.width / 2, ay = anchor ? anchor.y : vr.top + vr.height / 2;
    let P0 = S.pages[0], best = Infinity;
    for (const P of S.pages) {
      const r = P.div.getBoundingClientRect();
      const d = ay < r.top ? r.top - ay : ay > r.bottom ? ay - r.bottom : 0;
      if (d < best) { best = d; P0 = P; }
      if (d === 0) break;
    }
    const r0 = P0.div.getBoundingClientRect();
    const fx = (ax - r0.left) / r0.width, fy = (ay - r0.top) / r0.height;
    S.scale = s;
    S.pages.forEach(sizePage);
    const r1 = P0.div.getBoundingClientRect();
    v.scrollLeft += r1.left + fx * r1.width - ax;
    v.scrollTop += r1.top + fy * r1.height - ay;
    $("zoomVal").textContent = pct(s);
    scheduleRender(40);
    replaceComposer();
    saveView();
    updatePageInd();
  }
  function zoomStep(dir, anchor) {
    const cur = S.scale;
    const next = dir > 0 ? STEPS.find((z) => z > cur * 1.01) || ZMAX : [...STEPS].reverse().find((z) => z < cur / 1.01) || ZMIN;
    setScale(next, anchor);
  }
  function fit(mode) { setScale(fitScale(mode), null, mode); }

  $("zoomIn").onclick = () => zoomStep(1);
  $("zoomOut").onclick = () => zoomStep(-1);

  // zoom menu
  const menu = $("zoomMenu");
  function setMenu(open) { menu.hidden = !open; $("zoomVal").setAttribute("aria-expanded", String(open)); if (open) (menu.querySelector("button") || {}).focus?.(); }
  $("zoomVal").onclick = () => setMenu(menu.hidden);
  menu.addEventListener("click", (ev) => {
    const b = ev.target.closest("button"); if (!b) return;
    if (b.dataset.fit) fit(b.dataset.fit); else setScale(+b.dataset.z);
    setMenu(false);
  });
  document.addEventListener("pointerdown", (ev) => { if (!menu.hidden && !ev.target.closest(".zoomwrap")) setMenu(false); });

  // Pinch (trackpad), ⌘/Ctrl + scroll, and Safari gestures zoom the paper instead of the whole page.
  // While the gesture runs the pages are scaled with a cheap transform; when it ends they are re-rendered sharp.
  let G = null;
  function gesture(factor, cx, cy) {
    if (!S.pages.length) return;
    const pages = $("pages");
    if (!G) {
      const pr = pages.getBoundingClientRect();
      G = { k: 1, ax: cx, ay: cy, t: 0 };
      pages.style.transformOrigin = (cx - pr.left) + "px " + (cy - pr.top) + "px";
      pages.classList.add("zooming");
    }
    G.k = clamp(S.scale * G.k * factor, ZMIN, ZMAX) / S.scale;
    pages.style.transform = "scale(" + G.k + ")";
    $("zoomVal").textContent = pct(S.scale * G.k);
    replaceComposer();
    clearTimeout(G.t); G.t = setTimeout(endGesture, 180);
  }
  function endGesture() {
    if (!G) return;
    const g = G; G = null;
    const pages = $("pages");
    pages.style.transform = ""; pages.style.transformOrigin = ""; pages.classList.remove("zooming");
    setScale(S.scale * g.k, { x: g.ax, y: g.ay });
  }
  function anchorFor(ev) {
    const vr = $("viewer").getBoundingClientRect();
    const inside = ev.clientX >= vr.left && ev.clientX <= vr.right && ev.clientY >= vr.top && ev.clientY <= vr.bottom;
    return inside ? { x: ev.clientX, y: ev.clientY } : { x: vr.left + vr.width / 2, y: vr.top + vr.height / 2 };
  }
  window.addEventListener("wheel", (ev) => {
    if (!visible || !(ev.ctrlKey || ev.metaKey)) return;
    ev.preventDefault();
    let d = ev.deltaY * (ev.deltaMode === 1 ? 16 : ev.deltaMode === 2 ? 400 : 1);
    d = clamp(d, -60, 60);
    const a = G ? { x: G.ax, y: G.ay } : anchorFor(ev);
    gesture(Math.exp(-d * 0.0075), a.x, a.y);
  }, { passive: false });
  let gLast = 1;
  window.addEventListener("gesturestart", (ev) => { if (!visible) return; ev.preventDefault(); gLast = 1; }, { passive: false });
  window.addEventListener("gesturechange", (ev) => {
    if (!visible) return;
    ev.preventDefault();
    const a = G ? { x: G.ax, y: G.ay } : anchorFor(ev);
    gesture(ev.scale / gLast, a.x, a.y); gLast = ev.scale;
  }, { passive: false });
  window.addEventListener("gestureend", (ev) => { if (visible) ev.preventDefault(); }, { passive: false });

  let rT;
  window.addEventListener("resize", () => {
    clearTimeout(rT);
    rT = setTimeout(() => { if (!visible) return; if (S.fitMode) fit(S.fitMode); else scheduleRender(0); replaceComposer(); }, 120);
  });

  /* ---------------------------------------------------------------- page indicator and saved view */
  function currentPage() {
    const v = $("viewer");
    if (S.pages.length && v.scrollTop + v.clientHeight >= v.scrollHeight - 4) return S.pages.length;
    const mid = v.getBoundingClientRect().top + v.clientHeight * 0.35;
    let best = 1;
    for (const P of S.pages) { if (P.div && P.div.getBoundingClientRect().top <= mid) best = P.n; }
    return best;
  }
  function updatePageInd() {
    if (!S.pages.length || document.activeElement === $("pageIn")) return;
    $("pageIn").value = currentPage();
  }
  function goToPage(n, fy) {
    const P = S.pages[clamp(n, 1, S.pages.length) - 1]; if (!P) return;
    const v = $("viewer");
    v.scrollTop = P.div.offsetTop + (fy || 0) * P.div.offsetHeight - (fy ? v.clientHeight * 0.35 : 16);
  }
  $("pageIn").addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") { const n = parseInt(ev.target.value, 10); if (n) goToPage(n); ev.target.blur(); }
    else if (ev.key === "Escape") { ev.target.blur(); }
  });
  $("pageIn").addEventListener("focus", (ev) => ev.target.select());
  $("pageIn").addEventListener("blur", () => { $("pageIn").value = currentPage(); });

  const viewKey = () => api.lsKey("pm2:view:" + S.doc);
  // Saved (debounced) as you scroll and zoom; flushed whenever the document changes or the reader goes
  // away, while the outgoing paper is still laid out, so the last position is never lost.
  let vT = null;
  function writeView() {
    const v = $("viewer");
    if (!S.doc || !S.pages.length || !v.clientHeight) return;   // hidden reader: no layout to read
    const n = currentPage(), P = S.pages[n - 1];
    if (!P || !P.div) return;
    const fy = (v.scrollTop + v.clientHeight * 0.35 - P.div.offsetTop) / P.div.offsetHeight;
    try { localStorage.setItem(viewKey(), JSON.stringify({ scale: S.scale, fitMode: S.fitMode, page: n, fy })); } catch (_) {}
  }
  function saveView() { clearTimeout(vT); vT = setTimeout(() => { vT = null; writeView(); }, 250); }
  function flushView() { if (vT) { clearTimeout(vT); vT = null; writeView(); } }
  function restoreView() {
    let s = null;
    try { s = JSON.parse(localStorage.getItem(viewKey()) || "null"); } catch (_) {}
    if (s && s.fitMode) { S.fitMode = s.fitMode; S.scale = fitScale(s.fitMode); }
    else if (s && s.scale) { S.fitMode = null; S.scale = clamp(s.scale, ZMIN, ZMAX); }
    else {
      const dz = ((store.settings || {}).reader || {}).defaultZoom || "width";
      if (dz === "page") { S.fitMode = "page"; S.scale = fitScale("page"); }
      else if (/^\d+$/.test(dz)) { S.fitMode = null; S.scale = clamp(+dz / 100, ZMIN, ZMAX); }
      // the same rule as ⌘0, the zoom menu and every later refit, so the zoom never jumps on the first resize
      else { S.fitMode = "width"; S.scale = fitScale("width"); }
    }
    S.pages.forEach(sizePage);
    $("zoomVal").textContent = pct(S.scale);
    if (s && s.page) goToPage(s.page, s.fy); else $("viewer").scrollTop = 0;
    updatePageInd();
    scheduleRender(0);
  }

  $("viewer").addEventListener("scroll", () => {
    requestAnimationFrame(() => { updatePageInd(); replaceComposer(); });
    scheduleRender(80);
    saveView();
  }, { passive: true });

  /* ---------------------------------------------------------------- marks storage
     Server copy first, with revisions: a save made on an old revision gets a 409 and is merged
     (local edits by id on top of the server's marks), never last-writer-wins. */
  const lsKey = () => api.lsKey("pm2:marks:" + S.doc);
  let rev = 0, editGen = 0, dirtyIds = new Set(), deletedIds = new Set(), lsWarned = false;
  const stripCrops = (ms) => ms.map((m) => { const { cropData, ...r } = m; return r; });
  // marks imported from the PDF's own annotations replace them, so the PDF's copies aren't drawn as well
  const annMode = () => (S.marks.some((m) => m.imported) ? pdfjsLib.AnnotationMode.DISABLE : pdfjsLib.AnnotationMode.ENABLE_FORMS);
  function writeLocal(dirty) {
    try { localStorage.setItem(lsKey(), JSON.stringify({ dirty, baseRev: rev, marks: stripCrops(S.marks), dirtyIds: [...dirtyIds], deletedIds: [...deletedIds] })); }
    catch (_) { if (!lsWarned) { lsWarned = true; ui.toast("Couldn't keep a local backup. The server has the only copy.", { error: true }); } }
  }
  function mergeInto(serverMarks, localMarks, dirty, deleted) {
    const out = (serverMarks || []).filter((m) => !deleted.has(m.id));
    const at = new Map(out.map((m, i) => [m.id, i]));
    const added = [];
    for (const m of localMarks) if (dirty.has(m.id)) { if (at.has(m.id)) out[at.get(m.id)] = m; else { out.push(m); added.push(m); } }
    const used = new Set(out.filter((m) => !added.includes(m)).map((m) => m.num));
    let next = out.reduce((a, m) => Math.max(a, m.num || 0), 0);
    for (const m of added) { if (used.has(m.num)) m.num = ++next; used.add(m.num); }
    return out;
  }
  async function loadMarks() {
    const myDoc = S.doc, k = cur.key, a = cur.att;
    let server = null, err = null;
    try { server = await api.getMarks(k, a); } catch (e) { err = e; }
    if (S.doc !== myDoc) return;
    let local = null;
    try { local = JSON.parse(localStorage.getItem(lsKey()) || "null"); } catch (_) {}
    dirtyIds = new Set(); deletedIds = new Set(); editGen = 0;
    if (server) {
      rev = server.rev || 0;
      S.marks = server.marks || [];
      if (local && local.dirty && (local.dirtyIds || []).length + (local.deletedIds || []).length) {
        // edits that never reached the server: replay them on top of the server copy
        dirtyIds = new Set(local.dirtyIds || []); deletedIds = new Set(local.deletedIds || []);
        S.marks = mergeInto(S.marks, local.marks || [], dirtyIds, deletedIds);
        scheduleSave();
      } else setSave(server.savedAt ? "Saved " + hhmm(server.savedAt) : "", "ok");
    } else if (err && err.status >= 500) {
      S.marks = []; S.readOnly = true; setSave("The marks file can't be read, so nothing will be saved", "err");
    } else {
      S.marks = (local && local.marks) || []; rev = (local && local.baseRev) || 0;
      setSave("Server offline · kept in this browser", "err");
    }
    emitCounts();
  }
  function hhmm(iso) { return ui.timeShort(iso); }
  function setSave(t, cls) { const s = $("saveState"); s.textContent = t; s.className = "rd-save" + (cls ? " " + cls : ""); }
  function emitCounts() {
    if (!cur) return;
    const c = Object.assign(Object.create(null), { question: 0, remark: 0, explain: 0 });
    S.marks.forEach((m) => { if (typeof m.type === "string" && m.type) c[m.type] = (c[m.type] || 0) + 1; });
    c.total = S.marks.length;
    store.emit("marks-changed", { key: cur.key, att: cur.att, counts: c });
  }

  let sT = null;
  function scheduleSave() {
    if (S.readOnly) return;
    editGen++;
    writeLocal(true);
    setSave("Saving…");
    clearTimeout(sT); sT = setTimeout(() => save(false), 350);
  }
  function flushSave(keepalive) { if (sT) { clearTimeout(sT); sT = null; save(!!keepalive); } }
  async function save(keepalive) {
    clearTimeout(sT); sT = null;
    if (!cur || S.readOnly) return;
    const doc = S.doc, k = cur.key, a = cur.att, gen = editGen;
    try {
      const j = await api.saveMarks(k, a, keepalive ? stripCrops(S.marks) : S.marks, rev, false, { keepalive });
      if (doc !== S.doc) return;
      rev = j.rev;
      const byId = new Map((j.marks || []).map((m) => [m.id, m]));
      S.marks.forEach((m) => { const s = byId.get(m.id); if (s && s.crop) { m.crop = s.crop; delete m.cropData; } });
      if (gen === editGen) { dirtyIds.clear(); deletedIds.clear(); writeLocal(false); setSave("Saved " + hhmm(j.savedAt), "ok"); }
      else { writeLocal(true); clearTimeout(sT); sT = setTimeout(() => save(false), 350); }
      emitCounts();
      renderMarksPanel();
    } catch (e) {
      if (doc !== S.doc) return;
      if (e.conflict && e.payload) {
        rev = e.payload.rev || 0;
        S.marks = mergeInto(e.payload.marks || [], S.marks, dirtyIds, deletedIds);
        drawAllMarks(); renderMarksPanel();
        ui.toast("These marks were also changed in another window. Both sets of changes were kept.");
        clearTimeout(sT); sT = setTimeout(() => save(false), 50);
        return;
      }
      setSave("Not saved to disk · kept in this browser", "err");
    }
  }

  /* ---------------------------------------------------------------- drawing marks
     Positions are percentages of the page, so marks stay glued to the text at every zoom. */
  const pc = (f) => f * 100 + "%";
  function drawAllMarks() {
    S.pages.forEach((P) => { if (P.ov) P.ov.innerHTML = ""; });
    // reading order, so flags that share a line stack predictably
    [...S.marks].sort((a, b) => (a.page - b.page) || (a.y - b.y) || (a.num - b.num)).forEach(drawMark);
    S.pages.forEach(layoutFlags);
  }
  // Number flags live in the page margin beside the mark's first line (left margin for the left half
  // of the page, right margin for the right half), so they never cover the text.
  function placeFlag(P, r) {
    return { y: r.y + r.h / 2, side: r.x + r.w / 2 < 0.5 ? "l" : "r" };
  }
  // Lay a page's flags out in pixels for the current zoom: each sits level with its line, or just
  // below the flag above it on the same side, whichever is lower. Re-run whenever the page is resized.
  function layoutFlags(P) {
    if (!P.ov) return;
    const H = pageH(P);
    for (const side of ["l", "r"]) {
      const flags = [...P.ov.querySelectorAll(".badge--" + side)].sort((a, b) => a.dataset.fy - b.dataset.fy);
      let bottom = -Infinity;
      for (const f of flags) {
        const top = Math.max(f.dataset.fy * H - 7, bottom + 2);
        f.style.top = top + "px";
        bottom = top + 15;
      }
    }
  }
  function drawMark(m) {
    let first = true;
    // A text mark's pieces often overlap (selection rects of one line come out slightly offset). Each piece
    // is drawn solid inside one group per page that carries the wash's opacity, so overlaps composite once
    // (one even wash) instead of stacking into darker patches. The stored rects are not touched.
    const grp = {};
    for (const r of m.rects) {
      const P = S.pages[r.p - 1]; if (!P || !P.ov) continue;
      const d = el("div", (m.kind === "box" ? "box box--" : "hl hl--") + m.type + " " + mt.cls(m.type));
      d.dataset.id = m.id;
      Object.assign(d.style, { left: pc(r.x), top: pc(r.y), width: pc(r.w), height: pc(r.h) });
      if (m.kind === "box") P.ov.appendChild(d);
      else (grp[r.p] || (grp[r.p] = P.ov.appendChild(el("div", "hlgrp " + mt.cls(m.type))))).appendChild(d);
      if (first) {
        const b = el("button", "badge badge--" + m.type + " " + mt.cls(m.type), String(m.num));
        b.dataset.id = m.id;
        b.title = mt.get(m.type).name + " #" + m.num + (m.note ? ": " + m.note : "");
        b.setAttribute("aria-label", "Open " + mt.get(m.type).name + " " + m.num);
        const f = placeFlag(P, r);
        b.classList.add("badge--" + f.side);
        b.dataset.fy = f.y;
        b.onclick = (ev) => { ev.stopPropagation(); openEdit(m.id); };
        const hot = (on) => document.querySelectorAll('#view-reader .overlay [data-id="' + m.id + '"]').forEach((x) => x.classList.toggle("is-hot", on));
        b.onmouseenter = () => hot(true); b.onmouseleave = () => hot(false);
        P.ov.appendChild(b);
        first = false;
      }
    }
  }
  function flash(id) {
    document.querySelectorAll('.overlay [data-id="' + id + '"]').forEach((d) => { d.classList.remove("flash"); void d.offsetWidth; d.classList.add("flash"); });
  }

  /* ---------------------------------------------------------------- mark mode */
  function setMark(on) {
    if (on && S.pin) setPin(false);
    S.mark = on;
    if (on) $("banner").textContent = MARK_BANNER;
    hidePreview();
    $("markBtn").setAttribute("aria-pressed", String(on));
    $("toolSelect").setAttribute("aria-pressed", String(!on));
    $("banner").hidden = !on;
    document.body.classList.toggle("marking", on);
    if (!on) { if (!draftDirty()) closeComposer(); return; }
    // text already selected before turning Mark on: mark it right away
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && pageOf(sel.getRangeAt(0).startContainer)) openFromSelection(sel);
    else if (sel) sel.removeAllRanges();
  }
  function openFromSelection(sel) {
    const raw = clean(sel.toString()).trim();
    if (!raw) return false;
    const eq = looksLikeMath(raw), quote = tidyQuote(raw);
    const range = sel.getRangeAt(0);
    if (!pageOf(range.startContainer) && !pageOf(range.endContainer)) return false;
    const rects = normRects(range.getClientRects());
    if (!rects.length) return false;
    if (draftDirty()) { nudgeComposer(); return false; }
    openNew(eq ? { kind: "text", quote, rects, eq: true } : { kind: "text", quote, rects });
    return true;
  }
  $("markBtn").onclick = () => setMark(true);
  $("toolSelect").onclick = () => { setPin(false); setMark(false); };
  $("pinBtn").onclick = () => setPin(!S.pin);

  function pageOf(node) { const d = node && (node.nodeType === 1 ? node : node.parentElement); const p = d && d.closest(".page"); return p ? +p.dataset.n : 0; }

  function normRects(clientRects) {
    const out = [];
    for (const cr of clientRects) {
      if (cr.width < 1.5 || cr.height < 3) continue;
      if (S.pages[0] && cr.height > S.pages[0].h1 * S.scale * 0.05) continue;   // element boxes (page, endOfContent), not text lines
      const cx = cr.left + cr.width / 2, cy = cr.top + cr.height / 2;
      const P = S.pages.find((p) => { const b = p.div.getBoundingClientRect(); return cx >= b.left && cx <= b.right && cy >= b.top && cy <= b.bottom; });
      if (!P) continue;
      const b = P.div.getBoundingClientRect();
      out.push({ p: P.n, x: (cr.left - b.left) / b.width, y: (cr.top - b.top) / b.height, w: cr.width / b.width, h: cr.height / b.height });
    }
    // merge pieces on the same line
    out.sort((a, b) => a.p - b.p || a.y - b.y || a.x - b.x);
    const m = [];
    for (const r of out) {
      const L = m[m.length - 1];
      if (L && L.p === r.p && Math.abs(L.y - r.y) < 0.004 && Math.abs(L.h - r.h) < 0.006 && r.x <= L.x + L.w + 0.012 && !(L.x + L.w < 0.5 && r.x > 0.5)) {
        const x2 = Math.max(L.x + L.w, r.x + r.w); L.x = Math.min(L.x, r.x); L.w = x2 - L.x;
        const y2 = Math.max(L.y + L.h, r.y + r.h); L.y = Math.min(L.y, r.y); L.h = y2 - L.y;
      } else m.push({ ...r });
    }
    return m;
  }

  // the picture of an older equation mark that was saved without one: drawn from the PDF, kept for this session
  function markPicture(m) {
    const k = (cur ? cur.key + "/" + cur.att + "/" : "") + m.id;
    if (!liveCrops.has(k)) liveCrops.set(k, makeCrop(m.rects).catch(() => null).then((d) => { if (!d) liveCrops.delete(k); return d; }));
    return liveCrops.get(k);
  }

  // PNG of the marked region, rendered straight from the PDF (sharp whatever the zoom, even if the page is off screen)
  async function makeCrop(rects) {
    const p = rects[0].p, P = S.pages[p - 1];
    if (!P) return null;
    const rs = rects.filter((r) => r.p === p);
    let x0 = Math.min(...rs.map((r) => r.x)), y0 = Math.min(...rs.map((r) => r.y));
    let x1 = Math.max(...rs.map((r) => r.x + r.w)), y1 = Math.max(...rs.map((r) => r.y + r.h));
    const pad = 0.008; x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad); x1 = Math.min(1, x1 + pad); y1 = Math.min(1, y1 + pad);
    const k = Math.min(4, 1600 / Math.max(1, (x1 - x0) * P.w1));
    const vp = P.page.getViewport({ scale: k });
    const sx = x0 * vp.width, sy = y0 * vp.height, sw = (x1 - x0) * vp.width, sh = (y1 - y0) * vp.height;
    if (sw < 4 || sh < 4) return null;
    const c = document.createElement("canvas"); c.width = Math.round(sw); c.height = Math.round(sh);
    try {
      await P.page.render({ annotationMode: annMode(), canvasContext: c.getContext("2d"), viewport: vp, transform: [1, 0, 0, 1, -sx, -sy] }).promise;
      return c.toDataURL("image/png");
    } catch (_) { return null; }
  }

  function contextOf(p, quote) {
    const P = S.pages[p - 1]; if (!P) return "";
    const t = (P.text || "").replace(/\s+/g, " "), q = (quote || "").replace(/\s+/g, " ").trim();
    const i = q ? t.indexOf(q.slice(0, 60)) : -1;
    if (i < 0) return "";
    return t.slice(Math.max(0, i - 250), Math.min(t.length, i + q.length + 250));
  }

  // pdf.js trick: while dragging a selection, stretch endOfContent over the page so the
  // selection doesn't jump to the whole page when the pointer crosses a gap between lines
  $("pages").addEventListener("pointerdown", (ev) => {
    const tl = ev.target.closest && ev.target.closest(".textLayer");
    if (tl) { const e = tl.querySelector(".endOfContent"); if (e) e.classList.add("active"); root.classList.add("selecting"); }
  });
  document.addEventListener("pointerup", () => { root.classList.remove("selecting"); root.querySelectorAll(".endOfContent.active").forEach((e) => e.classList.remove("active")); });

  // text selection -> composer
  document.addEventListener("mouseup", (ev) => {
    if (!visible || !S.mark || drag || ev.target.closest(".composer, .panel, .toolbar")) return;
    setTimeout(() => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) return;
      openFromSelection(sel);
    }, 0);
  });

  // box drag
  let drag = null;
  $("pages").addEventListener("pointerdown", (ev) => {
    if (!(S.mark || S.pin) || ev.button !== 0) return;
    if (ev.target.closest(".badge")) return;
    const pageEl = ev.target.closest(".page"); if (!pageEl) return;
    const onText = ev.target.tagName === "SPAN" && ev.target.closest(".textLayer");
    if (onText && !ev.shiftKey && !S.pin) return;            // normal text selection
    if (S.mark && draftDirty()) { nudgeComposer(); return; }
    ev.preventDefault();
    window.getSelection().removeAllRanges();
    const b = pageEl.getBoundingClientRect();
    const d = el("div", "drawbox"); pageEl.appendChild(d);
    drag = { pageEl, b, x0: ev.clientX - b.left, y0: ev.clientY - b.top, d, moved: false };
    pageEl.setPointerCapture(ev.pointerId);
  });
  $("pages").addEventListener("pointermove", (ev) => {
    if (!drag) return;
    const x = Math.max(0, Math.min(drag.b.width, ev.clientX - drag.b.left)), y = Math.max(0, Math.min(drag.b.height, ev.clientY - drag.b.top));
    const l = Math.min(x, drag.x0), t = Math.min(y, drag.y0), w = Math.abs(x - drag.x0), h = Math.abs(y - drag.y0);
    Object.assign(drag.d.style, { left: l + "px", top: t + "px", width: w + "px", height: h + "px" });
    drag.r = { l, t, w, h }; if (w > 4 || h > 4) drag.moved = true;
  });
  function endDrag() {
    if (!drag) return;
    const D = drag; drag = null; D.d.remove();
    if (!D.r || D.r.w < 12 || D.r.h < 10) return;
    const n = +D.pageEl.dataset.n;
    const rects = [{ p: n, x: D.r.l / D.b.width, y: D.r.t / D.b.height, w: D.r.w / D.b.width, h: D.r.h / D.b.height }];
    if (S.pin) { addPin(rects); setPin(false); return; }
    // text that falls inside the box, for context
    const P = S.pages[n - 1];
    const inside = [...P.tl.querySelectorAll("span")].filter((s) => {
      const r = s.getBoundingClientRect(), cx = r.left + r.width / 2 - D.b.left, cy = r.top + r.height / 2 - D.b.top;
      return cx >= D.r.l && cx <= D.r.l + D.r.w && cy >= D.r.t && cy <= D.r.t + D.r.h;
    }).map((s) => clean(s.textContent)).join(" ").replace(/\s+/g, " ").trim();
    openNew({ kind: "box", quote: inside, rects });
  }
  $("pages").addEventListener("pointerup", endDrag);
  $("pages").addEventListener("pointercancel", () => { if (drag) { drag.d.remove(); drag = null; } });

  /* ---------------------------------------------------------------- pins
     A figure or a piece of text kept at the side while you scroll. Saved per PDF on this device. */
  const MARK_BANNER = $("banner").textContent;
  const PIN_BANNER = "Drag a box over a figure or text to pin it at the side. Esc returns to Select.";
  const pinKey = () => api.lsKey("pm2:pins:" + S.doc);
  const pinCrops = new Map();
  let pins = [];
  function setPin(on) {
    if (on && S.mark) setMark(false);
    S.pin = on;
    hidePreview(); hideSelTb();
    $("pinBtn").setAttribute("aria-pressed", String(on));
    $("toolSelect").setAttribute("aria-pressed", String(!on && !S.mark));
    if (on) $("banner").textContent = PIN_BANNER;
    $("banner").hidden = !on && !S.mark;
    document.body.classList.toggle("marking", on || S.mark);
  }
  function loadPins() {
    pins = [];
    try { pins = JSON.parse(localStorage.getItem(pinKey()) || "[]"); } catch (_) {}
    renderPins();
  }
  function savePins() { try { localStorage.setItem(pinKey(), JSON.stringify(pins)); } catch (_) {} }
  function addPin(rects) {
    if (!rects.length || !S.pages.length) return;
    pins.push({ id: Date.now().toString(36), rects });
    savePins(); renderPins();
    setTimeout(() => { const l = $("pinList"); l.scrollTop = l.scrollHeight; }, 0);
  }
  function pinSelection() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !pageOf(sel.getRangeAt(0).startContainer)) return false;
    const rects = normRects(sel.getRangeAt(0).getClientRects());
    if (!rects.length) return false;
    sel.removeAllRanges(); hideSelTb();
    addPin(rects);
    return true;
  }
  function pinCrop(pn) {
    const k = S.doc + "/" + pn.id;
    if (!pinCrops.has(k)) pinCrops.set(k, makeCrop(pn.rects).catch(() => null));
    return pinCrops.get(k);
  }
  function renderPins() {
    const list = $("pinList"), was = !$("pins").hidden;
    list.textContent = "";
    $("pins").hidden = !pins.length;
    for (const pn of pins) {
      const r = pn.rects[0];
      const card = el("div", "pin"), head = el("div", "pin__head");
      const go = el("button", "pin__page", "p. " + r.p);
      go.title = "Go to this spot";
      go.onclick = () => goToPage(r.p, r.y);
      const x = el("button", "ibtn pin__x");
      x.append(ui.icon("x")); x.title = "Unpin"; x.setAttribute("aria-label", "Unpin");
      x.onclick = () => { pins = pins.filter((q) => q !== pn); pinCrops.delete(S.doc + "/" + pn.id); savePins(); renderPins(); };
      head.append(go, el("span", "grow"), x);
      const img = el("img", "pin__img"); img.alt = "Pinned from page " + r.p;
      if (S.pages.length) pinCrop(pn).then((d) => { if (d) img.src = d; else img.replaceWith(el("p", "pin__err", "Couldn't draw this part of the page.")); });
      card.append(head, img);
      list.append(card);
    }
    if (was === !pins.length) refitSoon();
  }
  function refitSoon() { setTimeout(() => { if (!visible || !S.pages.length) return; if (S.fitMode) fit(S.fitMode); else scheduleRender(0); replaceComposer(); }, 0); }
  try { const w = +localStorage.getItem("pm2:pinw"); if (w) $("pins").style.width = w + "px"; } catch (_) {}
  $("pinGrip").addEventListener("pointerdown", (ev) => {
    ev.preventDefault();
    const box = $("pins"), x0 = ev.clientX, w0 = box.offsetWidth, max = box.parentElement.clientWidth * 0.6;
    const move = (e) => { box.style.width = clamp(w0 + x0 - e.clientX, 180, max) + "px"; };
    const up = () => {
      document.removeEventListener("pointermove", move); document.removeEventListener("pointerup", up);
      try { localStorage.setItem("pm2:pinw", String(box.offsetWidth)); } catch (_) {}
      refitSoon();
    };
    document.addEventListener("pointermove", move); document.addEventListener("pointerup", up);
  });

  /* ---------------------------------------------------------------- composer
     The composer is pinned to its mark: it follows the page when you scroll or zoom. */
  function openNew(base) {
    S.editing = null;
    const draft = { ...base, type: S.lastType, note: "", suggest: "", cropData: undefined };
    draft.cropP = makeCrop(base.rects).then((d) => {
      draft.cropData = d || undefined;
      if (S.draft === draft && (draft.kind === "box" || draft.eq) && d) { $("cmpCrop").src = d; $("cmpCrop").hidden = false; replaceComposer(); }
      return d;
    });
    S.draft = draft;
    fillComposer(draft, false);
    anchorTo(base.rects);
  }
  function openEdit(id) {
    const m = S.marks.find((x) => x.id === id); if (!m) return;
    if (S.editing === id && !$("composer").hidden) { flash(id); return; }
    if (draftDirty()) { nudgeComposer(); return; }
    S.editing = id;
    S.draft = { ...m };
    fillComposer(S.draft, true);
    anchorTo(m.rects);
    flash(id);
  }
  function fillComposer(d, isEdit) {
    $("cmpTitle").textContent = "p. " + d.rects[0].p;
    $("cmpKind").textContent = d.kind === "box" ? "area" : "text";
    $("cmpNum").hidden = !isEdit; if (isEdit) $("cmpNum").textContent = "#" + d.num;
    const eq = isEq(d), pic = d.kind === "box" || eq;
    $("cmpQuote").textContent = d.kind === "box" ? (d.quote || "(region, no selectable text)") : tidyQuote(d.quote);
    $("cmpQuote").hidden = eq || (!d.quote && d.kind !== "box");
    const src = d.cropData || (d.crop && cur ? api.cropUrl(cur.key, d.crop) : "");
    $("cmpCrop").hidden = !(pic && src); if (pic && src) $("cmpCrop").src = src;
    if (eq && !src && isEdit) markPicture(d).then((img) => {
      if (S.draft === d && img) { $("cmpCrop").src = img; $("cmpCrop").hidden = false; replaceComposer(); }
      else if (S.draft === d) { $("cmpQuote").hidden = false; }   // no picture: fall back to the text
    });
    $("noteIn").value = d.note || ""; $("suggestIn").value = d.suggest || "";
    $("cmpDelete").hidden = !isEdit;
    delete $("cmpDelete").dataset.armed; $("cmpDelete").textContent = "Delete";
    if (!isEdit && !mt.visible().some((t) => t.id === d.type)) d.type = (mt.visible()[0] || { id: "question" }).id;
    renderPicker(d.type);
    setType(d.type);
    $("composer").hidden = false;
    setTimeout(() => $("noteIn").focus({ preventScroll: true }), 0);
  }
  // the types offered in the composer: every visible type, plus the mark's own type if it's hidden
  function pickTypes(cur) {
    const v = mt.visible();
    return cur && !v.some((t) => t.id === cur) ? [...v, mt.get(cur)] : v;
  }
  function renderPicker(curType) {
    const box = $("seg");
    box.textContent = "";
    pickTypes(curType).forEach((t, i) => {
      const b = el("button", "tpick__opt " + mt.cls(t.id), t.name);
      b.type = "button";
      b.dataset.type = t.id;
      b.setAttribute("role", "radio");
      b.title = t.name + (i < 9 ? `  (⌃${i + 1})` : "");
      b.onclick = () => { setType(t.id); $("noteIn").focus(); };
      box.appendChild(b);
    });
    const edit = el("button", "tpick__edit", "Edit types…");
    edit.type = "button";
    edit.onclick = async () => {
      const keep = S.draft && S.draft.type;
      await mt.openEditor({ select: keep });
      if (!$("composer").hidden) setTimeout(() => $("noteIn").focus({ preventScroll: true }), 0);
    };
    box.appendChild(edit);
  }
  $("seg").addEventListener("keydown", (ev) => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(ev.key)) return;
    const opts = [...$("seg").querySelectorAll(".tpick__opt")];
    const i = opts.findIndex((b) => b.getAttribute("aria-checked") === "true");
    const j = (i + (ev.key === "ArrowLeft" || ev.key === "ArrowUp" ? -1 : 1) + opts.length) % opts.length;
    if (!opts[j]) return;
    ev.preventDefault(); setType(opts[j].dataset.type); opts[j].focus();
  });
  function setType(t) {
    if (!S.draft) return;
    S.draft.type = t;
    if (![...$("seg").querySelectorAll(".tpick__opt")].some((b) => b.dataset.type === t)) renderPicker(t);
    $("seg").querySelectorAll(".tpick__opt").forEach((b) => { const on = b.dataset.type === t; b.setAttribute("aria-checked", String(on)); b.tabIndex = on ? 0 : -1; });
    const T = mt.get(t);
    $("segHint").textContent = T.purpose || "";
    $("segHint").hidden = !T.purpose;
    $("noteLbl").textContent = T.noteLabel || "Note";
    $("noteIn").placeholder = T.placeholder || "";
    $("suggestWrap").hidden = !T.suggest;
    replaceComposer();
  }
  store.on("marktypes", () => {
    if (S.draft && !$("composer").hidden) { renderPicker(S.draft.type); setType(S.draft.type); }
    drawAllMarks(); renderMarksPanel();
  });

  // Has the open composer got typed text (or a changed type) that would be lost?
  function draftDirty() {
    if ($("composer").hidden || !S.draft) return false;
    const note = $("noteIn").value.trim(), sug = $("suggestIn").value.trim();
    if (S.editing) {
      const m = S.marks.find((x) => x.id === S.editing) || {};
      return note !== (m.note || "") || sug !== (m.suggest || "") || S.draft.type !== m.type;
    }
    return !!(note || sug);
  }
  function nudgeComposer() {
    const c = $("composer");
    c.classList.remove("nudge"); void c.offsetWidth; c.classList.add("nudge");
    toast("Save or cancel the open note first");
    $("noteIn").focus({ preventScroll: true });
  }

  let anchorRef = null;           // { p, x0, y0, x1, y1 } as page fractions
  function anchorTo(rects) {
    const p = rects[0].p, rs = rects.filter((r) => r.p === p);
    anchorRef = { p, x0: Math.min(...rs.map((r) => r.x)), y0: Math.min(...rs.map((r) => r.y)), x1: Math.max(...rs.map((r) => r.x + r.w)), y1: Math.max(...rs.map((r) => r.y + r.h)) };
    replaceComposer();
  }
  function replaceComposer() {
    const c = $("composer");
    if (c.hidden || !anchorRef) return;
    const P = S.pages[anchorRef.p - 1];
    let a;
    if (P && P.div) {
      const b = P.div.getBoundingClientRect();
      a = { left: b.left + anchorRef.x0 * b.width, right: b.left + anchorRef.x1 * b.width, top: b.top + anchorRef.y0 * b.height, bottom: b.top + anchorRef.y1 * b.height };
    } else a = { left: innerWidth / 2 - 210, right: innerWidth / 2 + 210, top: 120, bottom: 140 };
    const w = c.offsetWidth, h = c.offsetHeight, m = 12;
    const left = clamp((a.left + a.right) / 2 - w / 2, m, innerWidth - w - m);
    let top = a.bottom + 10;
    if (top + h > innerHeight - m && a.top - h - 10 >= m) top = a.top - h - 10;
    top = clamp(top, m, Math.max(m, innerHeight - h - m));
    c.style.left = left + "px"; c.style.top = top + "px";
  }
  function closeComposer() {
    const was = !$("composer").hidden;
    $("composer").hidden = true; S.draft = null; S.editing = null; anchorRef = null;
    if (was) { const s = window.getSelection(); if (s) s.removeAllRanges(); }
  }

  /* undo/redo of marks: each entry only applies to the PDF it was made on */
  const cloneMark = (m) => { const { cropData, ...r } = m; return JSON.parse(JSON.stringify(r)); };
  function putMark(m) {
    const i = S.marks.findIndex((x) => x.id === m.id);
    if (i >= 0) S.marks[i] = cloneMark(m); else S.marks.push(cloneMark(m));
    deletedIds.delete(m.id); dirtyIds.add(m.id);
  }
  function dropMark(id) { S.marks = S.marks.filter((x) => x.id !== id); deletedIds.add(id); dirtyIds.delete(id); }
  function onDoc(doc, title, fn) {
    return async () => {
      if (S.doc !== doc) throw new Error(`open “${title}” to change its marks`);
      // undo/redo would close the composer: never throw away a note that is still being typed
      // (undo.js puts the entry back on its stack and shows this message)
      if (draftDirty()) { nudgeComposer(); throw new Error("save or cancel the open note first"); }
      fn(); closeComposer(); drawAllMarks(); renderMarksPanel(); scheduleSave();
    };
  }
  function recordMark(label, undoFn, redoFn) {
    if (!cur) return;
    const doc = S.doc, title = ui.shortTitle((store.item(cur.key) || {}).title || cur.key, 40);
    undoLog.record({ label, undo: onDoc(doc, title, undoFn), redo: onDoc(doc, title, redoFn) });
  }
  function commit() {
    const d = S.draft; if (!d) return;
    d.note = $("noteIn").value.trim(); d.suggest = $("suggestIn").value.trim();   // kept even if the final type doesn't ask for it: never drop typed text
    if (S.editing) {
      const i = S.marks.findIndex((x) => x.id === S.editing);
      if (i >= 0) {
        const before = cloneMark(S.marks[i]);
        S.marks[i] = { ...S.marks[i], type: d.type, note: d.note, suggest: d.suggest, updated: new Date().toISOString() }; dirtyIds.add(S.marks[i].id);
        const after = cloneMark(S.marks[i]);
        recordMark(`the edit to mark #${after.num}`, () => putMark(before), () => putMark(after));
      }
    } else {
      const num = S.marks.reduce((a, m) => Math.max(a, m.num || 0), 0) + 1;
      const id = "m" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const r0 = d.rects[0];
      const m = { id, num, type: d.type, kind: d.kind, page: r0.p, y: r0.y, quote: d.quote, note: d.note, suggest: d.suggest,
        context: contextOf(r0.p, d.quote), rects: d.rects, cropData: d.cropData || undefined, created: new Date().toISOString() };
      if (d.eq) m.eq = true;
      S.marks.push(m); dirtyIds.add(m.id);
      let snap = null;
      recordMark(`mark #${num}`, () => { const cur_ = S.marks.find((x) => x.id === id); snap = cur_ ? cloneMark(cur_) : snap; dropMark(id); }, () => putMark(snap || m));
      // the crop usually finishes before you've typed anything; if not, it is saved when it lands
      if (!m.cropData && d.cropP) d.cropP.then((img) => { if (img && S.marks.includes(m) && !m.crop) { m.cropData = img; dirtyIds.add(m.id); scheduleSave(); } });
      toast(mt.get(d.type).name + " #" + num + " saved");
    }
    S.lastType = d.type; try { localStorage.setItem(api.lsKey("pm2:lastType"), d.type); } catch (_) {}
    window.getSelection().removeAllRanges();
    closeComposer(); drawAllMarks(); renderMarksPanel(); scheduleSave();
  }
  function del(id) {
    const gone = S.marks.find((m) => m.id === id);
    if (gone) { const copy = cloneMark(gone); recordMark(`deleting mark #${copy.num}`, () => putMark(copy), () => dropMark(id)); }
    S.marks = S.marks.filter((m) => m.id !== id);
    deletedIds.add(id); dirtyIds.delete(id);
    S.confirmDel = null;
    closeComposer(); drawAllMarks(); renderMarksPanel(); scheduleSave();
    toast("Mark deleted. ⌘Z brings it back.");
  }
  $("cmpSave").onclick = commit;
  $("cmpCancel").onclick = () => { closeComposer(); };
  $("cmpDelete").onclick = () => {
    if (!S.editing) return;
    const b = $("cmpDelete");
    if (b.dataset.armed || ((store.settings || {}).marks || {}).confirmDelete === false) { del(S.editing); return; }
    b.dataset.armed = "1"; b.textContent = "Really delete?";
    setTimeout(() => { delete b.dataset.armed; b.textContent = "Delete"; }, 2500);
  };

  /* ---------------------------------------------------------------- side panel: marks list */
  function renderMarksPanel() {
    $("notesCount").textContent = S.marks.length;
    $("tabMarksCount").textContent = S.marks.length;
    const total = S.marks.length;
    const counts = Object.create(null);
    S.marks.forEach((m) => { counts[m.type] = (counts[m.type] || 0) + 1; });
    // filter tabs: All, then each type that has marks here (registry order, then any unknown types)
    const order = mt.all().map((t) => t.id).filter((id) => counts[id]);
    Object.keys(counts).forEach((id) => { if (!order.includes(id)) order.push(id); });
    if (S.filter !== "all" && !counts[S.filter]) S.filter = "all";
    const f = $("filters"); f.innerHTML = "";
    [["all", "All"], ...order.map((id) => [id, mt.get(id).name])].forEach(([k, lab]) => {
      const b = el("button", "fchip" + (k === "all" ? "" : " " + mt.cls(k))); b.setAttribute("role", "tab"); b.setAttribute("aria-selected", String(S.filter === k));
      b.appendChild(document.createTextNode(lab)); b.appendChild(el("b", "num", String(k === "all" ? total : counts[k] || 0)));
      b.onclick = () => { S.filter = k; renderMarksPanel(); };
      f.appendChild(b);
    });
    const ed = el("button", "fchip fchip--edit", "Types…");
    ed.title = "Add or change mark types";
    ed.onclick = () => mt.openEditor({ select: S.filter !== "all" ? S.filter : undefined });
    f.appendChild(ed);
    const q = S.query.toLowerCase();
    const shown = S.marks.filter((m) => (S.filter === "all" || m.type === S.filter) &&
      (!q || [m.quote, m.note, m.suggest].join(" ").toLowerCase().includes(q)))
      .sort((a, b) => a.page - b.page || a.y - b.y);
    const L = $("list"); const keep = L.scrollTop; L.innerHTML = "";
    if (!S.marks.length) {
      const e = el("div", "empty"); e.appendChild(el("b", null, "No marks yet"));
      e.appendChild(document.createTextNode("Switch to Annotate (the ` key), then select text or drag a box over an equation or figure."));
      L.appendChild(e); return;
    }
    if (!shown.length) { L.appendChild(el("div", "empty", "Nothing matches this filter.")); return; }
    let pg = 0;
    for (const m of shown) {
      if (m.page !== pg) {
        pg = m.page; const h = el("div", "pgh"); h.appendChild(el("span", null, "Page " + pg));
        h.appendChild(el("span", null, String(shown.filter((x) => x.page === pg).length))); L.appendChild(h);
      }
      const T = mt.get(m.type);
      const c = el("div", "card card--" + m.type + " " + mt.cls(m.type)); c.tabIndex = 0; c.setAttribute("role", "button");
      c.dataset.card = m.id;
      if (S.editing === m.id) c.classList.add("is-open");
      c.setAttribute("aria-label", T.name + " " + m.num + " on page " + m.page);
      const top = el("div", "card__top");
      top.appendChild(el("span", "card__num num", String(m.num)));
      top.appendChild(el("span", "tlabel", T.name));
      if (m.kind === "box") top.appendChild(el("span", "card__kind", "area"));
      const dl = el("button", "card__del"); dl.title = "Delete"; dl.setAttribute("aria-label", "Delete mark " + m.num); dl.append(ui.icon("trash"));
      dl.onclick = (ev) => { ev.stopPropagation(); if (((store.settings || {}).marks || {}).confirmDelete === false) { del(m.id); return; } S.confirmDel = m.id; renderMarksPanel(); };
      top.appendChild(dl); c.appendChild(top);
      const eq = isEq(m);
      if (m.quote && !eq) c.appendChild(el("p", "card__quote", "“" + (m.kind === "box" ? m.quote : tidyQuote(m.quote)) + "”"));
      if ((m.kind === "box" || eq) && (m.crop || m.cropData)) { const im = el("img", "card__img"); im.alt = eq ? "Marked equation" : "Marked region"; im.src = m.cropData || api.cropUrl(cur.key, m.crop); c.appendChild(im); }
      else if (eq) {
        const im = el("img", "card__img"); im.alt = "Marked equation"; im.hidden = true; c.appendChild(im);
        markPicture(m).then((img) => { if (img) { im.src = img; im.hidden = false; } else im.replaceWith(el("p", "card__quote", "“" + tidyQuote(m.quote) + "”")); });
      }
      if (m.note) c.appendChild(el("p", "card__note", m.note));
      if (m.suggest) c.appendChild(el("p", "card__sug", m.suggest));
      if (m.type === "cite" && cur) {
        const cite = "\\cite[p.~" + m.page + "]{" + cur.key + "}";
        const cb = el("button", "card__act", "Copy " + cite);
        cb.onclick = async (ev) => { ev.stopPropagation(); ui.toast((await ui.copyText(cite)) ? "Copied " + cite : "Couldn't copy.", {}); };
        c.appendChild(cb);
      }
      if (S.confirmDel === m.id) {
        const cf = el("div", "confirm"); cf.appendChild(el("span", null, "Delete this mark?"));
        const y = el("button", null, "Delete"), n = el("button", null, "Keep");
        y.onclick = (ev) => { ev.stopPropagation(); del(m.id); }; n.onclick = (ev) => { ev.stopPropagation(); S.confirmDel = null; renderMarksPanel(); };
        cf.append(y, n); c.appendChild(cf);
      }
      const go = () => jumpTo(m);
      c.onclick = go; c.onkeydown = (ev) => { if (ev.target !== c) return; if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); go(); } };
      L.appendChild(c);
    }
    L.scrollTop = keep;
  }
  $("search").addEventListener("input", (e) => { S.query = e.target.value; renderMarksPanel(); });

  // Settings > Reader > "Smooth scrolling when jumping to a mark" (also used for link jumps and Back)
  const scrollBehavior = () => (((store.settings || {}).reader || {}).smoothScroll === false ? "auto" : "smooth");
  function jumpTo(m, instant) {
    const P = S.pages[m.page - 1]; if (!P || !P.div) return;
    if (draftDirty() && S.editing !== m.id) { nudgeComposer(); return; }
    const v = $("viewer"), r = m.rects[0];
    v.scrollTo({ top: P.div.offsetTop + r.y * P.div.offsetHeight - v.clientHeight * 0.3, left: Math.max(0, P.div.offsetLeft + r.x * P.div.offsetWidth - v.clientWidth * 0.3), behavior: instant ? "auto" : scrollBehavior() });
    openEdit(m.id);        // pinned to the mark, so it rides along with the scroll
  }

  /* ---------------------------------------------------------------- side panel: tabs and visibility */
  function setTab(t) {
    S.tab = t;
    $("tabMarks").setAttribute("aria-selected", String(t === "marks"));
    $("tabNotes").setAttribute("aria-selected", String(t === "notes"));
    $("viewMarks").hidden = t !== "marks";
    $("viewNotes").hidden = t !== "notes";
    syncPills();
    try { localStorage.setItem("pm2:rdtab", t); } catch (_) {}
  }
  function syncPills() {
    const open = !$("panel").hidden;
    $("marksBtn").setAttribute("aria-pressed", String(open));
    $("notesBtn").setAttribute("aria-pressed", String(open && S.tab === "notes"));
  }
  function setPanel(open, remember) {
    const changed = $("panel").hidden === !!open;
    $("panel").hidden = !open;
    syncPills();
    if (remember !== false) { try { localStorage.setItem("pm2:rdpanel", open ? "1" : "0"); } catch (_) {} }
    // refit only when the viewer's width actually changed: a refit writes scrollTop, which cancels a
    // smooth scroll that is under way (a ⌘K jump to a mark used to stop dead on page 1)
    if (changed) { if (S.fitMode) setTimeout(() => fit(S.fitMode), 0); else scheduleRender(0); }
    setTimeout(replaceComposer, 0);
  }
  // pill: show that tab, or hide the panel if that tab is already showing
  function togglePanelTab(t) {
    if (!$("panel").hidden && S.tab === t) { setPanel(false); return; }
    setTab(t);
    if ($("panel").hidden) setPanel(true);
    if (t === "notes") setTimeout(() => $("gnText").focus(), 0);
  }
  $("tabMarks").onclick = () => setTab("marks");
  $("tabNotes").onclick = () => { setTab("notes"); $("gnText").focus(); };
  $("marksBtn").onclick = () => setPanel($("panel").hidden);
  $("notesBtn").onclick = () => togglePanelTab("notes");
  $("panelClose").onclick = () => setPanel(false);

  /* ---------------------------------------------------------------- paper notes (notes.md, shared by all versions) */
  let nKey = null, nRev = 0, nSaved = "", nT = null;
  async function loadNotes(key) {
    if (nKey === key) return;
    flushNotes();
    nKey = key; nRev = 0; nSaved = ""; $("gnText").value = ""; gnStatus("");
    try {
      const j = await api.getNotes(key);
      if (nKey !== key) return;
      nRev = j.rev || 0; nSaved = j.text || ""; $("gnText").value = nSaved;
      gnStatus(j.savedAt ? "Saved " + hhmm(j.savedAt) : "", "ok");
    } catch (e) { if (nKey === key) gnStatus("Couldn't load the notes: " + e.message, "err"); }
  }
  function gnStatus(t, cls) { const s = $("gnSave"); s.textContent = t; s.className = "gn__save" + (cls ? " " + cls : ""); }
  function saveGeneralSoon() { gnStatus("Saving…"); clearTimeout(nT); nT = setTimeout(() => saveGeneral(false), 600); }
  function flushNotes(keepalive) { if (nT) { clearTimeout(nT); nT = null; saveGeneral(!!keepalive); } }
  async function saveGeneral(keepalive) {
    clearTimeout(nT); nT = null;
    const key = nKey; if (!key) return;
    const text = $("gnText").value;
    if (text === nSaved) { gnStatus("Saved", "ok"); return; }
    try {
      const j = await api.saveNotes(key, text, nRev, false, { keepalive });
      if (nKey !== key) return;
      nRev = j.rev; nSaved = text; gnStatus("Saved " + hhmm(j.savedAt), "ok");
      if ($("gnText").value !== nSaved) saveGeneralSoon();
    } catch (e) {
      if (e.conflict && e.payload) {
        try {
          const j = await api.saveNotes(key, text, e.payload.rev, true);
          if (nKey === key) { nRev = j.rev; nSaved = text; gnStatus("Saved " + hhmm(j.savedAt), "ok"); }
          ui.toast("Notes changed in another window; yours were saved and the other version is in history.");
        } catch (e2) { gnStatus("Not saved: " + e2.message, "err"); }
      } else gnStatus("Not saved: " + e.message, "err");
    }
  }
  $("gnText").addEventListener("input", saveGeneralSoon);
  $("gnPage").onclick = () => {
    const ta = $("gnText"), ref = "(p. " + (S.pages.length ? currentPage() : 1) + ") ";
    const a = ta.selectionStart, b = ta.selectionEnd;
    const pre = ta.value.slice(0, a), lead = pre && !/\s$/.test(pre) ? " " : "";
    ta.setRangeText(lead + ref, a, b, "end");
    ta.focus(); saveGeneralSoon();
  };
  const leave = () => { flushView(); flushSave(true); flushNotes(true); };
  window.addEventListener("pagehide", leave);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") leave(); });

  /* ---------------------------------------------------------------- keys (called by the shell while the reader is active) */
  let escArmed = 0;
  function onKey(ev) {
    if (!visible) return false;
    const typing = ev.target.closest && ev.target.closest("textarea, input, select");
    // scrolling with the keyboard: J/K go from where you are reading again
    if (!typing && ["ArrowUp", "ArrowDown", "PageUp", "PageDown", " ", "Home", "End"].includes(ev.key)) dropMarkCursor();
    if (navKey(ev, typing)) return true;
    const inComposer = ev.target.closest && ev.target.closest(".composer");
    const cmpOpen = !$("composer").hidden;
    const mod = ev.metaKey || ev.ctrlKey;
    if (cmpOpen && mod && ev.key === "Enter") { ev.preventDefault(); commit(); return true; }
    const fieldSel = typing && typeof ev.target.selectionStart === "number" && ev.target.selectionStart !== ev.target.selectionEnd;
    if (mod && !ev.shiftKey && ev.key.toLowerCase() === "c" && !fieldSel && String(window.getSelection() || "").trim() === "") {
      const m = S.editing && S.marks.find((x) => x.id === S.editing);
      if (m) {
        ev.preventDefault();
        const text = [tidyQuote(m.quote), m.note && "Note: " + m.note, m.suggest && "Suggested: " + m.suggest].filter(Boolean).join("\n") + `\n(p. ${m.page})`;
        ui.copyText(text).then((ok) => ui.toast(ok ? `Copied mark #${m.num}.` : "Couldn't copy."));
        return true;
      }
    }
    // ⌘+ / ⌘− / ⌘0 zoom the paper (not the whole page, which would just blur it)
    if (mod && !ev.altKey && ["=", "+", "-", "_", "0"].includes(ev.key)) {
      ev.preventDefault();
      if (ev.key === "0") fit("width"); else zoomStep(ev.key === "-" || ev.key === "_" ? -1 : 1);
      return true;
    }
    if (ev.key === "Escape") {
      if (!menu.hidden) { setMenu(false); $("zoomVal").focus(); return true; }
      if (drag) { drag.d.remove(); drag = null; return true; }
      if (cmpOpen && (inComposer || !typing)) {
        if (draftDirty() && Date.now() - escArmed > 2000) { escArmed = Date.now(); ui.toast("Press Esc again to discard this note."); return true; }
        closeComposer(); escArmed = 0; return true;
      }
      if (typing) return false;
      if (!find.hidden) { closeFind(); return true; }   // as the bar's × does; a second Esc leaves Annotate
      if (S.mark) { setMark(false); return true; }
      if (S.pin) { setPin(false); return true; }
      return false;
    }
    // Ctrl+1/2/3 picks the mark type while typing (Option+digit types ¡™£ on a Mac); plain 1/2/3 when not typing
    if (cmpOpen && /^[1-9]$/.test(ev.key) && !ev.metaKey && !ev.altKey && (ev.ctrlKey || !typing)) {
      const opts = [...$("seg").querySelectorAll(".tpick__opt")];
      const b = opts[+ev.key - 1];
      if (b) { ev.preventDefault(); setType(b.dataset.type); return true; }
    }
    if (typing || mod || ev.altKey) return false;
    if (ev.key === "`") { ev.preventDefault(); setMark(!S.mark); return true; }
    if (ev.key === "n" || ev.key === "N") { setPanel($("panel").hidden); return true; }
    return false;
  }
  document.addEventListener("mousedown", (ev) => {
    if (!visible) return;
    if (!$("composer").hidden && !ev.target.closest(".composer, .badge, .card, .toolbar, .tabbar, #overlay-root")) {
      // clicking elsewhere keeps a typed note safe: only close when nothing was typed
      if (!draftDirty()) closeComposer();
    }
  });

  /* ---------------------------------------------------------------- links (Fig. 7, Eq. (B3), [12], Sec. III, web links)
     The PDF's own hyperref links, laid over the page. Click jumps to the target and flashes it;
     hover shows a preview of the target; "Back" (or the browser's back) returns you. Off in Mark mode. */
  async function loadLinks(P, doc) {
    const lk = P.lk;      // the layer this call fills (a later rebuild of the same document gets its own call)
    let anns = [];
    try { anns = await P.page.getAnnotations(); } catch (_) { return; }
    if (S.doc !== doc || !lk || P.lk !== lk) return;
    const vp1 = P.page.getViewport({ scale: 1 });
    for (const a of anns) {
      if (a.subtype !== "Link" || !(a.dest || a.url)) continue;
      const [x0, y0, x1, y1] = vp1.convertToViewportRectangle(a.rect);
      const l = Math.min(x0, x1) / P.w1, t = Math.min(y0, y1) / P.h1, w = Math.abs(x1 - x0) / P.w1, h = Math.abs(y1 - y0) / P.h1;
      const ln = el("a", "lnk");
      Object.assign(ln.style, { left: pc(l), top: pc(t), width: pc(w), height: pc(h) });
      if (a.url) {
        ln.href = a.url; ln.target = "_blank"; ln.rel = "noopener noreferrer";
        ln.title = a.url;
      } else {
        ln.setAttribute("role", "link"); ln.tabIndex = -1; ln.dataset.dest = typeof a.dest === "string" ? a.dest : JSON.stringify(a.dest);
        ln.setAttribute("aria-label", "Go to " + destLabel(ln.dataset.dest));
      }
      lk.appendChild(ln);
    }
  }

  const destCache = new Map();
  // -> { page, fx, fy, kind } with fx/fy as page fractions (fy = top of the target)
  async function resolveDest(key) {
    if (destCache.has(key)) return destCache.get(key);
    const pdf = S.pdf;
    let d = key.startsWith("[") ? JSON.parse(key) : await pdf.getDestination(key);
    if (!Array.isArray(d)) return null;
    let n = typeof d[0] === "number" ? d[0] : await pdf.getPageIndex(d[0]);
    const P = S.pages[n]; if (!P) return null;
    const vp1 = P.page.getViewport({ scale: 1 });
    const mode = d[1] && d[1].name;
    let left = 0, top = null;
    if (mode === "XYZ") { left = d[2] || 0; top = d[3]; }
    else if (mode === "FitH" || mode === "FitBH") top = d[2];
    else if (mode === "FitR") { left = d[2]; top = d[5]; }
    const [px, py] = vp1.convertToViewportPoint(left, top == null ? vp1.viewBox[3] : top);
    const r = { page: n + 1, fx: clamp(px / P.w1, 0, 1), fy: clamp(py / P.h1, 0, 1), kind: key.startsWith("[") ? "" : key.split(".")[0] };
    destCache.set(key, r);
    return r;
  }
  function destLabel(key) {
    const k = key.split(".")[0];
    return { figure: "figure", table: "table", equation: "equation", cite: "reference", section: "section", "section*": "section", page: "page" }[k] || "target";
  }
  // The part of the target page worth showing: figures/tables full width, everything else its column.
  function destRegion(t) {
    const tall = { figure: 0.48, table: 0.32, equation: 0.1, cite: 0.075, section: 0.12, "section*": 0.12, page: 0.3 }[t.kind] || 0.14;
    const y0 = clamp(t.fy - (t.kind === "equation" ? 0.001 : 0.012), 0, 1), y1 = clamp(y0 + tall, 0, 1);
    if (t.kind === "figure" || t.kind === "table" || t.kind === "page") return { x0: 0.06, y0, x1: 0.94, y1 };
    const right = t.fx > 0.5 && !(t.kind === "equation" && t.fx < 0.52);
    return right ? { x0: 0.49, y0, x1: 0.94, y1 } : { x0: 0.06, y0, x1: 0.51, y1 };
  }

  // a region of a page as a canvas, `cssW` wide, sharp on this screen
  async function renderRegion(P, R, cssW) {
    const dpr = window.devicePixelRatio || 1;
    const k = (cssW * dpr) / ((R.x1 - R.x0) * P.w1);
    const vp = P.page.getViewport({ scale: k });
    const c = document.createElement("canvas");
    // whole CSS pixels both ways (height: auto would otherwise land on a half pixel and get resampled, see sizePage)
    c.width = Math.round(cssW * dpr); c.height = Math.round(Math.round((R.y1 - R.y0) * vp.height / dpr) * dpr);
    c.style.width = cssW + "px";
    await P.page.render({ annotationMode: annMode(), canvasContext: c.getContext("2d", { alpha: false }), viewport: vp, transform: [1, 0, 0, 1, -R.x0 * vp.width, -R.y0 * vp.height] }).promise;
    return c;
  }

  // jumping, with a way back
  const backStack = [];
  let histDepth = 0;
  function viewPos() {
    const v = $("viewer"), n = currentPage(), P = S.pages[n - 1];
    return { doc: S.doc, page: n, fy: (v.scrollTop + v.clientHeight * 0.35 - P.div.offsetTop) / P.div.offsetHeight, left: v.scrollLeft };
  }
  function showBack() {
    const b = $("backBtn");
    if (!backStack.length) { b.hidden = true; return; }
    b.hidden = false;
    $("backLbl").textContent = "Back to p. " + backStack[backStack.length - 1].page;
  }
  async function followDest(key) {
    const doc = S.doc;
    const t = await resolveDest(key); if (!t || S.doc !== doc || !S.pages[t.page - 1] || !S.pages[t.page - 1].div) return;
    hidePreview();
    backStack.push(viewPos());
    histDepth = backStack.length;
    try { history.pushState({ pmBack: histDepth }, ""); } catch (_) {}
    const P = S.pages[t.page - 1], v = $("viewer");
    const R = destRegion(t);
    v.scrollTo({ top: P.div.offsetTop + R.y0 * P.div.offsetHeight - v.clientHeight * 0.18, left: Math.max(0, P.div.offsetLeft + R.x0 * P.div.offsetWidth - 24), behavior: scrollBehavior() });
    showBack();
    // flash where we landed
    const f = el("div", "landing");
    Object.assign(f.style, { left: pc(R.x0), top: pc(R.y0), width: pc(R.x1 - R.x0), height: pc(Math.min(R.y1 - R.y0, t.kind === "figure" ? 0.08 : 1)) });
    P.ov.appendChild(f);
    setTimeout(() => f.remove(), 2000);
  }
  function goBack(fromPop) {
    const pos = backStack.pop(); if (!pos) return;
    if (pos.doc === S.doc) {
      const P = S.pages[pos.page - 1], v = $("viewer");
      if (P) v.scrollTo({ top: P.div.offsetTop + pos.fy * P.div.offsetHeight - v.clientHeight * 0.35, left: pos.left, behavior: scrollBehavior() });
    }
    showBack();
  }
  $("backBtn").onclick = () => { if (histDepth > 0) history.back(); else goBack(true); };
  window.addEventListener("popstate", (ev) => {
    const nd = (ev.state && ev.state.pmBack) || 0;
    if (nd < histDepth) { while (histDepth > nd && backStack.length) { goBack(true); histDepth--; } histDepth = nd; }
    else histDepth = Math.min(nd, backStack.length);   // Forward: just keep the depth in step
  });

  $("pages").addEventListener("click", (ev) => {
    const a = ev.target.closest && ev.target.closest("a.lnk[data-dest]");
    if (!a) return;
    ev.preventDefault();
    followDest(a.dataset.dest);
  });

  // hover preview of the target
  let pvT = null, pvFor = null;
  const pvCache = new Map();
  function hidePreview() { clearTimeout(pvT); pvFor = null; $("preview").hidden = true; }
  $("pages").addEventListener("pointerover", (ev) => {
    const a = ev.target.closest && ev.target.closest("a.lnk[data-dest]");
    if (!a || ev.pointerType === "touch" || S.mark) return;
    if (pvFor === a) return;
    clearTimeout(pvT);
    pvFor = a;
    pvT = setTimeout(() => showPreview(a), 220);
  });
  $("pages").addEventListener("pointerout", (ev) => {
    const a = ev.target.closest && ev.target.closest("a.lnk[data-dest]");
    if (a && !(ev.relatedTarget && a.contains(ev.relatedTarget))) hidePreview();
  });
  async function showPreview(a) {
    const key = a.dataset.dest, doc = S.doc;
    const t = await resolveDest(key); if (!t || pvFor !== a) return;
    const P = S.pages[t.page - 1]; if (!P) return;
    const R = destRegion(t);
    const W = Math.min(t.kind === "figure" || t.kind === "table" ? 560 : 440, innerWidth - 32);
    const ck = doc + "|" + key + "|" + W + "|" + (window.devicePixelRatio || 1);
    let c = pvCache.get(ck);
    if (!c) {
      try { c = await renderRegion(P, R, W); } catch (_) { return; }
      if (pvCache.size > 40) pvCache.delete(pvCache.keys().next().value);
      pvCache.set(ck, c);
    }
    if (pvFor !== a || S.doc !== doc) return;
    const box = $("preview");
    $("pvLabel").textContent = "p. " + t.page + (t.page === currentPage() ? " (this page)" : "") + " · click to go there";
    const host = $("pvImg"); host.innerHTML = ""; host.appendChild(c);
    box.hidden = false;
    const r = a.getBoundingClientRect(), bw = box.offsetWidth, bh = box.offsetHeight, m = 12;
    const left = clamp(r.left + r.width / 2 - bw / 2, m, innerWidth - bw - m);
    let top = r.bottom + 8;
    if (top + bh > innerHeight - m) top = Math.max(m, r.top - bh - 8);
    box.style.left = left + "px"; box.style.top = top + "px";
  }
  $("viewer").addEventListener("scroll", hidePreview, { passive: true });

  function toast(t) { ui.toast(t); }

  // panel: remembered open/closed and tab; starts closed on narrow screens
  let panelPref = null, tabPref = "marks";
  try { panelPref = localStorage.getItem("pm2:rdpanel"); tabPref = localStorage.getItem("pm2:rdtab") || "marks"; } catch (_) {}
  setTab(tabPref === "notes" ? "notes" : "marks");
  try { if (localStorage.getItem("pm2:rdside") === "1" && window.innerWidth >= 900) { $("side").hidden = false; $("sideBtn").setAttribute("aria-pressed", "true"); } } catch (_) {}
  $("panel").hidden = window.innerWidth < 900 ? true : panelPref === "0";
  syncPills();
  store.on("item", ({ key }) => { if (cur && cur.key === key) { const it = store.item(key); if (it) { setTitleText(it); fillVersions(it, cur.att); } } });

  /* ================================================================ navigation + quick marking
     - click the paper title (or ⌘P) to switch papers, listed in logical order (the project's sections)
     - ⌥↓ / ⌥↑ next / previous paper in that order
     - select text: a small toolbar offers the mark types; or press a type's letter (Q, R, E, H, C…)
       Highlight and Cite save at once, the others open the note
     - J / K next / previous mark, G go to page, ⌘F find in this paper                               */
  const h = ui.h;
  let texPlain = (x) => x;
  import("./library.js").then((m) => { if (m.texPlain) { texPlain = m.texPlain; if (cur) setTitleText(store.item(cur.key)); } }).catch(() => {});
  function setTitleText(it) {
    if (!it) return;
    // the text in its own span: an ellipsis can't apply to bare text in a flex button, and the chevron
    // (the sign that this is a paper switcher) used to be pushed out of sight
    $("title").replaceChildren(el("span", "rd-title__text", texPlain(it.title || it.key)), ui.icon("chev-down", "rd-title__chev"));
    $("title").title = texPlain(it.title || "") + "\nClick to switch paper (⌘P)";
  }
  const settingsR = () => ((store.settings || {}).reader) || {};

  // ---- paper switcher
  function paperRows(q) {
    const words = (q || "").toLowerCase().split(/\s+/).filter(Boolean);
    const hit = (it) => !words.length || words.every((w) => [it.title, ui.authorsFull(it.authors), it.year, it.venue].join(" ").toLowerCase().includes(w));
    const { pid, rest } = order.orderedKeys(cur.key);
    const groups = [];
    if (pid) for (const g of order.projectOrder(pid)) {
      const items = g.items.filter(hit);
      if (items.length) groups.push({ name: `${(store.project(pid) || {}).name} · ${g.name}`, items, ranked: !words.length });
    }
    const others = rest.map((k) => store.item(k)).filter((it) => it && !it.trashed && hit(it));
    if (others.length) groups.push({ name: pid ? "Other papers" : "All papers", items: others, ranked: false });
    return groups;
  }
  function openSwitcher() {
    if (!cur) return;
    const box = el("div", "psw");
    const inp = h("input", { class: "input psw__q", placeholder: "Go to paper…", "aria-label": "Find a paper" });
    const list = el("div", "psw__list"); list.setAttribute("role", "listbox");
    box.append(inp, list);
    let flat = [], at = 0;
    const render = () => {
      list.textContent = ""; flat = [];
      for (const g of paperRows(inp.value)) {
        list.append(el("div", "psw__head", g.name));
        g.items.forEach((it, i) => {
          const row = el("button", "psw__row" + (it.key === cur.key ? " is-current" : ""));
          row.setAttribute("role", "option");
          if (g.ranked) row.append(el("span", "psw__rank num", String(i + 1)));
          const t = el("span", "psw__t"); t.append(el("span", "psw__title", it.title || it.key), el("span", "psw__meta", [ui.authorsShort(it.authors), it.year, (it.attachments || []).length > 1 ? `${it.attachments.length} versions` : ""].filter(Boolean).join(" · ")));
          row.append(t);
          const n = store.markCounts(it.key).total; if (n) row.append(el("span", "psw__n num", String(n)));
          const idx = flat.length;
          row.onmouseenter = () => sel_(idx);
          row.onclick = () => go_(it.key);
          flat.push({ row, key: it.key });
          list.append(row);
        });
      }
      if (!flat.length) list.append(el("div", "psw__none", "No papers match."));
      sel_(Math.max(0, flat.findIndex((f) => f.key === cur.key && !inp.value)));
    };
    const sel_ = (i) => { at = ui.clamp(i, 0, flat.length - 1); flat.forEach((f, j) => f.row.setAttribute("aria-selected", String(j === at))); if (flat[at]) flat[at].row.scrollIntoView({ block: "nearest" }); };
    const go_ = (key) => { pop.close(); if (key !== cur.key) ctx.openReader(key); };
    inp.addEventListener("input", render);
    inp.addEventListener("keydown", (ev) => {
      if (ev.key === "ArrowDown") { ev.preventDefault(); sel_(at + 1); }
      else if (ev.key === "ArrowUp") { ev.preventDefault(); sel_(at - 1); }
      else if (ev.key === "Enter" && flat[at]) { ev.preventDefault(); go_(flat[at].key); }
    });
    const pop = ui.popover($("title"), box, {});
    render();
    setTimeout(() => inp.focus(), 0);
  }
  $("title").onclick = openSwitcher;
  function stepPaper(dir) {
    if (!cur) return;
    if (draftDirty()) { nudgeComposer(); return; }
    const { pid, seq } = order.stepKeys(cur.key);
    const i = seq.indexOf(cur.key);         // not in the list (e.g. in the Trash): don't jump to its start
    // skip papers with no PDF (openReader would refuse them and leave you stuck here)
    let j = i < 0 ? -1 : i + dir;
    while (j >= 0 && j < seq.length && !store.primaryAtt(store.item(seq[j]))) j += dir;
    const next = j >= 0 ? seq[j] : null;
    if (!next) {
      ui.toast(pid ? (dir > 0 ? "That's the last paper in this project." : "That's the first paper in this project.")
        : (dir > 0 ? "That's the last unfiled paper." : "That's the first unfiled paper."));
      return;
    }
    ctx.openReader(next);
  }

  // ---- quick marking from a selection
  const typeKeys = () => mt.quickKeys();   // letter -> type id (shared with the shortcuts list)
  const INSTANT = new Set(["highlight", "cite"]);
  function quickMark(typeId) {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return false;
    if (draftDirty()) { nudgeComposer(); return true; }
    if (!openFromSelection(sel)) return false;
    hideSelTb();
    setType(typeId);
    if (INSTANT.has(typeId)) commit();
    return true;
  }
  const seltb = el("div", "seltb"); seltb.hidden = true; seltb.setAttribute("role", "toolbar"); seltb.setAttribute("aria-label", "Mark the selection");
  root.querySelector(".rd").appendChild(seltb);
  function hideSelTb() { seltb.hidden = true; }
  function showSelTb() {
    if (!visible || S.mark || settingsR().selectionToolbar === false) return hideSelTb();
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !String(sel).trim()) return hideSelTb();
    const range = sel.getRangeAt(0);
    if (!pageOf(range.startContainer)) return hideSelTb();
    const keys = new Map([...typeKeys()].map(([k, id]) => [id, k]));
    seltb.textContent = "";
    for (const t of mt.visible()) {
      const b = el("button", "seltb__b " + mt.cls(t.id), t.name);
      // the shortcut letter is underlined in the name, as in a menu
      const k = keys.get(t.id), i = k ? t.name.toLowerCase().indexOf(k) : -1;
      if (k && settingsR().quickKeys !== false) {
        b.title = `${t.name} (${k.toUpperCase()})`;
        if (i >= 0) { const nm = el("span"); nm.append(t.name.slice(0, i), el("u", "seltb__key", t.name[i]), t.name.slice(i + 1)); b.textContent = ""; b.append(nm); }
      }
      b.onmousedown = (ev) => ev.preventDefault();      // keep the selection
      b.onclick = () => quickMark(t.id);
      seltb.append(b);
    }
    const pb = el("button", "seltb__b seltb__copy", "Pin");
    pb.title = "Keep this at the side while you read (P)";
    pb.onmousedown = (ev) => ev.preventDefault();
    pb.onclick = () => pinSelection();
    seltb.append(pb);
    const cp = el("button", "seltb__b seltb__copy", "Copy");
    cp.onmousedown = (ev) => ev.preventDefault();
    cp.onclick = () => { ui.copyText(clean(String(window.getSelection())).trim()).then((ok) => ui.toast(ok ? "Copied." : "Couldn't copy.")); hideSelTb(); };
    seltb.append(cp);
    seltb.hidden = false;
    const r = range.getBoundingClientRect(), w = seltb.offsetWidth, hgt = seltb.offsetHeight;
    let top = r.top - hgt - 8; if (top < 8) top = r.bottom + 8;
    seltb.style.left = clamp(r.left + r.width / 2 - w / 2, 8, innerWidth - w - 8) + "px";
    seltb.style.top = top + "px";
  }
  document.addEventListener("mouseup", (ev) => { if (visible && !ev.target.closest(".seltb, .composer")) setTimeout(showSelTb, 0); });
  document.addEventListener("selectionchange", () => { if (!seltb.hidden && window.getSelection().isCollapsed) hideSelTb(); });
  $("viewer").addEventListener("scroll", hideSelTb, { passive: true });

  // ---- J / K between marks
  // The cursor (the mark J/K last went to) only survives scrolls stepMark itself started: once you scroll
  // yourself, J/K go from where you are reading.
  let markCursor = null, markScrolling = false, markTop = 0;
  const dropMarkCursor = () => { markScrolling = false; markCursor = null; };
  {
    const v = $("viewer");
    v.addEventListener("scroll", () => {
      if (!markScrolling) { markCursor = null; return; }
      if (Math.abs(v.scrollTop - markTop) < 2) markScrolling = false;    // arrived (Safari has no scrollend)
    }, { passive: true });
    v.addEventListener("scrollend", () => { if (Math.abs(v.scrollTop - markTop) < 2) markScrolling = false; });
    for (const t of ["wheel", "touchstart", "pointerdown"]) v.addEventListener(t, dropMarkCursor, { passive: true });
  }
  function stepMark(dir) {
    if (!S.marks.length) { ui.toast("No marks in this PDF yet."); return; }
    const sorted = [...S.marks].sort((a, b) => a.page - b.page || a.y - b.y);
    const i = markCursor ? sorted.findIndex((m) => m.id === markCursor) : -1;
    let j;
    if (i >= 0) j = i + dir;
    else {
      // from where you are reading: J = first mark below the reading line, K = last mark above it
      const v = $("viewer"), n = currentPage(), P = S.pages[n - 1];
      const H = P && P.div ? P.div.offsetHeight : 1;
      const fy = P && P.div ? (v.scrollTop + v.clientHeight * 0.3 - P.div.offsetTop) / H : 0, e = 4 / H;   // a few px of slack
      if (dir > 0) j = sorted.findIndex((m) => m.page > n || (m.page === n && m.y > fy + e));
      else { const k = sorted.findIndex((m) => m.page > n || (m.page === n && m.y >= fy - e)); j = (k < 0 ? sorted.length : k) - 1; }
    }
    // nothing further that way: say so (it used to wrap to the other end, or step the wrong way)
    if (j < 0 || j >= sorted.length) { ui.toast(dir > 0 ? "No more marks after this." : "No earlier marks."); return; }
    const m = sorted[j];
    markCursor = m.id;
    const P = S.pages[m.page - 1]; if (!P || !P.div) return;
    const v = $("viewer"), r = m.rects[0];
    // clamped to the scrollable range, so the scroll can actually land on it (and the cursor is kept)
    const top = clamp(P.div.offsetTop + r.y * P.div.offsetHeight - v.clientHeight * 0.3, 0, Math.max(0, v.scrollHeight - v.clientHeight));
    markTop = top; markScrolling = Math.abs(top - v.scrollTop) >= 1;
    v.scrollTo({ top, behavior: scrollBehavior() });
    flash(m.id);
    const card = $("list").querySelector(`[data-card="${CSS.escape(m.id)}"]`);
    $("list").querySelectorAll(".card.is-cursor").forEach((c) => c.classList.remove("is-cursor"));
    if (card) { card.classList.add("is-cursor"); card.scrollIntoView({ block: "nearest" }); }
  }

  // ---- ⌘F find in this paper (the browser's find misses pages whose text isn't loaded yet)
  const find = el("div", "findbar"); find.hidden = true;
  const fIn = h("input", { class: "input findbar__q", placeholder: "Find in this paper", "aria-label": "Find in this paper" });
  const fN = el("span", "findbar__n num");
  const fPrev = h("button", { class: "ibtn", title: "Previous (⇧↵)", "aria-label": "Previous match" }, ui.icon("chev-left"));
  const fNext = h("button", { class: "ibtn", title: "Next (↵)", "aria-label": "Next match" }, ui.icon("chev-right"));
  const fX = h("button", { class: "ibtn", title: "Close (Esc)", "aria-label": "Close find" }, ui.icon("x"));
  find.append(fIn, fN, fPrev, fNext, fX);
  root.querySelector(".viewwrap").appendChild(find);
  let hits = [], hitAt = -1, findSeq = 0, finding = false;
  const pageText = new Map();   // page n -> {text, map, spans:[{a, b, it, s, ff}]}
  const DASH = /[-\u00ad\u2010-\u2015\u2212]/;
  async function textOf(P) {
    if (pageText.has(P.n)) return pageText.get(P.n);
    const tc = P.tc || await P.page.getTextContent();
    if (!P.tc) P.tc = tc;
    let text = "", spans = [];
    for (const it of tc.items) {
      const s = clean(it.str || "");
      if (s) { spans.push({ a: text.length, b: text.length + s.length, it, s, ff: (tc.styles[it.fontName] || {}).fontFamily }); text += s; }
      text += it.hasEOL ? " " : (s && !/\s$/.test(s) ? "" : "");
    }
    // normalised copy for matching, with a map back to positions in the raw text (so a highlight still covers
    // the raw text, hyphen and line break included): whitespace collapsed; hyphens and dashes ignored, and so
    // is the line break after one, so "semiconduc-⏎tors" reads "semiconductors" and "two-dimensional"
    // matches with or without its hyphen
    const raw = text.toLowerCase();
    let norm = "", map = [], hy = false;
    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i];
      if (DASH.test(ch)) { hy = true; continue; }
      if (/\s/.test(ch)) { if (hy || !norm.length || norm.endsWith(" ")) continue; norm += " "; map.push(i); continue; }
      hy = false; norm += ch; map.push(i);
    }
    map.push(raw.length);
    const r = { text: norm, map, spans };
    pageText.set(P.n, r);
    return r;
  }
  const normQuery = (q) => q.toLowerCase().replace(/[-\u00ad\u2010-\u2015\u2212]\s*/g, "").replace(/\s+/g, " ").trim();
  // Where characters i0..i1 of a text item sit across its width: measured in the item's font the way
  // pdf.js sizes its text-layer spans (equal widths per character drifted: "band" lit up "and ")
  const measCtx = document.createElement("canvas").getContext("2d");
  function glyphFrac(sp, i0, i1) {
    const n = Math.max(1, sp.s.length);
    measCtx.font = "100px " + (sp.ff || "sans-serif");
    const W = measCtx.measureText(sp.s).width;
    if (!(W > 0)) return [i0 / n, i1 / n];
    return [measCtx.measureText(sp.s.slice(0, i0)).width / W, measCtx.measureText(sp.s.slice(0, i1)).width / W];
  }
  function hitRects(P, spans, a, b) {
    const vp1 = P.page.getViewport({ scale: 1 }), out = [];
    for (const sp of spans) {
      if (sp.b <= a || sp.a >= b) continue;
      const it = sp.it, i0 = Math.max(a, sp.a) - sp.a, i1 = Math.min(b, sp.b) - sp.a;
      const [f0, f1] = glyphFrac(sp, i0, i1);
      const x = it.transform[4], y = it.transform[5], hgt = Math.hypot(it.transform[2], it.transform[3]) || it.height || 10;
      const [x0, y0, x1, y1] = vp1.convertToViewportRectangle([x + it.width * f0, y - hgt * 0.22, x + it.width * f1, y + hgt * 0.9]);
      out.push({ x: Math.min(x0, x1) / P.w1, y: Math.min(y0, y1) / P.h1, w: Math.abs(x1 - x0) / P.w1, h: Math.abs(y1 - y0) / P.h1 });
    }
    return out;
  }
  function clearHits() { root.querySelectorAll(".findhit").forEach((d) => d.remove()); }
  // Results are published only once the whole paper has been searched: stepping through a half-filled list
  // (and then snapping back to the first hit) is what Enter used to do while "Searching…" was showing.
  async function runFind() {
    const q = normQuery(fIn.value);
    const seq = ++findSeq; clearHits(); hits = []; hitAt = -1; finding = false;
    if (q.length < 2) { fN.textContent = ""; return; }
    finding = true; fN.textContent = "Searching…";
    const found = [];
    for (const P of S.pages) {
      const t = await textOf(P);
      if (seq !== findSeq) return;           // a newer search, or closing the bar, now owns `finding`
      let i = t.text.indexOf(q);
      while (i >= 0) { found.push({ P, rects: hitRects(P, t.spans, t.map[i], t.map[i + q.length - 1] + 1) }); i = t.text.indexOf(q, i + q.length); }
    }
    finding = false; hits = found;
    for (const hh of hits) for (const r of hh.rects) {
      if (!hh.P.fl) continue;
      const d = el("div", "findhit"); Object.assign(d.style, { left: pc(r.x), top: pc(r.y), width: pc(r.w), height: pc(r.h) });
      hh.P.fl.appendChild(d); (hh.els || (hh.els = [])).push(d);
    }
    fN.textContent = hits.length ? `${hits.length} found` : "No matches";
    if (hits.length) stepHit(1, true);
  }
  function stepHit(dir, first) {
    if (finding || !hits.length) return;
    if (first) { const n = currentPage(); hitAt = Math.max(0, hits.findIndex((x) => x.P.n >= n)); }
    else hitAt = (hitAt + dir + hits.length) % hits.length;
    root.querySelectorAll(".findhit.is-current").forEach((d) => d.classList.remove("is-current"));
    const hh = hits[hitAt]; (hh.els || []).forEach((d) => d.classList.add("is-current"));
    fN.textContent = `${hitAt + 1} of ${hits.length}`;
    const r = hh.rects[0]; if (!r || !hh.P.div) return;
    const v = $("viewer");
    v.scrollTo({ top: hh.P.div.offsetTop + r.y * hh.P.div.offsetHeight - v.clientHeight * 0.35, left: Math.max(0, hh.P.div.offsetLeft + r.x * hh.P.div.offsetWidth - v.clientWidth * 0.4) });
  }
  const debFind = ui.debounce(runFind, 200);
  fIn.addEventListener("input", debFind);
  fIn.addEventListener("keydown", (ev) => {
    // Enter while a search is running waits for it (its first hit is where Enter would have gone)
    if (ev.key === "Enter") { ev.preventDefault(); if (finding) return; if (!hits.length) runFind(); else stepHit(ev.shiftKey ? -1 : 1); }
    else if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); closeFind(); }
  });
  fPrev.onclick = () => stepHit(-1); fNext.onclick = () => stepHit(1); fX.onclick = () => closeFind();
  function openFind() { find.hidden = false; fIn.focus(); fIn.select(); if (fIn.value.trim()) runFind(); }
  function closeFind() { find.hidden = true; ++findSeq; finding = false; clearHits(); hits = []; hitAt = -1; fN.textContent = ""; $("viewer").focus({ preventScroll: true }); }

  // ---- jumps requested from elsewhere (⌘K mark / notes hits): {key, att, page?, markId?, panel?}
  let pendingJump = null;
  // Applied once the reader shows this PDF (a hidden reader keeps it pending for show()). The scroll waits
  // for any refit already queued by setPanel()/show(): a refit writes scrollTop and moves the page offsets
  // the target is computed from. It is instant: a smooth scroll across a whole paper helps nobody.
  function applyJump(d) {
    if (!d || !cur || d.key !== cur.key || (d.att && d.att !== cur.att) || !S.pages.length || !visible) return false;
    pendingJump = null;
    const m = d.markId && S.marks.find((x) => x.id === d.markId);
    const seq = openSeq, still = () => seq === openSeq && cur && cur.key === d.key && visible;
    if (m) {
      S.filter = "all"; S.query = ""; $("search").value = ""; setPanel(true); setTab("marks"); renderMarksPanel();
      setTimeout(() => { if (still()) jumpTo(m, true); }, 0);
    } else if (d.page) setTimeout(() => { if (still()) goToPage(+d.page); }, 0);
    if (d.panel === "notes") { setPanel(true); setTab("notes"); setTimeout(() => $("gnText").focus(), 0); }
    return true;
  }
  store.on("reader-jump", (d) => { d.handled = true; pendingJump = d; applyJump(d); });

  // ---- reader settings (from the Settings tab)
  function applyReaderSettings() {
    const r = settingsR();
    root.querySelector(".rd").dataset.pageTheme = r.pageTheme || "normal";
    root.querySelector(".rd").classList.toggle("no-flags", r.showFlags === false);
    if (r.selectionToolbar === false) hideSelTb();
  }
  store.on("settings", applyReaderSettings);
  applyReaderSettings();

  // ---- keys added to onKey (called first from onKey below)
  function navKey(ev, typing) {
    const mod = ev.metaKey || ev.ctrlKey;
    if (mod && !ev.altKey && !ev.shiftKey && ev.key.toLowerCase() === "f") { ev.preventDefault(); openFind(); return true; }
    if (mod && !ev.altKey && ev.key.toLowerCase() === "g" && !find.hidden) { ev.preventDefault(); stepHit(ev.shiftKey ? -1 : 1); return true; }
    if (typing || mod) return false;
    if (ev.altKey && (ev.key === "ArrowDown" || ev.key === "ArrowUp")) { ev.preventDefault(); stepPaper(ev.key === "ArrowDown" ? 1 : -1); return true; }
    if (ev.altKey) return false;
    const k = ev.key.toLowerCase();
    if (k === "p" && !ev.shiftKey && $("composer").hidden) { ev.preventDefault(); if (!pinSelection()) setPin(!S.pin); return true; }
    // a letter with text selected marks it
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && String(sel).trim() && settingsR().quickKeys !== false && !ev.shiftKey) {
      const t = typeKeys().get(k);
      if (t && pageOf(sel.getRangeAt(0).startContainer)) { ev.preventDefault(); quickMark(t); return true; }
    }
    if ($("composer").hidden) {
      if (k === "j" && !ev.shiftKey) { ev.preventDefault(); stepMark(1); return true; }
      if (k === "k" && !ev.shiftKey) { ev.preventDefault(); stepMark(-1); return true; }
      if (k === "g" && !ev.shiftKey) { ev.preventDefault(); $("pageIn").focus(); $("pageIn").select(); return true; }
    }
    return false;
  }

  // ---- commands for the ⌘K palette
  const here = () => visible && !!cur;
  commands.registerAll([
    { id: "reader.switch", title: "Switch paper…", section: "Reader", when: here, run: () => openSwitcher() },
    { id: "reader.next-paper", title: "Next paper", section: "Reader", keys: "⌥↓", when: here, run: () => stepPaper(1) },
    { id: "reader.prev-paper", title: "Previous paper", section: "Reader", keys: "⌥↑", when: here, run: () => stepPaper(-1) },
    { id: "reader.next-mark", title: "Next mark", section: "Marking", keys: "J", when: here, run: () => stepMark(1) },
    { id: "reader.prev-mark", title: "Previous mark", section: "Marking", keys: "K", when: here, run: () => stepMark(-1) },
    { id: "reader.annotate", title: "Annotate on / off", section: "Marking", keys: "`", when: here, run: () => setMark(!S.mark) },
    { id: "reader.pin", title: "Pin a figure to the side", section: "Reader", keys: "P", when: here, run: () => setPin(true) },
    { id: "reader.unpin", title: "Unpin everything", section: "Reader", when: () => here() && pins.length > 0, run: () => { pins = []; pinCrops.clear(); savePins(); renderPins(); } },
    { id: "reader.find", title: "Find in this paper", section: "Reader", keys: "⌘F", when: here, run: () => openFind() },
    { id: "reader.page", title: "Go to page…", section: "Reader", keys: "G", when: here, run: () => { $("pageIn").focus(); $("pageIn").select(); } },
    { id: "reader.fit-width", title: "Zoom to fit width", section: "Reader", keys: "⌘0", when: here, run: () => fit("width") },
    { id: "reader.fit-page", title: "Zoom to fit page", section: "Reader", when: here, run: () => fit("page") },
    { id: "reader.zoom-in", title: "Zoom in", section: "Reader", keys: "⌘+", when: here, run: () => zoomStep(1) },
    { id: "reader.zoom-out", title: "Zoom out", section: "Reader", keys: "⌘−", when: here, run: () => zoomStep(-1) },
    { id: "reader.outline", title: "Show / hide outline", section: "Reader", when: here, run: () => setSide($("side").hidden) },
    { id: "reader.panel", title: "Show / hide marks and notes", section: "Reader", keys: "N", when: here, run: () => setPanel($("panel").hidden) },
    { id: "reader.notes", title: "Write notes on this paper", section: "Reader", when: here, run: () => { setPanel(true); setTab("notes"); $("gnText").focus(); } },
    { id: "reader.journal", title: "Get journal PDF", section: "Reader", when: () => here() && journal.canGet(store.item(cur.key)), run: () => $("journalBtn").click() },
    { id: "reader.cite", title: "Copy \\cite{…} for this paper", section: "Reader", when: here, run: () => { const c = "\\cite{" + cur.key + "}"; ui.copyText(c).then((ok) => ui.toast(ok ? "Copied " + c : "Couldn't copy.")); } },
    { id: "reader.reveal", title: "Show this paper in the library", section: "Reader", when: here, run: () => { const k = cur.key; ctx.openLibrary({ name: "library", filter: "all" }); setTimeout(() => store.emit("reveal", { keys: [k] }), 0); } },
  ]);


  return {
    async open(key, att) {
      if (cur && cur.key === key && cur.att === att && (S.pdf || loadTask)) { if (visible) scheduleRender(0); return; }
      await openDoc(key, att);
    },
    close(key, att) {
      if (!cur || cur.key !== key || cur.att !== att) { dropDoc(key + "/" + att); return; }   // a background tab: forget its kept PDF
      flushView(); flushSave(); flushNotes();
      ++openSeq; ++S.renderGen; cancelRender();
      closeComposer();
      dropDoc(S.doc);              // releases its pages and destroys its loading task
      loadTask = null;
      S.pages.forEach((P) => releasePage(P, true)); S.pages = []; S.pdf = null;
      destCache.clear(); pvCache.clear(); backStack.length = 0; histDepth = 0; showBack(); hidePreview();
      ++findSeq; finding = false; hits = []; hitAt = -1; pageText.clear();
      $("pages").innerHTML = "";
      pins = []; pinCrops.clear(); renderPins();
      cur = null; S.doc = null; needRestore = false;
    },
    show() {
      visible = true;
      setTimeout(() => {
        if (!visible) return;
        if (needRestore && S.pages.length) { needRestore = false; restoreView(); }   // it loaded while hidden
        else if (S.fitMode && S.pages.length) fit(S.fitMode); else scheduleRender(0);
        $("viewer").focus({ preventScroll: true });
        if (pendingJump) applyJump(pendingJump);     // a ⌘K jump that arrived while the reader was hidden
      }, 0);
    },
    hide() { flushView(); visible = false; hidePreview(); setMenu(false); flushSave(); flushNotes(); },
    hasUnsavedDraft: () => draftDirty(),
    focusDraft() { if (!$("composer").hidden) $("noteIn").focus({ preventScroll: true }); },
    onKey,
  };
}

