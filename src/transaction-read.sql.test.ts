import { runWithTransaction } from "@better-auth/core/context";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createEntitlements } from "./api";
import { resolveMany, resolveState, syncOrganization } from "./resolve";
import { createSqlTestAuth } from "./test-sql";
import {
  expectNoOuterCalls,
  type FakeSource,
  fakeSource,
  getContext,
  getRuntime,
  seedOrg,
  seedOverride,
  setSnapshot,
  testCatalog,
} from "./test-utils";
import { inTransaction } from "./txn";

const HOUR = 3_600_000;

describe("reads inside a transaction (PRD #15, N03 half, PGlite)", () => {
  const source: FakeSource = fakeSource();
  const handler = vi.fn();
  let harness: Awaited<ReturnType<typeof createSqlTestAuth>>;

  const snapshotCount = async (organizationId: string) => {
    const { rows } = await sql<{ n: number }>`
      select count(*)::int as n from "entitlementSnapshot"
      where "organizationId" = ${organizationId}`.execute(harness.db);
    return rows[0]?.n;
  };

  beforeAll(async () => {
    harness = await createSqlTestAuth({
      options: { source },
      authOptions: { advanced: { backgroundTasks: { handler } } },
    });
  });
  afterAll(async () => {
    await harness?.close();
  });

  it("a missing snapshot resolves through the transaction, persists nothing and fills no cache", async () => {
    const { auth } = harness;
    const rt = await getRuntime(auth);
    const context = await getContext(auth);
    const { organizationId } = await seedOrg(auth);
    source.calls.length = 0;
    source.states.set(organizationId, { planKey: "pro", status: "active" });
    const api = createEntitlements(auth, testCatalog);
    const result = await expectNoOuterCalls(auth, async () => {
      expect(await inTransaction(rt)).toBe(true);
      return api.get(organizationId);
    });
    expect(result).toMatchObject({
      degraded: false,
      plan: { key: "pro", source: "billing" },
    });
    expect(source.calls).toHaveLength(1);
    expect(source.calls[0]?.adapter).not.toBe(context.adapter);
    expect(await snapshotCount(organizationId)).toBe(0);
    expect(rt.cache.get(organizationId)).toBeUndefined();
  });

  it("a stale snapshot schedules no refresh and isn't marked due", async () => {
    const { auth } = harness;
    const rt = await getRuntime(auth);
    const { organizationId } = await seedOrg(auth);
    const row = await setSnapshot(auth, organizationId, {
      planKey: "pro",
      status: "active",
      syncedAt: new Date(Date.now() - rt.options.maxAge - HOUR),
    });
    source.calls.length = 0;
    handler.mockClear();
    const result = await expectNoOuterCalls(auth, () =>
      resolveState(rt, organizationId),
    );
    expect(result.result.plan.key).toBe("pro");
    expect(handler).not.toHaveBeenCalled();
    expect(source.calls).toHaveLength(0);
    const { rows } = await sql<{ version: number; nextSyncAt: Date }>`
      select version, "nextSyncAt" from "entitlementSnapshot"
      where id = ${row.id}`.execute(harness.db);
    expect(rows[0]?.version).toBe(row.version);
    expect(new Date(rows[0]?.nextSyncAt as Date).getTime()).toBe(
      row.nextSyncAt.getTime(),
    );
  });

  it("getMany and an unknown organization work inside, persisting nothing", async () => {
    const { auth } = harness;
    const rt = await getRuntime(auth);
    const a = (await seedOrg(auth)).organizationId;
    const b = (await seedOrg(auth)).organizationId;
    await setSnapshot(auth, a, { planKey: "team", status: "active" });
    await seedOverride(auth, {
      organizationId: a,
      kind: "limit",
      key: "members",
      value: 3,
    });
    source.calls.length = 0;
    source.states.set(b, { planKey: "pro", status: "active" });
    const results = await expectNoOuterCalls(auth, () =>
      resolveMany(rt, [a, b, "org_missing"]),
    );
    expect(results.map((r) => [r.plan.key, r.degraded])).toEqual([
      ["team", false],
      ["pro", false],
      ["free", false],
    ]);
    expect(results[0]?.limits.members).toBe(3);
    expect(source.calls.map((c) => c.organizationId)).toEqual([b]);
    expect(await snapshotCount(b)).toBe(0);
  });

  it("sync throws the documented error and writes nothing", async () => {
    const { auth } = harness;
    const rt = await getRuntime(auth);
    const { organizationId } = await seedOrg(auth);
    source.calls.length = 0;
    await expect(
      expectNoOuterCalls(auth, () => syncOrganization(rt, organizationId)),
    ).rejects.toThrow(
      "[@byo-oss/entitlements] sync must run outside a transaction",
    );
    expect(source.calls).toHaveLength(0);
    expect(await snapshotCount(organizationId)).toBe(0);
  });

  it("outside a transaction, 50 parallel get on a missing snapshot write one row", async () => {
    const { auth } = harness;
    const { organizationId } = await seedOrg(auth);
    source.calls.length = 0;
    source.states.set(organizationId, { planKey: "team", status: "active" });
    const api = createEntitlements(auth, testCatalog);
    (await getRuntime(auth)).cache.clear();
    const results = await Promise.all(
      Array.from({ length: 50 }, () => api.get(organizationId)),
    );
    expect(results.every((r) => r.plan.key === "team")).toBe(true);
    expect(await snapshotCount(organizationId)).toBe(1);
    expect(source.calls).toHaveLength(1);
  });
});

describe("an adapter without real transactions (PGlite, transaction: false)", () => {
  it("detection reads false inside runWithTransaction, and read-through persists as outside", async () => {
    const source = fakeSource();
    const { auth, db, close } = await createSqlTestAuth({
      transaction: false,
      options: { source },
    });
    try {
      const rt = await getRuntime(auth);
      const { adapter } = await getContext(auth);
      const { organizationId } = await seedOrg(auth);
      source.states.set(organizationId, { planKey: "pro", status: "active" });
      const inside = await runWithTransaction(adapter, async () => ({
        detected: await inTransaction(rt),
        state: await resolveState(rt, organizationId),
        synced: await syncOrganization(rt, organizationId),
      }));
      expect(inside.detected).toBe(false);
      expect(inside.state.result.plan.key).toBe("pro");
      expect(inside.synced.result.plan.key).toBe("pro");
      const { rows } = await sql<{ n: number }>`
        select count(*)::int as n from "entitlementSnapshot"
        where "organizationId" = ${organizationId}`.execute(db);
      expect(rows[0]?.n).toBe(1);
    } finally {
      await close();
    }
  });
});
