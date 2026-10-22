import { defineEntitlements, type MeteredKey } from "@byo-oss/entitlements/catalog";

/**
 * Setup step 1, catalog and plugin (with `auth-options.ts`): the plans, features and limits,
 * declared once. Pure data, so the server, the pages and a pricing page can
 * all import this file. Free allows 3 API calls a month so the refusal is a
 * few clicks away.
 */
export const catalog = defineEntitlements({
  features: ["exports", "prioritySupport"],
  limits: {
    apiCalls: { kind: "metered", period: "month" },
    members: { kind: "capacity" },
    projects: { kind: "capacity" },
    retentionDays: { kind: "value" },
  },
  plans: {
    free: {
      features: { exports: false, prioritySupport: false },
      limits: { apiCalls: 3, members: 3, projects: 1, retentionDays: 7 },
      display: { name: "Free" },
    },
    pro: {
      features: { exports: true, prioritySupport: true },
      limits: {
        apiCalls: 10_000,
        members: 50,
        projects: "unlimited",
        retentionDays: 90,
      },
      display: { name: "Pro" },
    },
  },
  defaultPlan: "free",
});

export type AppCatalog = typeof catalog;

/** The metered keys, for one `UsageMeter` each. */
export const meteredKeys = Object.entries(catalog.limits)
  .filter(([, definition]) => definition.kind === "metered")
  .map(([key]) => key as MeteredKey<AppCatalog>);
