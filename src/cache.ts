import type { ResolvedState } from "./types";

/**
 * The in-process LRU of resolved state, keyed by organization id.
 * - Entries live `ttlMs`; `ttlMs: 0` turns the cache off (`get` always misses).
 * - At most `maxEntries` organizations; the least recently used goes first.
 * - Never holds usage counters, and never a result computed inside a
 *   transaction (callers don't `set` those).
 * - A per-organization generation guards fills against writes (RC review
 *   2): a read takes `generation(id)` before its first query and passes it
 *   to `set`, which skips the fill when that organization's entry was
 *   deleted (a write cleared it) or the cache cleared since. So a read that
 *   began before a write never caches the older state it read.
 * - `get` hands back the stored deep-frozen state with fresh copies of its
 *   `Date`s (`servedState`), so `setDate` on a result can't change the
 *   cache.
 */
export type EntitlementsCache = {
  get(organizationId: string): ResolvedState | undefined;
  /**
   * Stores a state. With `generation` (what `generation(organizationId)`
   * answered before the state's reads), the state is not stored when that
   * organization's entry was deleted, or the cache cleared, since.
   */
  set(organizationId: string, state: ResolvedState, generation?: number): void;
  /** Drops the entry and moves the organization's generation on. */
  delete(organizationId: string): void;
  /** Drops every entry and moves every generation on. */
  clear(): void;
  /** The organization's generation now: it moves on every `delete` of it and every `clear`, and never comes back to an earlier value. */
  generation(organizationId: string): number;
};

type Entry = { state: ResolvedState; expiresAt: number };

/** Fewest per-organization delete marks kept (the table holds at least `maxEntries`). */
const MIN_GENERATIONS = 1000;

/**
 * Creates the cache: a `Map` kept in recency order (a hit moves the entry
 * to the end; an insert past `maxEntries` drops the first). Expiry reads
 * `Date.now()` (the cache has no runtime clock), so Vitest fake timers move
 * it.
 *
 * Generations: every `delete` takes the next tick of one counter and
 * records it for that organization; an organization without a record has
 * the `floor`. The record table is bounded (the oldest record goes first,
 * and the floor rises to its tick), so a long-lived process doesn't grow
 * it: dropping a record keeps that organization's generation and moves only
 * the unrecorded ones on, which can only skip a fill, never let a stale one
 * in. `clear` empties the table and raises the floor past every tick.
 */
export function createCache(options: {
  ttlMs: number;
  maxEntries: number;
}): EntitlementsCache {
  const { ttlMs, maxEntries } = options;
  const entries = new Map<string, Entry>();
  const off = !(ttlMs > 0) || !(maxEntries > 0);
  const keep = Math.max(maxEntries, MIN_GENERATIONS);
  /** Organization → the tick of its last delete, oldest first. */
  const deletes = new Map<string, number>();
  let tick = 0;
  let floor = 0;
  const generation = (organizationId: string) =>
    deletes.get(organizationId) ?? floor;
  return {
    get(organizationId) {
      if (off) return undefined;
      const entry = entries.get(organizationId);
      if (!entry) return undefined;
      entries.delete(organizationId);
      if (entry.expiresAt <= Date.now()) return undefined;
      entries.set(organizationId, entry);
      return servedState(entry.state);
    },
    set(organizationId, state, since) {
      if (off) return;
      if (since !== undefined && since !== generation(organizationId)) return;
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
      if (off) return;
      tick += 1;
      deletes.delete(organizationId);
      deletes.set(organizationId, tick);
      while (deletes.size > keep) {
        const oldest = deletes.entries().next();
        if (oldest.done) break;
        deletes.delete(oldest.value[0]);
        floor = oldest.value[1];
      }
    },
    clear() {
      entries.clear();
      deletes.clear();
      tick += 1;
      floor = tick;
    },
    generation(organizationId) {
      return off ? 0 : generation(organizationId);
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

/**
 * `value` with a fresh frozen copy of every `Date` in it, and fresh frozen
 * copies of the plain objects and arrays on the way to one; parts without a
 * `Date` are shared as they are.
 */
function freshDates<T>(value: T): T {
  if (value instanceof Date) {
    return Object.freeze(new Date(value.getTime())) as T;
  }
  if (Array.isArray(value)) {
    let changed = false;
    const items = value.map((item) => {
      const next = freshDates(item);
      if (next !== item) changed = true;
      return next;
    });
    return changed ? (Object.freeze(items) as T) : value;
  }
  if (typeof value === "object" && value !== null) {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return value;
    let changed = false;
    const copy: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const next = freshDates(item);
      if (next !== item) changed = true;
      copy[key] = next;
    }
    return changed ? (Object.freeze(copy) as T) : value;
  }
  return value;
}

/**
 * A stored (deep-frozen) state as one caller gets it: the same frozen
 * objects, except that every `Date` (`periodEnd`, an override's
 * `expiresAt`, the snapshot's dates) is a fresh copy, so `setDate` on what
 * one caller got changes neither the cache nor what the next caller gets.
 */
export function servedState(state: ResolvedState): ResolvedState {
  const result = freshDates(state.result);
  const snapshot = freshDates(state.snapshot);
  if (result === state.result && snapshot === state.snapshot) return state;
  return Object.freeze({ ...state, result, snapshot });
}
