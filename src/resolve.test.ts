import { afterEach, describe, expect, it, vi } from "vitest";
import { createEntitlements } from "./api";
import { createCache } from "./cache";
import { liveOverrides } from "./live-overrides";
import type { ResolveEntitlementsInput } from "./options";
import {
  MAX_GET_MANY,
  resolveMany,
  resolveState,
  syncOrganization,
} from "./resolve";
import type { EntitlementSnapshotRow } from "./schema";
import {
  isDefaultEntitled,
  notifyPlanChange,
  readSnapshot,
  toSnapshotFields,
  writeSnapshot,
} from "./snapshot";
import {
  type AnyTestAuth,
  fakeSource,
  getContext,
  getRuntime,
  makeAuth,
  seedOrg,
  seedOverride,
  setSnapshot,
  type TestAuthConfig,
  testCatalog,
} from "./test-utils";
import type { BillingState, ResolvedState } from "./types";

const DAY = 86_400_000;
const HOUR = 3_600_000;

const active = (planKey: string, extra: Partial<BillingState> = {}) => ({
  planKey,
  status: "active",
  ...extra,
});

async function snapshotRows(auth: AnyTestAuth, organizationId: string) {
  const { adapter } = await getContext(auth);
  return adapter.findMany<EntitlementSnapshotRow>({
    model: "entitlementSnapshot",
    where: [{ field: "organizationId", value: organizationId }],
    limit: 10,
  });
}

