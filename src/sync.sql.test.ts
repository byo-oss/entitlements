import { afterEach, describe, expect, it, vi } from "vitest";
import { createEntitlements } from "./api";
import { bucketKey } from "./period";
import type {
  EntitlementOverrideRow,
  EntitlementSnapshotRow,
  EntitlementUsageRow,
} from "./schema";
import { runSync, SYNC_BACKOFF_BASE } from "./sync";
import { createSqlTestAuth, type SqlTestAuthConfig } from "./test-sql";
import {
  type AdapterCall,
  type AnyTestAuth,
  expectNoOuterCalls,
  fakeSource,
  getContext,
  getRuntime,
  seedOrg,
  seedOverride,
  seedUsage,
  setSnapshot,
  testCatalog,
} from "./test-utils";
import type { BillingState } from "./types";

// PRD #17 on PGlite + Kysely (real transactions, real date comparisons)

const NOW = new Date("2026-03-10T12:00:00.000Z");
const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

const at = (base: Date, ms: number) => new Date(base.getTime() + ms);
const active = (planKey: string, extra: Partial<BillingState> = {}) => ({
  planKey,
  status: "active",
  ...extra,
});
const due = (fields: Partial<EntitlementSnapshotRow> = {}) => ({
  syncedAt: at(NOW, -10 * MINUTE),
  nextSyncAt: at(NOW, -MINUTE),
  ...fields,
});

type Hook = (call: AdapterCall) => void | Promise<void>;

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

async function setup(config: SqlTestAuthConfig = {}) {
  const source = fakeSource();
  const onEvent = vi.fn();
  const hooks: { before: Hook | null } = { before: null };
  const sql = await createSqlTestAuth({
    ...config,
    options: { source, cacheTtlMs: 0, onEvent, ...config.options },
    adapter: { before: (call) => hooks.before?.(call) },
  });
  closers.push(sql.close);
  const rt = await getRuntime(sql.auth);
  let now = NOW;
  rt.now = () => new Date(now.getTime());
  const error = vi.fn();
  rt.logger = { ...rt.logger, error };
  return {
    ...sql,
    rt,
    source,
    onEvent,
    error,
    hooks,
    api: createEntitlements(sql.auth, testCatalog),
    setNow: (date: Date) => {
      now = date;
    },
  };
}

async function snapshotOf(auth: AnyTestAuth, organizationId: string) {
  const { adapter } = await getContext(auth);
  return adapter.findOne<EntitlementSnapshotRow>({
    model: "entitlementSnapshot",
    where: [{ field: "organizationId", value: organizationId }],
  });
}

async function overrideOf(auth: AnyTestAuth, id: string) {
  const { adapter } = await getContext(auth);
  return adapter.findOne<EntitlementOverrideRow>({
    model: "entitlementOverride",
    where: [{ field: "id", value: id }],
  });
}

async function usageOf(auth: AnyTestAuth, id: string) {
  const { adapter } = await getContext(auth);
  return adapter.findOne<EntitlementUsageRow>({
    model: "entitlementUsage",
    where: [{ field: "id", value: id }],
  });
}

const planEvents = (onEvent: ReturnType<typeof vi.fn>) =>
  onEvent.mock.calls
    .map((call) => call[0])
    .filter((event) => event.type === "entitlements.plan.changed");

const isDueList = (call: AdapterCall) =>
  call.method === "findMany" &&
  call.model === "entitlementSnapshot" &&
  (call.args.where as { field: string; value: unknown }[]).some(
    (w) => w.field === "syncState" && w.value === "idle",
  );

const isClaim = (call: AdapterCall) =>
  call.method === "incrementOne" &&
  call.model === "entitlementSnapshot" &&
  (call.args.set as { syncState?: string } | undefined)?.syncState ===
    "syncing";

