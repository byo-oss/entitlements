import { sweepAll } from "@byo-oss/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEntitlements } from "./api";
import type { entitlements } from "./index";
import { bucketKey } from "./period";
import type {
  EntitlementOverrideRow,
  EntitlementSnapshotRow,
  EntitlementUsageRow,
} from "./schema";
import { runSync, SYNC_BACKOFF_BASE, syncBackoff } from "./sync";
import {
  type AdapterCall,
  type AnyTestAuth,
  expectNoOuterCalls,
  fakeSource,
  getContext,
  getRuntime,
  makeAuth,
  seedOrg,
  seedOverride,
  seedUsage,
  setSnapshot,
  type TestAuthConfig,
  testCatalog,
} from "./test-utils";
import { currentAdapter } from "./txn";
import type { BillingState } from "./types";

// PRD #17 (the sweep), #10 (its pastDueSince half), memory lane

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

/** Fields of a due, idle snapshot that was synced recently (so reads don't mark it due themselves). */
const due = (fields: Partial<EntitlementSnapshotRow> = {}) => ({
  syncedAt: at(NOW, -10 * MINUTE),
  nextSyncAt: at(NOW, -MINUTE),
  ...fields,
});

type Hook = (call: AdapterCall) => void | Promise<void>;

/**
 * An auth with a fake source (unless `source: undefined` is passed), the
 * cache off, a clock at NOW and a spy logger. `hook` runs before every
 * adapter call while set.
 */
async function setup(config: TestAuthConfig = {}) {
  const source = fakeSource();
  const onEvent = vi.fn();
  const hooks: { before: Hook | null } = { before: null };
  const auth = makeAuth({
    ...config,
    options: { source, cacheTtlMs: 0, onEvent, ...config.options },
    adapter: { before: (call) => hooks.before?.(call) },
  });
  const rt = await getRuntime(auth);
  let now = NOW;
  rt.now = () => new Date(now.getTime());
  const error = vi.fn();
  rt.logger = { ...rt.logger, error };
  return {
    auth,
    rt,
    source,
    onEvent,
    error,
    hooks,
    api: createEntitlements(auth, testCatalog),
    setNow: (date: Date) => {
      now = date;
    },
    now: () => now,
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

afterEach(() => {
  vi.useRealTimers();
});

describe("runSync: resolve and write (PRD #17)", () => {
  it("resyncs a due snapshot: version-guarded write, bookkeeping reset, cache cleared; a row not yet due is left alone", async () => {
    const t = await setup({ options: { cacheTtlMs: 30_000 } });
    const { organizationId } = await seedOrg(t.auth);
    const later = await seedOrg(t.auth);
    await setSnapshot(t.auth, organizationId, due(active("pro")));
    await setSnapshot(t.auth, later.organizationId, {
      ...active("pro"),
      syncedAt: at(NOW, -MINUTE),
      nextSyncAt: at(NOW, HOUR),
    });
    // cached as pro
    expect((await t.api.get(organizationId)).plan.key).toBe("pro");
    t.source.states.set(organizationId, active("team", { seats: 3 }));

    const result = await runSync(t.rt);
    expect(result).toEqual({
      synced: 1,
      skipped: 0,
      retrying: 0,
      failed: 0,
      expired: 0,
      pruned: 0,
      hasMore: false,
    });
    expect(t.source.calls.map((c) => c.organizationId)).toEqual([
      organizationId,
    ]);
    expect(await snapshotOf(t.auth, organizationId)).toMatchObject({
      source: "fake",
      planKey: "team",
      status: "active",
      seats: 3,
      version: 1,
      syncState: "idle",
      syncClaimedAt: null,
      syncAttempts: 0,
      syncError: null,
      syncedAt: NOW,
      nextSyncAt: at(NOW, t.rt.options.maxAge),
    });
    // the sweep cleared this process's cache entry
    expect((await t.api.get(organizationId)).plan.key).toBe("team");
    expect(await snapshotOf(t.auth, later.organizationId)).toMatchObject({
      version: 0,
      planKey: "pro",
    });
  });

  it("migrates a snapshot written by another source in place", async () => {
    const t = await setup();
    const { organizationId } = await seedOrg(t.auth);
    const seeded = await setSnapshot(t.auth, organizationId, {
      ...due(active("team")),
      source: "previous",
    });
    t.source.states.set(organizationId, active("pro"));
    expect((await runSync(t.rt)).synced).toBe(1);
    expect(await snapshotOf(t.auth, organizationId)).toMatchObject({
      id: seeded.id,
      source: "fake",
      planKey: "pro",
      version: 1,
    });
  });

  it("a sweep that changes the plan emits plan.changed once; an unchanged resync emits nothing", async () => {
    const t = await setup();
    const { organizationId } = await seedOrg(t.auth);
    await setSnapshot(t.auth, organizationId, due());
    t.source.states.set(organizationId, active("pro"));
    await runSync(t.rt);
    const events = planEvents(t.onEvent);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "entitlements.plan.changed",
      organizationId,
      actorId: null,
      occurredAt: NOW,
      data: { from: "free", to: "pro", status: "active" },
    });
    t.setNow(at(NOW, t.rt.options.maxAge));
    expect((await runSync(t.rt)).synced).toBe(1);
    expect(planEvents(t.onEvent)).toHaveLength(1);
  });

  it("a source going from paid to null (row hard-deleted) clears every state field and resolves to defaultPlan", async () => {
    const t = await setup();
    const { organizationId } = await seedOrg(t.auth);
    await setSnapshot(t.auth, organizationId, {
      ...due(),
      planKey: "team",
      status: "active",
      periodStart: at(NOW, -5 * DAY),
      periodEnd: at(NOW, 25 * DAY),
      cancelAtPeriodEnd: true,
      seats: 4,
      sourceRef: "sub_1",
    });
    expect((await t.api.get(organizationId)).plan.key).toBe("team");
    // no state for the org: resolve answers null
    expect((await runSync(t.rt)).synced).toBe(1);
    expect(await snapshotOf(t.auth, organizationId)).toMatchObject({
      planKey: null,
      status: null,
      periodStart: null,
      periodEnd: null,
      cancelAtPeriodEnd: false,
      seats: null,
      sourceRef: null,
      pastDueSince: null,
    });
    const result = await t.api.get(organizationId);
    expect(result.plan).toMatchObject({ key: "free", source: "default" });
    expect(result.periodEnd).toBeNull();
    expect(planEvents(t.onEvent).map((e) => e.data)).toEqual([
      { from: "team", to: "free", status: null },
    ]);
  });

  it("a source going to a state without periodEnd clears planKey and periodEnd and resolves to defaultPlan", async () => {
    const t = await setup();
    const { organizationId } = await seedOrg(t.auth);
    await setSnapshot(t.auth, organizationId, {
      ...due(active("pro")),
      periodStart: at(NOW, -5 * DAY),
      periodEnd: at(NOW, 25 * DAY),
    });
    t.source.states.set(organizationId, { planKey: null, status: "canceled" });
    await runSync(t.rt);
    expect(await snapshotOf(t.auth, organizationId)).toMatchObject({
      planKey: null,
      status: "canceled",
      periodStart: null,
      periodEnd: null,
    });
    expect((await t.api.get(organizationId)).plan.key).toBe("free");
  });
});

