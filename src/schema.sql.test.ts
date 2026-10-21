import { runWithTransaction } from "@better-auth/core/context";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSqlTestAuth } from "./test-sql";
import {
  expectNoOuterCalls,
  getContext,
  getRuntime,
  IN_TRANSACTION_PROBE_PATH,
  inTransactionProbe,
  seedOrg,
  takeStrictViolations,
} from "./test-utils";
import { currentAdapter, inTransaction } from "./txn";

const createHarness = () =>
  createSqlTestAuth({ plugins: [inTransactionProbe()] });

describe("schema on PGlite", () => {
  let harness: Awaited<ReturnType<typeof createHarness>>;

  beforeAll(async () => {
    harness = await createHarness();
  });
  afterAll(async () => {
    await harness?.close();
  });

  it("migrates the three tables", async () => {
    const tables = await sql<{ table_name: string }>`
      select table_name from information_schema.tables
      where table_schema = 'public' and table_name like 'entitlement%'
      order by table_name`.execute(harness.db);
    expect(tables.rows.map((r) => r.table_name)).toEqual([
      "entitlementOverride",
      "entitlementSnapshot",
      "entitlementUsage",
    ]);
  });

  it("creates both unique indexes", async () => {
    const indexes = await sql<{ tablename: string; indexdef: string }>`
      select tablename, indexdef from pg_indexes
      where schemaname = 'public' and tablename like 'entitlement%'`.execute(
      harness.db,
    );
    const unique = indexes.rows
      .filter((r) => /CREATE UNIQUE INDEX/i.test(r.indexdef))
      .map((r) => `${r.tablename}:${r.indexdef.match(/\(([^)]+)\)/)?.[1]}`)
      .filter((r) => !r.endsWith(":id"));
    expect(unique.sort()).toEqual([
      'entitlementSnapshot:"organizationId"',
      "entitlementUsage:bucket",
    ]);
  });

  it("rejects a second snapshot for one organization and a duplicate bucket", async () => {
    const { organizationId } = await seedOrg(harness.auth);
    const now = new Date();
    const snapshot = {
      organizationId,
      source: "none",
      cancelAtPeriodEnd: false,
      version: 0,
      syncedAt: now,
      nextSyncAt: now,
      syncState: "idle",
      syncAttempts: 0,
      createdAt: now,
      updatedAt: now,
    };
    const { adapter } = await getContext(harness.auth);
    await adapter.create({ model: "entitlementSnapshot", data: snapshot });
    await expect(
      adapter.create({ model: "entitlementSnapshot", data: snapshot }),
    ).rejects.toThrow();
    const usage = {
      bucket: `${organizationId}:apiCalls:${now.toISOString()}`,
      organizationId,
      key: "apiCalls",
      periodStart: now,
      periodEnd: now,
      used: 0,
      refused: 0,
      createdAt: now,
      updatedAt: now,
    };
    await adapter.create({ model: "entitlementUsage", data: usage });
    await expect(
      adapter.create({ model: "entitlementUsage", data: usage }),
    ).rejects.toThrow();
  });

  it("detects a transaction: true inside runWithTransaction, false outside", async () => {
    const rt = await getRuntime(harness.auth);
    const { adapter } = await getContext(harness.auth);
    expect(await inTransaction(rt)).toBe(false);
    const inside = await runWithTransaction(adapter, async () => ({
      detected: await inTransaction(rt),
      current: await currentAdapter(rt),
    }));
    expect(inside.detected).toBe(true);
    expect(inside.current).not.toBe(adapter);
    expect(await inTransaction(rt)).toBe(false);
  });

  it("detects a transaction: false in a plain auth.handler request", async () => {
    const response = await harness.auth.handler(
      new Request(`http://localhost:3000/api/auth${IN_TRANSACTION_PROBE_PATH}`),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ inTransaction: false });
    // the probe's endpoint is typed on auth.api, and reads true inside one
    const { adapter } = await getContext(harness.auth);
    expect(
      await runWithTransaction(adapter, () =>
        harness.auth.api.testInTransaction(),
      ),
    ).toEqual({ inTransaction: true });
  });

  it("negative control: expectNoOuterCalls catches a direct ctx.context.adapter call", async () => {
    const rt = await getRuntime(harness.auth);
    const { adapter } = await getContext(harness.auth);
    const { organizationId } = await seedOrg(harness.auth);
    const where = [{ field: "organizationId", value: organizationId }];
    // positive control: the current adapter is the transaction's
    await expect(
      expectNoOuterCalls(harness.auth, async () =>
        (await currentAdapter(rt)).findOne({
          model: "entitlementSnapshot",
          where,
        }),
      ),
    ).resolves.toBeNull();
    await expect(
      expectNoOuterCalls(harness.auth, async () => {
        await adapter.findOne({ model: "entitlementSnapshot", where });
      }),
    ).rejects.toThrow(
      /findOne on entitlementSnapshot ran on the outer adapter/,
    );
    expect(takeStrictViolations()).toHaveLength(1);
  });
});
