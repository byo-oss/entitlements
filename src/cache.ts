import type { ResolvedState } from "./types";

/**
 * The in-process LRU of resolved state, keyed by organization id.
 * - Entries live `ttlMs`; `ttlMs: 0` turns the cache off (`get` always misses).
 * - At most `maxEntries` organizations; the least recently used goes first.
 * - Never holds usage counters, and never a result computed inside a
 *   transaction (callers don't `set` those).
 */
export type EntitlementsCache = {
  get(organizationId: string): ResolvedState | undefined;
  set(organizationId: string, state: ResolvedState): void;
  delete(organizationId: string): void;
  clear(): void;
};

type Entry = { state: ResolvedState; expiresAt: number };

/**
 * Creates the cache: a `Map` kept in recency order (a hit moves the entry
 * to the end; an insert past `maxEntries` drops the first). Expiry reads
 * `Date.now()` (the cache has no runtime clock), so Vitest fake timers move
 * it.
 */
export function createCache(options: {
  ttlMs: number;
  maxEntries: number;
}): EntitlementsCache {
  const { ttlMs, maxEntries } = options;
  const entries = new Map<string, Entry>();
  const off = !(ttlMs > 0) || !(maxEntries > 0);
  return {
    get(organizationId) {
      if (off) return undefined;
      const entry = entries.get(organizationId);
      if (!entry) return undefined;
      entries.delete(organizationId);
      if (entry.expiresAt <= Date.now()) return undefined;
      entries.set(organizationId, entry);
      return entry.state;
    },
    set(organizationId, state) {
      if (off) return;
      entries.delete(organizationId);
      entries.set(organizationId, { state, expiresAt: Date.now() + ttlMs });
      while (entries.size > maxEntries) {
        const oldest = entries.keys().next();
        if (oldest.done) break;
        entries.delete(oldest.value);
      }
    },
    delete(organizationId) {
      entries.delete(organizationId);
    },
    clear() {
      entries.clear();
    },
  };
}

/**
 * A deep-frozen copy of `value`: plain objects, arrays and `Date`s are
 * copied, then frozen; anything else (functions, class instances an app put
 * in a plan's `display`) is shared as is. Copying first keeps the freeze off
 * objects the adapter or the catalog own.
 */
function frozenCopy<T>(value: T): T {
  if (value instanceof Date) {
    return Object.freeze(new Date(value.getTime())) as T;
  }
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item) => frozenCopy(item))) as T;
  }
  if (typeof value === "object" && value !== null) {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return value;
    const copy: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      copy[key] = frozenCopy(item);
    }
    return Object.freeze(copy) as T;
  }
  return value;
}

/**
 * The state the cache stores and every caller gets back from it: a
 * deep-frozen copy (`result` and `snapshot`), so one caller changing a
 * result can't change what the next one reads. Results are read-only.
 */
export function freezeState(state: ResolvedState): ResolvedState {
  return Object.freeze({
    ...state,
    result: frozenCopy(state.result),
    snapshot: frozenCopy(state.snapshot),
  });
}
