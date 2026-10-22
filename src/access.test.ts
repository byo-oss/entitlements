import type { GenericEndpointContext } from "better-auth";
import { describe, expect, it, vi } from "vitest";
import {
  defaultAcceptSession,
  defaultAuthorize,
  type EntitlementsRoute,
  requireOrgExists,
  requireReader,
  requireStaff,
} from "./access";
import { ENTITLEMENTS_ERROR_CODES } from "./error-codes";
import type {
  EntitlementsAcceptSessionInput,
  EntitlementsAuthorizeInput,
  EntitlementsOptions,
  EntitlementsSession,
} from "./options";
import {
  type AdapterCall,
  type AnyTestAuth,
  addMember,
  expectNoOuterCalls,
  getContext,
  getRuntime,
  impersonatedHeaders,
  makeAuth,
  STAFF_ORG_ID,
  seedOrg,
  seedStaff,
  signUpUser,
  type TestUser,
} from "./test-utils";

const GET: EntitlementsRoute = { method: "GET", path: "/entitlements/get" };
const REFRESH: EntitlementsRoute = {
  method: "POST",
  path: "/entitlements/refresh",
};
const SET: EntitlementsRoute = {
  method: "POST",
  path: "/entitlements/override/set",
};
const LIST: EntitlementsRoute = {
  method: "GET",
  path: "/entitlements/overrides",
};

const apiError = (status: string, code: { code: string }) =>
  expect.objectContaining({
    status,
    body: expect.objectContaining({ code: code.code }),
  });
const orgNotFound = apiError(
  "NOT_FOUND",
  ENTITLEMENTS_ERROR_CODES.ORGANIZATION_NOT_FOUND,
);
const notAccepted = apiError(
  "FORBIDDEN",
  ENTITLEMENTS_ERROR_CODES.SESSION_NOT_ACCEPTED,
);

/**
 * An endpoint context as `sessionMiddleware` leaves it: better-auth's
 * context with `session` set from the headers' cookie. The route factories
 * are another node's work, so the gates are called directly.
 */
async function gateContext(
  auth: AnyTestAuth,
  headers: Headers,
): Promise<{ ctx: GenericEndpointContext; session: EntitlementsSession }> {
  const context = await getContext(auth);
  const session = (await auth.api.getSession({
    headers,
  })) as EntitlementsSession;
  const ctx = {
    context: Object.assign(Object.create(context), { session }),
    headers,
  } as unknown as GenericEndpointContext;
  return { ctx, session };
}

/** A customer org with an owner, a `member` and a `billing` user, plus the staff org. */
async function world(
  options: Partial<EntitlementsOptions> = { staffOrganizationId: STAFF_ORG_ID },
  calls?: AdapterCall[],
) {
  const auth = makeAuth({
    options,
    adapter: calls ? { before: (call) => void calls.push(call) } : undefined,
  });
  const rt = await getRuntime(auth);
  const { staff } = await seedStaff(auth);
  const { organizationId, owner } = await seedOrg(auth);
  const other = await seedOrg(auth);
  const member = await signUpUser(auth, "member@acme.test");
  await addMember(auth, {
    organizationId,
    userId: member.user.id,
    role: "member",
  });
  const billing = await signUpUser(auth, "billing@acme.test");
  await addMember(auth, {
    organizationId,
    userId: billing.user.id,
    role: "billing",
  });
  const reader = async (
    user: TestUser | Headers,
    orgId: string,
    route: EntitlementsRoute = GET,
  ) => {
    const headers = user instanceof Headers ? user : user.headers;
    const { ctx } = await gateContext(auth, headers);
    return requireReader(ctx, rt, orgId, route);
  };
  const staffGate = async (
    user: TestUser | Headers,
    action: "read" | "override",
    route: EntitlementsRoute = SET,
  ) => {
    const headers = user instanceof Headers ? user : user.headers;
    const { ctx } = await gateContext(auth, headers);
    return requireStaff(ctx, rt, action, route);
  };
  return {
    auth,
    rt,
    staff,
    organizationId,
    owner,
    other,
    member,
    billing,
    reader,
    staffGate,
  };
}