describe("runSync: claims and leases (PRD #17)", () => {
  it("lease reclaim: a claim at least leaseMs old is released and resynced; a fresh claim is left alone", async () => {
    const t = await setup();
    const dead = await seedOrg(t.auth);
    const working = await seedOrg(t.auth);
    const { leaseMs } = t.rt.options;
    await setSnapshot(t.auth, dead.organizationId, {
      ...due(active("pro")),
      syncState: "syncing",
      syncClaimedAt: at(NOW, -leaseMs),
      syncAttempts: 1,
    });
    await setSnapshot(t.auth, working.organizationId, {
      ...due(active("pro")),
      syncState: "syncing",
      syncClaimedAt: at(NOW, -leaseMs + 1_000),
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
      syncClaimedAt: null,
      syncAttempts: 0,
    });
    expect(await snapshotOf(t.auth, working.organizationId)).toMatchObject({
      planKey: "pro",
      syncState: "syncing",
      version: 0,
    });
  });

  it("claim race: two sweeps that list the same rows resolve each row once", async () => {
    const t = await setup();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const { organizationId } = await seedOrg(t.auth);
      await setSnapshot(t.auth, organizationId, due());
      t.source.states.set(organizationId, active("pro"));
      ids.push(organizationId);
    }
    // both sweeps read the due list before either claims
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
    expect(a.synced + b.synced).toBe(5);
    expect(a.skipped + b.skipped).toBe(5);
    expect(t.source.calls.map((c) => c.organizationId).sort()).toEqual(
      [...ids].sort(),
    );
    for (const id of ids) {
      expect(await snapshotOf(t.auth, id)).toMatchObject({
        planKey: "pro",
        version: 1,
        syncState: "idle",
      });
    }
    expect(planEvents(t.onEvent)).toHaveLength(5);
  });

  it("a row finished by one sweep isn't re-claimed by a sweep that listed it before", async () => {
    const t = await setup();
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const { organizationId } = await seedOrg(t.auth);
      await setSnapshot(t.auth, organizationId, due());
      t.source.states.set(organizationId, active("pro"));
      ids.push(organizationId);
    }
    // sweep A lists the rows, then waits before its claims until B is done
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
    expect(b).toMatchObject({ synced: 3, skipped: 0 });
    expect(a).toMatchObject({ synced: 0, skipped: 3 });
    expect(t.source.calls).toHaveLength(3);
    for (const id of ids) {
      expect(await snapshotOf(t.auth, id)).toMatchObject({
        version: 1,
        syncAttempts: 0,
        syncState: "idle",
      });
    }
  });

  it("a push during a sweep isn't overwritten: the sweep's write loses the version guard, releases the claim and counts synced", async () => {
    const t = await setup();
    const { organizationId } = await seedOrg(t.auth);
    await setSnapshot(t.auth, organizationId, due(active("pro")));
    const resolve = t.source.resolve;
    let pushed = false;
    t.source.resolve = async (id, ctx) => {
      if (pushed) return resolve(id, ctx);
      pushed = true;
      // what the sweep read before the provider changed
      const stale = await resolve(id, ctx);
      // the provider's push lands while the sweep is resolving
      t.source.states.set(id, active("team"));
      await t.source.changed?.(id);
      return stale;
    };
    t.source.states.set(organizationId, active("pro"));

    expect(await runSync(t.rt)).toMatchObject({
      synced: 1,
      retrying: 0,
      failed: 0,
    });
    expect(await snapshotOf(t.auth, organizationId)).toMatchObject({
      planKey: "team",
      version: 1,
      syncState: "idle",
      syncClaimedAt: null,
      syncAttempts: 0,
    });
    expect((await t.api.get(organizationId)).plan.key).toBe("team");
    // the push's plan change, and nothing from the sweep
    expect(planEvents(t.onEvent).map((e) => e.data)).toEqual([
      { from: "pro", to: "team", status: "active" },
    ]);
  });

  it("a lost version guard on a row still marked syncing releases the claim", async () => {
    const t = await setup();
    const { organizationId } = await seedOrg(t.auth);
    const seeded = await setSnapshot(t.auth, organizationId, due());
    const { adapter } = await getContext(t.auth);
    const resolve = t.source.resolve;
    t.source.resolve = async (id, ctx) => {
      // a writer that moves the version but leaves the claim in place
      await adapter.update({
        model: "entitlementSnapshot",
        where: [{ field: "id", value: seeded.id }],
        update: { version: 7 },
      });
      return resolve(id, ctx);
    };
    t.source.states.set(organizationId, active("pro"));
    expect(await runSync(t.rt)).toMatchObject({ synced: 1 });
    expect(await snapshotOf(t.auth, organizationId)).toMatchObject({
      planKey: null,
      version: 7,
      syncState: "idle",
      syncClaimedAt: null,
    });
    expect(planEvents(t.onEvent)).toHaveLength(0);
  });
});

