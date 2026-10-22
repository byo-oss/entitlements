import type { DBTransactionAdapter } from "better-auth";
import { canonicalPlanKey, type PlanKey } from "./catalog";
import { emit, entitlementsEvent } from "./events";
import { type EntitlementsRuntime, singleFlight, warnOnce } from "./runtime";
import type { EntitlementSnapshotRow } from "./schema";
import type { BillingState } from "./types";

const MODEL = "entitlementSnapshot";
const DAY_MS = 86_400_000;

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

const toDate = (value: Date | string | number | null | undefined) =>
  value === null || value === undefined ? null : new Date(value);

/**
 * The default `isEntitled`: `active` and `trialing`, and `past_due` while
 * `pastDueSince` is set and `now < pastDueSince + graceDays`. Every other
 * status (and none) is false.
 */
export function isDefaultEntitled(
  snapshot: EntitlementSnapshotRow,
  now: Date,
  graceDays: number,
): boolean {
  const { status } = snapshot;
  if (status === "active" || status === "trialing") return true;
  if (status !== "past_due") return false;
  const since = toDate(snapshot.pastDueSince);
  if (!since || Number.isNaN(since.getTime())) return false;
  return now.getTime() < since.getTime() + graceDays * DAY_MS;
}

/**
 * The one normalizer every snapshot write goes through. Sets `source` and
 * every state field explicitly: `null` state → `planKey`, `status`,
 * `periodStart`, `periodEnd`, `seats`, `sourceRef` null and
 * `cancelAtPeriodEnd: false`; a missing optional field → null; `planKey`
 * lowercased. `pastDueSince` is kept from `previous` while the status stays
 * `past_due`, set to `now` when it becomes `past_due`, null otherwise.
 */
export function toSnapshotFields(
  state: BillingState | null,
  opts: { source: string; previous: EntitlementSnapshotRow | null; now: Date },
): SnapshotStateFields {
  const status = state?.status ?? null;
  const { previous, now } = opts;
  let pastDueSince: Date | null = null;
  if (status === "past_due") {
    const kept =
      previous?.status === "past_due" ? toDate(previous.pastDueSince) : null;
    pastDueSince = kept ?? now;
  }
  return {
    source: opts.source,
    planKey:
      typeof state?.planKey === "string" ? state.planKey.toLowerCase() : null,
    status,
    periodStart: toDate(state?.periodStart),
    periodEnd: toDate(state?.periodEnd),
    cancelAtPeriodEnd: state?.cancelAtPeriodEnd === true,
    seats: state?.seats ?? null,
    pastDueSince,
    sourceRef: state?.sourceRef ?? null,
  };
}

/** The organization's snapshot row, or null. */
export async function readSnapshot(
  _rt: EntitlementsRuntime,
  adapter: DBTransactionAdapter,
  organizationId: string,
): Promise<EntitlementSnapshotRow | null> {
  return adapter.findOne<EntitlementSnapshotRow>({
    model: MODEL,
    where: [{ field: "organizationId", value: organizationId }],
  });
}

/**
 * The plan a snapshot alone resolves to (no overrides, no hook): its
 * `planKey` through `planAliases` when `isEntitled` holds and the key is in
 * the catalog, else `defaultPlan`. An unknown key warns once per process.
 * Throws what a custom `isEntitled` throws.
 */
export function snapshotPlan(
  rt: EntitlementsRuntime,
  snapshot: EntitlementSnapshotRow | null,
  now: Date,
): { plan: PlanKey<typeof rt.catalog>; entitled: boolean; billed: boolean } {
  const fallback = rt.catalog.defaultPlan as string;
  const entitled = snapshot !== null && rt.options.isEntitled(snapshot, now);
  if (!entitled || !snapshot.planKey) {
    return { plan: fallback, entitled, billed: false };
  }
  const plan = canonicalPlanKey(rt.catalog, snapshot.planKey);
  if (plan === null) {
    warnOnce(
      rt,
      `plan:${snapshot.planKey}`,
      `the billing source reported plan "${snapshot.planKey}", which isn't a plan or alias of the catalog; answering defaultPlan "${fallback}"`,
    );
    return { plan: fallback, entitled, billed: false };
  }
  return { plan, entitled, billed: true };
}

/** The sync bookkeeping a successful state write sets. */
function syncFields(rt: EntitlementsRuntime, now: Date) {
  return {
    syncedAt: now,
    nextSyncAt: new Date(now.getTime() + rt.options.maxAge),
    syncState: "idle" as const,
    syncAttempts: 0,
    syncError: null,
    syncClaimedAt: null,
    updatedAt: now,
  };
}

/**
 * A snapshot write and the organization's cache generation taken right
 * after the write's own cache clear, before `plan.changed` is emitted
 * (`generation` is null when nothing was written).
 */
export type TrackedSnapshotWrite = {
  row: EntitlementSnapshotRow | null;
  generation: number | null;
};

/** The version-guarded in-place write of `writeSnapshot`. */
async function updateSnapshot(
  rt: EntitlementsRuntime,
  organizationId: string,
  state: BillingState | null,
  previous: EntitlementSnapshotRow,
  adapter: DBTransactionAdapter,
): Promise<TrackedSnapshotWrite> {
  const now = rt.now();
  const row = await adapter.incrementOne<EntitlementSnapshotRow>({
    model: MODEL,
    where: [
      { field: "id", value: previous.id },
      { field: "version", value: previous.version },
    ],
    increment: { version: 1 },
    set: {
      ...toSnapshotFields(state, {
        source: rt.options.sourceId,
        previous,
        now,
      }),
      ...syncFields(rt, now),
    },
  });
  rt.cache.delete(organizationId);
  if (!row) return { row: null, generation: null };
  const generation = rt.cache.generation(organizationId);
  await notifyPlanChange(rt, organizationId, previous, row);
  return { row, generation };
}

