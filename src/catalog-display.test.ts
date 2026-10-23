import { describe, expect, it } from "vitest";
import { defineEntitlements } from "./catalog";

/** The app's copy for a plan: the shape every plan's `display` is checked against. */
interface PlanCopy {
  readonly name: string;
  readonly support: "Community" | "Priority";
  readonly items: readonly string[];
}

/** The message `run` throws; fails the test if it does not throw. */
function thrownMessage(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("expected a throw");
}

describe("defineEntitlements with a shared display shape", () => {
  it("the curried and plain forms return deep-equal catalogs", () => {
    const curried = defineEntitlements<PlanCopy>()({
      features: ["sso"],
      limits: { seats: { kind: "capacity" } },
      plans: {
        free: {
          features: { sso: false },
          limits: { seats: 3 },
          display: {
            name: "Free",
            support: "Community",
            items: ["3 seats"],
          },
        },
        pro: {
          features: { sso: true },
          limits: { seats: 25 },
          display: {
            name: "Pro",
            support: "Priority",
            items: ["25 seats"],
          },
        },
      },
      defaultPlan: "free",
      planAliases: { legacy: "pro" },
    });
    const plain = defineEntitlements({
      features: ["sso"],
      limits: { seats: { kind: "capacity" } },
      plans: {
        free: {
          features: { sso: false },
          limits: { seats: 3 },
          display: {
            name: "Free",
            support: "Community",
            items: ["3 seats"],
          },
        },
        pro: {
          features: { sso: true },
          limits: { seats: 25 },
          display: {
            name: "Pro",
            support: "Priority",
            items: ["25 seats"],
          },
        },
      },
      defaultPlan: "free",
      planAliases: { legacy: "pro" },
    });
    expect(curried).toEqual(plain);
  });

  it("the values of each plan come back as given", () => {
    const catalog = defineEntitlements<PlanCopy>()({
      features: ["sso"],
      limits: { seats: { kind: "capacity" } },
      plans: {
        free: {
          features: { sso: false },
          limits: { seats: 3 },
          display: {
            name: "Free",
            support: "Community",
            items: ["3 seats"],
          },
        },
        pro: {
          features: { sso: true },
          limits: { seats: 25 },
          display: {
            name: "Pro",
            support: "Priority",
            items: ["25 seats"],
          },
        },
      },
      defaultPlan: "free",
    });
    expect(catalog.defaultPlan).toBe("free");
    expect(catalog.plans.pro.features).toEqual({ sso: true });
    expect(catalog.plans.pro.limits).toEqual({ seats: 25 });
    expect(catalog.plans.pro.display).toEqual({
      name: "Pro",
      support: "Priority",
      items: ["25 seats"],
    });
    expect(catalog.plans.free.display.support).toBe("Community");
  });

  it("validation errors throw from the curried form with the plain form's message", () => {
    const badKey = {
      features: ["sso"],
      limits: { seats: { kind: "capacity" } },
      plans: {
        Pro: { features: { sso: true }, limits: { seats: 25 } },
        free: { features: { sso: false }, limits: { seats: 3 } },
      },
      defaultPlan: "free",
    };
    const curried = thrownMessage(() =>
      defineEntitlements<PlanCopy>()(badKey as never),
    );
    const plain = thrownMessage(() => defineEntitlements(badKey as never));
    expect(curried).toBe(plain);
    expect(curried).toMatch(
      /^\[@byo-oss\/entitlements\] plan key "Pro" must match/,
    );

    const missingLimit = {
      features: ["sso"],
      limits: { seats: { kind: "capacity" } },
      plans: {
        free: { features: { sso: false }, limits: {} },
      },
      defaultPlan: "free",
    };
    const curriedLimit = thrownMessage(() =>
      defineEntitlements<PlanCopy>()(missingLimit as never),
    );
    const plainLimit = thrownMessage(() =>
      defineEntitlements(missingLimit as never),
    );
    expect(curriedLimit).toBe(plainLimit);
    expect(curriedLimit).toBe(
      '[@byo-oss/entitlements] plan "free" is missing limit "seats"',
    );
  });

  it("defineEntitlements<D>() with no arguments does not throw and returns a function", () => {
    expect(() => defineEntitlements<PlanCopy>()).not.toThrow();
    expect(typeof defineEntitlements<PlanCopy>()).toBe("function");
  });

  it("each definer call gets its own planAliases default", () => {
    const define = defineEntitlements<PlanCopy>();
    const first = define({
      features: ["sso"],
      limits: { seats: { kind: "capacity" } },
      plans: {
        free: {
          features: { sso: false },
          limits: { seats: 3 },
          display: {
            name: "Free",
            support: "Community",
            items: ["3 seats"],
          },
        },
      },
      defaultPlan: "free",
    });
    const second = define({
      features: ["sso"],
      limits: { seats: { kind: "capacity" } },
      plans: {
        free: {
          features: { sso: false },
          limits: { seats: 3 },
          display: {
            name: "Free",
            support: "Community",
            items: ["3 seats"],
          },
        },
      },
      defaultPlan: "free",
    });
    expect(first).not.toBe(second);
    expect(first.planAliases).not.toBe(second.planAliases);
    expect(second.planAliases).toEqual({});

    // a change to one call's result does not reach the other
    (first.planAliases as Record<string, string>).legacy = "free";
    expect(second.planAliases).toEqual({});
  });
});
