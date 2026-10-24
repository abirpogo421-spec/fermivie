// server.py's request handling for the browser back end (WEB_CONTRACT.md 6.5): Handler._handle (path checks,
// profile.changed() after every change) and Handler._api (every /api route, in Python's order, with the same
// segment checks, body checks, statuses and payloads). The Host / Origin / Content-Type guards protect a
// server from other sites; a page talking to itself has nothing to guard, so they are left out.
//
//   handle(ctx, method, url, body) -> {status, json} | {status, text, ctype}
//   url: what js/api.js would fetch ("/api/items/<key>?..."), body: makeBody(...) from backend_http.js.
// ctx: see backend_import.js, plus profileRoute(m, segs, getBody) (backend_profile.js), about(), changed().

import { StoreError, bad, notFound, KEY_RE, ATT_RE, PROJECT_RE, rx } from "./store/index.js";
import * as py from "./store/py.js";
import { splitRequest, qget, bodyJson, bodyPdf, ok, textResponse, errorResponse, basename, splitext } from "./backend_http.js";
import * as IM from "./backend_import.js";

export function segKey(s) {
  if (!rx(KEY_RE, s)) throw notFound("No such paper.");
  return s;
}

export function segAtt(s) {
  if (!rx(ATT_RE, s)) throw notFound("No such attachment.");
  return s;
}

export function segProj(s) {
  if (!rx(PROJECT_RE, s)) throw notFound("No such project.");
  return s;
}

const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const or = (v, d) => (py.truthy(v) ? v : d);

/** Handler._handle for one request; never throws (errors become their JSON responses). */
export async function handle(ctx, method, url, body = null) {
  try {
    const r = splitRequest(url);
    if (r.error) return errorResponse(new StoreError(r.error[0], r.error[1]));
    const { segs, query } = r;
    if (segs.length && segs[0] === "api") {
      const out = await api(ctx, method, segs.slice(1), query, body);
      if (method !== "GET" && method !== "HEAD" && segs[1] !== "profile") ctx.changed(); // keep the profile folder up to date
      return out;
    }
    if (method !== "GET" && method !== "HEAD") return errorResponse(new StoreError(405, "Method not allowed."));
    return errorResponse(notFound("Not found."));
  } catch (e) {
    return errorResponse(e);
  }
}

/** Handler._api(m, s, q) */
async function api(ctx, m, s, q, body) {
  const L = ctx.lib;
  const n = s.length;
  const json = () => bodyJson(body);
  if (m === "GET" && same(s, ["library"])) {
    const lib = await L.load();
    lib.markTypes = await L.markTypes(lib);
    return ok({ library: lib, stats: await L.stats(lib) });
  }
  if (same(s, ["mark-types"])) {
    if (m === "GET") {
      const lib = await L.load();
      return ok({ types: await L.markTypes(lib), rev: py.toInt(or(py.pg(lib, "markTypesRev"), 0)) });
    }
    if (m === "PUT") {
      const b = json();
      const [types, rev] = await L.setMarkTypes(py.pg(b, "types"), { baseRev: py.pg(b, "baseRev"), force: py.truthy(py.pg(b, "force")) });
      return ok({ types, rev });
    }
  }
  if (n >= 1 && s[0] === "profile") return ok(await ctx.profileRoute(m, s.slice(1), body));
  if (same(s, ["settings"])) {
    if (m === "GET") return ok({ settings: await L.getSettings(), about: await ctx.about() });
    if (m === "PUT" || m === "PATCH") {
      const b = json();
      const st = await L.setSettings(Object.hasOwn(b, "settings") ? b.settings : b);
      return ok({ settings: st, about: await ctx.about() });
    }
  }
  if (m === "GET" && same(s, ["search"])) return ok({ hits: await L.search(qget(q, "q", "")) });
  if (m === "GET" && same(s, ["export", "bibtex"])) {
    const keys = (qget(q, "keys") || "").split(",").filter((k) => k);
    return textResponse(await L.bibtex({ keys: keys.length ? keys : null, project: qget(q, "project") || null }));
  }
  if (m === "POST" && same(s, ["import"])) {
    const b = json();
    return ok(await IM.doImport(ctx, py.pg(b, "input"), or(py.pg(b, "project"), null)));
  }
  if (m === "POST" && same(s, ["import", "file"])) {
    const project = qget(q, "project") || null;
    if (project && !L.projectIds(await L.load()).has(project)) throw bad("That project does not exist.");
    const pdf = await bodyPdf(body);
    return ok(await IM.doImportFile(ctx, pdf, qget(q, "name") || "", project));
  }
  if (m === "POST" && same(s, ["items"])) {
    const b = json();
    if (!py.isDict(py.pg(b, "meta"))) throw bad("meta must be an object.");
    return ok({ item: await L.createItem(b.meta, { project: or(py.pg(b, "project"), null) }) });
  }
  if (m === "POST" && same(s, ["items", "batch"])) return ok({ items: await L.createItems(py.pg(json(), "items")) });
  if (m === "POST" && same(s, ["items", "bulk"])) return ok({ items: await L.bulk(json()) });
  if (m === "POST" && same(s, ["trash", "empty"])) return ok({ moved: await L.emptyTrash() });
  if (m === "POST" && same(s, ["projects"])) {
    const b = json();
    return ok({ project: await L.createProject(py.pg(b, "name"), { parent: or(py.pg(b, "parent"), null) }) });
  }
  if (n >= 2 && s[0] === "projects") {
    const pid = segProj(s[1]);
    if (m === "PATCH" && n === 2) return ok({ project: await L.patchProject(pid, json()) });
    if (m === "POST" && n === 3 && s[2] === "delete") {
      await L.deleteProject(pid);
      return ok();
    }
    if (n === 3 && s[2] === "notes") {
      if (m === "GET") return ok(await L.getNotes("project", pid));
      if (m === "POST") {
        const b = json();
        return ok(await L.saveNotes("project", pid, py.pg(b, "text"), py.pg(b, "baseRev"), { force: py.truthy(py.pg(b, "force")) }));
      }
    }
  }
  if (n >= 2 && s[0] === "items") return itemRoute(ctx, m, s, q, body, json);
  throw notFound("Unknown API route.");
}

