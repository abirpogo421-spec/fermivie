#!/usr/bin/env python3
"""Fermivie: local research-paper library + PDF reader.

Run:  PORT=8124 LIBRARY_DIR=./library python3 server.py   (then open http://localhost:PORT)
Stdlib only. Binds 127.0.0.1. See CONTRACT.md §3 (API) and §9 (safety).
"""
from __future__ import annotations

import json
import os
import re
import sys
import subprocess
import tempfile
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlsplit

import importers
import published
import userprofile as profile
import library_store as ls
from library_store import StoreError, bad, not_found

APP_DIR = os.path.dirname(os.path.abspath(__file__))
PORT = int(os.environ.get("PORT", "8124"))
LIBRARY_DIR = os.path.abspath(os.environ.get("LIBRARY_DIR") or os.path.join(APP_DIR, "library"))
STATIC_ROOTS = ("js", "css", "vendor")
MAX_JSON = 20 * 1024 * 1024
MAX_PDF = 300 * 1024 * 1024
RESOLVE_TIMEOUT = 25
CTYPES = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
          ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
          ".json": "application/json", ".map": "application/json", ".svg": "image/svg+xml",
          ".png": "image/png", ".ico": "image/x-icon", ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8",
          ".bcmap": "application/octet-stream", ".pfb": "application/octet-stream", ".ttf": "font/ttf"}
CSP = "frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self'; connect-src 'self' data: blob:"
SIMPLE_CTYPES = {"application/x-www-form-urlencoded", "multipart/form-data", "text/plain"}

store: ls.Library = None  # set in make_server()


def _seg_key(s):
    if not ls.KEY_RE.match(s):
        raise not_found("No such paper.")
    return s


def _seg_att(s):
    if not ls.ATT_RE.match(s):
        raise not_found("No such attachment.")
    return s


def _seg_proj(s):
    if not ls.PROJECT_RE.match(s):
        raise not_found("No such project.")
    return s


# ---------------------------------------------------------------------------------------------
# import helpers (network work happens outside the store lock)
# ---------------------------------------------------------------------------------------------

def _att_label(res, url):
    meta = res.get("meta") or {}
    if url and not published.is_preprint_url(url) and meta.get("doi"):
        # the publisher's own site is the published version; a copy from a repository may be the accepted manuscript
        host = urlsplit(url).hostname or ""
        pub = {urlsplit(u).hostname for u in published.journal_pdf_urls(meta["doi"]) + [meta.get("url") or ""] if u}
        known = ("aps.org", "nature.com", "science.org", "acs.org", "wiley.com", "iop.org", "springer.com", "pnas.org",
                 "sciencedirect.com", "elsevier.com", "tandfonline.com", "oup.com", "cambridge.org", "aip.org",
                 "optica.org", "ieee.org", "mdpi.com", "frontiersin.org", "plos.org", "rsc.org", "annualreviews.org")
        if host in pub or any(host == k or host.endswith("." + k) for k in known):
            return "Published version"
        return "Open-access copy"
    if meta.get("arxiv") and ("arxiv.org" in (url or "")):
        v = meta.get("arxiv_version") or ""
        m = re.search(r"v(\d+)(?:\.pdf)?$", url or "")
        if m:
            v = "v" + m.group(1)
        return f"arXiv {v}".strip()
    return "PDF"


def _pdf_candidates(res):
    out = []
    for u in [res.get("pdf_url")] + list(res.get("pdf_candidates") or []):
        if u and u not in out:
            out.append(u)
    return out


def _download_first(cands, dest_dir):
    """Try each candidate URL; returns (tmp_path, download_result, url) or (None, errors, None)."""
    errors = []
    for u in cands[:6]:
        fd, tmp = tempfile.mkstemp(suffix=".pdf", prefix=".dl_", dir=dest_dir)
        os.close(fd)
        r = importers.download_pdf(u, tmp)
        if r.get("ok"):
            return tmp, r, u
        if os.path.exists(tmp):
            os.remove(tmp)
        errors.append(r.get("error") or "download failed")
    return None, errors, None


def _idents(meta=None, doi="", arxiv="", sha=""):
    meta = meta or {}
    out = set()
    d = (doi or meta.get("doi") or "").strip().lower()
    a = re.sub(r"v\d+$", "", (arxiv or meta.get("arxiv") or "").strip().lower())
    if d:
        out.add("doi:" + d)
    if a:
        out.add("arxiv:" + a)
    if sha:
        out.add("sha:" + sha)
    return out


APP_VERSION = "2.3"


def apply_settings(settings):
    """Make the server follow the saved settings (published.SEARCH_DIRS <- library.watchDirs).
    PM_SEARCH_DIRS in the environment still wins (tests use it)."""
    if os.environ.get("PM_SEARCH_DIRS"):
        return
    dirs = []
    for d in ((settings or {}).get("library") or {}).get("watchDirs") or []:
        p = os.path.abspath(os.path.expanduser(d))
        if os.path.isdir(p) and p not in dirs:
            dirs.append(p)
    published.SEARCH_DIRS = dirs


