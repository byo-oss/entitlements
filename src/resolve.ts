// BYO_STUB: N03 replaces this file (contracts.md "resolve.ts")
import { planEntitlements } from "./catalog";
import type { EntitlementsRuntime } from "./runtime";
import type { EntitlementsResult, ResolvedState } from "./types";

/** Most organization ids `getMany` takes in one call. */
export const MAX_GET_MANY = 1000;

/**
 * Resolves one organization (Resolution steps 1–6): cache, snapshot
 * (read-through when missing or from another source), `isEntitled`,
 * aliases, plan override, `resolveEntitlements`, feature/limit overrides,
 * background refresh when stale. Never throws for an outage: answers
 * `defaultPlan` with `degraded: true` and logs. Inside a transaction it
 * reads the cache but never fills it, persists nothing and schedules no
 * refresh. `bypassCache` skips the cache read.
 *
 * Stub: `defaultPlan` with `resolveEntitlements` applied, no database.
 */
export async function resolveState(
  rt: EntitlementsRuntime,
  organizationId: string,
  _opts?: { bypassCache?: boolean },
): Promise<ResolvedState> {
  const { catalog, options } = rt;
  const plan = catalog.defaultPlan as string;
  const base = planEntitlements(catalog, plan);
  let { features, limits } = base;
  if (options.resolveEntitlements) {
    const adjusted = await options.resolveEntitlements({
      organizationId,
      plan,
      snapshot: null,
      features: { ...features },
      limits: { ...limits },
    });
    features = { ...features, ...adjusted.features } as typeof features;
    limits = { ...limits, ...adjusted.limits } as typeof limits;
  }
  const result: EntitlementsResult = {
    organizationId,
    degraded: false,
    plan: { key: plan, display: base.display, source: "default" },
    status: null,
    periodEnd: null,
    cancelAtPeriodEnd: false,
    features,
    limits,
    overrides: [],
  };
  return { result, snapshot: null, entitled: false };
}

/** `resolveState(...).result`: what `get` returns. */
export async function resolveEntitlements(
  rt: EntitlementsRuntime,
  organizationId: string,
): Promise<EntitlementsResult> {
  return (await resolveState(rt, organizationId)).result;
}

/**
 * `getMany`: one result per id, in the order given (duplicates answered
 * once each). Snapshots and overrides are read with the `in` rules
 * (`findManyIn`). An empty list returns `[]` with no query; more than
 * `MAX_GET_MANY` ids throws
 * `[@byo-oss/entitlements] getMany takes at most 1000 organization ids`.
 * Degraded per organization on failure, like `resolveState`.
 *
 * Stub: `resolveState` per id.
 */
export async function resolveMany(
  rt: EntitlementsRuntime,
  organizationIds: readonly string[],
): Promise<EntitlementsResult[]> {
  return Promise.all(organizationIds.map((id) => resolveEntitlements(rt, id)));
}

/**
 * `sync`, `refreshEntitlements` and a source's `changed`: calls
 * `source.resolve` now, writes the snapshot (`writeSnapshot`), clears the
 * cache entry and returns fresh state (cache bypassed). Throws when the
 * source or the database throws (nothing persisted), and
 * `[@byo-oss/entitlements] sync must run outside a transaction` inside one.
 * Without a source it writes nothing and resolves fresh.
 *
 * Stub: `resolveState`.
 */
export async function syncOrganization(
  rt: EntitlementsRuntime,
  organizationId: string,
): Promise<ResolvedState> {
  return resolveState(rt, organizationId, { bypassCache: true });
}
