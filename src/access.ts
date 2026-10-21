// BYO_STUB: N05 replaces this file (contracts.md "access.ts")
import type { DBTransactionAdapter, GenericEndpointContext } from "better-auth";
import { APIError } from "better-auth/api";
import { ENTITLEMENTS_ERROR_CODES } from "./error-codes";
import type {
  EntitlementsAcceptSession,
  EntitlementsAuthorizeInput,
  EntitlementsSession,
} from "./options";
import type { EntitlementsRuntime } from "./runtime";
import type { EntitlementsAction } from "./statements";

/** The endpoint being gated, as `acceptSession` sees it. */
export type EntitlementsRoute = { method: "GET" | "POST"; path: string };

/** Who passed a read gate, and through which organization. */
export type ReaderAccess = {
  kind: "member" | "staff";
  session: EntitlementsSession;
};

/**
 * The default `authorize`: no `organizationId` → false; else the `member`
 * row of `(session.user.id, organizationId)` (`findMember`, through
 * `currentAdapter`); none → false; else the organization plugin's
 * `hasPermission` with that member's role and the org plugin's options.
 * Stub: false.
 */
export async function defaultAuthorize(
  _rt: EntitlementsRuntime,
  _input: EntitlementsAuthorizeInput,
): Promise<boolean> {
  return false;
}

/**
 * The default `acceptSession`: refuses an impersonated session
 * (`session.session.impersonatedBy` set) for `kind: "staff"` and for every
 * POST; allows everything else (impersonated member GETs included).
 * Stub: false.
 */
export const defaultAcceptSession: EntitlementsAcceptSession = () => false;

/**
 * Gate of `getEntitlements` and `refreshEntitlements`:
 * 1. `authorize` in `organizationId` with `entitlements: ["read"]`
 *    (`kind: "member"`); else in the staff organization (`kind: "staff"`).
 * 2. Neither → 404 `ORGANIZATION_NOT_FOUND`.
 * 3. `acceptSession({ session, headers, kind, ...route })` false → 403
 *    `SESSION_NOT_ACCEPTED`.
 * 4. `kind: "staff"` → `requireOrgExists`.
 * Uses `rt.options.authorize ?? defaultAuthorize`. Needs `sessionMiddleware`
 * on the endpoint. Stub: always 404.
 */
export async function requireReader(
  _ctx: GenericEndpointContext,
  _rt: EntitlementsRuntime,
  _organizationId: string,
  _route: EntitlementsRoute,
): Promise<ReaderAccess> {
  throw APIError.from(
    "NOT_FOUND",
    ENTITLEMENTS_ERROR_CODES.ORGANIZATION_NOT_FOUND,
  );
}

/**
 * Gate of the override endpoints: `authorize` in the staff organization
 * with `entitlements: [action]`; fails (or no staff organization and no
 * custom `authorize`) → 404 `ORGANIZATION_NOT_FOUND`, answered before any
 * organization lookup; then `acceptSession` with `kind: "staff"` → 403
 * `SESSION_NOT_ACCEPTED`. Stub: always 404.
 */
export async function requireStaff(
  _ctx: GenericEndpointContext,
  _rt: EntitlementsRuntime,
  _action: EntitlementsAction,
  _route: EntitlementsRoute,
): Promise<{ session: EntitlementsSession }> {
  throw APIError.from(
    "NOT_FOUND",
    ENTITLEMENTS_ERROR_CODES.ORGANIZATION_NOT_FOUND,
  );
}

/**
 * 404 `ORGANIZATION_NOT_FOUND` unless the `organization` row exists
 * (`findOrganization`). Stub: always 404.
 */
export async function requireOrgExists(
  _rt: EntitlementsRuntime,
  _adapter: DBTransactionAdapter,
  _organizationId: string,
): Promise<void> {
  throw APIError.from(
    "NOT_FOUND",
    ENTITLEMENTS_ERROR_CODES.ORGANIZATION_NOT_FOUND,
  );
}
