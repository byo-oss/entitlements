import type { BillingSource, BillingState } from "../types";

/** A settable in-memory `BillingSource`, for tests and fixtures. */
export type MemorySource = BillingSource & {
  /**
   * Sets (or, with `null`, clears) an organization's state. When the source
   * is connected, also calls `changed(organizationId)` and awaits it, like a
   * provider push; rejects when that resync failed.
   */
  set(organizationId: string, state: BillingState | null): Promise<void>;
  /** Makes every `resolve` throw `error` until called again with `null`. */
  setFailure(error: unknown): void;
};

export type MemorySourceOptions = {
  /** @default "memory" */
  id?: string;
  /** States to start with, by organization id. */
  initial?: Record<string, BillingState | null>;
};

const copyDate = (value: Date | null | undefined) =>
  value instanceof Date ? new Date(value.getTime()) : value;

/** A copy that shares nothing with `state` (dates are cloned too). */
function copyState(state: BillingState): BillingState {
  const copy: BillingState = { ...state };
  if ("periodStart" in state) copy.periodStart = copyDate(state.periodStart);
  if ("periodEnd" in state) copy.periodEnd = copyDate(state.periodEnd);
  return copy;
}

/**
 * Creates a `MemorySource`. `resolve` returns a copy of the stored state
 * (never the object given to `set`), or null. `set` stores a copy and, once
 * the plugin has called `connect`, awaits the plugin's `changed` callback; a
 * rejection from it is rethrown as is, and not logged again (the callback
 * logged it).
 */
export function memorySource(options: MemorySourceOptions = {}): MemorySource {
  const states = new Map<string, BillingState | null>();
  for (const [organizationId, state] of Object.entries(options.initial ?? {})) {
    states.set(organizationId, state ? copyState(state) : null);
  }
  let failure: { error: unknown } | null = null;
  let changed: ((organizationId: string) => Promise<void>) | null = null;
  return {
    id: options.id ?? "memory",
    resolve: async (organizationId) => {
      if (failure) throw failure.error;
      const state = states.get(organizationId);
      return state ? copyState(state) : null;
    },
    connect: (_context, callback) => {
      changed = callback;
    },
    set: async (organizationId, state) => {
      states.set(organizationId, state ? copyState(state) : null);
      if (changed) await changed(organizationId);
    },
    setFailure: (error) => {
      failure = error === null || error === undefined ? null : { error };
    },
  };
}
