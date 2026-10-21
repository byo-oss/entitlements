import { runWithTransaction } from "@better-auth/core/context";
import { getAuthTables } from "@better-auth/core/db";
import type { BetterAuthPlugin } from "better-auth";
import { describe, expect, it, vi } from "vitest";
import {
  chunk,
  FIND_PAGE,
  findAll,
  findManyIn,
  findMember,
  findOrganization,
  IN_CHUNK,
  markEntitlementsQuery,
} from "./adapter";
import { createEntitlements } from "./api";
import {
  canonicalPlanKey,
  limitKind,
  planEntitlements,
  upgradeTo,
} from "./catalog";
import { entitlementsClient } from "./client";
import { ENTITLEMENTS_ERROR_CODES } from "./error-codes";
import { ENTITLEMENTS_EVENT_TYPES, emit, entitlementsEvent } from "./events";
import { entitlements } from "./index";
import { ENTITLEMENTS_DEFAULTS, resolveOptions } from "./options";
import { entitlementsPathMethods } from "./path-methods";
import * as resolveModule from "./resolve";
import {
  createRuntime,
  requireContext,
  runtimeFromAuth,
  runtimeFromContext,
  singleFlight,
  warnOnce,
} from "./runtime";
import {
  buildSchema,
  decodeOverrideValue,
  ENTITLEMENTS_MODELS,
  encodeOverrideValue,
  fullSchema,
} from "./schema";
import { entitlementsStatements } from "./statements";
import { createSqlTestAuth } from "./test-sql";
import {
  addMember,
  expectNoOuterCalls,
  fakeSource,
  getContext,
  getRuntime,
  IN_TRANSACTION_PROBE_PATH,
  inTransactionProbe,
  makeAuth,
  seedOrg,
  seedOverride,
  seedUsage,
  setSnapshot,
  signUpUser,
  takeStrictViolations,
  testCatalog,
} from "./test-utils";
import { assertOutsideTransaction, currentAdapter, inTransaction } from "./txn";

/** The public catalog API: `./catalog`, and the catalog part of `.` and `./client`. */
const PUBLIC_CATALOG_VALUES = ["defineEntitlements", "upgradeTo"];
const INTERNAL_CATALOG_HELPERS = [
  "validateCatalog",
  "canonicalPlanKey",
  "planEntitlements",
  "planKeys",
  "limitKind",
  "isFeatureKey",
  "isLimitValue",
  "MAX_CATALOG_KEYS",
  "PLAN_KEY_PATTERN",
];

const snapshotWhere = (organizationId: string) => [
  { field: "organizationId", value: organizationId },
];

describe("strict adapter wrapper", () => {
  it("rejects an empty in list on an entitlement model", async () => {
    const { adapter } = await getContext(makeAuth());
    await expect(
      adapter.findMany({
        model: "entitlementUsage",
        where: [{ field: "organizationId", operator: "in", value: [] }],
        limit: 10,
      }),
    ).rejects.toThrow(/organizationId in with 0 values/);
    expect(takeStrictViolations()).toHaveLength(1);
  });

  it("rejects an in list of 91 values and accepts 90", async () => {
    const { adapter } = await getContext(makeAuth());
    const ids = (n: number) => Array.from({ length: n }, (_, i) => `org_${i}`);
    await expect(
      adapter.findMany({
        model: "entitlementSnapshot",
        where: [{ field: "organizationId", operator: "in", value: ids(91) }],
        limit: 10,
      }),
    ).rejects.toThrow(/with 91 values \(allowed 1\.\.90\)/);
    expect(takeStrictViolations()).toHaveLength(1);
    await expect(
      adapter.findMany({
        model: "entitlementSnapshot",
        where: [{ field: "organizationId", operator: "in", value: ids(90) }],
        limit: 10,
      }),
    ).resolves.toEqual([]);
  });

  it("rejects findMany without a limit", async () => {
    const { adapter } = await getContext(makeAuth());
    await expect(
      adapter.findMany({ model: "entitlementOverride", where: [] }),
    ).rejects.toThrow(/findMany on entitlementOverride without limit/);
    expect(takeStrictViolations()).toHaveLength(1);
  });

  it("rejects a where list that mixes AND and OR", async () => {
    const { adapter } = await getContext(makeAuth());
    await expect(
      adapter.findMany({
        model: "entitlementOverride",
        where: [
          { field: "organizationId", value: "a" },
          { field: "status", value: "active", connector: "OR" },
        ],
        limit: 10,
      }),
    ).rejects.toThrow(/mixes AND and OR/);
    expect(takeStrictViolations()).toHaveLength(1);
    // all OR (or all AND) is fine
    await expect(
      adapter.findMany({
        model: "entitlementOverride",
        where: [
          { field: "organizationId", value: "a", connector: "OR" },
          { field: "organizationId", value: "b", connector: "OR" },
        ],
        limit: 10,
      }),
    ).resolves.toEqual([]);
  });

  it("checks other models only when entitlements tagged the query", async () => {
    const { adapter } = await getContext(makeAuth());
    // better-auth's own shape of query passes untouched
    await expect(
      adapter.findMany({ model: "member", where: [] }),
    ).resolves.toEqual([]);
    await expect(
      adapter.findMany(markEntitlementsQuery({ model: "member", where: [] })),
    ).rejects.toThrow(/findMany on member without limit/);
    expect(takeStrictViolations()).toHaveLength(1);
  });

  it("lets an organization round trip through it (create, add, remove, delete)", async () => {
    const auth = makeAuth();
    const { organizationId, owner } = await seedOrg(auth);
    const teammate = await signUpUser(auth, "teammate@acme.test");
    await addMember(auth, {
      organizationId,
      userId: teammate.user.id,
      role: "member",
    });
    await auth.api.removeMember({
      body: { organizationId, memberIdOrEmail: teammate.user.email },
      headers: owner.headers,
    });
    await auth.api.deleteOrganization({
      body: { organizationId },
      headers: owner.headers,
    });
    const { adapter } = await getContext(auth);
    expect(await findOrganization(adapter, organizationId)).toBeNull();
    expect(takeStrictViolations()).toEqual([]);
  });
});

