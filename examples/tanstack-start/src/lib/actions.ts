import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { auth, entitlements } from "./auth";

type OrganizationInput = { organizationId: string };

const validateOrganization = (input: unknown): OrganizationInput => {
  const { organizationId } = (input ?? {}) as { organizationId?: unknown };
  if (typeof organizationId !== "string" || organizationId === "") {
    throw new Error("organizationId is required");
  }
  return { organizationId };
};

/**
 * The `createEntitlements` methods take a plain organization id, so the app
 * proves the caller belongs to it first: here, that the session's user has
 * `entitlements: ["read"]` in that organization.
 */
async function requireMember(organizationId: string) {
  const headers = getRequestHeaders();
  const { success } = await auth.api.hasPermission({
    headers,
    body: { organizationId, permissions: { entitlements: ["read"] } },
  });
  if (!success) throw new Error("Not a member of this organization");
}

/**
 * Setup step 5: the first `hasFeature` call. The page hides the button
 * behind `EntitlementGate`, but the server still checks.
 */
export const exportData = createServerFn({ method: "POST" })
  .validator(validateOrganization)
  .handler(async ({ data }) => {
    await requireMember(data.organizationId);
    const result = await entitlements.hasFeature(data.organizationId, "exports");
    return {
      allowed: result.allowed,
      reason: result.reason,
      upgradeTo: result.upgradeTo,
    };
  });

/**
 * One metered API call: `consumeUsage` counts it, or refuses it once the
 * plan's limit is used up (a refusal is never counted).
 */
export const callApi = createServerFn({ method: "POST" })
  .validator(validateOrganization)
  .handler(async ({ data }) => {
    await requireMember(data.organizationId);
    const result = await entitlements.consumeUsage(
      data.organizationId,
      "apiCalls",
    );
    return {
      allowed: result.allowed,
      reason: result.reason,
      used: result.used,
      limit: result.limit,
      remaining: result.remaining,
      resetAt: result.resetAt.toISOString(),
      upgradeTo: result.upgradeTo,
    };
  });