def _setting(section, key, default):
    try:
        return store.get_settings().get(section, {}).get(key, default)
    except StoreError:
        return default


def do_import(inp, project):
    if not isinstance(inp, str) or not inp.strip():
        raise bad("Paste an arXiv ID, DOI, or link.")
    lib = store.load()
    if project and project not in store.project_ids(lib):
        raise bad("That project does not exist.")
    p = importers.parse_input(inp)
    dup = store.find_duplicate(lib, doi=p.get("doi"), arxiv=p.get("arxiv"))
    if dup:
        it = store.add_to_project(dup, project) or store.get_item(store.load(), dup)
        return {"item": it, "duplicate": True, "warnings": []}
    res = importers.resolve(inp, timeout=RESOLVE_TIMEOUT)
    if not res.get("ok"):
        raise StoreError(422, res.get("error") or "Couldn't find that paper.", candidates=res.get("candidates") or [])
    meta = res.get("meta") or {}
    warnings = list(res.get("warnings") or [])
    ids = _idents(meta)
    key, dup = store.reserve(ids, importers.citekey(meta))
    if dup:
        it = store.add_to_project(dup, project) or store.get_item(store.load(), dup)
        return {"item": it, "duplicate": True, "warnings": []}
    tmp = None
    try:
        os.makedirs(os.path.join(store.root, "items"), exist_ok=True)
        cands = _pdf_candidates(res)
        prefer_journal = bool(_setting("library", "preferJournal", True))
        if meta.get("doi"):
            jurls = [u for u in published.journal_pdf_urls(meta["doi"]) if u not in cands]
            cands = jurls + cands if prefer_journal else cands + jurls
        tmp, dl, url = (None, [], None)
        if cands:
            tmp, dl, url = _download_first(cands, os.path.join(store.root, "items"))
        if not tmp and meta.get("type") != "preprint" and _setting("library", "preprintFallback", True):
            # the journal won't hand over its PDF (paywall) and no preprint was listed: look for one on arXiv
            aid = meta.get("arxiv") or importers.find_preprint(meta, timeout=RESOLVE_TIMEOUT)
            apdf = f"https://arxiv.org/pdf/{aid}" if aid else ""
            if apdf and apdf not in cands:
                pdup = store.find_duplicate(store.load(), arxiv=aid)
                if pdup:
                    it = store.add_to_project(pdup, project) or store.get_item(store.load(), pdup)
                    return {"item": it, "duplicate": True, "warnings": ["The arXiv version of this paper is already in your library."]}
                tmp, dl2, url = _download_first([apdf], os.path.join(store.root, "items"))
                if tmp:
                    dl = dl2
                    meta["arxiv"] = meta.get("arxiv") or aid
                    warnings = [w for w in warnings if w != importers.NO_OA_PDF_WARNING and "Attach it yourself" not in w
                                and "published version may differ" not in w]
                    warnings.append(f"The journal's PDF isn't open to download, so this is the arXiv preprint "
                                    f"(arXiv {aid}); it may differ from the published version.")
        if tmp:
            lib = store.load()
            sdup = store.find_duplicate(lib, sha=dl.get("sha256"))
            if sdup:
                it = store.add_to_project(sdup, project) or store.get_item(store.load(), sdup)
                return {"item": it, "duplicate": True, "warnings": []}
        else:
            if cands:
                warnings.append("Couldn't download the PDF (" + "; ".join(dict.fromkeys(dl))[:300] + "). Attach it yourself.")
            elif importers.NO_OA_PDF_WARNING not in warnings:
                warnings.append(importers.NO_OA_PDF_WARNING)
        item = store.create_item(meta, project=project, key=key)
        if tmp:
            item, _ = store.add_attachment_file(key, tmp, _att_label(res, dl.get("final_url") or url), source="url",
                                                url=dl.get("final_url") or url, prefer="main", move=True)
            tmp = None
        # already downloaded the journal version (e.g. through your library's access)? use it
        if not has_published(item):
            got, folder = attach_local_published(key, make_default=prefer_journal or not item.get("attachments"))
            if got:
                item = got
                warnings = [w for w in warnings if "preprint" not in w and w != importers.NO_OA_PDF_WARNING]
                warnings.append(f"Used the journal PDF from your {folder} folder.")
        return {"item": item, "duplicate": False, "warnings": warnings}
    finally:
        if tmp and os.path.exists(tmp):
            os.remove(tmp)
        store.release(ids, key)


def has_published(item):
    return any(not published.is_preprint_url(a.get("url")) and (a.get("label") or "").lower().startswith("published")
               for a in item.get("attachments", []))