describe("transactions (txn.ts)", () => {
  it("detects a transaction on the memory adapter: true inside runWithTransaction, false outside", async () => {
    const auth = makeAuth();
    const rt = await getRuntime(auth);
    const { adapter } = await getContext(auth);
    expect(await inTransaction(rt)).toBe(false);
    expect(await currentAdapter(rt)).toBe(adapter);
    const inside = await runWithTransaction(adapter, async () => ({
      detected: await inTransaction(rt),
      current: await currentAdapter(rt),
    }));
    expect(inside.detected).toBe(true);
    expect(inside.current).not.toBe(adapter);
    expect(await inTransaction(rt)).toBe(false);
  });

  it("reads false inside runWithTransaction on Kysely with transaction: false, through the wrapper", async () => {
    const { auth, close } = await createSqlTestAuth({ transaction: false });
    try {
      const rt = await getRuntime(auth);
      const { adapter } = await getContext(auth);
      const inside = await runWithTransaction(adapter, async () => ({
        detected: await inTransaction(rt),
        current: await currentAdapter(rt),
      }));
      expect(inside.detected).toBe(false);
      expect(inside.current).toBe(adapter);
      await expect(
        assertOutsideTransaction(rt, "consumeUsage"),
      ).resolves.toBeUndefined();
      // expectNoOuterCalls refuses: every call is "outer" by design here
      await expect(expectNoOuterCalls(auth, async () => {})).rejects.toThrow(
        /needs an adapter with real transactions/,
      );
    } finally {
      await close();
    }
  }, 30_000);

  it("throws the documented error inside a transaction", async () => {
    const auth = makeAuth();
    const rt = await getRuntime(auth);
    const { adapter } = await getContext(auth);
    await expect(
      runWithTransaction(adapter, () => assertOutsideTransaction(rt, "sync")),
    ).rejects.toThrow(
      "[@byo-oss/entitlements] sync must run outside a transaction",
    );
    await expect(assertOutsideTransaction(rt, "sync")).resolves.toBeUndefined();
  });

  it("expectNoOuterCalls passes code that uses currentAdapter", async () => {
    const auth = makeAuth();
    const rt = await getRuntime(auth);
    const { organizationId } = await seedOrg(auth);
    const row = await expectNoOuterCalls(auth, async () => {
      const adapter = await currentAdapter(rt);
      return adapter.findOne({
        model: "entitlementSnapshot",
        where: snapshotWhere(organizationId),
      });
    });
    expect(row).toBeNull();
  });

  it("negative control: catches code that calls ctx.context.adapter directly inside runWithTransaction", async () => {
    const auth = makeAuth();
    const { adapter } = await getContext(auth);
    const { organizationId } = await seedOrg(auth);
    await expect(
      expectNoOuterCalls(auth, async () => {
        await adapter.findOne({
          model: "entitlementSnapshot",
          where: snapshotWhere(organizationId),
        });
      }),
    ).rejects.toThrow(
      /findOne on entitlementSnapshot ran on the outer adapter/,
    );
    // also when the code under test swallows the error
    await expect(
      expectNoOuterCalls(auth, async () => {
        await adapter
          .findOne({
            model: "entitlementOverride",
            where: snapshotWhere(organizationId),
          })
          .catch(() => null);
      }),
    ).rejects.toThrow(/outer adapter calls inside runWithTransaction/);
    expect(takeStrictViolations()).toHaveLength(2);
  });

  it("also catches a tagged organization read on the outer adapter, and lets untagged better-auth reads pass", async () => {
    const auth = makeAuth();
    const rt = await getRuntime(auth);
    const { adapter } = await getContext(auth);
    const { organizationId } = await seedOrg(auth);
    // entitlements' own read (tagged) through currentAdapter: fine
    await expect(
      expectNoOuterCalls(auth, async () =>
        findOrganization(await currentAdapter(rt), organizationId),
      ),
    ).resolves.toMatchObject({ id: organizationId });
    // the same tagged read on the outer adapter: caught
    await expect(
      expectNoOuterCalls(auth, () => findOrganization(adapter, organizationId)),
    ).rejects.toThrow(/findOne on organization ran on the outer adapter/);
    expect(takeStrictViolations()).toHaveLength(1);
    // an untagged read (better-auth's own shape) on the outer adapter: passes
    await expect(
      expectNoOuterCalls(auth, () =>
        adapter.findOne({
          model: "organization",
          where: [{ field: "id", value: organizationId }],
        }),
      ),
    ).resolves.toMatchObject({ id: organizationId });
  });

  it("reads false in a plain auth.handler request (memory)", async () => {
    const auth = makeAuth({ plugins: [inTransactionProbe()] });
    const response = await auth.handler(
      new Request(`http://localhost:3000/api/auth${IN_TRANSACTION_PROBE_PATH}`),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ inTransaction: false });
    // extra config.plugins are typed on auth.api
    const direct: { inTransaction: boolean } =
      await auth.api.testInTransaction();
    expect(direct).toEqual({ inTransaction: false });
    const { adapter } = await getContext(auth);
    expect(
      await runWithTransaction(adapter, () => auth.api.testInTransaction()),
    ).toEqual({ inTransaction: true });
  });
});

