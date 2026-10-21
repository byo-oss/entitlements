import { describe, expect, it, vi } from "vitest";
import { createEntitlements } from "./api";
import { defineEntitlements, MAX_CATALOG_KEYS } from "./catalog";
import { entitlements } from "./index";
import {
  ENTITLEMENTS_DEFAULTS,
  type EntitlementsOptions,
  resolveOptions,
} from "./options";
import { makeAuth, seedOrg, testCatalog } from "./test-utils";

const PREFIX = /^\[@byo-oss\/entitlements\] /;

/** A valid catalog as plain data, for tests that break one rule at a time. */
function rawCatalog() {
  return {
    features: ["exports", "sso"],
    limits: {
      apiCalls: { kind: "metered", period: "day" },
      members: { kind: "capacity" },
    },
    plans: {
      free: {
        features: { exports: false, sso: false },
        limits: { apiCalls: 10, members: 3 },
      },
      pro: {
        features: { exports: true, sso: false },
        limits: { apiCalls: 100, members: "unlimited" },
        display: { name: "Pro" },
      },
    },
    defaultPlan: "free",
    planAliases: { legacy: "pro" },
  } as Record<string, unknown> & {
    features: unknown[];
    limits: Record<string, unknown>;
    plans: Record<string, Record<string, Record<string, unknown>>>;
    planAliases: Record<string, unknown>;
  };
}

type Raw = ReturnType<typeof rawCatalog>;

/** Boots the plugin with a catalog built by `edit`, skipping the types. */
const boot = (edit: (catalog: Raw) => void) => () => {
  const catalog = rawCatalog();
  edit(catalog);
  return entitlements({ catalog } as unknown as EntitlementsOptions);
};

const bootWith = (options: Record<string, unknown>) => () =>
  entitlements({
    catalog: testCatalog,
    ...options,
  } as unknown as EntitlementsOptions);

