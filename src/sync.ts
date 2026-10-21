// BYO_STUB: N07 replaces this file (contracts.md "sync.ts")
import type { EntitlementsRuntime } from "./runtime";
import type { EntitlementsSweepResult } from "./types";

/**
 * One sweep batch (PRD Background work): release stale claims; claim up to
 * `batchSize` due idle snapshots with a guarded `incrementOne`; resolve and
 * write version-guarded through `toSnapshotFields` (emitting
 * `plan.changed` through `notifyPlanChange`), then clear that
 * organization's cache entry (`rt.cache.delete`); back off or count `failed`;
 * mark expired overrides; prune usage and ended overrides past retention.
 * Steps 1–4 are skipped without a source. Must run outside a transaction.
 * Stub: does nothing.
 */
export async function runSync(
  _rt: EntitlementsRuntime,
): Promise<EntitlementsSweepResult> {
  return {
    synced: 0,
    skipped: 0,
    retrying: 0,
    failed: 0,
    expired: 0,
    pruned: 0,
    hasMore: false,
  };
}
