import { describe, expect, it, vi } from "vitest";
import { deleteOrganizationData, userDeleteHook } from "./lifecycle";
import type { EntitlementOverrideRow } from "./schema";
import {
  type AdapterCall,
  type AnyTestAuth,
  addMember,
  expectNoOuterCalls,
  getContext,
  getRuntime,
  makeAuth,
  seedOrg,
  seedOverride,
  seedUsage,
  setSnapshot,
  signUpUser,
  type TestAuthConfig,
} from "./test-utils";
import type { ResolvedState } from "./types";

const MODELS = [
  "entitlementSnapshot",
  "entitlementOverride",
  "entitlementUsage",
] as const;

/** Row counts per model for one organization, read straight from the adapter. */
async function counts(auth: AnyTestAuth, organizationId: string) {
  const { adapter } = await getContext(auth);
  const out: Record<string, number> = {};
  for (const model of MODELS) {
    const rows = await adapter.findMany({
      model,
      where: [{ field: "organizationId", value: organizationId }],
      limit: 1000,
    });
    out[model] = rows.length;
  }
  return out;
}

const NONE = {
  entitlementSnapshot: 0,
  entitlementOverride: 0,
  entitlementUsage: 0,
};
const SEEDED = {
  entitlementSnapshot: 1,
  entitlementOverride: 2,
  entitlementUsage: 2,
};

/** One snapshot, two overrides (one removed) and two usage rows. */
async function seedRows(auth: AnyTestAuth, organizationId: string) {
  await setSnapshot(auth, organizationId, { planKey: "pro", status: "active" });
  await seedOverride(auth, { organizationId, kind: "feature", key: "sso" });
  await seedOverride(auth, {
    organizationId,
    kind: "limit",
    key: "members",
    value: 10,
    status: "removed",
    endedAt: new Date(),
  });
  await seedUsage(auth, { organizationId, key: "apiCalls", used: 3 });
  await seedUsage(auth, { organizationId, key: "uploads", used: 1 });
}

/** A memory-lane auth that records every entitlement* deleteMany call. */
function setup(config: TestAuthConfig = {}) {
  const deletes: AdapterCall[] = [];
  let fail: ((call: AdapterCall) => boolean) | null = null;
  const auth = makeAuth({
    ...config,
    adapter: {
      before: (call) => {
        if (
          call.method === "deleteMany" &&
          call.model.startsWith("entitlement")
        ) {
          deletes.push(call);
        }
        if (fail?.(call)) throw new Error("simulated database failure");
      },
    },
  });
  return {
    auth,
    deletes,
    failWhen: (predicate: ((call: AdapterCall) => boolean) | null) => {
      fail = predicate;
    },
  };
}

const fakeState = { result: { degraded: false } } as unknown as ResolvedState;

describe("deleteOrganizationData (memory)", () => {
  it("deletes the organization's rows in all three models explicitly and clears its cache entry", async () => {
    const { auth, deletes } = setup();
    const rt = await getRuntime(auth);
    const { organizationId } = await seedOrg(auth);
    const other = await seedOrg(auth);
    await seedRows(auth, organizationId);
    await seedRows(auth, other.organizationId);
    rt.cache.set(organizationId, fakeState);
    rt.cache.set(other.organizationId, fakeState);

    await deleteOrganizationData(auth, organizationId);

    expect(await counts(auth, organizationId)).toEqual(NONE);
    expect(await counts(auth, other.organizationId)).toEqual(SEEDED);
    expect(rt.cache.get(organizationId)).toBeUndefined();
    expect(rt.cache.get(other.organizationId)).toBe(fakeState);
    // one deleteMany per model, each filtered on the organization
    expect(deletes.map((call) => call.model).sort()).toEqual(
      [...MODELS].sort(),
    );
    for (const call of deletes) {
      expect(call.args.where).toEqual([
        { field: "organizationId", value: organizationId },
      ]);
    }
    // the organization itself is untouched (it isn't ours to delete)
    const { adapter } = await getContext(auth);
    expect(
      await adapter.findOne({
        model: "organization",
        where: [{ field: "id", value: organizationId }],
      }),
    ).not.toBeNull();
  });

  it("runs inside the caller's transaction (G17)", async () => {
    const { auth } = setup();
    const { organizationId } = await seedOrg(auth);
    await seedRows(auth, organizationId);
    await expectNoOuterCalls(auth, () =>
      deleteOrganizationData(auth, organizationId),
    );
    expect(await counts(auth, organizationId)).toEqual(NONE);
  });

  it("throws without the plugin, and for an empty id", async () => {
    const bare = { $context: Promise.resolve({ options: { plugins: [] } }) };
    await expect(deleteOrganizationData(bare, "org_1")).rejects.toThrow(
      "[@byo-oss/entitlements] deleteOrganizationData needs the entitlements plugin installed on this auth instance",
    );
    const { auth } = setup();
    await expect(deleteOrganizationData(auth, "")).rejects.toThrow(
      "[@byo-oss/entitlements] deleteOrganizationData needs a non-empty organizationId",
    );
  });

  it("is the plugin's byo.deleteOrganizationData", async () => {
    const { auth } = setup();
    const { organizationId } = await seedOrg(auth);
    await seedRows(auth, organizationId);
    const context = await getContext(auth);
    const plugin = context.options.plugins?.find(
      (p) => p.id === "entitlements",
    ) as unknown as {
      byo: { deleteOrganizationData: typeof deleteOrganizationData };
    };
    await plugin.byo.deleteOrganizationData(auth, organizationId);
    expect(await counts(auth, organizationId)).toEqual(NONE);
  });
});

