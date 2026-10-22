import type { DBTransactionAdapter, Where } from "better-auth";
import { chunk } from "./adapter";
import type { EntitlementsRuntime } from "./runtime";
import type {
  EntitlementOverrideRow,
  EntitlementSnapshotRow,
  EntitlementUsageRow,
} from "./schema";
import { writeSnapshot } from "./snapshot";
import { assertOutsideTransaction, currentAdapter } from "./txn";
import type { BillingSource, EntitlementsSweepResult } from "./types";

const PREFIX = "[@byo-oss/entitlements]";
const SNAPSHOT = "entitlementSnapshot";
const OVERRIDE = "entitlementOverride";
const USAGE = "entitlementUsage";

/** First retry delay after a throwing `resolve` (ms). It doubles per attempt, up to `maxAge`. */
export const SYNC_BACKOFF_BASE = 60_000;

/** Longest `syncError` stored. */
const MAX_SYNC_ERROR = 1000;

/** Claimed snapshots resolved at the same time within one sweep call. */
const CONCURRENCY = 10;

/** The delay after failed attempt number `attempts` (1-based): 1 min, 2 min, 4 min, … at most `maxAge`. */
export function syncBackoff(attempts: number, maxAge: number): number {
  const exponent = Math.min(Math.max(0, attempts - 1), 30);
  return Math.min(SYNC_BACKOFF_BASE * 2 ** exponent, maxAge);
}

const errorMessage = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).slice(
    0,
    MAX_SYNC_ERROR,
  );

type Counts = Omit<EntitlementsSweepResult, "hasMore">;
type Outcome = "synced" | "skipped" | "retrying" | "failed";

/**
 * One sweep batch (PRD Background work):
 * 1. Release stale claims: a snapshot with `syncState = "syncing"` whose
 *    `syncClaimedAt` is at least `leaseMs` old goes back to `idle` (a dead
 *    worker). It is still due, so step 2 can claim it.
 * 2. Claim up to `batchSize` due idle snapshots, oldest `nextSyncAt` first,
 *    each with an `incrementOne` guarded on `id`, `syncState: "idle"` and
 *    `nextSyncAt lte now`. A lost claim counts as `skipped`.
 * 3. `source.resolve`, then `writeSnapshot`'s update guarded on the claimed
 *    `version` (`toSnapshotFields`, `plan.changed` through
 *    `notifyPlanChange`), then the organization's cache entry is cleared. A
 *    lost version guard means a push wrote newer state meanwhile: the claim
 *    is released and the row counts as `synced`.
 * 4. A throw backs off exponentially (`retrying`). Once `syncAttempts`
 *    reaches `maxAttempts` the row counts as `failed`: it keeps its last
 *    good state, records `syncError` and is retried at
 *    `nextSyncAt = now + maxAge`. A success resets the attempts.
 * 5. Marks live overrides past `expiresAt` as `expired`
 *    (`endedAt = expiresAt`); deletes usage counters whose period ended
 *    before `now - usageRetention` and removed or expired overrides that
 *    ended before `now - overrideRetention` (`pruned`). Each step reads at
 *    most `batchSize` rows.
 * 6. `hasMore` is true when any step found more than `batchSize` rows.
 *
 * Steps 1–4 are skipped without a source. Must run outside a transaction.
 */
export async function runSync(
  rt: EntitlementsRuntime,
): Promise<EntitlementsSweepResult> {
  await assertOutsideTransaction(rt, "processEntitlementsSync");
  const adapter = await currentAdapter(rt);
  const now = rt.now();
  const counts: Counts = {
    synced: 0,
    skipped: 0,
    retrying: 0,
    failed: 0,
    expired: 0,
    pruned: 0,
  };
  let hasMore = false;
  const { source } = rt.options;
  if (source) {
    await releaseStaleClaims(rt, adapter, now);
    if (await syncDue(rt, source, adapter, now, counts)) hasMore = true;
  }
  if (await expireOverrides(rt, adapter, now, counts)) hasMore = true;
  if (await pruneUsage(rt, adapter, now, counts)) hasMore = true;
  if (await pruneOverrides(rt, adapter, now, counts)) hasMore = true;
  return { ...counts, hasMore };
}

// ---------------------------------------------------------------------------
// Steps 1–4: snapshots
// ---------------------------------------------------------------------------

