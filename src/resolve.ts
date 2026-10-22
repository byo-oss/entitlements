import type { DBTransactionAdapter } from "better-auth";
import { findManyIn, findOrganization } from "./adapter";
import {
  canonicalPlanKey,
  isLimitValue,
  type LimitValue,
  planEntitlements,
} from "./catalog";
import {
  emptyOverrideSet,
  type LiveOverrideSet,
  liveOverrides,
} from "./live-overrides";
import {
  type EntitlementsRuntime,
  requireContext,
  singleFlight,
} from "./runtime";
import { decodeOverrideValue, type EntitlementSnapshotRow } from "./schema";
import {
  readSnapshot,
  snapshotPlan,
  toSnapshotFields,
  writeSnapshot,
} from "./snapshot";
import { assertOutsideTransaction, currentAdapter, inTransaction } from "./txn";
import type {
  AppliedOverride,
  BillingState,
  EntitlementsResult,
  PlanSource,
  ResolvedState,
} from "./types";

const PREFIX = "[@byo-oss/entitlements]";
const SNAPSHOT = "entitlementSnapshot";

/** Most organization ids `getMany` takes in one call. */
export const MAX_GET_MANY = 1000;

const toDate = (value: Date | string | number | null | undefined) =>
  value === null || value === undefined ? null : new Date(value);

const time = (value: Date | string | number) => new Date(value).getTime();

type Failure = { error: unknown };

/** What the load phase read for one organization. */
type Loaded = {
  /** The snapshot to resolve from (null: none, no source, or unknown organization). */
  snapshot: EntitlementSnapshotRow | null;
  /** The live overrides, or null when their read failed. */
  overrides: LiveOverrideSet | null;
  /** The first failure of the load phase. */
  failure: Failure | null;
  /** Whether `failure` was already logged (a batch read in `resolveMany`). */
  logged: boolean;
};

// ---------------------------------------------------------------------------
// Compute: snapshot → isEntitled → plan override → hook → overrides
// ---------------------------------------------------------------------------

/**
 * Resolution steps 2–5 over what was loaded. Any failure (of the load, of
 * `isEntitled` or of the `resolveEntitlements` hook) answers `defaultPlan`
 * with `degraded: true` and `error` set; the hook and the feature/limit
 * overrides still apply when they work (a throwing hook is not called
 * again). Logs the failure once, unless the batch read already logged it.
 */
async function compute(
  rt: EntitlementsRuntime,
  organizationId: string,
  loaded: Loaded,
  now: Date,
): Promise<ResolvedState> {
  const { catalog } = rt;
  const defaultPlan = catalog.defaultPlan as string;
  let failure = loaded.failure;
  let snapshot = failure ? null : loaded.snapshot;
  let plan = defaultPlan;
  let source: PlanSource = "default";
  let entitled = false;
  if (!failure) {
    try {
      const resolved = snapshotPlan(rt, snapshot, now);
      plan = resolved.plan;
      entitled = resolved.entitled;
      source = resolved.billed ? "billing" : "default";
    } catch (error) {
      failure = { error };
    }
  }
  const { overrides } = loaded;
  let planOverride: AppliedOverride | null = null;
  if (!failure && overrides?.plan) {
    const key = canonicalPlanKey(catalog, overrides.plan.key);
    if (key !== null) {
      plan = key;
      source = "override";
      planOverride = {
        kind: "plan",
        key: overrides.plan.key,
        expiresAt: toDate(overrides.plan.expiresAt),
      };
    }
  }
  const toDefault = () => {
    plan = defaultPlan;
    source = "default";
    snapshot = null;
    entitled = false;
    planOverride = null;
  };
  if (failure) toDefault();

  let base = planEntitlements(catalog, plan);
  let { features, limits } = base;
  const hook = rt.options.resolveEntitlements;
  if (hook) {
    try {
      const adjusted = await hook({
        organizationId,
        plan,
        snapshot,
        features: { ...features },
        limits: { ...limits },
      });
      const nextFeatures = { ...features };
      for (const [key, value] of Object.entries(adjusted?.features ?? {})) {
        if (key in nextFeatures && typeof value === "boolean") {
          nextFeatures[key] = value;
        }
      }
      const nextLimits = { ...limits };
      for (const [key, value] of Object.entries(adjusted?.limits ?? {})) {
        if (key in nextLimits && isLimitValue(value)) nextLimits[key] = value;
      }
      features = nextFeatures;
      limits = nextLimits;
    } catch (error) {
      failure ??= { error };
      toDefault();
      base = planEntitlements(catalog, plan);
      features = base.features;
      limits = base.limits;
    }
  }

  const applied: AppliedOverride[] = planOverride ? [planOverride] : [];
  if (overrides) {
    for (const [key, row] of overrides.features) {
      const value = decodeOverrideValue("feature", row.value);
      if (typeof value !== "boolean" || !(key in features)) continue;
      features[key] = value;
      applied.push({ kind: "feature", key, expiresAt: toDate(row.expiresAt) });
    }
    for (const [key, row] of overrides.limits) {
      const value = decodeOverrideValue("limit", row.value);
      if (!isLimitValue(value) || !(key in limits)) continue;
      limits[key] = value as LimitValue;
      applied.push({ kind: "limit", key, expiresAt: toDate(row.expiresAt) });
    }
  }

  if (failure && !(loaded.logged && failure === loaded.failure)) {
    rt.logger.error(
      `${PREFIX} resolving organization ${organizationId} failed; answering defaultPlan (degraded)`,
      failure.error,
    );
  }
  const result: EntitlementsResult = {
    organizationId,
    degraded: failure !== null,
    plan: { key: plan, display: base.display, source },
    status: snapshot?.status ?? null,
    periodEnd: toDate(snapshot?.periodEnd),
    cancelAtPeriodEnd: snapshot?.cancelAtPeriodEnd === true,
    features,
    limits,
    overrides: applied,
  };
  return failure
    ? { result, snapshot: null, entitled: false, error: failure.error }
    : { result, snapshot, entitled };
}

