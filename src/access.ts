import type { DBTransactionAdapter, GenericEndpointContext } from "better-auth";
import { APIError } from "better-auth/api";
import {
  hasPermission,
  type OrganizationOptions,
} from "better-auth/plugins/organization";
import { findMember, findOrganization } from "./adapter";
import { ENTITLEMENTS_ERROR_CODES } from "./error-codes";
import type {
  EntitlementsAcceptSession,
  EntitlementsAuthorize,
  EntitlementsAuthorizeInput,
  EntitlementsSession,
} from "./options";
import { type EntitlementsRuntime, requireContext } from "./runtime";
import type { EntitlementsAction } from "./statements";
import { currentAdapter } from "./txn";

/** The endpoint being gated, as `acceptSession` sees it. */
export type EntitlementsRoute = { method: "GET" | "POST"; path: string };

/** Who passed a read gate, and through which organization. */
export type ReaderAccess = {
  kind: "member" | "staff";
  session: EntitlementsSession;
};

const notFound = () =>
  APIError.from("NOT_FOUND", ENTITLEMENTS_ERROR_CODES.ORGANIZATION_NOT_FOUND);

// the organization plugin's own options, so `hasPermission` sees the app's
// `ac`, `roles`, `creatorRole` and dynamic access control
function organizationOptions(
  rt: EntitlementsRuntime,
): OrganizationOptions | undefined {
  const context = requireContext(rt) as unknown as {
    getPlugin?: (id: string) => { options?: unknown } | null | undefined;
    options: { plugins?: readonly { id: string; options?: unknown }[] };
  };
  const plugin =
    context.getPlugin?.("organization") ??
    context.options.plugins?.find((p) => p.id === "organization");
  return plugin?.options as OrganizationOptions | undefined;
}

/**
 * The default `authorize`: no `organizationId` → false; else the `member`
 * row of `(session.user.id, organizationId)` (`findMember`, through
 * `currentAdapter`); none → false; else the organization plugin's
 * `hasPermission` with that member's role and the org plugin's options.
 * Never looks at role names or at the session's active organization.
 */
export async function defaultAuthorize(
  rt: EntitlementsRuntime,
  input: EntitlementsAuthorizeInput,
): Promise<boolean> {
  const { organizationId } = input;
  if (!organizationId) return false;
  const options = organizationOptions(rt);
  if (!options) return false;
  const adapter = await currentAdapter(rt);
  const member = await findMember(adapter, {
    userId: input.session.user.id,
    organizationId,
  });
  if (!member) return false;
  // `hasPermission` reads dynamic roles through `ctx.context.adapter`: hand
  // it the current adapter, so that read joins a caller's transaction too
  const ctx = {
    context: Object.assign(Object.create(requireContext(rt)), { adapter }),
  } as unknown as GenericEndpointContext;
  return hasPermission(
    {
      role: member.role,
      options,
      permissions: { entitlements: [...input.permissions.entitlements] },
      organizationId,
    },
    ctx,
  );
}

// who acts as this session's user when it isn't the user themself, or null
const impersonatorOf = (session: EntitlementsSession): string | null =>
  session.session.impersonatedBy || null;

/**
 * The default `acceptSession`: refuses an impersonated session
 * (`session.session.impersonatedBy` set) for `kind: "staff"` and for every
 * POST; allows everything else (impersonated member GETs included).
 */
export const defaultAcceptSession: EntitlementsAcceptSession = ({
  session,
  kind,
  method,
}) => !(impersonatorOf(session) && (kind === "staff" || method === "POST"));

// the session `sessionMiddleware` put on the endpoint context
function sessionOf(ctx: GenericEndpointContext): EntitlementsSession {
  const session = (
    ctx.context as { session?: EntitlementsSession | null } | undefined
  )?.session;
  if (!session) throw APIError.fromStatus("UNAUTHORIZED");
  return session;
}

function authorizer(rt: EntitlementsRuntime): EntitlementsAuthorize {
  return rt.options.authorize ?? ((input) => defaultAuthorize(rt, input));
}