/** An auth with a fake source and the cache off, plus a seeded organization. */
async function setup(config: TestAuthConfig = {}) {
  const source = fakeSource();
  const onEvent = vi.fn();
  const auth = makeAuth({
    ...config,
    options: { source, cacheTtlMs: 0, onEvent, ...config.options },
  });
  const rt = await getRuntime(auth);
  const { organizationId, owner } = await seedOrg(auth);
  const api = createEntitlements(auth, testCatalog);
  return { auth, rt, source, onEvent, organizationId, owner, api };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("resolution order (PRD #9)", () => {
  it("snapshot → isEntitled → plan override → resolveEntitlements (sees the overridden plan) → feature/limit overrides", async () => {
    const seen: ResolveEntitlementsInput[] = [];
    const { auth, organizationId, api } = await setup({
      options: {
        resolveEntitlements: (input) => {
          seen.push(input);
          return { features: { sso: false }, limits: { members: 7 } };
        },
      },
    });
    await setSnapshot(auth, organizationId, active("pro"));
    await seedOverride(auth, { organizationId, kind: "plan", key: "team" });
    await seedOverride(auth, {
      organizationId,
      kind: "feature",
      key: "sso",
      value: true,
    });
    await seedOverride(auth, {
      organizationId,
      kind: "limit",
      key: "projects",
      value: 2,
    });
    const result = await api.get(organizationId);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      organizationId,
      plan: "team",
      snapshot: { planKey: "pro", status: "active" },
      features: testCatalog.plans.team.features,
      limits: testCatalog.plans.team.limits,
    });
    expect(result).toMatchObject({
      degraded: false,
      plan: { key: "team", source: "override" },
      status: "active",
    });
    // the hook's members survives, its sso is replaced by the feature override
    expect(result.features).toEqual({
      exports: true,
      sso: true,
      prioritySupport: true,
    });
    expect(result.limits).toMatchObject({ members: 7, projects: 2 });
    expect(result.overrides).toEqual([
      { kind: "plan", key: "team", expiresAt: null },
      { kind: "feature", key: "sso", expiresAt: null },
      { kind: "limit", key: "projects", expiresAt: null },
    ]);
  });

  it("an entitled billed plan has source billing; an alias resolves to its plan", async () => {
    const { auth, organizationId, api } = await setup();
    await setSnapshot(auth, organizationId, active("pro"));
    expect((await api.get(organizationId)).plan).toEqual({
      key: "pro",
      display: { name: "Pro" },
      source: "billing",
    });
    await setSnapshot(auth, organizationId, active("legacy"));
    const aliased = await api.get(organizationId);
    expect(aliased.plan).toMatchObject({ key: "pro", source: "billing" });
    expect(aliased.limits).toEqual(testCatalog.plans.pro.limits);
  });

  it("ignores expired overrides before the sweep marks them, even when newer than a live one", async () => {
    const { auth, organizationId, api } = await setup();
    const past = new Date(Date.now() - HOUR);
    const future = new Date(Date.now() + HOUR);
    await seedOverride(auth, {
      organizationId,
      kind: "limit",
      key: "apiCalls",
      value: 5,
      createdAt: new Date(Date.now() - 2 * HOUR),
    });
    await seedOverride(auth, {
      organizationId,
      kind: "limit",
      key: "apiCalls",
      value: 9,
      expiresAt: past,
    });
    await seedOverride(auth, {
      organizationId,
      kind: "plan",
      key: "team",
      expiresAt: past,
    });
    await seedOverride(auth, {
      organizationId,
      kind: "feature",
      key: "exports",
      value: true,
      expiresAt: future,
    });
    const result = await api.get(organizationId);
    expect(result.plan).toMatchObject({ key: "free", source: "default" });
    expect(result.limits.apiCalls).toBe(5);
    expect(result.features.exports).toBe(true);
    expect(result.overrides).toEqual([
      { kind: "feature", key: "exports", expiresAt: future },
      { kind: "limit", key: "apiCalls", expiresAt: null },
    ]);
  });

  it("the newest override wins per key, one plan override per org whatever its key, and removed or undecodable rows don't apply", async () => {
    const { auth, rt, organizationId, api } = await setup();
    const at = (ms: number) => new Date(Date.now() - ms);
    await seedOverride(auth, {
      organizationId,
      kind: "plan",
      key: "team",
      createdAt: at(3 * HOUR),
    });
    await seedOverride(auth, {
      organizationId,
      kind: "plan",
      key: "legacy",
      createdAt: at(HOUR),
    });
    await seedOverride(auth, {
      organizationId,
      kind: "feature",
      key: "sso",
      value: true,
      createdAt: at(2 * HOUR),
    });
    await seedOverride(auth, {
      organizationId,
      kind: "feature",
      key: "sso",
      value: false,
      createdAt: at(HOUR),
    });
    await seedOverride(auth, {
      organizationId,
      kind: "feature",
      key: "prioritySupport",
      value: true,
      status: "removed",
    });
    await seedOverride(auth, {
      organizationId,
      kind: "limit",
      key: "members",
      value: "lots" as never,
    });
    const result = await api.get(organizationId);
    expect(result.plan).toMatchObject({ key: "pro", source: "override" });
    expect(result.features).toEqual({
      exports: true,
      sso: false,
      prioritySupport: false,
    });
    expect(result.limits.members).toBe(testCatalog.plans.pro.limits.members);
    const { adapter } = await getContext(auth);
    const sets = await liveOverrides(rt, adapter, [organizationId], rt.now());
    expect(sets.get(organizationId)?.plan?.key).toBe("legacy");
    expect([...(sets.get(organizationId)?.limits.keys() ?? [])]).toEqual([]);
  });

  it("statuses outside the rule fall back to defaultPlan; trialing keeps the plan", async () => {
    const { auth, organizationId, api } = await setup();
    for (const status of ["paused", "unpaid", "incomplete", "canceled", null]) {
      await setSnapshot(auth, organizationId, { planKey: "pro", status });
      const result = await api.get(organizationId);
      expect(result.plan).toMatchObject({ key: "free", source: "default" });
      expect(result.status).toBe(status);
    }
    await setSnapshot(
      auth,
      organizationId,
      active("pro", { status: "trialing" }),
    );
    expect((await api.get(organizationId)).plan.key).toBe("pro");
  });

  it("an unknown plan key answers defaultPlan and warns once per process", async () => {
    const { auth, rt, organizationId, api } = await setup();
    const warn = vi.fn();
    rt.logger = { ...rt.logger, warn };
    await setSnapshot(auth, organizationId, active("gold"));
    expect((await api.get(organizationId)).plan.key).toBe("free");
    expect((await api.get(organizationId)).plan.key).toBe("free");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatch(/"gold"/);
  });

  it("another source's snapshot counts as missing: updated in place, and the second read makes no resolve call", async () => {
    const { auth, source, organizationId, api } = await setup();
    const old = await setSnapshot(auth, organizationId, {
      ...active("team"),
      source: "previous-source",
    });
    source.states.set(organizationId, active("pro"));
    expect((await api.get(organizationId)).plan.key).toBe("pro");
    expect(source.calls).toHaveLength(1);
    const rows = await snapshotRows(auth, organizationId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: old.id,
      source: "fake",
      planKey: "pro",
      version: old.version + 1,
    });
    expect((await api.get(organizationId)).plan.key).toBe("pro");
    expect(source.calls).toHaveLength(1);
  });

  it("reads through a missing snapshot once and persists it, also with no subscription", async () => {
    const { auth, source, organizationId, api } = await setup();
    const result = await api.get(organizationId);
    expect(result).toMatchObject({ degraded: false, plan: { key: "free" } });
    expect(source.calls).toEqual([
      { organizationId, adapter: expect.anything() },
    ]);
    const rows = await snapshotRows(auth, organizationId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      source: "fake",
      planKey: null,
      status: null,
      version: 0,
      syncState: "idle",
    });
    await api.get(organizationId);
    expect(source.calls).toHaveLength(1);
  });

  it("an unknown organization id answers defaultPlan (not degraded), calls no source, persists and caches nothing", async () => {
    const { auth, rt, source, api } = await setup({
      options: { cacheTtlMs: 30_000 },
    });
    const result = await api.get("org_missing");
    expect(result).toMatchObject({
      organizationId: "org_missing",
      degraded: false,
      plan: { key: "free", source: "default" },
    });
    expect(source.calls).toHaveLength(0);
    expect(await snapshotRows(auth, "org_missing")).toHaveLength(0);
    expect(rt.cache.get("org_missing")).toBeUndefined();
  });

  it("without a source, snapshot rows are ignored and nothing is written", async () => {
    const auth = makeAuth({ options: { cacheTtlMs: 0 } });
    const { organizationId } = await seedOrg(auth);
    const api = createEntitlements(auth, testCatalog);
    expect((await api.get(organizationId)).plan.key).toBe("free");
    expect(await snapshotRows(auth, organizationId)).toHaveLength(0);
    await setSnapshot(auth, organizationId, active("pro"));
    expect((await api.get(organizationId)).plan.key).toBe("free");
    await seedOverride(auth, { organizationId, kind: "plan", key: "team" });
    expect((await api.get(organizationId)).plan).toMatchObject({
      key: "team",
      source: "override",
    });
  });
});