/** Step 1. Each release is guarded on the row still being stale. */
async function releaseStaleClaims(
  rt: EntitlementsRuntime,
  adapter: DBTransactionAdapter,
  now: Date,
): Promise<void> {
  const cutoff = new Date(now.getTime() - rt.options.leaseMs);
  const stale: Where[] = [
    { field: "syncState", value: "syncing" },
    { field: "syncClaimedAt", operator: "lte", value: cutoff },
  ];
  const rows = await adapter.findMany<EntitlementSnapshotRow>({
    model: SNAPSHOT,
    where: stale,
    limit: rt.options.batchSize,
    sortBy: { field: "syncClaimedAt", direction: "asc" },
  });
  for (const row of rows) {
    await adapter.incrementOne<EntitlementSnapshotRow>({
      model: SNAPSHOT,
      where: [{ field: "id", value: row.id }, ...stale],
      increment: {},
      set: { syncState: "idle", syncClaimedAt: null, updatedAt: now },
    });
  }
}

/** Steps 2–4. Returns whether more rows were due than `batchSize`. */
async function syncDue(
  rt: EntitlementsRuntime,
  source: BillingSource,
  adapter: DBTransactionAdapter,
  now: Date,
  counts: Counts,
): Promise<boolean> {
  const { batchSize } = rt.options;
  const due = await adapter.findMany<EntitlementSnapshotRow>({
    model: SNAPSHOT,
    where: [
      { field: "syncState", value: "idle" },
      { field: "nextSyncAt", operator: "lte", value: now },
    ],
    limit: batchSize + 1,
    sortBy: { field: "nextSyncAt", direction: "asc" },
  });
  const batch = due.slice(0, batchSize);
  for (let i = 0; i < batch.length; i += CONCURRENCY) {
    const outcomes = await Promise.all(
      batch
        .slice(i, i + CONCURRENCY)
        .map((row) => syncOne(rt, source, adapter, row, now)),
    );
    for (const outcome of outcomes) counts[outcome] += 1;
  }
  return due.length > batchSize;
}

async function syncOne(
  rt: EntitlementsRuntime,
  source: BillingSource,
  adapter: DBTransactionAdapter,
  row: EntitlementSnapshotRow,
  now: Date,
): Promise<Outcome> {
  // incrementOne is the adapter's compare-and-swap: of several sweeps that
  // listed this row, exactly one gets it back. The "due" guard keeps a
  // sweep from re-claiming a row another sweep already finished.
  const claimed = await adapter.incrementOne<EntitlementSnapshotRow>({
    model: SNAPSHOT,
    where: [
      { field: "id", value: row.id },
      { field: "syncState", value: "idle" },
      { field: "nextSyncAt", operator: "lte", value: now },
    ],
    increment: { syncAttempts: 1 },
    set: { syncState: "syncing", syncClaimedAt: now },
  });
  if (!claimed) return "skipped";
  const { organizationId } = claimed;
  try {
    const state = await source.resolve(organizationId, { adapter });
    // guarded on the claimed version; sets syncState idle and the sync
    // bookkeeping, and emits plan.changed through notifyPlanChange
    const written = await writeSnapshot(rt, organizationId, state, {
      previous: claimed,
      adapter,
    });
    rt.cache.delete(organizationId);
    // null: a push stored newer state meanwhile, which stays
    if (!written) await release(rt, adapter, claimed);
    return "synced";
  } catch (error) {
    return retryOrFail(rt, adapter, claimed, error);
  }
}

/** Gives back a claim whose row another write already moved on. */
async function release(
  rt: EntitlementsRuntime,
  adapter: DBTransactionAdapter,
  claimed: EntitlementSnapshotRow,
): Promise<void> {
  await adapter.incrementOne<EntitlementSnapshotRow>({
    model: SNAPSHOT,
    where: [
      { field: "id", value: claimed.id },
      { field: "syncState", value: "syncing" },
    ],
    increment: {},
    set: { syncState: "idle", syncClaimedAt: null, updatedAt: rt.now() },
  });
}

