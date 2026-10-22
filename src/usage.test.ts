import { describe, expect, it, vi } from "vitest";
import { createEntitlements } from "./api";
import type { LimitValue } from "./catalog";
import type { EntitlementsOnError } from "./options";
import { bucketKey, periodFor } from "./period";
import * as resolveModule from "./resolve";
import type { EntitlementSnapshotRow, EntitlementUsageRow } from "./schema";
import {
  fakeSource,
  getContext,
  getRuntime,
  makeAuth,
  seedOrg,
  seedUsage,
  setSnapshot,
  testCatalog,
  type WrapAdapterOptions,
} from "./test-utils";
import type { ResolvedState } from "./types";
import { consumeUsage, getLimit, hasFeature, readUsage } from "./usage";

const NOW = new Date("2026-03-10T12:00:00.000Z");
const DAY_START = new Date("2026-03-10T00:00:00.000Z");
const DAY_END = new Date("2026-03-11T00:00:00.000Z");
const MONTH_START = new Date("2026-03-01T00:00:00.000Z");
const MONTH_END = new Date("2026-04-01T00:00:00.000Z");

/**
 * A memory-lane auth whose limits are varied through `resolveEntitlements`
 * (the resolve stub answers `defaultPlan`), a fixed clock, an `onEvent` spy
 * and an `error` spy on the runtime's logger.
 */
async function setup(
  config: {
    limits?: Record<string, LimitValue>;
    features?: Record<string, boolean>;
    onError?: EntitlementsOnError;
    adapter?: WrapAdapterOptions;
  } = {},
) {
  const limits: Record<string, LimitValue> = { ...config.limits };
  const features: Record<string, boolean> = { ...config.features };
  const onEvent = vi.fn();
  const auth = makeAuth({
    options: {
      // limits change between calls: no cached resolution
      cacheTtlMs: 0,
      resolveEntitlements: () => ({
        limits: { ...limits },
        features: { ...features },
      }),
      onEvent,
      ...(config.onError ? { onError: config.onError } : {}),
    },
    adapter: config.adapter,
  });
  const rt = await getRuntime(auth);
  const context = await getContext(auth);
  let now = NOW;
  rt.now = () => new Date(now.getTime());
  const error = vi.fn();
  rt.logger = { ...rt.logger, error };
  const { organizationId } = await seedOrg(auth);
  const api = createEntitlements(auth, testCatalog);
  const bucketRow = (key: string, periodStart: Date) =>
    context.adapter.findOne<EntitlementUsageRow>({
      model: "entitlementUsage",
      where: [
        { field: "bucket", value: bucketKey(organizationId, key, periodStart) },
      ],
    });
  const bucketCount = () =>
    context.adapter.count({
      model: "entitlementUsage",
      where: [{ field: "organizationId", value: organizationId }],
    });
  const limitEvents = () =>
    onEvent.mock.calls
      .map((call) => call[0])
      .filter((event) => event.type === "entitlements.usage.limit_reached");
  return {
    auth,
    rt,
    api,
    context,
    organizationId,
    limits,
    features,
    onEvent,
    error,
    bucketRow,
    bucketCount,
    limitEvents,
    setNow: (date: Date) => {
      now = date;
    },
  };
}

describe("consumeUsage: concurrent consumption (PRD #12, memory)", () => {
  it("50 parallel calls with limit 20 → exactly 20 allowed, used 20, 30 refused, one firstRefusal, one bucket row", async () => {
    const t = await setup({ limits: { apiCalls: 20 } });
    const results = await Promise.all(
      Array.from({ length: 50 }, () =>
        t.api.consumeUsage(t.organizationId, "apiCalls"),
      ),
    );
    expect(results.filter((r) => r.allowed)).toHaveLength(20);
    expect(results.filter((r) => !r.allowed)).toHaveLength(30);
    expect(
      results
        .filter((r) => !r.allowed)
        .every((r) => r.reason === "limit_reached"),
    ).toBe(true);
    expect(results.filter((r) => r.firstRefusal)).toHaveLength(1);
    expect(await t.bucketCount()).toBe(1);
    const row = await t.bucketRow("apiCalls", DAY_START);
    expect(row).toMatchObject({ used: 20, refused: 30 });
    expect(t.limitEvents()).toHaveLength(1);
    expect(t.error).not.toHaveBeenCalled();
  });
});

