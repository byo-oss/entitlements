import { runWithTransaction } from "@better-auth/core/context";
import { afterEach, describe, expect, it } from "vitest";
import { createEntitlements } from "./api";
import { createSqlTestAuth } from "./test-sql";
import {
  expectNoOuterCalls,
  fakeSource,
  getContext,
  getRuntime,
  seedOrg,
  seedOverride,
  seedStaff,
  testCatalog,
} from "./test-utils";
import { inTransaction } from "./txn";

// PRD #15, N06's half, on PGlite + Kysely. With real transactions the G17
// evidence is `expectNoOuterCalls`; without them, detection reads false
// and the endpoint works.

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

async function setup(transaction = true) {
  const source = fakeSource();
  const sql = await createSqlTestAuth({
    transaction,
    options: { source, staffOrganizationId: "org_staff" },
  });
  closers.push(sql.close);
  const rt = await getRuntime(sql.auth);
  const context = await getContext(sql.auth);
  const { staff } = await seedStaff(sql.auth, "org_staff");
  const { organizationId, owner } = await seedOrg(sql.auth);
  const count = async (table: string) =>
    (
      await sql.db
        .selectFrom(table)
        .selectAll()
        .where("organizationId", "=", organizationId)
        .execute()
    ).length;
  return {
    ...sql,
    rt,
    context,
    source,
    staff,
    owner,
    organizationId,
    api: createEntitlements(sql.auth, testCatalog),
    snapshots: () => count("entitlementSnapshot"),
    overrides: () => count("entitlementOverride"),
  };
}

class Rollback extends Error {}

describe("inside a caller's transaction (SQL, real transactions)", () => {
  it("hasFeature, getLimit and checkCapacity finish with a missing snapshot and leave no snapshot row", async () => {
    const t = await setup();
    t.source.states.set(t.organizationId, {
      planKey: "team",
      status: "active",
    });
    const [feature, limit, capacity] = await expectNoOuterCalls(
      t.auth,
      async () => {
        expect(await inTransaction(t.rt)).toBe(true);
        return [
          await t.api.hasFeature(t.organizationId, "sso"),
          await t.api.getLimit(t.organizationId, "uploads"),
          await t.api.checkCapacity(t.organizationId, "members", {
            count: 100,
          }),
        ] as const;
      },
    );
    expect(feature).toMatchObject({ allowed: true, plan: "team" });
    expect(limit).toMatchObject({ limit: "unlimited", degraded: false });
    expect(capacity).toMatchObject({ allowed: true, limit: 500 });
    expect(t.source.calls.length).toBeGreaterThan(0);
    expect(await t.snapshots()).toBe(0);
    expect(t.rt.cache.get(t.organizationId)).toBeUndefined();
    expect((await t.api.get(t.organizationId)).plan.key).toBe("team");
    expect(await t.snapshots()).toBe(1);
  });

  it("refreshEntitlements throws the documented error and writes nothing", async () => {
    const t = await setup();
    t.source.states.set(t.organizationId, { planKey: "pro", status: "active" });
    await expectNoOuterCalls(t.auth, async () => {
      await expect(
        t.auth.api.refreshEntitlements({
          body: { organizationId: t.organizationId },
          headers: t.owner.headers,
        }),
      ).rejects.toThrow(
        "[@byo-oss/entitlements] refreshEntitlements must run outside a transaction",
      );
    });
    expect(t.source.calls).toHaveLength(0);
    expect(await t.snapshots()).toBe(0);
    const fresh = await t.auth.api.refreshEntitlements({
      body: { organizationId: t.organizationId },
      headers: t.owner.headers,
    });
    expect(fresh.plan.key).toBe("pro");
    expect(await t.snapshots()).toBe(1);
  });

  it("an override set inside a rolled-back transaction leaves no row and no cached leak", async () => {
    const t = await setup();
    expect(await t.api.hasFeature(t.organizationId, "sso")).toMatchObject({
      allowed: false,
    });
    expect(t.rt.cache.get(t.organizationId)).toBeDefined();
    await expect(
      expectNoOuterCalls(t.auth, async () => {
        await t.auth.api.setEntitlementOverride({
          body: {
            organizationId: t.organizationId,
            kind: "feature",
            key: "sso",
            value: true,
            reason: "pilot",
          },
          headers: t.staff.admin.headers,
        });
        expect(await t.api.hasFeature(t.organizationId, "sso")).toMatchObject({
          allowed: true,
        });
        throw new Rollback("roll back");
      }),
    ).rejects.toBeInstanceOf(Rollback);
    expect(await t.overrides()).toBe(0);
    expect(t.rt.cache.get(t.organizationId)?.result.features.sso).not.toBe(
      true,
    );
    expect(await t.api.hasFeature(t.organizationId, "sso")).toMatchObject({
      allowed: false,
      reason: "not_in_plan",
    });
  });

  it("an override removed inside a rolled-back transaction stays active", async () => {
    const t = await setup();
    const row = await seedOverride(t.auth, {
      organizationId: t.organizationId,
      kind: "limit",
      key: "projects",
      value: 9,
    });
    expect(await t.api.getLimit(t.organizationId, "projects")).toMatchObject({
      limit: 9,
    });
    await expect(
      expectNoOuterCalls(t.auth, async () => {
        await t.auth.api.removeEntitlementOverride({
          body: { id: row.id },
          headers: t.staff.admin.headers,
        });
        throw new Rollback("roll back");
      }),
    ).rejects.toBeInstanceOf(Rollback);
    const [stored] = await t.db
      .selectFrom("entitlementOverride")
      .selectAll()
      .where("id", "=", row.id)
      .execute();
    expect(stored).toMatchObject({ status: "active", removedBy: null });
    expect(await t.api.getLimit(t.organizationId, "projects")).toMatchObject({
      limit: 9,
    });
  });
});

describe("on Kysely without real transactions (transaction: false)", () => {
  it("detection reads false and refreshEntitlements and override writes work", async () => {
    const t = await setup(false);
    t.source.states.set(t.organizationId, { planKey: "pro", status: "active" });
    const fresh = await runWithTransaction(t.context.adapter, async () => {
      expect(await inTransaction(t.rt)).toBe(false);
      await t.auth.api.setEntitlementOverride({
        body: {
          organizationId: t.organizationId,
          kind: "feature",
          key: "sso",
          value: true,
          reason: "pilot",
        },
        headers: t.staff.admin.headers,
      });
      return t.auth.api.refreshEntitlements({
        body: { organizationId: t.organizationId },
        headers: t.owner.headers,
      });
    });
    expect(fresh).toMatchObject({
      plan: { key: "pro" },
      features: { sso: true },
    });
    expect(await t.snapshots()).toBe(1);
    expect(await t.overrides()).toBe(1);
  });
});