describe("org delete through /organization/delete (PRD #22, memory)", () => {
  it("removes all three models for that organization only", async () => {
    const { auth } = setup();
    const rt = await getRuntime(auth);
    const { organizationId, owner } = await seedOrg(auth);
    const other = await seedOrg(auth);
    await seedRows(auth, organizationId);
    await seedRows(auth, other.organizationId);
    rt.cache.set(organizationId, fakeState);

    const deleted = await auth.api.deleteOrganization({
      body: { organizationId },
      headers: owner.headers,
    });

    expect(deleted).toMatchObject({ id: organizationId });
    expect(await counts(auth, organizationId)).toEqual(NONE);
    expect(await counts(auth, other.organizationId)).toEqual(SEEDED);
    expect(rt.cache.get(organizationId)).toBeUndefined();
  });

  it("a failed delete call (unauthorized, forbidden, not a member) removes nothing", async () => {
    const { auth, deletes } = setup();
    const { organizationId } = await seedOrg(auth);
    const outsider = await seedOrg(auth);
    const plainMember = await signUpUser(auth, "plain-member@acme.test");
    await addMember(auth, {
      organizationId,
      userId: plainMember.user.id,
      role: "member",
    });
    await seedRows(auth, organizationId);

    // no session
    await expect(
      auth.api.deleteOrganization({
        body: { organizationId },
        headers: new Headers(),
      }),
    ).rejects.toMatchObject({ status: "UNAUTHORIZED" });
    // a member without organization:delete
    await expect(
      auth.api.deleteOrganization({
        body: { organizationId },
        headers: plainMember.headers,
      }),
    ).rejects.toMatchObject({ status: "FORBIDDEN" });
    // another organization's owner naming this organization in the body
    await expect(
      auth.api.deleteOrganization({
        body: { organizationId },
        headers: outsider.owner.headers,
      }),
    ).rejects.toMatchObject({ status: "BAD_REQUEST" });

    expect(deletes).toEqual([]);
    expect(await counts(auth, organizationId)).toEqual(SEEDED);
  });

  it("a cleanup failure is logged and doesn't fail the response", async () => {
    const { auth, failWhen } = setup();
    const rt = await getRuntime(auth);
    const error = vi.fn();
    rt.logger = { ...rt.logger, error };
    const { organizationId, owner } = await seedOrg(auth);
    await seedRows(auth, organizationId);
    failWhen(
      (call) =>
        call.method === "deleteMany" && call.model === "entitlementOverride",
    );

    const deleted = await auth.api.deleteOrganization({
      body: { organizationId },
      headers: owner.headers,
    });
    failWhen(null);

    expect(deleted).toMatchObject({ id: organizationId });
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0]?.[0])).toContain(
      `[@byo-oss/entitlements] cleanup after /organization/delete failed for organization ${organizationId}`,
    );
    // deleteOrganizationData finishes the job afterwards
    await deleteOrganizationData(auth, organizationId);
    expect(await counts(auth, organizationId)).toEqual(NONE);
  });

  it("organizationCleanup: false keeps the rows on the memory adapter until deleteOrganizationData runs", async () => {
    const { auth, deletes } = setup({
      options: { organizationCleanup: false },
    });
    const { organizationId, owner } = await seedOrg(auth);
    await seedRows(auth, organizationId);

    await auth.api.deleteOrganization({
      body: { organizationId },
      headers: owner.headers,
    });

    // the memory adapter applies no foreign-key cascade
    expect(deletes).toEqual([]);
    expect(await counts(auth, organizationId)).toEqual(SEEDED);
    await deleteOrganizationData(auth, organizationId);
    expect(await counts(auth, organizationId)).toEqual(NONE);
  });
});

