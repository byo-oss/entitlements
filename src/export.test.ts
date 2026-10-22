import { describe, expect, it } from "vitest";
import {
  type EntitlementsExportPage,
  EXPORT_PAGE_SIZE,
  type ExportEntitlementsDataOptions,
  exportEntitlementsData,
  MAX_EXPORT_PAGE_SIZE,
} from "./export";
import {
  type AnyTestAuth,
  expectNoOuterCalls,
  getContext,
  makeAuth,
  seedOrg,
  seedOverride,
  seedUsage,
  setSnapshot,
  signUpUser,
} from "./test-utils";

const SAME_TIME = new Date("2026-03-01T00:00:00.000Z");

/** Every page from the first to the last, with the options given. */
async function exportAll(
  auth: AnyTestAuth,
  options: Omit<ExportEntitlementsDataOptions, "cursor"> = {},
) {
  const pages: EntitlementsExportPage[] = [];
  let cursor: string | null = null;
  do {
    const page = await exportEntitlementsData(auth, { ...options, cursor });
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

/** The ids stored in a model (optionally for one organization), straight from the adapter. */
async function storedIds(
  auth: AnyTestAuth,
  model: string,
  organizationId?: string,
) {
  const { adapter } = await getContext(auth);
  const rows = await adapter.findMany<{ id: string }>({
    model,
    where: organizationId
      ? [{ field: "organizationId", value: organizationId }]
      : [],
    limit: 10_000,
  });
  return rows.map((row) => row.id).sort();
}

const ids = (rows: { id: string }[]) => rows.map((row) => row.id).sort();

/** Two organizations with a snapshot, overrides of every status and usage rows. */
async function seedExport(auth: AnyTestAuth) {
  const author = await signUpUser(auth, `author-${Date.now()}@staff.test`);
  const remover = await signUpUser(auth, `remover-${Date.now()}@staff.test`);
  const orgs = [await seedOrg(auth), await seedOrg(auth)];
  for (const { organizationId } of orgs) {
    await setSnapshot(auth, organizationId, {
      planKey: "pro",
      status: "active",
    });
    await seedOverride(auth, {
      organizationId,
      kind: "feature",
      key: "sso",
      createdBy: author.user.id,
    });
    await seedOverride(auth, {
      organizationId,
      kind: "limit",
      key: "members",
      value: 10,
      status: "removed",
      endedAt: new Date(),
      createdBy: author.user.id,
      removedBy: remover.user.id,
    });
    await seedOverride(auth, {
      organizationId,
      kind: "plan",
      key: "team",
      status: "expired",
      expiresAt: new Date(Date.now() - 1000),
      endedAt: new Date(),
      // an author that no longer exists
      createdBy: "user_gone",
    });
    await seedUsage(auth, { organizationId, key: "apiCalls", used: 4 });
    await seedUsage(auth, { organizationId, key: "uploads", used: 2 });
  }
  return { author, remover, orgs };
}

describe("exportEntitlementsData (PRD #23 export half, memory)", () => {
  it("returns every row exactly once across pages, one model per page, in model order", async () => {
    const auth = makeAuth();
    await seedExport(auth);
    for (const limit of [1, 2, 3, 100]) {
      const all = await exportAll(auth, { limit });
      expect(ids(all.snapshots)).toEqual(
        await storedIds(auth, "entitlementSnapshot"),
      );
      expect(ids(all.overrides)).toEqual(
        await storedIds(auth, "entitlementOverride"),
      );
      expect(ids(all.usage)).toEqual(await storedIds(auth, "entitlementUsage"));
      // no duplicates
      expect(new Set(ids(all.overrides)).size).toBe(all.overrides.length);
      const order: string[] = [];
      for (const page of all.pages) {
        const filled = (["snapshots", "overrides", "usage"] as const).filter(
          (list) => page[list].length > 0,
        );
        expect(filled.length).toBeLessThanOrEqual(1);
        const total =
          page.snapshots.length + page.overrides.length + page.usage.length;
        expect(total).toBeLessThanOrEqual(limit);
        if (filled[0] && order.at(-1) !== filled[0]) order.push(filled[0]);
      }
      expect(order).toEqual(["snapshots", "overrides", "usage"]);
      expect(all.pages.at(-1)?.nextCursor).toBeNull();
    }
  });

  it("filters on organizationId, and every row carries it", async () => {
    const auth = makeAuth();
    const { orgs } = await seedExport(auth);
    const organizationId = orgs[0]?.organizationId as string;
    const all = await exportAll(auth, { organizationId, limit: 2 });
    expect(ids(all.snapshots)).toEqual(
      await storedIds(auth, "entitlementSnapshot", organizationId),
    );
    expect(ids(all.overrides)).toEqual(
      await storedIds(auth, "entitlementOverride", organizationId),
    );
    expect(ids(all.usage)).toEqual(
      await storedIds(auth, "entitlementUsage", organizationId),
    );
    for (const row of [...all.snapshots, ...all.overrides, ...all.usage]) {
      expect(row.organizationId).toBe(organizationId);
    }
    expect(all.overrides).toHaveLength(3);
  });

  it("puts the author's and remover's email on overrides, null when unknown", async () => {
    const auth = makeAuth();
    const { author, remover } = await seedExport(auth);
    const { overrides } = await exportAll(auth);
    expect(new Set(overrides.map((row) => row.status))).toEqual(
      new Set(["active", "removed", "expired"]),
    );
    for (const row of overrides) {
      if (row.status === "active") {
        expect(row).toMatchObject({
          createdBy: author.user.id,
          createdByEmail: author.user.email,
          removedBy: null,
          removedByEmail: null,
        });
      } else if (row.status === "removed") {
        expect(row).toMatchObject({
          createdByEmail: author.user.email,
          removedBy: remover.user.id,
          removedByEmail: remover.user.email,
        });
      } else {
        expect(row).toMatchObject({
          createdBy: "user_gone",
          createdByEmail: null,
          removedByEmail: null,
        });
      }
    }
  });

  it("rows are plain JSON in the documented schema", async () => {
    const auth = makeAuth();
    await seedExport(auth);
    const { snapshots, overrides, usage } = await exportAll(auth);
    const snapshot = snapshots[0] as Record<string, unknown>;
    expect(Object.keys(snapshot).sort()).toEqual(
      [
        "id",
        "organizationId",
        "source",
        "planKey",
        "status",
        "periodStart",
        "periodEnd",
        "cancelAtPeriodEnd",
        "seats",
        "pastDueSince",
        "sourceRef",
        "version",
        "syncedAt",
        "nextSyncAt",
        "syncState",
        "syncClaimedAt",
        "syncAttempts",
        "syncError",
        "createdAt",
        "updatedAt",
      ].sort(),
    );
    expect(Object.keys(overrides[0] as object).sort()).toEqual(
      [
        "id",
        "organizationId",
        "status",
        "kind",
        "key",
        "value",
        "reason",
        "permanent",
        "expiresAt",
        "endedAt",
        "createdBy",
        "removedBy",
        "createdAt",
        "createdByEmail",
        "removedByEmail",
      ].sort(),
    );
    expect(Object.keys(usage[0] as object).sort()).toEqual(
      [
        "id",
        "bucket",
        "organizationId",
        "key",
        "periodStart",
        "periodEnd",
        "used",
        "refused",
        "createdAt",
        "updatedAt",
      ].sort(),
    );
    const roundTrip = JSON.parse(
      JSON.stringify({ snapshots, overrides, usage }),
    );
    expect(roundTrip.overrides).toHaveLength(overrides.length);
    expect(roundTrip.snapshots[0].createdAt).toBe(
      (snapshot.createdAt as Date).toISOString(),
    );
  });

  it("reads more than 90 distinct authors' emails on one page (chunked user read)", async () => {
    const auth = makeAuth();
    const { organizationId } = await seedOrg(auth);
    const emails = new Map<string, string>();
    for (let i = 0; i < 95; i++) {
      const user = await signUpUser(
        auth,
        `author${i}-${Date.now()}@staff.test`,
      );
      emails.set(user.user.id, user.user.email);
      await seedOverride(auth, {
        organizationId,
        kind: "feature",
        key: "sso",
        status: "removed",
        endedAt: new Date(),
        createdBy: user.user.id,
      });
    }
    const page = await exportEntitlementsData(auth, {
      organizationId,
      limit: 1000,
    });
    // no snapshot or usage: the first page is the overrides
    expect(page.overrides).toHaveLength(95);
    for (const row of page.overrides) {
      expect(row.createdByEmail).toBe(emails.get(row.createdBy as string));
    }
  });

  it("250 overrides with an identical createdAt page out with none skipped or repeated", async () => {
    const auth = makeAuth();
    const { organizationId } = await seedOrg(auth);
    for (let i = 0; i < 250; i++) {
      await seedOverride(auth, {
        organizationId,
        kind: "feature",
        key: "exports",
        status: "removed",
        endedAt: SAME_TIME,
        createdAt: SAME_TIME,
      });
    }
    const all = await exportAll(auth, { organizationId, limit: 7 });
    expect(all.overrides).toHaveLength(250);
    expect(ids(all.overrides)).toEqual(
      await storedIds(auth, "entitlementOverride", organizationId),
    );
  });

  it("uses a default page size of 100 and accepts up to 1000", async () => {
    const auth = makeAuth();
    const { organizationId } = await seedOrg(auth);
    for (let i = 0; i < EXPORT_PAGE_SIZE + 1; i++) {
      await seedOverride(auth, { organizationId, kind: "feature", key: "sso" });
    }
    const first = await exportEntitlementsData(auth, { organizationId });
    expect(first.overrides).toHaveLength(EXPORT_PAGE_SIZE);
    expect(first.nextCursor).not.toBeNull();
    const second = await exportEntitlementsData(auth, {
      organizationId,
      cursor: first.nextCursor,
    });
    expect(second.overrides).toHaveLength(1);
    const big = await exportEntitlementsData(auth, {
      organizationId,
      limit: MAX_EXPORT_PAGE_SIZE,
    });
    expect(big.overrides).toHaveLength(EXPORT_PAGE_SIZE + 1);
    expect(big.nextCursor).not.toBeNull();
    const rest = await exportEntitlementsData(auth, {
      organizationId,
      cursor: big.nextCursor,
    });
    expect(rest).toEqual({
      snapshots: [],
      overrides: [],
      usage: [],
      nextCursor: null,
    });
  });

  it("an empty database exports one empty page", async () => {
    const auth = makeAuth();
    expect(await exportEntitlementsData(auth)).toEqual({
      snapshots: [],
      overrides: [],
      usage: [],
      nextCursor: null,
    });
  });

  it("runs inside the caller's transaction (G17)", async () => {
    const auth = makeAuth();
    await seedExport(auth);
    const page = await expectNoOuterCalls(auth, () =>
      exportEntitlementsData(auth, { limit: 1000, cursor: null }),
    );
    expect(page.snapshots).toHaveLength(2);
    const overrides = await expectNoOuterCalls(auth, () =>
      exportEntitlementsData(auth, { limit: 1000, cursor: page.nextCursor }),
    );
    expect(overrides.overrides).toHaveLength(6);
    expect(overrides.overrides.some((row) => row.createdByEmail)).toBe(true);
  });

  it("rejects a malformed cursor, a limit outside 1–1000 and an empty organizationId", async () => {
    const auth = makeAuth();
    const encode = (value: unknown) =>
      btoa(JSON.stringify(value))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
    for (const cursor of [
      "",
      "not a cursor!",
      "abc",
      encode({ m: "users", o: 0 }),
      encode({ m: "overrides", o: -1 }),
      encode({ m: "overrides", o: 1.5 }),
      encode({ m: "overrides" }),
      encode(null),
    ]) {
      await expect(exportEntitlementsData(auth, { cursor })).rejects.toThrow(
        "[@byo-oss/entitlements] invalid export cursor",
      );
    }
    for (const limit of [0, -1, 1.5, MAX_EXPORT_PAGE_SIZE + 1, Number.NaN]) {
      await expect(exportEntitlementsData(auth, { limit })).rejects.toThrow(
        "[@byo-oss/entitlements] exportEntitlementsData: limit must be an integer from 1 to 1000",
      );
    }
    await expect(
      exportEntitlementsData(auth, { organizationId: "" }),
    ).rejects.toThrow(
      "[@byo-oss/entitlements] exportEntitlementsData: organizationId is empty",
    );
    // a well-formed cursor still works
    await expect(
      exportEntitlementsData(auth, { cursor: encode({ m: "usage", o: 0 }) }),
    ).resolves.toMatchObject({ nextCursor: null });
  });

  it("throws without the plugin", async () => {
    const bare = { $context: Promise.resolve({ options: { plugins: [] } }) };
    await expect(exportEntitlementsData(bare)).rejects.toThrow(
      "[@byo-oss/entitlements] exportEntitlementsData needs the entitlements plugin installed on this auth instance",
    );
  });
});
