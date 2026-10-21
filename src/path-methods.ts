// Internal: the client plugin's pathMethods. Not exported from any entry (PRD amendment A3).

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