describe("runSync on SQL: claims (PRD #17)", () => {
  it("resyncs a due snapshot with the version guard and emits plan.changed once", async () => {
    const t = await setup();
    const { organizationId } = await seedOrg(t.auth);
    await setSnapshot(t.auth, organizationId, due());
    t.source.states.set(organizationId, active("pro"));
    expect(await runSync(t.rt)).toEqual({
      synced: 1,
      skipped: 0,
      retrying: 0,
      failed: 0,
      expired: 0,
      pruned: 0,
      hasMore: false,
    });
    expect(await snapshotOf(t.auth, organizationId)).toMatchObject({
      planKey: "pro",
      version: 1,
      syncState: "idle",
      syncClaimedAt: null,
      syncAttempts: 0,
      syncedAt: NOW,
      nextSyncAt: at(NOW, t.rt.options.maxAge),
    });
    expect(planEvents(t.onEvent).map((e) => e.data)).toEqual([
      { from: "free", to: "pro", status: "active" },
    ]);
    expect((await t.api.get(organizationId)).plan.key).toBe("pro");
  });

  it("lease reclaim: a stale claim is released and resynced; a fresh one is left alone", async () => {
    const t = await setup();
    const dead = await seedOrg(t.auth);
    const working = await seedOrg(t.auth);
    const { leaseMs } = t.rt.options;
    await setSnapshot(t.auth, dead.organizationId, {
      ...due(),
      syncState: "syncing",
      syncClaimedAt: at(NOW, -leaseMs - 1),
      syncAttempts: 1,
    });
    await setSnapshot(t.auth, working.organizationId, {
      ...due(),
      syncState: "syncing",
      syncClaimedAt: at(NOW, -MINUTE),
      syncAttempts: 1,
    });
    t.source.states.set(dead.organizationId, active("team"));
    t.source.states.set(working.organizationId, active("team"));
    expect(await runSync(t.rt)).toMatchObject({ synced: 1, skipped: 0 });
    expect(t.source.calls.map((c) => c.organizationId)).toEqual([
      dead.organizationId,
    ]);
    expect(await snapshotOf(t.auth, dead.organizationId)).toMatchObject({
      planKey: "team",
      syncState: "idle",
      syncAttempts: 0,
    });
    expect(await snapshotOf(t.auth, working.organizationId)).toMatchObject({
      planKey: null,
      syncState: "syncing",
    });
  });

  it("claim race: two sweeps that list the same rows resolve each row once", async () => {
    const t = await setup();
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      const { organizationId } = await seedOrg(t.auth);
      await setSnapshot(t.auth, organizationId, due());
      t.source.states.set(organizationId, active("pro"));
      ids.push(organizationId);
    }
    let arrived = 0;
    let open: () => void = () => {};
    const barrier = new Promise<void>((resolve) => {
      open = resolve;
    });
    t.hooks.before = async (call) => {
      if (!isDueList(call)) return;
      arrived += 1;
      if (arrived === 2) open();
      await barrier;
    };
    const [a, b] = await Promise.all([runSync(t.rt), runSync(t.rt)]);
    expect(arrived).toBe(2);
    expect(a.synced + b.synced).toBe(4);
    expect(a.skipped + b.skipped).toBe(4);
    expect(t.source.calls.map((c) => c.organizationId).sort()).toEqual(
      [...ids].sort(),
    );
    const rows = await t.db
      .selectFrom("entitlementSnapshot")
      .select(["version", "syncState", "planKey"])
      .execute();
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      expect(row).toEqual({ version: 1, syncState: "idle", planKey: "pro" });
    }
  });

  it("a row finished by one sweep isn't re-claimed by a sweep that listed it before", async () => {
    const t = await setup();
    for (let i = 0; i < 2; i++) {
      const { organizationId } = await seedOrg(t.auth);
      await setSnapshot(t.auth, organizationId, due());
    }
    let armed = true;
    let reached: () => void = () => {};
    const atClaim = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    t.hooks.before = async (call) => {
      if (!armed || !isClaim(call)) return;
      reached();
      await gate;
    };
    const first = runSync(t.rt);
    await atClaim;
    armed = false;
    const b = await runSync(t.rt);
    release();
    const a = await first;
    expect(b).toMatchObject({ synced: 2, skipped: 0 });
    expect(a).toMatchObject({ synced: 0, skipped: 2 });
    expect(t.source.calls).toHaveLength(2);
  });

  it("a push during a sweep isn't overwritten", async () => {
    const t = await setup();
    const { organizationId } = await seedOrg(t.auth);
    await setSnapshot(t.auth, organizationId, due(active("pro")));
    t.source.states.set(organizationId, active("pro"));
    const resolve = t.source.resolve;
    let pushed = false;
    t.source.resolve = async (id, ctx) => {
      if (pushed) return resolve(id, ctx);
      pushed = true;
      const stale = await resolve(id, ctx);
      t.source.states.set(id, active("team"));
      await t.source.changed?.(id);
      return stale;
    };
    expect(await runSync(t.rt)).toMatchObject({ synced: 1 });
    expect(await snapshotOf(t.auth, organizationId)).toMatchObject({
      planKey: "team",
      version: 1,
      syncState: "idle",
      syncClaimedAt: null,
    });
    expect(planEvents(t.onEvent).map((e) => e.data)).toEqual([
      { from: "pro", to: "team", status: "active" },
    ]);
  });

  it("must run outside a transaction", async () => {
    const t = await setup();
    await expectNoOuterCalls(t.auth, async () => {
      await expect(runSync(t.rt)).rejects.toThrow(
        "[@byo-oss/entitlements] processEntitlementsSync must run outside a transaction",
      );
    });
  });
});