// ---------------------------------------------------------------------------
// Load: snapshot, read-through, stale refresh
// ---------------------------------------------------------------------------

/** A snapshot row built in memory from a resolved state (read-through inside a transaction persists nothing). */
function virtualSnapshot(
  rt: EntitlementsRuntime,
  organizationId: string,
  state: BillingState | null,
  previous: EntitlementSnapshotRow | null,
  now: Date,
): EntitlementSnapshotRow {
  return {
    id: previous?.id ?? "",
    organizationId,
    ...toSnapshotFields(state, { source: rt.options.sourceId, previous, now }),
    version: previous?.version ?? 0,
    syncedAt: now,
    nextSyncAt: new Date(now.getTime() + rt.options.maxAge),
    syncState: "idle",
    syncClaimedAt: null,
    syncAttempts: 0,
    syncError: null,
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
  };
}

type SnapshotLoad = {
  snapshot: EntitlementSnapshotRow | null;
  /** False when the organization doesn't exist (answer defaultPlan, cache nothing). */
  known: boolean;
};

/**
 * Read-through outside a transaction, run once per organization at a time
 * (`readthrough:<id>`): re-read (another caller may have written it), check
 * the organization exists when the row is missing, `source.resolve`, then
 * `writeSnapshot`. A lost version guard re-reads the newer row.
 */
async function readThrough(
  rt: EntitlementsRuntime,
  adapter: DBTransactionAdapter,
  organizationId: string,
): Promise<SnapshotLoad> {
  const source = rt.options.source;
  const current = await readSnapshot(rt, adapter, organizationId);
  if (!source || (current && current.source === rt.options.sourceId)) {
    return { snapshot: current, known: true };
  }
  if (!current && !(await findOrganization(adapter, organizationId))) {
    return { snapshot: null, known: false };
  }
  const state = await source.resolve(organizationId, { adapter });
  const written = await writeSnapshot(rt, organizationId, state, {
    previous: current,
    adapter,
  });
  return {
    snapshot: written ?? (await readSnapshot(rt, adapter, organizationId)),
    known: true,
  };
}

/** Step 1: the snapshot to resolve from, reading through when it is missing or from another source. */
async function loadSnapshot(
  rt: EntitlementsRuntime,
  adapter: DBTransactionAdapter,
  organizationId: string,
  inTx: boolean,
  now: Date,
): Promise<SnapshotLoad> {
  const source = rt.options.source;
  // without a source every organization is on defaultPlan: snapshots are ignored
  if (!source) return { snapshot: null, known: true };
  const snapshot = await readSnapshot(rt, adapter, organizationId);
  if (snapshot && snapshot.source === rt.options.sourceId) {
    return { snapshot, known: true };
  }
  if (!inTx) {
    return singleFlight(rt, `readthrough:${organizationId}`, () =>
      readThrough(rt, adapter, organizationId),
    );
  }
  // inside a transaction: resolve through it, persist nothing
  if (!snapshot && !(await findOrganization(adapter, organizationId))) {
    return { snapshot: null, known: false };
  }
  const state = await source.resolve(organizationId, { adapter });
  return {
    snapshot: virtualSnapshot(rt, organizationId, state, snapshot, now),
    known: true,
  };
}

