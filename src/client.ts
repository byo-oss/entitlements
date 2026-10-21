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

export * from "./catalog";
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