describe("boot validation: catalog", () => {
  it("accepts a valid catalog", () => {
    expect(boot(() => {})).not.toThrow();
  });

  it("requires a catalog", () => {
    expect(() => entitlements({} as unknown as EntitlementsOptions)).toThrow(
      /^\[@byo-oss\/entitlements\] catalog is required/,
    );
  });

  it("defaultPlan not in plans", () => {
    expect(
      boot((c) => {
        c.defaultPlan = "gold";
      }),
    ).toThrow(/^\[@byo-oss\/entitlements\] defaultPlan "gold" is not in plans/);
  });

  it("a plan missing a feature", () => {
    expect(
      boot((c) => {
        delete c.plans.free?.features?.sso;
      }),
    ).toThrow(
      /^\[@byo-oss\/entitlements\] plan "free" is missing feature "sso"/,
    );
  });

  it("a plan missing a limit", () => {
    expect(
      boot((c) => {
        delete c.plans.pro?.limits?.members;
      }),
    ).toThrow(
      /^\[@byo-oss\/entitlements\] plan "pro" is missing limit "members"/,
    );
  });

  it("a plan setting an unknown feature", () => {
    expect(
      boot((c) => {
        (c.plans.free?.features as Record<string, unknown>).audit = true;
      }),
    ).toThrow(
      /^\[@byo-oss\/entitlements\] plan "free" sets unknown feature "audit"/,
    );
  });

  it("a plan setting an unknown limit", () => {
    expect(
      boot((c) => {
        (c.plans.free?.limits as Record<string, unknown>).seats = 3;
      }),
    ).toThrow(
      /^\[@byo-oss\/entitlements\] plan "free" sets unknown limit "seats"/,
    );
  });

  it("a plan setting an unknown field", () => {
    expect(
      boot((c) => {
        (c.plans.free as Record<string, unknown>).price = 10;
      }),
    ).toThrow(
      /^\[@byo-oss\/entitlements\] plan "free" sets unknown field "price"/,
    );
  });

  it("a negative limit", () => {
    expect(
      boot((c) => {
        (c.plans.free?.limits as Record<string, unknown>).members = -1;
      }),
    ).toThrow(
      /^\[@byo-oss\/entitlements\] plan "free" limit "members" must be a non-negative integer or "unlimited"/,
    );
  });

  it("a non-integer limit", () => {
    expect(
      boot((c) => {
        (c.plans.free?.limits as Record<string, unknown>).apiCalls = 2.5;
      }),
    ).toThrow(
      /^\[@byo-oss\/entitlements\] plan "free" limit "apiCalls" must be a non-negative integer or "unlimited"/,
    );
  });

  it('a limit that is neither a number nor "unlimited"', () => {
    expect(
      boot((c) => {
        (c.plans.free?.limits as Record<string, unknown>).apiCalls = "lots";
      }),
    ).toThrow(/limit "apiCalls" must be a non-negative integer or "unlimited"/);
  });

  it("a feature value that isn't a boolean", () => {
    expect(
      boot((c) => {
        (c.plans.free?.features as Record<string, unknown>).sso = "yes";
      }),
    ).toThrow(
      /^\[@byo-oss\/entitlements\] plan "free" feature "sso" must be true or false/,
    );
  });

  it("a plan key outside the pattern", () => {
    for (const key of ["Pro", "1pro", "pro plan", "pro.v2", ""]) {
      expect(
        boot((c) => {
          c.plans[key] = c.plans.pro as Record<string, Record<string, unknown>>;
        }),
        key,
      ).toThrow(
        new RegExp(
          `^\\[@byo-oss/entitlements\\] plan key "${key.replace(".", "\\.")}" must match`,
        ),
      );
    }
    expect(
      boot((c) => {
        c.plans["pro_v2-annual"] = c.plans.pro as Record<
          string,
          Record<string, unknown>
        >;
      }),
    ).not.toThrow();
  });

  it("an alias that shadows a plan", () => {
    expect(
      boot((c) => {
        c.planAliases.pro = "free";
      }),
    ).toThrow(/^\[@byo-oss\/entitlements\] plan alias "pro" shadows a plan/);
  });

  it("an alias that points to an unknown plan", () => {
    expect(
      boot((c) => {
        c.planAliases.legacy = "gold";
      }),
    ).toThrow(
      /^\[@byo-oss\/entitlements\] plan alias "legacy" points to "gold", which is not in plans/,
    );
  });

  it("an alias key outside the pattern", () => {
    expect(
      boot((c) => {
        c.planAliases.Legacy = "pro";
      }),
    ).toThrow(/^\[@byo-oss\/entitlements\] plan alias "Legacy" must match/);
  });

  it("more than 150 feature and limit keys", () => {
    const sized = (features: number, limits: number) => (c: Raw) => {
      c.features = Array.from({ length: features }, (_, i) => `f${i}`);
      c.limits = Object.fromEntries(
        Array.from({ length: limits }, (_, i) => [`l${i}`, { kind: "value" }]),
      );
      const plan = {
        features: Object.fromEntries(c.features.map((f) => [f, false])),
        limits: Object.fromEntries(Object.keys(c.limits).map((l) => [l, 1])),
      };
      c.plans = { free: plan };
      c.planAliases = {};
    };
    expect(MAX_CATALOG_KEYS).toBe(150);
    expect(boot(sized(100, 50))).not.toThrow();
    expect(boot(sized(100, 51))).toThrow(
      /^\[@byo-oss\/entitlements\] the catalog has 151 feature and limit keys; at most 150 are allowed/,
    );
  });

  it("a key that is both a feature and a limit", () => {
    expect(
      boot((c) => {
        c.limits.exports = { kind: "value" };
      }),
    ).toThrow(
      /^\[@byo-oss\/entitlements\] "exports" is both a feature and a limit/,
    );
  });

  it("a feature listed twice", () => {
    expect(
      boot((c) => {
        c.features.push("sso");
      }),
    ).toThrow(/^\[@byo-oss\/entitlements\] feature "sso" is listed twice/);
  });

  it("a limit with an unknown kind or period", () => {
    expect(
      boot((c) => {
        c.limits.members = { kind: "seats" };
      }),
    ).toThrow(/limit "members" needs kind "metered", "capacity" or "value"/);
    expect(
      boot((c) => {
        c.limits.apiCalls = { kind: "metered", period: "week" };
      }),
    ).toThrow(
      /metered limit "apiCalls" needs period "day", "month" or "billing"/,
    );
  });

  it("a catalog without plans", () => {
    expect(
      boot((c) => {
        c.plans = {};
      }),
    ).toThrow(
      /^\[@byo-oss\/entitlements\] catalog\.plans needs at least one plan/,
    );
  });

  it("defineEntitlements runs the same checks", () => {
    const catalog = rawCatalog();
    catalog.defaultPlan = "gold";
    expect(() => defineEntitlements(catalog as never)).toThrow(
      /^\[@byo-oss\/entitlements\] defaultPlan "gold" is not in plans/,
    );
    const ok = defineEntitlements({
      features: ["exports"],
      limits: {},
      plans: { free: { features: { exports: false }, limits: {} } },
      defaultPlan: "free",
    });
    expect(ok.planAliases).toEqual({});
  });
});

