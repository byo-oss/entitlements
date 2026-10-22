import type { AuthContext } from "better-auth";
import { describe, expect, it, vi } from "vitest";
import { resolveState, syncOrganization } from "../resolve";
import {
  type EntitlementsRuntime,
  PLUGIN_ID,
  runtimeFromAuth,
} from "../runtime";
import { readSnapshot } from "../snapshot";
import { currentAdapter } from "../txn";
import type { BillingSource, BillingState } from "../types";

/**
 * A test auth for the contract suite: a real `betterAuth` (memory adapter)
 * with the organization plugin, `entitlements({ catalog, source })` and the
 * source's own plugins, plus one existing organization. The catalog must
 * have at least one plan other than `defaultPlan`.
 */
export type BillingSourceTestSetup = {
  source: BillingSource;
  auth: { $context: Promise<object> };
  /** An existing organization with no billing state yet. */
  organizationId: string;
  /** Makes the provider report `state` for the organization (`null`: none). */
  setState(organizationId: string, state: BillingState | null): Promise<void>;
};

export type TestBillingSourceOptions = {
  /** Suite name. @default `"BillingSource"` (the source's id isn't known until `setup` runs) */
  name?: string;
  /** Builds a fresh setup; called once per test. */
  setup: () => Promise<BillingSourceTestSetup>;
  /** Builds a setup whose source's `resolve` always throws. Required. */
  failing: () => Promise<Omit<BillingSourceTestSetup, "setState">>;
};

/** One check of the suite: `run` throws when the source breaks the contract. */
export type BillingSourceContractCase = {
  name: string;
  run: () => Promise<void>;
};

const DAY_MS = 86_400_000;
const PREFIX = "testBillingSource";

type Opened = {
  setup: BillingSourceTestSetup;
  source: BillingSource;
  organizationId: string;
  rt: EntitlementsRuntime;
  context: AuthContext;
};

const time = (value: Date | string | number | null | undefined) =>
  value === null || value === undefined ? null : new Date(value).getTime();

/** Builds a setup and finds the runtime of the plugin installed on its auth. */
async function open(options: TestBillingSourceOptions): Promise<Opened> {
  const setup = await options.setup();
  const rt = await runtimeFromAuth(setup.auth, PREFIX);
  expect(
    rt.options.source,
    "the entitlements plugin of the auth must be installed with the source setup() returns",
  ).toBe(setup.source);
  return {
    setup,
    source: setup.source,
    organizationId: setup.organizationId,
    rt,
    context: (await setup.auth.$context) as AuthContext,
  };
}

/** The first plan that isn't the default one. */
function paidPlan(rt: EntitlementsRuntime): string {
  const plan = Object.keys(rt.catalog.plans).find(
    (key) => key !== rt.catalog.defaultPlan,
  );
  if (!plan) {
    throw new Error(
      `[@byo-oss/entitlements] ${PREFIX} needs a catalog with a plan other than defaultPlan`,
    );
  }
  return plan;
}

/** An active subscription to `planKey`, with whole-second dates. */
function paidState(rt: EntitlementsRuntime, planKey: string): BillingState {
  const now = Math.floor(rt.now().getTime() / 1000) * 1000;
  return {
    planKey,
    status: "active",
    periodStart: new Date(now - 5 * DAY_MS),
    periodEnd: new Date(now + 25 * DAY_MS),
    cancelAtPeriodEnd: true,
    seats: 3,
    sourceRef: "sub_contract",
  };
}

/** Silences the plugin's logger for a check that provokes errors; returns the error spy. */
function quietLogger(rt: EntitlementsRuntime) {
  const error = vi.spyOn(rt.logger, "error").mockImplementation(() => {});
  const warn = vi.spyOn(rt.logger, "warn").mockImplementation(() => {});
  return {
    error,
    restore() {
      error.mockRestore();
      warn.mockRestore();
    },
  };
}

const snapshotOf = async (rt: EntitlementsRuntime, organizationId: string) =>
  readSnapshot(rt, await currentAdapter(rt), organizationId);

/** Resolves the way a read after a change does: cache bypassed, source asked now. */
const syncResult = async (rt: EntitlementsRuntime, organizationId: string) =>
  (await syncOrganization(rt, organizationId)).result;

/**
 * The checks of `testBillingSource` as a list, so a test can run them one by
 * one and look at which fail. Not part of the public `./testing` surface.
 */
