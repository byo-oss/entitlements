// BYO_STUB: N03 replaces this file (contracts.md "snapshot.ts")
import type { DBTransactionAdapter } from "better-auth";
import type { EntitlementsRuntime } from "./runtime";
import type { EntitlementSnapshotRow } from "./schema";
import type { BillingState } from "./types";

/** The snapshot columns a state write sets, every one explicitly. */
export type SnapshotStateFields = Pick<
  EntitlementSnapshotRow,
  | "source"
  | "planKey"
  | "status"
  | "periodStart"
  | "periodEnd"
  | "cancelAtPeriodEnd"
  | "seats"
  | "pastDueSince"
  | "sourceRef"
>;

/**
 * The default `isEntitled`: `active` and `trialing`, and `past_due` while
 * `pastDueSince` is set and `now < pastDueSince + graceDays`.
 * Stub: always false.
 */
export function isDefaultEntitled(
  _snapshot: EntitlementSnapshotRow,
  _now: Date,
  _graceDays: number,
): boolean {
  return false;
}

/**
 * The one normalizer every snapshot write goes through. Sets `source` and
 * every state field explicitly: `null` state → `planKey`, `status`,
 * `periodStart`, `periodEnd`, `seats`, `sourceRef` null and
 * `cancelAtPeriodEnd: false`; a missing optional field → null; `planKey`
 * lowercased. `pastDueSince` is kept from `previous` while the status stays
 * `past_due`, set to `now` when it becomes `past_due`, null otherwise.
 * Stub: the `null` state.
 */
export function toSnapshotFields(
  _state: BillingState | null,
  opts: { source: string; previous: EntitlementSnapshotRow | null; now: Date },
): SnapshotStateFields {
  return {
    source: opts.source,
    planKey: null,
    status: null,
    periodStart: null,
    periodEnd: null,
    cancelAtPeriodEnd: false,
    seats: null,
    pastDueSince: null,
    sourceRef: null,
  };
}

/** The organization's snapshot row, or null. Stub: null. */
export async function readSnapshot(
  _rt: EntitlementsRuntime,
  _adapter: DBTransactionAdapter,
  _organizationId: string,
): Promise<EntitlementSnapshotRow | null> {
  return null;
}

/**
 * Writes a resolved state for an organization (read-through, push, `sync`).
 * - Creates the row when `previous` is null, through `singleFlight` keyed by
 *   organization; on a create error re-reads and rethrows only if the row
 *   is still missing.
 * - Otherwise updates in place, guarded on `previous.version`, incrementing
 *   `version`; also when `previous.source` differs from the configured one.
 * - Sets `syncedAt = now`, `nextSyncAt = now + maxAge`, `syncState: "idle"`,
 *   `syncAttempts: 0`, `syncError: null`.
 * - Clears this process's cache entry, and emits `entitlements.plan.changed`
 *   (through `notifyPlanChange`) when the resolved plan key changed.
 * Returns the row as stored, or null when nothing was written (the version
 * guard lost to a newer write). Callers outside a transaction only.
 * Stub: writes nothing, returns null.
 */
export async function writeSnapshot(
  _rt: EntitlementsRuntime,
  _organizationId: string,
  _state: BillingState | null,
  _opts: {
    previous: EntitlementSnapshotRow | null;
    adapter: DBTransactionAdapter;
  },
): Promise<EntitlementSnapshotRow | null> {
  return null;
}

/**
 * Emits `entitlements.plan.changed` when the plan a snapshot resolves to
 * (`isEntitled` + aliases + `defaultPlan`; overrides not included) differs
 * between `before` and `after`. A missing `before` resolves to
 * `defaultPlan`. Shared by `writeSnapshot` and the sweep (N07).
 * Stub: emits nothing.
 */
export async function notifyPlanChange(
  _rt: EntitlementsRuntime,
  _organizationId: string,
  _before: EntitlementSnapshotRow | null,
  _after: EntitlementSnapshotRow,
): Promise<void> {}
