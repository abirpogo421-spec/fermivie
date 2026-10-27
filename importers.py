#!/usr/bin/env python3
"""Paper importers for Fermivie, a local research-paper library.

Turns whatever the user pastes (arXiv id, DOI, publisher link, OpenReview /
ACL Anthology / PubMed Central / INSPIRE / ScienceDirect link, direct PDF link,
or even a paper title) into clean bibliographic metadata plus PDF links,
downloads PDFs safely, and formats citekeys and BibTeX.

Standard library only (written for Python 3.13, works on 3.9+).

Public API
----------
parse_input(text) -> dict             classify pasted text, no network
resolve(text, timeout=20) -> dict     look the paper up online
download_pdf(url, dest_path, timeout=60, max_bytes=300 MiB) -> dict
citekey(meta) -> str                  e.g. "morimoto2016topological"
bibtex(meta, key) -> str              clean BibTeX entry
format_authors_short(authors) -> str  "Morimoto & Nagaosa" / "Vaswani et al."

Extras
------
empty_meta()                 a META dict with every field present
search(query, limit=8)       title search over arXiv + Crossref
pdf_identifiers(data)        DOI / arXiv id / title sniffed from PDF bytes
sniff_pdf_file(path)         same, for a PDF on disk

Notes for callers
-----------------
* resolve(), download_pdf() and search() never raise; failures come back as
  {"ok": False, "error": "<human readable>"}.
* resolve()["source"] is one of "arxiv", "crossref", "openalex", "page",
  "pdf", plus "datacite", "inspire" and "europepmc" for those services.
* META carries one field beyond the core schema: "journal_ref" (the arXiv
  journal reference string, "" when absent).
* parse_input() returns "site", "id" and "label" in addition to
  kind/arxiv/doi/url.  "label" is a short human description such as
  "arXiv 1706.03762v5" for showing before the lookup finishes.
* No e-mail address or other personal data is ever sent to any service.
"""

from __future__ import annotations

import contextlib
import gzip
import hashlib
import html
import http.client
import json
import os
import re
import socket
import ssl
import subprocess
import sys
import tempfile
import threading
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
import difflib
import zlib
from html.parser import HTMLParser

__all__ = [
    "parse_input", "resolve", "download_pdf", "citekey", "bibtex",
    "format_authors_short", "search", "empty_meta", "pdf_identifiers",
    "sniff_pdf_file", "API_USER_AGENT", "BROWSER_USER_AGENT",
    "NO_OA_PDF_WARNING", "clean_abstract", "find_preprint",
]

API_USER_AGENT = "PaperMarker/1.0 (local research reader)"
BROWSER_USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36"
)
HTML_ACCEPT = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
NO_OA_PDF_WARNING = "No open-access PDF found - attach the PDF yourself"
MB = 1024 * 1024


# =============================================================================
# TLS: python.org builds on macOS ship without a CA bundle.  Find one.
# =============================================================================

_SSL_CTX = None
_SSL_LOCK = threading.Lock()
_CA_FILES = (
    "/etc/ssl/cert.pem",                         # macOS, Alpine
    "/etc/ssl/certs/ca-certificates.crt",        # Debian/Ubuntu
    "/etc/pki/tls/certs/ca-bundle.crt",          # Fedora/RHEL
    "/etc/ssl/ca-bundle.pem",                    # openSUSE
    "/opt/homebrew/etc/openssl@3/cert.pem",
    "/usr/local/etc/openssl@3/cert.pem",
    "/usr/local/etc/openssl/cert.pem",
)


def _ca_count(ctx):
    try:
        return ctx.cert_store_stats().get("x509_ca", 0)
    except Exception:
        return 0


def _ssl_context():
    global _SSL_CTX
    with _SSL_LOCK:
        if _SSL_CTX is not None:
            return _SSL_CTX
        ctx = ssl.create_default_context()
        if not _ca_count(ctx):
            for path in (os.environ.get("SSL_CERT_FILE"),) + _CA_FILES:
                if path and os.path.isfile(path):
                    try:
                        ctx.load_verify_locations(cafile=path)
                    except (ssl.SSLError, OSError, ValueError):
                        continue
                    if _ca_count(ctx):
                        break
        if not _ca_count(ctx) and sys.platform == "darwin":
            try:  # last resort: export the system roots from the keychain
                pem = subprocess.run(
                    ["/usr/bin/security", "find-certificate", "-a", "-p",
                     "/System/Library/Keychains/SystemRootCertificates.keychain"],
                    capture_output=True, timeout=20, check=False,
                ).stdout.decode("ascii", "ignore")
                if "BEGIN CERTIFICATE" in pem:
                    ctx.load_verify_locations(cadata=pem)
            except Exception:
                pass
        _SSL_CTX = ctx
        return ctx


# =============================================================================
# HTTP layer
# =============================================================================

class _NetError(Exception):
    """kind: notfound | blocked | ratelimited | timeout | offline | network |
    ssl | http | badurl | toolarge"""

    def __init__(self, kind, message, status=None, url="", body=b"", retry_after=None):
        super().__init__(message)
        self.kind = kind
        self.status = status
        self.url = url
        self.body = body or b""
        self.retry_after = retry_after


class _Resp:
    __slots__ = ("status", "url", "headers", "ctype", "body", "truncated")

    def __init__(self, status, url, headers, ctype, body, truncated):
        self.status = status
        self.url = url
        self.headers = headers
        self.ctype = ctype
        self.body = body
        self.truncated = truncated


class _SafeRedirect(urllib.request.HTTPRedirectHandler):
    max_redirections = 12

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        scheme = urllib.parse.urlsplit(newurl).scheme.lower()
        if scheme not in ("http", "https"):
            raise urllib.error.HTTPError(newurl, code, "refusing non-HTTP redirect", headers, fp)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def _opener():
    # A fresh cookie jar per request: some publishers bounce through a cookie
    # check; nothing is ever persisted.
    return urllib.request.build_opener(
        urllib.request.HTTPSHandler(context=_ssl_context()),
        urllib.request.HTTPCookieProcessor(),
        _SafeRedirect(),
    )


# Per-host politeness: arXiv asks for one API request every 3 s; Crossref's
# public pool allows 5 req/s with concurrency 1.
_HOST_INTERVAL = {
    "export.arxiv.org": 3.0,
    "api.crossref.org": 0.3,
    "api.openalex.org": 0.15,
    "api.datacite.org": 0.2,
    "inspirehep.net": 0.4,
    "www.ebi.ac.uk": 0.2,
    "api2.openreview.net": 0.5,
    "api.openreview.net": 0.5,
    "api.semanticscholar.org": 1.1,
}
_HOST_LOCKS = {}
_HOST_LAST = {}
_GATE_LOCK = threading.Lock()


@contextlib.contextmanager
def _host_gate(host):
    interval = _HOST_INTERVAL.get(host)
    if not interval:
        yield
        return
    with _GATE_LOCK:
        lock = _HOST_LOCKS.setdefault(host, threading.Lock())
    with lock:
        wait = _HOST_LAST.get(host, 0.0) + interval - time.monotonic()
        if wait > 0:
            time.sleep(wait)
        try:
            yield
        finally:
            _HOST_LAST[host] = time.monotonic()


_CACHE = {}
_CACHE_LOCK = threading.Lock()
_CACHE_TTL = 900.0
_CACHE_MAX = 256


def _cache_get(key):
    with _CACHE_LOCK:
        hit = _CACHE.get(key)
        if hit and hit[0] > time.monotonic():
            return hit[1]
        _CACHE.pop(key, None)
    return None