describe("runSync on SQL: retries and state (PRD #17)", () => {
  it("backs off, then counts failed and keeps the old plan", async () => {
    const t = await setup({ options: { maxAttempts: 2 } });
    const { organizationId } = await seedOrg(t.auth);
    await setSnapshot(t.auth, organizationId, due(active("pro")));
    t.source.failWith = new Error("provider down");
    expect(await runSync(t.rt)).toMatchObject({ retrying: 1 });
    expect(await snapshotOf(t.auth, organizationId)).toMatchObject({
      syncState: "idle",
      syncAttempts: 1,
      syncError: "provider down",
      nextSyncAt: at(NOW, SYNC_BACKOFF_BASE),
    });
    const later = at(NOW, SYNC_BACKOFF_BASE);
    t.setNow(later);
    expect(await runSync(t.rt)).toMatchObject({ failed: 1, retrying: 0 });
    expect(await snapshotOf(t.auth, organizationId)).toMatchObject({
      planKey: "pro",
      status: "active",
      version: 0,
      syncAttempts: 2,
      syncError: "provider down",
      nextSyncAt: at(later, t.rt.options.maxAge),
    });
    expect((await t.api.get(organizationId)).plan.key).toBe("pro");
  });

  it("paid → null and paid → a state without periodEnd clear planKey and periodEnd and resolve to defaultPlan", async () => {
    const t = await setup();
    const deleted = await seedOrg(t.auth);
    const canceled = await seedOrg(t.auth);
    for (const { organizationId } of [deleted, canceled]) {
      await setSnapshot(t.auth, organizationId, {
        ...due(active("team")),
        periodStart: at(NOW, -5 * DAY),
        periodEnd: at(NOW, 25 * DAY),
        seats: 2,
        sourceRef: "sub_1",
      });
    }
    t.source.states.set(canceled.organizationId, {
      planKey: null,
      status: "canceled",
    });
    expect((await runSync(t.rt)).synced).toBe(2);
    expect(await snapshotOf(t.auth, deleted.organizationId)).toMatchObject({
      planKey: null,
      status: null,
      periodStart: null,
      periodEnd: null,
      seats: null,
      sourceRef: null,
    });
    expect(await snapshotOf(t.auth, canceled.organizationId)).toMatchObject({
      planKey: null,
      status: "canceled",
      periodEnd: null,
    });
    for (const { organizationId } of [deleted, canceled]) {
      expect((await t.api.get(organizationId)).plan).toMatchObject({
        key: "free",
        source: "default",
      });
    }
  });

  it("end to end: a past_due org counts a billing key into its snapshot period inside the grace and the UTC month after it", async () => {
    const t = await setup();
    const { organizationId } = await seedOrg(t.auth);
    const periodStart = new Date("2026-03-05T00:00:00.000Z");
    const periodEnd = new Date("2026-04-05T00:00:00.000Z");
    const pastDue = {
      planKey: "pro",
      status: "past_due",
      periodStart,
      periodEnd,
    };
    await setSnapshot(t.auth, organizationId, {
      ...due(pastDue),
      pastDueSince: at(NOW, -DAY),
    });
    t.source.states.set(organizationId, pastDue);
    await runSync(t.rt);
    expect(await t.api.consumeUsage(organizationId, "reports")).toMatchObject({
      allowed: true,
      plan: "pro",
      limit: 100,
      resetAt: periodEnd,
    });

    t.setNow(at(NOW, 7 * DAY));
    await runSync(t.rt);
    expect(await snapshotOf(t.auth, organizationId)).toMatchObject({
      pastDueSince: at(NOW, -DAY),
    });
    const monthStart = new Date("2026-03-01T00:00:00.000Z");
    const monthEnd = new Date("2026-04-01T00:00:00.000Z");
    expect(await t.api.consumeUsage(organizationId, "reports")).toMatchObject({
      allowed: true,
      plan: "free",
      limit: 5,
      resetAt: monthEnd,
    });
    const buckets = await t.db
      .selectFrom("entitlementUsage")
      .select(["bucket", "used"])
      .where("organizationId", "=", organizationId)
      .orderBy("bucket")
      .execute();
    expect(buckets).toEqual(
      [
        { bucket: bucketKey(organizationId, "reports", monthStart), used: 1 },
        { bucket: bucketKey(organizationId, "reports", periodStart), used: 1 },
      ].sort((x, y) => x.bucket.localeCompare(y.bucket)),
    );
  });
});