describe("schema", () => {
  it("declares the three models in migration order", () => {
    expect(Object.keys(fullSchema)).toEqual([...ENTITLEMENTS_MODELS]);
    const tables = Object.keys(
      getAuthTables({
        plugins: [entitlements({ catalog: testCatalog })] as BetterAuthPlugin[],
      }),
    ).filter((t) => t.startsWith("entitlement"));
    expect(tables).toEqual([...ENTITLEMENTS_MODELS]);
  });

  it("declares onDelete explicitly on every reference", () => {
    const references: Record<string, string> = {};
    for (const [model, { fields }] of Object.entries(fullSchema)) {
      for (const [field, attr] of Object.entries(fields)) {
        if (!("references" in attr)) continue;
        const ref = attr.references as { model: string; onDelete?: string };
        expect(ref.onDelete, `${model}.${field}`).toBeDefined();
        references[`${model}.${field}`] = `${ref.model}:${ref.onDelete}`;
      }
    }
    expect(references).toEqual({
      "entitlementSnapshot.organizationId": "organization:cascade",
      "entitlementOverride.organizationId": "organization:cascade",
      "entitlementOverride.createdBy": "user:set null",
      "entitlementOverride.removedBy": "user:set null",
      "entitlementUsage.organizationId": "organization:cascade",
    });
  });

  it("flags the indexed and unique fields", () => {
    const flagged = (flag: "index" | "unique") =>
      Object.entries(fullSchema)
        .flatMap(([model, { fields }]) =>
          Object.entries(fields)
            .filter(
              ([, attr]) => (attr as Record<string, unknown>)[flag] === true,
            )
            .map(([field]) => `${model}.${field}`),
        )
        .sort();
    expect(flagged("unique")).toEqual([
      "entitlementSnapshot.organizationId",
      "entitlementUsage.bucket",
    ]);
    expect(flagged("index")).toEqual(
      [
        "entitlementSnapshot.nextSyncAt",
        "entitlementOverride.organizationId",
        "entitlementOverride.status",
        "entitlementOverride.createdBy",
        "entitlementOverride.removedBy",
        "entitlementUsage.organizationId",
        "entitlementUsage.periodEnd",
      ].sort(),
    );
  });

  it("adds no columns to better-auth's tables", () => {
    expect(
      Object.keys(fullSchema).every((m) => m.startsWith("entitlement")),
    ).toBe(true);
  });

  it("applies renames on a deep copy (mergeSchema mutates its input)", () => {
    const before = JSON.stringify(fullSchema);
    const renamed = buildSchema({
      entitlementUsage: { modelName: "plan_usage", fields: { used: "count" } },
    });
    expect(renamed.entitlementUsage).toMatchObject({ modelName: "plan_usage" });
    expect(
      (renamed.entitlementUsage.fields.used as { fieldName?: string })
        .fieldName,
    ).toBe("count");
    expect(JSON.stringify(fullSchema)).toBe(before);
    expect(buildSchema()).not.toBe(buildSchema());
    const plugin = entitlements({
      catalog: testCatalog,
      schema: { entitlementSnapshot: { modelName: "plan_snapshot" } },
    });
    expect(
      (plugin.schema.entitlementSnapshot as { modelName?: string }).modelName,
    ).toBe("plan_snapshot");
    expect(
      (
        entitlements({ catalog: testCatalog }).schema.entitlementSnapshot as {
          modelName?: string;
        }
      ).modelName,
    ).toBeUndefined();
  });

  it("encodes and decodes override values per kind", () => {
    expect(decodeOverrideValue("plan", encodeOverrideValue(null))).toBeNull();
    expect(decodeOverrideValue("feature", encodeOverrideValue(true))).toBe(
      true,
    );
    expect(decodeOverrideValue("limit", encodeOverrideValue(25))).toBe(25);
    expect(decodeOverrideValue("limit", '"unlimited"')).toBe("unlimited");
    expect(decodeOverrideValue("limit", "-1")).toBeUndefined();
    expect(decodeOverrideValue("limit", "1.5")).toBeUndefined();
    expect(decodeOverrideValue("feature", "1")).toBeUndefined();
    expect(decodeOverrideValue("plan", '"pro"')).toBeUndefined();
    expect(decodeOverrideValue("feature", "{not json")).toBeUndefined();
  });

  it("seeds rows through the wrapped adapter", async () => {
    const auth = makeAuth();
    const { organizationId } = await seedOrg(auth);
    const snapshot = await setSnapshot(auth, organizationId, {
      planKey: "pro",
      status: "active",
    });
    expect(snapshot).toMatchObject({
      organizationId,
      source: "none",
      planKey: "pro",
      version: 0,
      syncState: "idle",
    });
    const again = await setSnapshot(auth, organizationId, { planKey: "team" });
    expect(again.id).toBe(snapshot.id);
    expect(again.planKey).toBe("team");
    const override = await seedOverride(auth, {
      organizationId,
      kind: "limit",
      key: "members",
      value: 12,
    });
    expect(override).toMatchObject({
      status: "active",
      permanent: true,
      value: "12",
    });
  });

  it("seedUsage writes a counter for the key's current period", async () => {
    const auth = makeAuth();
    const rt = await getRuntime(auth);
    rt.now = () => new Date("2026-03-15T10:30:00.000Z");
    const { organizationId } = await seedOrg(auth);
    const daily = await seedUsage(auth, {
      organizationId,
      key: "apiCalls",
      used: 7,
    });
    expect(daily).toMatchObject({
      bucket: `${organizationId}:apiCalls:2026-03-15T00:00:00.000Z`,
      organizationId,
      key: "apiCalls",
      used: 7,
      refused: 0,
    });
    expect(daily.periodStart.toISOString()).toBe("2026-03-15T00:00:00.000Z");
    expect(daily.periodEnd.toISOString()).toBe("2026-03-16T00:00:00.000Z");
    const monthly = await seedUsage(auth, {
      organizationId,
      key: "uploads",
      refused: 2,
    });
    expect(monthly.periodStart.toISOString()).toBe("2026-03-01T00:00:00.000Z");
    expect(monthly.periodEnd.toISOString()).toBe("2026-04-01T00:00:00.000Z");
    expect(monthly).toMatchObject({ used: 0, refused: 2 });
    const start = new Date("2026-03-10T00:00:00.000Z");
    const end = new Date("2026-04-10T00:00:00.000Z");
    const billing = await seedUsage(auth, {
      organizationId,
      key: "reports",
      periodStart: start,
      periodEnd: end,
    });
    expect(billing.bucket).toBe(
      `${organizationId}:reports:2026-03-10T00:00:00.000Z`,
    );
    expect(billing.periodEnd).toEqual(end);
    await expect(
      seedUsage(auth, { organizationId, key: "members" }),
    ).rejects.toThrow(/isn't a metered limit/);
  });
});

describe("plugin", () => {
  it("has id, schema, error codes, after hooks and byo hooks", async () => {
    const plugin = entitlements({ catalog: testCatalog });
    expect(plugin.id).toBe("entitlements");
    expect(Object.keys(plugin.$ERROR_CODES).sort()).toEqual(
      [
        "ORGANIZATION_PLUGIN_REQUIRED",
        "NOT_ALLOWED",
        "SESSION_NOT_ACCEPTED",
        "UNKNOWN_KEY",
        "INVALID_OVERRIDE",
        "OVERRIDE_NOT_FOUND",
        "ORGANIZATION_NOT_FOUND",
        "ENTITLEMENTS_UNAVAILABLE",
        "INVALID_CURSOR",
      ].sort(),
    );
    expect(ENTITLEMENTS_ERROR_CODES.NOT_ALLOWED.code).toBe("NOT_ALLOWED");
    expect(Object.keys(plugin.byo).sort()).toEqual([
      "deleteOrganizationData",
      "sweep",
    ]);
    expect(typeof plugin.byo.sweep).toBe("function");
    expect(typeof plugin.byo.deleteOrganizationData).toBe("function");
    expect(Array.isArray(plugin.hooks.after)).toBe(true);
    expect(
      entitlements({ catalog: testCatalog, organizationCleanup: false }).hooks
        .after,
    ).toEqual([]);
    expect(plugin.options.catalog).toBe(testCatalog);
  });

  it("registers exactly the PRD's auth.api keys", () => {
    const plugin = entitlements({ catalog: testCatalog });
    expect(Object.keys(plugin.endpoints).sort()).toEqual(
      [
        "getEntitlements",
        "refreshEntitlements",
        "setEntitlementOverride",
        "removeEntitlementOverride",
        "listEntitlementOverrides",
        "processEntitlementsSync",
      ].sort(),
    );
  });

  it("byo hooks run through the auth instance", async () => {
    const auth = makeAuth();
    const plugin = (await getContext(auth)).options.plugins?.find(
      (p) => p.id === "entitlements",
    ) as ReturnType<typeof entitlements>;
    const result = await plugin.byo.sweep(auth);
    expect(result).toMatchObject({ hasMore: false });
    for (const key of [
      "synced",
      "skipped",
      "retrying",
      "failed",
      "expired",
      "pruned",
    ]) {
      expect(typeof (result as Record<string, unknown>)[key]).toBe("number");
    }
    const { organizationId } = await seedOrg(auth);
    await expect(
      plugin.byo.deleteOrganizationData(auth, organizationId),
    ).resolves.toBeUndefined();
  });

  it("processEntitlementsSync is server-only and has no path", async () => {
    const plugin = entitlements({ catalog: testCatalog });
    const endpoint = plugin.endpoints.processEntitlementsSync as unknown as {
      path?: string;
      options: { metadata?: { SERVER_ONLY?: boolean } };
    };
    expect(endpoint.path).toBeUndefined();
    expect(endpoint.options.metadata?.SERVER_ONLY).toBe(true);
    const auth = makeAuth();
    const response = await auth.handler(
      new Request("http://localhost:3000/api/auth/process-entitlements-sync", {
        method: "POST",
      }),
    );
    expect(response.status).toBe(404);
    // callable on the server
    await expect(auth.api.processEntitlementsSync()).resolves.toMatchObject({
      hasMore: false,
    });
  });

  it("pathMethods lists every endpoint with a path, with its method", () => {
    expect(entitlementsPathMethods).toEqual({
      "/entitlements/get": "GET",
      "/entitlements/refresh": "POST",
      "/entitlements/override/set": "POST",
      "/entitlements/override/remove": "POST",
      "/entitlements/overrides": "GET",
    });
    const plugin = entitlements({ catalog: testCatalog });
    const routes: Record<string, string> = {};
    for (const endpoint of Object.values(plugin.endpoints) as unknown as {
      path?: string;
      options: { method: string };
    }[]) {
      if (endpoint.path) routes[endpoint.path] = endpoint.options.method;
    }
    expect(routes).toEqual(entitlementsPathMethods);
    expect(entitlementsClient().pathMethods).toBe(entitlementsPathMethods);
    expect(entitlementsClient().id).toBe("entitlements");
  });

  it("init captures the context and returns the user delete hook", async () => {
    const auth = makeAuth();
    const context = await getContext(auth);
    const rt = await getRuntime(auth);
    expect(rt.context).toBe(context);
    expect(requireContext(rt)).toBe(context);
    expect(rt.logger).toBe(context.logger);
    const plugin = entitlements({ catalog: testCatalog });
    const result = await plugin.init(context);
    expect(typeof result.options.databaseHooks.user.delete.after).toBe(
      "function",
    );
  });

  it("awaits source.connect in init and hands it a changed callback", async () => {
    let connected = false;
    const changed: ((id: string) => Promise<void>)[] = [];
    const auth = makeAuth({
      options: {
        source: {
          id: "test",
          resolve: async () => null,
          connect: async (_context, callback) => {
            await new Promise((resolve) => setTimeout(resolve, 5));
            changed.push(callback);
            connected = true;
          },
        },
      },
    });
    await auth.$context;
    expect(connected).toBe(true);
    expect(changed).toHaveLength(1);
    const { organizationId } = await seedOrg(auth);
    await expect(changed[0]?.(organizationId)).resolves.toBeUndefined();
  });

  it("runtimeFromAuth names the caller when the plugin is missing", async () => {
    await expect(
      runtimeFromAuth(
        { $context: Promise.resolve({ options: { plugins: [] } }) },
        "exportEntitlementsData",
      ),
    ).rejects.toThrow(
      "[@byo-oss/entitlements] exportEntitlementsData needs the entitlements plugin installed on this auth instance",
    );
  });

  it("runtimeFromContext finds the runtime in a context, and names the caller without the plugin", async () => {
    const auth = makeAuth();
    const context = await getContext(auth);
    expect(runtimeFromContext(context, "connect")).toBe(await getRuntime(auth));
    expect(() =>
      runtimeFromContext({ options: { plugins: [] } }, "connect"),
    ).toThrow(
      "[@byo-oss/entitlements] connect needs the entitlements plugin installed on this auth instance",
    );
  });

  it("a throwing resolveEntitlements hook degrades the read, carries the error and logs once", async () => {
    const failure = new Error("hook down");
    const auth = makeAuth({
      options: {
        resolveEntitlements: () => {
          throw failure;
        },
      },
    });
    const rt = await getRuntime(auth);
    const error = vi.fn();
    rt.logger = { ...rt.logger, error };
    const { organizationId } = await seedOrg(auth);
    const result = await createEntitlements(auth, testCatalog).get(
      organizationId,
    );
    expect(result).toMatchObject({
      organizationId,
      degraded: true,
      plan: { key: "free", source: "default" },
      status: null,
      periodEnd: null,
    });
    expect(result.features).toEqual(testCatalog.plans.free.features);
    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(expect.any(String), failure);
    // the state the checks read carries the error for onError (contracts D8)
    const state = await resolveModule.resolveState(rt, organizationId);
    expect(state.result.degraded).toBe(true);
    expect(state.error).toBe(failure);
  });

  it("sync and the source's changed callback log a failed resync once and rethrow it", async () => {
    const source = fakeSource();
    const auth = makeAuth({ options: { source } });
    const rt = await getRuntime(auth);
    const error = vi.fn();
    rt.logger = { ...rt.logger, error };
    const failure = new Error("billing down");
    const spy = vi
      .spyOn(resolveModule, "syncOrganization")
      .mockRejectedValue(failure);
    try {
      await expect(
        createEntitlements(auth, testCatalog).sync("org_1"),
      ).rejects.toBe(failure);
      expect(error).toHaveBeenCalledTimes(1);
      expect(error).toHaveBeenCalledWith(
        "[@byo-oss/entitlements] sync failed for organization org_1",
        failure,
      );
      await expect(source.changed?.("org_1")).rejects.toBe(failure);
      expect(error).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
    }
  });

  it("requireContext throws before init", () => {
    const rt = createRuntime(resolveOptions({ catalog: testCatalog }));
    expect(() => requireContext(rt)).toThrow(/isn't initialized yet/);
    expect(rt.options.cacheTtlMs).toBe(ENTITLEMENTS_DEFAULTS.cacheTtlMs);
  });
});

describe("runtime helpers", () => {
  it("singleFlight shares one promise per key while it runs", async () => {
    const rt = createRuntime(resolveOptions({ catalog: testCatalog }));
    let runs = 0;
    const fn = async () => {
      runs += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return runs;
    };
    const [a, b] = await Promise.all([
      singleFlight(rt, "k", fn),
      singleFlight(rt, "k", fn),
    ]);
    expect([a, b, runs]).toEqual([1, 1, 1]);
    expect(rt.flights.size).toBe(0);
    await singleFlight(rt, "k", fn);
    expect(runs).toBe(2);
    await expect(
      singleFlight(rt, "fails", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(rt.flights.size).toBe(0);
  });

  it("warnOnce warns once per key", () => {
    const rt = createRuntime(resolveOptions({ catalog: testCatalog }));
    const warn = vi.fn();
    rt.logger = { ...rt.logger, warn };
    warnOnce(rt, "plan:gold", "unknown plan gold");
    warnOnce(rt, "plan:gold", "unknown plan gold");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "[@byo-oss/entitlements] unknown plan gold",
    );
  });
});

describe("adapter helpers", () => {
  it("chunks at 90 and gives no chunk for an empty list", () => {
    expect(IN_CHUNK).toBe(90);
    expect(chunk([])).toEqual([]);
    expect(
      chunk(Array.from({ length: 181 }, (_, i) => i)).map((c) => c.length),
    ).toEqual([90, 90, 1]);
  });

  it("findManyIn reads every match across chunks, and runs no query for []", async () => {
    const auth = makeAuth();
    const { adapter } = await getContext(auth);
    const orgs: string[] = [];
    for (let i = 0; i < 3; i++) orgs.push((await seedOrg(auth)).organizationId);
    for (const organizationId of orgs) {
      await setSnapshot(auth, organizationId);
    }
    const ids = [
      ...orgs,
      ...Array.from({ length: 200 }, (_, i) => `missing_${i}`),
      orgs[0] as string,
    ];
    const spy = vi.spyOn(adapter, "findMany");
    const rows = await findManyIn<{ organizationId: string }>(adapter, {
      model: "entitlementSnapshot",
      field: "organizationId",
      values: ids,
    });
    expect(rows.map((r) => r.organizationId).sort()).toEqual([...orgs].sort());
    expect(spy).toHaveBeenCalledTimes(3);
    spy.mockClear();
    expect(
      await findManyIn(adapter, {
        model: "entitlementSnapshot",
        field: "organizationId",
        values: [],
      }),
    ).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("findAll stops at max and pages at 1000", async () => {
    const auth = makeAuth();
    const { organizationId } = await seedOrg(auth);
    for (let i = 0; i < 5; i++) {
      await seedOverride(auth, {
        organizationId,
        kind: "feature",
        key: "exports",
      });
    }
    const { adapter } = await getContext(auth);
    const rows = await findAll(adapter, {
      model: "entitlementOverride",
      where: [{ field: "organizationId", value: organizationId }],
      max: 3,
    });
    expect(rows).toHaveLength(3);
    expect(FIND_PAGE).toBe(1000);
  });

  it("findMember and findOrganization read through tagged queries", async () => {
    const auth = makeAuth();
    const { organizationId, owner } = await seedOrg(auth);
    const { adapter } = await getContext(auth);
    expect(
      await findMember(adapter, { userId: owner.user.id, organizationId }),
    ).toMatchObject({ role: "owner" });
    expect(
      await findMember(adapter, { userId: "nobody", organizationId }),
    ).toBeNull();
    expect(await findOrganization(adapter, organizationId)).toMatchObject({
      id: organizationId,
    });
  });
});

describe("events", () => {
  it("builds events with the documented subjects", () => {
    expect(ENTITLEMENTS_EVENT_TYPES).toEqual([
      "entitlements.plan.changed",
      "entitlements.override.set",
      "entitlements.override.removed",
      "entitlements.usage.limit_reached",
    ]);
    const at = new Date("2026-01-01T00:00:00Z");
    expect(
      entitlementsEvent("entitlements.plan.changed", {
        organizationId: "org_1",
        actorId: null,
        data: { from: "free", to: "pro", status: "active" },
        occurredAt: at,
      }),
    ).toEqual({
      type: "entitlements.plan.changed",
      occurredAt: at,
      actorId: null,
      organizationId: "org_1",
      subject: { type: "organization", id: "org_1" },
      data: { from: "free", to: "pro", status: "active" },
    });
    expect(
      entitlementsEvent("entitlements.override.removed", {
        organizationId: "org_1",
        actorId: "user_1",
        overrideId: "ov_1",
        data: { kind: "feature", key: "exports" },
        occurredAt: at,
      }).subject,
    ).toEqual({ type: "entitlementOverride", id: "ov_1" });
  });

  it("emit awaits onEvent, logs its errors and never throws", async () => {
    const error = vi.fn();
    const event = entitlementsEvent("entitlements.usage.limit_reached", {
      organizationId: "org_1",
      actorId: null,
      data: { key: "apiCalls", limit: 10, periodEnd: new Date() },
      occurredAt: new Date("2026-01-01T00:00:00Z"),
    });
    const seen: unknown[] = [];
    await emit(
      {
        options: { onEvent: async (e) => void seen.push(e) },
        logger: { error },
      },
      event,
    );
    expect(seen).toEqual([event]);
    await expect(
      emit(
        {
          options: {
            onEvent: () => {
              throw new Error("consumer down");
            },
          },
          logger: { error },
        },
        event,
      ),
    ).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith(
      "[@byo-oss/entitlements] onEvent failed for entitlements.usage.limit_reached",
      expect.any(Error),
    );
    await expect(
      emit(
        {
          options: {
            onEvent: () => {
              throw new Error("consumer down");
            },
          },
          logger: {
            error: () => {
              throw new Error("logger down");
            },
          },
        },
        event,
      ),
    ).resolves.toBeUndefined();
    await expect(
      emit({ options: { onEvent: null }, logger: { error } }, event),
    ).resolves.toBeUndefined();
  });
});

describe("catalog helpers", () => {
  it("upgradeTo lists unlocking plans in catalog order", () => {
    expect(upgradeTo(testCatalog, { feature: "exports" })).toEqual([
      "pro",
      "team",
    ]);
    expect(upgradeTo(testCatalog, { feature: "sso" })).toEqual(["team"]);
    expect(upgradeTo(testCatalog, { limit: "members", atLeast: 51 })).toEqual([
      "team",
    ]);
    expect(upgradeTo(testCatalog, { limit: "projects", atLeast: 4 })).toEqual([
      "pro",
      "team",
    ]);
  });

  it("maps aliases, kinds and plan copies", () => {
    expect(canonicalPlanKey(testCatalog, "legacy")).toBe("pro");
    expect(canonicalPlanKey(testCatalog, "team")).toBe("team");
    expect(canonicalPlanKey(testCatalog, "gold")).toBeNull();
    expect(canonicalPlanKey(testCatalog, "toString")).toBeNull();
    expect(canonicalPlanKey(testCatalog, null)).toBeNull();
    // a catalog without planAliases (not built by defineEntitlements)
    const { planAliases: _, ...bare } = testCatalog;
    const noAliases = bare as unknown as typeof testCatalog;
    expect(canonicalPlanKey(noAliases, "pro")).toBe("pro");
    expect(canonicalPlanKey(noAliases, "legacy")).toBeNull();
    expect(limitKind(testCatalog, "apiCalls")).toBe("metered");
    expect(limitKind(testCatalog, "members")).toBe("capacity");
    expect(limitKind(testCatalog, "exports")).toBeNull();
    const copy = planEntitlements(testCatalog, "free");
    copy.limits.members = 99;
    expect(testCatalog.plans.free.limits.members).toBe(5);
    expect(copy.display).toEqual({ name: "Free" });
  });

  it("./catalog, ./client and . export only the public catalog API", async () => {
    const entry = await import("./catalog-entry");
    expect(Object.keys(entry).sort()).toEqual(
      [...PUBLIC_CATALOG_VALUES].sort(),
    );
    const client = await import("./client");
    expect(Object.keys(client).sort()).toEqual(
      [
        ...PUBLIC_CATALOG_VALUES,
        "entitlementsClient",
        "entitlementsStatements",
      ].sort(),
    );
    const root = await import("./index");
    expect(Object.keys(root).sort()).toEqual(
      [
        ...PUBLIC_CATALOG_VALUES,
        "entitlements",
        "createEntitlements",
        "deleteOrganizationData",
        "exportEntitlementsData",
        "entitlementsStatements",
        "ENTITLEMENTS_ERROR_CODES",
        "ENTITLEMENTS_EVENT_TYPES",
      ].sort(),
    );
    for (const name of INTERNAL_CATALOG_HELPERS) {
      expect(entry, name).not.toHaveProperty(name);
      expect(client, name).not.toHaveProperty(name);
      expect(root, name).not.toHaveProperty(name);
    }
  });

  it("statements", () => {
    expect(entitlementsStatements).toEqual({
      entitlements: ["read", "override"],
    });
  });
});