// a staff check can only pass with a staff organization or a custom authorize
const canCheckStaff = (rt: EntitlementsRuntime) =>
  rt.options.staffOrganizationId !== null || rt.options.authorize !== null;

async function requireAccepted(
  rt: EntitlementsRuntime,
  input: {
    session: EntitlementsSession;
    headers: Headers | undefined;
    kind: "member" | "staff";
    route: EntitlementsRoute;
  },
): Promise<void> {
  const accepted = await rt.options.acceptSession({
    session: input.session,
    headers: input.headers,
    kind: input.kind,
    method: input.route.method,
    path: input.route.path,
  });
  if (!accepted) {
    throw APIError.from(
      "FORBIDDEN",
      ENTITLEMENTS_ERROR_CODES.SESSION_NOT_ACCEPTED,
    );
  }
}

/**
 * Gate of `getEntitlements` and `refreshEntitlements`:
 * 1. `authorize` in `organizationId` with `entitlements: ["read"]`
 *    (`kind: "member"`); else in the staff organization (`kind: "staff"`).
 * 2. Neither → 404 `ORGANIZATION_NOT_FOUND`.
 * 3. `acceptSession({ session, headers, kind, ...route })` false → 403
 *    `SESSION_NOT_ACCEPTED`.
 * 4. `kind: "staff"` → `requireOrgExists`.
 * Uses `rt.options.authorize ?? defaultAuthorize`. Needs `sessionMiddleware`
 * on the endpoint.
 */
export async function requireReader(
  ctx: GenericEndpointContext,
  rt: EntitlementsRuntime,
  organizationId: string,
  route: EntitlementsRoute,
): Promise<ReaderAccess> {
  const session = sessionOf(ctx);
  const headers = ctx.headers;
  const authorize = authorizer(rt);
  const read = (): { entitlements: EntitlementsAction[] } => ({
    entitlements: ["read"],
  });
  let kind: ReaderAccess["kind"];
  if (
    await authorize({ session, headers, organizationId, permissions: read() })
  ) {
    kind = "member";
  } else if (
    canCheckStaff(rt) &&
    (await authorize({
      session,
      headers,
      organizationId: rt.options.staffOrganizationId ?? undefined,
      permissions: read(),
    }))
  ) {
    kind = "staff";
  } else {
    throw notFound();
  }
  await requireAccepted(rt, { session, headers, kind, route });
  // a member path proves the organization exists through the member row
  if (kind === "staff") {
    await requireOrgExists(rt, await currentAdapter(rt), organizationId);
  }
  return { kind, session };
}

/**
 * Gate of the override endpoints: `authorize` in the staff organization
 * with `entitlements: [action]`; fails (or no staff organization and no
 * custom `authorize`) → 404 `ORGANIZATION_NOT_FOUND`, answered before any
 * organization lookup; then `acceptSession` with `kind: "staff"` → 403
 * `SESSION_NOT_ACCEPTED`.
 */
export async function requireStaff(
  ctx: GenericEndpointContext,
  rt: EntitlementsRuntime,
  action: EntitlementsAction,
  route: EntitlementsRoute,
): Promise<{ session: EntitlementsSession }> {
  const session = sessionOf(ctx);
  const headers = ctx.headers;
  if (!canCheckStaff(rt)) throw notFound();
  const allowed = await authorizer(rt)({
    session,
    headers,
    // always the staff organization, never the target: a customer
    // organization's owner can't override their own organization
    organizationId: rt.options.staffOrganizationId ?? undefined,
    permissions: { entitlements: [action] },
  });
  if (!allowed) throw notFound();
  await requireAccepted(rt, { session, headers, kind: "staff", route });
  return { session };
}

/**
 * 404 `ORGANIZATION_NOT_FOUND` unless the `organization` row exists
 * (`findOrganization`).
 */
export async function requireOrgExists(
  _rt: EntitlementsRuntime,
  adapter: DBTransactionAdapter,
  organizationId: string,
): Promise<void> {
  const organization = await findOrganization(adapter, organizationId);
  if (!organization) throw notFound();
}