/**
 * Step 6, outside a transaction only: a snapshot whose `syncedAt` is older
 * than `maxAge` is served and refreshed. With a background-task handler
 * configured (`advanced.backgroundTasks.handler`), the refresh
 * (`syncOrganization`) goes to `context.runInBackground` once per
 * organization at a time; otherwise the row is marked due for the sweep
 * (`nextSyncAt = now`, guarded on its version, which it doesn't change).
 */
async function refreshIfStale(
  rt: EntitlementsRuntime,
  adapter: DBTransactionAdapter,
  snapshot: EntitlementSnapshotRow,
  now: Date,
): Promise<void> {
  if (!rt.options.source) return;
  if (time(snapshot.syncedAt) >= now.getTime() - rt.options.maxAge) return;
  const { organizationId } = snapshot;
  const context = requireContext(rt);
  if (context.options.advanced?.backgroundTasks?.handler) {
    const key = `refresh:${organizationId}`;
    if (rt.flights.has(key)) return;
    const task = singleFlight(rt, key, async () => {
      await syncOrganization(rt, organizationId);
    }).catch((error: unknown) => {
      rt.logger.error(
        `${PREFIX} background refresh failed for organization ${organizationId}`,
        error,
      );
    });
    context.runInBackground(task);
    return;
  }
  if (
    snapshot.syncState === "syncing" ||
    time(snapshot.nextSyncAt) <= now.getTime()
  ) {
    return;
  }
  try {
    await adapter.update({
      model: SNAPSHOT,
      where: [
        { field: "id", value: snapshot.id },
        { field: "version", value: snapshot.version },
      ],
      update: { nextSyncAt: now, updatedAt: now },
    });
  } catch (error) {
    rt.logger.warn(
      `${PREFIX} marking the stale snapshot of organization ${organizationId} due failed; the sweep picks it up at its nextSyncAt`,
      error,
    );
  }
}

/** Caches a state and handles staleness, outside a transaction only. */
async function settle(
  rt: EntitlementsRuntime,
  adapter: DBTransactionAdapter | null,
  state: ResolvedState,
  cacheable: boolean,
  now: Date,
): Promise<void> {
  if (state.result.degraded || !adapter) return;
  if (state.snapshot) await refreshIfStale(rt, adapter, state.snapshot, now);
  if (cacheable) rt.cache.set(state.result.organizationId, state);
}

// ---------------------------------------------------------------------------
// Public
// ---------------------------------------------------------------------------

/**
 * Resolves one organization (Resolution steps 1–6): cache, snapshot
 * (read-through when missing or from another source), `isEntitled`,
 * aliases, plan override, `resolveEntitlements`, feature/limit overrides,
 * background refresh when stale. `bypassCache` skips the cache read.
 *
 * Read-through for a missing snapshot first runs one `findOne` on
 * `organization` (`findOrganization`): an unknown organization id answers
 * `defaultPlan` (not degraded), persists nothing and isn't cached. Inside a
 * transaction it reads the cache but never fills it, persists nothing and
 * schedules no refresh.
 *
 * Never throws for an outage: when the database, the source or the
 * `resolveEntitlements` hook throws, it answers `defaultPlan` with
 * `result.degraded: true` and `error` set to what was thrown, logs it once
 * (`rt.logger.error`) and caches nothing. Checks that get a degraded state
 * answer `onError(state.error, …)` and don't log again.
 */
export async function resolveState(
  rt: EntitlementsRuntime,
  organizationId: string,
  opts: { bypassCache?: boolean } = {},
): Promise<ResolvedState> {
  if (!opts.bypassCache) {
    const hit = rt.cache.get(organizationId);
    if (hit) return hit;
  }
  const now = rt.now();
  let adapter: DBTransactionAdapter | null = null;
  let inTx = true;
  let failure: Failure | null = null;
  let load: SnapshotLoad = { snapshot: null, known: true };
  try {
    adapter = await currentAdapter(rt);
    inTx = await inTransaction(rt);
    load = await loadSnapshot(rt, adapter, organizationId, inTx, now);
  } catch (error) {
    failure = { error };
  }
  let overrides: LiveOverrideSet | null = null;
  if (adapter) {
    try {
      overrides =
        (await liveOverrides(rt, adapter, [organizationId], now)).get(
          organizationId,
        ) ?? emptyOverrideSet();
    } catch (error) {
      failure ??= { error };
    }
  }
  const state = await compute(
    rt,
    organizationId,
    { snapshot: load.snapshot, overrides, failure, logged: false },
    now,
  );
  if (!inTx) await settle(rt, adapter, state, load.known, now);
  return state;
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
 * once each). Cache hits are used; the rest have their snapshots and
 * overrides read with the `in` rules (`findManyIn`); an organization whose
 * snapshot is missing or from another source goes through `resolveState`
 * (read-through). An empty list returns `[]` with no query; more than
 * `MAX_GET_MANY` ids throws
 * `[@byo-oss/entitlements] getMany takes at most 1000 organization ids`.
 * A failed batch read degrades every organization it covered and logs once;
 * other failures degrade only their organization.
 */
