// BYO_STUB: N09 replaces this file (contracts.md "testing/memory-source.ts")
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

/**
 * Creates a `MemorySource`. `resolve` returns a copy of the stored state
 * (never the object given to `set`), or null.
 * Stub: `resolve` always returns null; `set` stores nothing.
 */
export function memorySource(options: MemorySourceOptions = {}): MemorySource {
  return {
    id: options.id ?? "memory",
    resolve: async () => null,
    set: async () => {},
    setFailure: () => {},
  };
}