describe("user delete (PRD #22, memory)", () => {
  async function overrideRows(auth: AnyTestAuth, organizationId: string) {
    const { adapter } = await getContext(auth);
    return adapter.findMany<EntitlementOverrideRow>({
      model: "entitlementOverride",
      where: [{ field: "organizationId", value: organizationId }],
      limit: 100,
    });
  }

  async function seedAuthored(auth: AnyTestAuth) {
    const { organizationId } = await seedOrg(auth);
    const gone = await signUpUser(auth, `gone-${Date.now()}@staff.test`);
    const kept = await signUpUser(auth, `kept-${Date.now()}@staff.test`);
    const byGone = await seedOverride(auth, {
      organizationId,
      kind: "feature",
      key: "sso",
      createdBy: gone.user.id,
    });
    const removedByGone = await seedOverride(auth, {
      organizationId,
      kind: "feature",
      key: "exports",
      status: "removed",
      endedAt: new Date(),
      createdBy: kept.user.id,
      removedBy: gone.user.id,
    });
    const byKept = await seedOverride(auth, {
      organizationId,
      kind: "limit",
      key: "members",
      value: 20,
      createdBy: kept.user.id,
      removedBy: kept.user.id,
    });
    return { organizationId, gone, kept, byGone, removedByGone, byKept };
  }

  it("nulls createdBy and removedBy for that user only", async () => {
    const { auth } = setup();
    const context = await getContext(auth);
    const seeded = await seedAuthored(auth);

    await context.internalAdapter.deleteUser(seeded.gone.user.id);

    expect(
      await context.adapter.findOne({
        model: "user",
        where: [{ field: "id", value: seeded.gone.user.id }],
      }),
    ).toBeNull();
    const rows = new Map(
      (await overrideRows(auth, seeded.organizationId)).map((row) => [
        row.id,
        row,
      ]),
    );
    expect(rows.get(seeded.byGone.id)).toMatchObject({
      createdBy: null,
      removedBy: null,
    });
    expect(rows.get(seeded.removedByGone.id)).toMatchObject({
      createdBy: seeded.kept.user.id,
      removedBy: null,
      status: "removed",
    });
    expect(rows.get(seeded.byKept.id)).toMatchObject({
      createdBy: seeded.kept.user.id,
      removedBy: seeded.kept.user.id,
    });
  });

  it("a failing update is logged and the user is still deleted", async () => {
    const { auth, failWhen } = setup();
    const rt = await getRuntime(auth);
    const context = await getContext(auth);
    const error = vi.fn();
    rt.logger = { ...rt.logger, error };
    const seeded = await seedAuthored(auth);
    failWhen(
      (call) =>
        call.method === "updateMany" && call.model === "entitlementOverride",
    );

    await context.internalAdapter.deleteUser(seeded.gone.user.id);
    failWhen(null);

    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0]?.[0])).toContain(
      `[@byo-oss/entitlements] clearing override authorship after deleting user ${seeded.gone.user.id} failed`,
    );
    expect(
      await context.adapter.findOne({
        model: "user",
        where: [{ field: "id", value: seeded.gone.user.id }],
      }),
    ).toBeNull();
  });

  it("ignores a call without a user id", async () => {
    const { auth } = setup();
    const rt = await getRuntime(auth);
    const hook = userDeleteHook(rt) as (user: unknown) => Promise<void>;
    await expect(hook(undefined)).resolves.toBeUndefined();
    await expect(hook({})).resolves.toBeUndefined();
  });
});
