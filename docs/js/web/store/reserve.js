// Import reservations (Python's Library.reserve / release with self.cond, self.inflight, self.reserved), shared by
// every Library object on one library: Python keeps them on the one Library its server has, which every tab
// reaches, so a second import of the same paper waits for the first and two imports never get the same key.
//
// With Web Locks (navigator.locks, every browser in use and node 22+) they are locks, so they reach every tab of
// the site, and a tab that closes mid-import lets its reservations go:
//   <P>cond          held while one reserve() looks and decides (Python's `with self.cond`)
//   <P>id:<ident>    held from reserve() until release(): an import busy with that identifier (self.inflight)
//   <P>key:<key>     held the same way: an item key a running import will use (self.reserved)
// where <P> = "pm-web-import:" + encodeURIComponent(libraryId) + ":". A reserve() that finds one of its
// identifiers held waits for that lock (granted when the holder lets go), then looks again, as Python's
// `while idents & self.inflight: self.cond.wait()` does. release() can let go only of locks this page holds
// (a page can't free another page's locks); the import that reserved is the one that releases.
// Without Web Locks: the same state in memory, one per libraryId for every Library object in this page.

const prefix = (libraryId) => "pm-web-import:" + encodeURIComponent(String(libraryId ?? "")) + ":";

/** navigator.locks when it can request and query, else null (read on every call: tests hide it). */
export function webLocks() {
  const l = globalThis.navigator?.locks;
  return l && typeof l.request === "function" && typeof l.query === "function" ? l : null;
}

// ---- Web Locks ------------------------------------------------------------------------------------

const HELD = new Map(); // lock name -> {release, done} for the reservation locks this page holds

/** Take lock `name` and keep it until release(name); resolves once it is granted. */
async function hold(locks, name) {
  let letGo, granted;
  const gate = new Promise((r) => { letGo = r; });
  const got = new Promise((r) => { granted = r; });
  const done = locks.request(name, () => {
    granted();
    return gate;
  });
  await got;
  HELD.set(name, { release: letGo, done });
}

async function heldNames(locks) {
  const q = await locks.query();
  return new Set((q.held || []).map((l) => l.name));
}

/**
 * reserve() through Web Locks. decide(reservedKeys) runs with <P>cond held once no identifier is busy and
 * returns [key, null] (the key is then reserved together with the identifiers) or [null, duplicateKey].
 */
async function reserveLocked(locks, libraryId, ids, decide) {
  const P = prefix(libraryId);
  for (;;) {
    const r = await locks.request(P + "cond", async () => {
      const held = await heldNames(locks);
      const busy = ids.filter((i) => held.has(P + "id:" + i));
      if (busy.length) return { busy };
      const keys = new Set([...held].filter((n) => n.startsWith(P + "key:")).map((n) => n.slice(P.length + 4)));
      const out = await decide(keys);
      if (out[0] !== null) {
        await hold(locks, P + "key:" + out[0]);
        for (const i of ids) await hold(locks, P + "id:" + i);
      }
      return { out };
    });
    if (r.out) return r.out;
    for (const i of r.busy) await locks.request(P + "id:" + i, () => {}); // granted when that import lets go
  }
}

async function releaseLocked(libraryId, ids, key) {
  const P = prefix(libraryId);
  const waits = [];
  const names = ids.map((i) => P + "id:" + i);
  if (typeof key === "string") names.push(P + "key:" + key); // Python's reserved.discard(None) does nothing
  for (const name of names) {
    const h = HELD.get(name);
    if (!h) continue;
    HELD.delete(name);
    h.release();
    waits.push(h.done);
  }
  await Promise.all(waits);
}

// ---- in memory (no Web Locks) ---------------------------------------------------------------------

/** Python's threading.Condition, for import reservations. */
class Condition {
  constructor() {
    this.locked = false;
    this.queue = [];
    this.waiters = new Set();
  }

  async acquire() {
    if (!this.locked) { this.locked = true; return; }
    await new Promise((r) => this.queue.push(r));
  }

  release() {
    const next = this.queue.shift();
    if (next) next();
    else this.locked = false;
  }

  /** Release, wait for notifyAll() or the timeout, re-acquire. */
  async wait(timeoutMs) {
    let wake;
    const woken = new Promise((r) => { wake = r; });
    this.waiters.add(wake);
    const timer = setTimeout(wake, timeoutMs);
    this.release();
    await woken;
    clearTimeout(timer);
    this.waiters.delete(wake);
    await this.acquire();
  }

  notifyAll() {
    const w = [...this.waiters];
    this.waiters.clear();
    for (const f of w) f();
  }
}

const LOCAL = new Map(); // libraryId -> {cond, inflight, reserved}

function local(libraryId) {
  const id = String(libraryId ?? "");
  let s = LOCAL.get(id);
  if (!s) LOCAL.set(id, (s = { cond: new Condition(), inflight: new Set(), reserved: new Set() }));
  return s;
}

// ---- the store's entry points ---------------------------------------------------------------------

/** The identifiers reserve() and release() use: `{i for i in idents if i}` (Python iterates a set; this keeps
 *  the caller's order). */
export const identSet = (idents, truthy) => [...new Set([...(idents ?? [])].filter((i) => truthy(i)))];

/** Item keys reserved by running imports of this library (self.reserved). */
export async function reservedKeys(libraryId) {
  const locks = webLocks();
  if (!locks) return new Set(local(libraryId).reserved);
  const P = prefix(libraryId);
  return new Set([...(await heldNames(locks))].filter((n) => n.startsWith(P + "key:")).map((n) => n.slice(P.length + 4)));
}

/** Wait until no other import is busy with these identifiers, then decide(reservedKeys) -> [key, null] or
 *  [null, dup]; a key returned is reserved with the identifiers until release(). */
export async function reserve(libraryId, ids, decide) {
  const locks = webLocks();
  if (locks) return reserveLocked(locks, libraryId, ids, decide);
  const s = local(libraryId);
  await s.cond.acquire();
  try {
    while (ids.some((i) => s.inflight.has(i))) await s.cond.wait(180000);
    const out = await decide(new Set(s.reserved));
    if (out[0] !== null) {
      s.reserved.add(out[0]);
      for (const i of ids) s.inflight.add(i);
    }
    return out;
  } finally {
    s.cond.release();
  }
}

export async function release(libraryId, ids, key) {
  if (webLocks()) return releaseLocked(libraryId, ids, key);
  const s = local(libraryId);
  await s.cond.acquire();
  try {
    for (const i of ids) s.inflight.delete(i);
    s.reserved.delete(key);
    s.cond.notifyAll();
  } finally {
    s.cond.release();
  }
}
