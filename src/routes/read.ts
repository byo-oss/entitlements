// BYO_STUB: N06 replaces this file (contracts.md "routes/read.ts")
import {
  APIError,
  createAuthEndpoint,
  sessionMiddleware,
} from "better-auth/api";
import * as z from "zod";
import { ENTITLEMENTS_ERROR_CODES } from "../error-codes";
import type { EntitlementsRuntime } from "../runtime";
import type { EntitlementsResponse } from "../types";

/**
 * `getEntitlements` (GET `/entitlements/get`) and `refreshEntitlements`
 * (POST `/entitlements/refresh`). Both: `sessionMiddleware`, then
 * `requireReader`; answer `EntitlementsResponse` (usage per metered key;
 * staff callers also get each override's `reason` and `createdBy`).
 * `getEntitlements` answers 503 `ENTITLEMENTS_UNAVAILABLE` instead of a
 * degraded result. `refreshEntitlements` runs `syncOrganization` (cache
 * bypassed) and throws inside a transaction.
 * Stub: both answer 404 `ORGANIZATION_NOT_FOUND`.
 */
export function readEndpoints(_rt: EntitlementsRuntime) {
  return {
    getEntitlements: createAuthEndpoint(
      "/entitlements/get",
      {
        method: "GET",
        query: z.object({ organizationId: z.string().min(1) }),
        use: [sessionMiddleware],
      },
      async (): Promise<EntitlementsResponse> => {
        throw APIError.from(
          "NOT_FOUND",
          ENTITLEMENTS_ERROR_CODES.ORGANIZATION_NOT_FOUND,
        );
      },
    ),
    refreshEntitlements: createAuthEndpoint(
      "/entitlements/refresh",
      {
        method: "POST",
        body: z.object({ organizationId: z.string().min(1) }),
        use: [sessionMiddleware],
      },
      async (): Promise<EntitlementsResponse> => {
        throw APIError.from(
          "NOT_FOUND",
          ENTITLEMENTS_ERROR_CODES.ORGANIZATION_NOT_FOUND,
        );
      },
    ),
  };
}
