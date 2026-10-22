import { describe, expect, it } from "vitest";
import { createEntitlements } from "./api";
import type { EntitlementOverrideRow, EntitlementSnapshotRow } from "./schema";
import {
  type AnyTestAuth,
  expectNoOuterCalls,
  fakeSource,
  getContext,
  getRuntime,
  makeAuth,
  STAFF_ORG_ID,
  seedOrg,
  seedOverride,
  seedStaff,
  testCatalog,
} from "./test-utils";
import { inTransaction } from "./txn";

// PRD #15, N06's half, on the memory adapter (real transactions). The G17
// evidence is `expectNoOuterCalls`: every entitlements call inside it must
// go through the transaction adapter.

async function rows<T>(
  auth: AnyTestAuth,
  model: string,
  organizationId: string,
): Promise<T[]> {
  const { adapter } = await getContext(auth);
  return adapter.findMany<T>({
    model,
    where: [{ field: "organizationId", value: organizationId }],
    limit: 100,
  });
}

/** Cache on (default TTL), a fake source, the staff org and one customer org. */
async function setup() {
  const source = fakeSource();
  const auth = makeAuth({
    options: { source, staffOrganizationId: STAFF_ORG_ID },
  });
  const rt = await getRuntime(auth);
  const { staff } = await seedStaff(auth);
  const { organizationId, owner } = await seedOrg(auth);
  return {
    auth,
    rt,
    source,
    staff,
    owner,
    organizationId,
    api: createEntitlements(auth, testCatalog),
    snapshots: () =>
      rows<EntitlementSnapshotRow>(auth, "entitlementSnapshot", organizationId),
    overrides: () =>
      rows<EntitlementOverrideRow>(auth, "entitlementOverride", organizationId),
  };
}

class Rollback extends Error {}

describe("inside a caller's transaction (memory)", () => {
  it("hasFeature, getLimit and checkCapacity finish with a missing snapshot and leave no snapshot row", async () => {
    const t = await setup();
    t.source.states.set(t.organizationId, {
      planKey: "pro",
      status: "active",
    });
    const [feature, limit, capacity] = await expectNoOuterCalls(
      t.auth,
      async () => {
        expect(await inTransaction(t.rt)).toBe(true);
        return [
          await t.api.hasFeature(t.organizationId, "exports"),
          await t.api.getLimit(t.organizationId, "apiCalls"),
          await t.api.checkCapacity(t.organizationId, "members", {
            count: 10,
          }),
        ] as const;
      },
    );
    // resolved through the source (pro), not persisted
    expect(feature).toMatchObject({ allowed: true, reason: "ok", plan: "pro" });
    expect(limit).toMatchObject({ limit: 50_000, used: 0, degraded: false });
    expect(capacity).toMatchObject({ allowed: true, limit: 50 });
    expect(t.source.calls.length).toBeGreaterThan(0);
    expect(await t.snapshots()).toHaveLength(0);
    expect(t.rt.cache.get(t.organizationId)).toBeUndefined();
    // outside, the same read persists it
    expect((await t.api.get(t.organizationId)).plan.key).toBe("pro");
    expect(await t.snapshots()).toHaveLength(1);
  });

  it("refreshEntitlements throws the documented error and writes nothing", async () => {
    const t = await setup();
    t.source.states.set(t.organizationId, {
      planKey: "pro",
      status: "active",
    });
    await expectNoOuterCalls(t.auth, async () => {
      await expect(
        t.auth.api.refreshEntitlements({
          body: { organizationId: t.organizationId },
          headers: t.owner.headers,
        }),
      ).rejects.toThrow(
        "[@byo-oss/entitlements] refreshEntitlements must run outside a transaction",
      );
    });
    expect(t.source.calls).toHaveLength(0);
    expect(await t.snapshots()).toHaveLength(0);
    // outside a transaction it works
    const fresh = await t.auth.api.refreshEntitlements({
      body: { organizationId: t.organizationId },
      headers: t.owner.headers,
    });
    expect(fresh.plan.key).toBe("pro");
    expect(await t.snapshots()).toHaveLength(1);
  });

  it("an override set inside a rolled-back transaction leaves no row and no cached leak", async () => {
    const t = await setup();
    // warm the cache with the old value
    expect(await t.api.hasFeature(t.organizationId, "sso")).toMatchObject({
      allowed: false,
    });
    expect(t.rt.cache.get(t.organizationId)).toBeDefined();
    await expect(
      expectNoOuterCalls(t.auth, async () => {
        const { override } = await t.auth.api.setEntitlementOverride({
          body: {
            organizationId: t.organizationId,
            kind: "feature",
            key: "sso",
            value: true,
            reason: "pilot",
          },
          headers: t.staff.admin.headers,
        });
        expect(override).toMatchObject({ key: "sso", status: "active" });
        // the transaction sees its own write
        expect(await t.api.hasFeature(t.organizationId, "sso")).toMatchObject({
          allowed: true,
        });
        throw new Rollback("roll back");
      }),
    ).rejects.toBeInstanceOf(Rollback);
    expect(await t.overrides()).toHaveLength(0);
    // nothing computed inside the transaction was cached
    expect(t.rt.cache.get(t.organizationId)?.result.features.sso).not.toBe(
      true,
    );
    expect(await t.api.hasFeature(t.organizationId, "sso")).toMatchObject({
      allowed: false,
      reason: "not_in_plan",
    });
  });

  it("an override removed inside a rolled-back transaction stays active", async () => {
    const t = await setup();
    const row = await seedOverride(t.auth, {
      organizationId: t.organizationId,
      kind: "feature",
      key: "sso",
      value: true,
    });
    expect(await t.api.hasFeature(t.organizationId, "sso")).toMatchObject({
      allowed: true,
    });
    await expect(
      expectNoOuterCalls(t.auth, async () => {
        expect(
          await t.auth.api.removeEntitlementOverride({
            body: { id: row.id },
            headers: t.staff.admin.headers,
          }),
        ).toEqual({ ok: true });
        expect(await t.api.hasFeature(t.organizationId, "sso")).toMatchObject({
          allowed: false,
        });
        throw new Rollback("roll back");
      }),
    ).rejects.toBeInstanceOf(Rollback);
    expect(await t.overrides()).toMatchObject([
      { id: row.id, status: "active" },
    ]);
    expect(await t.api.hasFeature(t.organizationId, "sso")).toMatchObject({
      allowed: true,
    });
  });
});
