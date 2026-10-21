import type { BetterAuthClientPlugin } from "better-auth/client";
import type { entitlements } from "./index";
import { entitlementsPathMethods } from "./path-methods";

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
