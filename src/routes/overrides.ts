// BYO_STUB: N06 replaces this file (contracts.md "routes/overrides.ts")
import {
  APIError,
  createAuthEndpoint,
  sessionMiddleware,
} from "better-auth/api";
import * as z from "zod";
import { ENTITLEMENTS_ERROR_CODES } from "../error-codes";
import type { EntitlementsRuntime } from "../runtime";
import { OVERRIDE_KINDS, OVERRIDE_STATUSES } from "../schema";
import type {
  ListOverridesResponse,
  RemoveOverrideResponse,
  SetOverrideResponse,
} from "../types";

/** Overrides per `listEntitlementOverrides` page. */
export const OVERRIDES_PAGE_SIZE = 50;

/**
 * The staff endpoints, each `sessionMiddleware` then `requireStaff`:
 * - `setEntitlementOverride` (POST `/entitlements/override/set`,
 *   `entitlements:override`): `requireOrgExists`, `validateOverride`,
 *   `setOverride` → `{ override }`.
 * - `removeEntitlementOverride` (POST `/entitlements/override/remove`,
 *   `entitlements:override`): `removeOverride` → `{ ok: true }`.
 * - `listEntitlementOverrides` (GET `/entitlements/overrides`,
 *   `entitlements:read`): newest first, 50 per page, keyset cursor
 *   (PRD Query rules); a malformed cursor or a page past the tie bound →
 *   400 `INVALID_CURSOR`.
 * Stub: every endpoint answers 404 `ORGANIZATION_NOT_FOUND`.
 */
export function overrideEndpoints(_rt: EntitlementsRuntime) {
  const notFound = () =>
    APIError.from("NOT_FOUND", ENTITLEMENTS_ERROR_CODES.ORGANIZATION_NOT_FOUND);
  return {
    setEntitlementOverride: createAuthEndpoint(
      "/entitlements/override/set",
      {
        method: "POST",
        body: z.object({
          organizationId: z.string().min(1),
          kind: z.enum(OVERRIDE_KINDS),
          key: z.string().min(1),
          value: z
            .union([z.boolean(), z.number(), z.literal("unlimited"), z.null()])
            .optional(),
          reason: z.string(),
          expiresAt: z.union([z.date(), z.string()]).nullable().optional(),
        }),
        use: [sessionMiddleware],
      },
      async (): Promise<SetOverrideResponse> => {
        throw notFound();
      },
    ),
    removeEntitlementOverride: createAuthEndpoint(
      "/entitlements/override/remove",
      {
        method: "POST",
        body: z.object({ id: z.string().min(1) }),
        use: [sessionMiddleware],
      },
      async (): Promise<RemoveOverrideResponse> => {
        throw notFound();
      },
    ),
    listEntitlementOverrides: createAuthEndpoint(
      "/entitlements/overrides",
      {
        method: "GET",
        query: z.object({
          organizationId: z.string().min(1).optional(),
          status: z.enum(OVERRIDE_STATUSES).optional(),
          cursor: z.string().optional(),
        }),
        use: [sessionMiddleware],
      },
      async (): Promise<ListOverridesResponse> => {
        throw notFound();
      },
    ),
  };
}
