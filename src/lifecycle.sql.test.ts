import { runWithTransaction } from "@better-auth/core/context";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deleteOrganizationData, userDeleteHook } from "./lifecycle";
import { createSqlTestAuth } from "./test-sql";
import {
  expectNoOuterCalls,
  getContext,
  getRuntime,
  seedOrg,
  seedOverride,
  seedUsage,
  setSnapshot,
  signUpUser,
} from "./test-utils";
import type { ResolvedState } from "./types";

type Harness = Awaited<ReturnType<typeof createSqlTestAuth>>;

const TABLES = [
  "entitlementSnapshot",
  "entitlementOverride",
  "entitlementUsage",
] as const;

/** Row counts per table for one organization, in raw SQL (no adapter in between). */
async function counts(harness: Harness, organizationId: string) {
  const out: Record<string, number> = {};
  for (const table of TABLES) {
    const { rows } = await sql<{ n: number }>`
      select count(*)::int as n from ${sql.table(table)}
      where "organizationId" = ${organizationId}`.execute(harness.db);
    out[table] = rows[0]?.n ?? -1;
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

async function seedRows(harness: Harness, organizationId: string) {
  const { auth } = harness;
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

const fakeState = { result: { degraded: false } } as unknown as ResolvedState;

describe("lifecycle on PGlite (PRD #22)", () => {
  let harness: Harness;
  beforeAll(async () => {
    harness = await createSqlTestAuth();
  });
  afterAll(async () => {
    await harness?.close();
  });

  it("org delete through /organization/delete removes all three models", async () => {
    const { auth } = harness;
    const rt = await getRuntime(auth);
    const { organizationId, owner } = await seedOrg(auth);
    const other = await seedOrg(auth);
    await seedRows(harness, organizationId);
    await seedRows(harness, other.organizationId);
    rt.cache.set(organizationId, fakeState);

    await auth.api.deleteOrganization({
      body: { organizationId },
      headers: owner.headers,
    });

    expect(await counts(harness, organizationId)).toEqual(NONE);
    expect(await counts(harness, other.organizationId)).toEqual(SEEDED);
    expect(rt.cache.get(organizationId)).toBeUndefined();
  });

  it("a failed delete call (unauthorized, forbidden) removes nothing", async () => {
    const { auth } = harness;
    const { organizationId } = await seedOrg(auth);
    const plainMember = await signUpUser(auth, "sql-plain-member@acme.test");
    await auth.api.addMember({
      body: { organizationId, userId: plainMember.user.id, role: "member" },
    });
    await seedRows(harness, organizationId);

    await expect(
      auth.api.deleteOrganization({
        body: { organizationId },
        headers: new Headers(),
      }),
    ).rejects.toMatchObject({ status: "UNAUTHORIZED" });
    await expect(
      auth.api.deleteOrganization({
        body: { organizationId },
        headers: plainMember.headers,
      }),
    ).rejects.toMatchObject({ status: "FORBIDDEN" });

    expect(await counts(harness, organizationId)).toEqual(SEEDED);
  });

  it("deleteOrganizationData deletes explicitly while the organization still exists (no cascade involved)", async () => {
    const { auth, db } = harness;
    const { organizationId } = await seedOrg(auth);
    await seedRows(harness, organizationId);

    await deleteOrganizationData(auth, organizationId);

    expect(await counts(harness, organizationId)).toEqual(NONE);
    const { rows } = await sql<{ n: number }>`
      select count(*)::int as n from "organization" where id = ${organizationId}`.execute(
      db,
    );
    expect(rows[0]?.n).toBe(1);
  });

  it("deleteOrganizationData inside runWithTransaction uses the transaction (G17) and rolls back with it", async () => {
    const { auth } = harness;
    const context = await getContext(auth);
    const { organizationId } = await seedOrg(auth);
    await seedRows(harness, organizationId);

    // rolled back: every delete went through the transaction, so nothing is gone
    await expect(
      runWithTransaction(context.adapter, async () => {
        await deleteOrganizationData(auth, organizationId);
        throw new Error("roll back");
      }),
    ).rejects.toThrow("roll back");
    expect(await counts(harness, organizationId)).toEqual(SEEDED);

    // committed, with no call on the outer adapter
    await expectNoOuterCalls(auth, () =>
      deleteOrganizationData(auth, organizationId),
    );
    expect(await counts(harness, organizationId)).toEqual(NONE);
  });

  it("user delete nulls createdBy/removedBy", async () => {
    const { auth, db } = harness;
    const context = await getContext(auth);
    const { organizationId } = await seedOrg(auth);
    const gone = await signUpUser(auth, "sql-gone@staff.test");
    const kept = await signUpUser(auth, "sql-kept@staff.test");
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

    await context.internalAdapter.deleteUser(gone.user.id);

    const { rows } = await sql<{
      id: string;
      createdBy: string | null;
      removedBy: string | null;
    }>`
      select id, "createdBy", "removedBy" from "entitlementOverride"
      where "organizationId" = ${organizationId}`.execute(db);
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get(byGone.id)).toMatchObject({
      createdBy: null,
      removedBy: null,
    });
    expect(byId.get(removedByGone.id)).toMatchObject({
      createdBy: kept.user.id,
      removedBy: null,
    });
  });

  it("the user-delete hook itself nulls both columns through the adapter (no FK involved)", async () => {
    const { auth, db } = harness;
    const rt = await getRuntime(auth);
    const { organizationId } = await seedOrg(auth);
    // the user still exists, so only the hook can clear the columns
    const author = await signUpUser(auth, "sql-author@staff.test");
    const row = await seedOverride(auth, {
      organizationId,
      kind: "feature",
      key: "sso",
      status: "removed",
      endedAt: new Date(),
      createdBy: author.user.id,
      removedBy: author.user.id,
    });

    const hook = userDeleteHook(rt) as (user: { id: string }) => Promise<void>;
    await hook({ id: author.user.id });

    const { rows } = await sql<{
      createdBy: string | null;
      removedBy: string | null;
    }>`
      select "createdBy", "removedBy" from "entitlementOverride"
      where id = ${row.id}`.execute(db);
    expect(rows[0]).toEqual({ createdBy: null, removedBy: null });
  });
});

describe("organizationCleanup: false on PGlite (PRD #22)", () => {
  let harness: Harness;
  beforeAll(async () => {
    harness = await createSqlTestAuth({
      options: { organizationCleanup: false },
    });
  });
  afterAll(async () => {
    await harness?.close();
  });

  it("the foreign-key cascade still removes the rows", async () => {
    const { auth } = harness;
    const context = await getContext(auth);
    const plugin = context.options.plugins?.find(
      (p) => p.id === "entitlements",
    );
    // no cleanup hook installed: the rows go by the cascade alone
    expect(plugin?.hooks?.after).toEqual([]);
    const { organizationId, owner } = await seedOrg(auth);
    await seedRows(harness, organizationId);

    await auth.api.deleteOrganization({
      body: { organizationId },
      headers: owner.headers,
    });

    expect(await counts(harness, organizationId)).toEqual(NONE);
  });
});