describe("boot validation: options", () => {
  it("staffOrganizationId set to an empty string", () => {
    expect(bootWith({ staffOrganizationId: "" })).toThrow(
      /^\[@byo-oss\/entitlements\] staffOrganizationId is an empty string/,
    );
    expect(bootWith({ staffOrganizationId: "org_staff" })).not.toThrow();
  });

  it("a source without an id, with the reserved id, or without resolve", () => {
    const resolve = async () => null;
    expect(bootWith({ source: { resolve } })).toThrow(
      /^\[@byo-oss\/entitlements\] source needs a non-empty id/,
    );
    expect(bootWith({ source: { id: "", resolve } })).toThrow(
      /source needs a non-empty id/,
    );
    expect(bootWith({ source: { id: "none", resolve } })).toThrow(
      /^\[@byo-oss\/entitlements\] source\.id "none" is reserved/,
    );
    expect(bootWith({ source: { id: "billing" } })).toThrow(
      /^\[@byo-oss\/entitlements\] source needs a resolve function/,
    );
  });

  it.each([
    ["pastDueGraceDays", -1, /pastDueGraceDays must be a number of at least 0/],
    ["cacheTtlMs", -1, /cacheTtlMs must be an integer of at least 0/],
    ["cacheTtlMs", 1.5, /cacheTtlMs must be an integer/],
    ["maxAge", 0, /maxAge must be an integer of at least 1/],
    ["usageRetention", -5, /usageRetention must be an integer of at least 0/],
    [
      "overrideRetention",
      Number.NaN,
      /overrideRetention must be an integer of at least 0/,
    ],
    ["maxAttempts", 0, /maxAttempts must be an integer of at least 1/],
    ["batchSize", 1001, /batchSize must be an integer from 1 to 1000/],
    ["batchSize", 0, /batchSize must be an integer from 1 to 1000/],
    ["leaseMs", "5m", /leaseMs must be an integer of at least 1/],
  ])("%s = %s", (name, value, message) => {
    expect(bootWith({ [name]: value })).toThrow(PREFIX);
    expect(bootWith({ [name]: value })).toThrow(message);
  });

  it("applies the defaults table", () => {
    const resolved = resolveOptions({ catalog: testCatalog });
    expect(resolved).toMatchObject({
      source: null,
      sourceId: "none",
      pastDueGraceDays: 7,
      resolveEntitlements: null,
      staffOrganizationId: null,
      authorize: null,
      onEvent: null,
      cacheTtlMs: 30_000,
      maxAge: 3_600_000,
      usageRetention: 90 * 86_400_000,
      overrideRetention: 365 * 86_400_000,
      organizationCleanup: true,
      maxAttempts: 5,
      batchSize: 100,
      leaseMs: 300_000,
    });
    expect(ENTITLEMENTS_DEFAULTS.cacheMaxEntries).toBe(10_000);
    expect(
      resolved.onError(new Error("x"), {
        organizationId: "o",
        key: "exports",
        operation: "hasFeature",
      }),
    ).toBe("deny");
    expect(typeof resolved.isEntitled).toBe("function");
    expect(typeof resolved.acceptSession).toBe("function");
  });
});