describe("status rule and pastDueSince (PRD #10)", () => {
  it("past_due keeps the plan for pastDueGraceDays from pastDueSince, even when periodEnd moves forward; pastDueSince survives repeated past_due syncs and clears on recovery", async () => {
    const { auth, rt, source, organizationId } = await setup();
    const t0 = new Date("2030-01-01T00:00:00.000Z");
    let now = t0;
    rt.now = () => now;
    const pastDue = (periodEnd: number) => ({
      planKey: "pro",
      status: "past_due",
      periodEnd: new Date(t0.getTime() + periodEnd),
    });

    source.states.set(organizationId, pastDue(30 * DAY));
    let state = await syncOrganization(rt, organizationId);
    expect(state.snapshot?.pastDueSince).toEqual(t0);
    expect(state.result.plan.key).toBe("pro");

    // a repeated past_due sync with the period moved forward keeps the clock
    now = new Date(t0.getTime() + 3 * DAY);
    source.states.set(organizationId, pastDue(60 * DAY));
    state = await syncOrganization(rt, organizationId);
    expect(state.snapshot?.pastDueSince).toEqual(t0);
    expect(state.result.plan.key).toBe("pro");

    // still inside the grace window
    now = new Date(t0.getTime() + 7 * DAY - 1);
    state = await resolveState(rt, organizationId, { bypassCache: true });
    expect(state.entitled).toBe(true);
    expect(state.result.plan.key).toBe("pro");

    // after it: defaultPlan, though periodEnd is far ahead
    now = new Date(t0.getTime() + 7 * DAY);
    source.states.set(organizationId, pastDue(90 * DAY));
    state = await syncOrganization(rt, organizationId);
    expect(state.snapshot?.pastDueSince).toEqual(t0);
    expect(state.snapshot?.periodEnd?.getTime()).toBeGreaterThan(now.getTime());
    expect(state.entitled).toBe(false);
    expect(state.result.plan).toMatchObject({ key: "free", source: "default" });
    expect(state.result.status).toBe("past_due");

    // recovery clears it
    now = new Date(t0.getTime() + 8 * DAY);
    source.states.set(organizationId, active("pro"));
    state = await syncOrganization(rt, organizationId);
    expect(state.snapshot?.pastDueSince).toBeNull();
    expect(state.result.plan.key).toBe("pro");

    // a new past_due starts a new clock
    now = new Date(t0.getTime() + 20 * DAY);
    source.states.set(organizationId, pastDue(40 * DAY));
    state = await syncOrganization(rt, organizationId);
    expect(state.snapshot?.pastDueSince).toEqual(now);
    expect(state.result.plan.key).toBe("pro");
    const [row] = await snapshotRows(auth, organizationId);
    expect(row?.pastDueSince).toEqual(now);
  });

  it("pastDueGraceDays sets the window; isDefaultEntitled covers each status", () => {
    const since = new Date("2030-01-01T00:00:00.000Z");
    const row = (status: string | null, pastDueSince: Date | null = since) =>
      ({ status, pastDueSince }) as EntitlementSnapshotRow;
    const at = (ms: number) => new Date(since.getTime() + ms);
    expect(isDefaultEntitled(row("active", null), at(0), 7)).toBe(true);
    expect(isDefaultEntitled(row("trialing", null), at(0), 7)).toBe(true);
    expect(isDefaultEntitled(row("past_due"), at(2 * DAY - 1), 2)).toBe(true);
    expect(isDefaultEntitled(row("past_due"), at(2 * DAY), 2)).toBe(false);
    expect(isDefaultEntitled(row("past_due"), at(0), 0)).toBe(false);
    expect(isDefaultEntitled(row("past_due", null), at(0), 7)).toBe(false);
    for (const status of ["paused", "unpaid", "incomplete", "canceled", null]) {
      expect(isDefaultEntitled(row(status), at(0), 7)).toBe(false);
    }
  });

  it("a custom pastDueGraceDays applies to resolution", async () => {
    const { auth, rt, organizationId } = await setup({
      options: { pastDueGraceDays: 1 },
    });
    const since = new Date(Date.now() - 2 * DAY);
    await setSnapshot(auth, organizationId, {
      planKey: "pro",
      status: "past_due",
      pastDueSince: since,
    });
    expect((await resolveState(rt, organizationId)).result.plan.key).toBe(
      "free",
    );
  });
});