describe("defaultAuthorize", () => {
  it("checks the member's role in the given organization with the org plugin's hasPermission", async () => {
    const { rt, auth, organizationId, owner, member, billing } = await world();
    const { session: ownerSession } = await gateContext(auth, owner.headers);
    const { session: memberSession } = await gateContext(auth, member.headers);
    const { session: billingSession } = await gateContext(
      auth,
      billing.headers,
    );
    const input = (
      session: EntitlementsSession,
      entitlements: ("read" | "override")[],
      orgId: string | undefined = organizationId,
    ): EntitlementsAuthorizeInput => ({
      session,
      headers: undefined,
      organizationId: orgId,
      permissions: { entitlements },
    });
    expect(await defaultAuthorize(rt, input(ownerSession, ["read"]))).toBe(
      true,
    );
    expect(await defaultAuthorize(rt, input(ownerSession, ["override"]))).toBe(
      true,
    );
    expect(await defaultAuthorize(rt, input(memberSession, ["read"]))).toBe(
      true,
    );
    expect(await defaultAuthorize(rt, input(memberSession, ["override"]))).toBe(
      false,
    );
    // a role without any entitlements action
    expect(await defaultAuthorize(rt, input(billingSession, ["read"]))).toBe(
      false,
    );
  });

  it("denies without an organizationId and without a member row", async () => {
    const { rt, auth, other, member } = await world();
    const { session } = await gateContext(auth, member.headers);
    const base = {
      session,
      headers: undefined,
      permissions: { entitlements: ["read" as const] },
    };
    expect(
      await defaultAuthorize(rt, { ...base, organizationId: undefined }),
    ).toBe(false);
    expect(await defaultAuthorize(rt, { ...base, organizationId: "" })).toBe(
      false,
    );
    expect(
      await defaultAuthorize(rt, {
        ...base,
        organizationId: other.organizationId,
      }),
    ).toBe(false);
  });

  it("reads the member row through the current adapter (joins a caller's transaction)", async () => {
    const { rt, auth, organizationId, member } = await world();
    const { session } = await gateContext(auth, member.headers);
    const allowed = await expectNoOuterCalls(auth, () =>
      defaultAuthorize(rt, {
        session,
        headers: undefined,
        organizationId,
        permissions: { entitlements: ["read"] },
      }),
    );
    expect(allowed).toBe(true);
  });
});

describe("defaultAcceptSession", () => {
  const session = (impersonatedBy?: string | null): EntitlementsSession => ({
    session: { id: "s1", userId: "u1", impersonatedBy },
    user: { id: "u1", email: "u1@acme.test" },
  });
  const input = (
    impersonatedBy: string | null | undefined,
    kind: "member" | "staff",
    route: EntitlementsRoute,
  ): EntitlementsAcceptSessionInput => ({
    session: session(impersonatedBy),
    headers: undefined,
    kind,
    ...route,
  });

  it("allows every ordinary session", () => {
    for (const kind of ["member", "staff"] as const) {
      for (const route of [GET, REFRESH, SET, LIST]) {
        expect(defaultAcceptSession(input(undefined, kind, route))).toBe(true);
        expect(defaultAcceptSession(input(null, kind, route))).toBe(true);
      }
    }
  });

  it("allows an impersonated member GET and refuses impersonated staff calls and POSTs", () => {
    expect(defaultAcceptSession(input("admin-1", "member", GET))).toBe(true);
    expect(defaultAcceptSession(input("admin-1", "member", REFRESH))).toBe(
      false,
    );
    expect(defaultAcceptSession(input("admin-1", "staff", GET))).toBe(false);
    expect(defaultAcceptSession(input("admin-1", "staff", LIST))).toBe(false);
    expect(defaultAcceptSession(input("admin-1", "staff", SET))).toBe(false);
  });
});

