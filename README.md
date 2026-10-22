# Paper Marker

A private library and PDF reader for research papers. It runs on your own computer and opens in your browser.
You keep papers in projects, mark them up (questions, remarks, things to work through, highlights, citations, or
kinds you define yourself), and find anything again with one search.

Everything stays on your computer and there is no account, no cloud and no tracking. It goes online only to look papers up: when you add one by link, ID, DOI or title, when you drop in a PDF (it looks up the DOI, arXiv ID or
title it finds inside), and when you use **Fetch metadata** or **Get journal PDF**. Those lookups go to arXiv,
Crossref, OpenAlex and the publisher's site.

This copy is a blank starting point with no papers, no projects, the default mark types and default settings.

## Use it online

Open **<https://abirpogo421-spec.github.io/paper-marker/>**. The whole app runs in your browser; nothing is
installed and nothing is uploaded. Your library is kept in a folder you choose, in the same format as the
downloadable version, so one folder works with both.

| Browser | Where the library is kept |
|---|---|
| Chrome, Edge, Arc | A folder you choose (a new empty one, an existing library folder, or your profile folder). The app asks to reopen it on later visits. |
| Safari, Firefox | The browser's own storage for the site. Use **Settings > Profile** to download a copy (.zip) now and then, and to load a profile folder or zip. |

What's different online: papers are looked up through Crossref, OpenAlex, DataCite, Semantic Scholar, Europe PMC,
INSPIRE and arXiv. Journal web pages that don't let other sites read them can't be pasted as links; paste the DOI
or arXiv ID instead, or drop the PDF in. **Get journal PDF** opens the journal in a new tab; then choose your
Downloads folder (Chrome, Edge, Arc) or the downloaded file. Git saving of the profile needs the downloadable version.

---

## 1. Set up (about 5 minutes, once)

You need **Python 3.9 or newer** and a normal browser (Chrome, Safari, Firefox or Edge). Nothing else gets installed.

**Get it:** on GitHub, click **Code > Download ZIP** (or `git clone https://github.com/abirpogo421-spec/paper-marker`),
or use the zip you were sent.

### Mac

1. Unzip the file and move the **Paper Marker** folder somewhere permanent, such as your home folder
   (in Finder: Go > Home). Your library is kept inside this folder, so don't leave it in Downloads.
2. Double-click **`Start Paper Marker.command`**.
   - The first time, macOS says the file was **Not Opened** because Apple could not verify it. Click **Done**,
     open **System Settings > Privacy & Security**, scroll down and click **Open Anyway** next to
     "Start Paper Marker.command", confirm with your password, then click **Open Anyway** again.
     You only do this once. (On macOS 14 or older: right-click the file, choose **Open**, then **Open**.)
   - If it says the "python3" command needs the command line developer tools, click **Install** and wait for it
     to finish, or install Python from <https://www.python.org/downloads/>. Then double-click again.
3. A Terminal window opens, and the app opens in your browser at <http://localhost:8124>.
   **Leave the Terminal window open** while you use the app. Closing it stops the app.
   - macOS may ask whether Terminal can access your Documents, Downloads or Desktop folder. Click **Allow**.
     Paper Marker only reads PDFs there (that's how **Get journal PDF** finds what you download) and never
     moves or changes them.

### Windows

1. Install Python from <https://www.python.org/downloads/>. On the first installer screen, tick
   **"Add python.exe to PATH"**.
2. Right-click the zip > **Properties**, tick **Unblock** at the bottom, and click **OK**. This stops Windows from
   warning about every file.
3. Right-click the zip > **Extract All** and pick a permanent place that OneDrive doesn't sync, such as
   `C:\Users\<you>`. A **Paper Marker** folder is created there.
4. Open that folder and double-click **`Start Paper Marker.bat`**. If Windows shows "Windows protected your PC",
   click **More info**, then **Run anyway**.
5. A black window opens, and the app opens in your browser at <http://localhost:8124>.
   **Leave the window open** while you use the app. Closing it stops the app.

### Linux

You need python3 3.9 or newer (check with `python3 --version`; install it with your package manager, e.g.
`sudo apt install python3`). Then:

```bash
cd "Paper Marker"
sh start.sh
```

Ctrl+C stops it. Run the same command each time.

### Every day after that

Double-click the same Start file again. If the app is already running, it just opens it in your browser.
You can also bookmark <http://localhost:8124>. The bookmark works whenever the app is running.

If another program is using port 8124, Paper Marker uses the next free one (8125, 8126, ...). The window tells
you which address to use.

---

## 2. Using it

On Windows and Linux, use **Ctrl** wherever this guide or the app shows **⌘**, and **Alt** for **⌥**.

**Add papers.** Click **Add Paper** and type or paste any of these:

- an arXiv link or ID: `2108.04082`, `https://arxiv.org/abs/2108.04082`
- a DOI: `10.1103/PhysRevB.61.5337`
- a journal page link (APS, Nature, Science, IOP, ACS, Wiley, Springer, PNAS and others), or a direct PDF link
- a paper's title, to search for it

**Many at once.** Click **Add Paper > Add many…** (or paste several lines anywhere, or drop a `.bib` or text file onto
the window) and paste a list, a reference list copied from a paper, or a whole `.bib` file. You see every paper it
found, can leave some out and pick a project, then they're all added together.

To skip the dialog, press **⌘V** anywhere in the app to add an ID, DOI or link you've copied (titles only work in
the Add Paper box). If the journal's PDF is behind a paywall, Paper Marker finds the paper's arXiv preprint
and adds that instead, and tells you so. For a paper already in your library without a PDF, click **Find arXiv
version** in its Attachments. You can also drag PDF files from your computer onto the window. The app reads the DOI or
title inside the PDF and fills in the details. Adding a paper you already have just shows you your copy.