describe("toSnapshotFields", () => {
  const now = new Date("2030-02-01T00:00:00.000Z");

  it("sets every field explicitly: null state, missing optional fields, lowercased plan key", () => {
    const empty = {
      source: "fake",
      planKey: null,
      status: null,
      periodStart: null,
      periodEnd: null,
      cancelAtPeriodEnd: false,
      seats: null,
      pastDueSince: null,
      sourceRef: null,
    };
    expect(
      toSnapshotFields(null, { source: "fake", previous: null, now }),
    ).toEqual(empty);
    expect(
      toSnapshotFields(
        { planKey: "PRO", status: "active" },
        { source: "fake", previous: null, now },
      ),
    ).toEqual({ ...empty, planKey: "pro", status: "active" });
    const periodStart = new Date("2030-01-15T00:00:00.000Z");
    expect(
      toSnapshotFields(
        {
          planKey: "team",
          status: "trialing",
          periodStart,
          periodEnd: null,
          cancelAtPeriodEnd: true,
          seats: 4,
          sourceRef: "sub_1",
        },
        { source: "fake", previous: null, now },
      ),
    ).toEqual({
      ...empty,
      planKey: "team",
      status: "trialing",
      periodStart,
      cancelAtPeriodEnd: true,
      seats: 4,
      sourceRef: "sub_1",
    });
  });

  it("pastDueSince: set on entering past_due, kept while it stays, null otherwise", () => {
    const since = new Date("2030-01-20T00:00:00.000Z");
    const previous = (status: string | null, pastDueSince: Date | null) =>
      ({ status, pastDueSince }) as EntitlementSnapshotRow;
    const pastDue = { planKey: "pro", status: "past_due" };
    const fields = (prev: EntitlementSnapshotRow | null, state: BillingState) =>
      toSnapshotFields(state, { source: "fake", previous: prev, now })
        .pastDueSince;
    expect(fields(null, pastDue)).toEqual(now);
    expect(fields(previous("active", null), pastDue)).toEqual(now);
    expect(fields(previous("past_due", since), pastDue)).toEqual(since);
    expect(fields(previous("past_due", since), active("pro"))).toBeNull();
  });
});

