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
 * Members get each override's `{ kind, key, expiresAt }`; staff callers
 * also get its `id`, `reason` and `createdBy`.
 * 503 `ENTITLEMENTS_UNAVAILABLE` instead of a result when:
 * - `getEntitlements`: `resolveState` came back degraded;
 * - `refreshEntitlements`: `syncOrganization` threw (logged once here), or
 *   its fresh state came back degraded;
 * - either: `readUsage` threw (logged once).
 * `refreshEntitlements` runs `syncOrganization` (cache bypassed) and, inside
 * a transaction, throws `assertOutsideTransaction(rt, "refreshEntitlements")`
 * (not a 503).
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
