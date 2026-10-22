import { describe, expect, it, vi } from "vitest";
import { ENTITLEMENTS_ERROR_CODES } from "./error-codes";
import type { EntitlementsOptions } from "./options";
import type { EntitlementSnapshotRow } from "./schema";
import {
  type AdapterCall,
  type AnyTestAuth,
  addMember,
  fakeSource,
  getContext,
  getRuntime,
  impersonatedHeaders,
  makeAuth,
  STAFF_ORG_ID,
  seedOrg,
  seedOverride,
  seedStaff,
  seedUsage,
  signUpUser,
  type TestUser,
} from "./test-utils";

// PRD #16 (endpoint half), #11 (the 503s) and J3, end to end through
// `auth.api` and `auth.handler`

type Transport = "api" | "handler";
type Endpoint = "get" | "refresh" | "set" | "remove" | "list";

const ROUTES: Record<
  Endpoint,
  { key: string; method: "GET" | "POST"; path: string }
> = {
  get: { key: "getEntitlements", method: "GET", path: "/entitlements/get" },
  refresh: {
    key: "refreshEntitlements",
    method: "POST",
    path: "/entitlements/refresh",
  },
  set: {
    key: "setEntitlementOverride",
    method: "POST",
    path: "/entitlements/override/set",
  },
  remove: {
    key: "removeEntitlementOverride",
    method: "POST",
    path: "/entitlements/override/remove",
  },
  list: {
    key: "listEntitlementOverrides",
    method: "GET",
    path: "/entitlements/overrides",
  },
};

const BASE_URL = "http://localhost:3000";

type Reply = { status: number; body: Record<string, unknown> };

type TestAuth = AnyTestAuth & {
  handler: (request: Request) => Promise<Response>;
};

/** Calls an endpoint through `auth.api` or `auth.handler`; errors become `{ status, body }`. */
async function call(
  auth: TestAuth,
  transport: Transport,
  endpoint: Endpoint,
  as: TestUser | Headers,
  input: Record<string, unknown>,
): Promise<Reply> {
  const route = ROUTES[endpoint];
  const headers = as instanceof Headers ? as : as.headers;
  if (transport === "api") {
    try {
      const body = await auth.api[route.key](
        route.method === "GET"
          ? { headers, query: input }
          : { headers, body: input },
      );
      return { status: 200, body };
    } catch (error) {
      const e = error as { statusCode?: number; body?: unknown };
      if (typeof e.statusCode !== "number") throw error;
      return { status: e.statusCode, body: (e.body ?? {}) as Reply["body"] };
    }
  }
  const url = new URL(`${BASE_URL}/api/auth${route.path}`);
  const requestHeaders = new Headers(headers);
  requestHeaders.set("origin", BASE_URL);
  let body: string | undefined;
  if (route.method === "GET") {
    for (const [name, value] of Object.entries(input)) {
      url.searchParams.set(name, String(value));
    }
  } else {
    requestHeaders.set("content-type", "application/json");
    body = JSON.stringify(input);
  }
  const response = await auth.handler(
    new Request(url, { method: route.method, headers: requestHeaders, body }),
  );
  const text = await response.text();
  return {
    status: response.status,
    body: text ? (JSON.parse(text) as Reply["body"]) : {},
  };
}

const failure = (status: number, code: { code: string }) =>
  expect.objectContaining({
    status,
    body: expect.objectContaining({ code: code.code }),
  });
const orgNotFound = failure(
  404,
  ENTITLEMENTS_ERROR_CODES.ORGANIZATION_NOT_FOUND,
);
const notAccepted = failure(403, ENTITLEMENTS_ERROR_CODES.SESSION_NOT_ACCEPTED);
const unavailable = failure(
  503,
  ENTITLEMENTS_ERROR_CODES.ENTITLEMENTS_UNAVAILABLE,
);

const STAFF_FIELDS = ["id", "reason", "createdBy"] as const;

