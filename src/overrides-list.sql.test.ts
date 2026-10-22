import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ENTITLEMENTS_ERROR_CODES } from "./error-codes";
import { encodeListCursor } from "./routes/overrides";
import { createSqlTestAuth, type SqlTestAuth } from "./test-sql";
import { seedOrg, seedOverride, seedStaff, type TestUser } from "./test-utils";
import type { EntitlementOverride } from "./types";

// PRD #23, the list half, on PGlite + Kysely: keyset paging newest first,
// with ties on `createdAt` ordered by id in code

const KEYS = ["exports", "sso", "prioritySupport"] as const;
const T0 = new Date("2026-01-15T12:00:00.000Z");

let close: () => Promise<void>;
let auth: SqlTestAuth;
let reader: TestUser;
let noRead: TestUser;

beforeAll(async () => {
  const sql = await createSqlTestAuth({
    options: { staffOrganizationId: "org_staff" },
  });
  close = sql.close;
  auth = sql.auth;
  const { staff } = await seedStaff(auth, "org_staff");
  reader = staff.member;
  noRead = staff.overrideOnly;
}, 30_000);

afterAll(async () => {
  await close?.();
});

/** `count` override rows of one org, all with `createdAt` = `at`. */
async function seedTied(organizationId: string, count: number, at: Date) {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const row = await seedOverride(auth, {
      organizationId,
      kind: "feature",
      key: KEYS[i % KEYS.length] as string,
      status: "removed",
      endedAt: at,
      createdAt: at,
    });
    ids.push(row.id);
  }
  return ids;
}

async function list(
  as: TestUser,
  query: {
    organizationId?: string;
    status?: "active" | "removed" | "expired";
    cursor?: string;
  },
) {
  return (await auth.api.listEntitlementOverrides({
    headers: as.headers,
    query,
  })) as { overrides: EntitlementOverride[]; nextCursor: string | null };
}

/** Every page of a query, in order. */
async function pageAll(query: { organizationId?: string }) {
  const pages: EntitlementOverride[][] = [];
  let cursor: string | undefined;
  for (let guard = 0; guard < 100; guard++) {
    const page = await list(reader, { ...query, cursor });
    pages.push(page.overrides);
    if (!page.nextCursor) return pages;
    cursor = page.nextCursor;
  }
  throw new Error("paging didn't end");
}

const time = (value: Date | string) => new Date(value).getTime();

/** `count` rows of one org, one per timestamp, `stepMs` apart from `from`. */
async function seedSpread(
  organizationId: string,
  count: number,
  from: Date,
  stepMs: number,
) {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const at = new Date(from.getTime() + i * stepMs);
    ids.push(...(await seedTied(organizationId, 1, at)));
  }
  return ids;
}

/**
 * Every expected row came back exactly once, newest first, on non-empty
 * pages of at most 50.
 */
function expectEachOnce(pages: EntitlementOverride[][], expected: string[]) {
  for (const page of pages) {
    expect(page.length).toBeGreaterThan(0);
    expect(page.length).toBeLessThanOrEqual(50);
  }
  const rows = pages.flat();
  const ids = rows.map((o) => o.id);
  expect(new Set(ids).size).toBe(ids.length);
  expect([...ids].sort()).toEqual([...expected].sort());
  for (let i = 1; i < rows.length; i++) {
    expect(
      time((rows[i - 1] as EntitlementOverride).createdAt),
    ).toBeGreaterThanOrEqual(time((rows[i] as EntitlementOverride).createdAt));
  }
}

