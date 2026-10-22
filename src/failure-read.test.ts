import { describe, expect, it, vi } from "vitest";
import { createEntitlements } from "./api";
import { type EntitlementsOptions, resolveOptions } from "./options";
import { resolveMany, resolveState, syncOrganization } from "./resolve";
import { createRuntime } from "./runtime";
import type { EntitlementSnapshotRow } from "./schema";
import {
  type AdapterCall,
  type AnyTestAuth,
  fakeSource,
  getContext,
  getRuntime,
  makeAuth,
  seedOrg,
  seedOverride,
  setSnapshot,
  testCatalog,
} from "./test-utils";

const HOUR = 3_600_000;

async function snapshotRows(auth: AnyTestAuth, organizationId: string) {
  const { adapter } = await getContext(auth);
  return adapter.findMany<EntitlementSnapshotRow>({
    model: "entitlementSnapshot",
    where: [{ field: "organizationId", value: organizationId }],
    limit: 10,
  });
}

/**
 * An auth with a fake source, the cache on, a spied `rt.logger.error`, and
 * an adapter that throws for calls matching `failing` while it is set.
 */
async function setup(options: Partial<EntitlementsOptions> = {}) {
  const source = fakeSource();
  const outage = new Error("database down");
  let failing: ((call: AdapterCall) => boolean) | null = null;
  const auth = makeAuth({
    options: { source, ...options },
    adapter: {
      before: (call) => {
        if (failing?.(call)) throw outage;
      },
    },
  });
  const rt = await getRuntime(auth);
  const error = vi.fn();
  rt.logger = { ...rt.logger, error };
  const { organizationId } = await seedOrg(auth);
  return {
    auth,
    rt,
    source,
    error,
    outage,
    organizationId,
    api: createEntitlements(auth, testCatalog),
    fail: (match: ((call: AdapterCall) => boolean) | null) => {
      failing = match;
    },
  };
}

describe("degraded reads (PRD #11, read half)", () => {
  it("a throwing source → degraded defaultPlan with error set, nothing persisted, one log line; overrides and the hook still apply", async () => {
    const resolveHook = vi.fn(() => ({ limits: { members: 9 } }));
    const { auth, rt, source, error, organizationId, api } = await setup({
      resolveEntitlements: resolveHook,
    });
    const failure = new Error("billing down");
    source.failWith = failure;
    await seedOverride(auth, {
      organizationId,
      kind: "feature",
      key: "sso",
      value: true,
    });
    const result = await api.get(organizationId);
    expect(result).toMatchObject({
      organizationId,
      degraded: true,
      plan: { key: "free", source: "default" },
      status: null,
      periodEnd: null,
      cancelAtPeriodEnd: false,
    });
    expect(result.features.sso).toBe(true);
    expect(result.limits.members).toBe(9);
    expect(result.overrides).toEqual([
      { kind: "feature", key: "sso", expiresAt: null },
    ]);
    expect(resolveHook).toHaveBeenCalledWith(
      expect.objectContaining({ plan: "free", snapshot: null }),
    );
    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(expect.any(String), failure);
    expect(await snapshotRows(auth, organizationId)).toHaveLength(0);

    // the state the checks read carries the error, and nothing was cached
    expect(rt.cache.get(organizationId)).toBeUndefined();
    const state = await resolveState(rt, organizationId);
    expect(state).toMatchObject({
      snapshot: null,
      entitled: false,
      error: failure,
    });
    expect(error).toHaveBeenCalledTimes(2);

    // once the source answers, the next read is normal and persists
    source.failWith = null;
    source.states.set(organizationId, { planKey: "pro", status: "active" });
    expect(await api.get(organizationId)).toMatchObject({
      degraded: false,
      plan: { key: "pro" },
    });
    expect(error).toHaveBeenCalledTimes(2);
    expect(await snapshotRows(auth, organizationId)).toHaveLength(1);
  });

  it("a throwing adapter on the snapshot read → degraded, one log line, nothing persisted", async () => {
    const { auth, error, outage, organizationId, api, fail } = await setup();
    fail((call) => call.model === "entitlementSnapshot");
    const result = await api.get(organizationId);
    expect(result).toMatchObject({ degraded: true, plan: { key: "free" } });
    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(expect.any(String), outage);
    fail(null);
    expect(await snapshotRows(auth, organizationId)).toHaveLength(0);
  });

  it("a throwing snapshot create → degraded, nothing persisted, one log line", async () => {
    const { auth, rt, error, outage, organizationId, fail } = await setup();
    fail(
      (call) =>
        call.model === "entitlementSnapshot" && call.method === "create",
    );
    const state = await resolveState(rt, organizationId);
    expect(state.result.degraded).toBe(true);
    expect(state.error).toBe(outage);
    expect(error).toHaveBeenCalledTimes(1);
    fail(null);
    expect(await snapshotRows(auth, organizationId)).toHaveLength(0);
  });

  it("a throwing override read degrades a billed plan to defaultPlan", async () => {
    const { auth, error, organizationId, api, fail } = await setup();
    await setSnapshot(auth, organizationId, {
      planKey: "pro",
      status: "active",
    });
    fail((call) => call.model === "entitlementOverride");
    const result = await api.get(organizationId);
    expect(result).toMatchObject({
      degraded: true,
      plan: { key: "free", source: "default" },
      status: null,
      overrides: [],
    });
    expect(error).toHaveBeenCalledTimes(1);
  });

  it("a throwing isEntitled degrades once", async () => {
    const failure = new Error("rule broke");
    const { auth, error, organizationId, api } = await setup({
      isEntitled: () => {
        throw failure;
      },
    });
    await setSnapshot(auth, organizationId, {
      planKey: "pro",
      status: "active",
    });
    const result = await api.get(organizationId);
    expect(result).toMatchObject({ degraded: true, plan: { key: "free" } });
    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(expect.any(String), failure);
  });

  it("a throwing hook on a billed plan answers defaultPlan without the hook, logged once", async () => {
    const failure = new Error("hook down");
    const { auth, error, organizationId, api } = await setup({
      resolveEntitlements: () => {
        throw failure;
      },
    });
    await setSnapshot(auth, organizationId, {
      planKey: "team",
      status: "active",
    });
    await seedOverride(auth, { organizationId, kind: "plan", key: "pro" });
    const result = await api.get(organizationId);
    expect(result).toMatchObject({
      degraded: true,
      plan: { key: "free", source: "default" },
      overrides: [],
    });
    expect(result.features).toEqual(testCatalog.plans.free.features);
    expect(result.limits).toEqual(testCatalog.plans.free.limits);
    expect(error).toHaveBeenCalledTimes(1);
  });

  it("before init, a read degrades instead of throwing", async () => {
    const rt = createRuntime(resolveOptions({ catalog: testCatalog }));
    const error = vi.fn();
    rt.logger = { ...rt.logger, error };
    const state = await resolveState(rt, "org_1");
    expect(state.result.degraded).toBe(true);
    expect(error).toHaveBeenCalledTimes(1);
  });
});

