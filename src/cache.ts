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