describe("boot validation: init", () => {
  it("ORGANIZATION_PLUGIN_REQUIRED when the organization plugin is missing", async () => {
    const auth = makeAuth({ organization: false });
    await expect(auth.$context).rejects.toThrow(
      /^\[@byo-oss\/entitlements\] ORGANIZATION_PLUGIN_REQUIRED: add organization\(\) to plugins/,
    );
  });

  it("warns once when there is no staffOrganizationId and no authorize", async () => {
    const warn = vi.fn();
    const logger = { disabled: false, level: "warn" as const, log: warn };
    await makeAuth({ authOptions: { logger } }).$context;
    const warnings = () =>
      warn.mock.calls.filter((call) =>
        String(call[1]).includes("no staffOrganizationId and no authorize"),
      );
    expect(warnings()).toHaveLength(1);
    warn.mockClear();
    await makeAuth({
      authOptions: { logger },
      options: { staffOrganizationId: "org_staff" },
    }).$context;
    await makeAuth({
      authOptions: { logger },
      options: { authorize: () => false },
    }).$context;
    expect(warnings()).toHaveLength(0);
  });

  it("a source's connect failure fails boot", async () => {
    const auth = makeAuth({
      options: {
        source: {
          id: "broken",
          resolve: async () => null,
          connect: () => {
            throw new Error("[@byo-oss/entitlements] stripe plugin missing");
          },
        },
      },
    });
    await expect(auth.$context).rejects.toThrow(/stripe plugin missing/);
  });
});

describe("createEntitlements", () => {
  it("throws on the first call when given a different catalog than the plugin", async () => {
    const auth = makeAuth();
    const { organizationId } = await seedOrg(auth);
    const other = defineEntitlements({
      features: ["exports"],
      limits: {},
      plans: { free: { features: { exports: true }, limits: {} } },
      defaultPlan: "free",
    });
    const api = createEntitlements(auth, other);
    await expect(api.get(organizationId)).rejects.toThrow(
      "[@byo-oss/entitlements] createEntitlements got a different catalog than the plugin",
    );
    await expect(api.hasFeature(organizationId, "exports")).rejects.toThrow(
      /different catalog than the plugin/,
    );
  });

  it("accepts the same catalog by reference, or a deeply equal copy", async () => {
    const auth = makeAuth();
    const { organizationId } = await seedOrg(auth);
    const same = createEntitlements(auth, testCatalog);
    await expect(same.get(organizationId)).resolves.toMatchObject({
      organizationId,
    });
    const copy = structuredClone(testCatalog);
    expect(copy).not.toBe(testCatalog);
    const equal = createEntitlements(auth, copy);
    await expect(equal.get(organizationId)).resolves.toMatchObject({
      organizationId,
    });
    await expect(equal.invalidate(organizationId)).resolves.toBeUndefined();
  });

  it("names itself when the plugin isn't installed", async () => {
    const api = createEntitlements(
      { $context: Promise.resolve({ options: { plugins: [] } }) },
      testCatalog,
    );
    await expect(api.get("org_1")).rejects.toThrow(
      "[@byo-oss/entitlements] createEntitlements needs the entitlements plugin installed on this auth instance",
    );
  });
});