describe("requireReader", () => {
  it("lets a member read their own organization (kind member)", async () => {
    const { reader, organizationId, owner, member } = await world();
    await expect(reader(member, organizationId)).resolves.toMatchObject({
      kind: "member",
      session: { user: { id: member.user.id } },
    });
    await expect(reader(owner, organizationId, REFRESH)).resolves.toMatchObject(
      { kind: "member" },
    );
  });

  it("answers 404 for another organization and for a member without entitlements:read", async () => {
    const { reader, organizationId, other, member, billing } = await world();
    await expect(reader(member, other.organizationId)).rejects.toEqual(
      orgNotFound,
    );
    await expect(reader(billing, organizationId)).rejects.toEqual(orgNotFound);
    // whether or not the organization exists
    await expect(reader(member, "org_missing")).rejects.toEqual(orgNotFound);
  });

  it("lets staff with entitlements:read read any existing organization (kind staff)", async () => {
    const { reader, organizationId, staff } = await world();
    for (const role of ["owner", "admin", "member"] as const) {
      await expect(reader(staff[role], organizationId)).resolves.toMatchObject({
        kind: "staff",
      });
    }
    // staff without read
    await expect(reader(staff.billing, organizationId)).rejects.toEqual(
      orgNotFound,
    );
    await expect(reader(staff.overrideOnly, organizationId)).rejects.toEqual(
      orgNotFound,
    );
  });

  it("answers 404 to staff for an unknown organization id, and writes no snapshot", async () => {
    const { auth, reader, staff } = await world();
    await expect(reader(staff.owner, "org_missing")).rejects.toEqual(
      orgNotFound,
    );
    await expect(reader(staff.owner, "org_missing", REFRESH)).rejects.toEqual(
      orgNotFound,
    );
    const { adapter } = await getContext(auth);
    expect(
      await adapter.count({ model: "entitlementSnapshot", where: [] }),
    ).toBe(0);
  });

  it("checks the target organization first, then the staff organization", async () => {
    const authorize = vi.fn(
      (input: EntitlementsAuthorizeInput) =>
        input.organizationId === STAFF_ORG_ID,
    );
    const { reader, organizationId, member } = await world({
      staffOrganizationId: STAFF_ORG_ID,
      authorize,
    });
    await expect(reader(member, organizationId)).resolves.toMatchObject({
      kind: "staff",
    });
    expect(authorize.mock.calls.map(([input]) => input)).toEqual([
      expect.objectContaining({
        organizationId,
        permissions: { entitlements: ["read"] },
      }),
      expect.objectContaining({
        organizationId: STAFF_ORG_ID,
        permissions: { entitlements: ["read"] },
      }),
    ]);
  });

  it("without a staff organization, only members read", async () => {
    const { reader, organizationId, member, staff } = await world({});
    await expect(reader(member, organizationId)).resolves.toMatchObject({
      kind: "member",
    });
    await expect(reader(staff.owner, organizationId)).rejects.toEqual(
      orgNotFound,
    );
  });

  it("allows an impersonated member GET, refuses an impersonated member POST and impersonated staff", async () => {
    const { auth, reader, organizationId, member, staff } = await world();
    const asMember = await impersonatedHeaders(auth, member.user.email);
    await expect(reader(asMember, organizationId, GET)).resolves.toMatchObject({
      kind: "member",
    });
    await expect(reader(asMember, organizationId, REFRESH)).rejects.toEqual(
      notAccepted,
    );
    const asStaff = await impersonatedHeaders(auth, staff.owner.user.email);
    await expect(reader(asStaff, organizationId, GET)).rejects.toEqual(
      notAccepted,
    );
    // the gate answers 404 before acceptSession for a caller with no path
    const asOutsider = await impersonatedHeaders(auth, member.user.email);
    await expect(
      reader(asOutsider, (await seedOrg(auth)).organizationId),
    ).rejects.toEqual(orgNotFound);
  });

  it("passes kind, method and path to a custom acceptSession", async () => {
    const acceptSession = vi.fn(
      (_input: EntitlementsAcceptSessionInput) => true,
    );
    const { reader, organizationId, member, staff } = await world({
      staffOrganizationId: STAFF_ORG_ID,
      acceptSession,
    });
    await reader(member, organizationId, GET);
    await reader(staff.owner, organizationId, REFRESH);
    expect(acceptSession.mock.calls.map(([input]) => input)).toEqual([
      expect.objectContaining({ kind: "member", ...GET }),
      expect.objectContaining({ kind: "staff", ...REFRESH }),
    ]);
  });
});