def attach_local_published(key, since=None, make_default=True):
    """Copy a matching journal PDF from Downloads/Desktop into the item (and make it the default)."""
    it = store.get_item(store.load(), key)
    path = published.find_local_pdf(it, since=since)
    if not path:
        return None, ""
    folder = os.path.basename(os.path.dirname(path)) or "Downloads"
    try:   # no url: the file's full path (with the account name in it) never goes into library.json
        item, att = store.add_attachment_file(key, path, "Published version", source="file",
                                              url="", prefer="published", move=False)
    except StoreError:
        return None, ""
    if not make_default:
        return item, folder
    return store.patch_item(key, {"primary": att["key"]}), folder


def _title_from_name(name):
    stem = os.path.splitext(os.path.basename(name or ""))[0]
    t = re.sub(r"[_]+", " ", stem).strip()
    return t or "Untitled"


def do_import_file(tmp, name, project):
    """tmp: a temp PDF file inside the library (ours to move/remove)."""
    lib = store.load()
    if project and project not in store.project_ids(lib):
        raise bad("That project does not exist.")
    sha = ls.sha256_file(tmp)
    dup = store.find_duplicate(lib, sha=sha)
    if dup:
        it = store.add_to_project(dup, project) or store.get_item(store.load(), dup)
        return {"item": it, "duplicate": True, "warnings": []}
    warnings = []
    ids_found = importers.sniff_pdf_file(tmp)
    meta = importers.empty_meta()
    meta["title"] = ids_found.get("title") or _title_from_name(name)
    by_title = None
    if not (ids_found.get("arxiv") or ids_found.get("doi")) and ids_found.get("title"):
        # many journal PDFs carry a good title but no DOI we can read: look the title up and
        # take the result only when its title is exactly the PDF's
        try:
            res = importers.resolve(ids_found["title"], timeout=15)
        except Exception:
            res = {"ok": False}
        m = res.get("meta") or {}
        if res.get("ok") and m.get("title") and \
                importers._norm_title(m["title"]) == importers._norm_title(ids_found["title"]):
            by_title = res
            ids_found = {**ids_found, "doi": m.get("doi") or "", "arxiv": m.get("arxiv") or ""}
    if ids_found.get("arxiv") or ids_found.get("doi"):
        dup = store.find_duplicate(lib, doi=ids_found.get("doi"), arxiv=ids_found.get("arxiv"))
        if dup:
            it = store.add_to_project(dup, project) or store.get_item(store.load(), dup)
            return {"item": it, "duplicate": True, "warnings": ["The same paper is already in your library."]}
        q = ids_found.get("arxiv") or ids_found.get("doi")
        if by_title:
            res = by_title
        else:
            try:
                res = importers.resolve(q, timeout=15)
            except Exception:
                res = {"ok": False}
        if res.get("ok") and res.get("meta"):
            meta = res["meta"]
        else:
            meta["arxiv"] = ids_found.get("arxiv") or ""
            meta["doi"] = ids_found.get("doi") or ""
            if ids_found.get("arxiv"):
                meta["type"] = "preprint"
            warnings.append("Couldn't fetch the metadata online; fill it in or use Fetch metadata.")
    ids = _idents(meta, sha=sha)
    key, dup = store.reserve(ids, importers.citekey(meta))
    if dup:
        it = store.add_to_project(dup, project) or store.get_item(store.load(), dup)
        return {"item": it, "duplicate": True, "warnings": []}
    try:
        store.create_item(meta, project=project, key=key)
        label = os.path.basename(name or "") or "PDF"
        item, _ = store.add_attachment_file(key, tmp, label, source="file", prefer="main", move=True)
        return {"item": item, "duplicate": False, "warnings": warnings}
    finally:
        store.release(ids, key)


def do_enrich(key, body):
    inp = body.get("input")
    if not isinstance(inp, str) or not inp.strip():
        raise bad("Give a DOI, arXiv ID or link.")
    store.get_item(store.load(), key)
    res = importers.resolve(inp, timeout=RESOLVE_TIMEOUT)
    if not res.get("ok"):
        raise StoreError(422, res.get("error") or "Couldn't find metadata for that.", candidates=res.get("candidates") or [])
    item = store.apply_meta(key, res.get("meta") or {}, overwrite=bool(body.get("overwrite")))
    return {"item": item, "warnings": list(res.get("warnings") or [])}


