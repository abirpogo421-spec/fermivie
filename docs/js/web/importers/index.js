// Public surface of the browser importers (port of importers.py's __all__; WEB_CONTRACT.md section 6.2).
//
//   parseInput(text)                       classify pasted text, no network
//   resolve(text, {timeout})               look the paper up online (CORS-open APIs only)
//   search(query, limit, {timeout})        title search (arXiv's records at DataCite, Crossref)
//   findPreprint(meta, {timeout})          arXiv id of a published paper's preprint, or ""
//   downloadPdf(url, {timeout, maxBytes})  {ok, error, bytes, size, sha256, final_url, content_type}
//   citekey(meta), bibtex(meta, key), cleanAbstract(text), emptyMeta(), normTitle(s), sniffPdf(bytes),
//   formatAuthorsShort(authors), NO_OA_PDF_WARNING
// Extras for the back end: BLOCKED_SITE_MESSAGE, isReachable(url) (true when a web page may fetch that URL).

export { parseInput } from "./parse.js";
export { cleanAbstract } from "./abstract.js";
export { emptyMeta, normTitle, formatAuthorsShort } from "./names.js";
export { citekey, bibtex } from "./bibtex.js";
export { sniffPdf } from "./pdfsniff.js";
export { resolve, search, findPreprint, downloadPdf, NO_OA_PDF_WARNING, BLOCKED_SITE_MESSAGE } from "./resolve.js";
export { isReachable } from "./net.js";
