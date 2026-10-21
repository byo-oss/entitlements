// BYO_STUB: N03 replaces this file (contracts.md "cache.ts")
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

/** Creates the cache. Stub: a cache that never holds anything. */
export function createCache(_options: {
  ttlMs: number;
  maxEntries: number;
}): EntitlementsCache {
  return {
    get: () => undefined,
    set: () => {},
    delete: () => {},
    clear: () => {},
  };
}