def do_profile(m, s, b):
    """The profile folder (a local 'sign-in'): see profile.py."""
    if m == "GET" and s == []:
        return {"profile": profile.status(store)}
    if m != "POST" or len(s) != 1:
        raise not_found("Not found.")
    act = s[0]
    if act == "save":
        return {"profile": profile.save(store)}
    if act == "disconnect":
        store.set_settings({"profile": {"folder": ""}})
        return {"profile": profile.status(store)}
    if act == "preview":
        return {"preview": profile.preview(b.get("path") or "")}
    if act == "load":
        summary = profile.load(store, b.get("path") or "", connect=b.get("connect", True) is not False)
        apply_settings(store.get_settings())
        return {"summary": summary, "profile": profile.status(store)}
    if act == "connect":
        raw = (b.get("folder") or "").strip().strip('"').strip("'")
        if not raw:
            raise bad("Choose a folder for your profile.")
        folder = os.path.abspath(os.path.expanduser(raw))
        if os.path.isfile(folder):
            raise bad("That's a file. Choose a folder.")
        if not os.path.isdir(folder):
            if not os.path.isdir(os.path.dirname(folder)):
                raise bad("That folder doesn't exist, and neither does the one it would go in.")
            os.makedirs(folder)
        if os.path.abspath(folder).startswith(os.path.abspath(store.root) + os.sep) or os.path.abspath(folder) == os.path.abspath(store.root):
            raise bad("Choose a folder outside the library folder.")
        has = os.path.isfile(os.path.join(folder, profile.FILE))
        if has and not b.get("replace"):
            # never overwrite someone's profile by accident: the app asks whether to load it or replace it
            raise StoreError(409, "That folder already has a Fermivie profile.", preview=profile.preview(folder))
        patch = {"folder": folder}
        for k in ("includePdfs", "git", "push"):
            if isinstance(b.get(k), bool):
                patch[k] = b[k]
        store.set_settings({"profile": patch})
        return {"profile": profile.save(store)}
    if act == "choose":
        return choose_folder(b.get("prompt") or "Choose a folder for your Fermivie profile")
    raise not_found("Not found.")


def choose_folder(prompt):
    """A native folder picker on the computer running the app (it's your own computer)."""
    prompt = re.sub(r'["\\]', "", str(prompt))[:120]
    if sys.platform == "darwin":
        r = subprocess.run(["osascript", "-e", f'POSIX path of (choose folder with prompt "{prompt}")'],
                           capture_output=True, text=True, timeout=600)
        if r.returncode:
            return {"cancelled": True}
        return {"path": r.stdout.strip().rstrip("/") or "/"}
    try:
        import tkinter
        from tkinter import filedialog
        root = tkinter.Tk(); root.withdraw(); root.attributes("-topmost", True)
        path = filedialog.askdirectory(title=prompt); root.destroy()
        return {"path": path} if path else {"cancelled": True}
    except Exception:
        raise StoreError(501, "There's no folder picker here: type the folder's full path instead.")


def do_find_preprint(key):
    """Attach the arXiv preprint of a paper that's already in the library (found by its title and authors)."""
    it = store.get_item(store.load(), key)
    if any(published.is_preprint_url(a.get("url")) for a in it.get("attachments", [])):
        raise StoreError(409, "The arXiv version is already attached.")
    aid = it.get("arxiv") or importers.find_preprint(
        {"title": it.get("title"), "authors": it.get("authors"), "year": it.get("year")}, timeout=RESOLVE_TIMEOUT)
    if not aid:
        raise StoreError(404, "No arXiv version of this paper was found, so there's no free copy to add. "
                              "Use Get journal PDF to download it with your own access, or Add PDF.")
    out = do_fetch_attachment(key, {"url": f"https://arxiv.org/pdf/{aid}", "label": "arXiv"})
    if not it.get("arxiv"):
        out["item"] = store.patch_item(key, {"arxiv": aid})
    out["arxiv"] = aid
    return out


def do_fetch_attachment(key, body):
    url = body.get("url")
    label = body.get("label")
    if not isinstance(url, str) or not url.strip():
        raise bad("Give a link to a PDF, an arXiv ID or a DOI.")
    if label is not None and not isinstance(label, str):
        raise bad("label must be text.")
    store.get_item(store.load(), key)
    d = os.path.join(store.root, "items")
    os.makedirs(d, exist_ok=True)
    tmp, dl, used, res = None, [], None, {}
    u = url.strip()
    if re.match(r"^https?://", u, re.I):
        tmp, dl, used = _download_first([u], d)
    if not tmp:
        res = importers.resolve(u, timeout=RESOLVE_TIMEOUT)
        if not res.get("ok"):
            raise StoreError(422, res.get("error") or (dl[0] if dl else "Couldn't find a PDF there."),
                             candidates=res.get("candidates") or [])
        cands = _pdf_candidates(res)
        if not cands:
            raise StoreError(422, importers.NO_OA_PDF_WARNING)
        tmp, dl, used = _download_first(cands, d)
        if not tmp:
            raise StoreError(422, "Couldn't download the PDF: " + "; ".join(dict.fromkeys(dl))[:300])
    try:
        final = dl.get("final_url") or used
        lab = (label or "").strip() or (_att_label(res, final) if res else "PDF")
        item, att = store.add_attachment_file(key, tmp, lab, source="url", url=final, move=True)
        tmp = None
        return {"item": item, "attachment": att}
    finally:
        if tmp and os.path.exists(tmp):
            os.remove(tmp)