describe("consumeUsage: refusals, zero limits, periods (PRD #13)", () => {
  it("allows up to the limit and reports used, remaining and resetAt", async () => {
    const t = await setup({ limits: { apiCalls: 5 } });
    const first = await t.api.consumeUsage(t.organizationId, "apiCalls");
    expect(first).toMatchObject({
      allowed: true,
      reason: "ok",
      key: "apiCalls",
      plan: "free",
      used: 1,
      limit: 5,
      remaining: 4,
      firstRefusal: false,
    });
    expect(first.resetAt).toEqual(DAY_END);
    const second = await t.api.consumeUsage(t.organizationId, "apiCalls", {
      amount: 4,
    });
    expect(second).toMatchObject({ allowed: true, used: 5, remaining: 0 });
    const row = await t.bucketRow("apiCalls", DAY_START);
    expect(row).toMatchObject({
      organizationId: t.organizationId,
      key: "apiCalls",
      used: 5,
      refused: 0,
    });
    expect(row?.periodStart).toEqual(DAY_START);
    expect(row?.periodEnd).toEqual(DAY_END);
  });

  it("refusals don't count: used stays put, refused increments, limit_reached is emitted once", async () => {
    const t = await setup({ limits: { apiCalls: 5 } });
    await t.api.consumeUsage(t.organizationId, "apiCalls", { amount: 3 });
    // 3 + 3 > 5: refused, nothing counted
    const tooMuch = await t.api.consumeUsage(t.organizationId, "apiCalls", {
      amount: 3,
    });
    expect(tooMuch).toMatchObject({
      allowed: false,
      reason: "limit_reached",
      used: 3,
      remaining: 2,
      limit: 5,
      firstRefusal: true,
    });
    expect(tooMuch.upgradeTo).toEqual(["free", "pro", "team"]);
    // what is left still fits
    expect(
      await t.api.consumeUsage(t.organizationId, "apiCalls", { amount: 2 }),
    ).toMatchObject({ allowed: true, used: 5, remaining: 0 });
    const again = await t.api.consumeUsage(t.organizationId, "apiCalls");
    expect(again).toMatchObject({
      allowed: false,
      used: 5,
      firstRefusal: false,
    });
    expect(await t.bucketRow("apiCalls", DAY_START)).toMatchObject({
      used: 5,
      refused: 2,
    });
    const events = t.limitEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "entitlements.usage.limit_reached",
      organizationId: t.organizationId,
      actorId: null,
      subject: { type: "organization", id: t.organizationId },
      data: { key: "apiCalls", limit: 5, periodEnd: DAY_END },
    });
    expect(events[0].occurredAt).toEqual(NOW);
  });

  it("a 0 limit refuses, creates the bucket, and signals once per period", async () => {
    const t = await setup({ limits: { apiCalls: 0 } });
    const first = await t.api.consumeUsage(t.organizationId, "apiCalls");
    expect(first).toMatchObject({
      allowed: false,
      reason: "limit_reached",
      used: 0,
      limit: 0,
      remaining: 0,
      firstRefusal: true,
    });
    const second = await t.api.consumeUsage(t.organizationId, "apiCalls");
    expect(second).toMatchObject({ allowed: false, firstRefusal: false });
    expect(await t.bucketRow("apiCalls", DAY_START)).toMatchObject({
      used: 0,
      refused: 2,
    });
    expect(await t.bucketCount()).toBe(1);
    expect(t.limitEvents()).toHaveLength(1);
  });

  it("amount above the limit refuses on a fresh bucket without counting", async () => {
    const t = await setup({ limits: { apiCalls: 5 } });
    const result = await t.api.consumeUsage(t.organizationId, "apiCalls", {
      amount: 6,
    });
    expect(result).toMatchObject({
      allowed: false,
      used: 0,
      firstRefusal: true,
    });
    expect(await t.bucketRow("apiCalls", DAY_START)).toMatchObject({
      used: 0,
      refused: 1,
    });
  });

  it("unlimited always allows", async () => {
    const t = await setup({ limits: { apiCalls: "unlimited" } });
    const result = await t.api.consumeUsage(t.organizationId, "apiCalls", {
      amount: 1_000_000,
    });
    expect(result).toMatchObject({
      allowed: true,
      used: 1_000_000,
      limit: "unlimited",
      remaining: "unlimited",
    });
  });

  it("consumes from an existing bucket (seeded) and refuses at its limit", async () => {
    const t = await setup({ limits: { apiCalls: 10 } });
    t.setNow(NOW);
    await seedUsage(t.auth, {
      organizationId: t.organizationId,
      key: "apiCalls",
      used: 9,
    });
    expect(
      await t.api.consumeUsage(t.organizationId, "apiCalls"),
    ).toMatchObject({ allowed: true, used: 10 });
    expect(
      await t.api.consumeUsage(t.organizationId, "apiCalls"),
    ).toMatchObject({ allowed: false, used: 10, firstRefusal: true });
    expect(await t.bucketCount()).toBe(1);
  });

  it("day rollover (UTC) starts a new bucket, and the first refusal signals again", async () => {
    const t = await setup({ limits: { apiCalls: 1 } });
    t.setNow(new Date("2026-03-10T23:59:59.999Z"));
    expect(
      await t.api.consumeUsage(t.organizationId, "apiCalls"),
    ).toMatchObject({ allowed: true, used: 1 });
    expect(
      await t.api.consumeUsage(t.organizationId, "apiCalls"),
    ).toMatchObject({ allowed: false, firstRefusal: true });
    t.setNow(new Date("2026-03-11T00:00:00.000Z"));
    const next = await t.api.consumeUsage(t.organizationId, "apiCalls");
    expect(next).toMatchObject({ allowed: true, used: 1 });
    expect(next.resetAt).toEqual(new Date("2026-03-12T00:00:00.000Z"));
    expect(
      await t.api.consumeUsage(t.organizationId, "apiCalls"),
    ).toMatchObject({ allowed: false, firstRefusal: true });
    expect(await t.bucketCount()).toBe(2);
    expect(t.limitEvents()).toHaveLength(2);
    expect(
      await t.bucketRow("apiCalls", new Date("2026-03-11T00:00:00.000Z")),
    ).toMatchObject({ used: 1, refused: 1 });
  });

  it("month rollover (UTC) starts a new bucket", async () => {
    const t = await setup({ limits: { uploads: 2 } });
    t.setNow(new Date("2026-03-31T23:00:00.000Z"));
    await t.api.consumeUsage(t.organizationId, "uploads", { amount: 2 });
    expect(await t.api.consumeUsage(t.organizationId, "uploads")).toMatchObject(
      { allowed: false },
    );
    t.setNow(new Date("2026-04-01T00:00:00.000Z"));
    const next = await t.api.consumeUsage(t.organizationId, "uploads");
    expect(next).toMatchObject({ allowed: true, used: 1 });
    expect(next.resetAt).toEqual(new Date("2026-05-01T00:00:00.000Z"));
    expect(await t.bucketCount()).toBe(2);
    expect(
      await t.bucketRow("uploads", new Date("2026-03-01T00:00:00.000Z")),
    ).toMatchObject({ used: 2, refused: 1 });
  });

  it("billing follows the snapshot period while entitled and in period, else the UTC month", async () => {
    const t = await setup({ limits: { reports: 3 } });
    const periodStart = new Date("2026-02-15T08:00:00.000Z");
    const periodEnd = new Date("2026-03-15T08:00:00.000Z");
    const base = await resolveModule.resolveState(t.rt, t.organizationId);
    const snapshot = { periodStart, periodEnd } as EntitlementSnapshotRow;
    let entitled = true;
    const spy = vi
      .spyOn(resolveModule, "resolveState")
      .mockImplementation(async () => ({ ...base, snapshot, entitled }));
    try {
      const inPeriod = await t.api.consumeUsage(t.organizationId, "reports");
      expect(inPeriod).toMatchObject({ allowed: true, used: 1 });
      expect(inPeriod.resetAt).toEqual(periodEnd);
      expect(await t.bucketRow("reports", periodStart)).toMatchObject({
        used: 1,
        periodEnd,
      });
      // not entitled any more: the UTC month, not the old period
      entitled = false;
      const lapsed = await t.api.consumeUsage(t.organizationId, "reports");
      expect(lapsed).toMatchObject({ allowed: true, used: 1 });
      expect(lapsed.resetAt).toEqual(MONTH_END);
      expect(await t.bucketRow("reports", MONTH_START)).toMatchObject({
        used: 1,
      });
      // entitled but past periodEnd: the UTC month too
      entitled = true;
      t.setNow(new Date("2026-03-20T00:00:00.000Z"));
      const ended = await t.api.consumeUsage(t.organizationId, "reports");
      expect(ended).toMatchObject({ allowed: true, used: 2 });
      expect(ended.resetAt).toEqual(MONTH_END);
      expect(await t.bucketCount()).toBe(2);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("periodFor", () => {
  const snapshot = (periodStart: Date | null, periodEnd: Date | null) =>
    ({ periodStart, periodEnd }) as EntitlementSnapshotRow;
  const start = new Date("2026-02-15T08:00:00.000Z");
  const end = new Date("2026-03-15T08:00:00.000Z");

  it("day and month are UTC calendar periods", () => {
    const none = { snapshot: null, entitled: false };
    expect(periodFor("day", none, NOW)).toEqual({
      start: DAY_START,
      end: DAY_END,
    });
    expect(periodFor("month", none, NOW)).toEqual({
      start: MONTH_START,
      end: MONTH_END,
    });
    expect(
      periodFor("month", none, new Date("2026-12-31T23:59:59.999Z")),
    ).toEqual({
      start: new Date("2026-12-01T00:00:00.000Z"),
      end: new Date("2027-01-01T00:00:00.000Z"),
    });
    // a day/month key ignores the snapshot period
    expect(
      periodFor("day", { snapshot: snapshot(start, end), entitled: true }, NOW),
    ).toEqual({ start: DAY_START, end: DAY_END });
  });

  it("billing = the snapshot period only while entitled and periodStart <= now < periodEnd", () => {
    const entitled = { snapshot: snapshot(start, end), entitled: true };
    expect(periodFor("billing", entitled, NOW)).toEqual({ start, end });
    expect(periodFor("billing", entitled, start)).toEqual({ start, end });
    // now === periodEnd: the period is over
    expect(periodFor("billing", entitled, end)).toEqual({
      start: MONTH_START,
      end: MONTH_END,
    });
    expect(
      periodFor("billing", entitled, new Date("2026-02-01T00:00:00.000Z")),
    ).toEqual({
      start: new Date("2026-02-01T00:00:00.000Z"),
      end: MONTH_START,
    });
    expect(
      periodFor(
        "billing",
        { snapshot: snapshot(start, end), entitled: false },
        NOW,
      ),
    ).toEqual({ start: MONTH_START, end: MONTH_END });
    expect(
      periodFor(
        "billing",
        { snapshot: snapshot(null, end), entitled: true },
        NOW,
      ),
    ).toEqual({ start: MONTH_START, end: MONTH_END });
    expect(
      periodFor(
        "billing",
        { snapshot: snapshot(start, null), entitled: true },
        NOW,
      ),
    ).toEqual({ start: MONTH_START, end: MONTH_END });
    expect(
      periodFor("billing", { snapshot: null, entitled: false }, NOW),
    ).toEqual({ start: MONTH_START, end: MONTH_END });
  });

  it("reads a seeded snapshot row's dates", async () => {
    const source = fakeSource();
    const auth = makeAuth({ options: { source } });
    const { organizationId } = await seedOrg(auth);
    const row = await setSnapshot(auth, organizationId, {
      planKey: "pro",
      status: "active",
      periodStart: start,
      periodEnd: end,
    });
    expect(
      periodFor("billing", { snapshot: row, entitled: true }, NOW),
    ).toEqual({ start, end });
  });
});

describe("consumeUsage: argument errors and transactions", () => {
  it("throws UNKNOWN_KEY for a key that isn't a metered limit", async () => {
    const t = await setup();
    for (const key of ["members", "retentionDays", "exports", "nope"]) {
      await expect(consumeUsage(t.rt, t.organizationId, key)).rejects.toThrow(
        `[@byo-oss/entitlements] UNKNOWN_KEY: consumeUsage got "${key}", which isn't a metered limit of the catalog`,
      );
    }
  });

  it("amount must be a positive integer", async () => {
    const t = await setup();
    for (const amount of [0, -1, 1.5, Number.NaN]) {
      await expect(
        consumeUsage(t.rt, t.organizationId, "apiCalls", { amount }),
      ).rejects.toThrow(
        "[@byo-oss/entitlements] consumeUsage: amount must be a positive integer",
      );
    }
    expect(await t.bucketCount()).toBe(0);
  });
});

describe("failure policy for checks (PRD #11, checks half)", () => {
  const throwingHook = (failure: Error) => ({
    resolveEntitlements: () => {
      throw failure;
    },
  });

  async function degradedSetup(onError?: EntitlementsOnError) {
    const failure = new Error("hook down");
    const onErrorSpy = vi.fn(onError ?? (() => "deny" as const));
    const auth = makeAuth({
      options: { ...throwingHook(failure), onError: onErrorSpy },
    });
    const rt = await getRuntime(auth);
    const context = await getContext(auth);
    const error = vi.fn();
    rt.logger = { ...rt.logger, error };
    const { organizationId } = await seedOrg(auth);
    return {
      failure,
      onErrorSpy,
      api: createEntitlements(auth, testCatalog),
      rt,
      context,
      error,
      organizationId,
    };
  }

  it("a degraded state → each check answers onError (deny) with reason error, logging only the read's line", async () => {
    const t = await degradedSetup();
    const feature = await t.api.hasFeature(t.organizationId, "exports");
    expect(feature).toMatchObject({
      allowed: false,
      reason: "error",
      plan: "free",
      upgradeTo: [],
    });
    expect(t.error).toHaveBeenCalledTimes(1);
    const consumed = await t.api.consumeUsage(t.organizationId, "apiCalls");
    expect(consumed).toMatchObject({
      allowed: false,
      reason: "error",
      firstRefusal: false,
      limit: 1_000,
    });
    expect(t.error).toHaveBeenCalledTimes(2);
    const capacity = await t.api.checkCapacity(t.organizationId, "members", {
      count: 0,
    });
    expect(capacity).toMatchObject({ allowed: false, reason: "error" });
    expect(t.error).toHaveBeenCalledTimes(3);
    // one log line per failure: every line is the read's own
    for (const call of t.error.mock.calls) expect(call[1]).toBe(t.failure);
    expect(t.onErrorSpy.mock.calls).toEqual([
      [
        t.failure,
        {
          organizationId: t.organizationId,
          key: "exports",
          operation: "hasFeature",
        },
      ],
      [
        t.failure,
        {
          organizationId: t.organizationId,
          key: "apiCalls",
          operation: "consumeUsage",
        },
      ],
      [
        t.failure,
        {
          organizationId: t.organizationId,
          key: "members",
          operation: "checkCapacity",
        },
      ],
    ]);
    // a degraded consume touches no bucket
    expect(
      await t.context.adapter.count({
        model: "entitlementUsage",
        where: [{ field: "organizationId", value: t.organizationId }],
      }),
    ).toBe(0);
  });

  it("onError allow → allowed: true with reason error", async () => {
    const t = await degradedSetup(() => "allow");
    expect(await t.api.hasFeature(t.organizationId, "exports")).toMatchObject({
      allowed: true,
      reason: "error",
    });
    expect(
      await t.api.consumeUsage(t.organizationId, "apiCalls"),
    ).toMatchObject({ allowed: true, reason: "error" });
    expect(
      await t.api.checkCapacity(t.organizationId, "members", { count: 99 }),
    ).toMatchObject({ allowed: true, reason: "error" });
    expect(t.error).toHaveBeenCalledTimes(3);
  });

  it("a degraded getLimit answers defaultPlan, degraded: true, reason error, without logging again", async () => {
    const t = await degradedSetup();
    const metered = await t.api.getLimit(t.organizationId, "apiCalls");
    expect(metered).toMatchObject({
      allowed: false,
      reason: "error",
      degraded: true,
      plan: "free",
      limit: 1_000,
      used: 0,
      remaining: 1_000,
    });
    const value = await t.api.getLimit(t.organizationId, "retentionDays");
    expect(value).toMatchObject({
      reason: "error",
      degraded: true,
      limit: 7,
    });
    expect(t.error).toHaveBeenCalledTimes(2);
    expect(t.onErrorSpy).not.toHaveBeenCalled();
  });

  it("consumeUsage's own query failure → onError, logged once", async () => {
    const failure = new Error("usage table down");
    for (const answer of ["deny", "allow"] as const) {
      const onError = vi.fn(() => answer);
      const t = await setup({
        onError,
        adapter: {
          before: (call) => {
            if (call.model === "entitlementUsage") throw failure;
          },
        },
      });
      const result = await t.api.consumeUsage(t.organizationId, "apiCalls");
      expect(result).toMatchObject({
        allowed: answer === "allow",
        reason: "error",
        firstRefusal: false,
      });
      expect(onError).toHaveBeenCalledWith(failure, {
        organizationId: t.organizationId,
        key: "apiCalls",
        operation: "consumeUsage",
      });
      expect(t.error).toHaveBeenCalledTimes(1);
      expect(t.error).toHaveBeenCalledWith(expect.any(String), failure);
    }
  });

  it("a failing refusal increment → onError, logged once, no event", async () => {
    const failure = new Error("refused counter down");
    const t = await setup({
      limits: { apiCalls: 0 },
      adapter: {
        before: (call) => {
          if (
            call.model === "entitlementUsage" &&
            call.method === "incrementOne"
          ) {
            throw failure;
          }
        },
      },
    });
    expect(
      await t.api.consumeUsage(t.organizationId, "apiCalls"),
    ).toMatchObject({ allowed: false, reason: "error" });
    expect(t.error).toHaveBeenCalledTimes(1);
    expect(t.limitEvents()).toHaveLength(0);
  });

  it("getLimit logs a readUsage failure once and answers degraded; readUsage itself throws without logging", async () => {
    const failure = new Error("usage read down");
    const t = await setup({
      limits: { apiCalls: 50 },
      adapter: {
        before: (call) => {
          if (call.model === "entitlementUsage") throw failure;
        },
      },
    });
    const result = await t.api.getLimit(t.organizationId, "apiCalls");
    expect(result).toMatchObject({
      allowed: false,
      reason: "error",
      degraded: true,
      plan: "free",
      // defaultPlan's own limit, not the adjusted one
      limit: 1_000,
      used: 0,
    });
    expect(t.error).toHaveBeenCalledTimes(1);
    expect(t.error).toHaveBeenCalledWith(expect.any(String), failure);
    const state = await resolveModule.resolveState(t.rt, t.organizationId);
    await expect(
      readUsage(t.rt, t.context.adapter, t.organizationId, "apiCalls", state),
    ).rejects.toBe(failure);
    expect(t.error).toHaveBeenCalledTimes(1);
  });
});

describe("getLimit", () => {
  it("metered keys report the counter without creating a bucket", async () => {
    const t = await setup({ limits: { apiCalls: 10 } });
    const empty = await t.api.getLimit(t.organizationId, "apiCalls");
    expect(empty).toMatchObject({
      allowed: true,
      reason: "ok",
      key: "apiCalls",
      plan: "free",
      limit: 10,
      degraded: false,
      used: 0,
      remaining: 10,
    });
    expect(empty.resetAt).toEqual(DAY_END);
    expect(await t.bucketCount()).toBe(0);
    await seedUsage(t.auth, {
      organizationId: t.organizationId,
      key: "apiCalls",
      used: 7,
    });
    const used = await t.api.getLimit(t.organizationId, "apiCalls");
    expect(used).toMatchObject({ allowed: true, used: 7, remaining: 3 });
    // upgradeTo: plans with at least used + 1
    expect(used.upgradeTo).toEqual(["free", "pro", "team"]);
    expect(await t.bucketCount()).toBe(1);
  });

  it("limit_reached when nothing remains, not_in_plan for a 0 limit", async () => {
    const t = await setup({ limits: { apiCalls: 3, members: 0 } });
    await t.api.consumeUsage(t.organizationId, "apiCalls", { amount: 3 });
    const reached = await t.api.getLimit(t.organizationId, "apiCalls");
    expect(reached).toMatchObject({
      allowed: false,
      reason: "limit_reached",
      remaining: 0,
    });
    expect(reached.upgradeTo).toEqual(["free", "pro", "team"]);
    const capacity = await t.api.getLimit(t.organizationId, "members");
    expect(capacity).toMatchObject({
      allowed: false,
      reason: "not_in_plan",
      limit: 0,
      degraded: false,
    });
    expect(capacity).not.toHaveProperty("used");
    expect(capacity.upgradeTo).toEqual(["free", "pro", "team"]);
    t.limits.apiCalls = 0;
    expect(await t.api.getLimit(t.organizationId, "apiCalls")).toMatchObject({
      allowed: false,
      reason: "not_in_plan",
    });
  });

  it("value and unlimited limits", async () => {
    const t = await setup({ limits: { uploads: "unlimited" } });
    expect(
      await t.api.getLimit(t.organizationId, "retentionDays"),
    ).toMatchObject({ allowed: true, reason: "ok", limit: 7 });
    const unlimited = await t.api.getLimit(t.organizationId, "uploads");
    expect(unlimited).toMatchObject({
      allowed: true,
      limit: "unlimited",
      remaining: "unlimited",
    });
    expect(unlimited.resetAt).toEqual(MONTH_END);
  });

  it("throws UNKNOWN_KEY for a key that isn't a limit", async () => {
    const t = await setup();
    await expect(getLimit(t.rt, t.organizationId, "exports")).rejects.toThrow(
      `[@byo-oss/entitlements] UNKNOWN_KEY: getLimit got "exports", which isn't a limit of the catalog`,
    );
  });
});

describe("hasFeature", () => {
  it("answers the resolved feature value with upgradeTo", async () => {
    const t = await setup({ features: { sso: true } });
    const exports = await t.api.hasFeature(t.organizationId, "exports");
    expect(exports).toEqual({
      allowed: false,
      reason: "not_in_plan",
      key: "exports",
      plan: "free",
      upgradeTo: ["pro", "team"],
    });
    expect(await t.api.hasFeature(t.organizationId, "sso")).toMatchObject({
      allowed: true,
      reason: "ok",
      upgradeTo: ["team"],
    });
  });

  it("throws UNKNOWN_KEY for a key that isn't a feature", async () => {
    const t = await setup();
    await expect(
      hasFeature(t.rt, t.organizationId, "apiCalls"),
    ).rejects.toThrow(
      `[@byo-oss/entitlements] UNKNOWN_KEY: hasFeature got "apiCalls", which isn't a feature of the catalog`,
    );
  });
});

describe("readUsage", () => {
  it("reads the current period's bucket, used 0 without one", async () => {
    const t = await setup({ limits: { apiCalls: 4 } });
    const state: ResolvedState = await resolveModule.resolveState(
      t.rt,
      t.organizationId,
    );
    expect(
      await readUsage(
        t.rt,
        t.context.adapter,
        t.organizationId,
        "apiCalls",
        state,
      ),
    ).toEqual({ used: 0, remaining: 4, resetAt: DAY_END });
    await seedUsage(t.auth, {
      organizationId: t.organizationId,
      key: "apiCalls",
      used: 6,
    });
    expect(
      await readUsage(
        t.rt,
        t.context.adapter,
        t.organizationId,
        "apiCalls",
        state,
      ),
    ).toEqual({ used: 6, remaining: 0, resetAt: DAY_END });
    expect(await t.bucketCount()).toBe(1);
  });
});
