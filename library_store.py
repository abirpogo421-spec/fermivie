#!/usr/bin/env python3
"""Persistence layer for Paper Marker (CONTRACT.md §2, §9).

library.json + per-attachment marks files + notes, with rolling history,
atomic writes, revisions and a single write lock. Stdlib only.

Nothing here hard-deletes user data: trash is a flag, emptying the trash and
removing an attachment move files into library/_deleted/.
"""
from __future__ import annotations

import base64
import copy
import datetime
import hashlib
import json
import os
import re
import unicodedata
import shutil
import threading
import time

import importers

KEY_RE = re.compile(r"^[a-z0-9]{1,80}$")
ATT_RE = re.compile(r"^[a-z0-9-]{1,64}$")
PROJECT_RE = re.compile(r"^[a-z0-9_-]{1,64}$")
CROP_RE = re.compile(r"^[A-Za-z0-9_-][A-Za-z0-9._-]{0,200}\.png$")

TYPES = ("article", "preprint", "inproceedings", "book", "thesis", "manuscript", "misc")
READ_STATES = ("unread", "reading", "read")
STR_FIELDS = ("title", "date", "venue", "volume", "issue", "pages", "doi", "arxiv", "arxiv_version",
              "url", "publisher", "abstract")
META_FIELDS = ("type", "title", "authors", "year", "date", "venue", "volume", "issue", "pages", "doi",
               "arxiv", "arxiv_version", "url", "publisher", "abstract", "categories")
EDITABLE = META_FIELDS + ("tags", "projects", "read", "primary", "opened")
HISTORY_KEEP = 50
SEARCH_MAX_HITS = 500                                    # overall /api/search cap (no per-PDF cap on mark hits)
MARK_TYPES = ("question", "remark", "explain")          # the original three; always kept (marks use them)
TYPE_NAME = {"question": "Question", "remark": "Remark", "explain": "Explain"}
PALETTE = ("amber", "rose", "teal", "blue", "violet", "orange", "olive", "slate")
WINDOWS_RESERVED = {"con", "prn", "aux", "nul", *(f"com{i}" for i in range(1, 10)), *(f"lpt{i}" for i in range(1, 10))}
MARK_TYPE_ID = re.compile(r"^[a-z][a-z0-9-]{0,23}$")
RESERVED_TYPE_IDS = {"total", "error", "all", "constructor", "prototype", "toString", "hasOwnProperty"}
DEFAULT_MARK_TYPES = [
    {"id": "question", "name": "Question", "color": "amber",
     "purpose": "You don't follow why something is true or how one step leads to the next. Ask it in your own words.",
     "noteLabel": "Your question", "placeholder": "e.g. Why does the sign flip here?", "suggest": False, "hidden": False},
    {"id": "remark", "name": "Remark", "color": "rose",
     "purpose": "Something in the text should change: the wording, a number, a claim. Mostly for drafts you are writing or reviewing.",
     "noteLabel": "What should change", "placeholder": "e.g. Too long, cut the second clause", "suggest": True, "hidden": False},
    {"id": "explain", "name": "Explain", "color": "teal",
     "purpose": "A concept or term you want explained from the ground up, by a collaborator or by yourself later. The note can be left blank.",
     "noteLabel": "What's unclear (optional)", "placeholder": "Leave blank if the whole idea is unclear", "suggest": False, "hidden": False},
    {"id": "highlight", "name": "Highlight", "color": "olive",
     "purpose": "Worth keeping. No note needed; these are collected as the paper's highlights.",
     "noteLabel": "Note (optional)", "placeholder": "", "suggest": False, "hidden": False},
    {"id": "cite", "name": "Cite", "color": "violet",
     "purpose": "A claim or result you may cite in your own writing. Exported with the paper's citation key and page.",
     "noteLabel": "Where you'd use it (optional)", "placeholder": "e.g. Intro, background paragraph", "suggest": False, "hidden": False},
]


def default_mark_types():
    return json.loads(json.dumps(DEFAULT_MARK_TYPES))


def clean_mark_types(types):
    """Validate a list of mark types from the client. Raises bad() with a readable message."""
    if not isinstance(types, list) or not types:
        raise bad("There must be at least one mark type.")
    if len(types) > 24:
        raise bad("That's too many mark types (24 at most).")
    out, seen, names = [], set(), set()
    for t in types:
        if not isinstance(t, dict):
            raise bad("Bad mark type.")
        tid = str(t.get("id") or "").strip()
        if not MARK_TYPE_ID.match(tid):
            raise bad(f"'{tid}' isn't a valid type id (lowercase letters, digits and dashes).")
        if tid in RESERVED_TYPE_IDS:
            raise bad(f"'{tid}' is reserved; pick another name.")
        if tid in seen:
            raise bad(f"Two types share the id '{tid}'.")
        seen.add(tid)
        name = " ".join(str(t.get("name") or "").split())
        if not name or len(name) > 30:
            raise bad("Each mark type needs a name of at most 30 characters.")
        if name.casefold() in names:
            raise bad(f"Two types are called '{name}'. Give each type its own name.")
        names.add(name.casefold())
        color = t.get("color") if t.get("color") in PALETTE else "slate"
        def txt(k, n):
            v = t.get(k)
            return str(v)[:n] if isinstance(v, str) else ""
        out.append({"id": tid, "name": name, "color": color, "purpose": txt("purpose", 600),
                    "noteLabel": txt("noteLabel", 60) or "Note", "placeholder": txt("placeholder", 120),
                    "suggest": bool(t.get("suggest")), "hidden": bool(t.get("hidden"))})
    if all(t["hidden"] for t in out):
        raise bad("At least one mark type has to stay visible.")
    return out


class StoreError(Exception):
    """An error with an HTTP status and an optional extra payload."""

    def __init__(self, status, message, **extra):
        super().__init__(message)
        self.status = status
        self.message = message
        self.extra = extra


def bad(msg):
    return StoreError(400, msg)


def not_found(msg):
    return StoreError(404, msg)


def now_iso():
    return datetime.datetime.now().isoformat(timespec="seconds")


def _stamp():
    return datetime.datetime.now().strftime("%Y%m%d_%H%M%S_%f")


