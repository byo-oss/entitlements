import type { DBTransactionAdapter } from "better-auth";
import { findManyIn } from "./adapter";
import { canonicalPlanKey, isFeatureKey, limitKind } from "./catalog";
import type { EntitlementsRuntime } from "./runtime";
import { decodeOverrideValue, type EntitlementOverrideRow } from "./schema";

/** Read limit of the live-override query per organization (150 keys + one plan override, rounded up). */
export const LIVE_OVERRIDE_LIMIT = 200;

/** One organization's live overrides: at most one per plan / feature key / limit key. */
export type LiveOverrideSet = {
  plan: EntitlementOverrideRow | null;
  features: Map<string, EntitlementOverrideRow>;
  limits: Map<string, EntitlementOverrideRow>;
};

const MODEL = "entitlementOverride";

/** An empty set (no live overrides). */
export function emptyOverrideSet(): LiveOverrideSet {
  return { plan: null, features: new Map(), limits: new Map() };
}

const time = (value: Date | string | number) => new Date(value).getTime();

/** Whether `a` wins over `b`: the newer `createdAt`, ties broken by the larger id. */
function newer(a: EntitlementOverrideRow, b: EntitlementOverrideRow): boolean {
  const diff = time(a.createdAt) - time(b.createdAt);
  return diff !== 0 ? diff > 0 : a.id > b.id;
}

/** Whether a row read as `active` still applies at `now`, for this catalog. */
function isLive(
  rt: EntitlementsRuntime,
  row: EntitlementOverrideRow,
  now: Date,
): boolean {
  if (
    row.permanent === false &&
    row.expiresAt !== null &&
    row.expiresAt !== undefined &&
    time(row.expiresAt) <= now.getTime()
  ) {
    return false;
  }
  if (decodeOverrideValue(row.kind, row.value) === undefined) return false;
  if (row.kind === "plan")
    return canonicalPlanKey(rt.catalog, row.key) !== null;
  if (row.kind === "feature") return isFeatureKey(rt.catalog, row.key);
  if (row.kind === "limit") return limitKind(rt.catalog, row.key) !== null;
  return false;
}

/**
 * The live overrides of each organization, keyed by organization id (every
 * id present, possibly with an empty set). Reads `organizationId` (`eq`, or
 * `in` chunks of 90 through `findManyIn`) + `status eq "active"`, limit 200
 * per organization; drops rows whose `expiresAt <= now` in code (when
 * `permanent` is false), rows whose value doesn't decode and keys no longer
 * in the catalog, before it keeps the newest `createdAt` per key (ties by
 * id) and one plan override whatever its key. No query for an empty list.
 */
export async function liveOverrides(
  rt: EntitlementsRuntime,
  adapter: DBTransactionAdapter,
  organizationIds: readonly string[],
  now: Date,
): Promise<Map<string, LiveOverrideSet>> {
  const sets = new Map<string, LiveOverrideSet>();
  for (const id of organizationIds) sets.set(id, emptyOverrideSet());
  if (sets.size === 0) return sets;
  const ids = [...sets.keys()];
  const active = { field: "status", value: "active" };
  const rows =
    ids.length === 1
      ? await adapter.findMany<EntitlementOverrideRow>({
          model: MODEL,
          where: [{ field: "organizationId", value: ids[0] as string }, active],
          limit: LIVE_OVERRIDE_LIMIT,
        })
      : await findManyIn<EntitlementOverrideRow>(adapter, {
          model: MODEL,
          field: "organizationId",
          values: ids,
          where: [active],
        });
  for (const row of rows) {
    const set = sets.get(row.organizationId);
    if (!set || row.status !== "active" || !isLive(rt, row, now)) continue;
    if (row.kind === "plan") {
      if (!set.plan || newer(row, set.plan)) set.plan = row;
      continue;
    }
    const byKey = row.kind === "feature" ? set.features : set.limits;
    const current = byKey.get(row.key);
    if (!current || newer(row, current)) byKey.set(row.key, row);
  }
  return sets;
}
