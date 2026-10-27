"""Your profile: the whole library in one folder you choose, kept up to date, and loadable anywhere.

A local "sign-in". Connect a folder (a synced drive, a USB stick, a git repository) and after every change
Fermivie writes into it:

  paper-marker-profile.json   every paper's details, projects, mark types, settings, all marks, notes and crops
  pdfs/<sha256>.pdf           a copy of every PDF (optional, on by default), so the profile is complete

On another computer (or a fresh copy of the app) "Load a profile" reads that folder back: papers, marks,
notes and projects you don't have yet are added, and nothing you already have is changed. PDFs come from
pdfs/, or are downloaded again from where they came from (arXiv, the journal) when the copy isn't there.
If the folder is a git repository, each save can also be committed (and pushed), e.g. to a private GitHub repo.
Stdlib only.
"""
import base64
import copy
import json
import os
import shutil
import subprocess
import threading
import time

import importers
import library_store as ls

FILE = "paper-marker-profile.json"
FORMAT = "paper-marker-profile"
DELAY = 4.0                      # seconds of quiet after a change before saving

_state = {"lastSaved": None, "lastError": None, "saving": False, "gitResult": None}
_timer = None
_tlock = threading.Lock()


def folder_of(store):
    try:
        p = (store.get_settings().get("profile") or {})
    except ls.StoreError:
        return None, {}
    f = (p.get("folder") or "").strip()
    return (os.path.abspath(os.path.expanduser(f)) if f else None), p


def status(store):
    folder, p = folder_of(store)
    info = {"folder": folder or "", "includePdfs": p.get("includePdfs", True) is not False,
            "git": bool(p.get("git")), "push": bool(p.get("push")), **_state}
    if folder:
        info["exists"] = os.path.isdir(folder)
        info["isGitRepo"] = os.path.isdir(os.path.join(folder, ".git"))
        info["file"] = os.path.join(folder, FILE)
        info["hasFile"] = os.path.isfile(info["file"])
    return info


def changed(store):
    """Something was saved: write the profile once things are quiet for a few seconds."""
    global _timer
    if not folder_of(store)[0]:
        return
    with _tlock:
        if _timer:
            _timer.cancel()
        _timer = threading.Timer(DELAY, _save_quietly, args=(store,))
        _timer.daemon = True
        _timer.start()


def _save_quietly(store):
    try:
        save(store)
    except Exception as e:   # reported on the Profile page, never breaks the app
        _state["lastError"] = str(e)


# ---- writing ----------------------------------------------------------------------------------------
def _read(path, binary=False):
    with open(path, "rb") as f:
        b = f.read()
    return b if binary else b.decode("utf-8")


def snapshot(store):
    """Everything in the library except the PDFs, as one JSON-able dict."""
    with store.lock:
        lib = store.load()
        root = store.root
        marks, notes, crops = {}, {}, {}
        for key in lib.get("items", {}):
            d = os.path.join(root, "items", key)
            if not os.path.isdir(d):
                continue
            for name in sorted(os.listdir(d)):
                p = os.path.join(d, name)
                if name.endswith(".marks.json"):
                    marks[f"{key}/{name[:-len('.marks.json')]}"] = json.loads(_read(p))
                elif name in ("notes.md", "notes.rev.json"):
                    notes[f"items/{key}/{name}"] = _read(p)
            cd = os.path.join(d, "crops")
            if os.path.isdir(cd):
                for name in sorted(os.listdir(cd)):
                    if name.endswith(".png"):
                        crops[f"{key}/{name}"] = base64.b64encode(_read(os.path.join(cd, name), True)).decode("ascii")
        pd = os.path.join(root, "projects")
        if os.path.isdir(pd):
            for name in sorted(os.listdir(pd)):
                if name.endswith((".md", ".rev.json")):
                    notes[f"projects/{name}"] = _read(os.path.join(pd, name))
        settings = store.get_settings()
    settings = copy.deepcopy(settings)
    settings.pop("profile", None)   # where the profile lives is this computer's business
    return {"format": FORMAT, "version": 1, "app": "Paper Marker", "savedAt": ls.now_iso(),
            "library": lib, "settings": settings, "marks": marks, "notes": notes, "crops": crops}


