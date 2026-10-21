// BYO_STUB: N03 replaces this file (contracts.md "live-overrides.ts")
import type { DBTransactionAdapter } from "better-auth";
import type { EntitlementsRuntime } from "./runtime";
import type { EntitlementOverrideRow } from "./schema";

/** Read limit of the live-override query per organization (150 keys + one plan override, rounded up). */
export const LIVE_OVERRIDE_LIMIT = 200;

/** One organization's live overrides: at most one per plan / feature key / limit key. */
export type LiveOverrideSet = {
  plan: EntitlementOverrideRow | null;
  features: Map<string, EntitlementOverrideRow>;
  limits: Map<string, EntitlementOverrideRow>;
};

/**
 * The live overrides of each organization, keyed by organization id (every
 * id present, possibly with an empty set). Reads `organizationId` (`eq`, or
 * `in` chunks of 90 through `findManyIn`) + `status eq "active"`, limit 200
 * per organization; drops rows whose `expiresAt <= now` in code (when
 * `permanent` is false) and rows whose value doesn't decode; keeps the
 * newest `createdAt` per key (ties by id) and one plan override whatever
 * its key; ignores keys no longer in the catalog. No query for an empty list.
 * Stub: an empty set per organization.
 */
export async function liveOverrides(
  _rt: EntitlementsRuntime,
  _adapter: DBTransactionAdapter,
  organizationIds: readonly string[],
  _now: Date,
): Promise<Map<string, LiveOverrideSet>> {
  return new Map(
    organizationIds.map((id) => [
      id,
      { plan: null, features: new Map(), limits: new Map() },
    ]),
  );
}