describe("runSync on SQL: expiry and prunes (PRD #17)", () => {
  it("expires lapsed overrides and prunes past retention, keeping permanent and active overrides", async () => {
    const t = await setup({ options: { source: undefined } });
    const { organizationId } = await seedOrg(t.auth);
    const { usageRetention, overrideRetention } = t.rt.options;
    const lapsed = await seedOverride(t.auth, {
      organizationId,
      kind: "feature",
      key: "sso",
      expiresAt: at(NOW, -HOUR),
    });
    const future = await seedOverride(t.auth, {
      organizationId,
      kind: "feature",
      key: "exports",
      expiresAt: at(NOW, HOUR),
    });
    const old = at(NOW, -overrideRetention - DAY);
    const oldPermanent = await seedOverride(t.auth, {
      organizationId,
      kind: "plan",
      key: "pro",
      createdAt: at(old, -DAY),
    });
    const activeStray = await seedOverride(t.auth, {
      organizationId,
      kind: "feature",
      key: "prioritySupport",
      endedAt: old,
      createdAt: at(old, -DAY),
    });
    const oldRemoved = await seedOverride(t.auth, {
      organizationId,
      kind: "limit",
      key: "members",
      value: 3,
      status: "removed",
      endedAt: old,
      createdAt: at(old, -DAY),
    });
    const oldExpired = await seedOverride(t.auth, {
      organizationId,
      kind: "limit",
      key: "projects",
      value: 3,
      status: "expired",
      expiresAt: old,
      endedAt: old,
      createdAt: at(old, -DAY),
    });
    const recentRemoved = await seedOverride(t.auth, {
      organizationId,
      kind: "limit",
      key: "retentionDays",
      value: 30,
      status: "removed",
      endedAt: at(NOW, -DAY),
    });
    const oldUsage = await seedUsage(t.auth, {
      organizationId,
      key: "uploads",
      periodStart: at(NOW, -usageRetention - 31 * DAY),
      periodEnd: at(NOW, -usageRetention - DAY),
    });
    const keptUsage = await seedUsage(t.auth, {
      organizationId,
      key: "uploads",
      periodStart: at(NOW, -usageRetention - 29 * DAY),
      periodEnd: at(NOW, -usageRetention + DAY),
    });

    expect(await runSync(t.rt)).toMatchObject({
      synced: 0,
      expired: 1,
      pruned: 3,
      hasMore: false,
    });
    expect(await overrideOf(t.auth, lapsed.id)).toMatchObject({
      status: "expired",
      endedAt: at(NOW, -HOUR),
    });
    for (const kept of [future, oldPermanent, activeStray]) {
      expect(await overrideOf(t.auth, kept.id)).toMatchObject({
        status: "active",
      });
    }
    expect(await overrideOf(t.auth, recentRemoved.id)).toMatchObject({
      status: "removed",
    });
    expect(await overrideOf(t.auth, oldRemoved.id)).toBeNull();
    expect(await overrideOf(t.auth, oldExpired.id)).toBeNull();
    expect(await usageOf(t.auth, oldUsage.id)).toBeNull();
    expect(await usageOf(t.auth, keptUsage.id)).not.toBeNull();
  });

  it("hasMore across batches", async () => {
    const t = await setup({ options: { batchSize: 2 } });
    for (let i = 0; i < 3; i++) {
      const { organizationId } = await seedOrg(t.auth);
      await setSnapshot(t.auth, organizationId, due());
    }
    expect(await runSync(t.rt)).toMatchObject({ synced: 2, hasMore: true });
    expect(await runSync(t.rt)).toMatchObject({ synced: 1, hasMore: false });
  });
});