describe("runSync: retries (PRD #17)", () => {
  it("backoff: a throwing resolve goes back to idle with an exponential nextSyncAt and keeps its state", async () => {
    const t = await setup();
    const { organizationId } = await seedOrg(t.auth);
    await setSnapshot(t.auth, organizationId, due(active("pro")));
    t.source.failWith = new Error("provider down");

    expect(await runSync(t.rt)).toMatchObject({ retrying: 1, synced: 0 });
    expect(await snapshotOf(t.auth, organizationId)).toMatchObject({
      planKey: "pro",
      status: "active",
      version: 0,
      syncState: "idle",
      syncClaimedAt: null,
      syncAttempts: 1,
      syncError: "provider down",
      nextSyncAt: at(NOW, SYNC_BACKOFF_BASE),
    });
    expect(t.error).toHaveBeenCalledTimes(1);

    // not due yet
    t.setNow(at(NOW, SYNC_BACKOFF_BASE - 1));
    expect(await runSync(t.rt)).toMatchObject({ retrying: 0 });
    expect(t.source.calls).toHaveLength(1);

    const second = at(NOW, SYNC_BACKOFF_BASE);
    t.setNow(second);
    expect(await runSync(t.rt)).toMatchObject({ retrying: 1 });
    expect(await snapshotOf(t.auth, organizationId)).toMatchObject({
      syncAttempts: 2,
      nextSyncAt: at(second, 2 * SYNC_BACKOFF_BASE),
    });
    expect(t.error).toHaveBeenCalledTimes(2);
    expect((await t.api.get(organizationId)).plan.key).toBe("pro");
  });

  it("syncBackoff doubles from one minute and is capped at maxAge", () => {
    expect(syncBackoff(1, HOUR)).toBe(MINUTE);
    expect(syncBackoff(2, HOUR)).toBe(2 * MINUTE);
    expect(syncBackoff(3, HOUR)).toBe(4 * MINUTE);
    expect(syncBackoff(10, HOUR)).toBe(HOUR);
    expect(syncBackoff(1_000, HOUR)).toBe(HOUR);
  });

  it("failed: after maxAttempts the row keeps its old plan, records syncError and is retried at maxAge; a success resets it", async () => {
    const t = await setup({ options: { maxAttempts: 3 } });
    const { organizationId } = await seedOrg(t.auth);
    await setSnapshot(t.auth, organizationId, due(active("pro")));
    t.source.failWith = new Error("provider down");

    let now = NOW;
    expect(await runSync(t.rt)).toMatchObject({ retrying: 1, failed: 0 });
    now = at(now, SYNC_BACKOFF_BASE);
    t.setNow(now);
    expect(await runSync(t.rt)).toMatchObject({ retrying: 1, failed: 0 });
    now = at(now, 2 * SYNC_BACKOFF_BASE);
    t.setNow(now);
    expect(await runSync(t.rt)).toMatchObject({ retrying: 0, failed: 1 });
    const { maxAge } = t.rt.options;
    expect(await snapshotOf(t.auth, organizationId)).toMatchObject({
      planKey: "pro",
      status: "active",
      version: 0,
      syncState: "idle",
      syncAttempts: 3,
      syncError: "provider down",
      nextSyncAt: at(now, maxAge),
    });
    // the org's plan is never dropped because a sync failed
    expect((await t.api.get(organizationId)).plan.key).toBe("pro");
    expect(planEvents(t.onEvent)).toHaveLength(0);

    // retried at the normal pace; still failing → failed again
    now = at(now, maxAge);
    t.setNow(now);
    expect(await runSync(t.rt)).toMatchObject({ failed: 1 });

    now = at(now, maxAge);
    t.setNow(now);
    t.source.failWith = null;
    t.source.states.set(organizationId, active("team"));
    expect(await runSync(t.rt)).toMatchObject({ synced: 1, failed: 0 });
    expect(await snapshotOf(t.auth, organizationId)).toMatchObject({
      planKey: "team",
      syncAttempts: 0,
      syncError: null,
      version: 1,
    });
  });
});

