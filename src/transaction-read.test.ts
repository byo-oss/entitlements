import { describe, expect, it, vi } from "vitest";
import { createEntitlements } from "./api";
import { resolveMany, resolveState, syncOrganization } from "./resolve";
import type { EntitlementSnapshotRow } from "./schema";
import {
  type AnyTestAuth,
  expectNoOuterCalls,
  fakeSource,
  getContext,
  getRuntime,
  makeAuth,
  seedOrg,
  seedOverride,
  setSnapshot,
  testCatalog,
} from "./test-utils";
import { inTransaction } from "./txn";

const HOUR = 3_600_000;

async function snapshotRows(auth: AnyTestAuth, organizationId: string) {
  const { adapter } = await getContext(auth);
  return adapter.findMany<EntitlementSnapshotRow>({
    model: "entitlementSnapshot",
    where: [{ field: "organizationId", value: organizationId }],
    limit: 10,
  });
}

/** Memory lane, with a background-task handler so a scheduled refresh would show. */
async function setup() {
  const source = fakeSource();
  const handler = vi.fn();
  const auth = makeAuth({
    options: { source },
    authOptions: { advanced: { backgroundTasks: { handler } } },
  });
  const rt = await getRuntime(auth);
  const context = await getContext(auth);
  const { organizationId } = await seedOrg(auth);
  handler.mockClear();
  return {
    auth,
    rt,
    context,
    source,
    handler,
    organizationId,
    api: createEntitlements(auth, testCatalog),
  };
}

describe("reads inside a transaction (PRD #15, N03 half, memory)", () => {
  it("a missing snapshot resolves through the transaction, persists nothing and fills no cache", async () => {
    const { auth, rt, context, source, organizationId, api } = await setup();
    source.states.set(organizationId, { planKey: "pro", status: "active" });
    const result = await expectNoOuterCalls(auth, async () => {
      expect(await inTransaction(rt)).toBe(true);
      return api.get(organizationId);
    });
    expect(result).toMatchObject({
      degraded: false,
      plan: { key: "pro", source: "billing" },
      status: "active",
    });
    expect(source.calls).toHaveLength(1);
    expect(source.calls[0]?.adapter).not.toBe(context.adapter);
    expect(await snapshotRows(auth, organizationId)).toHaveLength(0);
    expect(rt.cache.get(organizationId)).toBeUndefined();
    // outside, the same read persists it
    expect((await api.get(organizationId)).plan.key).toBe("pro");
    expect(await snapshotRows(auth, organizationId)).toHaveLength(1);
  });

  it("a stale snapshot is served without scheduling a refresh or marking it due", async () => {
    const { auth, rt, source, handler, organizationId, api } = await setup();
    const row = await setSnapshot(auth, organizationId, {
      planKey: "pro",
      status: "active",
      syncedAt: new Date(Date.now() - rt.options.maxAge - HOUR),
    });
    source.states.set(organizationId, { planKey: "team", status: "active" });
    const result = await expectNoOuterCalls(auth, () =>
      api.get(organizationId),
    );
    expect(result.plan.key).toBe("pro");
    expect(handler).not.toHaveBeenCalled();
    expect(source.calls).toHaveLength(0);
    const [after] = await snapshotRows(auth, organizationId);
    expect(after).toMatchObject({
      version: row.version,
      nextSyncAt: row.nextSyncAt,
      updatedAt: row.updatedAt,
    });
    expect(rt.cache.get(organizationId)).toBeUndefined();
  });

  it("reads the cache but never writes it", async () => {
    const { auth, rt, organizationId, api } = await setup();
    await setSnapshot(auth, organizationId, {
      planKey: "pro",
      status: "active",
    });
    expect((await api.get(organizationId)).plan.key).toBe("pro");
    const cached = rt.cache.get(organizationId);
    expect(cached).toBeDefined();
    // a change the cache doesn't know about yet
    await setSnapshot(auth, organizationId, {
      planKey: "team",
      status: "active",
    });
    const inside = await expectNoOuterCalls(auth, async () => ({
      cached: await api.get(organizationId),
      fresh: await resolveState(rt, organizationId, { bypassCache: true }),
    }));
    expect(inside.cached.plan.key).toBe("pro");
    expect(inside.fresh.result.plan.key).toBe("team");
    expect(rt.cache.get(organizationId)).toBe(cached);
  });

  it("an unknown organization answers defaultPlan without calling the source", async () => {
    const { auth, source } = await setup();
    const api = createEntitlements(auth, testCatalog);
    const result = await expectNoOuterCalls(auth, () => api.get("org_missing"));
    expect(result).toMatchObject({ degraded: false, plan: { key: "free" } });
    expect(source.calls).toHaveLength(0);
  });

  it("getMany works inside and persists nothing", async () => {
    const { auth, rt, source, organizationId } = await setup();
    const other = (await seedOrg(auth)).organizationId;
    await setSnapshot(auth, organizationId, {
      planKey: "team",
      status: "active",
    });
    await seedOverride(auth, {
      organizationId,
      kind: "feature",
      key: "exports",
      value: false,
    });
    source.states.set(other, { planKey: "legacy", status: "trialing" });
    const results = await expectNoOuterCalls(auth, () =>
      resolveMany(rt, [organizationId, other]),
    );
    expect(results.map((r) => r.plan.key)).toEqual(["team", "pro"]);
    expect(results[0]?.features.exports).toBe(false);
    expect(await snapshotRows(auth, other)).toHaveLength(0);
    expect(rt.cache.get(organizationId)).toBeUndefined();
    expect(rt.cache.get(other)).toBeUndefined();
  });

  it("sync and syncOrganization throw the documented error and write nothing", async () => {
    const { auth, rt, source, organizationId, api } = await setup();
    source.states.set(organizationId, { planKey: "pro", status: "active" });
    const message =
      "[@byo-oss/entitlements] sync must run outside a transaction";
    await expect(
      expectNoOuterCalls(auth, () => syncOrganization(rt, organizationId)),
    ).rejects.toThrow(message);
    await expect(
      expectNoOuterCalls(auth, () => api.sync(organizationId)),
    ).rejects.toThrow(message);
    expect(source.calls).toHaveLength(0);
    expect(await snapshotRows(auth, organizationId)).toHaveLength(0);
  });
});