**Journal versions.** If you added the arXiv version of a paper that has since been published, select it and click
**Get journal PDF** (in the Attachments part of the right-hand pane, below the abstract, or at the top of the
reader). Your browser opens the journal's PDF using whatever access you already have (campus network, library
login). Download it (⌘S, or the journal's download button) and Paper Marker spots it in your Downloads folder and
attaches it. If it hasn't appeared after a few minutes, click **Get journal PDF** again: it picks up a PDF that's
already in Downloads. Paper Marker also checks Downloads and Desktop by itself whenever you add a paper with a DOI.
It only reads the files there and never changes them. You can choose which folders it checks in Settings.

**Projects.** Click **+** next to Projects to make one. Drag papers onto a project in the sidebar, or right-click
them and choose **Add to Project**. With one paper selected you can also tick projects under **Projects** in the
right-hand pane. If a project is open when you add a paper, the paper goes straight into it. A paper can be in
several projects.

Each project has two sections, **To mark** and **Reference**, which appear once it has papers. A new paper starts
in **Reference** and moves to **To mark** when you make your first mark on it, unless you've already dragged it
somewhere yourself. You can rename sections, add more (**New Section**), drag papers between them, and put papers
in order (drag, or ⌥↑ / ⌥↓).

**Reading and marking.** Double-click a paper to open it in a tab.

- Select text, then pick a mark type from the small toolbar that appears. To mark an area instead (an equation,
  a figure), switch to **Annotate** with the button at the top or the **`** key, and drag a box around it.
- Type your note and press ⌘↵ to save. You can write LaTeX like `$\chi^{(2)}$` in notes. It's kept exactly as
  you type it; the app doesn't typeset notes.
- Marks are numbered flags in the margin. **J** / **K** jump to the next or previous mark, and the side panel
  (**N**) lists them all.
- Click the paper's title at the top of the reader to see the other papers in its project, in your order, and
  switch between them.
- Every paper and every project also has a free-form notes page.

**Find anything.** Press **⌘K** to search papers, your marks, paper notes, project names and commands all at once.
**⌘P** jumps to a paper. **?** shows every keyboard shortcut.

**Undo.** ⌘Z undoes marks, trashing, moves and edits; ⌘⇧Z redoes. Deleted papers go to **Trash** first.

---

## 3. Your profile (take your library anywhere)

Paper Marker has no accounts. Instead, your **profile** is a folder you choose that holds your whole library:
papers, marks, notes, projects, settings and a copy of every PDF. Set it up once in **Settings > Profile >
Choose folder…**. After that it updates itself a few seconds after every change.

- **On another computer, or a fresh copy of Paper Marker:** an empty library shows **Load your profile…**, or use
  **Settings > Profile > Choose profile…**. Pick the folder and everything comes back. Papers you already have
  stay as they are.
- **Where to keep it:** a synced drive (iCloud Drive, Dropbox, OneDrive, Google Drive), a USB stick, or a **private**
  GitHub repository: make the repo, clone it, choose the cloned folder, and tick **Commit each save with git**
  (and **Also push**). Keep it private, because it holds your notes.
- The profile is a plain file, `paper-marker-profile.json`, plus a `pdfs/` folder, so you (or Claude) can read it
  without the app.

---

## 4. Your data

Everything you make is in the **`library`** folder inside the app folder:

| What | Where |
| --- | --- |
| The list of papers, projects and mark types | `library/library.json` |
| Each paper's PDFs | `library/items/<paper>/` (the first PDF is saved as `main.pdf`) |
| Your marks on a PDF | `library/items/<paper>/<pdf>.marks.json`, plus a readable `.marks.md` copy |
| Pictures of boxed areas | `library/items/<paper>/crops/` |
| Paper notes / project notes | `library/items/<paper>/notes.md`, `library/projects/<project id>.md` |
| Settings (after you first change one) | `library/settings.json` |
| Earlier versions of library.json, marks, notes and settings | `library/history/` |
| Papers removed with Empty Trash | `library/_deleted/` (delete what's in it to free space) |

`<paper>` is the paper's short key, like `bhalla2021quantum`. `<project id>` looks like `p_thesis_ch_2`.

- **Back it up** by copying the `library` folder anywhere (a cloud drive, an external disk).
- **Move to another computer** by copying the whole app folder, `library` included.
- **Update the app** by replacing every file and folder *except* `library` with the new version.
- The `.marks.md` files are plain text, so you can read, search or share your notes without the app.

---

## 5. If something goes wrong

| Problem | Fix |
| --- | --- |
| Browser says "This site can't be reached" | The app isn't running. Double-click the Start file again. |
| The window says "Python was not found" or "Python 3 isn't installed" (Windows) | Install Python from python.org, tick "Add python.exe to PATH", and double-click again. If you use Anaconda instead, open Anaconda Prompt, `cd` to the Paper Marker folder and run `python launch.py`. |
| "Python 3.9 or newer" message | Install a newer Python (python.org on Mac and Windows, your package manager on Linux). |
| "Unzip the whole Paper Marker folder first" (Windows) | You opened the Start file inside the zip. Extract the zip first (step 3), then use the Start file in the new folder. |
| A paper won't import ("blocked" / "couldn't download") | Some journals block automatic downloads. Download the PDF yourself and drag it in, or use **Get journal PDF**. |
| Changes don't show after an update | Reload the page (⌘R / Ctrl+R). |
| Something looks broken | Check the app's window for an error message. Your data is safe in `library/`, and `library/history/` keeps earlier copies. |

To change how it works or looks (your own mark types, settings, colours, where the library is kept, or the code
itself), see **CUSTOMIZING.md**.