describe("snapshot writes and plan.changed", () => {
  it("50 parallel get on an organization with no snapshot → one entitlementSnapshot row, one resolve, one plan.changed (PRD #12)", async () => {
    const { auth, source, onEvent, organizationId, api } = await setup();
    source.states.set(organizationId, active("pro"));
    const results = await Promise.all(
      Array.from({ length: 50 }, () => api.get(organizationId)),
    );
    expect(new Set(results.map((r) => r.plan.key))).toEqual(new Set(["pro"]));
    expect(await snapshotRows(auth, organizationId)).toHaveLength(1);
    expect(source.calls).toHaveLength(1);
    expect(onEvent).toHaveBeenCalledTimes(1);
  });

  it("50 parallel syncs on an organization with no snapshot → one row", async () => {
    const { auth, rt, source, organizationId } = await setup();
    source.states.set(organizationId, active("team"));
    await Promise.all(
      Array.from({ length: 50 }, () => syncOrganization(rt, organizationId)),
    );
    const rows = await snapshotRows(auth, organizationId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.planKey).toBe("team");
  });

  it("emits plan.changed once per change of the resolved plan key, not on a no-op write or a first write to defaultPlan", async () => {
    const { rt, source, onEvent, organizationId } = await setup();
    // first write resolving to defaultPlan: nothing
    await syncOrganization(rt, organizationId);
    expect(onEvent).not.toHaveBeenCalled();

    source.states.set(organizationId, active("pro"));
    await syncOrganization(rt, organizationId);
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent.mock.calls[0]?.[0]).toMatchObject({
      type: "entitlements.plan.changed",
      organizationId,
      actorId: null,
      subject: { type: "organization", id: organizationId },
      data: { from: "free", to: "pro", status: "active" },
      occurredAt: expect.any(Date),
    });

    // same state again, and a status change that keeps the plan: nothing
    await syncOrganization(rt, organizationId);
    source.states.set(organizationId, active("legacy", { status: "trialing" }));
    await syncOrganization(rt, organizationId);
    expect(onEvent).toHaveBeenCalledTimes(1);

    source.states.set(organizationId, null);
    await syncOrganization(rt, organizationId);
    expect(onEvent).toHaveBeenCalledTimes(2);
    expect(onEvent.mock.calls[1]?.[0]).toMatchObject({
      data: { from: "pro", to: "free", status: null },
    });
  });

  it("the event's occurredAt is rt.now(), and notifyPlanChange treats a missing or foreign-source before as defaultPlan", async () => {
    const { auth, rt, onEvent, organizationId } = await setup();
    const fixed = new Date("2031-05-05T05:05:05.000Z");
    rt.now = () => fixed;
    const after = await setSnapshot(auth, organizationId, active("team"));
    const foreign = { ...after, source: "previous-source" };
    await notifyPlanChange(rt, organizationId, foreign, after);
    await notifyPlanChange(rt, organizationId, null, after);
    await notifyPlanChange(rt, organizationId, after, after);
    expect(onEvent).toHaveBeenCalledTimes(2);
    expect(onEvent.mock.calls[0]?.[0]).toMatchObject({
      occurredAt: fixed,
      data: { from: "free", to: "team", status: "active" },
    });
  });

  it("writeSnapshot updates in place guarded on version, and returns null when the guard lost", async () => {
    const { auth, rt, organizationId } = await setup();
    const { adapter } = await getContext(auth);
    const first = await writeSnapshot(rt, organizationId, active("pro"), {
      previous: null,
      adapter,
    });
    expect(first).toMatchObject({ version: 0, planKey: "pro" });
    const second = await writeSnapshot(rt, organizationId, active("team"), {
      previous: first,
      adapter,
    });
    expect(second).toMatchObject({ version: 1, planKey: "team" });
    // a writer still holding the first version loses
    const stale = await writeSnapshot(rt, organizationId, null, {
      previous: first,
      adapter,
    });
    expect(stale).toBeNull();
    expect(await readSnapshot(rt, adapter, organizationId)).toMatchObject({
      version: 1,
      planKey: "team",
    });
    // a create when the row already exists never overwrites it (RC review 1 #1):
    // null, and the caller re-reads or retries
    const third = await writeSnapshot(rt, organizationId, active("pro"), {
      previous: null,
      adapter,
    });
    expect(third).toBeNull();
    expect(await readSnapshot(rt, adapter, organizationId)).toMatchObject({
      version: 1,
      planKey: "team",
    });
    expect(await snapshotRows(auth, organizationId)).toHaveLength(1);
  });

  it("writeSnapshot sets the sync bookkeeping on every write", async () => {
    const { auth, rt, organizationId } = await setup();
    const { adapter } = await getContext(auth);
    const before = await setSnapshot(auth, organizationId, {
      syncState: "syncing",
      syncClaimedAt: new Date(),
      syncAttempts: 3,
      syncError: "boom",
    });
    const now = new Date("2030-03-03T00:00:00.000Z");
    rt.now = () => now;
    const row = await writeSnapshot(rt, organizationId, active("pro"), {
      previous: before,
      adapter,
    });
    expect(row).toMatchObject({
      syncedAt: now,
      nextSyncAt: new Date(now.getTime() + rt.options.maxAge),
      syncState: "idle",
      syncAttempts: 0,
      syncError: null,
      syncClaimedAt: null,
      updatedAt: now,
    });
  });
});