async function snapshotRows(auth: AnyTestAuth, organizationId: string) {
  const { adapter } = await getContext(auth);
  return adapter.findMany<EntitlementSnapshotRow>({
    model: "entitlementSnapshot",
    where: [{ field: "organizationId", value: organizationId }],
    limit: 10,
  });
}

/**
 * A customer org (owner, `member`, `billing` users), a second org, the
 * staff org, a fake source, a spied `rt.logger.error`, and an adapter that
 * throws for calls matching `fail(...)` while it is set.
 */
async function world(options: Partial<EntitlementsOptions> = {}) {
  const source = fakeSource();
  const outage = new Error("database down");
  let failing: ((call: AdapterCall) => boolean) | null = null;
  const auth = makeAuth({
    options: { source, staffOrganizationId: STAFF_ORG_ID, ...options },
    adapter: {
      before: (c) => {
        if (failing?.(c)) throw outage;
      },
    },
  });
  const rt = await getRuntime(auth);
  const error = vi.fn();
  rt.logger = { ...rt.logger, error };
  const { staff } = await seedStaff(auth);
  const { organizationId, owner } = await seedOrg(auth);
  const other = await seedOrg(auth);
  const n = Math.random().toString(36).slice(2, 8);
  const member = await signUpUser(auth, `member-${n}@acme.test`);
  await addMember(auth, {
    organizationId,
    userId: member.user.id,
    role: "member",
  });
  const billing = await signUpUser(auth, `billing-${n}@acme.test`);
  await addMember(auth, {
    organizationId,
    userId: billing.user.id,
    role: "billing",
  });
  return {
    auth,
    rt,
    source,
    error,
    outage,
    organizationId,
    owner,
    other,
    member,
    billing,
    staff,
    fail: (match: ((c: AdapterCall) => boolean) | null) => {
      failing = match;
    },
  };
}