# ---------------------------------------------------------------------------------------------
# HTTP handler
# ---------------------------------------------------------------------------------------------

class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "PaperMarker/2"

    def log_message(self, fmt, *args):
        pass

    # ---- responses ------------------------------------------------------------------------------
    def end_headers(self):
        # no other site may frame the app (clickjacking), and script on the page can only talk to this server
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Content-Security-Policy", CSP)
        super().end_headers()

    def _send(self, code, body: bytes, ctype, extra=None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Content-Type-Options", "nosniff")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, obj, code=200):
        b = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self._send(code, b, "application/json", {"Cache-Control": "no-store"})

    def _ok(self, **kw):
        self._json(dict(ok=True, **kw))

    def _err(self, code, msg, **extra):
        self._json(dict(ok=False, error=msg, **extra), code)

    # ---- request checks -------------------------------------------------------------------------
    def _port(self):
        return self.server.server_address[1]

    def _host_ok(self):
        host = (self.headers.get("Host") or "").strip().lower()
        p = self._port()
        return host in (f"localhost:{p}", f"127.0.0.1:{p}")

    def _origin_ok(self):
        o = self.headers.get("Origin")
        if o is None:
            return True
        p = self._port()
        return o.strip().lower() in (f"http://localhost:{p}", f"http://127.0.0.1:{p}")

    def _ctype(self):
        return (self.headers.get("Content-Type") or "").split(";")[0].strip().lower()

    def _length(self, limit):
        if self.headers.get("Transfer-Encoding"):
            self.close_connection = True
            raise StoreError(411, "Chunked bodies are not supported.")
        cl = self.headers.get("Content-Length")
        if cl is None:
            return 0
        try:
            n = int(cl)
        except ValueError:
            self.close_connection = True
            raise bad("Bad Content-Length.")
        if n < 0:
            self.close_connection = True
            raise bad("Bad Content-Length.")
        if n > limit:
            self.close_connection = True
            raise StoreError(413, f"Request too large (limit {limit // (1024 * 1024)} MB).")
        return n

    def _drain(self):
        """Read and discard an unread body so the keep-alive connection stays in sync.

        Idempotent per request: once the body has been read (or drained) a second call is a no-op.
        Without that, an error raised after a drain made _handle drain again and block on
        rfile.read() for bytes that were already consumed (the request hung until the client quit)."""
        if getattr(self, "_body_read", False):
            return
        self._body_read = True
        if self.headers.get("Transfer-Encoding"):
            # chunked bodies are never parsed; we can't skip one reliably, so drop the connection
            self.close_connection = True
            return
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            self.close_connection = True
            return
        if n > MAX_JSON:
            self.close_connection = True
            return
        while n > 0:
            chunk = self.rfile.read(min(n, 1 << 16))
            if not chunk:
                break
            n -= len(chunk)

    def _body_json(self):
        if self._ctype() != "application/json":
            self._drain()
            raise StoreError(415, "Send JSON (Content-Type: application/json).")
        n = self._length(MAX_JSON)
        raw = self.rfile.read(n) if n else b""
        self._body_read = True
        try:
            obj = json.loads(raw.decode("utf-8")) if raw else {}
        except (ValueError, UnicodeDecodeError):
            raise bad("Bad JSON.")
        if not isinstance(obj, dict):
            raise bad("Send a JSON object.")
        return obj

    def _body_pdf_to_tmp(self):
        """Stream an uploaded PDF into a temp file inside the library; returns its path."""
        if self._ctype() not in ("application/pdf", "application/octet-stream"):
            self._drain()
            raise StoreError(415, "Send the PDF as application/pdf.")
        n = self._length(MAX_PDF)
        if n <= 0:
            raise bad("The upload is empty.")
        d = os.path.join(store.root, "items")
        os.makedirs(d, exist_ok=True)
        fd, tmp = tempfile.mkstemp(suffix=".pdf", prefix=".up_", dir=d)
        ok = False
        try:
            with os.fdopen(fd, "wb") as f:
                left, head = n, b""
                while left > 0:
                    chunk = self.rfile.read(min(left, 1 << 20))
                    if not chunk:
                        raise bad("The upload was cut off.")
                    if len(head) < 1024:
                        head += chunk[:1024]
                    f.write(chunk)
                    left -= len(chunk)
            self._body_read = True
            if not ls.is_pdf(head):
                raise StoreError(415, "That file is not a PDF.")
            ok = True
            return tmp
        finally:
            if not ok:
                self.close_connection = self.close_connection or not getattr(self, "_body_read", False)
                if os.path.exists(tmp):
                    os.remove(tmp)

    # ---- dispatch -------------------------------------------------------------------------------
    def do_GET(self):
        self._handle("GET")

    def do_HEAD(self):
        self._handle("HEAD")

    def do_POST(self):
        self._handle("POST")

    def do_PATCH(self):
        self._handle("PATCH")

    def do_PUT(self):
        self._handle("PUT")

    def do_DELETE(self):
        self._handle("DELETE")

    def do_OPTIONS(self):
        self._body_read = False  # the handler instance is reused across keep-alive requests
        self._drain()
        self._err(403, "Cross-origin requests are not allowed.")

    def _handle(self, method):
        self._body_read = False
        try:
            if not self._host_ok():
                self._drain()
                return self._err(403, "Bad Host header.")
            if method not in ("GET", "HEAD"):
                if not self._origin_ok():
                    self._drain()
                    return self._err(403, "Cross-origin requests are not allowed.")
                sfs = (self.headers.get("Sec-Fetch-Site") or "").lower()
                if sfs in ("cross-site", "same-site"):
                    self._drain()
                    return self._err(403, "Cross-origin requests are not allowed.")
                if self._ctype() in SIMPLE_CTYPES:
                    self._drain()
                    return self._err(415, "Unsupported Content-Type.")
            parts = urlsplit(self.path)
            raw_path = parts.path
            if "\x00" in raw_path or "\\" in raw_path:
                self._drain()
                return self._err(400, "Bad path.")
            segs_raw = raw_path.split("/")[1:]
            segs = [unquote(s) for s in segs_raw]
            for s in segs:
                if s in (".", "..") or "/" in s or "\\" in s or "\x00" in s:
                    self._drain()
                    return self._err(403, "Bad path.")
            q = {k: v[0] for k, v in parse_qs(parts.query, keep_blank_values=True).items()}
            if segs and segs[0] == "api":
                out = self._api(method, segs[1:], q)
                if method not in ("GET", "HEAD") and segs[1:2] != ["profile"]:
                    profile.changed(store)   # keep the connected profile folder up to date
                return out
            if method not in ("GET", "HEAD"):
                self._drain()
                return self._err(405, "Method not allowed.")
            if segs and segs[0] == "files":
                return self._files(segs[1:])
            return self._static(segs)
        except StoreError as e:
            try:
                self._drain()  # no-op when the body was already read or drained
                self._err(e.status, e.message, **e.extra)
            except (BrokenPipeError, ConnectionResetError, TimeoutError):
                self.close_connection = True
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True
        except Exception as e:
            traceback.print_exc()
            try:
                self._err(500, f"Server error: {type(e).__name__}: {e}")
            except Exception:
                self.close_connection = True
        finally:
            # Safety net: a body nobody read (e.g. a GET sent with one) must not be parsed as the next request.
            if not self._body_read and not self.close_connection:
                try:
                    self._drain()
                except OSError:
                    self.close_connection = True

    def _about(self):
        return {"library": store.root, "version": APP_VERSION, "port": self._port(),
                "watching": list(published.SEARCH_DIRS), "home": os.path.expanduser("~")}

    # ---- API ------------------------------------------------------------------------------------
    def _api(self, m, s, q):
        n = len(s)
        if m == "GET" and s == ["library"]:
            lib = store.load()
            lib["markTypes"] = store.mark_types(lib)
            return self._ok(library=lib, stats=store.stats(lib))
        if s == ["mark-types"]:
            if m == "GET":
                lib = store.load()
                return self._ok(types=store.mark_types(lib), rev=int(lib.get("markTypesRev") or 0))
            if m == "PUT":
                b = self._body_json()
                types, rev = store.set_mark_types(b.get("types"), b.get("baseRev"), bool(b.get("force")))
                return self._ok(types=types, rev=rev)
        if n >= 1 and s[0] == "profile":
            return self._ok(**do_profile(m, s[1:], self._body_json() if m == "POST" else {}))
        if s == ["settings"]:
            if m == "GET":
                return self._ok(settings=store.get_settings(), about=self._about())
            if m in ("PUT", "PATCH"):
                b = self._body_json()
                st = store.set_settings(b.get("settings") if "settings" in b else b)
                apply_settings(st)
                return self._ok(settings=st, about=self._about())
        if m == "GET" and s == ["search"]:
            return self._ok(hits=store.search(q.get("q", "")))
        if m == "GET" and s == ["export", "bibtex"]:
            keys = [k for k in (q.get("keys") or "").split(",") if k]
            text = store.bibtex(keys=keys or None, project=q.get("project") or None)
            return self._send(200, text.encode("utf-8"), "text/plain; charset=utf-8", {"Cache-Control": "no-store"})
        if m == "POST" and s == ["import"]:
            b = self._body_json()
            return self._ok(**do_import(b.get("input"), b.get("project") or None))
        if m == "POST" and s == ["import", "file"]:
            project = q.get("project") or None
            if project and project not in store.project_ids(store.load()):
                raise bad("That project does not exist.")
            tmp = self._body_pdf_to_tmp()
            try:
                return self._ok(**do_import_file(tmp, q.get("name") or "", project))
            finally:
                if os.path.exists(tmp):
                    os.remove(tmp)
        if m == "POST" and s == ["items"]:
            b = self._body_json()
            if not isinstance(b.get("meta"), dict):
                raise bad("meta must be an object.")
            return self._ok(item=store.create_item(b["meta"], project=b.get("project") or None))
        if m == "POST" and s == ["items", "batch"]:
            return self._ok(items=store.create_items(self._body_json().get("items")))
        if m == "POST" and s == ["items", "bulk"]:
            return self._ok(items=store.bulk(self._body_json()))
        if m == "POST" and s == ["trash", "empty"]:
            self._drain()
            return self._ok(moved=store.empty_trash())
        if m == "POST" and s == ["projects"]:
            b = self._body_json()
            return self._ok(project=store.create_project(b.get("name"), b.get("parent") or None))
        if n >= 2 and s[0] == "projects":
            pid = _seg_proj(s[1])
            if m == "PATCH" and n == 2:
                return self._ok(project=store.patch_project(pid, self._body_json()))
            if m == "POST" and n == 3 and s[2] == "delete":
                self._drain()
                store.delete_project(pid)
                return self._ok()
            if n == 3 and s[2] == "notes":
                if m == "GET":
                    return self._ok(**store.get_notes("project", pid))
                if m == "POST":
                    b = self._body_json()
                    return self._ok(**store.save_notes("project", pid, b.get("text"), b.get("baseRev"),
                                                       bool(b.get("force"))))
        if n >= 2 and s[0] == "items":
            key = _seg_key(s[1])
            if n == 2 and m == "PATCH":
                return self._ok(item=store.patch_item(key, self._body_json()))
            if n == 3 and m == "POST":
                if s[2] == "enrich":
                    return self._ok(**do_enrich(key, self._body_json()))
                if s[2] in ("trash", "restore"):
                    self._drain()
                    return self._ok(item=store.set_trashed(key, s[2] == "trash"))
                if s[2] == "notes":
                    b = self._body_json()
                    return self._ok(**store.save_notes("item", key, b.get("text"), b.get("baseRev"),
                                                       bool(b.get("force"))))
                if s[2] == "attachments":
                    store.get_item(store.load(), key)
                    tmp = self._body_pdf_to_tmp()
                    try:
                        name = q.get("name") or ""
                        label = q.get("label") or os.path.splitext(os.path.basename(name))[0] or "PDF"
                        item, att = store.add_attachment_file(key, tmp, label, source="file", move=True)
                        return self._ok(item=item, attachment=att)
                    finally:
                        if os.path.exists(tmp):
                            os.remove(tmp)
            if n == 3 and m == "GET" and s[2] == "journal":
                it = store.get_item(store.load(), key)
                return self._ok(url=published.journal_open_url(it.get("doi")), has=has_published(it))
            if n == 3 and m == "POST" and s[2] == "find-preprint":
                self._drain()
                return self._ok(**do_find_preprint(key))
            if n == 3 and m == "POST" and s[2] == "find-published":
                b = self._body_json()
                since = b.get("since")
                it = store.get_item(store.load(), key)
                if has_published(it):
                    return self._ok(found=True, item=it, already=True)
                got, folder = attach_local_published(key, since=float(since) if isinstance(since, (int, float)) else None)
                return self._ok(found=bool(got), item=got or it, folder=folder)
            if n == 3 and m == "GET" and s[2] == "notes":
                return self._ok(**store.get_notes("item", key))
            if n == 4 and s[2] == "attachments" and s[3] == "fetch" and m == "POST":
                return self._ok(**do_fetch_attachment(key, self._body_json()))
            if n >= 4 and s[2] == "attachments":
                att = _seg_att(s[3])
                if n == 4 and m == "PATCH":
                    b = self._body_json()
                    return self._ok(item=store.rename_attachment(key, att, b.get("label")))
                if n == 5 and s[4] == "remove" and m == "POST":
                    self._drain()
                    return self._ok(item=store.remove_attachment(key, att))
                if n == 5 and s[4] == "marks":
                    if m == "GET":
                        return self._ok(**store.get_marks(key, att))
                    if m == "POST":
                        b = self._body_json()
                        return self._ok(**store.save_marks(key, att, b.get("marks"), b.get("baseRev"),
                                                           bool(b.get("force"))))
        self._drain()
        raise not_found("Unknown API route.")

    # ---- files ----------------------------------------------------------------------------------
    def _files(self, s):
        if len(s) == 2 and s[1].endswith(".pdf"):
            key, att = _seg_key(s[0]), _seg_att(s[1][:-4])
            path = os.path.join(store.root, "items", key, f"{att}.pdf")
            return self._serve_file(path, "application/pdf", ranges=True)
        if len(s) == 3 and s[1] == "crops" and ls.CROP_RE.match(s[2]):
            key = _seg_key(s[0])
            path = os.path.join(store.root, "items", key, "crops", s[2])
            return self._serve_file(path, "image/png", ranges=False)
        raise not_found("Not found.")

    def _serve_file(self, path, ctype, ranges=False, base=None):
        base = base or os.path.join(store.root, "items")
        real = os.path.realpath(path)
        if not real.startswith(os.path.realpath(base) + os.sep):
            raise StoreError(403, "Forbidden.")
        try:
            st = os.stat(real)
        except FileNotFoundError:
            raise not_found("Not found.")
        if not os.path.isfile(real):
            raise not_found("Not found.")
        size = st.st_size
        etag = f'"{size:x}-{st.st_mtime_ns:x}"'
        hdr = {"Cache-Control": "no-cache", "ETag": etag, "X-Content-Type-Options": "nosniff"}
        if ranges:
            hdr["Accept-Ranges"] = "bytes"
        inm = self.headers.get("If-None-Match")
        if inm and (inm.strip() == "*" or etag in [x.strip() for x in inm.split(",")]):
            self.send_response(304)
            for k, v in hdr.items():
                self.send_header(k, v)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        start, end, code = 0, size - 1, 200
        rng = self.headers.get("Range") if ranges else None
        if rng and self.headers.get("If-Range") and self.headers.get("If-Range").strip() != etag:
            rng = None
        if rng:
            m = re.fullmatch(r"\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*", rng)
            if m and (m.group(1) or m.group(2)):
                a, b = m.group(1), m.group(2)
                if a:
                    start = int(a)
                    end = min(int(b), size - 1) if b else size - 1
                else:
                    ln = int(b)
                    start, end = max(0, size - ln), size - 1
                    if ln == 0:
                        start = size
                if start >= size or start > end:
                    self.send_response(416)
                    self.send_header("Content-Range", f"bytes */{size}")
                    self.send_header("Content-Length", "0")
                    self.send_header("Cache-Control", "no-cache")
                    self.end_headers()
                    return
                code = 206
            # multi-range or malformed: ignore and send the whole file (allowed by RFC 9110)
        length = end - start + 1 if size else 0
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(length))
        if code == 206:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        for k, v in hdr.items():
            self.send_header(k, v)
        self.end_headers()
        if self.command == "HEAD" or length <= 0:
            return
        with open(real, "rb") as f:
            f.seek(start)
            left = length
            while left > 0:
                chunk = f.read(min(left, 256 * 1024))
                if not chunk:
                    break
                self.wfile.write(chunk)
                left -= len(chunk)

    # ---- static ---------------------------------------------------------------------------------
    def _index(self):
        with open(os.path.join(APP_DIR, "index.html"), "rb") as f:
            html = f.read()
        try:
            st = store.get_settings()
        except StoreError:
            st = None
        # a JSON data block (no inline script, so the page's CSP can forbid inline scripts); js/boot.js reads
        # it. It is there even when settings.json can't be read ("null"): it also tells js/api.js that this
        # page came from a Fermivie server.
        js = json.dumps(st or None, ensure_ascii=True).replace("<", "\\u003c")
        block = f'<script type="application/json" id="pm-settings">{js}</script>'.encode()
        html = html.replace(b"<!--pm-settings-->", block, 1)
        self._send(200, html, CTYPES[".html"], {"Cache-Control": "no-cache"})

    def _static(self, segs):
        if segs in ([], [""], ["index.html"]):
            return self._index()
        elif len(segs) >= 2 and segs[0] in STATIC_ROOTS and all(segs[1:]) and \
                not any(x.startswith(".") for x in segs):
            path = os.path.join(APP_DIR, *segs)
        else:
            raise not_found("Not found.")
        ext = os.path.splitext(path)[1].lower()
        if ext not in CTYPES:
            raise not_found("Not found.")
        return self._serve_file(path, CTYPES[ext], ranges=False, base=APP_DIR)


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = os.name != "nt"   # on Windows it would let two servers share one port
    request_queue_size = 64


def make_server(port=None, library_dir=None):
    global store
    store = ls.Library(library_dir or LIBRARY_DIR)
    try:
        apply_settings(store.get_settings())
    except StoreError as e:
        print("settings:", e.message, file=sys.stderr)
    return Server(("127.0.0.1", PORT if port is None else port), Handler)


def main():
    srv = make_server()
    print(f"Fermivie on http://localhost:{srv.server_address[1]}  (library: {store.root})", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