/** Step 4: back off, or count `failed` from `maxAttempts` on. The row's billing state is never touched. */
async function retryOrFail(
  rt: EntitlementsRuntime,
  adapter: DBTransactionAdapter,
  claimed: EntitlementSnapshotRow,
  error: unknown,
): Promise<Outcome> {
  const { maxAttempts, maxAge } = rt.options;
  const attempts = claimed.syncAttempts;
  const failed = attempts >= maxAttempts;
  const delay = failed ? maxAge : syncBackoff(attempts, maxAge);
  const now = rt.now();
  rt.logger.error(
    `${PREFIX} sweep: resolving organization ${claimed.organizationId} failed (attempt ${attempts} of ${maxAttempts}); ${failed ? "it keeps its last state and is" : "it is"} retried in ${Math.round(delay / 1000)}s`,
    error,
  );
  try {
    const updated = await adapter.incrementOne<EntitlementSnapshotRow>({
      model: SNAPSHOT,
      where: [
        { field: "id", value: claimed.id },
        { field: "version", value: claimed.version },
        { field: "syncState", value: "syncing" },
      ],
      increment: {},
      set: {
        syncState: "idle",
        syncClaimedAt: null,
        syncError: errorMessage(error),
        nextSyncAt: new Date(now.getTime() + delay),
        updatedAt: now,
      },
    });
    // a push wrote newer state meanwhile: keep its schedule, drop the claim
    if (!updated) await release(rt, adapter, claimed);
  } catch (writeError) {
    // the claim stays; the lease releases it
    rt.logger.error(
      `${PREFIX} sweep: recording the failed resolve of organization ${claimed.organizationId} failed`,
      writeError,
    );
  }
  return failed ? "failed" : "retrying";
}

// ---------------------------------------------------------------------------
// Step 5: overrides and usage
// ---------------------------------------------------------------------------

/** Marks live overrides past `expiresAt` as `expired`. Returns whether more were found than `batchSize`. */
async function expireOverrides(
  rt: EntitlementsRuntime,
  adapter: DBTransactionAdapter,
  now: Date,
  counts: Counts,
): Promise<boolean> {
  const { batchSize } = rt.options;
  const rows = await adapter.findMany<EntitlementOverrideRow>({
    model: OVERRIDE,
    where: [
      { field: "status", value: "active" },
      { field: "permanent", value: false },
      { field: "expiresAt", operator: "lte", value: now },
    ],
    limit: batchSize + 1,
    sortBy: { field: "expiresAt", direction: "asc" },
  });
  for (const row of rows.slice(0, batchSize)) {
    const updated = await adapter.incrementOne<EntitlementOverrideRow>({
      model: OVERRIDE,
      where: [
        { field: "id", value: row.id },
        { field: "status", value: "active" },
      ],
      increment: {},
      set: { status: "expired", endedAt: row.expiresAt },
    });
    if (updated) {
      counts.expired += 1;
      rt.cache.delete(row.organizationId);
    }
  }
  return rows.length > batchSize;
}

/** Deletes usage counters whose period ended before `now - usageRetention`. */
async function pruneUsage(
  rt: EntitlementsRuntime,
  adapter: DBTransactionAdapter,
  now: Date,
  counts: Counts,
): Promise<boolean> {
  const { batchSize, usageRetention } = rt.options;
  const cutoff = new Date(now.getTime() - usageRetention);
  const rows = await adapter.findMany<EntitlementUsageRow>({
    model: USAGE,
    where: [{ field: "periodEnd", operator: "lt", value: cutoff }],
    limit: batchSize + 1,
    sortBy: { field: "periodEnd", direction: "asc" },
  });
  const ids = rows.slice(0, batchSize).map((row) => row.id);
  await deleteByIds(adapter, USAGE, ids, []);
  counts.pruned += ids.length;
  return rows.length > batchSize;
}

/** Deletes removed or expired overrides that ended before `now - overrideRetention`. */
async function pruneOverrides(
  rt: EntitlementsRuntime,
  adapter: DBTransactionAdapter,
  now: Date,
  counts: Counts,
): Promise<boolean> {
  const { batchSize, overrideRetention } = rt.options;
  const cutoff = new Date(now.getTime() - overrideRetention);
  const ended: Where = {
    field: "status",
    operator: "in",
    value: ["removed", "expired"],
  };
  const rows = await adapter.findMany<EntitlementOverrideRow>({
    model: OVERRIDE,
    where: [ended, { field: "endedAt", operator: "lt", value: cutoff }],
    limit: batchSize + 1,
    sortBy: { field: "endedAt", direction: "asc" },
  });
  const ids = rows.slice(0, batchSize).map((row) => row.id);
  // the status guard is repeated, so an active override is never deleted
  await deleteByIds(adapter, OVERRIDE, ids, [ended]);
  counts.pruned += ids.length;
  return rows.length > batchSize;
}

/** `deleteMany` by id, in chunks of 90; no query for an empty list. */
async function deleteByIds(
  adapter: DBTransactionAdapter,
  model: string,
  ids: readonly string[],
  where: Where[],
): Promise<void> {
  for (const part of chunk(ids)) {
    await adapter.deleteMany({
      model,
      where: [...where, { field: "id", operator: "in", value: part }],
    });
  }
}