def _sec_stamp():
    return datetime.datetime.now().strftime("%Y%m%d_%H%M%S")


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def atomic_write(path, data: bytes):
    d = os.path.dirname(path)
    os.makedirs(d, exist_ok=True)
    tmp = os.path.join(d, f".{os.path.basename(path)}.{os.getpid()}.{threading.get_ident()}.tmp")
    try:
        with open(tmp, "wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        replace_retry(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)


def replace_retry(src, dst):
    """os.replace, retried briefly on Windows, where it fails while anything (a reader, antivirus, a sync
    client) has the target open."""
    for i in range(40):
        try:
            return os.replace(src, dst)
        except PermissionError:
            if os.name != "nt" or i == 39:
                raise
            time.sleep(0.05)


def dump_json(obj) -> bytes:
    return (json.dumps(obj, indent=1, ensure_ascii=False) + "\n").encode("utf-8")


def slug(s, maxlen=32, sep="-"):
    s = re.sub(r"[^a-z0-9]+", sep, importers._fold(str(s or "")).lower()).strip(sep)
    return s[:maxlen].strip(sep)


# ---------------------------------------------------------------------------------------------
# app settings (library/settings.json, CONTRACT.md §10.3)
# ---------------------------------------------------------------------------------------------

DEFAULT_SETTINGS = {
    "theme": "system", "tabs": "horizontal", "density": "comfortable",
    "reader": {"defaultZoom": "width", "pageTheme": "normal", "showFlags": True, "selectionToolbar": True,
               "quickKeys": True, "smoothScroll": True},
    "marks": {"confirmDelete": True},
    "library": {"preferJournal": True, "preprintFallback": True, "watchDirs": ["~/Downloads", "~/Desktop"],
                "newProjectSections": ["To mark", "Reference"]},
    "profile": {"folder": "", "includePdfs": True, "git": False, "push": False},
}
SETTING_CHOICES = {
    "theme": ("system", "light", "dark"),
    "tabs": ("horizontal", "vertical"),
    "density": ("comfortable", "compact"),
    "reader.pageTheme": ("normal", "dim", "dark"),
}


def default_settings():
    return copy.deepcopy(DEFAULT_SETTINGS)


def _str_items(v, what, max_n, max_len):
    if not isinstance(v, list) or not all(isinstance(x, str) for x in v):
        raise bad(f"{what} must be a list of text.")
    out = []
    for x in v:
        x = x.strip()
        if x and x not in out:
            if len(x) > max_len:
                raise bad(f"{what}: “{x[:40]}…” is too long.")
            out.append(x)
    if len(out) > max_n:
        raise bad(f"{what}: at most {max_n} entries.")
    return out


def _setting_value(path, cur, v):
    """Validate one value against the type of its default; returns the cleaned value."""
    if path in SETTING_CHOICES:
        if v not in SETTING_CHOICES[path]:
            raise bad(f"{path} must be one of: " + ", ".join(SETTING_CHOICES[path]) + ".")
        return v
    if path == "reader.defaultZoom":
        if v in ("width", "page"):
            return v
        try:
            n = int(str(v).rstrip("%"))
        except ValueError:
            raise bad("reader.defaultZoom must be width, page or a percentage.")
        if not 25 <= n <= 800:
            raise bad("reader.defaultZoom must be between 25 and 800 %.")
        return str(n)
    if path == "library.watchDirs":
        dirs = _str_items(v, "Folders to watch", 20, 500)
        for d in dirs:
            if not (d.startswith("~") or os.path.isabs(d) or re.match(r"^[A-Za-z]:[\\/]|^\\\\", d)):
                raise bad(f"“{d}” isn't a full folder path (start it with /, ~ or a drive letter).")
        return dirs
    if path == "profile.folder":
        if not isinstance(v, str) or len(v) > 500:
            raise bad("The profile folder must be a path.")
        v = v.strip()
        if v and not (v.startswith("~") or os.path.isabs(v) or re.match(r"^[A-Za-z]:[\\/]|^\\\\", v)):
            raise bad("Give the profile folder's full path (starting with /, ~ or a drive letter).")
        return v
    if path == "library.newProjectSections":
        secs = _str_items(v, "Sections for new projects", 20, 80)
        if not secs:
            raise bad("Sections for new projects: keep at least one section.")
        return secs
    if isinstance(cur, bool):
        if not isinstance(v, bool):
            raise bad(f"{path} must be true or false.")
        return v
    # a key added later by a view (not in the defaults): accept plain scalar values only
    if isinstance(v, bool) or (isinstance(v, (int, float)) and abs(v) < 1e9) or (isinstance(v, str) and len(v) <= 200):
        return v
    raise bad(f"{path} has an unsupported value.")


def merge_settings(base, patch):
    """Deep-merge a (partial) settings patch into base after validating every known key.
    Unknown top-level keys are dropped; unknown keys inside a known section must be plain values."""
    if not isinstance(patch, dict):
        raise bad("settings must be an object.")
    out = copy.deepcopy(base)
    for k, v in patch.items():
        if k not in DEFAULT_SETTINGS:
            continue
        d = DEFAULT_SETTINGS[k]
        if isinstance(d, dict):
            if not isinstance(v, dict):
                raise bad(f"{k} must be an object.")
            sec = out.get(k) if isinstance(out.get(k), dict) else {}
            for sk, sv in v.items():
                if not isinstance(sk, str) or not re.match(r"^[A-Za-z][A-Za-z0-9]{0,40}$", sk):
                    continue
                sec[sk] = _setting_value(f"{k}.{sk}", d.get(sk), sv)
            out[k] = sec
        else:
            out[k] = _setting_value(k, d, v)
    return out


def fill_settings(stored):
    """Stored settings on top of the defaults (stored values that no longer validate fall back)."""
    out = default_settings()
    if not isinstance(stored, dict):
        return out
    for k, v in stored.items():
        try:
            out = merge_settings(out, {k: v})
        except StoreError:
            if isinstance(v, dict) and isinstance(DEFAULT_SETTINGS.get(k), dict):
                for sk, sv in v.items():
                    try:
                        out = merge_settings(out, {k: {sk: sv}})
                    except StoreError:
                        pass
    return out


def is_pdf(data: bytes) -> bool:
    return data[:1024].lstrip(b"\x00\t\r\n\f ").startswith(b"%PDF-") or b"%PDF-" in data[:1024]


# ---------------------------------------------------------------------------------------------
# item normalisation
# ---------------------------------------------------------------------------------------------

def _authors(v):
    out = []
    for a in v or []:
        if isinstance(a, dict):
            given = str(a.get("given") or "").strip()
            family = str(a.get("family") or "").strip()
            if not family and given:
                family, given = given, ""
            if family:
                out.append({"given": given, "family": family})
        elif isinstance(a, str) and a.strip():
            sa = importers._split_name(a)
            if sa:
                out.append(sa)
    return out


def _year(v):
    if v in (None, ""):
        return None
    try:
        y = int(str(v).strip()[:4]) if not isinstance(v, int) else v
    except (TypeError, ValueError):
        return None
    return y if 1000 <= y <= 2999 else None


def _str_list(v):
    out = []
    for x in v or []:
        if isinstance(x, str) and x.strip() and x.strip() not in out:
            out.append(x.strip())
    return out


def clean_meta(meta):
    """Importer META (or a client dict) -> the metadata fields of an item, all present."""
    m = meta if isinstance(meta, dict) else {}
    out = {}
    for k in STR_FIELDS:
        v = m.get(k)
        out[k] = "" if v is None else str(v)
    t = m.get("type")
    out["type"] = t if t in TYPES else "misc"
    out["authors"] = _authors(m.get("authors"))
    out["year"] = _year(m.get("year"))
    if out["year"] is None and re.match(r"^\d{4}", out["date"]):
        out["year"] = _year(out["date"][:4])
    out["categories"] = _str_list(m.get("categories"))
    if out["arxiv"]:
        mm = re.match(r"^(.*?)(v\d+)$", out["arxiv"])
        if mm and re.search(r"\d", mm.group(1)):
            out["arxiv"] = mm.group(1)
            out["arxiv_version"] = out["arxiv_version"] or mm.group(2)
    return out


def new_item(key, meta, projects=(), tags=()):
    t = now_iso()
    item = {"key": key}
    item.update(clean_meta(meta))
    item.update({
        "tags": _str_list(tags), "projects": list(projects), "read": "unread",
        "added": t, "modified": t, "opened": None, "primary": "", "attachments": [], "trashed": None,
    })
    return item


def item_meta(item):
    """Item -> META for importers.bibtex / citekey."""
    m = {k: item.get(k) for k in META_FIELDS}
    if m.get("type") == "manuscript":
        m["type"] = "misc"
    return m


# ---------------------------------------------------------------------------------------------
# marks.md
# ---------------------------------------------------------------------------------------------

def marks_md(item_title, att_label, key, att, doc, data, types=None):
    """The original marks.md layout plus a first line naming the item and attachment,
    and a legend saying what each mark type used here is for."""
    marks = sorted(data.get("marks", []), key=lambda m: (m.get("page", 0) or 0, m.get("y", 0) or 0))
    saved = data.get("savedAt") or now_iso()
    try:
        saved_s = datetime.datetime.fromisoformat(saved).strftime("%Y-%m-%d %H:%M")
    except (TypeError, ValueError):
        saved_s = str(saved)
    L = [f"Item: {item_title or key} | Attachment: {att_label or att} (library/items/{key}/{att}.pdf)",
         f"# Marks on {doc}", "",
         f"Saved {saved_s} | {len(marks)} marks", ""]
    types = types or DEFAULT_MARK_TYPES
    tmap = {t["id"]: t for t in types}
    used = [t for t in types if any(m.get("type") == t["id"] for m in marks)]
    stray = sorted({m.get("type") for m in marks if isinstance(m.get("type"), str) and m.get("type")} - set(tmap))
    used += [{"id": i, "name": i, "purpose": ""} for i in stray]
    one_line = lambda x: " ".join(str(x or "").split())
    for t in (used or [t for t in types if t["id"] in MARK_TYPES]):
        n = sum(1 for m in marks if m.get("type") == t["id"])
        L.append(f"- {one_line(t['name'])}: {n}" + (f" — {one_line(t['purpose'])}" if t.get("purpose") else ""))
    L.append("")
    for m in marks:
        tname = tmap[m.get("type")]["name"] if m.get("type") in tmap else TYPE_NAME.get(m.get("type"), m.get("type") or "Mark")
        L.append(f"## #{m.get('num')} {tname} (p. {m.get('page')})")
        if m.get("quote"):
            q = str(m["quote"])
            lines = [x for x in (y.strip() for y in q.split("\n")) if x]
            eq = m.get("eq") or (m.get("kind") != "box" and len(lines) >= 3 and len("".join(q.split())) / len(lines) < 10)
            # an equation's text layer is a jumble of fragments: the picture below shows it properly
            L.append("> (equation: see the picture below)" if eq and m.get("crop") else "> " + " ".join(q.split()))
        if m.get("note"):
            L.append(f"\n**Note:** {m['note']}")
        if m.get("suggest"):
            L.append(f"\n**Suggested wording:** {m['suggest']}")
        if m.get("crop"):
            L.append(f"\n![crop](crops/{m['crop']})")
        L.append("")
    return "\n".join(L)


def count_marks(marks):
    """Counts per mark type id (any type, built-in or custom) plus the total."""
    c = {"question": 0, "remark": 0, "explain": 0, "total": 0}
    for m in marks or []:
        t = m.get("type") if isinstance(m, dict) else None
        if isinstance(t, str) and t and t not in RESERVED_TYPE_IDS:
            c[t] = c.get(t, 0) + 1
        c["total"] += 1
    return c


# ---------------------------------------------------------------------------------------------
# the store
# ---------------------------------------------------------------------------------------------

class Library:
    def __init__(self, root):
        self.root = os.path.abspath(root)
        self.lock = threading.RLock()
        self.cond = threading.Condition()   # guards import reservations (never held with .lock first)
        self.inflight = set()               # identifiers being imported right now
        self.reserved = set()               # item keys reserved by running imports
        self._stats_cache = {}
        for d in ("items", "projects", "history", "_deleted"):
            os.makedirs(os.path.join(self.root, d), exist_ok=True)

    # ---- paths ----------------------------------------------------------------------------
    @property
    def lib_path(self):
        return os.path.join(self.root, "library.json")

    def item_dir(self, key):
        if not KEY_RE.match(key or ""):
            raise not_found("No such paper.")
        return os.path.join(self.root, "items", key)

    def marks_path(self, key, att):
        if not ATT_RE.match(att or ""):
            raise not_found("No such attachment.")
        return os.path.join(self.item_dir(key), f"{att}.marks.json")

    def rel(self, path):
        return os.path.relpath(path, self.root)

    # ---- history ----------------------------------------------------------------------------
    def backup(self, path):
        """Copy path into history/ (exact-identity rotation, newest HISTORY_KEEP kept)."""
        if not os.path.exists(path):
            return None
        hist = os.path.join(self.root, "history")
        os.makedirs(hist, exist_ok=True)
        flat = self.rel(path).replace(os.sep, "__")
        name = f"{flat}__{_stamp()}"
        n = 1
        while os.path.exists(os.path.join(hist, name)):
            name = f"{flat}__{_stamp()}_{n}"
            n += 1
        shutil.copy2(path, os.path.join(hist, name))
        pat = re.compile(r"^" + re.escape(flat) + r"__\d{8}_\d{6}_\d{6}(?:_\d+)?$")
        mine = sorted(f for f in os.listdir(hist) if pat.match(f))
        for old in mine[:-HISTORY_KEEP]:
            try:
                os.remove(os.path.join(hist, old))
            except OSError:
                pass
        return name

    # ---- library.json -------------------------------------------------------------------------
    def load(self):
        with self.lock:
            return self._load_unlocked()

    def _load_unlocked(self):
        p = self.lib_path
        if not os.path.exists(p):
            return {"version": 1, "items": {}, "projects": [], "savedAt": None}
        try:
            with open(p, "rb") as f:
                lib = json.loads(f.read().decode("utf-8"))
            if not isinstance(lib, dict) or not isinstance(lib.get("items"), dict) \
                    or not isinstance(lib.get("projects"), list):
                raise ValueError("unexpected structure")
        except (ValueError, UnicodeDecodeError, OSError) as e:
            raise StoreError(500, f"library.json is unreadable ({e}). Nothing was changed; "
                                  f"restore it from library/history/.", corrupt=True)
        return lib

    def save(self, lib, backup=True):
        with self.lock:
            lib["version"] = 1
            lib["savedAt"] = now_iso()
            if backup:
                self.backup(self.lib_path)
            atomic_write(self.lib_path, dump_json(lib))

    def get_item(self, lib, key):
        it = lib["items"].get(key) if KEY_RE.match(key or "") else None
        if not it:
            raise not_found(f"No paper with key {key!r}.")
        return it

    def project_ids(self, lib):
        return {p["id"] for p in lib["projects"]}

    def _unique_key(self, lib, base):
        base = re.sub(r"[^a-z0-9]", "", base or "") or "anonnd"
        base = base[:60]
        taken = set(lib["items"]) | self.reserved
        items_dir = os.path.join(self.root, "items")

        def free(k):
            return k not in taken and not os.path.exists(os.path.join(items_dir, k))
        if free(base):
            return base
        for c in "bcdefghijklmnopqrstuvwxyz":
            if free(base + c):
                return base + c
        n = 2
        while not free(f"{base}{n}"):
            n += 1
        return f"{base}{n}"

    # ---- library + stats ------------------------------------------------------------------------
    def _att_counts(self, path):
        try:
            st = os.stat(path)
        except FileNotFoundError:
            return {"question": 0, "remark": 0, "explain": 0, "total": 0}
        sig = (st.st_mtime_ns, st.st_size)
        hit = self._stats_cache.get(path)
        if hit and hit[0] == sig:
            return dict(hit[1])
        try:
            with open(path, "rb") as f:
                data = json.loads(f.read().decode("utf-8"))
            c = count_marks(data.get("marks"))
        except Exception:
            c = {"question": 0, "remark": 0, "explain": 0, "total": 0, "error": "unreadable marks file"}
        self._stats_cache[path] = (sig, c)
        return dict(c)

    def stats(self, lib):
        out = {}
        for key, it in lib["items"].items():
            per = {}
            tot = {"question": 0, "remark": 0, "explain": 0, "total": 0}
            for a in it.get("attachments", []):
                c = self._att_counts(os.path.join(self.root, "items", key, f"{a['key']}.marks.json"))
                per[a["key"]] = c
                for k, v in c.items():
                    if isinstance(v, int):
                        tot[k] = tot.get(k, 0) + v
            np = os.path.join(self.root, "items", key, "notes.md")
            try:
                has_notes = os.path.getsize(np) > 0
            except OSError:
                has_notes = False
            out[key] = {"marks": tot, "perAttachment": per, "hasNotes": has_notes}
        return out

    # ---- items ------------------------------------------------------------------------------------
    def create_item(self, meta, project=None, key=None, tags=()):
        with self.lock:
            lib = self.load()
            projects = []
            if project:
                if project not in self.project_ids(lib):
                    raise bad("That project does not exist.")
                projects = [project]
            k = key or self._unique_key(lib, importers.citekey(item_meta(clean_meta(meta))))
            if k in lib["items"]:
                raise bad(f"Key {k!r} is already used.")
            it = new_item(k, meta, projects, tags)
            os.makedirs(self.item_dir(k), exist_ok=True)
            lib["items"][k] = it
            self.save(lib)
            return copy.deepcopy(it)

    def _validate_patch(self, lib, it, patch):
        if not isinstance(patch, dict) or not patch:
            raise bad("Nothing to change.")
        out = {}
        for k, v in patch.items():
            if k not in EDITABLE:
                raise bad(f"Field {k!r} cannot be edited.")
            if k in STR_FIELDS:
                if v is None:
                    v = ""
                if not isinstance(v, str):
                    raise bad(f"{k} must be text.")
            elif k == "type":
                if v not in TYPES:
                    raise bad("Unknown item type.")
            elif k == "authors":
                if not isinstance(v, list):
                    raise bad("authors must be a list.")
                v = _authors(v)
            elif k == "year":
                if v not in (None, "") and _year(v) is None:
                    raise bad("year must be a 4-digit number.")
                v = _year(v)
            elif k in ("categories", "tags"):
                if not isinstance(v, list):
                    raise bad(f"{k} must be a list.")
                v = _str_list(v)
            elif k == "projects":
                if not isinstance(v, list):
                    raise bad("projects must be a list.")
                ids = self.project_ids(lib)
                v = _str_list(v)
                if any(p not in ids for p in v):
                    raise bad("Unknown project.")
            elif k == "read":
                if v not in READ_STATES:
                    raise bad("read must be unread, reading or read.")
            elif k == "primary":
                if v not in [a["key"] for a in it.get("attachments", [])]:
                    raise bad("primary must be one of the paper's attachments.")
            elif k == "opened":
                if v is not None and not isinstance(v, str):
                    raise bad("opened must be a timestamp or null.")
            out[k] = v
        return out

    def patch_item(self, key, patch):
        with self.lock:
            lib = self.load()
            it = self.get_item(lib, key)
            changes = self._validate_patch(lib, it, patch)
            it.update(changes)
            if set(changes) - {"opened", "read"}:
                it["modified"] = now_iso()
            # "opened" is bookkeeping (Recently Opened), not an edit: every paper open / tab switch sends one,
            # so spending a history slot on it would evict the real states history exists to keep.
            self.save(lib, backup=bool(set(changes) - {"opened"}))
            return copy.deepcopy(it)

    def apply_meta(self, key, meta, overwrite=False):
        """Fill empty metadata fields of an item from importer META (all if overwrite)."""
        with self.lock:
            lib = self.load()
            it = self.get_item(lib, key)
            new = clean_meta(meta)
            changed = False
            for k in META_FIELDS:
                nv = new.get(k)
                if nv in ("", None, []) or (k == "type" and nv == "misc"):
                    continue
                cur = it.get(k)
                empty = cur in ("", None, []) or (k == "type" and cur == "misc")
                if (overwrite or empty) and cur != nv:
                    it[k] = nv
                    changed = True
            if changed:
                it["modified"] = now_iso()
                self.save(lib)
            return copy.deepcopy(it)

    def set_trashed(self, key, trashed):
        with self.lock:
            lib = self.load()
            it = self.get_item(lib, key)
            it["trashed"] = now_iso() if trashed else None
            self.save(lib)
            return copy.deepcopy(it)

    def empty_trash(self):
        with self.lock:
            lib = self.load()
            moved = []
            stamp = _sec_stamp()
            for key, it in list(lib["items"].items()):
                if not it.get("trashed"):
                    continue
                dest = os.path.join(self.root, "_deleted", f"{stamp}_{key}")
                n = 2
                while os.path.exists(dest):
                    dest = os.path.join(self.root, "_deleted", f"{stamp}_{key}_{n}")
                    n += 1
                src = os.path.join(self.root, "items", key)
                if os.path.isdir(src):
                    shutil.move(src, dest)
                else:
                    os.makedirs(dest, exist_ok=True)
                atomic_write(os.path.join(dest, "item.json"), dump_json(it))
                del lib["items"][key]
                moved.append(key)
            if moved:
                self.save(lib)
            return moved

    def bulk(self, body):
        if not isinstance(body, dict):
            raise bad("Bad request.")
        keys = body.get("keys")
        if not isinstance(keys, list) or not keys or not all(isinstance(k, str) for k in keys):
            raise bad("keys must be a non-empty list.")
        with self.lock:
            lib = self.load()
            items = [self.get_item(lib, k) for k in keys]
            ids = self.project_ids(lib)
            add_p = _str_list(body.get("addProjects"))
            rem_p = _str_list(body.get("removeProjects"))
            if any(p not in ids for p in add_p):
                raise bad("Unknown project.")
            add_t = _str_list(body.get("addTags"))
            rem_t = _str_list(body.get("removeTags"))
            read = body.get("read")
            if read is not None and read not in READ_STATES:
                raise bad("read must be unread, reading or read.")
            t = now_iso()
            for it in items:
                before = json.dumps(it, sort_keys=True)
                for p in add_p:
                    if p not in it["projects"]:
                        it["projects"].append(p)
                it["projects"] = [p for p in it["projects"] if p not in rem_p]
                for tg in add_t:
                    if tg not in it["tags"]:
                        it["tags"].append(tg)
                it["tags"] = [tg for tg in it["tags"] if tg not in rem_t]
                if body.get("trash") is True and not it.get("trashed"):
                    it["trashed"] = t
                if body.get("restore") is True:
                    it["trashed"] = None
                if read is not None:
                    it["read"] = read
                if json.dumps(it, sort_keys=True) != before and (add_p or rem_p or add_t or rem_t):
                    it["modified"] = t
            self.save(lib)
            return copy.deepcopy(items)

    # ---- duplicates -------------------------------------------------------------------------------
    def find_duplicate(self, lib, doi="", arxiv="", sha=""):
        doi = (doi or "").strip().lower()
        ax = re.sub(r"v\d+$", "", (arxiv or "").strip().lower())
        for key, it in lib["items"].items():
            if it.get("trashed"):
                continue
            if doi and (it.get("doi") or "").strip().lower() == doi:
                return key
            if ax and re.sub(r"v\d+$", "", (it.get("arxiv") or "").strip().lower()) == ax:
                return key
            if sha and any(a.get("sha256") == sha for a in it.get("attachments", [])):
                return key
        return None

    def add_to_project(self, key, project):
        if not project:
            return None
        with self.lock:
            lib = self.load()
            it = self.get_item(lib, key)
            if project not in self.project_ids(lib):
                raise bad("That project does not exist.")
            if project not in it["projects"]:
                it["projects"].append(project)
                self.save(lib)
            return copy.deepcopy(it)

    # ---- import reservations ----------------------------------------------------------------------
    def reserve(self, idents, base_key):
        """Wait until no other import is busy with the same identifiers, then reserve a key.
        Returns (key, duplicate_key)."""
        idents = {i for i in idents if i}
        with self.cond:
            while idents & self.inflight:
                self.cond.wait(timeout=180)
            lib = self.load()
            dup = None
            for i in idents:
                kind, _, val = i.partition(":")
                dup = self.find_duplicate(lib, **{kind: val})
                if dup:
                    break
            if dup:
                return None, dup
            key = self._unique_key(lib, base_key)
            self.reserved.add(key)
            self.inflight |= idents
            return key, None

    def release(self, idents, key):
        with self.cond:
            self.inflight -= {i for i in idents if i}
            self.reserved.discard(key)
            self.cond.notify_all()

    # ---- attachments ------------------------------------------------------------------------------
    def _new_att_key(self, it, label="", prefer=None):
        keys = {a["key"] for a in it.get("attachments", [])}
        d = os.path.join(self.root, "items", it["key"])
        if prefer and ATT_RE.match(prefer) and prefer not in keys and not os.path.exists(os.path.join(d, prefer + ".pdf")):
            return prefer
        if not keys and not os.path.exists(os.path.join(d, "main.pdf")):
            return "main"
        base = slug(label, 24) or "pdf"
        if base in WINDOWS_RESERVED:   # con.pdf, aux.pdf … are devices on Windows
            base += "-pdf"
        k, n = base, 2
        while k in keys or os.path.exists(os.path.join(d, k + ".pdf")) or os.path.exists(os.path.join(d, k + ".marks.json")):
            k = f"{base}-{n}"
            n += 1
        return k

    def add_attachment_file(self, key, src_path, label, source="file", url="", prefer=None, move=True):
        """Put the PDF at src_path into the item as a new attachment (src is moved when move=True:
        callers pass a temp file they own; user files are always copied)."""
        with self.lock:
            lib = self.load()
            it = self.get_item(lib, key)
            sha = sha256_file(src_path)
            for a in it.get("attachments", []):
                if a.get("sha256") == sha:
                    raise StoreError(409, "That PDF is already attached to this paper.", duplicate=True)
            att = self._new_att_key(it, label, prefer)
            dest = os.path.join(self.item_dir(key), f"{att}.pdf")
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            if move:
                os.replace(src_path, dest)
            else:
                shutil.copy2(src_path, dest)
            a = {"key": att, "label": label or att, "file": f"{att}.pdf", "source": source, "url": url or "",
                 "added": now_iso(), "bytes": os.path.getsize(dest), "sha256": sha, "pages": 0}
            it.setdefault("attachments", []).append(a)
            if not it.get("primary") or it["primary"] not in [x["key"] for x in it["attachments"]]:
                it["primary"] = att
            it["modified"] = now_iso()
            self.save(lib)
            return copy.deepcopy(it), copy.deepcopy(a)

    def rename_attachment(self, key, att, label):
        if not isinstance(label, str) or not label.strip():
            raise bad("label must be non-empty text.")
        with self.lock:
            lib = self.load()
            it = self.get_item(lib, key)
            a = next((x for x in it.get("attachments", []) if x["key"] == att), None)
            if not a:
                raise not_found("No such attachment.")
            a["label"] = label
            it["modified"] = now_iso()
            self.save(lib)
            return copy.deepcopy(it)

    def remove_attachment(self, key, att):
        with self.lock:
            lib = self.load()
            it = self.get_item(lib, key)
            a = next((x for x in it.get("attachments", []) if x["key"] == att), None)
            if not a:
                raise not_found("No such attachment.")
            d = self.item_dir(key)
            dest = os.path.join(self.root, "_deleted", f"{_sec_stamp()}_{key}_{att}")
            n = 2
            while os.path.exists(dest):
                dest = os.path.join(self.root, "_deleted", f"{_sec_stamp()}_{key}_{att}_{n}")
                n += 1
            os.makedirs(os.path.join(dest, "crops"), exist_ok=True)
            mp = os.path.join(d, f"{att}.marks.json")
            crops = []
            if os.path.exists(mp):
                try:
                    with open(mp, "rb") as f:
                        crops = [m.get("crop") for m in json.loads(f.read().decode("utf-8")).get("marks", [])
                                 if isinstance(m, dict) and m.get("crop")]
                except Exception:
                    crops = []
            for fn in (a.get("file") or f"{att}.pdf", f"{att}.marks.json", f"{att}.marks.md"):
                p = os.path.join(d, fn)
                if os.path.exists(p):
                    shutil.move(p, os.path.join(dest, fn))
            for c in crops:
                if isinstance(c, str) and CROP_RE.match(c):
                    p = os.path.join(d, "crops", c)
                    if os.path.exists(p):
                        shutil.move(p, os.path.join(dest, "crops", c))
            atomic_write(os.path.join(dest, "attachment.json"), dump_json({"item": key, "attachment": a}))
            it["attachments"] = [x for x in it["attachments"] if x["key"] != att]
            if it.get("primary") == att:
                it["primary"] = it["attachments"][0]["key"] if it["attachments"] else ""
            it["modified"] = now_iso()
            self.save(lib)
            return copy.deepcopy(it)

    # ---- marks ------------------------------------------------------------------------------------
    def _att(self, lib, key, att):
        it = self.get_item(lib, key)
        a = next((x for x in it.get("attachments", []) if x["key"] == att), None)
        if not a:
            raise not_found(f"No attachment {att!r} on this paper.")
        return it, a

    def read_marks_file(self, path):
        with self.lock:
            return self._read_marks_file_unlocked(path)

    def _read_marks_file_unlocked(self, path):
        """-> dict or None if missing; raises StoreError(500) when unreadable."""
        if not os.path.exists(path):
            return None
        try:
            with open(path, "rb") as f:
                data = json.loads(f.read().decode("utf-8"))
            if not isinstance(data, dict) or not isinstance(data.get("marks"), list):
                raise ValueError("no marks list")
        except (ValueError, UnicodeDecodeError, OSError) as e:
            raise StoreError(500, f"The marks file {self.rel(path)} is unreadable ({e}). Nothing was "
                                  f"changed; fix or restore it from library/history/ before saving.", corrupt=True)
        return data

    @staticmethod
    def _rev(data):
        if data is None:
            return 0
        r = data.get("rev")
        return r if isinstance(r, int) and r >= 0 else 1

    def get_marks(self, key, att):
        lib = self.load()
        it, a = self._att(lib, key, att)
        data = self.read_marks_file(self.marks_path(key, att))
        if data is None:
            return {"item": key, "attachment": att, "doc": a.get("label") or a.get("file"),
                    "marks": [], "savedAt": None, "rev": 0}
        return {"item": key, "attachment": att, "doc": data.get("doc") or a.get("label"),
                "marks": data["marks"], "savedAt": data.get("savedAt"), "rev": self._rev(data)}

    def save_marks(self, key, att, marks, base_rev, force=False):
        if not isinstance(marks, list) or not all(isinstance(m, dict) for m in marks):
            raise bad("marks must be a list of objects.")
        with self.lock:
            lib = self.load()
            it, a = self._att(lib, key, att)
            path = self.marks_path(key, att)
            cur = self.read_marks_file(path)
            rev = self._rev(cur)
            if not force:
                br = 0 if base_rev is None else base_rev
                if not isinstance(br, int) or isinstance(br, bool) or br != rev:
                    raise StoreError(409, "These marks were changed somewhere else.", conflict=True, rev=rev,
                                     marks=(cur or {}).get("marks", []), savedAt=(cur or {}).get("savedAt"))
            # decode crops first, so a bad crop writes nothing
            crops = []
            for m in marks:
                cd = m.get("cropData")
                if cd is None:
                    continue
                if not isinstance(cd, str) or not cd.startswith("data:image/png;base64,"):
                    raise bad("cropData must be a PNG data URL.")
                try:
                    png = base64.b64decode(cd.split(",", 1)[1], validate=True)
                except (ValueError, base64.binascii.Error):
                    raise bad("cropData is not valid base64.")
                if not png.startswith(b"\x89PNG"):
                    raise bad("cropData is not a PNG.")
                safe_id = re.sub(r"[^A-Za-z0-9_-]", "_", str(m.get("id")))[:80] or "mark"
                crops.append((m, f"{att}_{safe_id}.png", png))
            for m, fn, png in crops:
                atomic_write(os.path.join(self.item_dir(key), "crops", fn), png)
                del m["cropData"]
                m["crop"] = fn
            for m in marks:   # cropData that was null/absent is never stored
                m.pop("cropData", None)
            data = {"item": key, "attachment": att,
                    "doc": (cur or {}).get("doc") or a.get("label") or a.get("file"),
                    "marks": marks, "savedAt": now_iso(), "rev": rev + 1}
            self.backup(path)
            atomic_write(path, dump_json(data))
            self.write_md(it, a, data)
            return {"savedAt": data["savedAt"], "rev": data["rev"], "marks": marks}

    # ---- mark types ---------------------------------------------------------------------------------
    def mark_types(self, lib=None):
        lib = lib if lib is not None else self.load()
        mt = lib.get("markTypes")
        if not isinstance(mt, list) or not mt:
            return default_mark_types()
        try:
            return clean_mark_types(mt)
        except StoreError:
            return default_mark_types()

    def set_mark_types(self, types, base_rev=None, force=False):
        types = clean_mark_types(types)
        if base_rev is not None and (isinstance(base_rev, bool) or not isinstance(base_rev, int)):
            raise bad("baseRev must be a whole number.")
        with self.lock:
            lib = self.load()
            cur_rev = int(lib.get("markTypesRev") or 0)
            if not force and base_rev is not None and base_rev != cur_rev:
                raise StoreError(409, "Mark types were changed in another window. Close this and open Mark Types again.",
                                 conflict=True, rev=cur_rev, types=self.mark_types(lib))
            old = {t["id"] for t in self.mark_types(lib)}
            keep = {t["id"] for t in types}
            in_use = {}
            for key, st in self.stats(lib).items():
                for k, v in st["marks"].items():
                    if k != "total" and isinstance(v, int) and v:
                        in_use[k] = in_use.get(k, 0) + v
            gone = [f"{k} ({n} marks)" for k, n in in_use.items() if k in old and k not in keep]
            if gone:
                raise bad("These types are still in use, so they can be hidden but not removed: " + ", ".join(gone) + ".")
            builtin = [b for b in MARK_TYPES if b not in keep]
            if builtin:
                raise bad("Question, Remark and Explain are built in: hide them instead of removing them.")
            lib["markTypes"] = types
            lib["markTypesRev"] = cur_rev + 1
            self.save(lib)
            # keep every marks.md legend in step with the new names and descriptions
            for key, it in lib["items"].items():
                for a in it.get("attachments", []):
                    p = self.marks_path(key, a["key"])
                    if os.path.exists(p):
                        try:
                            self.write_md(it, a, self.read_marks_file(p), types=types)
                        except Exception:
                            pass
            return types, cur_rev + 1

    # ---- settings -------------------------------------------------------------------------------
    @property
    def settings_path(self):
        return os.path.join(self.root, "settings.json")

    def _read_settings(self):
        with self.lock:
            return self._read_settings_unlocked()

    def _read_settings_unlocked(self):
        p = self.settings_path
        if not os.path.exists(p):
            return {}
        try:
            with open(p, "rb") as f:
                data = json.loads(f.read().decode("utf-8"))
            if not isinstance(data, dict):
                raise ValueError("not an object")
            return data
        except (ValueError, UnicodeDecodeError, OSError) as e:
            raise StoreError(500, f"settings.json is unreadable ({e}). Nothing was changed; "
                                  f"fix or delete library/settings.json.", corrupt=True)

    def get_settings(self):
        return fill_settings(self._read_settings())

    def set_settings(self, patch):
        with self.lock:
            merged = merge_settings(fill_settings(self._read_settings()), patch)
            merged["savedAt"] = now_iso()
            self.backup(self.settings_path)
            atomic_write(self.settings_path, dump_json(merged))
            return fill_settings(merged)

    def write_md(self, it, a, data, types=None):
        key, att = it["key"], a["key"]
        if types is None:
            try:
                types = self.mark_types()
            except StoreError:
                types = None
        text = marks_md(it.get("title"), a.get("label"), key, att, data.get("doc") or a.get("label"), data, types)
        atomic_write(os.path.join(self.item_dir(key), f"{att}.marks.md"), text.encode("utf-8"))

    # ---- notes ------------------------------------------------------------------------------------
    def _notes_paths(self, kind, ident):
        if kind == "item":
            d = self.item_dir(ident)
            return os.path.join(d, "notes.md"), os.path.join(d, "notes.rev.json")
        if not PROJECT_RE.match(ident or ""):
            raise not_found("No such project.")
        d = os.path.join(self.root, "projects")
        return os.path.join(d, f"{ident}.md"), os.path.join(d, f"{ident}.rev.json")

    def _check_owner(self, kind, ident):
        lib = self.load()
        if kind == "item":
            self.get_item(lib, ident)
        elif ident not in self.project_ids(lib):
            raise not_found("No such project.")

    def _read_notes(self, kind, ident):
        with self.lock:
            return self._read_notes_unlocked(kind, ident)

    def _read_notes_unlocked(self, kind, ident):
        mp, rp = self._notes_paths(kind, ident)
        if not os.path.exists(mp):
            return {"text": "", "savedAt": None, "rev": 0}
        try:
            with open(mp, "rb") as f:
                text = f.read().decode("utf-8")
        except (UnicodeDecodeError, OSError) as e:
            raise StoreError(500, f"{self.rel(mp)} is unreadable ({e}). Nothing was changed.", corrupt=True)
        meta = {}
        if os.path.exists(rp):
            try:
                with open(rp, "rb") as f:
                    meta = json.loads(f.read().decode("utf-8"))
                if not isinstance(meta, dict):
                    raise ValueError("not an object")
            except (ValueError, UnicodeDecodeError, OSError) as e:
                raise StoreError(500, f"{self.rel(rp)} is unreadable ({e}). Nothing was changed.", corrupt=True)
        rev = meta.get("rev") if isinstance(meta.get("rev"), int) else 1
        saved = meta.get("savedAt") or datetime.datetime.fromtimestamp(os.path.getmtime(mp)).isoformat(timespec="seconds")
        return {"text": text, "savedAt": saved, "rev": rev}

    def get_notes(self, kind, ident):
        self._check_owner(kind, ident)
        return self._read_notes(kind, ident)

    def save_notes(self, kind, ident, text, base_rev, force=False, saved_at=None):
        if not isinstance(text, str):
            raise bad("text must be a string.")
        with self.lock:
            self._check_owner(kind, ident)
            cur = self._read_notes(kind, ident)
            if not force:
                br = 0 if base_rev is None else base_rev
                if not isinstance(br, int) or isinstance(br, bool) or br != cur["rev"]:
                    raise StoreError(409, "These notes were changed somewhere else.", conflict=True,
                                     rev=cur["rev"], text=cur["text"], savedAt=cur["savedAt"])
            mp, rp = self._notes_paths(kind, ident)
            self.backup(mp)
            atomic_write(mp, text.encode("utf-8"))
            meta = {"rev": cur["rev"] + 1, "savedAt": saved_at or now_iso()}
            atomic_write(rp, dump_json(meta))
            return {"text": text, "savedAt": meta["savedAt"], "rev": meta["rev"]}

    # ---- projects ---------------------------------------------------------------------------------
    def _proj(self, lib, pid):
        p = next((x for x in lib["projects"] if x["id"] == pid), None)
        if not p:
            raise not_found("No such project.")
        return p

    def create_project(self, name, parent=None, pid=None):
        if not isinstance(name, str) or not name.strip():
            raise bad("Project name is empty.")
        with self.lock:
            lib = self.load()
            if parent:
                self._proj(lib, parent)
            ids = self.project_ids(lib)
            base = pid or ("p_" + (slug(name, 32, "_") or "project"))
            k, n = base, 2
            projdir = os.path.join(self.root, "projects")
            while k in ids or os.path.exists(os.path.join(projdir, k + ".md")):
                k = f"{base}_{n}"
                n += 1
            p = {"id": k, "name": name.strip(), "parent": parent or None, "created": now_iso()}
            lib["projects"].append(p)
            self.save(lib)
            return dict(p)

    def patch_project(self, pid, body):
        if not isinstance(body, dict):
            raise bad("Bad request.")
        with self.lock:
            lib = self.load()
            p = self._proj(lib, pid)
            if "name" in body:
                if not isinstance(body["name"], str) or not body["name"].strip():
                    raise bad("Project name is empty.")
                p["name"] = body["name"].strip()
            if "parent" in body:
                par = body["parent"] or None
                if par is not None:
                    self._proj(lib, par)
                    a = par
                    while a:   # no cycles
                        if a == pid:
                            raise bad("A project can't be moved inside itself.")
                        a = next((x.get("parent") for x in lib["projects"] if x["id"] == a), None)
                p["parent"] = par
            if "sections" in body:
                secs = body["sections"]
                if not isinstance(secs, list) or len(secs) > 20:
                    raise bad("sections must be a list of at most 20.")
                out, seen = [], set()
                for x in secs:
                    sid = str((x or {}).get("id") or "")
                    name = " ".join(str((x or {}).get("name") or "").split())[:40]
                    if not re.match(r"^[a-z0-9-]{1,24}$", sid) or sid in seen or not name:
                        raise bad("Each section needs a unique id and a name.")
                    seen.add(sid)
                    out.append({"id": sid, "name": name})
                p["sections"] = out
            if "placement" in body:
                pl = body["placement"]
                if not isinstance(pl, dict):
                    raise bad("placement must be an object.")
                secs = {x["id"] for x in p.get("sections") or []}
                clean = {}
                for k, v in pl.items():
                    if k in lib["items"] and isinstance(v, dict) and (not secs or v.get("section") in secs):
                        r = v.get("rank")
                        clean[k] = {"section": str(v.get("section")), "rank": float(r) if isinstance(r, (int, float)) else 0.0}
                p["placement"] = clean
            self.save(lib)
            return dict(p)

    def delete_project(self, pid):
        with self.lock:
            lib = self.load()
            p = self._proj(lib, pid)
            for c in lib["projects"]:
                if c.get("parent") == pid:
                    c["parent"] = p.get("parent")
            lib["projects"] = [x for x in lib["projects"] if x["id"] != pid]
            for it in lib["items"].values():
                if pid in it.get("projects", []):
                    it["projects"] = [x for x in it["projects"] if x != pid]
            self.save(lib)
            stamp = _sec_stamp()
            for suffix in (".md", ".rev.json"):
                src = os.path.join(self.root, "projects", pid + suffix)
                if os.path.exists(src):
                    shutil.move(src, os.path.join(self.root, "_deleted", f"{stamp}_project_{pid}{suffix}"))
            return True

    # ---- search / bibtex ----------------------------------------------------------------------------
    @staticmethod
    def _snip(text, i, n):
        a, b = max(0, i - 50), min(len(text), i + n + 70)
        s = re.sub(r"\s+", " ", text[a:b]).strip()
        return ("…" if a > 0 else "") + s + ("…" if b < len(text) else "")

    @staticmethod
    def _fold(s):
        """Lower case without accents or compatibility forms (á -> a, ₂ -> 2), for search."""
        s = unicodedata.normalize("NFKD", s)
        return "".join(c for c in s if not unicodedata.category(c).startswith("M")).lower()

    @staticmethod
    def _words(q):
        return [w for w in re.split(r"[\s\-\u2010-\u2015/,;]+", Library._fold(q)) if w]

    @staticmethod
    def _match(text, words):
        """Where to cut a snippet when every query word occurs in text (in any order), else -1."""
        f = Library._fold(text)
        if not all(w in f for w in words):
            return -1, 0
        i = text.lower().find(words[0])
        if i < 0:
            i = min(f.find(words[0]), max(len(text) - 1, 0))
        return i, len(words[0])

    def search(self, q):
        q = (q or "").strip()
        words = self._words(q)
        if not words:
            return []
        lib = self.load()
        hits = []
        for key, it in lib["items"].items():
            ab = it.get("abstract") or ""
            i, n = self._match(ab, words)
            if i >= 0:
                hits.append({"key": key, "where": "abstract", "snippet": self._snip(ab, i, n)})
            np = os.path.join(self.root, "items", key, "notes.md")
            if os.path.exists(np):
                try:
                    with open(np, "rb") as f:
                        txt = f.read().decode("utf-8", "replace")
                    i, n = self._match(txt, words)
                    if i >= 0:
                        hits.append({"key": key, "where": "notes", "snippet": self._snip(txt, i, n)})
                except OSError:
                    pass
            for a in it.get("attachments", []):
                mp = os.path.join(self.root, "items", key, f"{a['key']}.marks.json")
                if not os.path.exists(mp):
                    continue
                try:
                    with open(mp, "rb") as f:
                        marks = json.loads(f.read().decode("utf-8")).get("marks", [])
                except Exception:
                    continue
                if not isinstance(marks, list):
                    continue
                # every matching mark is returned (no per-PDF cap): the palette's Marks & notes tab lists them all.
                # A mark matches when its note, suggested wording and quote together hold every word; the
                # snippet comes from the first of those fields that has the first word.
                for m in marks:
                    if not isinstance(m, dict):
                        continue
                    vals = [m.get(fld) for fld in ("note", "suggest", "quote")]
                    vals = [v for v in vals if isinstance(v, str)]
                    if not vals or self._match("\n".join(vals), words)[0] < 0:
                        continue
                    v = next((v for v in vals if self._match(v, words[:1])[0] >= 0), vals[0])
                    i, n = self._match(v, words[:1])
                    hits.append({"key": key, "where": "marks", "att": a["key"], "markId": m.get("id"), "page": m.get("page"), "type": m.get("type"),
                                 "num": m.get("num"), "snippet": self._snip(v, max(i, 0), n)})
                    if len(hits) >= SEARCH_MAX_HITS:
                        return hits
            if len(hits) >= SEARCH_MAX_HITS:
                break
        return hits[:SEARCH_MAX_HITS]

    def bibtex(self, keys=None, project=None):
        lib = self.load()
        if keys:
            items = [self.get_item(lib, k) for k in keys]
        elif project:
            self._proj(lib, project)
            tree, i = [project], 0
            while i < len(tree):
                tree += [p["id"] for p in lib["projects"] if p.get("parent") == tree[i]]
                i += 1
            items = [it for it in lib["items"].values()
                     if not it.get("trashed") and set(it.get("projects", [])) & set(tree)]
            items.sort(key=lambda it: it["key"])
        else:
            items = sorted((it for it in lib["items"].values() if not it.get("trashed")), key=lambda it: it["key"])
        return "\n".join(importers.bibtex(item_meta(it), it["key"]) for it in items)
