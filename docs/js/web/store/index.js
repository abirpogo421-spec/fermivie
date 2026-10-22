// js/web/store: the browser port of library_store.py (WEB_CONTRACT.md 6.1).
//
//   const lib = await Library.open(fs, {libraryId});   // fs: any LibFS (DirFS, IdbFS, NodeFS, ...)
//   const data = await lib.load();  await lib.patchItem(key, {read: "read"});  ...
//
// Every Python method is here in camelCase with the same results, errors (StoreError status, message and
// extra) and files on disk. See library.js for the locking rules and the argument mapping, model.js for the
// module-level functions, libjson.js for how library.json keeps Python's floats and key order and how caller
// arguments are read (asJson: as the JSON body the server would get), reserve.js for import reservations
// across Library objects and tabs, unicode.js (generated from Python 3.13) for the Unicode data py.js uses.

export { Library } from "./library.js";
export {
  StoreError, bad, notFound, rx,
  KEY_RE, ATT_RE, PROJECT_RE, CROP_RE, MARK_TYPE_ID,
  TYPES, READ_STATES, STR_FIELDS, META_FIELDS, EDITABLE, HISTORY_KEEP, SEARCH_MAX_HITS, MARK_TYPES, TYPE_NAME,
  PALETTE, WINDOWS_RESERVED, RESERVED_TYPE_IDS, DEFAULT_MARK_TYPES, DEFAULT_SETTINGS, SETTING_CHOICES,
  defaultSettings, mergeSettings, fillSettings, cleanMarkTypes, defaultMarkTypes, marksMd, countMarks,
  cleanMeta, newItem, itemMeta, isPdf, slug, cleanAuthors, year, strList, strItems, settingValue,
} from "./model.js";
export { parseLibJson, dumpsLib, dumpLibJson, markFloat, isFloat, markExact, exactText, assign, remove, keysOf, deepCopy,
  dictCopy, asJson } from "./libjson.js";