describe("runSync: pastDueSince through sweeps (PRD #10, sweep half)", () => {
  it("set on the first past_due sync, kept while past_due (even as periodEnd moves forward), defaultPlan after the grace, cleared on recovery", async () => {
    const t = await setup();
    const { organizationId } = await seedOrg(t.auth);
    await setSnapshot(t.auth, organizationId, due(active("pro")));
    const { maxAge, pastDueGraceDays } = t.rt.options;
    t.source.states.set(organizationId, {
      planKey: "pro",
      status: "past_due",
      periodStart: at(NOW, -20 * DAY),
      periodEnd: at(NOW, 10 * DAY),
    });
    await runSync(t.rt);
    expect(await snapshotOf(t.auth, organizationId)).toMatchObject({
      status: "past_due",
      pastDueSince: NOW,
    });
    expect((await t.api.get(organizationId)).plan.key).toBe("pro");

    // a renewal moves periodEnd forward before payment
    let now = at(NOW, 2 * DAY);
    t.setNow(now);
    t.source.states.set(organizationId, {
      planKey: "pro",
      status: "past_due",
      periodStart: at(NOW, 10 * DAY),
      periodEnd: at(NOW, 40 * DAY),
    });
    expect((await runSync(t.rt)).synced).toBe(1);
    expect(await snapshotOf(t.auth, organizationId)).toMatchObject({
      pastDueSince: NOW,
      periodEnd: at(NOW, 40 * DAY),
    });
    expect((await t.api.get(organizationId)).plan.key).toBe("pro");

    // the grace counts from pastDueSince, not from the period
    now = at(NOW, pastDueGraceDays * DAY);
    t.setNow(now);
    expect((await runSync(t.rt)).synced).toBe(1);
    expect(await snapshotOf(t.auth, organizationId)).toMatchObject({
      pastDueSince: NOW,
    });
    expect((await t.api.get(organizationId)).plan.key).toBe("free");

    now = at(now, maxAge);
    t.setNow(now);
    t.source.states.set(organizationId, active("pro"));
    await runSync(t.rt);
    expect(await snapshotOf(t.auth, organizationId)).toMatchObject({
      status: "active",
      pastDueSince: null,
    });
    expect((await t.api.get(organizationId)).plan.key).toBe("pro");
  });

  it("end to end with real resolution: a billing-period key counts into the snapshot period inside the grace and into the UTC month after it", async () => {
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
    expect((await runSync(t.rt)).synced).toBe(1);
    expect(await snapshotOf(t.auth, organizationId)).toMatchObject({
      pastDueSince: at(NOW, -DAY),
    });

    const inGrace = await t.api.consumeUsage(organizationId, "reports");
    expect(inGrace).toMatchObject({
      allowed: true,
      plan: "pro",
      limit: 100,
      used: 1,
      resetAt: periodEnd,
    });
    const { adapter } = await getContext(t.auth);
    expect(
      await adapter.findOne<EntitlementUsageRow>({
        model: "entitlementUsage",
        where: [
          {
            field: "bucket",
            value: bucketKey(organizationId, "reports", periodStart),
          },
        ],
      }),
    ).toMatchObject({ used: 1, periodStart, periodEnd });

    // past pastDueSince + 7 days, still inside the billing period
    const after = at(NOW, 7 * DAY);
    t.setNow(after);
    expect((await runSync(t.rt)).synced).toBe(1);
    expect(await snapshotOf(t.auth, organizationId)).toMatchObject({
      status: "past_due",
      pastDueSince: at(NOW, -DAY),
      periodEnd,
    });
    const afterGrace = await t.api.consumeUsage(organizationId, "reports");
    const monthStart = new Date("2026-03-01T00:00:00.000Z");
    const monthEnd = new Date("2026-04-01T00:00:00.000Z");
    expect(afterGrace).toMatchObject({
      allowed: true,
      plan: "free",
      limit: 5,
      used: 1,
      resetAt: monthEnd,
    });
    expect(
      await adapter.findOne<EntitlementUsageRow>({
        model: "entitlementUsage",
        where: [
          {
            field: "bucket",
            value: bucketKey(organizationId, "reports", monthStart),
          },
        ],
      }),
    ).toMatchObject({ used: 1, periodStart: monthStart, periodEnd: monthEnd });
  });
});