export async function resolveMany(
  rt: EntitlementsRuntime,
  organizationIds: readonly string[],
): Promise<EntitlementsResult[]> {
  if (organizationIds.length > MAX_GET_MANY) {
    throw new Error(
      `${PREFIX} getMany takes at most ${MAX_GET_MANY} organization ids`,
    );
  }
  if (organizationIds.length === 0) return [];
  const states = new Map<string, ResolvedState>();
  const misses: string[] = [];
  for (const id of new Set(organizationIds)) {
    const hit = rt.cache.get(id);
    if (hit) states.set(id, hit);
    else misses.push(id);
  }
  if (misses.length > 0) {
    const now = rt.now();
    let adapter: DBTransactionAdapter | null = null;
    let inTx = true;
    let failure: Failure | null = null;
    const snapshots = new Map<string, EntitlementSnapshotRow>();
    try {
      adapter = await currentAdapter(rt);
      inTx = await inTransaction(rt);
      if (rt.options.source) {
        const rows = await findManyIn<EntitlementSnapshotRow>(adapter, {
          model: SNAPSHOT,
          field: "organizationId",
          values: misses,
        });
        for (const row of rows) snapshots.set(row.organizationId, row);
      }
    } catch (error) {
      failure = { error };
    }
    let overrideSets: Map<string, LiveOverrideSet> | null = null;
    if (adapter) {
      try {
        overrideSets = await liveOverrides(rt, adapter, misses, now);
      } catch (error) {
        failure ??= { error };
      }
    }
    if (failure) {
      rt.logger.error(
        `${PREFIX} resolving ${misses.length} organizations failed; answering defaultPlan (degraded)`,
        failure.error,
      );
    }
    await Promise.all(
      misses.map(async (id) => {
        const snapshot = snapshots.get(id) ?? null;
        if (
          !failure &&
          rt.options.source &&
          (!snapshot || snapshot.source !== rt.options.sourceId)
        ) {
          states.set(id, await resolveState(rt, id, { bypassCache: true }));
          return;
        }
        const state = await compute(
          rt,
          id,
          {
            snapshot,
            overrides: overrideSets?.get(id) ?? null,
            failure,
            logged: true,
          },
          now,
        );
        if (!inTx) await settle(rt, adapter, state, true, now);
        states.set(id, state);
      }),
    );
  }
  return organizationIds.map((id) => (states.get(id) as ResolvedState).result);
}

/**
 * `sync`, `refreshEntitlements` and a source's `changed`: calls
 * `source.resolve` now, writes the snapshot (`writeSnapshot`), clears the
 * cache entry and returns fresh state (cache bypassed; that fresh state can
 * itself come back degraded). Throws when the source or the database throws
 * (nothing persisted), `[@byo-oss/entitlements] syncOrganization:
 * organization <id> not found` for an id that isn't an organization (nothing
 * written), and `[@byo-oss/entitlements] sync must run outside a
 * transaction` inside one. It doesn't log a failure: its caller does, once
 * (`sync` logs and rethrows, `refreshEntitlements` logs and answers 503,
 * the `changed` callback logs and rethrows to the source). Without a source
 * it writes nothing and resolves fresh.
 */
export async function syncOrganization(
  rt: EntitlementsRuntime,
  organizationId: string,
): Promise<ResolvedState> {
  await assertOutsideTransaction(rt, "sync");
  const adapter = await currentAdapter(rt);
  if (!(await findOrganization(adapter, organizationId))) {
    throw new Error(
      `${PREFIX} syncOrganization: organization ${organizationId} not found`,
    );
  }
  const source = rt.options.source;
  if (source) {
    const previous = await readSnapshot(rt, adapter, organizationId);
    const state = await source.resolve(organizationId, { adapter });
    await writeSnapshot(rt, organizationId, state, { previous, adapter });
  }
  rt.cache.delete(organizationId);
  return resolveState(rt, organizationId, { bypassCache: true });
}
