import { describe, expect, it, vi } from "vitest";
import { createEntitlements } from "./api";
import { checkCapacity } from "./capacity";
import type { LimitValue } from "./catalog";
import type { EntitlementsOnError } from "./options";
import { getRuntime, makeAuth, seedOrg, testCatalog } from "./test-utils";

async function setup(
  config: {
    limits?: Record<string, LimitValue>;
    onError?: EntitlementsOnError;
    failWith?: Error;
  } = {},
) {
  const limits: Record<string, LimitValue> = { ...config.limits };
  const auth = makeAuth({
    options: {
      // limits change between calls: no cached resolution
      cacheTtlMs: 0,
      resolveEntitlements: () => {
        if (config.failWith) throw config.failWith;
        return { limits: { ...limits } };
      },
      ...(config.onError ? { onError: config.onError } : {}),
    },
  });
  const rt = await getRuntime(auth);
  const error = vi.fn();
  rt.logger = { ...rt.logger, error };
  const { organizationId } = await seedOrg(auth);
  return {
    rt,
    api: createEntitlements(auth, testCatalog),
    organizationId,
    limits,
    error,
  };
}

describe("checkCapacity (PRD #14)", () => {
  it("allows while count + adding <= limit (adding defaults to 1)", async () => {
    const t = await setup();
    // free: members 5
    expect(
      await t.api.checkCapacity(t.organizationId, "members", { count: 4 }),
    ).toEqual({
      allowed: true,
      reason: "ok",
      key: "members",
      plan: "free",
      upgradeTo: ["free", "pro", "team"],
      count: 4,
      limit: 5,
      over: false,
    });
    const atLimit = await t.api.checkCapacity(t.organizationId, "members", {
      count: 5,
    });
    expect(atLimit).toMatchObject({
      allowed: false,
      reason: "limit_reached",
      count: 5,
      limit: 5,
      over: false,
    });
    expect(atLimit.upgradeTo).toEqual(["pro", "team"]);
    expect(
      await t.api.checkCapacity(t.organizationId, "members", {
        count: 5,
        adding: 0,
      }),
    ).toMatchObject({ allowed: true, over: false });
    expect(
      await t.api.checkCapacity(t.organizationId, "members", {
        count: 2,
        adding: 4,
      }),
    ).toMatchObject({ allowed: false, reason: "limit_reached" });
    expect(t.error).not.toHaveBeenCalled();
  });

  it("over: a downgraded org above its new limit", async () => {
    const t = await setup({ limits: { members: 50 } });
    expect(
      await t.api.checkCapacity(t.organizationId, "members", { count: 12 }),
    ).toMatchObject({ allowed: true, over: false, limit: 50 });
    // downgrade: the limit drops below the current count, nothing is deleted
    t.limits.members = 10;
    const downgraded = await t.api.checkCapacity(t.organizationId, "members", {
      count: 12,
    });
    expect(downgraded).toMatchObject({
      allowed: false,
      reason: "limit_reached",
      count: 12,
      limit: 10,
      over: true,
    });
    expect(downgraded.upgradeTo).toEqual(["pro", "team"]);
    // removing rows is still a question for the app: adding 0 at 12 > 10
    expect(
      await t.api.checkCapacity(t.organizationId, "members", {
        count: 12,
        adding: 0,
      }),
    ).toMatchObject({ allowed: false, over: true });
  });

  it("unlimited always allows and is never over", async () => {
    const t = await setup({ limits: { projects: "unlimited" } });
    expect(
      await t.api.checkCapacity(t.organizationId, "projects", {
        count: 1_000_000,
        adding: 1_000,
      }),
    ).toMatchObject({
      allowed: true,
      reason: "ok",
      limit: "unlimited",
      over: false,
    });
  });

  it("a 0 limit refuses the first one", async () => {
    const t = await setup({ limits: { projects: 0 } });
    expect(
      await t.api.checkCapacity(t.organizationId, "projects", { count: 0 }),
    ).toMatchObject({ allowed: false, limit: 0, over: false });
  });

  it("throws for invalid numbers and for a key that isn't a capacity limit", async () => {
    const t = await setup();
    for (const opts of [
      { count: -1 },
      { count: 1.5 },
      { count: Number.NaN },
      { count: 1, adding: -1 },
      { count: 1, adding: 0.5 },
      {} as { count: number },
    ]) {
      await expect(
        checkCapacity(t.rt, t.organizationId, "members", opts),
      ).rejects.toThrow(
        "[@byo-oss/entitlements] checkCapacity: count and adding must be non-negative integers",
      );
    }
    for (const key of ["apiCalls", "retentionDays", "exports", "nope"]) {
      await expect(
        checkCapacity(t.rt, t.organizationId, key, { count: 0 }),
      ).rejects.toThrow(
        `[@byo-oss/entitlements] UNKNOWN_KEY: checkCapacity got "${key}", which isn't a capacity limit of the catalog`,
      );
    }
  });

  it("a degraded state answers onError with reason error, without a second log line", async () => {
    const failure = new Error("hook down");
    for (const answer of ["deny", "allow"] as const) {
      const onError = vi.fn(() => answer);
      const t = await setup({ failWith: failure, onError });
      const result = await t.api.checkCapacity(t.organizationId, "members", {
        count: 1,
      });
      expect(result).toMatchObject({
        allowed: answer === "allow",
        reason: "error",
        key: "members",
        plan: "free",
        upgradeTo: [],
        count: 1,
        over: false,
      });
      expect(onError).toHaveBeenCalledWith(failure, {
        organizationId: t.organizationId,
        key: "members",
        operation: "checkCapacity",
      });
      // the read's own line only
      expect(t.error).toHaveBeenCalledTimes(1);
    }
  });
});