describe("runSync: expiry and prunes (PRD #17)", () => {
  it("marks live overrides past expiresAt as expired with endedAt = expiresAt; others stay", async () => {
    const t = await setup();
    const { organizationId } = await seedOrg(t.auth);
    const lapsed = await seedOverride(t.auth, {
      organizationId,
      kind: "feature",
      key: "sso",
      expiresAt: at(NOW, -HOUR),
    });
    const exact = await seedOverride(t.auth, {
      organizationId,
      kind: "limit",
      key: "members",
      value: 9,
      expiresAt: NOW,
    });
    const future = await seedOverride(t.auth, {
      organizationId,
      kind: "feature",
      key: "exports",
      expiresAt: at(NOW, HOUR),
    });
    const permanent = await seedOverride(t.auth, {
      organizationId,
      kind: "plan",
      key: "team",
    });
    const removed = await seedOverride(t.auth, {
      organizationId,
      kind: "feature",
      key: "prioritySupport",
      status: "removed",
      expiresAt: at(NOW, -2 * HOUR),
      endedAt: at(NOW, -3 * HOUR),
    });

    expect(await runSync(t.rt)).toMatchObject({ expired: 2, pruned: 0 });
    expect(await overrideOf(t.auth, lapsed.id)).toMatchObject({
      status: "expired",
      endedAt: at(NOW, -HOUR),
    });
    expect(await overrideOf(t.auth, exact.id)).toMatchObject({
      status: "expired",
      endedAt: NOW,
    });
    expect(await overrideOf(t.auth, future.id)).toMatchObject({
      status: "active",
      endedAt: null,
    });
    expect(await overrideOf(t.auth, permanent.id)).toMatchObject({
      status: "active",
    });
    expect(await overrideOf(t.auth, removed.id)).toMatchObject({
      status: "removed",
      endedAt: at(NOW, -3 * HOUR),
    });
    // expiry emits nothing
    expect(t.onEvent).not.toHaveBeenCalled();
    expect((await runSync(t.rt)).expired).toBe(0);
  });

  it("prunes usage past usageRetention and ended overrides past overrideRetention; keeps permanent and active overrides", async () => {
    const t = await setup();
    const { organizationId } = await seedOrg(t.auth);
    const { usageRetention, overrideRetention } = t.rt.options;
    const oldUsage = await seedUsage(t.auth, {
      organizationId,
      key: "uploads",
      periodStart: at(NOW, -usageRetention - 31 * DAY),
      periodEnd: at(NOW, -usageRetention - DAY),
      used: 4,
    });
    const recentUsage = await seedUsage(t.auth, {
      organizationId,
      key: "uploads",
      periodStart: at(NOW, -usageRetention - 29 * DAY),
      periodEnd: at(NOW, -usageRetention + DAY),
    });
    const currentUsage = await seedUsage(t.auth, {
      organizationId,
      key: "apiCalls",
    });
    const old = at(NOW, -overrideRetention - DAY);
    const oldRemoved = await seedOverride(t.auth, {
      organizationId,
      kind: "feature",
      key: "sso",
      status: "removed",
      endedAt: old,
      createdAt: at(old, -DAY),
    });
    const oldExpired = await seedOverride(t.auth, {
      organizationId,
      kind: "limit",
      key: "members",
      value: 3,
      status: "expired",
      expiresAt: old,
      endedAt: old,
      createdAt: at(old, -DAY),
    });
    const recentRemoved = await seedOverride(t.auth, {
      organizationId,
      kind: "feature",
      key: "exports",
      status: "removed",
      endedAt: at(NOW, -overrideRetention + DAY),
    });
    const oldPermanent = await seedOverride(t.auth, {
      organizationId,
      kind: "plan",
      key: "pro",
      createdAt: at(old, -DAY),
    });
    const activeExpiring = await seedOverride(t.auth, {
      organizationId,
      kind: "limit",
      key: "projects",
      value: 9,
      expiresAt: at(NOW, DAY),
      createdAt: at(old, -DAY),
    });
    // an active row with a stray old endedAt is still active
    const activeStray = await seedOverride(t.auth, {
      organizationId,
      kind: "feature",
      key: "prioritySupport",
      endedAt: old,
      createdAt: at(old, -DAY),
    });

    expect(await runSync(t.rt)).toMatchObject({
      pruned: 3,
      expired: 0,
      hasMore: false,
    });
    expect(await usageOf(t.auth, oldUsage.id)).toBeNull();
    expect(await usageOf(t.auth, recentUsage.id)).not.toBeNull();
    expect(await usageOf(t.auth, currentUsage.id)).not.toBeNull();
    expect(await overrideOf(t.auth, oldRemoved.id)).toBeNull();
    expect(await overrideOf(t.auth, oldExpired.id)).toBeNull();
    for (const kept of [
      recentRemoved,
      oldPermanent,
      activeExpiring,
      activeStray,
    ]) {
      expect(await overrideOf(t.auth, kept.id)).toMatchObject({
        status: kept.status,
      });
    }
    expect((await runSync(t.rt)).pruned).toBe(0);
  });

  it("without a source, steps 1–4 are skipped; expiry and prunes still run", async () => {
    const t = await setup({ options: { source: undefined } });
    expect(t.rt.options.source).toBeNull();
    const { organizationId } = await seedOrg(t.auth);
    const seeded = await setSnapshot(t.auth, organizationId, {
      ...due(active("pro")),
      syncState: "syncing",
      syncClaimedAt: at(NOW, -DAY),
    });
    const other = await seedOrg(t.auth);
    const idle = await setSnapshot(t.auth, other.organizationId, due());
    const lapsed = await seedOverride(t.auth, {
      organizationId,
      kind: "feature",
      key: "sso",
      expiresAt: at(NOW, -HOUR),
    });
    await seedUsage(t.auth, {
      organizationId,
      key: "uploads",
      periodStart: at(NOW, -t.rt.options.usageRetention - 31 * DAY),
      periodEnd: at(NOW, -t.rt.options.usageRetention - DAY),
    });
    expect(await runSync(t.rt)).toEqual({
      synced: 0,
      skipped: 0,
      retrying: 0,
      failed: 0,
      expired: 1,
      pruned: 1,
      hasMore: false,
    });
    expect(await snapshotOf(t.auth, organizationId)).toEqual(seeded);
    expect(await snapshotOf(t.auth, other.organizationId)).toEqual(idle);
    expect(await overrideOf(t.auth, lapsed.id)).toMatchObject({
      status: "expired",
    });
  });
});

