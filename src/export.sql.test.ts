import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type EntitlementsExportPage,
  type ExportEntitlementsDataOptions,
  exportEntitlementsData,
} from "./export";
import { createSqlTestAuth } from "./test-sql";
import {
  expectNoOuterCalls,
  seedOrg,
  seedOverride,
  seedUsage,
  setSnapshot,
  signUpUser,
} from "./test-utils";

type Harness = Awaited<ReturnType<typeof createSqlTestAuth>>;

const SAME_TIME = new Date("2026-03-01T00:00:00.000Z");

async function exportAll(
  harness: Harness,
  options: Omit<ExportEntitlementsDataOptions, "cursor"> = {},
) {
  const pages: EntitlementsExportPage[] = [];
  let cursor: string | null = null;
  do {
    const page = await exportEntitlementsData(harness.auth, {
      ...options,
      cursor,
    });
    pages.push(page);
    cursor = page.nextCursor;
    if (pages.length > 10_000) throw new Error("export never ended");
  } while (cursor);
  return {
    pages,
    snapshots: pages.flatMap((page) => page.snapshots),
    overrides: pages.flatMap((page) => page.overrides),
    usage: pages.flatMap((page) => page.usage),
  };
}

/** The ids in a table (optionally for one organization), in raw SQL. */
async function storedIds(
  harness: Harness,
  table: string,
  organizationId?: string,
) {
  const query = organizationId
    ? sql<{
        id: string;
      }>`select id from ${sql.table(table)} where "organizationId" = ${organizationId}`
    : sql<{ id: string }>`select id from ${sql.table(table)}`;
  const { rows } = await query.execute(harness.db);
  return rows.map((row) => row.id).sort();
}

const ids = (rows: { id: string }[]) => rows.map((row) => row.id).sort();

describe("exportEntitlementsData on PGlite (PRD #23 export half)", () => {
  let harness: Harness;
  let organizationId: string;
  let otherOrganizationId: string;
  let author: Awaited<ReturnType<typeof signUpUser>>;
  let remover: Awaited<ReturnType<typeof signUpUser>>;

  beforeAll(async () => {
    harness = await createSqlTestAuth();
    const { auth } = harness;
    author = await signUpUser(auth, "sql-export-author@staff.test");
    remover = await signUpUser(auth, "sql-export-remover@staff.test");
    organizationId = (await seedOrg(auth)).organizationId;
    otherOrganizationId = (await seedOrg(auth)).organizationId;
    for (const orgId of [organizationId, otherOrganizationId]) {
      await setSnapshot(auth, orgId, { planKey: "pro", status: "active" });
      await seedUsage(auth, {
        organizationId: orgId,
        key: "apiCalls",
        used: 4,
      });
      await seedUsage(auth, { organizationId: orgId, key: "uploads", used: 1 });
      await seedOverride(auth, {
        organizationId: orgId,
        kind: "feature",
        key: "sso",
        createdBy: author.user.id,
      });
    }
    // 250 overrides sharing one createdAt, of every status
    const statuses = ["active", "removed", "expired"] as const;
    for (let i = 0; i < 250; i++) {
      const status = statuses[i % 3] as (typeof statuses)[number];
      await seedOverride(auth, {
        organizationId,
        kind: "limit",
        key: "members",
        value: i,
        status,
        createdAt: SAME_TIME,
        endedAt: status === "active" ? null : SAME_TIME,
        createdBy: author.user.id,
        removedBy: status === "removed" ? remover.user.id : null,
      });
    }
  });
  afterAll(async () => {
    await harness?.close();
  });

  it("250 rows with an identical createdAt page out with no row skipped or repeated", async () => {
    for (const limit of [7, 100, 249, 250]) {
      const all = await exportAll(harness, { organizationId, limit });
      expect(all.overrides).toHaveLength(251);
      expect(new Set(ids(all.overrides)).size).toBe(251);
      expect(ids(all.overrides)).toEqual(
        await storedIds(harness, "entitlementOverride", organizationId),
      );
    }
  });

  it("every row of every model exactly once across pages", async () => {
    const all = await exportAll(harness, { limit: 13 });
    expect(ids(all.snapshots)).toEqual(
      await storedIds(harness, "entitlementSnapshot"),
    );
    expect(ids(all.overrides)).toEqual(
      await storedIds(harness, "entitlementOverride"),
    );
    expect(ids(all.usage)).toEqual(
      await storedIds(harness, "entitlementUsage"),
    );
    expect(all.overrides).toHaveLength(252);
    for (const page of all.pages) {
      const filled = [page.snapshots, page.overrides, page.usage].filter(
        (list) => list.length > 0,
      );
      expect(filled.length).toBeLessThanOrEqual(1);
    }
  });

  it("filters on organizationId", async () => {
    const all = await exportAll(harness, {
      organizationId: otherOrganizationId,
      limit: 1,
    });
    expect(all.snapshots).toHaveLength(1);
    expect(all.overrides).toHaveLength(1);
    expect(all.usage).toHaveLength(2);
    for (const row of [...all.snapshots, ...all.overrides, ...all.usage]) {
      expect(row.organizationId).toBe(otherOrganizationId);
    }
  });

  it("carries the author's and remover's email on overrides", async () => {
    const { overrides } = await exportAll(harness, {
      organizationId,
      limit: 1000,
    });
    for (const row of overrides) {
      expect(row.createdByEmail).toBe(author.user.email);
      expect(row.removedByEmail).toBe(
        row.status === "removed" ? remover.user.email : null,
      );
    }
    expect(overrides.some((row) => row.status === "expired")).toBe(true);
  });

  it("runs inside the caller's transaction (G17)", async () => {
    const { auth } = harness;
    const first = await expectNoOuterCalls(auth, () =>
      exportEntitlementsData(auth, { organizationId, limit: 1000 }),
    );
    expect(first.snapshots).toHaveLength(1);
    const second = await expectNoOuterCalls(auth, () =>
      exportEntitlementsData(auth, {
        organizationId,
        limit: 1000,
        cursor: first.nextCursor,
      }),
    );
    expect(second.overrides).toHaveLength(251);
    expect(second.overrides[0]?.createdByEmail).toBe(author.user.email);
  });
});
