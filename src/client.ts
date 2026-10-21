import type { BetterAuthClientPlugin } from "better-auth/client";
import type { entitlements } from "./index";

/**
 * Every endpoint the client calls, with its method.
 * `processEntitlementsSync` is server-only and has no path.
 */
export const entitlementsPathMethods = {
  "/entitlements/get": "GET",
  "/entitlements/refresh": "POST",
  "/entitlements/override/set": "POST",
  "/entitlements/override/remove": "POST",
  "/entitlements/overrides": "GET",
} as const satisfies Record<string, "GET" | "POST">;

/**
 * The better-auth client plugin:
 * `createAuthClient({ plugins: [organizationClient(), entitlementsClient()] })`.
 */
export const entitlementsClient = () => {
  return {
    id: "entitlements",
    $InferServerPlugin: {} as ReturnType<typeof entitlements>,
    pathMethods: entitlementsPathMethods,
  } satisfies BetterAuthClientPlugin;
};

// the public catalog API (the same list as catalog-entry.ts)
export {
  type AnyCatalog,
  type CapacityKey,
  type CapacityLimitDefinition,
  type Catalog,
  type CatalogInput,
  defineEntitlements,
  type FeatureKey,
  type LimitDefinition,
  type LimitKey,
  type LimitKind,
  type LimitValue,
  type MeteredKey,
  type MeteredLimitDefinition,
  type MeteredPeriod,
  type PlanAliasKey,
  type PlanDefinition,
  type PlanKey,
  type UpgradeTarget,
  upgradeTo,
  type ValueKey,
  type ValueLimitDefinition,
} from "./catalog";
export {
  type EntitlementsAction,
  entitlementsStatements,
} from "./statements";
export type {
  EntitlementOverride,
  EntitlementsResponse,
  ListOverridesResponse,
  UsageInfo,
  Wire,
} from "./types";