def save(store):
    folder, p = folder_of(store)
    if not folder:
        raise ls.StoreError(400, "No profile folder is connected.")
    _state["saving"] = True
    try:
        os.makedirs(folder, exist_ok=True)
        snap = snapshot(store)
        if p.get("includePdfs", True) is not False:
            pdir = os.path.join(folder, "pdfs")
            os.makedirs(pdir, exist_ok=True)
            for key, it in snap["library"].get("items", {}).items():
                for a in it.get("attachments", []):
                    src = os.path.join(store.root, "items", key, a.get("file") or "")
                    sha = a.get("sha256") or ""
                    if sha and os.path.isfile(src) and not os.path.isfile(os.path.join(pdir, sha + ".pdf")):
                        tmp = os.path.join(pdir, f".{sha}.tmp")
                        shutil.copyfile(src, tmp)
                        ls.replace_retry(tmp, os.path.join(pdir, sha + ".pdf"))
        ls.atomic_write(os.path.join(folder, FILE), json.dumps(snap, ensure_ascii=False, indent=1).encode("utf-8"))
        _state["lastSaved"], _state["lastError"] = snap["savedAt"], None
        if p.get("git") and os.path.isdir(os.path.join(folder, ".git")):
            _state["gitResult"] = _git(folder, bool(p.get("push")))
        return status(store)
    finally:
        _state["saving"] = False


def _git(folder, push):
    def run(*args):
        r = subprocess.run(["git", "-C", folder, *args], capture_output=True, text=True, timeout=120)
        return r.returncode, (r.stdout + r.stderr).strip()
    try:
        run("add", "-A")
        code, out = run("commit", "-q", "-m", "Fermivie profile " + time.strftime("%Y-%m-%d %H:%M"))
        if code and "nothing to commit" not in out:
            return "Couldn't commit: " + out[-200:]
        if push:
            code, out = run("push", "-q")
            if code:
                return "Committed, but couldn't push: " + out[-200:]
            return "Committed and pushed"
        return "Committed"
    except (OSError, subprocess.SubprocessError) as e:
        return "git isn't available: " + str(e)[:150]


# ---- reading --------------------------------------------------------------------------------------------
def read_profile(path):
    p = os.path.abspath(os.path.expanduser((path or "").strip().strip('"').strip("'")))
    f = os.path.join(p, FILE) if os.path.isdir(p) else p
    if not os.path.isfile(f):
        raise ls.StoreError(404, f"There's no Fermivie profile ({FILE}) there.")
    try:
        data = json.loads(_read(f))
    except (OSError, ValueError) as e:
        raise ls.StoreError(400, f"That profile can't be read: {e}")
    if not isinstance(data, dict) or data.get("format") != FORMAT or not isinstance(data.get("library"), dict):
        raise ls.StoreError(400, "That file isn't a Fermivie profile.")
    return os.path.dirname(f), data


def preview(path):
    folder, data = read_profile(path)
    lib = data["library"]
    return {"folder": folder, "savedAt": data.get("savedAt"), "papers": len(lib.get("items") or {}),
            "projects": len(lib.get("projects") or []),
            "marks": sum(len((m or {}).get("marks") or []) for m in (data.get("marks") or {}).values()),
            "pdfs": os.path.isdir(os.path.join(folder, "pdfs"))}


def _safe(name):
    return bool(name) and "/" not in name and "\\" not in name and not name.startswith(".")