describe("runSync: batches (PRD #17)", () => {
  it("hasMore while more snapshots are due than batchSize", async () => {
    const t = await setup({ options: { batchSize: 2 } });
    for (let i = 0; i < 3; i++) {
      const { organizationId } = await seedOrg(t.auth);
      await setSnapshot(t.auth, organizationId, {
        ...due(),
        nextSyncAt: at(NOW, -(i + 1) * MINUTE),
      });
    }
    expect(await runSync(t.rt)).toMatchObject({ synced: 2, hasMore: true });
    expect(await runSync(t.rt)).toMatchObject({ synced: 1, hasMore: false });
    expect(await runSync(t.rt)).toMatchObject({ synced: 0, hasMore: false });
  });

  it("claims the oldest nextSyncAt first", async () => {
    const t = await setup({ options: { batchSize: 1 } });
    const newer = await seedOrg(t.auth);
    const older = await seedOrg(t.auth);
    await setSnapshot(t.auth, newer.organizationId, due());
    await setSnapshot(t.auth, older.organizationId, {
      ...due(),
      nextSyncAt: at(NOW, -HOUR),
    });
    await runSync(t.rt);
    expect(t.source.calls.map((c) => c.organizationId)).toEqual([
      older.organizationId,
    ]);
  });

  it("hasMore while more overrides expire, or more rows are prunable, than batchSize", async () => {
    const t = await setup({ options: { batchSize: 2, source: undefined } });
    const { organizationId } = await seedOrg(t.auth);
    for (const key of ["sso", "exports", "prioritySupport"]) {
      await seedOverride(t.auth, {
        organizationId,
        kind: "feature",
        key,
        expiresAt: at(NOW, -HOUR),
      });
    }
    expect(await runSync(t.rt)).toMatchObject({ expired: 2, hasMore: true });
    expect(await runSync(t.rt)).toMatchObject({ expired: 1, hasMore: false });

    const { usageRetention } = t.rt.options;
    for (let i = 0; i < 3; i++) {
      await seedUsage(t.auth, {
        organizationId,
        key: "uploads",
        periodStart: at(NOW, -usageRetention - (40 + i) * DAY),
        periodEnd: at(NOW, -usageRetention - (10 + i) * DAY),
      });
    }
    expect(await runSync(t.rt)).toMatchObject({ pruned: 2, hasMore: true });
    expect(await runSync(t.rt)).toMatchObject({ pruned: 1, hasMore: false });
  });
});