export function billingSourceCases(
  options: TestBillingSourceOptions,
): BillingSourceContractCase[] {
  const cases: BillingSourceContractCase[] = [];
  const add = (name: string, run: () => Promise<void>) => {
    cases.push({ name, run });
  };

  add("has the shape of a BillingSource", async () => {
    const { source, rt, organizationId, setup } = await open(options);
    expect(typeof source.id).toBe("string");
    expect(source.id).not.toBe("");
    expect(typeof source.resolve).toBe("function");
    expect(["undefined", "function"]).toContain(typeof source.connect);

    await setup.setState(organizationId, null);
    const adapter = await currentAdapter(rt);
    const direct = source.resolve(organizationId, { adapter });
    expect(typeof direct?.then, "resolve must return a promise").toBe(
      "function",
    );
    const state = await direct;
    if (state !== null) {
      expect(["string", "object"]).toContain(typeof state.planKey);
      expect(["string", "object"]).toContain(typeof state.status);
    }

    // the plugin calls resolve(organizationId, { adapter }) once per sync
    const spy = vi.spyOn(source, "resolve");
    try {
      await syncOrganization(rt, organizationId);
      expect(spy).toHaveBeenCalledTimes(1);
      const [id, ctx] = spy.mock.calls[0] ?? [];
      expect(id).toBe(organizationId);
      expect(typeof ctx?.adapter?.findOne).toBe("function");
    } finally {
      spy.mockRestore();
    }
    const row = await snapshotOf(rt, organizationId);
    expect(row?.source, "snapshots carry the source id").toBe(source.id);
  });

  add("resolves null for an organization with no state", async () => {
    const { source, rt, organizationId, setup } = await open(options);
    await setup.setState(organizationId, null);
    const adapter = await currentAdapter(rt);
    expect(await source.resolve(organizationId, { adapter })).toBeNull();

    const result = await syncResult(rt, organizationId);
    expect(result.degraded).toBe(false);
    expect(result.plan.key).toBe(rt.catalog.defaultPlan);
    expect(result.plan.source).toBe("default");
    const row = await snapshotOf(rt, organizationId);
    expect(row?.planKey ?? null).toBeNull();
    expect(row?.periodEnd ?? null).toBeNull();
  });

  add("resolves the state it was given", async () => {
    const { source, rt, organizationId, setup } = await open(options);
    const plan = paidPlan(rt);
    const given = paidState(rt, plan);
    await setup.setState(organizationId, given);

    const adapter = await currentAdapter(rt);
    const got = await source.resolve(organizationId, { adapter });
    expect(got).not.toBeNull();
    expect(got?.planKey?.toLowerCase()).toBe(plan.toLowerCase());
    expect(got?.status).toBe(given.status);
    expect(time(got?.periodEnd)).toBe(time(given.periodEnd));
    expect(got?.cancelAtPeriodEnd ?? false).toBe(given.cancelAtPeriodEnd);

    const result = await syncResult(rt, organizationId);
    expect(result.degraded).toBe(false);
    expect(result.plan.key).toBe(plan);
    expect(result.plan.source).toBe("billing");
    expect(time(result.periodEnd)).toBe(time(given.periodEnd));
    const row = await snapshotOf(rt, organizationId);
    expect(row?.planKey).toBe(plan.toLowerCase());
    expect(row?.source).toBe(source.id);
  });

  add("does not mutate the context it is given", async () => {
    const { source, rt, organizationId, setup } = await open(options);
    await setup.setState(organizationId, paidState(rt, paidPlan(rt)));
    const adapter = await currentAdapter(rt);
    const ctx = Object.freeze({ adapter });
    // a frozen context throws on any write (modules are strict)
    await source.resolve(organizationId, ctx);
    expect(ctx.adapter).toBe(adapter);
  });

  add("returns copies and does not change the state it was given", async () => {
    const { source, rt, organizationId, setup } = await open(options);
    const given = paidState(rt, paidPlan(rt));
    const expected = structuredClone(given);
    Object.freeze(given);
    await setup.setState(organizationId, given);
    expect(given).toEqual(expected);

    const adapter = await currentAdapter(rt);
    const first = await source.resolve(organizationId, { adapter });
    expect(first).not.toBeNull();
    if (first && !Object.isFrozen(first)) {
      first.planKey = "tampered";
      first.status = "tampered";
      first.periodEnd = new Date(0);
    }
    const second = await source.resolve(organizationId, { adapter });
    expect(second).not.toBe(first);
    expect(second?.planKey?.toLowerCase()).toBe(given.planKey?.toLowerCase());
    expect(second?.status).toBe(given.status);
    expect(time(second?.periodEnd)).toBe(time(given.periodEnd));
    expect(given).toEqual(expected);
  });

  add(
    "rejects when it fails: the read is degraded and persists nothing",
    async () => {
      const failing = await options.failing();
      const rt = await runtimeFromAuth(failing.auth, PREFIX);
      expect(
        rt.options.source,
        "the failing auth must be installed with the failing source",
      ).toBe(failing.source);
      const { organizationId } = failing;
      const adapter = await currentAdapter(rt);
      const logger = quietLogger(rt);
      try {
        let thrown = false;
        try {
          await failing.source.resolve(organizationId, { adapter });
        } catch {
          thrown = true;
        }
        expect(thrown, "the failing source's resolve must throw").toBe(true);

        const state = await resolveState(rt, organizationId, {
          bypassCache: true,
        });
        expect(state.result.degraded).toBe(true);
        expect(state.error).toBeDefined();
        expect(state.result.plan.key).toBe(rt.catalog.defaultPlan);
        expect(state.result.plan.source).toBe("default");
        expect(state.result.status).toBeNull();
        expect(state.result.periodEnd).toBeNull();
        expect(logger.error).toHaveBeenCalledTimes(1);
        expect(rt.cache.get(organizationId)).toBeUndefined();
        expect(
          await snapshotOf(rt, organizationId),
          "a snapshot exists only after a successful resolve",
        ).toBeNull();

        await expect(
          syncOrganization(rt, organizationId),
        ).rejects.toBeDefined();
        expect(await snapshotOf(rt, organizationId)).toBeNull();
        expect(rt.cache.get(organizationId)).toBeUndefined();
      } finally {
        logger.restore();
      }
    },
  );

  const ends: [string, BillingState | null][] = [
    ["null", null],
    ["a state without periodEnd", { planKey: null, status: "canceled" }],
  ];
  for (const [label, next] of ends) {
    add(
      `going from a paid state to ${label} falls back to defaultPlan`,
      async () => {
        const { rt, organizationId, setup } = await open(options);
        const plan = paidPlan(rt);
        const paid = paidState(rt, plan);
        await setup.setState(organizationId, paid);
        const before = await syncResult(rt, organizationId);
        expect(before.plan.key).toBe(plan);
        expect(time(before.periodEnd)).toBe(time(paid.periodEnd));

        await setup.setState(organizationId, next);
        const after = await syncResult(rt, organizationId);
        expect(after.degraded).toBe(false);
        expect(after.plan.key).toBe(rt.catalog.defaultPlan);
        expect(after.plan.source).toBe("default");
        expect(after.periodEnd).toBeNull();
        const row = await snapshotOf(rt, organizationId);
        expect(row?.planKey ?? null).toBeNull();
        expect(row?.periodEnd ?? null).toBeNull();
        // a fresh read agrees: nothing stale is served from the cache
        const read = await resolveState(rt, organizationId);
        expect(read.result.plan.key).toBe(rt.catalog.defaultPlan);
        expect(read.result.periodEnd).toBeNull();
      },
    );
  }

  add(
    "connect, when present, is awaited and changed triggers a resync",
    async () => {
      const { source, rt, organizationId, setup, context } =
        await open(options);
      if (typeof source.connect !== "function") return;
      const plugin = context.options.plugins?.find((p) => p.id === PLUGIN_ID);
      expect(plugin?.init, "the entitlements plugin has an init").toBeDefined();

      // run init again with connect observed: it awaits connect and hands it `changed`
      const original = source.connect.bind(source);
      let finished = false;
      const connect = vi
        .spyOn(source, "connect")
        .mockImplementation(async (...args) => {
          await Promise.resolve();
          await original(...args);
          finished = true;
        });
      const logger = quietLogger(rt);
      let calls: Parameters<NonNullable<BillingSource["connect"]>>[] = [];
      try {
        await plugin?.init?.(context);
        expect(finished, "init must await source.connect").toBe(true);
        calls = [...connect.mock.calls];
      } finally {
        logger.restore();
        connect.mockRestore();
      }
      expect(calls).toHaveLength(1);
      const [given, changed] = calls[0] ?? [];
      expect(given).toBe(context);
      expect(typeof changed).toBe("function");

      // warm the cache with the no-state answer, then change the provider
      const plan = paidPlan(rt);
      expect((await resolveState(rt, organizationId)).result.plan.key).toBe(
        rt.catalog.defaultPlan,
      );
      await setup.setState(organizationId, paidState(rt, plan));
      await changed?.(organizationId);

      // `changed` resynced: the snapshot and the cache hold the new state
      const row = await snapshotOf(rt, organizationId);
      expect(row?.planKey).toBe(plan.toLowerCase());
      const read = await resolveState(rt, organizationId);
      expect(read.result.plan.key).toBe(plan);
      expect(read.result.plan.source).toBe("billing");
    },
  );

  return cases;
}

/**
 * Registers the `BillingSource` contract suite with vitest (`describe`/`it`):
 * the call shape; `null` for an organization without state; the state set
 * comes back; inputs aren't mutated; a throwing `resolve` gives a
 * `degraded` resolution and persists nothing; a paid state going to `null`,
 * or to one without `periodEnd`, ends with `planKey`/`periodEnd` null and
 * `defaultPlan`; `connect`, when present, is awaited and `changed`
 * resyncs. ESM only (imports `vitest`).
 */
export function testBillingSource(options: TestBillingSourceOptions): void {
  describe(options.name ?? "BillingSource", () => {
    for (const { name, run } of billingSourceCases(options)) {
      it(name, run, 30_000);
    }
  });
}
