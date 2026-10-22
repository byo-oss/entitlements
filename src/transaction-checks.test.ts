import { describe, expect, it } from "vitest";
import { createEntitlements } from "./api";
import { bucketKey } from "./period";
import {
  expectNoOuterCalls,
  getContext,
  getRuntime,
  makeAuth,
  seedOrg,
  seedUsage,
  testCatalog,
} from "./test-utils";
import { inTransaction } from "./txn";

// PRD #15, N04's half, memory lane (G17: expectNoOuterCalls is the evidence)

async function setup() {
  const auth = makeAuth({
    options: {
      cacheTtlMs: 0,
      resolveEntitlements: () => ({ limits: { apiCalls: 10 } }),
    },
  });
  const context = await getContext(auth);
  const rt = await getRuntime(auth);
  const { organizationId } = await seedOrg(auth);
  const usageRows = () =>
    context.adapter.count({
      model: "entitlementUsage",
      where: [{ field: "organizationId", value: organizationId }],
    });
  return {
    auth,
    rt,
    api: createEntitlements(auth, testCatalog),
    organizationId,
    usageRows,
  };
}

describe("checks inside a caller's transaction (memory)", () => {
  it("consumeUsage throws the documented error and writes nothing", async () => {
    const t = await setup();
    await expectNoOuterCalls(t.auth, async () => {
      expect(await inTransaction(t.rt)).toBe(true);
      await expect(
        t.api.consumeUsage(t.organizationId, "apiCalls"),
      ).rejects.toThrow(
        "[@byo-oss/entitlements] consumeUsage must run outside a transaction",
      );
    });
    expect(await t.usageRows()).toBe(0);
    // outside the transaction it works
    expect(
      await t.api.consumeUsage(t.organizationId, "apiCalls"),
    ).toMatchObject({ allowed: true, used: 1 });
  });

  it("getLimit reads the counter through the transaction and creates no bucket", async () => {
    const t = await setup();
    const empty = await expectNoOuterCalls(t.auth, () =>
      t.api.getLimit(t.organizationId, "apiCalls"),
    );
    expect(empty).toMatchObject({
      allowed: true,
      degraded: false,
      used: 0,
      remaining: 10,
    });
    expect(await t.usageRows()).toBe(0);
    await seedUsage(t.auth, {
      organizationId: t.organizationId,
      key: "apiCalls",
      used: 4,
    });
    expect(
      await expectNoOuterCalls(t.auth, () =>
        t.api.getLimit(t.organizationId, "apiCalls"),
      ),
    ).toMatchObject({ used: 4, remaining: 6, degraded: false });
    expect(await t.usageRows()).toBe(1);
  });

  it("hasFeature and checkCapacity work inside a transaction", async () => {
    const t = await setup();
    const [feature, capacity, value] = await expectNoOuterCalls(
      t.auth,
      async () => [
        await t.api.hasFeature(t.organizationId, "exports"),
        await t.api.checkCapacity(t.organizationId, "members", { count: 1 }),
        await t.api.getLimit(t.organizationId, "retentionDays"),
      ],
    );
    expect(feature).toMatchObject({ allowed: false, reason: "not_in_plan" });
    expect(capacity).toMatchObject({ allowed: true, reason: "ok" });
    expect(value).toMatchObject({ limit: 7, degraded: false });
    expect(await t.usageRows()).toBe(0);
  });

  it("the bucket key is the documented format", () => {
    expect(
      bucketKey("org_1", "apiCalls", new Date("2026-03-10T00:00:00.000Z")),
    ).toBe("org_1:apiCalls:2026-03-10T00:00:00.000Z");
  });
});