def load(store, path, connect=True):
    """Add what the profile has and this library doesn't. Returns a summary."""
    folder, data = read_profile(path)
    plib = data["library"]
    have = set(store.load().get("items", {}))
    marks, notes, crops = data.get("marks") or {}, data.get("notes") or {}, data.get("crops") or {}
    ready, missing = {}, []
    # 1) files first, outside the lock (PDF copies or downloads can take a while)
    for key, it in (plib.get("items") or {}).items():
        if not isinstance(it, dict) or not ls.KEY_RE.match(key) or key in have:
            continue
        it = copy.deepcopy(it)
        d = os.path.join(store.root, "items", key)
        os.makedirs(os.path.join(d, "crops"), exist_ok=True)
        atts = []
        for a in it.get("attachments") or []:
            fn = a.get("file") or ""
            if not ls.ATT_RE.match(a.get("key") or "") or not fn.endswith(".pdf") or not _safe(fn):
                continue
            dest, sha = os.path.join(d, fn), a.get("sha256") or ""
            src = os.path.join(folder, "pdfs", sha + ".pdf")
            ok = False
            if sha and os.path.isfile(src):
                shutil.copyfile(src, dest + ".tmp")
                ls.replace_retry(dest + ".tmp", dest)
                ok = True
            elif (a.get("url") or "").startswith("http"):
                ok = bool(importers.download_pdf(a["url"], dest).get("ok"))
            if ok:
                atts.append(a)
            else:
                missing.append(f"{it.get('title') or key} ({a.get('label') or a.get('key')})")
        it["attachments"] = atts
        if atts and not any(a["key"] == it.get("primary") for a in atts):
            it["primary"] = atts[0]["key"]
        for ref, m in marks.items():
            k, _, att = ref.partition("/")
            if k == key and ls.ATT_RE.match(att) and isinstance(m, dict):
                ls.atomic_write(os.path.join(d, f"{att}.marks.json"), ls.dump_json(m))
        for ref, b64 in crops.items():
            k, _, name = ref.partition("/")
            if k == key and _safe(name) and name.endswith(".png"):
                ls.atomic_write(os.path.join(d, "crops", name), base64.b64decode(b64))
        for ref, text in notes.items():
            parts = ref.split("/")
            if len(parts) == 3 and parts[0] == "items" and parts[1] == key and parts[2] in ("notes.md", "notes.rev.json"):
                ls.atomic_write(os.path.join(d, parts[2]), text.encode("utf-8"))
        ready[key] = it
    # 2) then the library itself, under the lock
    with store.lock:
        lib = store.load()
        added = [k for k in ready if k not in lib["items"]]
        for k in added:
            lib["items"][k] = ready[k]
        mine = {p.get("id") for p in lib.get("projects", [])}
        new_projects = [p for p in plib.get("projects") or [] if isinstance(p, dict) and p.get("id") and p["id"] not in mine]
        lib.setdefault("projects", []).extend(new_projects)
        ptypes = [t for t in plib.get("markTypes") or [] if isinstance(t, dict) and t.get("id")]
        if ptypes and not lib.get("markTypes"):   # never edited here: take the profile's mark types as they are
            lib["markTypes"] = ls.clean_mark_types(ptypes)
            lib["markTypesRev"] = int(lib.get("markTypesRev") or 0) + 1
        types = {t.get("id") for t in lib.get("markTypes") or store.mark_types(lib)}
        extra = [t for t in ptypes if t.get("id") not in types]
        if extra:
            lib["markTypes"] = ls.clean_mark_types(list(lib.get("markTypes") or store.mark_types(lib)) + extra)
            lib["markTypesRev"] = int(lib.get("markTypesRev") or 0) + 1
        store.save(lib)
        for ref, text in notes.items():   # project notes you don't have yet
            parts = ref.split("/")
            if len(parts) == 2 and parts[0] == "projects" and _safe(parts[1]) and parts[1].endswith((".md", ".rev.json")):
                dest = os.path.join(store.root, "projects", parts[1])
                if not os.path.exists(dest):
                    ls.atomic_write(dest, text.encode("utf-8"))
        for k in added:   # readable .marks.md copies
            it = lib["items"][k]
            for a in it.get("attachments", []):
                m = marks.get(f"{k}/{a['key']}")
                if isinstance(m, dict):
                    try:
                        store.write_md(it, a, m)
                    except Exception:
                        pass
    if not os.path.isfile(store.settings_path) and isinstance(data.get("settings"), dict):
        try:
            store.set_settings(data["settings"])
        except ls.StoreError:
            pass
    if connect:
        store.set_settings({"profile": {"folder": folder}})
        _state["lastSaved"] = data.get("savedAt")
    n_marks = sum(len((marks.get(f"{k}/{a['key']}") or {}).get("marks") or []) for k in added for a in ready[k]["attachments"])
    return {"added": len(added), "skipped": len((plib.get("items") or {})) - len(added), "projects": len(new_projects),
            "marks": n_marks, "missingPdfs": missing, "folder": folder}