/** The /api/items/<key>/... part of Handler._api */
async function itemRoute(ctx, m, s, q, body, json) {
  const L = ctx.lib;
  const n = s.length;
  const key = segKey(s[1]);
  if (n === 2 && m === "PATCH") return ok({ item: await L.patchItem(key, json()) });
  if (n === 3 && m === "POST") {
    if (s[2] === "enrich") return ok(await IM.doEnrich(ctx, key, json()));
    if (s[2] === "trash" || s[2] === "restore") return ok({ item: await L.setTrashed(key, s[2] === "trash") });
    if (s[2] === "notes") {
      const b = json();
      return ok(await L.saveNotes("item", key, py.pg(b, "text"), py.pg(b, "baseRev"), { force: py.truthy(py.pg(b, "force")) }));
    }
    if (s[2] === "attachments") {
      L.getItem(await L.load(), key);
      const pdf = await bodyPdf(body);
      const name = qget(q, "name") || "";
      const label = qget(q, "label") || splitext(basename(name))[0] || "PDF";
      const [item, att] = await L.addAttachmentBytes(key, pdf, label, { source: "file" });
      return ok({ item, attachment: att });
    }
  }
  if (n === 3 && m === "GET" && s[2] === "journal") {
    const it = L.getItem(await L.load(), key);
    return ok({ url: ctx.pub.journalOpenUrl(py.pg(it, "doi")), has: IM.hasPublished(ctx, it) });
  }
  if (n === 3 && m === "POST" && s[2] === "find-preprint") return ok(await IM.doFindPreprint(ctx, key));
  if (n === 3 && m === "POST" && s[2] === "find-published") {
    const b = json();
    const since = py.pg(b, "since");
    const it = L.getItem(await L.load(), key);
    if (IM.hasPublished(ctx, it)) return ok({ found: true, item: it, already: true });
    const num = typeof since === "number" || typeof since === "boolean" ? Number(since) : null;
    const [got, folder] = await IM.attachLocalPublished(ctx, key, { since: num });
    return ok({ found: !!got, item: got || it, folder });
  }
  if (n === 3 && m === "GET" && s[2] === "notes") return ok(await L.getNotes("item", key));
  if (n === 4 && s[2] === "attachments" && s[3] === "fetch" && m === "POST") return ok(await IM.doFetchAttachment(ctx, key, json()));
  if (n >= 4 && s[2] === "attachments") {
    const att = segAtt(s[3]);
    if (n === 4 && m === "PATCH") {
      const b = json();
      return ok({ item: await L.renameAttachment(key, att, py.pg(b, "label")) });
    }
    if (n === 5 && s[4] === "remove" && m === "POST") return ok({ item: await L.removeAttachment(key, att) });
    if (n === 5 && s[4] === "marks") {
      if (m === "GET") return ok(await L.getMarks(key, att));
      if (m === "POST") {
        const b = json();
        return ok(await L.saveMarks(key, att, py.pg(b, "marks"), py.pg(b, "baseRev"), { force: py.truthy(py.pg(b, "force")) }));
      }
    }
  }
  throw notFound("Unknown API route.");
}