describe("stale snapshots (compliance 5.4)", () => {
  async function staleSetup(handler?: (promise: Promise<unknown>) => void) {
    const ctx = await setup(
      handler
        ? { authOptions: { advanced: { backgroundTasks: { handler } } } }
        : {},
    );
    const stale = ctx.rt.options.maxAge;
    const row = await setSnapshot(ctx.auth, ctx.organizationId, {
      ...active("pro"),
      syncedAt: new Date(Date.now() - stale - HOUR),
    });
    ctx.source.states.set(ctx.organizationId, active("team"));
    return { ...ctx, row };
  }

  it("with a background-task handler: served stale, refreshed through runInBackground exactly once", async () => {
    const tasks: Promise<unknown>[] = [];
    const handler = vi.fn((promise: Promise<unknown>) => {
      tasks.push(promise);
    });
    const { auth, source, organizationId, api } = await staleSetup(handler);
    // hold the refresh's resolve until both reads returned, so the second
    // read sees the refresh still running
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = source.resolve;
    source.resolve = async (id, ctx) => {
      await gate;
      return original(id, ctx);
    };
    handler.mockClear();
    tasks.length = 0;
    const a = await api.get(organizationId);
    const b = await api.get(organizationId);
    expect(a.plan.key).toBe("pro");
    expect(b.plan.key).toBe("pro");
    expect(handler).toHaveBeenCalledTimes(1);
    release();
    await Promise.all(tasks);
    expect(source.calls).toHaveLength(1);
    expect((await snapshotRows(auth, organizationId))[0]?.planKey).toBe("team");
    expect((await api.get(organizationId)).plan.key).toBe("team");
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("without a handler: served stale and marked due for the sweep (nextSyncAt = now, version unchanged), no resolve", async () => {
    const { auth, rt, source, organizationId, row, api } = await staleSetup();
    const now = new Date();
    rt.now = () => now;
    expect((await api.get(organizationId)).plan.key).toBe("pro");
    expect(source.calls).toHaveLength(0);
    const [after] = await snapshotRows(auth, organizationId);
    expect(after?.nextSyncAt).toEqual(now);
    expect(after?.version).toBe(row.version);
    expect(after?.planKey).toBe("pro");
  });

  it("a fresh snapshot is neither refreshed nor marked", async () => {
    const handler = vi.fn();
    const ctx = await setup({
      authOptions: { advanced: { backgroundTasks: { handler } } },
    });
    const row = await setSnapshot(ctx.auth, ctx.organizationId, active("pro"));
    handler.mockClear();
    await ctx.api.get(ctx.organizationId);
    expect(handler).not.toHaveBeenCalled();
    expect((await snapshotRows(ctx.auth, ctx.organizationId))[0]).toMatchObject(
      {
        nextSyncAt: row.nextSyncAt,
        version: row.version,
      },
    );
  });
});

describe("cache", () => {
  it("serves a cached state until invalidate, and sync clears the entry", async () => {
    const { auth, rt, source, organizationId, api } = await setup({
      options: { cacheTtlMs: 30_000 },
    });
    await setSnapshot(auth, organizationId, active("pro"));
    expect((await api.get(organizationId)).plan.key).toBe("pro");
    expect(rt.cache.get(organizationId)?.result.plan.key).toBe("pro");
    await setSnapshot(auth, organizationId, active("team"));
    expect((await api.get(organizationId)).plan.key).toBe("pro");
    await api.invalidate(organizationId);
    expect((await api.get(organizationId)).plan.key).toBe("team");
    source.states.set(organizationId, active("legacy"));
    expect((await api.sync(organizationId)).plan.key).toBe("pro");
    expect((await api.get(organizationId)).plan.key).toBe("pro");
    // bypassCache reads fresh
    await setSnapshot(auth, organizationId, active("team"));
    expect(
      (await resolveState(rt, organizationId, { bypassCache: true })).result
        .plan.key,
    ).toBe("team");
  });

  it("is an LRU with a TTL; ttlMs 0 turns it off", () => {
    vi.useFakeTimers();
    const state = (id: string) =>
      ({ result: { organizationId: id } }) as unknown as ResolvedState;
    const cache = createCache({ ttlMs: 1000, maxEntries: 2 });
    cache.set("a", state("a"));
    cache.set("b", state("b"));
    expect(cache.get("a")).toBeDefined(); // a is now the most recent
    cache.set("c", state("c"));
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBeDefined();
    expect(cache.get("c")).toBeDefined();
    vi.advanceTimersByTime(1000);
    expect(cache.get("a")).toBeUndefined();
    cache.set("d", state("d"));
    cache.delete("d");
    expect(cache.get("d")).toBeUndefined();
    cache.set("e", state("e"));
    cache.clear();
    expect(cache.get("e")).toBeUndefined();
    const off = createCache({ ttlMs: 0, maxEntries: 10 });
    off.set("a", state("a"));
    expect(off.get("a")).toBeUndefined();
  });
});

describe("getMany", () => {
  it("[] runs no query; more than 1000 ids throws", async () => {
    const { auth, rt } = await setup();
    const { adapter } = await getContext(auth);
    const findMany = vi.spyOn(adapter, "findMany");
    const findOne = vi.spyOn(adapter, "findOne");
    expect(await resolveMany(rt, [])).toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
    expect(findOne).not.toHaveBeenCalled();
    await expect(
      resolveMany(
        rt,
        Array.from({ length: MAX_GET_MANY + 1 }, (_, i) => `org_${i}`),
      ),
    ).rejects.toThrow(
      "[@byo-oss/entitlements] getMany takes at most 1000 organization ids",
    );
  });

  it("answers one result per id in input order, reading snapshots and overrides in batches", async () => {
    const { auth, source, organizationId, api } = await setup();
    const orgs = [organizationId];
    for (let i = 0; i < 3; i++) orgs.push((await seedOrg(auth)).organizationId);
    const [a, b, c, d] = orgs as [string, string, string, string];
    await setSnapshot(auth, a, active("pro"));
    await setSnapshot(auth, b, active("team"));
    await seedOverride(auth, { organizationId: c, kind: "plan", key: "team" });
    await setSnapshot(auth, c, active("pro"));
    source.states.set(d, active("legacy")); // no snapshot yet: read-through
    const results = await api.getMany([d, a, "org_missing", b, a, c]);
    expect(results.map((r) => [r.organizationId, r.plan.key])).toEqual([
      [d, "pro"],
      [a, "pro"],
      ["org_missing", "free"],
      [b, "team"],
      [a, "pro"],
      [c, "team"],
    ]);
    expect(results.every((r) => !r.degraded)).toBe(true);
    expect(source.calls.map((call) => call.organizationId)).toEqual([d]);
    expect(await snapshotRows(auth, d)).toHaveLength(1);
    expect(await snapshotRows(auth, "org_missing")).toHaveLength(0);
  });

  it("reads 120 organizations within the in-list rules", async () => {
    const { auth, rt } = await setup();
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const { organizationId } = await seedOrg(auth);
      await setSnapshot(auth, organizationId, active("pro"));
      ids.push(organizationId);
    }
    const all = [
      ...ids,
      ...Array.from({ length: 117 }, (_, i) => `org_unknown_${i}`),
    ];
    const results = await resolveMany(rt, all);
    expect(results).toHaveLength(120);
    expect(results.slice(0, 3).map((r) => r.plan.key)).toEqual([
      "pro",
      "pro",
      "pro",
    ]);
  });
});

describe("syncOrganization", () => {
  it("resolves, writes, and returns fresh state", async () => {
    const { auth, rt, source, organizationId } = await setup();
    source.states.set(organizationId, active("team", { seats: 3 }));
    const state = await syncOrganization(rt, organizationId);
    expect(state.result.plan.key).toBe("team");
    expect(state.snapshot).toMatchObject({ planKey: "team", seats: 3 });
    expect(source.calls[0]?.adapter).toBe((await getContext(auth)).adapter);
  });

  it("throws for an id that isn't an organization and writes nothing", async () => {
    const { auth, rt, source } = await setup();
    await expect(syncOrganization(rt, "org_missing")).rejects.toThrow(
      "[@byo-oss/entitlements] syncOrganization: organization org_missing not found",
    );
    expect(source.calls).toHaveLength(0);
    expect(await snapshotRows(auth, "org_missing")).toHaveLength(0);
  });

  it("without a source writes nothing and resolves fresh", async () => {
    const auth = makeAuth();
    const rt = await getRuntime(auth);
    const { organizationId } = await seedOrg(auth);
    const state = await syncOrganization(rt, organizationId);
    expect(state.result.plan.key).toBe("free");
    expect(await snapshotRows(auth, organizationId)).toHaveLength(0);
  });
});

describe("cached results are read-only (RC review 1 #4)", () => {
  it("a result from the cache is deep-frozen: a mutation throws and the next caller sees the original", async () => {
    const { auth, rt, source, organizationId, api } = await setup({
      options: { cacheTtlMs: 30_000 },
    });
    source.states.set(organizationId, active("pro"));
    await seedOverride(auth, {
      organizationId,
      kind: "feature",
      key: "sso",
      value: true,
    });
    // the caller that fills the cache gets the frozen copy too
    const first = await api.get(organizationId);
    const second = await api.get(organizationId);
    expect(second).toBe(first);
    for (const result of [first, second]) {
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result.plan)).toBe(true);
      expect(Object.isFrozen(result.plan.display)).toBe(true);
      expect(Object.isFrozen(result.features)).toBe(true);
      expect(Object.isFrozen(result.limits)).toBe(true);
      expect(Object.isFrozen(result.overrides)).toBe(true);
      expect(Object.isFrozen(result.overrides[0])).toBe(true);
    }
    // test files are ES modules: strict mode, so writes throw
    expect(() => {
      (first.plan as { key: string }).key = "team";
    }).toThrow(TypeError);
    expect(() => {
      (first.features as Record<string, boolean>).prioritySupport = true;
    }).toThrow(TypeError);
    expect(() => {
      (first.limits as Record<string, unknown>).apiCalls = "unlimited";
    }).toThrow(TypeError);
    expect(() => {
      first.overrides.push({
        kind: "feature",
        key: "exports",
        expiresAt: null,
      });
    }).toThrow(TypeError);
    const state = rt.cache.get(organizationId);
    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(state?.snapshot)).toBe(true);
    const next = await api.get(organizationId);
    expect(next).toMatchObject({
      plan: { key: "pro" },
      features: { prioritySupport: false, sso: true },
      limits: { apiCalls: 50_000 },
    });
    expect(next.overrides).toHaveLength(1);
    // the catalog's own objects stay unfrozen
    expect(Object.isFrozen(testCatalog.plans.pro.limits)).toBe(false);
    expect(Object.isFrozen(testCatalog.plans.pro.display)).toBe(false);
    // and checks still read it
    expect((await api.hasFeature(organizationId, "exports")).allowed).toBe(
      true,
    );
  });

  it("getMany's results come from the same frozen states", async () => {
    const { source, organizationId, api } = await setup({
      options: { cacheTtlMs: 30_000 },
    });
    source.states.set(organizationId, active("team"));
    const [result] = await api.getMany([organizationId]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(await api.get(organizationId)).toBe(result);
  });
});