describe("listEntitlementOverrides paging (SQL)", () => {
  it("250 overrides with identical createdAt page out with no row skipped or repeated", async () => {
    const { organizationId } = await seedOrg(auth);
    const other = await seedOrg(auth);
    const ids = await seedTied(organizationId, 250, T0);
    // another org's rows, same timestamp: filtered out
    await seedTied(other.organizationId, 3, T0);

    const pages = await pageAll({ organizationId });
    expect(pages.map((p) => p.length)).toEqual([50, 50, 50, 50, 50]);
    const seen = pages.flat().map((o) => o.id);
    expect(new Set(seen).size).toBe(250);
    expect([...seen].sort()).toEqual([...ids].sort());
    expect(pages.flat().every((o) => o.organizationId === organizationId)).toBe(
      true,
    );
  });

  it("250 tied rows followed by older rows: every row exactly once, the older ones included", async () => {
    const { organizationId } = await seedOrg(auth);
    const tied = await seedTied(organizationId, 250, T0);
    // older rows: a run of single timestamps and a small tied group
    const older = [
      ...(await seedSpread(
        organizationId,
        15,
        new Date(T0.getTime() - 3_600_000),
        60_000,
      )),
      ...(await seedTied(
        organizationId,
        7,
        new Date(T0.getTime() - 7_200_000),
      )),
    ];
    const pages = await pageAll({ organizationId });
    expectEachOnce(pages, [...tied, ...older]);
    expect(pages.slice(0, 5).map((p) => p.length)).toEqual([
      50, 50, 50, 50, 50,
    ]);
    expect(
      pages
        .slice(0, 5)
        .flat()
        .map((o) => o.id)
        .sort(),
    ).toEqual([...tied].sort());
  });

  it("a tied group that starts partway through a page: every row exactly once, no 400", async () => {
    const { organizationId } = await seedOrg(auth);
    const newer = await seedSpread(
      organizationId,
      30,
      new Date(T0.getTime() + 60_000),
      60_000,
    );
    const tied = await seedTied(organizationId, 250, T0);
    const older = await seedSpread(
      organizationId,
      20,
      new Date(T0.getTime() - 3_600_000),
      60_000,
    );
    const pages = await pageAll({ organizationId });
    expectEachOnce(pages, [...newer, ...tied, ...older]);
    // the first page stops before the tied group, which then starts a page
    expect(pages[0]?.map((o) => o.id).sort()).toEqual([...newer].sort());
  });

  it("orders newest first across mixed timestamps and small tie groups, with filters", async () => {
    const { organizationId } = await seedOrg(auth);
    const expected: string[] = [];
    // 12 timestamps, 1 to 9 rows each, newest last so insert order differs
    for (let step = 0; step < 12; step++) {
      const at = new Date(T0.getTime() + step * 60_000);
      const count = 1 + ((step * 5) % 9);
      expected.push(...(await seedTied(organizationId, count, at)));
    }
    const active = await seedOverride(auth, {
      organizationId,
      kind: "limit",
      key: "projects",
      value: 4,
      createdAt: new Date(T0.getTime() - 60_000),
    });

    const pages = await pageAll({ organizationId });
    const rows = pages.flat();
    expect(rows).toHaveLength(expected.length + 1);
    expect(new Set(rows.map((o) => o.id)).size).toBe(rows.length);
    for (let i = 1; i < rows.length; i++) {
      const prev = rows[i - 1] as EntitlementOverride;
      const row = rows[i] as EntitlementOverride;
      expect(time(prev.createdAt)).toBeGreaterThanOrEqual(time(row.createdAt));
    }
    // within a page, ties are ordered by id (across a page edge the database
    // picks which tied rows come first; the cursor's ids keep them unique)
    for (const page of pages) {
      for (let i = 1; i < page.length; i++) {
        const prev = page[i - 1] as EntitlementOverride;
        const row = page[i] as EntitlementOverride;
        if (time(prev.createdAt) === time(row.createdAt)) {
          expect(prev.id < row.id).toBe(true);
        }
      }
    }
    // the oldest row is the active one; the status filter finds only it
    expect(rows.at(-1)?.id).toBe(active.id);
    const onlyActive = await list(reader, { organizationId, status: "active" });
    expect(onlyActive).toMatchObject({
      overrides: [{ id: active.id, value: 4, status: "active" }],
      nextCursor: null,
    });
  });

  it("past the tie bound (251 identical createdAt) the next page answers 400 INVALID_CURSOR", async () => {
    const { organizationId } = await seedOrg(auth);
    await seedTied(organizationId, 251, T0);
    let cursor: string | undefined;
    const returned: string[] = [];
    for (let page = 0; page < 5; page++) {
      const reply = await list(reader, { organizationId, cursor });
      returned.push(...reply.overrides.map((o) => o.id));
      expect(reply.nextCursor).not.toBeNull();
      cursor = reply.nextCursor as string;
    }
    expect(new Set(returned).size).toBe(250);
    await expect(
      list(reader, { organizationId, cursor }),
    ).rejects.toMatchObject({
      status: "BAD_REQUEST",
      body: { code: ENTITLEMENTS_ERROR_CODES.INVALID_CURSOR.code },
    });
  });

  it("without filters, the first page lists every org's overrides newest first", async () => {
    const { organizationId } = await seedOrg(auth);
    const newest = await seedOverride(auth, {
      organizationId,
      kind: "feature",
      key: "sso",
      createdAt: new Date(T0.getTime() + 86_400_000),
    });
    const page = await list(reader, {});
    expect(page.overrides.length).toBeGreaterThan(1);
    expect(page.overrides.length).toBeLessThanOrEqual(50);
    expect(page.overrides[0]?.id).toBe(newest.id);
    expect(page.nextCursor).not.toBeNull();
    const orgs = new Set(page.overrides.map((o) => o.organizationId));
    expect(orgs.size).toBeGreaterThan(1);
  });

  it("a malformed cursor → 400 INVALID_CURSOR; read in the staff org is required", async () => {
    const bad = [
      "not a cursor",
      "e30", // {}
      encodeListCursor({ at: "yesterday", ids: ["a"] }),
      encodeListCursor({
        at: T0.toISOString(),
        ids: Array.from({ length: 201 }, (_, i) => `id${i}`),
      }),
      Buffer.from(JSON.stringify({ at: T0.toISOString(), ids: [1] })).toString(
        "base64url",
      ),
    ];
    for (const cursor of bad) {
      await expect(list(reader, { cursor })).rejects.toMatchObject({
        status: "BAD_REQUEST",
        body: { code: ENTITLEMENTS_ERROR_CODES.INVALID_CURSOR.code },
      });
    }
    // well-formed cursors: empty ids (the amendment), and the 200-id cap
    expect(
      (
        await list(reader, {
          cursor: encodeListCursor({ at: T0.toISOString(), ids: [] }),
        })
      ).overrides,
    ).toBeDefined();
    const atCap = encodeListCursor({
      at: T0.toISOString(),
      ids: Array.from({ length: 200 }, (_, i) => `id${i}`),
    });
    expect((await list(reader, { cursor: atCap })).overrides).toBeDefined();
    await expect(list(noRead, {})).rejects.toMatchObject({
      status: "NOT_FOUND",
      body: { code: ENTITLEMENTS_ERROR_CODES.ORGANIZATION_NOT_FOUND.code },
    });
  });
});