describe.each<Transport>(["api", "handler"])(
  "access, end to end (%s)",
  (transport) => {
    it("a member reads their own org, with usage and without staff fields", async () => {
      const w = await world();
      await seedOverride(w.auth, {
        organizationId: w.organizationId,
        kind: "feature",
        key: "exports",
        value: true,
        reason: "trial",
        createdBy: w.staff.owner.user.id,
      });
      await seedUsage(w.auth, {
        organizationId: w.organizationId,
        key: "apiCalls",
        used: 7,
      });
      for (const endpoint of ["get", "refresh"] as const) {
        const reply = await call(w.auth, transport, endpoint, w.member, {
          organizationId: w.organizationId,
        });
        expect(reply.status).toBe(200);
        expect(reply.body).toMatchObject({
          organizationId: w.organizationId,
          degraded: false,
          plan: { key: "free", source: "default" },
          features: { exports: true, sso: false },
          usage: {
            apiCalls: { used: 7, remaining: 993 },
            uploads: { used: 0, remaining: 10 },
            reports: { used: 0, remaining: 5 },
          },
        });
        const overrides = reply.body.overrides as Record<string, unknown>[];
        expect(overrides).toHaveLength(1);
        expect(Object.keys(overrides[0] as object).sort()).toEqual([
          "expiresAt",
          "key",
          "kind",
        ]);
        for (const field of STAFF_FIELDS) {
          expect(overrides[0]).not.toHaveProperty(field);
        }
      }
      // the owner reads too (read in their own org)
      expect(
        (
          await call(w.auth, transport, "get", w.owner, {
            organizationId: w.organizationId,
          })
        ).status,
      ).toBe(200);
    });

    it("another org, no read permission, or an unknown org → 404", async () => {
      const w = await world();
      for (const endpoint of ["get", "refresh"] as const) {
        expect(
          await call(w.auth, transport, endpoint, w.member, {
            organizationId: w.other.organizationId,
          }),
        ).toEqual(orgNotFound);
        expect(
          await call(w.auth, transport, endpoint, w.billing, {
            organizationId: w.organizationId,
          }),
        ).toEqual(orgNotFound);
        expect(
          await call(w.auth, transport, endpoint, w.member, {
            organizationId: "org_missing",
          }),
        ).toEqual(orgNotFound);
      }
      expect(await snapshotRows(w.auth, w.other.organizationId)).toHaveLength(
        0,
      );
      expect(await snapshotRows(w.auth, "org_missing")).toHaveLength(0);
    });

    it("staff read any org with each override's id, reason and createdBy; an unknown org → 404 and no snapshot row", async () => {
      const w = await world();
      const row = await seedOverride(w.auth, {
        organizationId: w.organizationId,
        kind: "limit",
        key: "projects",
        value: 9,
        reason: "migration",
        createdBy: w.staff.owner.user.id,
      });
      const plan = await seedOverride(w.auth, {
        organizationId: w.organizationId,
        kind: "plan",
        key: "team",
        reason: "partner",
        createdBy: w.staff.admin.user.id,
      });
      for (const endpoint of ["get", "refresh"] as const) {
        const reply = await call(w.auth, transport, endpoint, w.staff.member, {
          organizationId: w.organizationId,
        });
        expect(reply.status).toBe(200);
        expect(reply.body).toMatchObject({
          organizationId: w.organizationId,
          plan: { key: "team", source: "override" },
          limits: { projects: 9 },
        });
        const overrides = reply.body.overrides as unknown[];
        expect(overrides).toHaveLength(2);
        expect(overrides).toEqual(
          expect.arrayContaining([
            {
              kind: "limit",
              key: "projects",
              expiresAt: null,
              id: row.id,
              reason: "migration",
              createdBy: w.staff.owner.user.id,
            },
            {
              kind: "plan",
              key: "team",
              expiresAt: null,
              id: plan.id,
              reason: "partner",
              createdBy: w.staff.admin.user.id,
            },
          ]),
        );
        expect(
          await call(w.auth, transport, endpoint, w.staff.member, {
            organizationId: "org_missing",
          }),
        ).toEqual(orgNotFound);
        // staff without read in the staff org
        expect(
          await call(w.auth, transport, endpoint, w.staff.billing, {
            organizationId: w.organizationId,
          }),
        ).toEqual(orgNotFound);
      }
      expect(await snapshotRows(w.auth, "org_missing")).toHaveLength(0);
    });

    it("a customer-org owner can't override their own org; staff with override can, staff without → 404", async () => {
      const w = await world();
      const body = {
        organizationId: w.organizationId,
        kind: "feature",
        key: "sso",
        value: true,
        reason: "pilot",
      };
      expect(await call(w.auth, transport, "set", w.owner, body)).toEqual(
        orgNotFound,
      );
      for (const user of [w.staff.member, w.staff.billing]) {
        expect(await call(w.auth, transport, "set", user, body)).toEqual(
          orgNotFound,
        );
        expect(
          await call(w.auth, transport, "set", user, {
            ...body,
            organizationId: "org_missing",
          }),
        ).toEqual(orgNotFound);
      }
      // staff with override, for an unknown org → 404 as well
      expect(
        await call(w.auth, transport, "set", w.staff.admin, {
          ...body,
          organizationId: "org_missing",
        }),
      ).toEqual(orgNotFound);

      const set = await call(w.auth, transport, "set", w.staff.admin, body);
      expect(set.status).toBe(200);
      const override = set.body.override as Record<string, unknown>;
      expect(override).toMatchObject({
        organizationId: w.organizationId,
        status: "active",
        kind: "feature",
        key: "sso",
        value: true,
        reason: "pilot",
        createdBy: w.staff.admin.user.id,
        expiresAt: null,
      });
      // the member sees it at once (the write cleared the cache)
      const read = await call(w.auth, transport, "get", w.member, {
        organizationId: w.organizationId,
      });
      expect(read.body).toMatchObject({ features: { sso: true } });

      // invalid input → INVALID_OVERRIDE (validation after the gates)
      expect(
        await call(w.auth, transport, "set", w.staff.admin, {
          ...body,
          key: "nope",
        }),
      ).toEqual(failure(400, ENTITLEMENTS_ERROR_CODES.INVALID_OVERRIDE));

      // remove: the owner and staff without override → 404, staff with → ok
      for (const user of [w.owner, w.staff.member]) {
        expect(
          await call(w.auth, transport, "remove", user, { id: override.id }),
        ).toEqual(orgNotFound);
      }
      expect(
        await call(w.auth, transport, "remove", w.staff.overrideOnly, {
          id: override.id,
        }),
      ).toEqual({ status: 200, body: { ok: true } });
      expect(
        await call(w.auth, transport, "remove", w.staff.admin, {
          id: override.id,
        }),
      ).toEqual(failure(404, ENTITLEMENTS_ERROR_CODES.OVERRIDE_NOT_FOUND));
    });

    it("the override list needs read in the staff org", async () => {
      const w = await world();
      await seedOverride(w.auth, {
        organizationId: w.organizationId,
        kind: "feature",
        key: "exports",
      });
      const list = await call(w.auth, transport, "list", w.staff.member, {
        organizationId: w.organizationId,
      });
      expect(list.status).toBe(200);
      expect(list.body).toMatchObject({
        overrides: [{ organizationId: w.organizationId, key: "exports" }],
        nextCursor: null,
      });
      for (const user of [w.owner, w.member, w.staff.overrideOnly]) {
        expect(
          await call(w.auth, transport, "list", user, {
            organizationId: w.organizationId,
          }),
        ).toEqual(orgNotFound);
      }
      // no filter: every org's overrides, newest first
      await seedOverride(w.auth, {
        organizationId: w.other.organizationId,
        kind: "limit",
        key: "members",
        value: 8,
        createdAt: new Date(Date.now() + 60_000),
      });
      const all = await call(w.auth, transport, "list", w.staff.member, {});
      expect(all.status).toBe(200);
      expect(all.body).toMatchObject({
        overrides: [
          { organizationId: w.other.organizationId, key: "members" },
          { organizationId: w.organizationId, key: "exports" },
        ],
        nextCursor: null,
      });
      expect(
        await call(w.auth, transport, "list", w.staff.member, {
          cursor: "not a cursor",
        }),
      ).toEqual(failure(400, ENTITLEMENTS_ERROR_CODES.INVALID_CURSOR));
    });

    it("impersonated: a member GET is allowed, staff calls and POSTs are refused", async () => {
      const w = await world();
      const asMember = await impersonatedHeaders(w.auth, w.member.user.email);
      const asStaff = await impersonatedHeaders(
        w.auth,
        w.staff.admin.user.email,
      );
      const target = { organizationId: w.organizationId };
      const get = await call(w.auth, transport, "get", asMember, target);
      expect(get.status).toBe(200);
      expect(
        await call(w.auth, transport, "refresh", asMember, target),
      ).toEqual(notAccepted);
      expect(await call(w.auth, transport, "get", asStaff, target)).toEqual(
        notAccepted,
      );
      expect(
        await call(w.auth, transport, "set", asStaff, {
          ...target,
          kind: "feature",
          key: "sso",
          value: true,
          reason: "pilot",
        }),
      ).toEqual(notAccepted);
      expect(await call(w.auth, transport, "list", asStaff, target)).toEqual(
        notAccepted,
      );
    });

    it("no session → 401", async () => {
      const w = await world();
      const reply = await call(w.auth, transport, "get", new Headers(), {
        organizationId: w.organizationId,
      });
      expect(reply.status).toBe(401);
    });
  },
);