describe("requireStaff", () => {
  it("passes staff whose role has the action in the staff organization", async () => {
    const { staffGate, staff } = await world();
    for (const role of ["owner", "admin", "overrideOnly"] as const) {
      await expect(staffGate(staff[role], "override")).resolves.toMatchObject({
        session: { user: { id: staff[role].user.id } },
      });
    }
    await expect(staffGate(staff.member, "read", LIST)).resolves.toBeDefined();
  });

  it("answers 404 (not 403) to staff without the action", async () => {
    const { staffGate, staff } = await world();
    await expect(staffGate(staff.member, "override")).rejects.toEqual(
      orgNotFound,
    );
    await expect(staffGate(staff.billing, "override")).rejects.toEqual(
      orgNotFound,
    );
    await expect(staffGate(staff.overrideOnly, "read", LIST)).rejects.toEqual(
      orgNotFound,
    );
  });

  it("refuses a customer organization's owner: the check runs in the staff organization", async () => {
    const { staffGate, owner } = await world();
    await expect(staffGate(owner, "override")).rejects.toEqual(orgNotFound);
    await expect(staffGate(owner, "read", LIST)).rejects.toEqual(orgNotFound);
  });

  it("denies everyone without a staff organization or a custom authorize, before any query", async () => {
    const calls: AdapterCall[] = [];
    const { staffGate, staff } = await world({}, calls);
    calls.length = 0;
    await expect(staffGate(staff.owner, "override")).rejects.toEqual(
      orgNotFound,
    );
    expect(
      calls.filter((c) => c.model === "member" || c.model === "organization"),
    ).toEqual([]);
  });

  it("warns once at boot without a staff organization and without authorize", async () => {
    const log = vi.fn();
    const auth = makeAuth({ authOptions: { logger: { log } } });
    await getRuntime(auth);
    const warnings = log.mock.calls.filter(
      ([level, message]) =>
        level === "warn" && String(message).includes("staffOrganizationId"),
    );
    expect(warnings).toHaveLength(1);
  });

  it("gives a custom authorize { organizationId: staffOrganizationId, permissions }", async () => {
    const authorize = vi.fn(() => true);
    const { auth, rt, owner } = await world({
      staffOrganizationId: STAFF_ORG_ID,
      authorize,
    });
    const { ctx, session } = await gateContext(auth, owner.headers);
    await requireStaff(ctx, rt, "override", SET);
    expect(authorize).toHaveBeenCalledTimes(1);
    expect(authorize).toHaveBeenCalledWith({
      session,
      headers: owner.headers,
      organizationId: STAFF_ORG_ID,
      permissions: { entitlements: ["override"] },
    });
  });

  it("calls a custom authorize without a staff organization (organizationId undefined)", async () => {
    const authorize = vi.fn(() => false);
    const { staffGate, staff } = await world({ authorize });
    await expect(staffGate(staff.owner, "override")).rejects.toEqual(
      orgNotFound,
    );
    expect(authorize).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: undefined }),
    );
  });

  it("refuses impersonated staff sessions, GET and POST", async () => {
    const { auth, staffGate, staff } = await world();
    const headers = await impersonatedHeaders(auth, staff.owner.user.email);
    await expect(staffGate(headers, "override", SET)).rejects.toEqual(
      notAccepted,
    );
    await expect(staffGate(headers, "read", LIST)).rejects.toEqual(notAccepted);
  });

  it("a custom acceptSession can refuse API-key sessions on the override endpoints", async () => {
    const acceptSession = vi.fn(
      ({ headers, path }: EntitlementsAcceptSessionInput) =>
        !(
          path.startsWith("/entitlements/override/") &&
          headers?.has("x-api-key")
        ),
    );
    const { staffGate, staff } = await world({
      staffOrganizationId: STAFF_ORG_ID,
      acceptSession,
    });
    const withKey = new Headers(staff.owner.headers);
    withKey.set("x-api-key", "test_secret");
    await expect(staffGate(withKey, "override", SET)).rejects.toEqual(
      notAccepted,
    );
    // the same session without the key, and the key on a non-override route
    await expect(
      staffGate(staff.owner, "override", SET),
    ).resolves.toBeDefined();
    await expect(staffGate(withKey, "read", LIST)).resolves.toBeDefined();
    expect(acceptSession).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "staff", ...SET }),
    );
  });
});

describe("requireOrgExists", () => {
  it("answers 404 for an unknown organization and passes a real one", async () => {
    const { auth, rt, organizationId } = await world();
    const { adapter } = await getContext(auth);
    await expect(
      requireOrgExists(rt, adapter, organizationId),
    ).resolves.toBeUndefined();
    await expect(requireOrgExists(rt, adapter, "org_missing")).rejects.toEqual(
      orgNotFound,
    );
  });
});
