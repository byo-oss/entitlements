import { runWithTransaction } from "@better-auth/core/context";
import { afterEach, describe, expect, it } from "vitest";
import { createEntitlements } from "./api";
import { createSqlTestAuth } from "./test-sql";
import {
  expectNoOuterCalls,
  getContext,
  getRuntime,
  seedOrg,
  seedUsage,
  testCatalog,
} from "./test-utils";
import { inTransaction } from "./txn";

// PRD #15, N04's half, on PGlite + Kysely (G17: expectNoOuterCalls is the
// evidence with real transactions; without them, detection reads false)

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

async function setup(transaction: boolean) {
  const sql = await createSqlTestAuth({
    transaction,
    options: {
      cacheTtlMs: 0,
      resolveEntitlements: () => ({ limits: { apiCalls: 10 } }),
    },
  });
  closers.push(sql.close);
  const context = await getContext(sql.auth);
  const rt = await getRuntime(sql.auth);
  const { organizationId } = await seedOrg(sql.auth);
  const usageRows = async () =>
    (
      await sql.db
        .selectFrom("entitlementUsage")
        .selectAll()
        .where("organizationId", "=", organizationId)
        .execute()
    ).length;
  return {
    ...sql,
    context,
    rt,
    api: createEntitlements(sql.auth, testCatalog),
    organizationId,
    usageRows,
  };
}

describe("checks inside a caller's transaction (SQL, real transactions)", () => {
  it("consumeUsage throws the documented error and writes nothing", async () => {
    const t = await setup(true);
    await expectNoOuterCalls(t.auth, async () => {
      expect(await inTransaction(t.rt)).toBe(true);
      await expect(
        t.api.consumeUsage(t.organizationId, "apiCalls"),
      ).rejects.toThrow(
        "[@byo-oss/entitlements] consumeUsage must run outside a transaction",
      );
    });
    expect(await t.usageRows()).toBe(0);
    expect(
      await t.api.consumeUsage(t.organizationId, "apiCalls"),
    ).toMatchObject({ allowed: true, used: 1 });
  });

  it("getLimit, hasFeature and checkCapacity work and create no bucket", async () => {
    const t = await setup(true);
    const [limit, feature, capacity] = await expectNoOuterCalls(
      t.auth,
      async () => [
        await t.api.getLimit(t.organizationId, "apiCalls"),
        await t.api.hasFeature(t.organizationId, "exports"),
        await t.api.checkCapacity(t.organizationId, "members", { count: 1 }),
      ],
    );
    expect(limit).toMatchObject({ used: 0, remaining: 10, degraded: false });
    expect(feature).toMatchObject({ allowed: false, reason: "not_in_plan" });
    expect(capacity).toMatchObject({ allowed: true, reason: "ok" });
    expect(await t.usageRows()).toBe(0);

    await seedUsage(t.auth, {
      organizationId: t.organizationId,
      key: "apiCalls",
      used: 3,
    });
    expect(
      await expectNoOuterCalls(t.auth, () =>
        t.api.getLimit(t.organizationId, "apiCalls"),
      ),
    ).toMatchObject({ used: 3, remaining: 7 });
    expect(await t.usageRows()).toBe(1);
  });
});

describe("checks on Kysely without real transactions (transaction: false)", () => {
  it("detection reads false inside runWithTransaction and consumeUsage works", async () => {
    const t = await setup(false);
    const results = await runWithTransaction(t.context.adapter, async () => {
      expect(await inTransaction(t.rt)).toBe(false);
      return [
        await t.api.consumeUsage(t.organizationId, "apiCalls", { amount: 4 }),
        await t.api.consumeUsage(t.organizationId, "apiCalls", { amount: 7 }),
        await t.api.getLimit(t.organizationId, "apiCalls"),
      ];
    });
    expect(results[0]).toMatchObject({ allowed: true, used: 4 });
    expect(results[1]).toMatchObject({
      allowed: false,
      reason: "limit_reached",
      used: 4,
      firstRefusal: true,
    });
    expect(results[2]).toMatchObject({ used: 4, remaining: 6 });
    expect(await t.usageRows()).toBe(1);
  });
});
