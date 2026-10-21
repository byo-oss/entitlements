// BYO_STUB: N06 replaces this file (contracts.md "routes/overrides.ts")
import {
  APIError,
  createAuthEndpoint,
  sessionMiddleware,
} from "better-auth/api";
import * as z from "zod";
import { ENTITLEMENTS_ERROR_CODES } from "../error-codes";
import type { EntitlementsRuntime } from "../runtime";
import { OVERRIDE_STATUSES } from "../schema";
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
 *   `setOverride` → `{ override }`. The body schema is loose (`kind`,
 *   `key` any string, `value` unknown), so every override rule answers 400
 *   `INVALID_OVERRIDE`; only a field of the wrong JSON type for a string
 *   (or `expiresAt` that is neither a string, a Date nor null) gets
 *   better-auth's own 400.
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
        // loose on purpose: a wrong kind, key or value reaches
        // validateOverride and answers 400 INVALID_OVERRIDE (PRD), not
        // better-auth's own 400
        body: z.object({
          organizationId: z.string().min(1),
          kind: z.string(),
          key: z.string(),
          value: z.unknown(),
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