describe("processEntitlementsSync and byo.sweep", () => {
  it("is server-only: 404 over HTTP, and auth.api.processEntitlementsSync() runs the sweep", async () => {
    const t = await setup();
    const { organizationId } = await seedOrg(t.auth);
    await setSnapshot(t.auth, organizationId, due());
    t.source.states.set(organizationId, active("pro"));
    for (const path of [
      "/process-entitlements-sync",
      "/entitlements/sync",
      "/entitlements/process-sync",
    ]) {
      const response = await t.auth.handler(
        new Request(`http://localhost:3000/api/auth${path}`, {
          method: "POST",
        }),
      );
      expect(response.status).toBe(404);
    }
    expect(t.source.calls).toHaveLength(0);
    expect(await t.auth.api.processEntitlementsSync()).toMatchObject({
      synced: 1,
      hasMore: false,
    });
    expect((await snapshotOf(t.auth, organizationId))?.planKey).toBe("pro");
  });

  it("byo.sweep runs the same sweep through the auth instance", async () => {
    const t = await setup();
    const { organizationId } = await seedOrg(t.auth);
    await setSnapshot(t.auth, organizationId, due());
    t.source.states.set(organizationId, active("team"));
    const plugin = (await getContext(t.auth)).options.plugins?.find(
      (p) => p.id === "entitlements",
    ) as ReturnType<typeof entitlements>;
    expect(await plugin.byo.sweep(t.auth)).toMatchObject({ synced: 1 });
    expect((await snapshotOf(t.auth, organizationId))?.planKey).toBe("team");
  });
});

// ---------------------------------------------------------------------------
// Inside a caller's transaction (PRD A4): the sweep joins it
// ---------------------------------------------------------------------------

type Setup = Awaited<ReturnType<typeof setup>>;

/**
 * Work for every sweep step: two due snapshots (the source answers `pro`
 * and `team`), one live override past `expiresAt` and one usage counter
 * past `usageRetention`.
 */
async function seedSweepWork(t: Setup) {
  const orgs: string[] = [];
  for (const planKey of ["pro", "team"]) {
    const { organizationId } = await seedOrg(t.auth);
    await setSnapshot(t.auth, organizationId, due());
    t.source.states.set(organizationId, active(planKey));
    orgs.push(organizationId);
  }
  const [first] = orgs as [string, string];
  const lapsed = await seedOverride(t.auth, {
    organizationId: first,
    kind: "feature",
    key: "sso",
    permanent: false,
    expiresAt: at(NOW, -HOUR),
  });
  const { usageRetention } = t.rt.options;
  const oldUsage = await seedUsage(t.auth, {
    organizationId: first,
    key: "uploads",
    periodStart: at(NOW, -usageRetention - 31 * DAY),
    periodEnd: at(NOW, -usageRetention - DAY),
    used: 4,
  });
  const before = [];
  for (const id of orgs) before.push(await snapshotOf(t.auth, id));
  return { orgs, lapsed, oldUsage, before };
}

type SweepWork = Awaited<ReturnType<typeof seedSweepWork>>;

/** Reads through the transaction's adapter (an outer read would fail `expectNoOuterCalls`). */
async function readInside(t: Setup, work: SweepWork) {
  const adapter = await currentAdapter(t.rt);
  const snapshots = [];
  for (const id of work.orgs) {
    snapshots.push(
      await adapter.findOne<EntitlementSnapshotRow>({
        model: "entitlementSnapshot",
        where: [{ field: "organizationId", value: id }],
      }),
    );
  }
  const override = await adapter.findOne<EntitlementOverrideRow>({
    model: "entitlementOverride",
    where: [{ field: "id", value: work.lapsed.id }],
  });
  const usage = await adapter.findOne<EntitlementUsageRow>({
    model: "entitlementUsage",
    where: [{ field: "id", value: work.oldUsage.id }],
  });
  return { adapter, snapshots, override, usage };
}

