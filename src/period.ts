// BYO_STUB: N04 replaces this file (contracts.md "period.ts")
import type { MeteredPeriod } from "./catalog";
import type { ResolvedState } from "./types";

/** A counter period: `start <= now < end`. */
export type UsagePeriod = { start: Date; end: Date };

/**
 * The current period of a metered key:
 * - `day`: the UTC calendar day; `month`: the UTC calendar month;
 * - `billing`: the snapshot's `periodStart`..`periodEnd` while
 *   `state.entitled` and `periodStart <= now < periodEnd`, else the UTC
 *   month.
 * Stub: the UTC day.
 */
export function periodFor(
  _period: MeteredPeriod,
  _state: Pick<ResolvedState, "snapshot" | "entitled">,
  now: Date,
): UsagePeriod {
  const start = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  return { start, end: new Date(start.getTime() + 24 * 60 * 60 * 1000) };
}

/** `${organizationId}:${key}:${periodStart ISO}`: the unique `entitlementUsage.bucket`. */
export function bucketKey(
  organizationId: string,
  key: string,
  periodStart: Date,
): string {
  return `${organizationId}:${key}:${periodStart.toISOString()}`;
}