/**
 * Writes a resolved state for an organization (read-through, push, `sync`,
 * the sweep).
 * - Creates the row when `previous` is null, through `singleFlight` keyed by
 *   organization (`snapshot:<id>`). A row another writer created after the
 *   caller's read is never overwritten: the flight re-reads first and
 *   returns null when the row exists; on a create error it re-reads and
 *   rethrows only if the row is still missing (else null); a caller that
 *   joined another caller's flight gets null too (the row holds that
 *   caller's state, not its own). Callers re-read (read-through) or retry
 *   read→resolve→write (`syncOrganization`).
 * - Otherwise updates in place, guarded on `previous.version`, incrementing
 *   `version`; also when `previous.source` differs from the configured one.
 * - Sets `syncedAt = now`, `nextSyncAt = now + maxAge`, `syncState: "idle"`,
 *   `syncAttempts: 0`, `syncError: null`, `syncClaimedAt: null`.
 * - Clears this process's cache entry, and emits `entitlements.plan.changed`
 *   (through `notifyPlanChange`) when the resolved plan key changed.
 * Returns the row as stored, or null when nothing was written (the version
 * guard lost to a newer write or a sweep's claim, or the create found a row
 * someone else wrote). Callers outside a transaction only.
 */
export async function writeSnapshot(
  rt: EntitlementsRuntime,
  organizationId: string,
  state: BillingState | null,
  opts: {
    previous: EntitlementSnapshotRow | null;
    adapter: DBTransactionAdapter;
  },
): Promise<EntitlementSnapshotRow | null> {
  return (await writeSnapshotTracked(rt, organizationId, state, opts)).row;
}

/**
 * `writeSnapshot`, also answering the organization's cache generation taken
 * synchronously after the write's own cache clear and before its
 * `plan.changed` event (null when nothing was written). A read-through
 * caches against it: a write that lands while the event handler runs
 * moves it on, so the read-through's (then older) state isn't cached.
 */
export async function writeSnapshotTracked(
  rt: EntitlementsRuntime,
  organizationId: string,
  state: BillingState | null,
  opts: {
    previous: EntitlementSnapshotRow | null;
    adapter: DBTransactionAdapter;
  },
): Promise<TrackedSnapshotWrite> {
  const { previous, adapter } = opts;
  if (previous) {
    return updateSnapshot(rt, organizationId, state, previous, adapter);
  }
  let mine = false;
  const created = await singleFlight(rt, `snapshot:${organizationId}`, () => {
    mine = true;
    return createSnapshot(rt, organizationId, state, adapter);
  });
  return mine ? created : { row: null, generation: null };
}

/** The create flight of `writeSnapshot`: no row when a row already exists. */
async function createSnapshot(
  rt: EntitlementsRuntime,
  organizationId: string,
  state: BillingState | null,
  adapter: DBTransactionAdapter,
): Promise<TrackedSnapshotWrite> {
  const none = { row: null, generation: null };
  // written by another caller after this one's read: its state may be
  // newer than this one, so it stays
  if (await readSnapshot(rt, adapter, organizationId)) return none;
  const now = rt.now();
  let row: EntitlementSnapshotRow;
  try {
    row = await adapter.create<
      Omit<EntitlementSnapshotRow, "id">,
      EntitlementSnapshotRow
    >({
      model: MODEL,
      data: {
        organizationId,
        ...toSnapshotFields(state, {
          source: rt.options.sourceId,
          previous: null,
          now,
        }),
        version: 0,
        ...syncFields(rt, now),
        createdAt: now,
      },
    });
  } catch (error) {
    // another process won the unique organizationId: its row stays
    if (await readSnapshot(rt, adapter, organizationId)) return none;
    throw error;
  }
  rt.cache.delete(organizationId);
  const generation = rt.cache.generation(organizationId);
  await notifyPlanChange(rt, organizationId, null, row);
  return { row, generation };
}

/**
 * Emits `entitlements.plan.changed` when the plan a snapshot resolves to
 * (`isEntitled` + aliases + `defaultPlan`; overrides not included) differs
 * between `before` and `after`. A missing `before`, or one written by
 * another source (which resolution treats as missing), resolves to
 * `defaultPlan`. Shared by `writeSnapshot` and the sweep (N07). Never
 * throws: a throwing `isEntitled` is logged and nothing is emitted.
 */
export async function notifyPlanChange(
  rt: EntitlementsRuntime,
  organizationId: string,
  before: EntitlementSnapshotRow | null,
  after: EntitlementSnapshotRow,
): Promise<void> {
  const now = rt.now();
  let from: string;
  let to: string;
  try {
    from = snapshotPlan(
      rt,
      before && before.source === after.source ? before : null,
      now,
    ).plan;
    to = snapshotPlan(rt, after, now).plan;
  } catch (error) {
    rt.logger.error(
      `[@byo-oss/entitlements] isEntitled threw while checking organization ${organizationId} for a plan change; no plan.changed event`,
      error,
    );
    return;
  }
  if (from === to) return;
  await emit(
    rt,
    entitlementsEvent("entitlements.plan.changed", {
      organizationId,
      actorId: null,
      data: { from, to, status: after.status ?? null },
      occurredAt: now,
    }),
  );
}