/** Inside the transaction: the sweep's writes are visible, and the source got the transaction's adapter. */
async function expectSweptInside(t: Setup, work: SweepWork) {
  const inside = await readInside(t, work);
  const outer = (await getContext(t.auth)).adapter;
  expect(inside.adapter).not.toBe(outer);
  expect(t.source.calls).toHaveLength(2);
  for (const call of t.source.calls) expect(call.adapter).toBe(inside.adapter);
  expect(inside.snapshots.map((row) => row?.planKey)).toEqual(["pro", "team"]);
  for (const [i, row] of inside.snapshots.entries()) {
    expect(row).toMatchObject({
      syncState: "idle",
      syncClaimedAt: null,
      syncAttempts: 0,
      version: (work.before[i]?.version ?? 0) + 1,
    });
  }
  expect(inside.override).toMatchObject({
    status: "expired",
    endedAt: at(NOW, -HOUR),
  });
  expect(inside.usage).toBeNull();
}

/** After a rollback every row is as seeded. */
async function expectUntouched(t: Setup, work: SweepWork) {
  for (const [i, id] of work.orgs.entries()) {
    expect(await snapshotOf(t.auth, id)).toEqual(work.before[i]);
  }
  expect(await overrideOf(t.auth, work.lapsed.id)).toMatchObject({
    status: "active",
    endedAt: null,
  });
  expect(await usageOf(t.auth, work.oldUsage.id)).not.toBeNull();
}

/** After a commit the sweep's writes persist. */
async function expectSwept(t: Setup, work: SweepWork) {
  for (const [i, id] of work.orgs.entries()) {
    expect(await snapshotOf(t.auth, id)).toMatchObject({
      planKey: ["pro", "team"][i],
      syncState: "idle",
      version: (work.before[i]?.version ?? 0) + 1,
    });
  }
  expect(await overrideOf(t.auth, work.lapsed.id)).toMatchObject({
    status: "expired",
  });
  expect(await usageOf(t.auth, work.oldUsage.id)).toBeNull();
}

const SWEPT = { synced: 2, expired: 1, pruned: 1, hasMore: false };

describe("runSync inside a transaction joins it (PRD A4)", () => {
  it("runs on the transaction's adapter; its writes are visible inside and gone after a rollback", async () => {
    const t = await setup();
    const work = await seedSweepWork(t);
    await expect(
      expectNoOuterCalls(t.auth, async () => {
        expect(await runSync(t.rt)).toMatchObject(SWEPT);
        await expectSweptInside(t, work);
        throw new Error("roll back");
      }),
    ).rejects.toThrow("roll back");
    await expectUntouched(t, work);
    // the rolled-back rows are still due: a later sweep takes them
    t.source.calls.length = 0;
    expect(await runSync(t.rt)).toMatchObject(SWEPT);
    await expectSwept(t, work);
  });

  it("a committed run persists its writes", async () => {
    const t = await setup();
    const work = await seedSweepWork(t);
    await expectNoOuterCalls(t.auth, async () => {
      expect(await runSync(t.rt)).toMatchObject(SWEPT);
      await expectSweptInside(t, work);
    });
    await expectSwept(t, work);
    expect(planEvents(t.onEvent)).toHaveLength(2);
  });

  it("auth.api.processEntitlementsSync() joins it too", async () => {
    const t = await setup();
    const work = await seedSweepWork(t);
    await expect(
      expectNoOuterCalls(t.auth, async () => {
        expect(await t.auth.api.processEntitlementsSync()).toMatchObject(SWEPT);
        await expectSweptInside(t, work);
        throw new Error("roll back");
      }),
    ).rejects.toThrow("roll back");
    await expectUntouched(t, work);
  });

  it("core's sweepAll(auth) joins it through byo.sweep", async () => {
    const t = await setup();
    const work = await seedSweepWork(t);
    await expect(
      expectNoOuterCalls(t.auth, async () => {
        const result = await sweepAll(t.auth);
        expect(result.results).toHaveLength(1);
        expect(result.results[0]?.error).toBeUndefined();
        expect(result.results[0]).toMatchObject({
          pluginId: "entitlements",
          last: SWEPT,
        });
        await expectSweptInside(t, work);
        throw new Error("roll back");
      }),
    ).rejects.toThrow("roll back");
    await expectUntouched(t, work);
    await expectNoOuterCalls(t.auth, async () => {
      expect((await sweepAll(t.auth)).results[0]?.error).toBeUndefined();
    });
    await expectSwept(t, work);
  });
});
