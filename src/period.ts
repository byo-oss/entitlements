import type { MeteredPeriod } from "./catalog";
import type { ResolvedState } from "./types";

/** A counter period: `start <= now < end`. */
export type UsagePeriod = { start: Date; end: Date };

const DAY_MS = 24 * 60 * 60 * 1000;

/** The UTC calendar day of `now`. */
function utcDay(now: Date): UsagePeriod {
  const start = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  return { start, end: new Date(start.getTime() + DAY_MS) };
}

/** The UTC calendar month of `now`. */
function utcMonth(now: Date): UsagePeriod {
  return {
    start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
    end: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)),
  };
}

const toDate = (value: Date | string | null | undefined): Date | null =>
  value === null || value === undefined ? null : new Date(value);

/**
 * The current period of a metered key:
 * - `day`: the UTC calendar day; `month`: the UTC calendar month;
 * - `billing`: the snapshot's `periodStart`..`periodEnd` while
 *   `state.entitled` and `periodStart <= now < periodEnd`, else the UTC
 *   month (so an ended subscription doesn't keep counting into an old
 *   bucket).
 */
export function periodFor(
  period: MeteredPeriod,
  state: Pick<ResolvedState, "snapshot" | "entitled">,
  now: Date,
): UsagePeriod {
  if (period === "day") return utcDay(now);
  if (period === "billing" && state.entitled && state.snapshot) {
    const start = toDate(state.snapshot.periodStart);
    const end = toDate(state.snapshot.periodEnd);
    if (
      start !== null &&
      end !== null &&
      start.getTime() <= now.getTime() &&
      now.getTime() < end.getTime()
    ) {
      return { start, end };
    }
  }
  return utcMonth(now);
}

/** `${organizationId}:${key}:${periodStart ISO}`: the unique `entitlementUsage.bucket`. */
export function bucketKey(
  organizationId: string,
  key: string,
  periodStart: Date,
): string {
  return `${organizationId}:${key}:${periodStart.toISOString()}`;
}