def _cache_put(key, resp):
    with _CACHE_LOCK:
        if len(_CACHE) >= _CACHE_MAX:
            for k in sorted(_CACHE, key=lambda k: _CACHE[k][0])[: _CACHE_MAX // 4]:
                _CACHE.pop(k, None)
        _CACHE[key] = (time.monotonic() + _CACHE_TTL, resp)


def _retry_after(headers):
    try:
        v = headers.get("Retry-After") if headers else None
        return float(v) if v is not None else None
    except (TypeError, ValueError):
        return None


def _read_capped(r, max_bytes):
    chunks, total = [], 0
    while True:
        chunk = r.read(min(65536, max_bytes - total + 1))
        if not chunk:
            return b"".join(chunks), False
        chunks.append(chunk)
        total += len(chunk)
        if total > max_bytes:
            return b"".join(chunks)[:max_bytes], True


def _decode_content(body, encoding):
    encoding = (encoding or "").lower().strip()
    if not body or encoding in ("", "identity"):
        return body
    try:
        if encoding in ("gzip", "x-gzip"):
            try:
                return gzip.decompress(body)
            except Exception:
                return zlib.decompressobj(16 + zlib.MAX_WBITS).decompress(body)
        if encoding == "deflate":
            try:
                return zlib.decompress(body)
            except zlib.error:
                return zlib.decompress(body, -zlib.MAX_WBITS)
    except Exception:
        pass
    return body


def _classify_urlerror(err, url):
    reason = getattr(err, "reason", err)
    if isinstance(reason, (socket.timeout, TimeoutError)):
        return _NetError("timeout", "timed out", url=url)
    if isinstance(reason, socket.gaierror):
        return _NetError("offline", "could not look up the host name", url=url)
    if isinstance(reason, ssl.SSLError):
        return _NetError("ssl", f"secure connection failed ({reason})", url=url)
    return _NetError("network", str(reason) or type(reason).__name__, url=url)


def _do_request(url, headers, timeout, max_bytes):
    req = urllib.request.Request(url, headers=headers, method="GET")
    try:
        with _opener().open(req, timeout=timeout) as r:
            body, truncated = _read_capped(r, max_bytes)
            body = _decode_content(body, r.headers.get("Content-Encoding"))
            return _Resp(getattr(r, "status", 200) or 200, r.geturl(), r.headers,
                         r.headers.get_content_type(), body, truncated)
    except urllib.error.HTTPError as e:
        try:
            body = e.read(512 * 1024) or b""
        except Exception:
            body = b""
        status = e.code
        if status in (404, 410):
            kind = "notfound"
        elif status == 429:
            kind = "ratelimited"
        elif status in (401, 403, 405, 406, 451):
            kind = "blocked"
        else:
            kind = "http"
        final = getattr(e, "filename", None) or url
        raise _NetError(kind, f"HTTP {status}", status=status, url=final, body=body,
                        retry_after=_retry_after(e.headers)) from None
    except urllib.error.URLError as e:
        raise _classify_urlerror(e, url) from None
    except (socket.timeout, TimeoutError):
        raise _NetError("timeout", "timed out", url=url) from None
    except ssl.SSLError as e:
        raise _NetError("ssl", f"secure connection failed ({e})", url=url) from None
    except (http.client.HTTPException, ConnectionError, OSError, ValueError) as e:
        raise _NetError("network", f"{type(e).__name__}: {e}", url=url) from None


def _fetch(url, *, timeout=20, browser=False, accept="*/*", max_bytes=8 * MB,
           retries=None, cache=False, extra_headers=None):
    try:
        parts = urllib.parse.urlsplit(url)
    except ValueError:
        raise _NetError("badurl", f"not a valid link: {url}") from None
    if parts.scheme.lower() not in ("http", "https") or not parts.hostname:
        raise _NetError("badurl", f"not a web link: {url}")
    key = (url, accept, browser, tuple(sorted((extra_headers or {}).items())))
    if cache:
        hit = _cache_get(key)
        if hit is not None:
            return hit
    headers = {"User-Agent": BROWSER_USER_AGENT if browser else API_USER_AGENT,
               "Accept": accept}
    if browser:
        headers["Accept-Language"] = "en-US,en;q=0.9"
    headers.update(extra_headers or {})
    attempts = 1 + (retries if retries is not None else (0 if browser else 1))
    host = parts.hostname.lower()
    for attempt in range(attempts):
        try:
            with _host_gate(host):
                resp = _do_request(url, headers, timeout, max_bytes)
            if cache and resp.status == 200 and not resp.truncated:
                _cache_put(key, resp)
            return resp
        except _NetError as e:
            transient = e.kind in ("ratelimited", "timeout", "network") or (
                e.kind == "http" and e.status in (500, 502, 503, 504))
            if transient and attempt + 1 < attempts:
                time.sleep(min(e.retry_after or 1.5 * (attempt + 1), 5.0))
                continue
            raise
    raise _NetError("network", "request failed", url=url)  # pragma: no cover


def _get_json(url, ctx, retries=1):
    resp = _fetch(url, timeout=ctx.t(), accept="application/json", cache=True, retries=retries)
    try:
        return json.loads(resp.body.decode("utf-8", "replace"))
    except ValueError:
        raise _NetError("http", f"unreadable answer from {urllib.parse.urlsplit(url).hostname}") from None


def _host(url):
    try:
        h = (urllib.parse.urlsplit(url).hostname or "").lower()
    except ValueError:
        return ""
    return h[4:] if h.startswith("www.") else h


def _describe(err, service):
    k = getattr(err, "kind", "")
    if k == "timeout":
        return f"{service} took too long to answer"
    if k == "offline":
        return f"could not reach {service} (are you online?)"
    if k == "ssl":
        return f"secure connection to {service} failed"
    if k == "ratelimited":
        return f"{service} is rate-limiting requests; try again in a minute"
    if k == "blocked":
        return f"{service} refused the request (HTTP {err.status})"
    if k == "notfound":
        return f"{service} has no record of it"
    if k == "badurl":
        return str(err)
    return f"{service}: {err}"


_CHALLENGE_MARKERS = (
    b"cf-turnstile", b"challenge-platform", b"cf_chl_", b"Just a moment...",
    b"Verifying you are human", b"Verifying your browser", b"not a bot",
    b"Attention Required! | Cloudflare", b"_Incapsula_Resource", b"px-captcha",
    b"/.within.website/", b"Please enable JS and disable any ad blocker",
    b"Are you a robot", b"captcha-delivery", b"Request Rejected",
)


def _looks_blocked(resp):
    if resp.status in (202, 403, 429, 503):
        return True
    head = resp.body[:60000]
    return any(m in head for m in _CHALLENGE_MARKERS)


def _blocked_message(url):
    host = _host(url) or "This site"
    return (f"{host} blocks automated access, so the paper could not be loaded "
            "from that link. Paste its DOI or arXiv id instead, or download the "
            "PDF in your browser and attach it.")


def _is_pdf_bytes(body):
    return b"%PDF" in (body or b"")[:1024]


def _is_html_bytes(body):
    head = (body or b"")[:2048].lstrip().lower()
    return head.startswith((b"<!doctype html", b"<html", b"<head", b"<!--", b"<?xml")) or b"<html" in head


def _decode_html(resp):
    charset = None
    try:
        charset = resp.headers.get_content_charset()
    except Exception:
        charset = None
    if not charset:
        m = re.search(rb"<meta[^>]+charset=[\"']?([\w\-]+)", resp.body[:4096], re.I)
        if m:
            charset = m.group(1).decode("ascii", "ignore")
    for cs in (charset, "utf-8"):
        if not cs:
            continue
        try:
            return resp.body.decode(cs, "replace")
        except LookupError:
            continue
    return resp.body.decode("utf-8", "replace")


# =============================================================================
# Text helpers
# =============================================================================

_WS_RE = re.compile(r"\s+")
_TAG_RE = re.compile(r"</?[A-Za-z][\w:.\-]*(?:\s[^<>]*)?/?>")


def _ws(s):
    return _WS_RE.sub(" ", str(s if s is not None else "")).strip()


def _strip_tags(s):
    return _TAG_RE.sub("", s or "")


def _clean_text(s):
    """Strip HTML/MathML tags and entities from a title-like string."""
    if not s:
        return ""
    return _ws(_strip_tags(html.unescape(_strip_tags(str(s)))))


# Abstract markup: only real JATS / HTML / MathML tags (a known name, or any prefixed name such as
# jats:p or mml:mi, with name="value" attributes).  Plain-text inequalities such as "k<k_F and k>k_F",
# "0<T<T_c" or a decoded "&lt;x&gt;" are text and stay as written.
_MARKUP_NAMES = (
    "p|br|hr|sub|sup|i|b|u|s|em|strong|small|big|span|div|font|a|tt|code|q|cite|abbr|mark|del|ins|strike|"
    "h[1-6]|ul|ol|li|dl|dt|dd|blockquote|pre|img|table|thead|tbody|tfoot|tr|td|th|caption|figure|"
    "italic|bold|underline|overline|roman|sc|monospace|sans-serif|xref|title|sec|abstract|trans-abstract|"
    "label|list|list-item|fn|fig|graphic|inline-graphic|media|ext-link|uri|email|named-content|"
    "styled-content|inline-formula|disp-formula|tex-math|alternatives|math|semantics|annotation|"
    "annotation-xml|m(?:i|n|o|s|text|row|sub|sup|subsup|frac|sqrt|root|over|under|underover|fenced|style|"
    "space|padded|phantom|enclose|table|tr|td|multiscripts|prescripts|error|glyph)|none|break|"
    "chem-struct|chem-struct-wrap|disp-quote|attrib|def-list|def-item|term|def|statement|boxed-text|p-group")
_MARKUP_RE = re.compile(
    r"</?(?:[A-Za-z][\w.\-]*:[A-Za-z][\w.\-]*|(?:" + _MARKUP_NAMES + r"))"
    r"(?:\s+[A-Za-z_:][\w:.\-]*\s*=\s*(?:\"[^\"]*\"|'[^']*'|[^\s\"'<>]+))*\s*/?>", re.I)
_ENTITY_RE = re.compile(r"&(?:[A-Za-z][A-Za-z0-9]{1,31}|#[0-9]{1,7}|#[xX][0-9A-Fa-f]{1,6});")


def _strip_markup(s):
    return _MARKUP_RE.sub("", s or "")


def _unescape_entities(s):
    """&lt; &amp; &#x3c7; ... -> characters (only complete entities with a semicolon)."""
    return _ENTITY_RE.sub(lambda m: html.unescape(m.group(0)), s) if "&" in s else s


def _clean_abstract(s):
    """Plain-text abstract from JATS/HTML; paragraphs separated by blank lines."""
    if not s:
        return ""
    s = str(s)
    if _MARKUP_RE.search(s):
        s = re.sub(r"\s+", " ", s)  # whitespace inside markup is not significant
        # MathML / <tex-math> -> $TeX$ (one copy per <alternatives>) before the tags go: stripped,
        # "10<sup>9</sup>" in MathML would read "10 9" and "PbZrO_3" "PbZr O 3"
        s = _mathml_to_tex(s)
    s = re.sub(r"<(?:jats:)?xref\b[^>]*>.*?</(?:jats:)?xref>", "", s, flags=re.S | re.I)

    def sup(m):
        inner = _ws(_strip_markup(m.group(1)))
        before = _strip_markup(m.string[max(0, m.start() - 120):m.start()]).rstrip()[-3:]
        if not inner:
            return ""
        if re.fullmatch(r"[\d\s,;\u2013\u2014\-]+", inner):
            if re.search(r"[,;\u2013\u2014\-]", inner):
                return ""                       # citation range "1-4", "5,6"
            if len(before) >= 2 and before[-1].isalpha() and before[-2].isalpha():
                return ""                       # "effort<sup>12</sup>"
            if before[-1:] in (".", ")", "]", ","):
                return ""
        return "^" + inner if " " not in inner else "^(" + inner + ")"

    s = re.sub(r"<(?:jats:)?sup\b[^>]*>(.*?)</(?:jats:)?sup>", sup, s, flags=re.S | re.I)
    s = re.sub(r"<(?:jats:)?title\b[^>]*>\s*(?:abstract|summary|graphical abstract)\s*"
               r"</(?:jats:)?title>", "\n\n", s, flags=re.S | re.I)
    s = re.sub(r"<(?:jats:)?title\b[^>]*>(.*?)</(?:jats:)?title>",
               lambda m: "\n\n" + _ws(_strip_markup(m.group(1))) + ": ", s, flags=re.S | re.I)
    s = re.sub(r"</?(?:jats:)?p(?:\s+[\w:.\-]+\s*=\s*(?:\"[^\"]*\"|'[^']*'|[^\s\"'<>]+))*\s*/?>", "\n\n", s, flags=re.I)
    s = re.sub(r"<br\s*/?>", "\n\n", s, flags=re.I)
    s = _strip_markup(_unescape_entities(_strip_markup(s)))
    paras = [_ws(p) for p in re.split(r"\n\s*\n", s)]
    s = "\n\n".join(p for p in paras if p)
    s = re.sub(r":\s*\n\n", ": ", s)
    s = re.sub(r" +([,.;)\]])", r"\1", s)
    s = re.sub(r"^Abstract\b[\s:.\-\u2013]*(?=[A-Z0-9])", "", s)
    return s.strip()


# ---- abstracts with math ---------------------------------------------------------------------
# Crossref/APS abstracts carry TeX ({\ensuremath{\chi}}_{2}, ``quotes'', \mathbf{P}), JATS/HTML
# markup and MathML.  clean_abstract() turns all of that into plain text where math stays as
# TeX between $...$ (the library renders it with KaTeX).  It is idempotent.

_MML_RE = re.compile(r"<(?:\w+:)?math\b[^>]*>.*?</(?:\w+:)?math>", re.S | re.I)
_TEXMATH_RE = re.compile(r"<(?:\w+:)?tex-math\b[^>]*>(.*?)</(?:\w+:)?tex-math>", re.S | re.I)
_MML_OPS = {"{": r"\{", "}": r"\}", "#": r"\#", "%": r"\%", "&": r"\&", "_": r"\_",
            "\u2061": "", "\u2062": "", "\u2063": "", "\u00a0": " "}
_MML_FUNCS = {"sin", "cos", "tan", "exp", "log", "ln", "det", "max", "min", "lim", "Re", "Im", "tr", "Tr"}


def _mml_tex(e):
    """MathML element -> TeX (None when it uses something unsupported)."""
    tag = e.tag.rsplit("}", 1)[-1].lower()
    kids = list(e)
    txt = _ws(e.text)
    if tag in ("mi", "mn", "mo", "ms"):
        t = "".join(_MML_OPS.get(c, c) for c in txt)
        if tag == "mi" and txt in _MML_FUNCS:
            return "\\" + txt if txt not in ("Re", "Im", "tr", "Tr") else "\\mathrm{" + txt + "}"
        if tag == "mi" and len(txt) > 1 and txt.isalpha():
            return "\\mathrm{" + t + "}"
        return t
    if tag == "mtext":
        return "\\text{" + txt.replace("{", "").replace("}", "") + "}" if txt else " "
    if tag in ("mspace", "none", "mprescripts"):
        return " " if tag == "mspace" else ""
    if tag == "semantics":
        for k in kids:
            ktag = k.tag.rsplit("}", 1)[-1].lower()
            if ktag == "annotation" and "tex" in (k.get("encoding") or "").lower() and _ws(k.text):
                return _ws(k.text)
        return _mml_tex(kids[0]) if kids else ""
    parts = [_mml_tex(k) for k in kids if k.tag.rsplit("}", 1)[-1].lower() not in ("annotation", "annotation-xml")]
    if any(p is None for p in parts):
        return None
    g = ["{" + p + "}" for p in parts]
    if tag in ("math", "mrow", "mstyle", "mpadded", "mphantom", "merror", "menclose", "mtd"):
        return "".join(parts)
    if tag == "msub" and len(g) == 2:
        return g[0] + "_" + g[1]
    if tag == "msup" and len(g) == 2:
        return g[0] + "^" + g[1]
    if tag == "msubsup" and len(g) == 3:
        return g[0] + "_" + g[1] + "^" + g[2]
    if tag == "mfrac" and len(g) == 2:
        return "\\frac" + g[0] + g[1]
    if tag == "msqrt":
        return "\\sqrt{" + "".join(parts) + "}"
    if tag == "mroot" and len(g) == 2:
        return "\\sqrt[" + parts[1] + "]" + g[0]
    if tag in ("mover", "munder", "munderover") and len(g) >= 2:
        if tag == "mover" and parts[1] in ("\u00af", "\u203e", "\u2015", "-", "\u2212"):
            return "\\bar" + g[0]
        if tag == "mover" and parts[1] in ("\u02dc", "~"):
            return "\\tilde" + g[0]
        if tag == "mover" and parts[1] in ("^", "\u02c6"):
            return "\\hat" + g[0]
        if tag == "mover" and parts[1] in ("\u2192", "\u20d7"):
            return "\\vec" + g[0]
        if tag == "mover" and parts[1] in ("\u02d9", "."):
            return "\\dot" + g[0]
        if tag == "munder":
            return "\\underset" + g[1] + g[0]
        if tag == "mover":
            return "\\overset" + g[1] + g[0]
        return "\\overset" + g[2] + "{\\underset" + g[1] + g[0] + "}" if len(g) == 3 else None
    if tag == "mfenced":
        o, c = e.get("open", "("), e.get("close", ")")
        esc = lambda b: "\\" + b if b in "{}" else b  # noqa: E731
        return "\\left" + (esc(o) or ".") + ",".join(parts) + "\\right" + (esc(c) or ".")
    if tag == "mmultiscripts":
        return "".join(parts)
    return None


def _mathml_to_tex(s):
    """Replace <mml:math> / <tex-math> islands by $TeX$ (or their plain text when unparseable)."""
    def tex_island(m):
        t = html.unescape(m.group(1))
        t = re.sub(r"\\(?:documentclass|usepackage)(?:\[[^\]]*\])?\{[^}]*\}|\\(?:begin|end)\{document\}|"
                   r"\\pagestyle\{[^}]*\}|\\setlength\{[^}]*\}\{[^}]*\}", "", t)
        t = _ws(t).strip()
        t = re.sub(r"^\$+|\$+$", "", t).strip()
        t = re.sub(r"^\\\(|\\\)$|^\\\[|\\\]$", "", t).strip()
        return "$" + t + "$" if t else ""

    # <alternatives> holds the same formula twice; keep the TeX one when there is one
    s = re.sub(r"<(?:\w+:)?alternatives\b[^>]*>(.*?)</(?:\w+:)?alternatives>",
               lambda m: _TEXMATH_RE.search(m.group(1)).group(0) if _TEXMATH_RE.search(m.group(1)) else m.group(1),
               s, flags=re.S | re.I)
    s = _TEXMATH_RE.sub(tex_island, s)

    def mml_island(m):
        x = m.group(0)
        alt = re.search(r"\balttext\s*=\s*\"([^\"]*)\"", x)
        x = re.sub(r"<(/?)[\w.\-]+:", r"<\1", x)
        x = re.sub(r"\s[\w.\-]+:[\w.\-]+\s*=\s*(\"[^\"]*\"|'[^']*')", "", x)
        x = re.sub(r"\sxmlns\s*=\s*(\"[^\"]*\"|'[^']*')", "", x)
        tex = None
        try:
            x = re.sub(r"&(?!(?:lt|gt|amp|quot|apos|#\d+|#x[0-9a-fA-F]+);)(\w+;)?",
                       lambda e: html.unescape(e.group(0)) if e.group(1) else "&amp;", x)
            tex = _mml_tex(ET.fromstring(x))
        except (ET.ParseError, RecursionError, ValueError):
            tex = None
        if tex is None and alt and "\\" in alt.group(1):
            tex = html.unescape(alt.group(1))
        if tex is None:
            return " " + _ws(_strip_tags(m.group(0))) + " "
        tex = _ws(tex)
        return "$" + tex + "$" if tex else ""

    return _MML_RE.sub(mml_island, s)


_ELEMENTS = frozenset(
    "H He Li Be B C N O F Ne Na Mg Al Si P S Cl Ar K Ca Sc Ti V Cr Mn Fe Co Ni Cu Zn Ga Ge As Se "
    "Br Kr Rb Sr Y Zr Nb Mo Tc Ru Rh Pd Ag Cd In Sn Sb Te I Xe Cs Ba La Ce Pr Nd Pm Sm Eu Gd Tb Dy "
    "Ho Er Tm Yb Lu Hf Ta W Re Os Ir Pt Au Hg Tl Pb Bi Po At Rn Fr Ra Ac Th Pa U Np Pu".split())
_TEX_ACCENTS = {"'": "\u0301", "`": "\u0300", "^": "\u0302", '"': "\u0308", "~": "\u0303",
                "=": "\u0304", ".": "\u0307", "c": "\u0327", "v": "\u030c", "u": "\u0306", "H": "\u030b"}
_MATH_SPLIT = re.compile(r"(\$\$.+?\$\$|(?<!\\)\$(?:\\.|[^$\\])+?\$|\\\(.+?\\\)|\\\[.+?\\\])", re.S)


def _formula_like(tok):
    """MoS, WSe, GaAs: two or more chemical element symbols run together."""
    parts = re.findall(r"[A-Z][a-z]?", tok)
    return len(parts) >= 2 and "".join(parts) == tok and all(p in _ELEMENTS for p in parts)


def _count_dollars(s):
    return len(re.findall(r"(?<!\\)\$", s))


def _unwrap_ensuremath(s):
    """\\ensuremath{X} -> X inside math, $X$ outside it."""
    if "\\ensuremath" not in s:
        return s
    out, i = [], 0
    while True:
        j = s.find("\\ensuremath", i)
        if j < 0:
            out.append(s[i:])
            break
        out.append(s[i:j])
        k = j + len("\\ensuremath")
        while k < len(s) and s[k] == " ":
            k += 1
        if k < len(s) and s[k] == "{":
            depth, e = 0, k
            while e < len(s):
                c = s[e]
                if c == "\\":
                    e += 2
                    continue
                if c == "{":
                    depth += 1
                elif c == "}":
                    depth -= 1
                    if depth == 0:
                        break
                e += 1
            inner, end = s[k + 1:e], e + 1
        else:
            m = re.match(r"\\[A-Za-z]+|\S?", s[k:])
            inner = m.group(0)
            end = k + len(inner)
        inner = _unwrap_ensuremath(inner)
        out.append(inner if _count_dollars("".join(out)) % 2 else "$" + inner + "$")
        i = end
    return "".join(out)


# APS-style TeX nothing downstream knows: keep the \ifmmode branch for where it sits (math: \cdot,
# text: \v{c}) and turn spacing-only \phantom{..} / \rule{..}{..} into a thin space.
_IFMMODE = re.compile(r"\\ifmmode\s*(.*?)\s*\\else\s*(.*?)\s*\\fi(?:\{\})?", re.S)
_BLANK_SPACE = re.compile(r"\\[hv]?phantom\s*\{(?:[^{}]|\{(?:[^{}]|\{[^{}]*\})*\})*\}"
                          r"|\\rule\s*(?:\[[^\]]*\])?\s*\{[^{}]*\}\s*\{[^{}]*\}")


def _tex_resolve(s, math):
    if "\\" not in s:
        return s
    s = _IFMMODE.sub(lambda m: m.group(1) if math else m.group(2), s)
    return _BLANK_SPACE.sub(r"\\,", s) if math else re.sub(r"\\textperiodcentered(?:\{\})?", "\u00b7", s)


def _tie_edges(x, i, n):   # a TeX tie against a math segment: $T_c$~K, Fig.~$2$
    if i > 0:
        x = re.sub(r"^~(?=[^\s~])", " ", x)
    return re.sub(r"(?<=[^\s/~\\])~$", " ", x) if i < n - 1 else x


def _tidy_text(t):
    t = t.replace("``", "\u201c").replace("''", "\u201d")
    t = re.sub(r"`([^`'\n]{1,80})'", "\u2018\\1\u2019", t)
    t = t.replace("---", "\u2014")
    t = re.sub(r"(?<!-)--(?!-)", "\u2013", t)
    acc = lambda m: unicodedata.normalize("NFC", m.group(2) + _TEX_ACCENTS[m.group(1)])  # noqa: E731
    t = re.sub(r"\{\\([\'`^\"~=.])\{?([A-Za-z])\}?\}", acc, t)
    t = re.sub(r"\\([\'`^\"~=.])\{?([A-Za-z])\}?", acc, t)
    t = re.sub(r"\\([cvuH])\{([A-Za-z])\}", acc, t)
    for _ in range(2):
        t = re.sub(r"\\(?:emph|textit|textbf|textrm|textsf|texttt|textsc|textup|text|mbox)\{([^{}]*)\}", r"\1", t)
    t = re.sub(r"\{\\(?:it|bf|em|rm|sc|sf|tt)\s+([^{}]*)\}", r"\1", t)
    for _ in range(2):   # TeX grouping braces in running text: {MoS}$_2$ -> MoS$_2$ (\cmd{...} kept)
        t = re.sub(r"(\\[A-Za-z]+\s*)?(?<!\\)\{([^{}\\$]*)\}", lambda m: m.group(0) if m.group(1) else m.group(2), t)
    t = re.sub(r"\\([&%_#])", r"\1", t)
    t = re.sub(r"(?<=[^\s/~\\])~(?=[^\s~])", " ", t)   # TeX tie: 300~K, Ref.~[3] (not ~10 or /~user)
    t = re.sub(r"\\l?dots\b", "\u2026", t)
    t = re.sub(r"\b([A-Z][A-Za-z]{1,9}) (\d{1,2})(?=[\s,.;:)\]]|$)",
               lambda m: m.group(1) + m.group(2) if _formula_like(m.group(1)) else m.group(0), t)
    t = re.sub(r"[ \t]+([,.;:!?)\]])", r"\1", t)
    t = re.sub(r"([(\[])[ \t]+", r"\1", t)
    return t


def _tidy_math(m):
    if not m.startswith("$") or m.startswith("$$"):
        return m
    body = m[1:-1].strip()
    mm = re.match(r"^(.*?)\s*([,.;:])$", body, re.S)
    if mm and mm.group(1).strip() and not mm.group(1).endswith("\\"):
        return "$" + mm.group(1).strip() + "$" + mm.group(2)
    return "$" + body + "$" if body else ""


def clean_abstract(text):
    """Readable abstract: markup stripped, TeX quotes/accents made typographic,
    \\ensuremath unwrapped, math kept as TeX between $...$ for rendering.  Idempotent."""
    if not text:
        return ""
    s = str(text)
    if not _MARKUP_RE.search(s):
        s = _unescape_entities(s)   # &lt;110&gt; in a plain abstract (escaped markup is stripped below)
    if _MARKUP_RE.search(s):
        s = _clean_abstract(_mathml_to_tex(re.sub(r"\s+", " ", s)))
    s = _unwrap_ensuremath(s)
    paras = []
    for p in re.split(r"\n\s*\n", s):
        p = _ws(p)
        if not p:
            continue
        segs = _MATH_SPLIT.split(p)
        p = "".join(_tidy_math(_tex_resolve(x, True)) if i % 2 else _tidy_text(_tie_edges(_tex_resolve(x, False), i, len(segs)))
                    for i, x in enumerate(segs))
        paras.append(_ws(p))
    return "\n\n".join(paras)


_FOLD = str.maketrans({
    "ß": "ss", "ø": "o", "Ø": "O", "æ": "ae", "Æ": "AE", "œ": "oe", "Œ": "OE",
    "ł": "l", "Ł": "L", "đ": "d", "Đ": "D", "ð": "d", "Ð": "D", "þ": "th",
    "Þ": "Th", "ı": "i", "ħ": "h", "ŋ": "ng",
})


def _fold(s):
    s = str(s or "").translate(_FOLD)
    s = unicodedata.normalize("NFKD", s)
    return "".join(c for c in s if not unicodedata.combining(c))


_PARTICLES = {"van", "von", "der", "den", "de", "del", "della", "degli", "di", "da",
              "du", "dos", "das", "do", "le", "la", "ter", "ten", "zu", "zur", "af",
              "av", "bin", "ibn", "al", "el", "y"}
_SUFFIXES = {"jr", "jr.", "sr", "sr.", "ii", "iii", "iv"}


def _fix_case(name):
    # Some registries deposit "MORIMOTO"; leave initials and short tokens alone.
    if len(name) > 3 and name.isupper():
        return " ".join(w.capitalize() if len(w) > 2 else w for w in name.split(" "))
    return name


def _split_name(name):
    """'Last, First' or 'First Middle Last' -> {'given', 'family'}."""
    name = _ws(_clean_text(name)) if name else ""
    name = name.strip(" ,;")
    if not name:
        return None
    if "," in name:
        family, _, given = name.partition(",")
        given = given.strip(" ,")
        if given.lower() in _SUFFIXES and "," in given:  # "King, Jr., Martin"
            suffix, _, given = given.partition(",")
            family = f"{family} {suffix}".strip()
        return {"given": _fix_case(given.strip()), "family": _fix_case(family.strip())}
    toks = name.split(" ")
    if len(toks) == 1:
        return {"given": "", "family": _fix_case(toks[0])}
    suffix = ""
    if len(toks) > 2 and toks[-1].lower() in _SUFFIXES:
        suffix = toks.pop()
    i = len(toks) - 1
    while i - 1 > 0 and toks[i - 1].lower() in _PARTICLES and toks[i - 1][:1].islower():
        i -= 1
    given, family = " ".join(toks[:i]), " ".join(toks[i:])
    if suffix:
        family = f"{family} {suffix}"
    return {"given": _fix_case(given), "family": _fix_case(family)}


_MONTHS = {m: i + 1 for i, m in enumerate(
    ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"])}


def _fmt_date(y, mo=None, d=None):
    try:
        y = int(y)
    except (TypeError, ValueError):
        return None
    if not 1000 <= y <= 2999:
        return None
    try:
        mo = int(mo) if mo not in (None, "") else None
        d = int(d) if d not in (None, "") else None
    except (TypeError, ValueError):
        mo = d = None
    if mo is None or not 1 <= mo <= 12:
        return f"{y:04d}"
    if d is None or not 1 <= d <= 31:
        return f"{y:04d}-{mo:02d}"
    return f"{y:04d}-{mo:02d}-{d:02d}"


def _parse_date(s):
    """'2017/06/12', '2019/6', '2021 Jul 15', '2016-07-07T..', 'July 2016' ..."""
    if s is None:
        return None
    if isinstance(s, int):
        return _fmt_date(s)
    s = _ws(s)
    if not s:
        return None
    m = re.match(r"^(\d{4})(?:[-/.](\d{1,2})(?:[-/.](\d{1,2}))?)?(?!\d)", s)
    if m and (m.group(2) or not re.search(r"[A-Za-z]", s[4:])):
        return _fmt_date(m.group(1), m.group(2), m.group(3))
    ym = re.search(r"(?<!\d)(1[5-9]\d\d|2[0-2]\d\d)(?!\d)", s)
    if not ym:
        return None
    mm = re.search(r"\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?", s, re.I)
    mo = _MONTHS[mm.group(1).lower()] if mm else None
    d = None
    if mo:
        rest = s[:ym.start()] + " " + s[ym.end():]
        dm = re.search(r"(?<!\d)(\d{1,2})(?:st|nd|rd|th)?(?!\d)", rest)
        d = dm.group(1) if dm else None
    return _fmt_date(ym.group(1), mo, d)


def _date_from_parts(obj):
    try:
        parts = (obj or {}).get("date-parts") or []
        p = parts[0] if parts else []
        if not p or p[0] is None:
            return None
        return _fmt_date(*(list(p) + [None, None])[:3])
    except (TypeError, ValueError, IndexError, AttributeError):
        return None


def _norm_title(s):
    return " ".join(re.findall(r"[a-z0-9]+", _fold(_clean_text(s)).lower()))


# =============================================================================
# META
# =============================================================================

_STR_FIELDS = ("title", "venue", "volume", "issue", "pages", "doi", "arxiv",
               "arxiv_version", "abstract", "url", "publisher", "type", "journal_ref")
_TYPES = {"article", "preprint", "inproceedings", "book", "thesis", "misc"}
_ARXIV_CAT_RE = re.compile(r"^[a-z\-]+(?:\.[A-Za-z\-]+)?$")


def empty_meta():
    return {
        "title": "", "authors": [], "year": None, "date": None, "venue": "",
        "volume": "", "issue": "", "pages": "", "doi": "", "arxiv": "",
        "arxiv_version": "", "abstract": "", "url": "", "publisher": "",
        "type": "misc", "categories": [], "journal_ref": "",
    }


def _finalize_meta(m):
    out = empty_meta()
    if isinstance(m, dict):
        out.update({k: v for k, v in m.items() if not str(k).startswith("_")})
    for k in _STR_FIELDS:
        v = out.get(k)
        if v is None:
            out[k] = ""
        elif k == "abstract":
            out[k] = clean_abstract(v)
        else:
            out[k] = _ws(v)
    authors = []
    for a in out.get("authors") or []:
        if isinstance(a, dict):
            given, family = _ws(a.get("given")), _ws(a.get("family"))
            if not family and given:
                family, given = given, ""
            if family:
                authors.append({"given": given, "family": family})
        elif isinstance(a, str):
            sa = _split_name(a)
            if sa:
                authors.append(sa)
    out["authors"] = authors
    d = out.get("date")
    d = d if isinstance(d, str) and re.fullmatch(r"\d{4}(?:-\d{2}(?:-\d{2})?)?", d) else _parse_date(d)
    y = out.get("year")
    try:
        y = int(y) if y not in (None, "") else None
    except (TypeError, ValueError):
        y = None
    if y is not None and not 1000 <= y <= 2999:
        y = None
    if d and y is None:
        y = int(d[:4])
    if y is not None and not d:
        d = str(y)
    out["date"], out["year"] = d, y
    if out["type"] not in _TYPES:
        out["type"] = "misc"
    cats = []
    for c in out.get("categories") or []:
        c = _ws(c)
        if c and c not in cats:
            cats.append(c)
    out["categories"] = cats
    out["pages"] = re.sub(r"\s*[\-\u2010-\u2015]+\s*", "-", out["pages"]).strip("-")
    out["doi"] = re.sub(r"^(?:https?://(?:dx\.)?doi\.org/|doi:\s*)", "", out["doi"], flags=re.I)
    if out["arxiv"]:
        base, ver = _split_arxiv_version(out["arxiv"])
        out["arxiv"] = base
        if ver and not out["arxiv_version"]:
            out["arxiv_version"] = ver
    return out


# =============================================================================
# parse_input
# =============================================================================

_ARXIV_ARCHIVES = (
    "acc-phys", "adap-org", "alg-geom", "ao-sci", "astro-ph", "atom-ph", "bayes-an",
    "chao-dyn", "chem-ph", "cmp-lg", "comp-gas", "cond-mat", "cs", "dg-ga",
    "funct-an", "gr-qc", "hep-ex", "hep-lat", "hep-ph", "hep-th", "math",
    "math-ph", "mtrl-th", "nlin", "nucl-ex", "nucl-th", "patt-sol", "physics",
    "plasm-ph", "q-alg", "q-bio", "q-fin", "quant-ph", "solv-int", "stat",
    "supr-con",
)
_ARCH_ALT = "|".join(sorted((re.escape(a) for a in _ARXIV_ARCHIVES), key=len, reverse=True))
_ARXIV_ID_PAT = (r"(?:(?P<new>\d{4}\.\d{4,5})(?P<nv>v\d+)?(?!\d)"
                 r"|(?P<arch>" + _ARCH_ALT + r")(?:\.[A-Za-z][A-Za-z\-]*)?/(?P<num>\d{7})(?P<ov>v\d+)?(?!\d))")
_ARXIV_ID_RE = re.compile(_ARXIV_ID_PAT, re.I)
_ARXIV_HOSTS = {"arxiv.org", "export.arxiv.org", "ar5iv.org", "ar5iv.labs.arxiv.org",
                "alphaxiv.org", "browse.arxiv.org", "lanl.arxiv.org", "xxx.lanl.gov"}


def _valid_new_core(core):
    yymm, num = core.split(".")
    yy, mm = int(yymm[:2]), int(yymm[2:])
    if not 1 <= mm <= 12:
        return False
    if len(num) == 4:
        return (yy, mm) >= (7, 4) and yy <= 14
    return yy >= 15


def _arxiv_from_match(m):
    if m.group("new"):
        if not _valid_new_core(m.group("new")):
            return ""
        return m.group("new") + (m.group("nv") or "").lower()
    return f"{m.group('arch').lower()}/{m.group('num')}{(m.group('ov') or '').lower()}"


def _match_arxiv_exact(s):
    m = _ARXIV_ID_RE.fullmatch((s or "").strip())
    return _arxiv_from_match(m) if m else ""


def _arxiv_from_path(rest):
    m = _ARXIV_ID_RE.match(rest or "")
    return _arxiv_from_match(m) if m else ""


def _split_arxiv_version(aid):
    m = re.match(r"^(.*?)(v\d+)?$", aid or "")
    return (m.group(1), m.group(2) or "") if m else (aid or "", "")


def _arxiv_doi(base):
    return f"10.48550/arXiv.{base}"


_DOI_TAIL_PATS = [
    re.compile(p, re.I) for p in (
        r"/(?:suppl(?:_file)?|supplementary|supplemental|suppinfo|figures?|tables?|"
        r"media|assets?|attachments?|downloads?)(?:/.*)?$",
        r"\.full\.pdf(?:\+html)?$", r"\.full(?:-text)?$", r"\.abstract$",
        r"\.pdf$", r"\+html$", r"\.html?$",
        r"/(?:full|abstract|abs|summary|pdf|epdf|pdfdirect|pdfft|meta|fulltext|full-text|"
        r"html|references|citedby|cited-by|metrics|reader|view|info|comments|text|"
        r"issuetoc|toc|bibtex|ris|citation)$",
    )
]


def _clean_doi(raw, from_url=False):
    d = str(raw or "").strip()
    if from_url or "%2f" in d.lower() or "%3a" in d.lower():
        d = urllib.parse.unquote(d)
    d = re.sub(r"^(?:https?://)?(?:dx\.)?doi\.org/", "", d, flags=re.I)
    d = re.sub(r"^(?:doi\s*:?\s*|info:doi/|urn:doi:)", "", d, flags=re.I).strip()
    if from_url:
        d = d.split("?")[0].split("#")[0]
    d = _strip_trailing(d.split()[0] if d.split() else "")
    changed = True
    while changed and from_url:
        changed = False
        for pat in _DOI_TAIL_PATS:
            m = pat.search(d)
            if m and m.start() > 8:
                d = d[:m.start()]
                changed = True
        d = d.rstrip("/.,;:")
    if not from_url:
        d = re.sub(r"\.pdf$", "", d, flags=re.I)
    if d.lower().startswith("10.1101/"):
        d = re.sub(r"v\d+$", "", d)
    return d if re.fullmatch(r"10\.\d{4,9}/\S+", d) else ""


_ZW = dict.fromkeys(map(ord, "\u200b\u200c\u200d\u2060\ufeff"), None)
_PAIRS = {"<": ">", "(": ")", "[": "]", "{": "}", '"': '"', "'": "'",
          "\u201c": "\u201d", "\u2018": "\u2019", "`": "`", "\u00ab": "\u00bb"}
_CLOSERS = {")": "(", "]": "[", "}": "{"}


def _strip_trailing(s):
    while s:
        c = s[-1]
        if c in ".,;:!?'\"\u201d\u2019>`\u00bb":
            s = s[:-1].rstrip()
            continue
        if c in _CLOSERS and s.count(_CLOSERS[c]) < s.count(c):
            s = s[:-1].rstrip()
            continue
        break
    return s


def _clean_input(text):
    if text is None:
        return ""
    s = str(text).translate(_ZW).replace("\u00a0", " ").strip()
    for _ in range(5):
        before = s
        if len(s) >= 2 and s[0] in _PAIRS and s[-1] == _PAIRS[s[0]]:
            s = s[1:-1].strip()
        if s[:1] in ("<", "(", "[", "{") and s.count(s[0]) > s.count(_PAIRS[s[0]]):
            s = s[1:].strip()
        if s[:1] in ('"', "'", "\u201c", "\u2018", "`"):
            s = s[1:].strip()
        s = _strip_trailing(s)
        if s == before:
            break
    return s


_DOMAINISH = re.compile(
    r"^(?:www\.[a-z0-9.\-]+\.[a-z]{2,24}(?::\d+)?(?:[/?#]|$)"
    r"|(?:[a-z0-9](?:[a-z0-9\-]*[a-z0-9])?\.)+[a-z]{2,24}(?::\d+)?/)", re.I)


def _arxiv_result(aid, url="", doi=""):
    return {"kind": "arxiv", "arxiv": aid, "doi": doi,
            "url": url or f"https://arxiv.org/abs/{aid}", "site": "arxiv", "id": aid}


def _doi_result(doi, url="", site=""):
    m = re.match(r"^10\.48550/arxiv\.(.+)$", doi, re.I)
    if m:
        aid = _match_arxiv_exact(m.group(1))
        if aid:
            base, _ = _split_arxiv_version(aid)
            return _arxiv_result(aid, url=url, doi=_arxiv_doi(base))
    return {"kind": "doi", "arxiv": "", "doi": doi, "url": url or f"https://doi.org/{doi}",
            "site": site or "doi", "id": doi}


def _url_result(kind, url, site="", ident=""):
    return {"kind": kind, "arxiv": "", "doi": "", "url": url, "site": site, "id": ident}


def _classify_url(url):
    try:
        p = urllib.parse.urlsplit(url)
        host = (p.hostname or "").lower()
    except ValueError:
        return None
    if p.scheme.lower() not in ("http", "https") or not host or "." not in host:
        return None
    if p.scheme.lower() == "http" and host.endswith("arxiv.org"):
        url = "https" + url[4:]
    h = host[4:] if host.startswith("www.") else host
    path = urllib.parse.unquote(p.path or "")
    try:
        qs = urllib.parse.parse_qs(p.query)
    except ValueError:
        qs = {}

    # arXiv and mirrors
    if h in _ARXIV_HOSTS or h.endswith(".arxiv.org"):
        m = re.search(r"/(?:abs|pdf|html|format|ps|src|e-print|papers|overview|v)/(.+)$", path)
        aid = _arxiv_from_path(m.group(1)) if m else ""
        if aid:
            return _arxiv_result(aid, url=url)
        return _url_result("url", url, "arxiv")
    if h == "huggingface.co":
        m = re.match(r"^/papers/(.+)$", path)
        aid = _arxiv_from_path(m.group(1)) if m else ""
        if aid:
            return _arxiv_result(aid, url=url)

    # doi.org resolver links
    if h in ("doi.org", "dx.doi.org") or h.endswith(".doi.org"):
        d = _clean_doi(path.lstrip("/"), from_url=True)
        if d:
            return _doi_result(d, url=url, site="doi")

    # Nature: /articles/<id> is DOI 10.1038/<id>
    if h == "nature.com" or h.endswith(".nature.com"):
        m = re.search(r"/articles/([a-z][a-z0-9\-._]*?)(?:\.pdf)?/?$", path, re.I)
        if not m:
            m = re.search(r"/(?:full|abs|pdf|fp)/([a-z]+\d[\w\-]*?)(?:_[a-z]+)?\.(?:html|pdf)$", path, re.I)
        if m:
            return _doi_result(f"10.1038/{m.group(1)}", url=url, site="nature")

    if h == "openreview.net":
        oid = (qs.get("id") or qs.get("noteId") or [""])[0].strip()
        if re.fullmatch(r"[A-Za-z0-9_\-]{5,40}", oid):
            return _url_result("url", f"https://openreview.net/forum?id={oid}", "openreview", oid)
        return _url_result("url", url, "openreview")

    if h in ("aclanthology.org", "aclweb.org", "aclanthology.info"):
        m = re.search(r"/(?:anthology/)?([A-Z]\d{2}-\d{4}|\d{4}\.[a-z0-9]+(?:-[a-z0-9]+)*\.\d+)"
                      r"(?:v\d+)?(?:\.pdf|\.bib|\.xml)?/?$", path)
        if m:
            aid = m.group(1)
            return _url_result("url", f"https://aclanthology.org/{aid}/", "acl", aid)

    if h in ("pmc.ncbi.nlm.nih.gov", "ncbi.nlm.nih.gov", "europepmc.org") or h.endswith(".ncbi.nlm.nih.gov"):
        m = re.search(r"(PMC\d{3,10})", path, re.I)
        if m and (h != "ncbi.nlm.nih.gov" or "/pmc/" in path):
            pmc = m.group(1).upper()
            return _url_result("url", f"https://pmc.ncbi.nlm.nih.gov/articles/{pmc}/", "pmc", pmc)
        m = (re.match(r"^/(\d{4,9})/?$", path) if h == "pubmed.ncbi.nlm.nih.gov" else
             re.match(r"^/pubmed/(\d{4,9})/?$", path) if h == "ncbi.nlm.nih.gov" else
             re.match(r"^/(?:article|abstract)/MED/(\d{4,9})", path, re.I) if h == "europepmc.org" else None)
        if m:
            pmid = m.group(1)
            return _url_result("url", f"https://pubmed.ncbi.nlm.nih.gov/{pmid}/", "pubmed", pmid)

    if h in ("semanticscholar.org", "api.semanticscholar.org"):
        m = re.search(r"/arxiv/(.+)$", path)
        aid = _arxiv_from_path(m.group(1)) if m else ""
        if aid:
            return _arxiv_result(aid, url=url)
        m = re.search(r"(?<![0-9a-f])([0-9a-f]{40})(?![0-9a-f])", path)
        if m:
            return _url_result("url", url, "s2", m.group(1))

    if h in ("ui.adsabs.harvard.edu", "adsabs.harvard.edu", "articles.adsabs.harvard.edu"):
        m = re.search(r"/abs/([0-9]{4}[A-Za-z0-9.&]{14}[A-Za-z.])(?:/|$)", path)
        if m:
            bib = m.group(1)
            am = re.match(r"^(\d{4})arXiv(\d{4})\.?(\d{4,5})[A-Z.]$", bib)
            if am:
                aid = _match_arxiv_exact(f"{am.group(2)}.{am.group(3)}")
                if aid:
                    return _arxiv_result(aid, url=url)
            return _url_result("url", url, "ads", bib)

    if h == "inspirehep.net":
        m = re.match(r"^/(?:api/)?(?:literature|record)/(\d+)", path)
        if m:
            rid = m.group(1)
            return _url_result("url", f"https://inspirehep.net/literature/{rid}", "inspire", rid)

    if h in ("sciencedirect.com", "cell.com", "thelancet.com", "linkinghub.elsevier.com") \
            or h.endswith(".sciencedirect.com") or h.endswith(".cell.com"):
        m = re.search(r"(?:pii/|PII|fulltext/|abstract/|retrieve/pii/)(S?[\dX][\dX\-()]{14,24}[\dX])", path, re.I)
        if m:
            pii = re.sub(r"[^0-9X]", "", m.group(1).upper())
            pii = "S" + pii if not pii.startswith("S") else pii
            if len(pii) >= 15:
                return _url_result("url", url, "elsevier", pii)

    if h in ("biorxiv.org", "medrxiv.org"):
        m = re.search(r"/content/(10\.1101/[^?#]+)", path)
        if m:
            d = _clean_doi(m.group(1), from_url=True)
            if d:
                return _doi_result(d, url=url, site=h.split(".")[0])
        m = re.search(r"(?<![\d.])(\d{4}\.\d{2}\.\d{2}\.\d{6})(?![\d])", path)
        if m:
            return _doi_result(f"10.1101/{m.group(1)}", url=url, site=h.split(".")[0])

    # Generic: a DOI in the path or in a query value
    m = re.search(r"(10\.\d{4,9}/[^\s?#]+)", path)
    if m:
        d = _clean_doi(m.group(1), from_url=True)
        if d:
            return _doi_result(d, url=url, site=h)
    for vals in qs.values():
        for v in vals:
            m = re.search(r"(10\.\d{4,9}/\S+)", v)
            if m:
                d = _clean_doi(m.group(1), from_url=True)
                if d:
                    return _doi_result(d, url=url, site=h)

    if path.lower().endswith(".pdf"):
        return _url_result("pdf_url", url, h)
    return _url_result("url", url, h)


def _classify_token(s):
    if not s:
        return None
    m = re.match(r"^arxiv\s*:\s*(.+)$", s, re.I)
    if m:
        aid = _match_arxiv_exact(m.group(1).strip())
        if aid:
            return _arxiv_result(aid)
    aid = _match_arxiv_exact(s)
    if aid:
        return _arxiv_result(aid)
    m = re.match(r"^(?:doi\s*:?\s*|info:doi/|urn:doi:)(10\.\S+)$", s, re.I)
    if m:
        d = _clean_doi(m.group(1))
        if d:
            return _doi_result(d)
    if re.match(r"^10\.\d{4,9}/\S+$", s):
        d = _clean_doi(s)
        if d:
            return _doi_result(d)
    if re.match(r"^https?://", s, re.I):
        return _classify_url(s)
    if " " not in s and _DOMAINISH.match(s):
        return _classify_url("https://" + s)
    return None


def _find_embedded(s):
    """Pull an identifier out of free text such as a pasted citation."""
    m = re.search(r"https?://[^\s<>\"'\u201c\u201d]+", s, re.I)
    if m:
        r = _classify_token(_strip_trailing(m.group(0)))
        if r:
            return r
    m = re.search(r"arxiv\s*:\s*(" + _ARXIV_ID_PAT + r")", s, re.I)
    if m:
        aid = _arxiv_from_match(_ARXIV_ID_RE.match(m.group(1)))
        if aid:
            return _arxiv_result(aid)
    m = re.search(r"(?<![\w.])10\.\d{4,9}/[^\s\"'<>]+", s)
    if m:
        d = _clean_doi(_strip_trailing(m.group(0)))
        if d:
            return _doi_result(d)
    if "arxiv" in s.lower() or len(s.split()) <= 3:
        for m in re.finditer(r"(?<![\w./])" + _ARXIV_ID_PAT, s, re.I):
            aid = _arxiv_from_match(m)
            if aid:
                return _arxiv_result(aid)
    return None


_SITE_NAMES = {"openreview": "OpenReview", "acl": "ACL Anthology", "pmc": "PubMed Central",
               "pubmed": "PubMed", "inspire": "INSPIRE", "elsevier": "ScienceDirect",
               "s2": "Semantic Scholar", "ads": "NASA ADS"}


def _label(r):
    k = r["kind"]
    if k == "arxiv":
        return f"arXiv {r['arxiv']}"
    if k == "doi":
        return f"DOI {r['doi']}"
    if k == "pdf_url":
        return f"PDF link ({_host(r['url'])})"
    if k == "url":
        if r["site"] in _SITE_NAMES and r["id"]:
            return f"{_SITE_NAMES[r['site']]} {r['id']}"
        return f"Web page ({_host(r['url'])})"
    return ""


def parse_input(text):
    """Classify pasted text without touching the network.

    Returns {"kind": "arxiv"|"doi"|"url"|"pdf_url"|"unknown", "arxiv": str,
    "doi": str, "url": str, "site": str, "id": str, "label": str}.
    "arxiv" keeps the version if one was given; old-style ids are normalised
    to the canonical archive/number form ("math.AG/0601001" -> "math/0601001").
    "url" is the pasted link, or the canonical landing page for bare ids.
    """
    out = {"kind": "unknown", "arxiv": "", "doi": "", "url": "", "site": "", "id": "", "label": ""}
    try:
        s = _clean_input(text)
        if not s:
            return out
        r = _classify_token(s)
        if r is None and re.search(r"\s", s):
            r = _find_embedded(s)
        if r:
            out.update(r)
        out["label"] = _label(out)
    except Exception:  # parse_input must never raise on odd input
        out = {"kind": "unknown", "arxiv": "", "doi": "", "url": "", "site": "", "id": "", "label": ""}
    return out


# =============================================================================
# HTML <meta> harvesting
# =============================================================================

class _HeadParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.meta = {}
        self.links = []
        self.title = ""
        self.jsonld = []
        self._in_title = False
        self._title_done = False
        self._script = None

    def handle_starttag(self, tag, attrs):
        a = {}
        for k, v in attrs:
            a[(k or "").lower()] = v if v is not None else ""
        if tag == "meta":
            key = a.get("name") or a.get("property") or a.get("itemprop")
            if key and "content" in a:
                self.meta.setdefault(key.strip().lower(), []).append(_ws(a["content"]))
        elif tag == "link":
            self.links.append(a)
        elif tag == "title" and not self._title_done:
            self._in_title = True
        elif tag == "script":
            self._script = [] if "ld+json" in a.get("type", "").lower() else None

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)

    def handle_endtag(self, tag):
        if tag == "title" and self._in_title:
            self._in_title = False
            self._title_done = True
        elif tag == "script" and self._script is not None:
            self.jsonld.append("".join(self._script))
            self._script = None

    def handle_data(self, data):
        if self._in_title:
            self.title += data
        if self._script is not None:
            self._script.append(data)


def _parse_html(text):
    p = _HeadParser()
    try:
        p.feed(text)
        p.close()
    except Exception:
        pass
    return p


def _split_people_list(s):
    if not s:
        return []
    parts = re.split(r"\s*;\s*|\s+and\s+|\s*&\s*", s)
    return [p for p in (x.strip() for x in parts) if p]


def _first_doi(values):
    for v in values:
        if not v:
            continue
        m = re.search(r"10\.\d{4,9}/[^\s\"'<>]+", str(v))
        if m:
            d = _clean_doi(m.group(0), from_url=str(v).lower().startswith("http"))
            if d:
                return d
    return ""


def _jsonld_article(scripts):
    wanted = ("ScholarlyArticle", "MedicalScholarlyArticle", "Article", "Report", "Thesis",
              "Chapter", "Book", "CreativeWork", "TechArticle")
    found = []

    def walk(o):
        if isinstance(o, list):
            for x in o:
                walk(x)
        elif isinstance(o, dict):
            t = o.get("@type")
            ts = t if isinstance(t, list) else [t]
            if any(x in wanted for x in ts if isinstance(x, str)):
                found.append(o)
            for k in ("@graph", "mainEntity"):
                if k in o:
                    walk(o[k])

    for raw in scripts[:8]:
        raw = raw.strip()
        raw = re.sub(r"^\s*(?:<!--|//<!\[CDATA\[)|(?:-->|//\]\]>)\s*$", "", raw)
        try:
            walk(json.loads(raw))
        except ValueError:
            continue
    if not found:
        return {}
    found.sort(key=lambda o: 0 if "Scholarly" in str(o.get("@type")) else 1)
    o = found[0]

    def name_of(x):
        if isinstance(x, str):
            return x
        if isinstance(x, dict):
            if x.get("familyName"):
                return f"{x.get('familyName')}, {x.get('givenName', '')}".strip(", ")
            return x.get("name", "")
        return ""

    authors = o.get("author") or o.get("creator") or []
    if not isinstance(authors, list):
        authors = [authors]
    part = o.get("isPartOf") or {}
    if isinstance(part, list):
        part = part[0] if part else {}
    ident = o.get("identifier") or o.get("sameAs") or ""
    return {
        "title": _clean_text(o.get("headline") or o.get("name") or ""),
        "authors": [n for n in (name_of(a) for a in authors) if n],
        "date": o.get("datePublished") or o.get("dateCreated") or "",
        "venue": name_of(part) if part else "",
        "doi": _first_doi([json.dumps(ident)]) if ident else "",
    }


def _meta_from_page(pm, page_url):
    def g(*keys):
        for k in keys:
            for v in pm.meta.get(k, ()):
                if v:
                    return v
        return ""

    def all_(k):
        return [v for v in pm.meta.get(k, ()) if v]

    sch_title = g("citation_title", "bepress_citation_title", "dc.title", "dcterms.title",
                  "eprints.title", "prism.title")
    ld = _jsonld_article(pm.jsonld) if pm.jsonld else {}
    scholarly = bool(sch_title)
    title = _clean_text(sch_title or ld.get("title") or g("og:title", "twitter:title") or pm.title)

    raw_authors = (all_("citation_author") or all_("bepress_citation_author")
                   or _split_people_list(g("citation_authors")) or all_("dc.creator")
                   or all_("dcterms.creator") or all_("eprints.creators_name")
                   or ld.get("authors") or _split_people_list(g("author")))
    authors = [a for a in (_split_name(x) for x in raw_authors) if a]

    date = _parse_date(g("citation_publication_date", "citation_date", "citation_online_date",
                         "citation_cover_date", "bepress_citation_date", "dc.date",
                         "dcterms.issued", "dcterms.date", "dc.date.issued",
                         "prism.publicationdate", "prism.coverdate", "eprints.date",
                         "citation_year", "article:published_time") or ld.get("date"))
    conf = g("citation_conference_title", "citation_conference")
    journal = g("citation_journal_title", "bepress_citation_journal_title", "prism.publicationname")
    book = g("citation_book_title", "citation_inbook_title")
    inst = g("citation_dissertation_institution", "citation_technical_report_institution")
    venue = conf or journal or book or g("dc.source", "eprints.publication") or inst or ld.get("venue", "")

    fp = g("citation_firstpage", "prism.startingpage", "bepress_citation_firstpage")
    lp = g("citation_lastpage", "prism.endingpage", "bepress_citation_lastpage")
    pages = fp + (f"-{lp}" if lp and lp != fp else "") if fp else ""

    doi = _first_doi([g("citation_doi"), g("bepress_citation_doi"), g("prism.doi"),
                      *all_("dc.identifier"), *all_("dcterms.identifier"),
                      g("citation_identifier"), ld.get("doi", "")])
    pdf = g("citation_pdf_url", "bepress_citation_pdf_url", "eprints.document_url")
    if not pdf:
        for ln in pm.links:
            if "alternate" in ln.get("rel", "").lower() and "pdf" in ln.get("type", "").lower() and ln.get("href"):
                pdf = ln["href"]
                break
    if pdf:
        pdf = urllib.parse.urljoin(page_url, pdf)
    arxiv = _match_arxiv_exact(g("citation_arxiv_id"))

    abstract = g("citation_abstract", "dc.description", "dcterms.abstract",
                 "dcterms.description", "eprints.abstract")
    if not abstract and scholarly:
        # Page descriptions are often a citation line ("A. Author. Proc. of X");
        # only trust a long one that does not repeat the authors or venue.
        d = g("og:description", "description", "twitter:description")
        first_fam = authors[0]["family"].lower() if authors else ""
        if len(d) >= 200 and not (first_fam and first_fam in d.lower()) \
                and not (venue and venue.lower()[:40] in d.lower()):
            abstract = d

    canon = g("citation_abstract_html_url")
    if not canon:
        for ln in pm.links:
            if ln.get("rel", "").lower() == "canonical" and ln.get("href"):
                canon = ln["href"]
                break
    canon = urllib.parse.urljoin(page_url, canon) if canon else page_url

    if conf:
        typ = "inproceedings"
    elif journal:
        typ = "article"
    elif g("citation_dissertation_institution"):
        typ = "thesis"
    elif arxiv:
        typ = "preprint"
    else:
        typ = "misc"

    meta = empty_meta()
    meta.update(
        title=title, authors=authors, date=date, venue=venue or ("arXiv" if arxiv else ""),
        volume=g("citation_volume", "prism.volume", "bepress_citation_volume"),
        issue=g("citation_issue", "prism.number", "bepress_citation_issue"),
        pages=pages, doi=doi, arxiv=arxiv, abstract=_clean_abstract(abstract), url=canon,
        publisher=g("citation_publisher", "dc.publisher", "dcterms.publisher",
                    "bepress_citation_publisher", "eprints.publisher"),
        type=typ,
    )
    return meta, {"doi": doi, "pdf": pdf, "arxiv": arxiv, "scholarly": scholarly}


# =============================================================================
# Source-specific metadata builders
# =============================================================================

_ATOM = {"a": "http://www.w3.org/2005/Atom", "arxiv": "http://arxiv.org/schemas/atom"}


def _arxiv_entry_meta(entry, requested_ver=""):
    eid = (entry.findtext("a:id", "", _ATOM) or "").strip()
    title = _ws(entry.findtext("a:title", "", _ATOM))
    if "/api/errors" in eid or title == "Error":
        raise _NetError("notfound", _ws(entry.findtext("a:summary", "", _ATOM)) or "arXiv error", status=400)
    m = re.search(r"arxiv\.org/abs/(.+?)(v\d+)?$", eid)
    base = m.group(1) if m else ""
    ver = (m.group(2) or "") if m else ""
    meta = empty_meta()
    meta.update(title=title, abstract=_ws(entry.findtext("a:summary", "", _ATOM)),
                venue="arXiv", publisher="arXiv", type="preprint", arxiv=base,
                arxiv_version=requested_ver or ver, url=f"https://arxiv.org/abs/{base}")
    meta["authors"] = [a for a in (_split_name(x.findtext("a:name", "", _ATOM))
                                   for x in entry.findall("a:author", _ATOM)) if a]
    meta["date"] = _parse_date(entry.findtext("a:published", "", _ATOM))
    doi = _ws(entry.findtext("arxiv:doi", "", _ATOM))
    meta["doi"] = (_clean_doi(doi.split()[0]) if doi else "") or _arxiv_doi(base)
    meta["journal_ref"] = _ws(entry.findtext("arxiv:journal_ref", "", _ATOM))
    cats = []
    prim = entry.find("arxiv:primary_category", _ATOM)
    if prim is not None and prim.get("term"):
        cats.append(prim.get("term"))
    for c in entry.findall("a:category", _ATOM):
        t = c.get("term") or ""
        if t and t not in cats and _ARXIV_CAT_RE.match(t):
            cats.append(t)
    meta["categories"] = cats
    return meta


def _arxiv_api_meta(ctx, base, ver):
    url = "https://export.arxiv.org/api/query?" + urllib.parse.urlencode(
        {"id_list": base + ver, "max_results": "1"})
    resp = _fetch(url, timeout=ctx.t(), accept="application/atom+xml, application/xml;q=0.9",
                  cache=True, retries=1)
    try:
        root = ET.fromstring(resp.body)
    except ET.ParseError:
        raise _NetError("http", "arXiv returned an unreadable answer") from None
    entry = root.find("a:entry", _ATOM)
    if entry is None:
        raise _NetError("notfound", "arXiv returned no entry", status=404)
    return _arxiv_entry_meta(entry, ver)


def _arxiv_page_meta(ctx, base, ver):
    url = f"https://arxiv.org/abs/{base}{ver}"
    resp = _fetch(url, timeout=ctx.t(), browser=True, accept=HTML_ACCEPT, max_bytes=3 * MB)
    meta, info = _meta_from_page(_parse_html(_decode_html(resp)), url)
    if not meta["title"]:
        raise _NetError("http", "no metadata on the arXiv page")
    doi = info["doi"] if info["doi"] and not info["doi"].lower().startswith("10.48550/") else ""
    meta.update(venue="arXiv", publisher="arXiv", type="preprint", arxiv=base,
                arxiv_version=ver, url=f"https://arxiv.org/abs/{base}",
                doi=doi or _arxiv_doi(base))
    return meta


_CROSSREF_TYPES = {
    "journal-article": "article", "proceedings-article": "inproceedings",
    "book": "book", "monograph": "book", "edited-book": "book", "reference-book": "book",
    "book-set": "book", "dissertation": "thesis", "posted-content": "preprint",
}
_SERIES_PREFIXES = ("lecture notes in", "communications in computer", "advances in intelligent",
                    "springer proceedings", "smart innovation", "lecture notes of the")


def _crossref_message(ctx, doi):
    url = "https://api.crossref.org/works/" + urllib.parse.quote(doi, safe="/()")
    data = _get_json(url, ctx)
    msg = data.get("message") if isinstance(data, dict) else None
    if not isinstance(msg, dict):
        raise _NetError("http", "unexpected Crossref answer")
    return msg


def _meta_from_crossref(msg, doi_hint=""):
    meta = empty_meta()
    title = _clean_text((msg.get("title") or [""])[0])
    sub = _clean_text((msg.get("subtitle") or [""])[0]) if msg.get("subtitle") else ""
    if sub and sub.lower() not in title.lower():
        title = f"{title}: {sub}" if title else sub
    people = msg.get("author") or msg.get("editor") or []
    authors = []
    for a in people:
        fam = _clean_text(a.get("family") or a.get("name") or "")
        giv = _clean_text(a.get("given") or "")
        if fam or giv:
            authors.append({"given": _fix_case(giv), "family": _fix_case(fam or giv) if fam else giv})
    ctype = msg.get("type") or ""
    containers = [_clean_text(c) for c in (msg.get("container-title") or []) if c]
    venue = ""
    if containers:
        venue = containers[-1] if len(containers) > 1 and containers[0].lower().startswith(_SERIES_PREFIXES) else containers[0]
    if ctype == "posted-content" or (ctype == "dissertation" and not venue):
        inst = msg.get("institution") or []
        if isinstance(inst, dict):
            inst = [inst]
        venue = venue or (inst[0].get("name", "") if inst else "") or msg.get("group-title", "")
    typ = _CROSSREF_TYPES.get(ctype, "misc")
    if ctype == "posted-content" and (msg.get("subtype") or "preprint") != "preprint":
        typ = "misc"
    if ctype in ("book-chapter", "book-part", "book-section") and re.search(
            r"proceedings|conference|workshop|symposium|lecture notes", " ".join(containers), re.I):
        typ = "inproceedings"
    date = None
    for k in ("issued", "published-print", "published-online", "posted", "created"):
        date = _date_from_parts(msg.get(k))
        if date:
            break
    doi = msg.get("DOI") or doi_hint
    if doi_hint and doi and doi_hint.lower() == doi.lower():
        doi = doi_hint
    meta.update(
        title=title, authors=authors, date=date, venue=venue,
        volume=str(msg.get("volume") or ""), issue=str(msg.get("issue") or ""),
        pages=str(msg.get("page") or msg.get("article-number") or ""),
        doi=doi, abstract=_clean_abstract(msg.get("abstract") or ""),
        url=f"https://doi.org/{doi}" if doi else "", publisher=_clean_text(msg.get("publisher") or ""),
        type=typ, categories=[_clean_text(s) for s in (msg.get("subject") or [])][:8],
    )
    return meta


def _crossref_oa_links(msg):
    """PDF links from Crossref that are explicitly openly licensed."""
    licensed = any("creativecommons.org" in (l.get("URL") or "") for l in (msg.get("license") or []))
    if not licensed:
        return []
    out = []
    for l in msg.get("link") or []:
        u = l.get("URL") or ""
        if "pdf" in (l.get("content-type") or "") and u.startswith("http") and not re.search(
                r"api\.elsevier\.com|harvest\.aps\.org|api\.wiley\.com|tdm", u):
            out.append(u)
    return out


_DATACITE_TYPES = {"Preprint": "preprint", "JournalArticle": "article", "ConferencePaper": "inproceedings",
                   "ConferenceProceeding": "inproceedings", "Book": "book", "Dissertation": "thesis"}


def _datacite_meta(ctx, doi):
    url = "https://api.datacite.org/dois/" + urllib.parse.quote(doi, safe="/()")
    data = _get_json(url, ctx)
    a = ((data or {}).get("data") or {}).get("attributes") or {}
    if not a:
        raise _NetError("notfound", "DataCite has no record", status=404)
    meta = empty_meta()
    titles = a.get("titles") or []
    authors = []
    for c in a.get("creators") or []:
        if c.get("familyName"):
            authors.append({"given": c.get("givenName") or "", "family": c["familyName"]})
        elif c.get("name"):
            authors.append(_split_name(c["name"]) if c.get("nameType") != "Organizational"
                           else {"given": "", "family": c["name"]})
    date = None
    for want in ("Issued", "Submitted", "Available", "Created"):
        for d in a.get("dates") or []:
            if d.get("dateType") == want and d.get("date"):
                date = _parse_date(d["date"])
                break
        if date:
            break
    publisher = a.get("publisher") or ""
    if isinstance(publisher, dict):
        publisher = publisher.get("name", "")
    container = (a.get("container") or {}).get("title") or ""
    rtype = (a.get("types") or {}).get("resourceTypeGeneral") or ""
    abstract = ""
    for d in a.get("descriptions") or []:
        if d.get("description") and d.get("descriptionType", "Abstract") == "Abstract":
            abstract = d["description"]
            break
    cats = []
    for s in a.get("subjects") or []:
        m = re.search(r"\(([a-z\-]+(?:\.[A-Za-z\-]+)?)\)\s*$", s.get("subject") or "")
        if m and s.get("subjectScheme") == "arXiv":
            cats.append(m.group(1))
    meta.update(title=_clean_text(titles[0].get("title") if titles else ""),
                authors=[x for x in authors if x], date=date or a.get("publicationYear"),
                venue=container or publisher, publisher=publisher, doi=a.get("doi") or doi,
                abstract=_clean_abstract(abstract), url=f"https://doi.org/{doi}",
                type=_DATACITE_TYPES.get(rtype, "misc"), categories=cats)
    if doi.lower() == (a.get("doi") or "").lower():
        meta["doi"] = doi
    return meta


def _openalex_work(ctx, doi):
    url = "https://api.openalex.org/works/doi:" + urllib.parse.quote(doi, safe="/()")
    data = _get_json(url, ctx)
    if not isinstance(data, dict) or not data.get("id"):
        raise _NetError("notfound", "OpenAlex has no record", status=404)
    return data


def _openalex_abstract(work):
    inv = work.get("abstract_inverted_index") or {}
    if not isinstance(inv, dict) or not inv:
        return ""
    pos = {}
    for word, idxs in inv.items():
        for i in idxs or []:
            if isinstance(i, int):
                pos[i] = word
    return _ws(" ".join(pos[i] for i in sorted(pos)))


def _arxiv_id_in_url(u):
    if not u or "arxiv" not in u.lower():
        return ""
    r = _classify_url(u if u.startswith("http") else "https://" + u)
    if r and r.get("kind") == "arxiv":
        return _split_arxiv_version(r["arxiv"])[0]
    m = re.search(r"10\.48550/arxiv\.(.+)$", u, re.I)
    return _split_arxiv_version(_match_arxiv_exact(m.group(1)))[0] if m else ""


def _openalex_pdf_info(work):
    best = work.get("best_oa_location") or {}
    locs = [best] + [l for l in (work.get("locations") or []) if l]
    arx, others, first_arxiv = [], [], ""
    for loc in locs:
        pdf = loc.get("pdf_url") or ""
        aid = (_arxiv_id_in_url(pdf) or _arxiv_id_in_url(loc.get("landing_page_url") or "")
               or _arxiv_id_in_url(loc.get("doi") or ""))
        if aid and not first_arxiv:
            first_arxiv = aid
        if pdf.startswith("http"):
            if aid:
                arx.append(f"https://arxiv.org/pdf/{aid}")
            else:
                others.append(pdf)
    oa_url = (work.get("open_access") or {}).get("oa_url") or ""
    if oa_url.lower().endswith(".pdf") and oa_url not in others:
        others.append(oa_url)
    return arx + others, first_arxiv


_OPENALEX_TYPES = {"article": "article", "preprint": "preprint", "book": "book",
                   "dissertation": "thesis", "book-chapter": "misc"}


def _meta_from_openalex(work, doi_hint=""):
    meta = empty_meta()
    loc = work.get("primary_location") or {}
    src = loc.get("source") or {}
    biblio = work.get("biblio") or {}
    fp, lp = biblio.get("first_page") or "", biblio.get("last_page") or ""
    typ = _CROSSREF_TYPES.get(work.get("type_crossref") or "", "") or _OPENALEX_TYPES.get(work.get("type") or "", "misc")
    if typ == "article" and src.get("type") == "conference":
        typ = "inproceedings"
    if typ == "article" and src.get("type") == "repository":
        typ = "preprint"
    doi = re.sub(r"^https?://doi\.org/", "", work.get("doi") or "", flags=re.I) or doi_hint
    if doi_hint and doi.lower() == doi_hint.lower():
        doi = doi_hint
    meta.update(
        title=_clean_text(work.get("display_name") or work.get("title") or ""),
        authors=[a for a in (_split_name(x.get("raw_author_name") or (x.get("author") or {}).get("display_name"))
                             for x in work.get("authorships") or []) if a],
        date=work.get("publication_date") or work.get("publication_year"),
        venue=_clean_text(src.get("display_name") or ""), volume=str(biblio.get("volume") or ""),
        issue=str(biblio.get("issue") or ""), pages=fp + (f"-{lp}" if lp and lp != fp else ""),
        doi=doi, abstract=_openalex_abstract(work), url=f"https://doi.org/{doi}" if doi else "",
        publisher=_clean_text(src.get("host_organization_name") or ""), type=typ,
    )
    return meta


# =============================================================================
# resolve()
# =============================================================================

class _Ctx:
    def __init__(self, timeout):
        try:
            self.timeout = max(3.0, float(timeout or 20))
        except (TypeError, ValueError):
            self.timeout = 20.0
        self.start = time.monotonic()
        self.budget = max(self.timeout * 3.0, 30.0)
        self.warnings = []

    def remaining(self):
        return self.budget - (time.monotonic() - self.start)

    def t(self):
        return max(2.0, min(self.timeout, self.remaining()))

    def has_time(self, need=3.0):
        return self.remaining() > need

    def warn(self, msg):
        if msg and msg not in self.warnings:
            self.warnings.append(msg)


def _dedupe_urls(urls):
    out = []
    for u in urls:
        if isinstance(u, str) and u.startswith(("http://", "https://")) and u not in out:
            out.append(u)
    return out


def _result(ctx, ok, meta, source, pdf_url=None, more_pdfs=(), error=None, **extra):
    cands = _dedupe_urls([pdf_url] + list(more_pdfs))
    r = {
        "ok": bool(ok),
        "error": None if ok else (error or "Something went wrong."),
        "meta": _finalize_meta(meta),
        "pdf_url": cands[0] if cands else None,
        "pdf_candidates": cands,
        "source": source,
        "warnings": list(ctx.warnings),
    }
    r.update(extra)
    return r


def _fail(ctx, error, meta=None, source="", pdf_url=None, **extra):
    return _result(ctx, False, meta or empty_meta(), source, pdf_url, (), error=error, **extra)


def _resolve_arxiv(ctx, aid):
    base, ver = _split_arxiv_version(aid)
    meta, notfound, errors = None, False, []
    try:
        meta = _arxiv_api_meta(ctx, base, ver)
    except _NetError as e:
        notfound = e.kind == "notfound"
        errors.append(_describe(e, "the arXiv API"))
    if meta is None and ctx.has_time():
        try:
            meta = _arxiv_page_meta(ctx, base, ver)
        except _NetError as e:
            if e.kind == "notfound":
                notfound = True
            else:
                errors.append(_describe(e, "arxiv.org"))
    if meta is None and not notfound and ctx.has_time():
        try:
            meta = _datacite_meta(ctx, _arxiv_doi(base))
            meta.update(venue="arXiv", publisher="arXiv", type="preprint", arxiv=base,
                        arxiv_version=ver, url=f"https://arxiv.org/abs/{base}")
        except _NetError:
            meta = None
    if meta is None:
        if notfound:
            what = f"version {ver} of arXiv:{base}" if ver else f"arXiv:{base}"
            return _fail(ctx, f"arXiv has no paper {what}. Check the id.", source="arxiv")
        return _fail(ctx, "Could not load arXiv:" + aid + " (" + "; ".join(errors[:2]) + ").",
                     source="arxiv")
    if errors:
        ctx.warn("arXiv API was unavailable; details came from a backup source")
    return _result(ctx, True, meta, "arxiv", f"https://arxiv.org/pdf/{base}{ver}")


def _resolve_doi(ctx, doi, extra_candidates=(), late_candidates=()):
    m = re.match(r"^10\.48550/arxiv\.(.+)$", doi, re.I)
    if m and _match_arxiv_exact(m.group(1)):
        return _resolve_arxiv(ctx, _match_arxiv_exact(m.group(1)))
    meta, source, msg = None, "", None
    cr_notfound, cr_error = False, None
    try:
        msg = _crossref_message(ctx, doi)
        meta, source = _meta_from_crossref(msg, doi), "crossref"
    except _NetError as e:
        if e.kind == "notfound":
            cr_notfound = True
        else:
            cr_error = e
    if meta is None and cr_notfound and ctx.has_time():
        try:
            meta, source = _datacite_meta(ctx, doi), "datacite"
        except _NetError:
            pass
    work = None
    if ctx.has_time():
        try:
            work = _openalex_work(ctx, doi)
        except _NetError as e:
            if e.kind != "notfound" and meta is not None:
                ctx.warn("Could not check OpenAlex for open-access PDFs (" + _describe(e, "OpenAlex") + ")")
    if meta is not None and work is not None and not meta.get("title"):
        meta["title"] = _clean_text(work.get("display_name") or work.get("title") or "")
    if meta is None and work is not None:
        meta, source = _meta_from_openalex(work, doi), "openalex"
        if cr_error is not None:
            ctx.warn("Crossref was unavailable (" + _describe(cr_error, "Crossref") + "); details came from OpenAlex")
    if meta is None:
        if cr_error is None:
            return _fail(ctx, f"DOI {doi} was not found. Check it for typos.", source="crossref")
        return _fail(ctx, f"Could not look up DOI {doi}: " + _describe(cr_error, "Crossref") + ".",
                     source="crossref")
    cands = list(extra_candidates)
    # OpenAlex's abstract is a word index with every formula dropped ("We present Hamiltonians");
    # the arXiv summary keeps the math, so it comes first and OpenAlex is the last resort
    oa_abstract = source == "openalex" and bool(meta.get("abstract"))
    if work is not None:
        oa_cands, oa_arxiv = _openalex_pdf_info(work)
        if oa_arxiv and not meta.get("arxiv"):
            meta["arxiv"] = oa_arxiv
        cands += oa_cands
    _arxiv_abstract(ctx, meta, replace=oa_abstract)
    if not meta.get("abstract") and work is not None:
        meta["abstract"] = _openalex_abstract(work)
        oa_abstract = bool(meta["abstract"])
    if meta.get("arxiv"):
        cands.append(f"https://arxiv.org/pdf/{meta['arxiv']}")
    if msg is not None:
        cands += _crossref_oa_links(msg)
        rel = msg.get("relation") or {}
        for item in rel.get("is-preprint-of") or []:
            if item.get("id-type") == "doi" and item.get("id"):
                ctx.warn(f"This preprint has a published version: DOI {item['id']}")
                break
    cands += list(late_candidates)
    if not cands and not meta.get("arxiv") and meta.get("type") != "preprint" and ctx.has_time(8):
        aid = _arxiv_by_title(ctx, meta.get("title", ""), meta.get("authors") or [])
        if aid:
            meta["arxiv"] = aid
            cands.append(f"https://arxiv.org/pdf/{aid}")
            _arxiv_abstract(ctx, meta, replace=oa_abstract)
    # the journal's own PDF first (open access, or the published version), the arXiv preprint after
    arx = [c for c in cands if "arxiv.org/pdf/" in c]
    ordered = _dedupe_urls([c for c in cands if c not in arx] + arx)
    if not ordered:
        ctx.warn(NO_OA_PDF_WARNING)
    elif "arxiv.org/pdf/" in ordered[0] and meta.get("type") != "preprint":
        ctx.warn("The PDF is the arXiv preprint; the published version may differ")
    return _result(ctx, True, meta, source, None, ordered)


def _arxiv_abstract(ctx, meta, replace=False):
    """Fill meta's abstract from the arXiv summary (math kept as TeX), or replace an OpenAlex one."""
    if (meta.get("abstract") and not replace) or not meta.get("arxiv") or not ctx.has_time():
        return False
    try:
        base, ver = _split_arxiv_version(meta["arxiv"])
        ab = _arxiv_api_meta(ctx, base, ver).get("abstract") or ""
    except _NetError:
        return False
    if ab:
        meta["abstract"] = ab
    return bool(ab)


def _arxiv_by_title(ctx, title, authors):
    """Find the arXiv preprint of a published paper: exact title + first author."""
    nt = _norm_title(title)
    if len(nt.split()) < 3:
        return ""
    phrase = _ws(re.sub(r"[\"():]", " ", _clean_text(title)))
    url = "https://export.arxiv.org/api/query?" + urllib.parse.urlencode(
        {"search_query": f'ti:"{phrase}"', "max_results": "5"})
    try:
        resp = _fetch(url, timeout=min(ctx.t(), 12.0), accept="application/atom+xml", cache=True, retries=0)
        root = ET.fromstring(resp.body)
    except (_NetError, ET.ParseError):
        return ""
    fam = _norm_title(_family_of(authors[0])) if authors else ""
    for e in root.findall("a:entry", _ATOM):
        try:
            m = _arxiv_entry_meta(e)
        except _NetError:
            continue
        if _squash(m["title"]) != _squash(title):   # "Bi 2 Se 3" (journal markup) == "Bi2Se3" (arXiv)
            continue
        if fam and not any(_norm_title(a["family"]) == fam for a in m["authors"]):
            continue
        return m["arxiv"]
    return ""


def _squash(t):
    return re.sub(r"[^a-z0-9]", "", _norm_title(t))


def _title_words(t):
    return {w for w in _norm_title(t).split() if len(w) > 1 and w not in _STOPWORDS}


def _arxiv_close_title(ctx, title, authors, year=None):
    """Like _arxiv_by_title, for titles reworded between preprint and journal: first author plus the title's
    longest words, accepted when most title words agree and the dates fit (preprint up to 5 years before)."""
    words = _title_words(title)
    fam = _fold(_family_of(authors[0])) if authors else ""
    fam_n = _norm_title(fam)
    if len(words) < 3 or not fam_n:
        return ""
    best, best_sim = "", 0.0
    for n in (4, 2):
        key = sorted(words, key=len, reverse=True)[:n]
        q = "au:" + fam_n.split()[-1] + "".join(f" AND ti:{w}" for w in key)
        url = "https://export.arxiv.org/api/query?" + urllib.parse.urlencode({"search_query": q, "max_results": "10"})
        if not ctx.has_time(4):
            break
        try:
            resp = _fetch(url, timeout=min(ctx.t(), 12.0), accept="application/atom+xml", cache=True, retries=0)
            root = ET.fromstring(resp.body)
        except (_NetError, ET.ParseError):
            continue
        for e in root.findall("a:entry", _ATOM):
            try:
                m = _arxiv_entry_meta(e)
            except _NetError:
                continue
            if not any(_norm_title(_fold(a.get("family") or "")) == fam_n for a in m["authors"]):
                continue
            if year and m.get("year") and not (int(year) - 5 <= int(m["year"]) <= int(year) + 1):
                continue
            other = _title_words(m["title"])
            sim = max(len(words & other) / max(1, len(words | other)),
                      difflib.SequenceMatcher(None, _squash(title), _squash(m["title"])).ratio() - 0.25)
            if sim > best_sim:
                best, best_sim = m["arxiv"], sim
        if best_sim >= 0.6:
            return best
    return ""


def find_preprint(meta, timeout=15):
    """arXiv id of the preprint of a published paper (exact title + first author, then a close title), or "".
    Used when the journal's PDF can't be downloaded. Never raises."""
    try:
        meta = meta or {}
        title, authors = meta.get("title") or "", meta.get("authors") or []
        if not title:
            return ""
        ctx = _Ctx(timeout)
        return _arxiv_by_title(ctx, title, authors) or _arxiv_close_title(ctx, title, authors, meta.get("year"))
    except Exception:
        return ""


def _resolve_openreview(ctx, oid):
    forum = f"https://openreview.net/forum?id={oid}"
    pdf = f"https://openreview.net/pdf?id={oid}"
    blocked, meta = False, None
    for api in ("https://api2.openreview.net/notes?id=", "https://api.openreview.net/notes?id="):
        try:
            data = _get_json(api + urllib.parse.quote(oid), ctx, retries=0)
        except _NetError as e:
            blocked = blocked or e.kind in ("blocked", "ratelimited")
            continue
        notes = (data or {}).get("notes") or []
        if notes:
            meta = _meta_from_openreview(notes[0], forum)
            break
    if (meta is None or not meta["title"]) and ctx.has_time():
        try:
            resp = _fetch(forum, timeout=ctx.t(), browser=True, accept=HTML_ACCEPT, max_bytes=3 * MB)
            if _looks_blocked(resp) and b"citation_title" not in resp.body:
                blocked = True
            else:
                meta, info = _meta_from_page(_parse_html(_decode_html(resp)), forum)
                pdf = info["pdf"] or pdf
        except _NetError as e:
            blocked = blocked or e.kind in ("blocked", "ratelimited")
    if meta is not None and meta["title"]:
        meta["url"] = forum
        if not meta["venue"]:
            meta["venue"] = "OpenReview"
        return _result(ctx, True, meta, "page", pdf)
    meta = empty_meta()
    meta.update(url=forum, venue="OpenReview")
    if blocked:
        err = ("OpenReview is showing a browser verification check, so this paper could not be "
               "loaded automatically. Open the forum page in your browser, download the PDF and "
               "attach it (or paste the paper's arXiv id if it has one).")
    else:
        err = "Could not load this OpenReview paper; check the link or try again later."
    return _fail(ctx, err, meta=meta, source="page", pdf_url=pdf)


def _meta_from_openreview(note, forum):
    c = note.get("content") or {}

    def val(k):
        v = c.get(k)
        return v.get("value") if isinstance(v, dict) else v

    meta = empty_meta()
    ms = note.get("pdate") or note.get("cdate") or note.get("tcdate")
    date = time.strftime("%Y-%m-%d", time.gmtime(ms / 1000)) if isinstance(ms, (int, float)) else None
    venue = val("venue") or ""
    meta.update(title=_clean_text(val("title") or ""),
                authors=[a for a in (_split_name(x) for x in (val("authors") or [])) if a],
                abstract=_clean_abstract(val("abstract") or ""), venue=venue or "OpenReview",
                date=date, url=forum,
                type="inproceedings" if re.search(r"conference|iclr|neurips|icml|workshop", venue, re.I) else "preprint")
    return meta


def _resolve_acl(ctx, aid):
    land = f"https://aclanthology.org/{aid}/"
    pdf = f"https://aclanthology.org/{aid}.pdf"
    err = None
    try:
        resp = _fetch(land, timeout=ctx.t(), browser=True, accept=HTML_ACCEPT, max_bytes=3 * MB)
        text = _decode_html(resp)
        meta, info = _meta_from_page(_parse_html(text), land)
        if meta["title"]:
            meta["url"] = land
            m = re.search(r"acl-abstract[\"']?>.*?<span[^>]*>(.*?)</span>", text, re.S)
            if m:
                meta["abstract"] = _clean_abstract(m.group(1))
            if meta["type"] == "misc":
                meta["type"] = "inproceedings"
            return _result(ctx, True, meta, "page", info["pdf"] or pdf)
    except _NetError as e:
        err = e
    if ctx.has_time():
        r = _resolve_doi(ctx, f"10.18653/v1/{aid}", extra_candidates=[pdf])
        if r["ok"]:
            return r
    why = _describe(err, "aclanthology.org") if err else "no details on the page"
    return _fail(ctx, f"Could not load ACL Anthology paper {aid} ({why}).", source="page", pdf_url=pdf)


def _resolve_europepmc(ctx, query, canonical):
    url = "https://www.ebi.ac.uk/europepmc/webservices/rest/search?" + urllib.parse.urlencode(
        {"query": query, "format": "json", "resultType": "core", "pageSize": "1"})
    try:
        data = _get_json(url, ctx)
    except _NetError as e:
        return _fail(ctx, "Could not look this up in Europe PMC (" + _describe(e, "Europe PMC") + ").",
                     source="europepmc")
    results = ((data or {}).get("resultList") or {}).get("result") or []
    if not results:
        return _fail(ctx, "Europe PMC has no record of this article.", source="europepmc")
    r0 = results[0]
    epmc = []
    for u in ((r0.get("fullTextUrlList") or {}).get("fullTextUrl") or []):
        if u.get("documentStyle") == "pdf" and u.get("availabilityCode") in ("OA", "F") and u.get("url"):
            epmc.append(u["url"])
    if r0.get("doi"):
        res = _resolve_doi(ctx, r0["doi"], late_candidates=epmc)
        if res["ok"]:
            return res
    meta = empty_meta()
    j = r0.get("journalInfo") or {}
    authors = []
    for a in ((r0.get("authorList") or {}).get("author") or []):
        if a.get("lastName"):
            authors.append({"given": a.get("firstName") or a.get("initials") or "", "family": a["lastName"]})
        elif a.get("collectiveName"):
            authors.append({"given": "", "family": a["collectiveName"]})
    meta.update(title=_clean_text(r0.get("title") or "").rstrip("."), authors=authors,
                date=r0.get("firstPublicationDate") or r0.get("pubYear"),
                venue=((j.get("journal") or {}).get("title") or ""), volume=j.get("volume") or "",
                issue=j.get("issue") or "", pages=r0.get("pageInfo") or "", doi=r0.get("doi") or "",
                abstract=_clean_abstract(r0.get("abstractText") or ""), url=canonical, type="article")
    if not epmc:
        ctx.warn(NO_OA_PDF_WARNING)
    return _result(ctx, True, meta, "europepmc", None, epmc)


def _resolve_inspire(ctx, rid):
    try:
        data = _get_json(f"https://inspirehep.net/api/literature/{rid}", ctx)
    except _NetError as e:
        return _fail(ctx, "Could not load the INSPIRE record (" + _describe(e, "INSPIRE") + ").",
                     source="inspire")
    m = (data or {}).get("metadata") or {}
    if not m.get("titles"):
        return _fail(ctx, "INSPIRE returned an empty record.", source="inspire")
    pubs = m.get("publication_info") or []
    pub = next((p for p in pubs if p.get("material") == "publication" and p.get("journal_title")), None) \
        or next((p for p in pubs if p.get("journal_title") and p.get("material") not in ("erratum", "reprint")), None) \
        or next((p for p in pubs if p.get("journal_title")), None) or {}
    dois = m.get("dois") or []
    doi = next((d["value"] for d in dois if d.get("material") == "publication"), "") or (dois[0]["value"] if dois else "")
    eprints = m.get("arxiv_eprints") or []
    arxiv = eprints[0].get("value", "") if eprints else ""
    doc = " ".join(m.get("document_type") or [])
    if pub.get("journal_title"):
        typ = "article"
    elif "conference" in doc:
        typ = "inproceedings"
    elif "thesis" in doc:
        typ = "thesis"
    elif "book" in doc:
        typ = "book"
    elif arxiv:
        typ = "preprint"
    else:
        typ = "misc"
    pages = pub.get("page_start") or pub.get("artid") or ""
    if pub.get("page_start") and pub.get("page_end"):
        pages = f"{pub['page_start']}-{pub['page_end']}"
    date = str(pub.get("year")) if pub.get("year") else (m.get("preprint_date") or m.get("earliest_date"))
    abstracts = m.get("abstracts") or []
    meta = empty_meta()
    meta.update(
        title=_ws(m["titles"][0].get("title", "")),
        authors=[a for a in (_split_name(x.get("full_name")) for x in (m.get("authors") or [])) if a],
        date=date, venue=pub.get("journal_title") or ("arXiv" if typ == "preprint" else ""),
        volume=pub.get("journal_volume") or "", issue=pub.get("journal_issue") or "", pages=pages,
        doi=doi or (_arxiv_doi(arxiv) if arxiv else ""), arxiv=arxiv,
        abstract=_clean_abstract(abstracts[0].get("value", "")) if abstracts else "",
        url=f"https://inspirehep.net/literature/{rid}", type=typ,
        categories=list(eprints[0].get("categories") or []) if eprints else [],
    )
    cands = [f"https://arxiv.org/pdf/{arxiv}"] if arxiv else []
    if not cands and doi and ctx.has_time():
        try:
            cands, _ = _openalex_pdf_info(_openalex_work(ctx, doi))
        except _NetError:
            pass
    if not cands:
        ctx.warn(NO_OA_PDF_WARNING)
    return _result(ctx, True, meta, "inspire", None, cands)


def _resolve_elsevier(ctx, pii, url):
    q = "https://api.crossref.org/works?" + urllib.parse.urlencode(
        {"filter": f"alternative-id:{pii}", "rows": "2", "select": "DOI,title"})
    try:
        items = ((_get_json(q, ctx, retries=2) or {}).get("message") or {}).get("items") or []
    except _NetError as e:
        return _fail(ctx, "Could not look up this ScienceDirect article (" + _describe(e, "Crossref")
                     + "). Paste its DOI instead.", source="crossref")
    if items and items[0].get("DOI"):
        return _resolve_doi(ctx, items[0]["DOI"])
    return _fail(ctx, _blocked_message(url), source="page")


def _resolve_s2(ctx, pid, url):
    api = (f"https://api.semanticscholar.org/graph/v1/paper/{pid}?fields=externalIds,title,authors,"
           "year,venue,abstract,openAccessPdf,publicationDate,journal,publicationTypes")
    try:
        d = _get_json(api, ctx, retries=1)
    except _NetError as e:
        return _fail(ctx, "Could not load this Semantic Scholar paper (" + _describe(e, "Semantic Scholar")
                     + "). Paste its DOI or arXiv id instead.", source="page")
    ext = d.get("externalIds") or {}
    oa = ((d.get("openAccessPdf") or {}).get("url") or "")
    late = [oa] if oa.startswith("http") else []
    if ext.get("DOI") and not str(ext["DOI"]).lower().startswith("10.48550/"):
        r = _resolve_doi(ctx, ext["DOI"], late_candidates=late)
        if r["ok"]:
            return r
    if ext.get("ArXiv"):
        r = _resolve_arxiv(ctx, str(ext["ArXiv"]))
        if r["ok"]:
            return r
    if not d.get("title"):
        return _fail(ctx, "Semantic Scholar returned no details for this paper.", source="page")
    j = d.get("journal") or {}
    types = d.get("publicationTypes") or []
    meta = empty_meta()
    meta.update(title=_clean_text(d["title"]),
                authors=[a for a in (_split_name(x.get("name")) for x in d.get("authors") or []) if a],
                date=d.get("publicationDate") or d.get("year"), venue=j.get("name") or d.get("venue") or "",
                volume=str(j.get("volume") or ""), pages=_ws(j.get("pages") or ""),
                abstract=_clean_abstract(d.get("abstract") or ""), url=url,
                type="article" if "JournalArticle" in types else "inproceedings" if "Conference" in types else "misc")
    if not late:
        ctx.warn(NO_OA_PDF_WARNING)
    return _result(ctx, True, meta, "page", None, late)


def _doi_meta_any(ctx, doi):
    """Metadata for a DOI from Crossref, falling back to DataCite."""
    try:
        return _meta_from_crossref(_crossref_message(ctx, doi), doi)
    except _NetError as e:
        if e.kind != "notfound" or not ctx.has_time():
            raise
    return _datacite_meta(ctx, doi)


def _title_from_filename(url):
    try:
        name = urllib.parse.unquote(urllib.parse.urlsplit(url).path.rstrip("/").rsplit("/", 1)[-1])
    except ValueError:
        name = ""
    name = re.sub(r"\.pdf$", "", name, flags=re.I)
    t = re.sub(r"[_+]+", " ", name)
    if t.count("-") >= 2 and re.search(r"[A-Za-z]{3}", t):
        t = t.replace("-", " ")
    t = _ws(t)
    if t and t == t.lower() and " " in t:
        t = t[0].upper() + t[1:]
    return t or "Untitled PDF"


def _pdf_result(ctx, url, head):
    ids = pdf_identifiers(head)
    if ids["arxiv"] and ctx.has_time():
        r = _resolve_arxiv(ctx, ids["arxiv"])
        if r["ok"]:
            r["pdf_candidates"] = _dedupe_urls([url] + r["pdf_candidates"])
            r["pdf_url"] = url
            r["warnings"].append(f"Identified from the PDF: arXiv {ids['arxiv']}")
            return r
    if ids["doi"] and ctx.has_time():
        r = _resolve_doi(ctx, ids["doi"])
        if r["ok"]:
            r["pdf_candidates"] = _dedupe_urls([url] + r["pdf_candidates"])
            r["pdf_url"] = url
            r["warnings"] = [w for w in r["warnings"] if w != NO_OA_PDF_WARNING]
            r["warnings"].append(f"Identified from the PDF: DOI {ids['doi']}")
            return r
    meta = empty_meta()
    meta.update(title=ids["title"] or _title_from_filename(url), url=url, type="misc")
    ctx.warn("Only the PDF was found; fill in the title, authors and year")
    return _result(ctx, True, meta, "pdf", url)


def _resolve_pdf(ctx, url):
    try:
        resp = _fetch(url, timeout=ctx.t(), browser=True, accept="application/pdf,*/*;q=0.8",
                      max_bytes=768 * 1024, extra_headers={"Range": "bytes=0-786431"})
    except _NetError as e:
        if e.kind == "notfound":
            return _fail(ctx, f"That PDF link is broken (HTTP {e.status}).", source="pdf")
        if e.kind == "blocked":
            return _fail(ctx, f"{_host(url)} refused to send the PDF (HTTP {e.status}). Download it in "
                         "your browser and attach it.", source="pdf")
        if e.kind == "badurl":
            return _fail(ctx, str(e), source="pdf")
        ctx.warn("Could not check the PDF link (" + _describe(e, _host(url)) + ")")
        meta = empty_meta()
        meta.update(title=_title_from_filename(url), url=url)
        return _result(ctx, True, meta, "pdf", url)
    if _is_pdf_bytes(resp.body):
        data = resp.body
        ids = pdf_identifiers(data)
        m = re.match(r"bytes\s+\d+-\d+/(\d+)", resp.headers.get("Content-Range") or "")
        total = int(m.group(1)) if m else 0
        if not (ids["arxiv"] or ids["doi"]) and resp.status == 206 and total > len(data) and ctx.has_time(6):
            # Identifiers often sit at the end (arXiv's stamp, XMP/Info updates).
            # Explicit ranges only: some CDNs reject suffix ranges ("bytes=-N").
            start = max(len(data), total - 512 * 1024)
            try:
                tail = _fetch(resp.url, timeout=ctx.t(), browser=True, accept="application/pdf,*/*;q=0.8",
                              max_bytes=512 * 1024 + 1024,
                              extra_headers={"Range": f"bytes={start}-{total - 1}"})
                if tail.status == 206:
                    data = data + b"\n" + tail.body
            except _NetError:
                pass
        return _pdf_result(ctx, resp.url, data)
    r = _resolve_page(ctx, url, resp=resp)
    if r["ok"]:
        r["warnings"].insert(0, "The link opened a web page, not a PDF")
        return r
    return _fail(ctx, "The link did not return a PDF (the server sent a web page, often a login or "
                 "paywall page). Download it in your browser and attach it.", source="pdf")


def _route_parsed(ctx, p):
    kind, site = p["kind"], p["site"]
    if kind == "arxiv":
        return _resolve_arxiv(ctx, p["arxiv"])
    if kind == "doi":
        return _resolve_doi(ctx, p["doi"])
    if kind == "pdf_url":
        return _resolve_pdf(ctx, p["url"])
    if kind == "url":
        if site == "openreview" and p["id"]:
            return _resolve_openreview(ctx, p["id"])
        if site == "acl" and p["id"]:
            return _resolve_acl(ctx, p["id"])
        if site == "pmc" and p["id"]:
            return _resolve_europepmc(ctx, f"PMCID:{p['id']}", p["url"])
        if site == "pubmed" and p["id"]:
            return _resolve_europepmc(ctx, f"EXT_ID:{p['id']} AND SRC:MED", p["url"])
        if site == "inspire" and p["id"]:
            return _resolve_inspire(ctx, p["id"])
        if site == "elsevier" and p["id"]:
            return _resolve_elsevier(ctx, p["id"], p["url"])
        if site == "s2" and p["id"]:
            return _resolve_s2(ctx, p["id"], p["url"])
        if site == "ads" and p["id"]:
            return _fail(ctx, "NASA ADS pages can't be read without an ADS API token. Paste the DOI or "
                         "arXiv id shown on the ADS page instead.", source="page")
        return _resolve_page(ctx, p["url"])
    return None


def _resolve_page(ctx, url, resp=None):
    if resp is None:
        try:
            resp = _fetch(url, timeout=ctx.t(), browser=True, accept=HTML_ACCEPT, max_bytes=4 * MB)
        except _NetError as e:
            final = e.url or url
            if final != url:
                p2 = parse_input(final)
                if p2["kind"] in ("arxiv", "doi") or p2["site"] in ("elsevier", "pmc", "inspire"):
                    return _route_parsed(ctx, p2)
            if e.kind in ("blocked", "ratelimited") or (e.kind == "http" and e.status in (202, 503)):
                return _fail(ctx, _blocked_message(url), source="page")
            if e.kind == "notfound":
                return _fail(ctx, f"That page does not exist (HTTP {e.status}). Check the link.", source="page")
            return _fail(ctx, "Could not open the link: " + _describe(e, _host(url) or "the site") + ".",
                         source="page")
    final = resp.url or url
    if final != url:
        p2 = parse_input(final)
        if p2["kind"] in ("arxiv", "doi") or p2["site"] in ("elsevier", "pmc", "inspire", "acl", "openreview"):
            return _route_parsed(ctx, p2)
    if _is_pdf_bytes(resp.body):
        return _pdf_result(ctx, final, resp.body)
    pm = _parse_html(_decode_html(resp))
    meta, info = _meta_from_page(pm, final)
    if not info["scholarly"] and _looks_blocked(resp):
        return _fail(ctx, _blocked_message(final), source="page")
    if info["arxiv"] and (not meta["title"] or meta["type"] in ("preprint", "misc")):
        r = _resolve_arxiv(ctx, info["arxiv"])
        if r["ok"]:
            return r
    if info["doi"] and not meta["title"]:
        return _resolve_doi(ctx, info["doi"], extra_candidates=[info["pdf"]] if info["pdf"] else ())
    if info["doi"] and ctx.has_time() and (not meta["authors"] or not meta["year"] or not meta["venue"]):
        try:
            cr = _doi_meta_any(ctx, info["doi"])
            for k in ("authors", "date", "year", "venue", "volume", "issue", "pages", "publisher", "abstract"):
                if not meta.get(k) and cr.get(k):
                    meta[k] = cr[k]
            if meta["type"] == "misc":
                meta["type"] = cr["type"]
        except _NetError:
            pass
    if not meta["title"]:
        return _fail(ctx, "No paper details were found on that page. Paste the DOI or arXiv id instead.",
                     source="page")
    cands = [info["pdf"]] if info["pdf"] else []
    if not cands and info["doi"] and ctx.has_time():
        try:
            cands, aid = _openalex_pdf_info(_openalex_work(ctx, info["doi"]))
            if aid and not meta["arxiv"]:
                meta["arxiv"] = aid
        except _NetError:
            pass
    if not info["scholarly"]:
        ctx.warn("This page has no citation metadata; it was saved as a web page - check the details")
    elif not cands:
        ctx.warn(NO_OA_PDF_WARNING)
    return _result(ctx, True, meta, "page", None, cands)


def _resolve(text, timeout):
    ctx = _Ctx(timeout)
    p = parse_input(text)
    r = _route_parsed(ctx, p)
    if r is not None:
        return r
    q = _ws(_clean_input(text))
    if len(q.split()) >= 3 and len(q) <= 400 and re.search(r"[A-Za-z]{3}", q):
        found = _search(ctx, q, 6)
        nq = _norm_title(q)
        exact = [c for c in found if _norm_title(c["title"]) == nq]
        if exact:
            r = _route_parsed(ctx, parse_input(exact[0]["input"]))
            if r is not None and r["ok"]:
                r["warnings"].insert(0, "Matched by title - check this is the right paper")
                return r
        return _fail(ctx, "No arXiv id, DOI or link found. Pick one of the title matches, or paste "
                     "an identifier.", candidates=found)
    return _fail(ctx, "Paste an arXiv id (e.g. 2401.12345), a DOI (10.xxxx/...), or a link to the paper.")


def resolve(text, timeout=20):
    """Look a paper up online.  Never raises.

    Returns {"ok", "error", "meta", "pdf_url", "pdf_candidates", "source",
    "warnings"} (plus "candidates" for an unmatched title search).
    """
    try:
        return _resolve(text, timeout)
    except Exception as e:  # last line of defence: callers must never see a traceback
        ctx = _Ctx(timeout)
        return _fail(ctx, f"Unexpected error while importing: {type(e).__name__}: {e}")


# =============================================================================
# search()
# =============================================================================

def _candidate(meta, ident, source):
    m = _finalize_meta(meta)
    return {"input": ident, "title": m["title"], "authors": format_authors_short(m["authors"]),
            "year": m["year"], "venue": m["venue"], "type": m["type"], "doi": m["doi"],
            "arxiv": m["arxiv"], "source": source}


def _search(ctx, query, limit):
    q = _ws(query)[:300]
    if not q:
        return []
    out = []
    phrase = _ws(re.sub(r"[\"():]", " ", q))
    words = [w for w in re.findall(r"[A-Za-z0-9]{3,}", _fold(phrase)) if w.lower() not in _STOPWORDS][:8]
    queries = [f'ti:"{phrase}"']
    if len(words) >= 2:
        queries.append(" AND ".join(f"all:{w}" for w in words))
    seen_ids = set()
    for sq in queries:
        if len(out) >= 3 or not ctx.has_time(6):
            break
        try:
            url = "https://export.arxiv.org/api/query?" + urllib.parse.urlencode(
                {"search_query": sq, "max_results": str(min(limit, 10))})
            resp = _fetch(url, timeout=ctx.t(), accept="application/atom+xml", cache=True, retries=1)
            for e in ET.fromstring(resp.body).findall("a:entry", _ATOM):
                try:
                    m = _arxiv_entry_meta(e)
                except _NetError:
                    continue
                if m["arxiv"] and m["arxiv"] not in seen_ids:
                    seen_ids.add(m["arxiv"])
                    out.append(_candidate(m, f"arXiv:{m['arxiv']}", "arxiv"))
        except (_NetError, ET.ParseError) as e:
            ctx.warn("arXiv search unavailable (" + _describe(e, "arXiv") + ")")
            break
    if ctx.has_time():
        try:
            url = "https://api.crossref.org/works?" + urllib.parse.urlencode({
                "query.bibliographic": q, "rows": str(min(2 * limit, 20)),
                "select": "DOI,title,subtitle,author,issued,container-title,type,publisher,posted"})
            for it in ((_get_json(url, ctx, retries=2) or {}).get("message") or {}).get("items") or []:
                if it.get("type") in ("peer-review", "component", "grant", "other", "journal-issue"):
                    continue
                if it.get("DOI") and it.get("title"):
                    out.append(_candidate(_meta_from_crossref(it, it["DOI"]), it["DOI"], "crossref"))
        except _NetError as e:
            ctx.warn("Crossref search unavailable (" + _describe(e, "Crossref") + ")")
    nq = set(_norm_title(q).split())

    def score(c):
        t = _norm_title(c["title"])
        words = set(t.split())
        overlap = len(words & nq) / max(1, len(words | nq))
        return (t == " ".join(_norm_title(q).split()), overlap)

    out.sort(key=score, reverse=True)
    seen, ranked = set(), []
    for c in out:
        k = _norm_title(c["title"])
        if k and k not in seen:
            seen.add(k)
            ranked.append(c)
    return ranked[:limit]


def search(query, limit=8, timeout=20):
    """Title/keyword search over arXiv and Crossref.  Never raises.

    Returns {"ok", "error", "results": [{"input", "title", "authors", "year",
    "venue", "type", "doi", "arxiv", "source"}], "warnings"}.  Pass a
    result's "input" to resolve() to import it.
    """
    ctx = _Ctx(timeout)
    try:
        res = _search(ctx, query, max(1, int(limit or 8)))
        return {"ok": True, "error": None, "results": res, "warnings": ctx.warnings}
    except Exception as e:
        return {"ok": False, "error": f"Search failed: {type(e).__name__}: {e}", "results": [],
                "warnings": ctx.warnings}


# =============================================================================
# download_pdf()
# =============================================================================

def download_pdf(url, dest_path, timeout=60, max_bytes=300 * 1024 * 1024):
    """Stream a PDF to dest_path (atomically).  Never raises.

    Returns {"ok", "error", "bytes", "sha256", "final_url", "content_type"}.
    Rejects anything that does not start with %PDF (login pages, paywalls,
    bot checks) and anything larger than max_bytes.
    """
    res = {"ok": False, "error": None, "bytes": 0, "sha256": "", "final_url": "", "content_type": ""}
    tmp = None
    try:
        url = _ws(url)
        try:
            parts = urllib.parse.urlsplit(url)
        except ValueError:
            parts = None
        if not parts or parts.scheme.lower() not in ("http", "https") or not parts.hostname:
            res["error"] = "Not a web link to a PDF."
            return res
        host = parts.hostname.lower()
        if host.endswith("arxiv.org") and parts.scheme.lower() == "http":
            url = "https" + url[4:]
        if host.endswith("arxiv.org"):
            url = re.sub(r"(arxiv\.org)/abs/", r"\1/pdf/", url)
        dest_path = os.path.abspath(os.path.expanduser(str(dest_path)))
        dest_dir = os.path.dirname(dest_path) or "."
        os.makedirs(dest_dir, exist_ok=True)
        try:
            timeout = max(5.0, float(timeout or 60))
        except (TypeError, ValueError):
            timeout = 60.0
        deadline = time.monotonic() + max(timeout * 10, 120)
        req = urllib.request.Request(url, headers={
            "User-Agent": BROWSER_USER_AGENT, "Accept": "application/pdf,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9"})
        try:
            r = _opener().open(req, timeout=timeout)
        except urllib.error.HTTPError as e:
            res["final_url"] = getattr(e, "filename", None) or url
            if e.code in (404, 410):
                res["error"] = f"The PDF link is broken (HTTP {e.code})."
            elif e.code in (401, 403):
                res["error"] = (f"{_host(res['final_url'])} refused the download (HTTP {e.code}). "
                                "Download the PDF in your browser and attach it.")
            elif e.code == 429:
                res["error"] = "The server is rate-limiting downloads; try again in a minute."
            else:
                res["error"] = f"Download failed (HTTP {e.code})."
            return res
        with r:
            res["final_url"] = r.geturl()
            res["content_type"] = r.headers.get_content_type() or ""
            encoding = (r.headers.get("Content-Encoding") or "").lower().strip()
            if encoding in ("gzip", "x-gzip"):
                inflater = zlib.decompressobj(16 + zlib.MAX_WBITS)
            elif encoding == "deflate":
                inflater = zlib.decompressobj()
            elif encoding in ("", "identity"):
                inflater = None
            else:
                res["error"] = f"The server sent the file in an unsupported encoding ({encoding})."
                return res
            try:
                clen = int(r.headers.get("Content-Length") or -1)
            except ValueError:
                clen = -1
            if inflater is None and clen > max_bytes:
                res["error"] = f"The PDF is larger than the {_human_size(max_bytes)} limit."
                return res
            fd, tmp = tempfile.mkstemp(prefix=".pm-download-", suffix=".part", dir=dest_dir)
            h = hashlib.sha256()
            total = 0
            head = b""
            checked = False
            with os.fdopen(fd, "wb") as f:
                while True:
                    if time.monotonic() > deadline:
                        raise _NetError("timeout", "download took too long")
                    raw = r.read(256 * 1024)
                    if not raw:
                        chunk = inflater.flush() if inflater is not None else b""
                        if not chunk:
                            break
                        raw_done = True
                    else:
                        chunk = inflater.decompress(raw) if inflater is not None else raw
                        raw_done = False
                    if not checked:
                        head += chunk[: 1024 - len(head)]
                        if len(head) >= 1024:
                            checked = True
                            if not _is_pdf_bytes(head):
                                res["error"] = _not_pdf_message(head, res["final_url"])
                                return res
                    total += len(chunk)
                    if total > max_bytes:
                        res["error"] = f"The PDF is larger than the {_human_size(max_bytes)} limit."
                        return res
                    h.update(chunk)
                    f.write(chunk)
                    if raw_done:
                        break
            if total == 0:
                res["error"] = "The server sent an empty file."
                return res
            if not _is_pdf_bytes(head):
                res["error"] = _not_pdf_message(head, res["final_url"])
                return res
            if inflater is None and clen >= 0 and total != clen:
                res["error"] = f"Download incomplete ({total} of {clen} bytes); try again."
                return res
        try:
            os.chmod(tmp, 0o644)
        except OSError:
            pass
        os.replace(tmp, dest_path)
        tmp = None
        res.update(ok=True, bytes=total, sha256=h.hexdigest())
        return res
    except _NetError as e:
        res["error"] = "Download failed: " + _describe(e, _host(url) or "the server") + "."
        return res
    except urllib.error.URLError as e:
        res["error"] = "Download failed: " + _describe(_classify_urlerror(e, url), _host(url) or "the server") + "."
        return res
    except (socket.timeout, TimeoutError):
        res["error"] = "Download failed: the server stopped responding."
        return res
    except (http.client.HTTPException, ConnectionError, ssl.SSLError, zlib.error) as e:
        res["error"] = f"Download interrupted ({type(e).__name__}); try again."
        return res
    except OSError as e:
        res["error"] = f"Could not save the PDF: {e}"
        return res
    except Exception as e:
        res["error"] = f"Download failed: {type(e).__name__}: {e}"
        return res
    finally:
        if tmp and os.path.exists(tmp):
            try:
                os.remove(tmp)
            except OSError:
                pass


def _human_size(n):
    return f"{n / MB:.0f} MB" if n >= MB else f"{max(1, n // 1024)} KB"


def _not_pdf_message(head, final_url):
    host = _host(final_url) or "The server"
    if _is_html_bytes(head):
        return (f"{host} sent a web page instead of a PDF (usually a login, paywall or "
                "bot-check page). Open the link in your browser and attach the PDF yourself.")
    return f"{host} did not send a PDF file."


# =============================================================================
# PDF sniffing
# =============================================================================

_PDF_LIT = rb"\((?:\\.|[^\\()]|\((?:\\.|[^\\()])*\))*\)"
_PDF_LIT_RE = re.compile(_PDF_LIT, re.S)
_PDF_SHOW_RE = re.compile(rb"\[((?:" + _PDF_LIT + rb"|[^\]()])*)\]\s*TJ|(" + _PDF_LIT + rb")\s*(?:Tj|'|\")", re.S)


def _pdf_unescape(b):
    out = bytearray()
    i, n = 0, len(b)
    esc = {ord("n"): 10, ord("r"): 13, ord("t"): 9, ord("b"): 8, ord("f"): 12,
           ord("("): 40, ord(")"): 41, ord("\\"): 92}
    while i < n:
        c = b[i]
        if c == 92 and i + 1 < n:
            d = b[i + 1]
            if d in esc:
                out.append(esc[d])
                i += 2
                continue
            if 48 <= d <= 55:
                j = i + 1
                while j < n and j < i + 4 and 48 <= b[j] <= 55:
                    j += 1
                out.append(int(b[i + 1:j], 8) & 0xFF)
                i = j
                continue
            if d in (10, 13):
                i += 2
                continue
            out.append(d)
            i += 2
            continue
        out.append(c)
        i += 1
    return bytes(out)


def _pdf_string(token):
    """Decode a PDF literal '(..)' or hex '<..>' string."""
    token = token.strip()
    if token.startswith(b"<"):
        hexs = re.sub(rb"[^0-9A-Fa-f]", b"", token)
        if len(hexs) % 2:
            hexs += b"0"
        raw = bytes.fromhex(hexs.decode("ascii"))
    else:
        raw = _pdf_unescape(token[1:-1])
    if raw.startswith(b"\xfe\xff"):
        return raw[2:].decode("utf-16-be", "replace")
    if raw.startswith(b"\xef\xbb\xbf"):
        return raw[3:].decode("utf-8", "replace")
    return raw.decode("latin-1")


def _pdf_text(content):
    parts = []
    for m in _PDF_SHOW_RE.finditer(content):
        if m.group(1) is not None:
            parts.append(b"".join(_pdf_unescape(x[1:-1]) for x in _PDF_LIT_RE.findall(m.group(1))))
        else:
            parts.append(_pdf_unescape(m.group(2)[1:-1]))
    return b" ".join(parts).decode("latin-1")


def _good_pdf_title(t):
    t = _ws(t)
    if len(t.split()) < 3 or len(t) > 300:
        return False
    return not re.search(r"\.(?:dvi|docx?|tex|pdf|indd|qxd|rtf)\b|microsoft word|untitled|^arxiv|template|"
                         r"^\s*paper\s*\d*\s*$", t, re.I)


def pdf_identifiers(data):
    """Find a DOI, an arXiv id (from arXiv's margin stamp) and a title in PDF
    bytes (the first few MB are enough).  Never raises.
    Returns {"doi": str, "arxiv": str, "title": str}."""
    out = {"doi": "", "arxiv": "", "title": ""}
    try:
        if not isinstance(data, (bytes, bytearray)) or not _is_pdf_bytes(bytes(data[:1024])):
            return out
        data = bytes(data)
        xmps = [m.group(0) for m in re.finditer(rb"<x:xmpmeta.*?</x:xmpmeta>", data[:8 * MB], re.S)][:4]
        infos = [data]
        texts = []
        # arXiv appends its margin stamp as an incremental update at the end of
        # the file, so look at the last streams first, then from the top.
        starts = [m for m in re.finditer(rb"(?<!end)stream\r?\n", data)]
        order = starts[-30:][::-1] + starts[:-30]
        budget = 64 * MB
        for n, m in enumerate(order):
            if n >= 600 or budget <= 0 or (out["arxiv"] and len(texts) >= 8):
                break
            k = data.rfind(b"obj", max(0, m.start() - 1500), m.start())
            hdr = data[k if k >= 0 else max(0, m.start() - 1500):m.start()]
            if b"FlateDecode" not in hdr:
                continue
            if re.search(rb"/Subtype\s*/Image|/FontFile|/Length1|/Subtype\s*/(?:Type1C|CIDFontType0C|OpenType|XML)"
                         rb"|/Type\s*/XRef|/ICCBased|/N\s+[34]\b", hdr):
                continue
            end = data.find(b"endstream", m.end())
            raw = data[m.end():] if end < 0 else data[m.end():end]
            try:
                dec = zlib.decompressobj().decompress(raw, 4 * MB)
            except zlib.error:
                continue
            budget -= len(dec)
            if b"xmpmeta" in dec:
                xmps.append(dec)
            elif b"/ObjStm" in hdr:
                infos.append(dec)
            elif b"Tj" in dec or b"TJ" in dec:
                t = _pdf_text(dec)
                texts.append(t)
                if not out["arxiv"]:
                    out["arxiv"] = _arxiv_stamp(t)
        for x in xmps:
            s = x.decode("utf-8", "replace")
            if not out["doi"]:
                for pat in (r"<prism:doi>\s*([^<]+?)\s*</prism:doi>", r"prism:doi=\"([^\"]+)\"",
                            r"<pdfx:doi>\s*([^<]+?)\s*<", r"pdfx:doi=\"([^\"]+)\"",
                            r"<crossmark:DOI>\s*([^<]+?)\s*<", r"crossmark:DOI=\"([^\"]+)\"",
                            r"<dc:identifier>\s*(?:<[^>]+>\s*)*(?:doi:\s*|https?://(?:dx\.)?doi\.org/)?(10\.\d{4,9}/[^<\s]+)"):
                    mm = re.search(pat, s, re.I)
                    if mm:
                        d = _clean_doi(mm.group(1))
                        if d:
                            out["doi"] = d
                            break
            if not out["title"]:
                mm = re.search(r"<dc:title>.*?<rdf:li[^>]*>(.*?)</rdf:li>", s, re.S)
                if mm and _good_pdf_title(_clean_text(mm.group(1))):
                    out["title"] = _clean_text(mm.group(1))
        for blob in infos:
            for dm in re.finditer(rb"<<((?:(?!<<|>>).){0,4000}?)>>", blob, re.S):
                body = dm.group(1)
                if b"/Producer" not in body and b"/CreationDate" not in body and b"/Creator" not in body:
                    continue
                if not out["doi"]:
                    mm = re.search(rb"/(?:doi|DOI)\s*(" + _PDF_LIT + rb"|<[0-9A-Fa-f\s]+>)", body)
                    if mm:
                        out["doi"] = _clean_doi(_pdf_string(mm.group(1)))
                if not out["title"]:
                    mm = re.search(rb"/Title\s*(" + _PDF_LIT + rb"|<[0-9A-Fa-f\s]+>)", body)
                    if mm:
                        t = _ws(_pdf_string(mm.group(1)))
                        if _good_pdf_title(t):
                            out["title"] = t
    except Exception:
        pass
    return out


def _arxiv_stamp(text):
    """arXiv's margin stamp looks like 'arXiv:1706.03762v7  [cs.CL]  2 Aug 2023'."""
    mm = re.search(r"arXiv:\s*(\d{4}\.\d{4,5})(v\d+)?\s*\[[a-z\-]+(?:\.[A-Za-z\-]+)?\]", text) or \
        re.search(r"arXiv:\s*([a-z\-]+(?:\.[A-Za-z\-]+)?/\d{7})(v\d+)?\s*\[[a-z\-]+(?:\.[A-Za-z\-]+)?\]", text)
    if not mm:
        return ""
    return _match_arxiv_exact(mm.group(1) + (mm.group(2) or ""))


def sniff_pdf_file(path, max_bytes=8 * MB):
    """pdf_identifiers() for a file on disk (reads the head plus the tail,
    where the document-info dictionary usually lives).  Never raises."""
    try:
        size = os.path.getsize(path)
        with open(path, "rb") as f:
            head = f.read(max_bytes)
            tail = b""
            if size > max_bytes:
                f.seek(max(max_bytes, size - 512 * 1024))
                tail = f.read()
        return pdf_identifiers(head + b"\n" + tail)
    except Exception:
        return {"doi": "", "arxiv": "", "title": ""}


# =============================================================================
# citekey / bibtex / short author list
# =============================================================================

_STOPWORDS = {"a", "an", "the", "on", "of", "in", "for", "to", "and", "with", "from",
              "towards", "toward"}


def _family_of(a):
    if isinstance(a, dict):
        return _ws(a.get("family") or a.get("given") or "")
    if isinstance(a, str):
        sa = _split_name(a)
        return sa["family"] if sa else ""
    return ""


def citekey(meta):
    """first-author family + year + first significant title word, [a-z0-9] only."""
    m = meta if isinstance(meta, dict) else {}
    fam = ""
    for a in m.get("authors") or []:
        fam = _family_of(a)
        if fam:
            break
    words = re.findall(r"[a-z0-9]+", _fold(fam).lower())
    if len(words) > 3:  # an organisation, e.g. "The LIGO Scientific Collaboration"
        words = [w for w in words if w not in _STOPWORDS][:1]
    name = "".join(words) or "anon"
    year = m.get("year")
    if not year and isinstance(m.get("date"), str):
        year = m["date"][:4]
    year = str(year) if re.fullmatch(r"\d{4}", str(year or "")) else "nd"
    title = re.sub(r"\\[A-Za-z]+", " ", _clean_text(m.get("title") or ""))
    tw = next((w for w in re.findall(r"[a-z0-9]+", _fold(title).lower()) if w not in _STOPWORDS), "")
    return re.sub(r"[^a-z0-9]", "", name + year + tw)


_MATH_RE = re.compile(r"(?<!\\)\$[^$\n]+?(?<!\\)\$")
_LATEX_CMD_RE = re.compile(r"\\(?:[A-Za-z]+|[\"'`^~=.])")


def _bib_escape_plain(s, keep_braces):
    s = re.sub(r"(?<!\\)([&%#_$])", r"\\\1", s)
    if not keep_braces:
        s = re.sub(r"(?<!\\)([{}])", r"\\\1", s)
    return s


def _bib_escape(s):
    """Escape & % $ # _ { } for BibTeX; inline $math$ is kept verbatim, and
    braces are left alone when the text already contains LaTeX commands."""
    s = _ws(s)
    out, pos = [], 0
    outside = _MATH_RE.sub(" ", s)
    keep = bool(_LATEX_CMD_RE.search(outside))
    for m in _MATH_RE.finditer(s):
        out.append(_bib_escape_plain(s[pos:m.start()], keep))
        out.append(m.group(0))
        pos = m.end()
    out.append(_bib_escape_plain(s[pos:], keep))
    return "".join(out)


def _protect_caps(s):
    """Brace words like BERT, AlphaFold, SARS-CoV-2 so styles keep their case."""
    out, pos = [], 0
    for m in _MATH_RE.finditer(s):
        out.append(_protect_segment(s[pos:m.start()]))
        out.append(m.group(0))
        pos = m.end()
    out.append(_protect_segment(s[pos:]))
    return "".join(out)


def _protect_segment(seg):
    def fix(tok):
        if not tok or "\\" in tok or "{" in tok or "}" in tok:
            return tok
        mm = re.match(r"^([^\w]*)([\w][\w\-'.]*?)([^\w]*)$", tok)
        if not mm:
            return tok
        pre, core, post = mm.groups()
        if any(c.isupper() for c in core[1:]) or (len(core) == 1 and core.isupper() and core not in ("A", "I")):
            return f"{pre}{{{core}}}{post}"
        return tok
    return " ".join(fix(t) for t in seg.split(" "))


def _bib_name(a):
    fam, giv = _bib_escape(a.get("family", "")), _bib_escape(a.get("given", ""))
    if not giv:
        return f"{{{fam}}}" if " " in fam else fam
    if fam.lower().split(" ")[-1] in _SUFFIXES and " " in fam:  # "King Jr." -> "King, Jr., Martin"
        base, suf = fam.rsplit(" ", 1)
        return f"{base}, {suf}, {giv}"
    return f"{fam}, {giv}"


def bibtex(meta, key):
    """A clean BibTeX entry for meta under the given key."""
    m = _finalize_meta(meta if isinstance(meta, dict) else {})
    key = re.sub(r"[^A-Za-z0-9_:\-.]", "", str(key or "")) or citekey(m)
    typ, venue = m["type"], m["venue"]
    is_arxiv = bool(m["arxiv"])
    if typ == "article" and venue and venue.lower() != "arxiv":
        etype = "article"
    elif typ == "inproceedings" and venue:
        etype = "inproceedings"
    elif typ == "book":
        etype = "book"
    elif typ == "thesis":
        etype = "phdthesis"
    else:
        etype = "misc"
    fields = []

    def add(name, value, raw=False):
        value = _ws(value)
        if value:
            fields.append((name, value if raw else _bib_escape(value)))

    if m["title"]:
        fields.append(("title", _protect_caps(_bib_escape(m["title"]))))
    if m["authors"]:
        fields.append(("author", " and ".join(_bib_name(a) for a in m["authors"])))
    if etype == "article":
        add("journal", venue)
    elif etype == "inproceedings":
        add("booktitle", venue)
    elif etype == "phdthesis":
        add("school", venue or m["publisher"])
    elif etype == "misc" and venue and venue.lower() != "arxiv":
        add("howpublished", venue)
    if etype != "phdthesis":
        add("volume", m["volume"])
        add("number", m["issue"])
        if m["pages"]:
            fields.append(("pages", _bib_escape(m["pages"]).replace("-", "--")))
    if m["year"]:
        fields.append(("year", str(m["year"])))
    if etype in ("book", "inproceedings"):
        add("publisher", m["publisher"])
    if m["doi"]:
        fields.append(("doi", re.sub(r"[\s{}]", "", m["doi"])))
    if is_arxiv:
        fields.append(("eprint", m["arxiv"]))
        fields.append(("archivePrefix", "arXiv"))
        if m["categories"] and _ARXIV_CAT_RE.match(m["categories"][0]):
            fields.append(("primaryClass", m["categories"][0]))
    if m["url"]:
        fields.append(("url", re.sub(r"[\s{}]", "", m["url"])))
    width = max([len(n) for n, _ in fields] + [9])
    lines = [f"@{etype}{{{key},"]
    for i, (n, v) in enumerate(fields):
        lines.append(f"  {n.ljust(width)} = {{{v}}}" + ("," if i < len(fields) - 1 else ""))
    lines.append("}")
    return "\n".join(lines) + "\n"


def format_authors_short(authors):
    """'Morimoto', 'Morimoto & Nagaosa', 'Vaswani et al.'"""
    names = [n for n in (_family_of(a) for a in (authors or [])) if n]
    if not names:
        return ""
    if len(names) == 1:
        return names[0]
    if len(names) == 2:
        return f"{names[0]} & {names[1]}"
    return f"{names[0]} et al."


if __name__ == "__main__":  # python3 importers.py <arxiv id | DOI | link>
    if len(sys.argv) < 2:
        print("usage: importers.py <arXiv id | DOI | URL>")
        sys.exit(2)
    arg = " ".join(sys.argv[1:])
    print(json.dumps(parse_input(arg), indent=2))
    out = resolve(arg)
    print(json.dumps(out, indent=2, ensure_ascii=False))
    if out["ok"]:
        print(bibtex(out["meta"], citekey(out["meta"])))