describe("getMany failures", () => {
  it("a failed batch read degrades every organization it covered and logs once", async () => {
    const { auth, rt, error, outage, organizationId, fail } = await setup();
    const other = (await seedOrg(auth)).organizationId;
    await setSnapshot(auth, organizationId, {
      planKey: "pro",
      status: "active",
    });
    await setSnapshot(auth, other, { planKey: "team", status: "active" });
    fail(
      (call) =>
        call.model === "entitlementSnapshot" && call.method === "findMany",
    );
    const results = await resolveMany(rt, [organizationId, other]);
    expect(results.map((r) => [r.degraded, r.plan.key])).toEqual([
      [true, "free"],
      [true, "free"],
    ]);
    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(expect.any(String), outage);
    expect(rt.cache.get(organizationId)).toBeUndefined();
  });

  it("a source throw degrades only the organization that read through", async () => {
    const { auth, rt, source, error, organizationId } = await setup();
    const other = (await seedOrg(auth)).organizationId;
    await setSnapshot(auth, organizationId, {
      planKey: "pro",
      status: "active",
    });
    source.failWith = new Error("billing down");
    const results = await resolveMany(rt, [organizationId, other]);
    expect(results.map((r) => [r.degraded, r.plan.key])).toEqual([
      [false, "pro"],
      [true, "free"],
    ]);
    expect(error).toHaveBeenCalledTimes(1);
    expect(await snapshotRows(auth, other)).toHaveLength(0);
  });
});

describe("sync failures", () => {
  it("syncOrganization throws a source failure, persists nothing and doesn't log", async () => {
    const { auth, rt, source, error, organizationId } = await setup();
    const failure = new Error("billing down");
    source.failWith = failure;
    await expect(syncOrganization(rt, organizationId)).rejects.toBe(failure);
    expect(error).not.toHaveBeenCalled();
    expect(await snapshotRows(auth, organizationId)).toHaveLength(0);
  });

  it("syncOrganization throws a database failure and keeps the old row", async () => {
    const { auth, rt, source, error, outage, organizationId, fail } =
      await setup();
    const before = await setSnapshot(auth, organizationId, {
      planKey: "pro",
      status: "active",
    });
    source.states.set(organizationId, { planKey: "team", status: "active" });
    fail(
      (call) =>
        call.model === "entitlementSnapshot" && call.method === "incrementOne",
    );
    await expect(syncOrganization(rt, organizationId)).rejects.toBe(outage);
    fail(null);
    expect(error).not.toHaveBeenCalled();
    expect((await snapshotRows(auth, organizationId))[0]).toMatchObject({
      planKey: "pro",
      version: before.version,
    });
  });

  it("a failed background refresh is logged once and never reaches the reader", async () => {
    const tasks: Promise<unknown>[] = [];
    const source = fakeSource();
    const auth = makeAuth({
      options: { source, cacheTtlMs: 0 },
      authOptions: {
        advanced: {
          backgroundTasks: {
            handler: (promise) => {
              tasks.push(promise);
            },
          },
        },
      },
    });
    const rt = await getRuntime(auth);
    const error = vi.fn();
    rt.logger = { ...rt.logger, error };
    const { organizationId } = await seedOrg(auth);
    await setSnapshot(auth, organizationId, {
      planKey: "pro",
      status: "active",
      syncedAt: new Date(Date.now() - rt.options.maxAge - HOUR),
    });
    const failure = new Error("billing down");
    source.failWith = failure;
    tasks.length = 0;
    const result = await createEntitlements(auth, testCatalog).get(
      organizationId,
    );
    expect(result).toMatchObject({ degraded: false, plan: { key: "pro" } });
    expect(tasks).toHaveLength(1);
    await expect(Promise.all(tasks)).resolves.toBeDefined();
    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(expect.any(String), failure);
  });
});
