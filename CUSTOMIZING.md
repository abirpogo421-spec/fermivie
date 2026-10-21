# Making Paper Marker your own

Most changes need no code. They're covered first, then the options for starting it, then the code itself.

---

## 1. In the app (no code)

### Mark types

Click **Mark Types** in the library toolbar. The defaults are:

| Type | Meant for |
| --- | --- |
| Question | you don't follow why something is true or how one step leads to the next |
| Remark | something in the text should change (wording, a number, a claim), with optional suggested wording. Mostly for drafts |
| Explain | a concept or term you want explained from the ground up, by a collaborator or by yourself later (note optional) |
| Highlight | worth keeping. Saved instantly, no note needed |
| Cite | a claim or result you may cite. Saved instantly, exported with the paper's citation key and page |

In the editor you can add your own types (a name, a colour, and a line saying what it's for), rename, recolour or
reorder any type, and hide types you don't use. Question, Remark and Explain are built in: they can be hidden but
not removed. Any other type can be removed once no mark uses it, so no mark ever loses its type. Each type's
description is shown while you make that kind of mark and is written at the top of every `.marks.md` file, so
anyone reading your notes knows what each type means.

While writing a note, ⌃1 … ⌃9 switch between your visible types in order.

### Settings (⌘, or the gear icon)

| Section | Setting | What it does |
| --- | --- | --- |
| General | Tabs | across the top, or down the left side |
| Appearance | Theme | match the system, light, or dark |
| Appearance | Density | comfortable or compact rows |
| Reader | Zoom for a new paper | fit width, fit page, or 75–200 %. Papers you've opened before keep their own zoom |
| Reader | Page colour | normal, dimmed, or dark (inverted) pages for night reading |
| Reader | Show mark numbers on the page | the numbered flags in the margin |
| Reader | Show mark buttons when text is selected | the small toolbar that appears over selected text |
| Reader | Mark selected text with one key | each type's letter (Q, R, E, H, C) marks the selected text |
| Reader | Smooth scrolling when jumping to a mark | animate J / K jumps |
| Marking | Ask before deleting a mark | |
| Library & import | Default version | take the journal PDF or the arXiv PDF first when a paper has both |
| Library & import | No free PDF | when a journal's PDF can't be downloaded, add the paper's arXiv preprint instead (on by default) |
| Library & import | Folders to check | where **Get journal PDF** looks for downloads (Downloads and Desktop by default) |
| Profile | Profile folder, PDFs, Git / GitHub | where your profile is kept and how (see README, section 3) |
| Library & import | New project sections | the sections a new project starts with (default: To mark, Reference) |

Settings are saved in `library/settings.json`, so they travel with your library.

### Projects and order

To make a sub-project, right-click a project and choose **New Subproject…**. A project lists the papers of its
sub-projects too. Sections inside a project are yours to rename, add, reorder and delete. A deleted section's
papers move to the first section (or to the second, if you delete the first). The order you give papers is what
⌥↓ / ⌥↑ (next / previous paper) and the title menu in the reader follow.

---

## 2. Options when starting it

Set these as environment variables before starting:

- **Mac / Linux** (in Terminal, in the Paper Marker folder): `PORT=8300 sh start.sh`
- **Windows, Command Prompt** (type `cmd` in the folder's address bar): `set PORT=8300` then `py launch.py`.
  Don't put quotes around paths in `set`: `set LIBRARY_DIR=D:\My Papers`
- **Windows, PowerShell**: `$env:PORT = "8300"; py launch.py`

| Variable | What it does | Default |
| --- | --- | --- |
| `PORT` | first port to try | `8124` |
| `LIBRARY_DIR` | use a library folder somewhere else (a synced drive, or a separate library per topic). `~` works. A relative path is relative to where you start it from, so a full path is safest | `library/` in the app folder |
| `PM_NO_BROWSER` | set to `1` to not open a browser tab on start | unset |
| `PM_SEARCH_DIRS` | folders searched for downloaded journal PDFs, separated by `:` (`;` on Windows). While it's set, Settings > Folders to check is ignored | unset |

To keep two separate libraries, start a second copy with its own `LIBRARY_DIR`. It runs on the next free port,
and starting either one again opens the copy that already has that library. Each address remembers its own open
tabs, so give each library a fixed `PORT` if you bookmark them.

---

## 3. Changing the code

There is no build step and nothing to install: it's plain Python (standard library only) and plain JavaScript.
Edit a file, then:

- **CSS / JavaScript / HTML:** reload the browser tab (⌘R).
- **Python:** stop the app (close its window) and start it again.

### Where things are

```
launch.py            starts the server, picks a port, opens the browser
server.py            the local web server and its JSON API (answers on 127.0.0.1 only)
library_store.py     everything on disk: library.json, marks, notes, history backups, trash, settings
importers.py         turns links / IDs / DOIs / titles into metadata + PDFs (arXiv, Crossref, OpenAlex, ...)
published.py         journal PDF links per publisher, and finding downloaded PDFs in Downloads
userprofile.py       the profile folder: saving the whole library into it after each change, and loading it back
index.html           page shell; loads everything below
js/app.js            tabs, routing, app-wide keyboard shortcuts, paste-to-import
js/library.js        the library view: table, projects, sections, details pane, Add Paper dialog
js/reader.js         the PDF reader: rendering, marks, flags, find, side panel
js/store.js          client-side state (library, settings) and saving, with undo recording
js/api.js            one function per server endpoint
js/ui.js             shared widgets: menus, dialogs, toasts, icons
js/undo.js           the ⌘Z / ⌘⇧Z history
js/commands.js       the command registry that feeds ⌘K
js/palette.js        the ⌘K search
js/settings.js       the Settings page and the keyboard-shortcut list
js/marktypes.js      mark types: colours (PALETTE), styles, the Mark Types editor
js/order.js          "logical order" of papers in a project
js/journal.js        the Get journal PDF flow
css/base.css         colours, fonts, buttons, shared layout
css/library.css, css/reader.css, css/palette.css, css/settings.css
vendor/              pdf.js 3.11.174 (PDF rendering, with its fonts and character maps) and KaTeX 0.16.11 (math), unmodified
```

Comments in the code sometimes cite "CONTRACT.md §n". That was the internal build spec and isn't included.
The parts that matter (files on disk and the API) are summarized below.

### Common changes

**Colours and fonts.** At the top of `css/base.css`, `:root { ... }` holds the light theme's colours and `--font`.
The dark theme repeats the same names further down, twice: once for "system" when the computer is in dark mode,
and once for the explicit dark theme. Change all three blocks. To change the blue accent everywhere, set
`--accent`, `--accent-text`, `--sel`, `--sel-weak` and `--focus` in all three, and the `rgba(60, 110, 230, …)`
values in `css/reader.css` (text selection, link hover, the flash where you land, the box you draw).

**Mark colours.** The colours offered in the Mark Types editor are `PALETTE` in `js/marktypes.js`. Each has a
`base` colour plus `ink` / `inkDark` text colours for light and dark mode.

**Default mark types / default settings for new libraries.** `DEFAULT_MARK_TYPES` and `DEFAULT_SETTINGS` in
`library_store.py`. These only affect a library that doesn't have them yet. For an existing library, use the
Mark Types editor and Settings.

**A new command in ⌘K.** Keep your own code in its own file. Create `js/mine.js`:

```js
import * as commands from "./commands.js";

commands.register({
  id: "my.export-notes",            // unique
  title: "Export my notes",         // what ⌘K shows
  section: "Library",               // "Go to", "App", "Library", "Reader" or "Marking"
  keys: "",                         // optional shortcut label to display
  when: () => true,                 // optional: only offered when this returns true
  run: () => { /* ... */ },
});
```

and add `import "./mine.js";` next to the other imports at the top of `js/app.js`. (Files that already import
`commands`, such as `js/library.js`, can call `commands.register(...)` directly. Don't add the import a second time.)

**Keyboard shortcuts.** App-wide keys are in the document `keydown` listener under "global keys" in `js/app.js`,
library keys in `listKey` and the `keydown` listener in `js/library.js`, and reader keys in `navKey` / `onKey` in
`js/reader.js`. The list shown by **?** is `SHORTCUTS` in `js/settings.js` plus every registered command that has
`keys`, so update the list when you change a key.

**Another publisher for Get journal PDF.** Add its DOI prefix and PDF-URL pattern to `journal_pdf_urls` in
`published.py`.

**Importing from another site.** URL recognition is in `importers.py` (`parse_input` and the URL-classifying
helpers). Lookups go through `resolve()`.

### Files on disk

```
library/
  library.json                 all papers ("items"), projects, mark types
  settings.json                settings (created when you first change one)
  items/<paperKey>/
     <pdfKey>.pdf              each PDF of the paper (e.g. main.pdf)
     <pdfKey>.marks.json       the marks on that PDF
     <pdfKey>.marks.md         readable copy of the marks, rewritten on every save
     crops/                    image crops of boxed marks
     notes.md                  the paper's notes
  projects/<projectId>.md      project notes
  history/                     the last 50 saved versions of library.json, settings.json, each marks file and
                               each notes file (named <path with __>__<timestamp>)
  _deleted/                    papers removed by Empty Trash, removed PDFs, deleted projects' notes
                               (never hard-deleted; empty it yourself to free space)
```

A paper key looks like `bhalla2021quantum` (first author, year, first title word) and never changes. In
`library.json`, each item has the usual bibliographic fields (`title`, `authors` as `{given, family}`, `year`,
`venue`, `doi`, `arxiv`, `abstract`, ...), plus `projects` (project ids), `tags`, `read`, `attachments` (its PDFs)
and `trashed`. Each project has `id`, `name`, `parent`, and optionally `sections` and `placement`
(which section each paper is in, and its rank).

A mark looks like
`{id, num, type, kind: "text"|"box", page, quote, note, suggest, rects: [{p, x, y, w, h}], created, crop?}`,
with `rects` in page fractions. Every save goes through a revision check, so two open windows can't silently
overwrite each other.

Edit these files by hand only while the app is stopped. If something goes wrong, `history/` has the previous versions.

### The API (for scripts)

The server only answers on `127.0.0.1`. It refuses write requests whose `Origin` is anything other than
`http://localhost:<port>` or `http://127.0.0.1:<port>`, and requests with a body must be JSON (or `application/pdf`
for uploads). That way no web page you visit can change your library. A few useful calls:

| Call | Does |
| --- | --- |
| `GET /api/library` | everything in `library.json` (including project ids), plus mark counts |
| `POST /api/import` `{"input": "<link, ID, DOI or title>", "project": "<project id>"}` | add a paper |
| `POST /api/import/file?name=x.pdf&project=<project id>` with the PDF bytes | add a PDF |
| `GET /api/items/<key>/attachments/<pdfKey>/marks` | the marks on one PDF |
| `GET /api/search?q=<text>` | text search over abstracts, paper notes and marks (not titles or PDF text) |
| `GET /api/export/bibtex?project=<project id>` | BibTeX for a project (or `?keys=a,b`, or nothing for all) |

For example, from a Mac or Linux terminal while the app runs on port 8124 (use the address its window shows):

```bash
curl -s http://localhost:8124/api/export/bibtex > references.bib
curl -s -X POST http://localhost:8124/api/import \
  -H "Origin: http://localhost:8124" -H "Content-Type: application/json" \
  -d '{"input": "2108.04082"}'
curl -s -X POST "http://localhost:8124/api/import/file?name=draft.pdf" \
  -H "Origin: http://localhost:8124" -H "Content-Type: application/pdf" --data-binary @draft.pdf
```

On Windows, run these in Command Prompt with `curl.exe`, putting the JSON in double quotes with inner quotes
escaped (`-d "{\"input\": \"2108.04082\"}"`).

---

## 4. Updating later

To take a newer version, replace every file and folder except `library/`. The app reads older libraries as they
are and adds anything new (such as settings) with defaults.