describe("syncOrganization: lost writes (RC review 1 #1)", () => {
  it("a write that loses to a concurrent writer retries with a fresh read and resolve, so the newer state wins", async () => {
    const { auth, rt, source, organizationId } = await setup();
    await setSnapshot(auth, organizationId, active("pro"));
    const { adapter } = await getContext(auth);
    const resolve = source.resolve;
    let calls = 0;
    source.resolve = async (id, ctx) => {
      calls += 1;
      const state = await resolve(id, ctx);
      if (calls === 1) {
        // another process stores newer state after this call's read
        const row = await readSnapshot(rt, adapter, id);
        await adapter.update({
          model: "entitlementSnapshot",
          where: [{ field: "id", value: row?.id as string }],
          update: { planKey: "team", version: (row?.version ?? 0) + 1 },
        });
        source.states.set(id, active("team"));
      }
      return state;
    };
    source.states.set(organizationId, active("pro", { seats: 2 }));
    const state = await syncOrganization(rt, organizationId);
    expect(calls).toBe(2);
    expect(state.result.plan.key).toBe("team");
    expect(await readSnapshot(rt, adapter, organizationId)).toMatchObject({
      planKey: "team",
      version: 2,
    });
  });

  it("retries a lost write 3 times (4 attempts), then throws; refreshEntitlements answers 503 and logs once", async () => {
    const { auth, rt, source, organizationId, owner } = await setup();
    const seeded = await setSnapshot(auth, organizationId, active("pro"));
    const { adapter } = await getContext(auth);
    const resolve = source.resolve;
    let calls = 0;
    source.resolve = async (id, ctx) => {
      calls += 1;
      const row = await readSnapshot(rt, adapter, id);
      // a writer that always lands between the read and the write
      await adapter.update({
        model: "entitlementSnapshot",
        where: [{ field: "id", value: seeded.id }],
        update: { version: (row?.version ?? 0) + 1 },
      });
      return resolve(id, ctx);
    };
    source.states.set(organizationId, active("team"));
    await expect(syncOrganization(rt, organizationId)).rejects.toThrow(
      "[@byo-oss/entitlements] syncOrganization: lost the snapshot write to concurrent writers",
    );
    expect(calls).toBe(4);
    expect((await readSnapshot(rt, adapter, organizationId))?.planKey).toBe(
      "pro",
    );

    const error = vi.fn();
    rt.logger = { ...rt.logger, error };
    calls = 0;
    await expect(
      auth.api.refreshEntitlements({
        body: { organizationId },
        headers: owner.headers,
      }),
    ).rejects.toMatchObject({ status: "SERVICE_UNAVAILABLE" });
    expect(calls).toBe(4);
    expect(error).toHaveBeenCalledTimes(1);
  });

  it("concurrent syncs in one process run one at a time; a call made during a run shares the next run", async () => {
    const { auth, rt, source, organizationId } = await setup();
    const { adapter } = await getContext(auth);
    const resolve = source.resolve;
    let open: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    let calls = 0;
    source.resolve = async (id, ctx) => {
      calls += 1;
      const state = await resolve(id, ctx);
      if (calls === 1) await gate;
      return state;
    };
    source.states.set(organizationId, active("pro"));
    const first = syncOrganization(rt, organizationId);
    await vi.waitFor(() => expect(calls).toBe(1));
    // the provider changes while the first sync holds the old state
    source.states.set(organizationId, active("team"));
    const later = Array.from({ length: 5 }, () =>
      syncOrganization(rt, organizationId),
    );
    open();
    const [a, ...rest] = await Promise.all([first, ...later]);
    expect(a?.result.plan.key).toBe("pro");
    for (const state of rest) expect(state.result.plan.key).toBe("team");
    // one run for the first call, one shared by the five that waited
    expect(calls).toBe(2);
    expect(await readSnapshot(rt, adapter, organizationId)).toMatchObject({
      planKey: "team",
      version: 1,
    });
    expect(rt.flights.size).toBe(0);
  });
});
