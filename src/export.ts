import type { DBTransactionAdapter, Where } from "better-auth";
import { findManyIn } from "./adapter";
import { type AuthWithContext, runtimeFromAuth } from "./runtime";
import type {
  EntitlementOverrideRow,
  EntitlementSnapshotRow,
  EntitlementUsageRow,
} from "./schema";
import { currentAdapter } from "./txn";

const PREFIX = "[@byo-oss/entitlements]";

/** Rows per model per page, by default and at most. */
export const EXPORT_PAGE_SIZE = 100;
export const MAX_EXPORT_PAGE_SIZE = 1000;

export type ExportEntitlementsDataOptions = {
  /** Only this organization's rows. */
  organizationId?: string;
  /** `nextCursor` of the previous page. */
  cursor?: string | null;
  /** Rows per page (1–1000). @default 100 */
  limit?: number;
};

export type ExportedSnapshot = EntitlementSnapshotRow;
/** An override row plus its author's and remover's email (null when unknown or deleted). */
export type ExportedOverride = EntitlementOverrideRow & {
  createdByEmail: string | null;
  removedByEmail: string | null;
};
export type ExportedUsage = EntitlementUsageRow;

/**
 * One page of the export. Models are paged one after another (snapshots,
 * then overrides, then usage), each with offset paging over
 * `sortBy: { field: "id", direction: "asc" }`; a page holds rows of one
 * model and the other lists are empty. `nextCursor` is null after the last
 * page.
 */
export type EntitlementsExportPage = {
  snapshots: ExportedSnapshot[];
  overrides: ExportedOverride[];
  usage: ExportedUsage[];
  nextCursor: string | null;
};

/** The exported models, in export order, keyed by their page list. */
const EXPORT_MODELS = [
  { list: "snapshots", model: "entitlementSnapshot" },
  { list: "overrides", model: "entitlementOverride" },
  { list: "usage", model: "entitlementUsage" },
] as const;

type ExportList = (typeof EXPORT_MODELS)[number]["list"];

/** Where the next page starts: a model (by list name) and an offset into it. */
type ExportCursor = { m: ExportList; o: number };

const ENCODED_CURSOR = /^[A-Za-z0-9_-]+$/;

function encodeCursor(cursor: ExportCursor): string {
  // the JSON is ASCII (a list name and digits), so btoa takes it as is
  return btoa(JSON.stringify(cursor))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function invalidCursor(): Error {
  return new Error(`${PREFIX} invalid export cursor`);
}

function decodeCursor(value: unknown): ExportCursor {
  if (typeof value !== "string" || !ENCODED_CURSOR.test(value)) {
    throw invalidCursor();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(atob(value.replace(/-/g, "+").replace(/_/g, "/")));
  } catch {
    throw invalidCursor();
  }
  const { m, o } = (parsed ?? {}) as { m?: unknown; o?: unknown };
  if (
    !EXPORT_MODELS.some((entry) => entry.list === m) ||
    typeof o !== "number" ||
    !Number.isSafeInteger(o) ||
    o < 0
  ) {
    throw invalidCursor();
  }
  return { m: m as ExportList, o };
}

/** Adds the author's and remover's email to override rows (one tagged `user` read). */
async function withEmails(
  adapter: DBTransactionAdapter,
  rows: EntitlementOverrideRow[],
): Promise<ExportedOverride[]> {
  const userIds = new Set<string>();
  for (const row of rows) {
    if (row.createdBy) userIds.add(row.createdBy);
    if (row.removedBy) userIds.add(row.removedBy);
  }
  const users = await findManyIn<{ id: string; email: string }>(adapter, {
    model: "user",
    field: "id",
    values: [...userIds],
    select: ["id", "email"],
  });
  const emails = new Map(users.map((user) => [user.id, user.email]));
  const emailOf = (id: string | null) => (id ? (emails.get(id) ?? null) : null);
  return rows.map((row) => ({
    ...row,
    createdByEmail: emailOf(row.createdBy),
    removedByEmail: emailOf(row.removedBy),
  }));
}

/**
 * Exports snapshots, overrides (every status) and usage rows as plain JSON
 * in the documented schema, page by page (an opaque offset cursor). Every
 * row carries `organizationId`; overrides also carry `createdByEmail` and
 * `removedByEmail`. Pass `organizationId` for one organization's rows, and
 * each page's `nextCursor` back as `cursor` until it is null.
 *
 * Offsets run over `id` order, so a row deleted mid-export shifts later
 * rows back and one of them can be missed; export from a quiet database or
 * keep one copy of each `id` and re-run. The catalog isn't exported: it is
 * your own code.
 *
 * Throws `[@byo-oss/entitlements] invalid export cursor` for a malformed
 * cursor, and a `[@byo-oss/entitlements] exportEntitlementsData: …` error
 * for a `limit` outside 1–1000 or an empty `organizationId`.
 */
export async function exportEntitlementsData(
  auth: AuthWithContext,
  options: ExportEntitlementsDataOptions = {},
): Promise<EntitlementsExportPage> {
  const rt = await runtimeFromAuth(auth, "exportEntitlementsData");
  const limit = options.limit ?? EXPORT_PAGE_SIZE;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_EXPORT_PAGE_SIZE) {
    throw new Error(
      `${PREFIX} exportEntitlementsData: limit must be an integer from 1 to ${MAX_EXPORT_PAGE_SIZE}`,
    );
  }
  const where: Where[] = [];
  // an empty organizationId must not fall through to "every organization"
  if (options.organizationId !== undefined) {
    if (
      typeof options.organizationId !== "string" ||
      options.organizationId === ""
    ) {
      throw new Error(
        `${PREFIX} exportEntitlementsData: organizationId is empty`,
      );
    }
    where.push({ field: "organizationId", value: options.organizationId });
  }
  const start: ExportCursor =
    options.cursor == null
      ? { m: "snapshots", o: 0 }
      : decodeCursor(options.cursor);
  const adapter = await currentAdapter(rt);
  const page: EntitlementsExportPage = {
    snapshots: [],
    overrides: [],
    usage: [],
    nextCursor: null,
  };
  let index = EXPORT_MODELS.findIndex((entry) => entry.list === start.m);
  let offset = start.o;
  for (; index < EXPORT_MODELS.length; index++, offset = 0) {
    const { list, model } = EXPORT_MODELS[
      index
    ] as (typeof EXPORT_MODELS)[number];
    // one row past the page tells whether this model has more
    const rows = await adapter.findMany<Record<string, unknown>>({
      model,
      where,
      limit: limit + 1,
      offset,
      sortBy: { field: "id", direction: "asc" },
    });
    // nothing left in this model (or it is empty): go on to the next one
    if (rows.length === 0) continue;
    const pageRows = rows.slice(0, limit);
    if (list === "overrides") {
      page.overrides = await withEmails(
        adapter,
        pageRows as EntitlementOverrideRow[],
      );
    } else if (list === "snapshots") {
      page.snapshots = pageRows.map((row) => ({
        ...row,
      })) as ExportedSnapshot[];
    } else {
      page.usage = pageRows.map((row) => ({ ...row })) as ExportedUsage[];
    }
    const next = EXPORT_MODELS[index + 1];
    page.nextCursor =
      rows.length > limit
        ? encodeCursor({ m: list, o: offset + limit })
        : next
          ? encodeCursor({ m: next.list, o: 0 })
          : null;
    return page;
  }
  return page;
}
