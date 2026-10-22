import { afterEach, describe, expect, it, vi } from "vitest";
import { createEntitlements } from "./api";
import type { LimitValue } from "./catalog";
import { bucketKey } from "./period";
import { createSqlTestAuth, type SqlTestAuthConfig } from "./test-sql";
import {
  type AdapterCall,
  getRuntime,
  seedOrg,
  seedUsage,
  testCatalog,
} from "./test-utils";

// PRD #12 (consume half) and #13 on PGlite + Kysely

const NOW = new Date("2026-03-10T12:00:00.000Z");
const DAY_START = new Date("2026-03-10T00:00:00.000Z");

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

async function setup(
  limits: Record<string, LimitValue>,
  config: SqlTestAuthConfig = {},
) {
  const onEvent = vi.fn();
  const sql = await createSqlTestAuth({
    ...config,
    options: {
      // limits change between calls: no cached resolution
      cacheTtlMs: 0,
      resolveEntitlements: () => ({ limits: { ...limits } }),
      onEvent,
      ...config.options,
    },
  });
  closers.push(sql.close);
  const rt = await getRuntime(sql.auth);
  let now = NOW;
  rt.now = () => new Date(now.getTime());
  const error = vi.fn();
  rt.logger = { ...rt.logger, error };
  const { organizationId } = await seedOrg(sql.auth);
  const rows = async () =>
    sql.db
      .selectFrom("entitlementUsage")
      .selectAll()
      .where("organizationId", "=", organizationId)
      .execute();
  return {
    ...sql,
    rt,
    api: createEntitlements(sql.auth, testCatalog),
    organizationId,
    onEvent,
    error,
    rows,
    setNow: (date: Date) => {
      now = date;
    },
  };
}

const limitEvents = (onEvent: ReturnType<typeof vi.fn>) =>
  onEvent.mock.calls.filter(
    (call) => call[0].type === "entitlements.usage.limit_reached",
  );

describe("consumeUsage on SQL", () => {
  it("50 parallel calls with limit 20 → exactly 20 allowed, used 20, 30 refused, one firstRefusal, one bucket row", async () => {
    const t = await setup({ apiCalls: 20 });
    const results = await Promise.all(
      Array.from({ length: 50 }, () =>
        t.api.consumeUsage(t.organizationId, "apiCalls"),
      ),
    );
    expect(results.filter((r) => r.allowed)).toHaveLength(20);
    expect(results.filter((r) => !r.allowed)).toHaveLength(30);
    expect(results.filter((r) => r.reason === "error")).toHaveLength(0);
    expect(results.filter((r) => r.firstRefusal)).toHaveLength(1);
    const rows = await t.rows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      bucket: bucketKey(t.organizationId, "apiCalls", DAY_START),
      used: 20,
      refused: 30,
    });
    expect(limitEvents(t.onEvent)).toHaveLength(1);
    expect(t.error).not.toHaveBeenCalled();
  });

  it("a create that loses the unique bucket re-reads the row and consumes from it", async () => {
    let raced = false;
    let seeding: Promise<unknown> | null = null;
    const holder: { seed?: () => Promise<unknown> } = {};
    const t = await setup(
      { apiCalls: 5 },
      {
        adapter: {
          before: async (call: AdapterCall) => {
            if (
              !raced &&
              call.method === "create" &&
              call.model === "entitlementUsage"
            ) {
              // another process creates the same bucket first
              raced = true;
              seeding = holder.seed?.() ?? null;
              await seeding;
            }
          },
        },
      },
    );
    holder.seed = () =>
      seedUsage(t.auth, {
        organizationId: t.organizationId,
        key: "apiCalls",
        used: 2,
      });
    const result = await t.api.consumeUsage(t.organizationId, "apiCalls");
    expect(raced).toBe(true);
    expect(seeding).not.toBeNull();
    expect(result).toMatchObject({ allowed: true, reason: "ok", used: 3 });
    const rows = await t.rows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ used: 3, refused: 0 });
    expect(t.error).not.toHaveBeenCalled();
  });

  it("refusals don't count, a 0 limit refuses and signals once, a new day starts a new bucket", async () => {
    const t = await setup({ apiCalls: 0, uploads: 2 });
    expect(
      await t.api.consumeUsage(t.organizationId, "apiCalls"),
    ).toMatchObject({ allowed: false, firstRefusal: true, used: 0 });
    expect(
      await t.api.consumeUsage(t.organizationId, "apiCalls"),
    ).toMatchObject({ allowed: false, firstRefusal: false, used: 0 });
    expect(limitEvents(t.onEvent)).toHaveLength(1);

    await t.api.consumeUsage(t.organizationId, "uploads", { amount: 2 });
    expect(await t.api.consumeUsage(t.organizationId, "uploads")).toMatchObject(
      { allowed: false, used: 2, firstRefusal: true },
    );

    t.setNow(new Date("2026-03-11T00:00:00.000Z"));
    expect(
      await t.api.consumeUsage(t.organizationId, "apiCalls"),
    ).toMatchObject({ allowed: false, firstRefusal: true });
    const rows = (await t.rows()).map((r) => ({
      key: r.key,
      periodStart: new Date(r.periodStart).toISOString(),
      used: r.used,
      refused: r.refused,
    }));
    expect(rows).toHaveLength(3);
    expect(rows).toEqual(
      expect.arrayContaining([
        {
          key: "apiCalls",
          periodStart: "2026-03-10T00:00:00.000Z",
          used: 0,
          refused: 2,
        },
        {
          key: "apiCalls",
          periodStart: "2026-03-11T00:00:00.000Z",
          used: 0,
          refused: 1,
        },
        {
          key: "uploads",
          periodStart: "2026-03-01T00:00:00.000Z",
          used: 2,
          refused: 1,
        },
      ]),
    );
    expect(limitEvents(t.onEvent)).toHaveLength(3);
  });

  it("getLimit reads the SQL counter and creates no bucket", async () => {
    const t = await setup({ apiCalls: 10 });
    expect(await t.api.getLimit(t.organizationId, "apiCalls")).toMatchObject({
      used: 0,
      remaining: 10,
      degraded: false,
    });
    expect(await t.rows()).toHaveLength(0);
    await t.api.consumeUsage(t.organizationId, "apiCalls", { amount: 4 });
    expect(await t.api.getLimit(t.organizationId, "apiCalls")).toMatchObject({
      used: 4,
      remaining: 6,
    });
  });
});
