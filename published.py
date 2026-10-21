"""The journal (published) version of a paper.

- journal_pdf_urls(doi): where a journal serves the PDF for a DOI. The browser opens these with the
  user's own access (campus network, institutional login); the server also tries them, which works
  for open-access journals.
- find_local_pdf(item): a PDF of this paper that the user already has in ~/Downloads (or ~/Desktop),
  matched by DOI in the file name or inside the PDF. Files are only read, never moved.
Stdlib only.
"""
import os
import re
import time

import importers

APS = {
    "physrevlett": "prl", "physrevb": "prb", "physreva": "pra", "physrevc": "prc", "physrevd": "prd",
    "physreve": "pre", "physrevx": "prx", "physrevresearch": "prresearch", "physrevapplied": "prapplied",
    "physrevmaterials": "prmaterials", "physrevfluids": "prfluids", "physrevaccelbeams": "prab",
    "physrevphyseducres": "prper", "prxquantum": "prxquantum", "revmodphys": "rmp", "physrev": "pr",
}


def journal_pdf_urls(doi):
    """Best-guess PDF links on the publisher's own site, most specific first."""
    doi = (doi or "").strip()
    if not doi.lower().startswith("10."):
        return []
    low = doi.lower()
    out = []
    if low.startswith("10.1103/"):
        j = low.split("/", 1)[1].split(".")[0]
        if j in APS:
            out.append(f"https://journals.aps.org/{APS[j]}/pdf/{doi}")
    elif low.startswith("10.1038/"):
        out.append(f"https://www.nature.com/articles/{doi.split('/', 1)[1]}.pdf")
    elif low.startswith("10.1126/"):
        out.append(f"https://www.science.org/doi/pdf/{doi}")
    elif low.startswith("10.1021/"):
        out.append(f"https://pubs.acs.org/doi/pdf/{doi}")
    elif low.startswith("10.1002/") or low.startswith("10.1111/"):
        out.append(f"https://onlinelibrary.wiley.com/doi/pdfdirect/{doi}")
    elif low.startswith("10.1088/") or low.startswith("10.1149/"):
        out.append(f"https://iopscience.iop.org/article/{doi}/pdf")
    elif low.startswith("10.1007/") or low.startswith("10.1186/"):
        out.append(f"https://link.springer.com/content/pdf/{doi}.pdf")
    elif low.startswith("10.1073/"):
        out.append(f"https://www.pnas.org/doi/pdf/{doi}")
    return out


def journal_open_url(doi):
    """What to open in the browser: the journal's PDF if we know its pattern, else the DOI page."""
    u = journal_pdf_urls(doi)
    return u[0] if u else (f"https://doi.org/{doi}" if doi else "")


def _norm(s):
    return re.sub(r"[^a-z0-9]", "", (s or "").lower())


def _name_keys(doi):
    """File-name fragments that identify a DOI: 'PhysRevB.61.5337', 's41586-021-03819-2', the whole DOI."""
    doi = (doi or "").strip()
    if not doi:
        return []
    suffix = doi.split("/", 1)[1] if "/" in doi else doi
    keys = {_norm(suffix), _norm(doi)}
    return [k for k in keys if len(k) >= 8]


SEARCH_DIRS = [os.path.abspath(os.path.expanduser(p.strip().strip("\"'"))) for p in os.environ.get("PM_SEARCH_DIRS", "").split(os.pathsep) if p.strip()] or \
    [os.path.expanduser("~/Downloads"), os.path.expanduser("~/Desktop")]
_sniff_cache = {}   # path -> ((mtime, size), identifiers)


def _candidates(max_files=400, max_age_days=730):
    files = []
    cutoff = time.time() - max_age_days * 86400
    for d in SEARCH_DIRS:
        try:
            with os.scandir(d) as it:
                for e in it:
                    if e.is_file() and e.name.lower().endswith(".pdf"):
                        st = e.stat()
                        if st.st_mtime >= cutoff and st.st_size > 10_000:
                            files.append((st.st_mtime, e.path, st.st_size))
        except OSError:
            continue
    files.sort(reverse=True)
    return files[:max_files]


def _sniff(path, mtime, size):
    sig = (mtime, size)
    hit = _sniff_cache.get(path)
    if hit and hit[0] == sig:
        return hit[1]
    ids = importers.sniff_pdf_file(path) or {}
    _sniff_cache[path] = (sig, ids)
    return ids


def find_local_pdf(item, since=None, sniff_limit=60):
    """-> path of a PDF of this paper's published version found in Downloads/Desktop, or None.
    A file name match is enough; otherwise the PDF's own DOI must match. Preprints (arXiv-stamped,
    no DOI) are ignored: the point is the journal version."""
    doi = (item.get("doi") or "").strip()
    if not doi or doi.lower().startswith("10.48550/"):
        return None
    keys = _name_keys(doi)
    title = importers._norm_title(item.get("title") or "")
    title = title if len(title.split()) >= 4 else ""   # too short to prove anything
    own = {a.get("sha256") for a in item.get("attachments", [])}
    sniffed = 0
    for mtime, path, size in _candidates():
        if since and mtime < since:
            continue
        base = _norm(os.path.splitext(os.path.basename(path))[0])
        hit = any(k in base for k in keys)
        if not hit and sniffed < sniff_limit:
            sniffed += 1
            ids = _sniff(path, mtime, size)
            hit = (ids.get("doi") or "").lower() == doi.lower()
            # no readable DOI: the PDF's own title, word for word, is the next best proof
            if not hit and not ids.get("doi") and not ids.get("arxiv") and ids.get("title") and title:
                hit = importers._norm_title(ids["title"]) == title
        if hit:
            try:
                if importers_sha(path) in own:
                    continue
            except OSError:
                continue
            return path
    return None


def importers_sha(path):
    import hashlib
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def is_preprint_url(url):
    return "arxiv.org" in (url or "").lower()
