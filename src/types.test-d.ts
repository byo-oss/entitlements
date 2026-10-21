/**
 * Type tests (PRD #7), checked by `pnpm typecheck` (tsc), never run by
 * vitest. Every `@ts-expect-error` must hit a real error: tsc fails on an
 * unused directive, so each negative case proves itself.
 */
import { createEntitlements } from "./api";
import {
  type CapacityKey,
  defineEntitlements,
  type FeatureKey,
  type MeteredKey,
  type PlanKey,
  upgradeTo,
} from "./catalog";
import type { EntitlementsResult } from "./types";

declare const auth: { $context: Promise<object> };

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
const assertType = <T extends true>(_value?: T) => {};

const catalog = defineEntitlements({
  features: ["exports", "sso"],
  limits: {
    apiCalls: { kind: "metered", period: "day" },
    members: { kind: "capacity" },
    retentionDays: { kind: "value" },
  },
  plans: {
    free: {
      features: { exports: false, sso: false },
      limits: { apiCalls: 1_000, members: 5, retentionDays: 7 },
      display: { name: "Free" },
    },
    pro: {
      features: { exports: true, sso: false },
      limits: { apiCalls: 50_000, members: "unlimited", retentionDays: 90 },
    },
  },
  defaultPlan: "free",
  planAliases: { legacy: "pro" },
});

assertType<Equal<FeatureKey<typeof catalog>, "exports" | "sso">>();
assertType<Equal<MeteredKey<typeof catalog>, "apiCalls">>();
assertType<Equal<CapacityKey<typeof catalog>, "members">>();
assertType<Equal<PlanKey<typeof catalog>, "free" | "pro">>();

export function catalogErrors() {
  defineEntitlements({
    features: ["exports", "sso"],
    limits: { apiCalls: { kind: "metered", period: "day" } },
    plans: {
      free: {
        // @ts-expect-error a plan missing a feature key ("sso")
        features: { exports: false },
        limits: { apiCalls: 1 },
      },
    },
    defaultPlan: "free",
  });

  defineEntitlements({
    features: ["exports"],
    limits: { apiCalls: { kind: "metered", period: "day" } },
    plans: {
      free: {
        features: { exports: false },
        // @ts-expect-error a plan missing a limit key ("apiCalls")
        limits: {},
      },
    },
    defaultPlan: "free",
  });

  defineEntitlements({
    features: ["exports"],
    limits: { apiCalls: { kind: "metered", period: "day" } },
    plans: {
      free: {
        // @ts-expect-error a plan setting an unknown feature key
        features: { exports: false, audit: true },
        limits: { apiCalls: 1 },
      },
    },
    defaultPlan: "free",
  });

  defineEntitlements({
    features: ["exports"],
    limits: { apiCalls: { kind: "metered", period: "day" } },
    plans: {
      free: {
        features: { exports: false },
        // @ts-expect-error a plan setting an unknown limit key
        limits: { apiCalls: 1, seats: 3 },
      },
    },
    defaultPlan: "free",
  });

  defineEntitlements({
    features: ["exports"],
    limits: { apiCalls: { kind: "metered", period: "day" } },
    plans: {
      // @ts-expect-error a plan key outside /^[a-z][a-z0-9_-]*$/
      Pro: { features: { exports: true }, limits: { apiCalls: 1 } },
      free: { features: { exports: false }, limits: { apiCalls: 1 } },
    },
    defaultPlan: "free",
  });

  defineEntitlements({
    features: ["exports"],
    limits: { apiCalls: { kind: "metered", period: "day" } },
    plans: {
      free: { features: { exports: false }, limits: { apiCalls: 1 } },
    },
    defaultPlan: "free",
    // @ts-expect-error an alias pointing to an unknown plan
    planAliases: { legacy: "gold" },
  });

  defineEntitlements({
    features: ["exports"],
    limits: { apiCalls: { kind: "metered", period: "day" } },
    plans: {
      free: { features: { exports: false }, limits: { apiCalls: 1 } },
      pro: { features: { exports: true }, limits: { apiCalls: 2 } },
    },
    defaultPlan: "free",
    // @ts-expect-error an alias that shadows a plan
    planAliases: { pro: "free" },
  });

  defineEntitlements({
    features: ["exports"],
    limits: { apiCalls: { kind: "metered", period: "day" } },
    plans: {
      free: { features: { exports: false }, limits: { apiCalls: 1 } },
    },
    // @ts-expect-error defaultPlan not in plans
    defaultPlan: "gold",
  });

  defineEntitlements({
    features: ["exports"],
    limits: { apiCalls: { kind: "metered", period: "day" } },
    plans: {
      free: {
        features: { exports: false },
        // @ts-expect-error a limit value that is neither a number nor "unlimited"
        limits: { apiCalls: "lots" },
      },
    },
    defaultPlan: "free",
  });
}

export async function callSites(organizationId: string) {
  const entitlements = createEntitlements(auth, catalog);

  // valid calls compile, typed by the catalog
  const result: EntitlementsResult<typeof catalog> =
    await entitlements.get(organizationId);
  assertType<Equal<typeof result.plan.key, "free" | "pro">>();
  assertType<Equal<keyof typeof result.features, "exports" | "sso">>();
  const feature = await entitlements.hasFeature(organizationId, "exports");
  assertType<Equal<typeof feature.key, "exports">>();
  assertType<Equal<typeof feature.upgradeTo, ("free" | "pro")[]>>();
  const consumed = await entitlements.consumeUsage(organizationId, "apiCalls", {
    amount: 2,
  });
  assertType<Equal<typeof consumed.firstRefusal, boolean>>();
  const capacity = await entitlements.checkCapacity(organizationId, "members", {
    count: 3,
  });
  assertType<Equal<typeof capacity.over, boolean>>();
  const metered = await entitlements.getLimit(organizationId, "apiCalls");
  assertType<Equal<typeof metered.used, number>>();
  const value = await entitlements.getLimit(organizationId, "retentionDays");
  // @ts-expect-error a value key's getLimit has no counter
  value.used;
  upgradeTo(catalog, { feature: "sso" });
  upgradeTo(catalog, { limit: "members", atLeast: 10 });

  // @ts-expect-error hasFeature with an unknown feature
  await entitlements.hasFeature(organizationId, "nope");
  // @ts-expect-error hasFeature with a limit key
  await entitlements.hasFeature(organizationId, "apiCalls");
  // @ts-expect-error consumeUsage on a capacity key
  await entitlements.consumeUsage(organizationId, "members");
  // @ts-expect-error consumeUsage on a value key
  await entitlements.consumeUsage(organizationId, "retentionDays");
  // @ts-expect-error checkCapacity on a metered key
  await entitlements.checkCapacity(organizationId, "apiCalls", { count: 1 });
  // @ts-expect-error checkCapacity needs a count
  await entitlements.checkCapacity(organizationId, "members", {});
  // @ts-expect-error getLimit with an unknown key
  await entitlements.getLimit(organizationId, "nope");
  // @ts-expect-error upgradeTo with an unknown feature
  upgradeTo(catalog, { feature: "nope" });
}