describe("503 ENTITLEMENTS_UNAVAILABLE (PRD #11)", () => {
  it("getEntitlements: a degraded read → 503, logged once (by the read)", async () => {
    const w = await world();
    w.source.failWith = new Error("source down");
    for (const transport of ["api", "handler"] as const) {
      w.error.mockClear();
      expect(
        await call(w.auth, transport, "get", w.member, {
          organizationId: w.organizationId,
        }),
      ).toEqual(unavailable);
      expect(w.error).toHaveBeenCalledTimes(1);
    }
    expect(await snapshotRows(w.auth, w.organizationId)).toHaveLength(0);
  });

  it("a readUsage throw → 503, logged once by the handler", async () => {
    const w = await world({ cacheTtlMs: 0 });
    w.fail((c) => c.model === "entitlementUsage" && c.method === "findOne");
    for (const endpoint of ["get", "refresh"] as const) {
      w.error.mockClear();
      expect(
        await call(w.auth, "api", endpoint, w.member, {
          organizationId: w.organizationId,
        }),
      ).toEqual(unavailable);
      expect(w.error).toHaveBeenCalledTimes(1);
      expect(w.error.mock.calls[0]?.[1]).toBe(w.outage);
    }
  });

  it("a throw from the staff live-row read → 503, logged once; members don't read the rows", async () => {
    const w = await world();
    await seedOverride(w.auth, {
      organizationId: w.organizationId,
      kind: "feature",
      key: "exports",
    });
    const target = { organizationId: w.organizationId };
    // warm the cache, so only the staff row read reaches the adapter
    expect(
      (await call(w.auth, "api", "get", w.staff.member, target)).status,
    ).toBe(200);
    w.error.mockClear();
    w.fail((c) => c.model === "entitlementOverride" && c.method === "findMany");
    expect(await call(w.auth, "api", "get", w.staff.member, target)).toEqual(
      unavailable,
    );
    expect(w.error).toHaveBeenCalledTimes(1);
    expect(w.error.mock.calls[0]?.[1]).toBe(w.outage);
    const member = await call(w.auth, "api", "get", w.member, target);
    expect(member.status).toBe(200);
    expect(member.body).toMatchObject({ features: { exports: true } });
    expect(w.error).toHaveBeenCalledTimes(1);
  });

  it("refreshEntitlements: a sync that throws → 503, logged once", async () => {
    const w = await world();
    w.source.failWith = new Error("source down");
    for (const transport of ["api", "handler"] as const) {
      w.error.mockClear();
      expect(
        await call(w.auth, transport, "refresh", w.member, {
          organizationId: w.organizationId,
        }),
      ).toEqual(unavailable);
      expect(w.error).toHaveBeenCalledTimes(1);
      expect(w.error.mock.calls[0]?.[1]).toBe(w.source.failWith);
    }
    expect(await snapshotRows(w.auth, w.organizationId)).toHaveLength(0);
  });

  it("refreshEntitlements: a degraded fresh state → 503, logged once (by the read)", async () => {
    const w = await world();
    w.source.states.set(w.organizationId, { planKey: "pro", status: "active" });
    w.fail((c) => c.model === "entitlementOverride" && c.method === "findMany");
    expect(
      await call(w.auth, "api", "refresh", w.member, {
        organizationId: w.organizationId,
      }),
    ).toEqual(unavailable);
    expect(w.error).toHaveBeenCalledTimes(1);
    // the sync itself went through
    expect(await snapshotRows(w.auth, w.organizationId)).toMatchObject([
      { planKey: "pro" },
    ]);
  });
});

describe("J3: refreshEntitlements bypasses the cache", () => {
  it("returns the new plan right after a source update while the cache holds the old one", async () => {
    const w = await world();
    const target = { organizationId: w.organizationId };
    const first = await call(w.auth, "api", "get", w.member, target);
    expect(first.body).toMatchObject({ plan: { key: "free" } });
    // checkout completed; the webhook hasn't arrived
    w.source.states.set(w.organizationId, {
      planKey: "pro",
      status: "active",
    });
    expect(
      (await call(w.auth, "api", "get", w.member, target)).body,
    ).toMatchObject({ plan: { key: "free" } });
    expect(w.rt.cache.get(w.organizationId)?.result.plan.key).toBe("free");

    const refreshed = await call(w.auth, "api", "refresh", w.member, target);
    expect(refreshed.status).toBe(200);
    expect(refreshed.body).toMatchObject({
      plan: { key: "pro", source: "billing" },
      status: "active",
      features: { exports: true },
      limits: { projects: "unlimited" },
    });
    expect(
      (await call(w.auth, "api", "get", w.member, target)).body,
    ).toMatchObject({ plan: { key: "pro" } });
  });
});
