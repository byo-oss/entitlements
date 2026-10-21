// BYO_STUB: N08 replaces this file (contracts.md "export.ts")
import type { AuthWithContext } from "./runtime";
import type {
  EntitlementOverrideRow,
  EntitlementSnapshotRow,
  EntitlementUsageRow,
} from "./schema";

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

/**
 * Exports snapshots, overrides (every status) and usage rows as plain JSON
 * in the documented schema, page by page (an opaque offset cursor). A row
 * deleted mid-export shifts later rows back a page (documented). A
 * malformed cursor throws `[@byo-oss/entitlements] invalid export cursor`.
 * Stub: one empty page.
 */
export async function exportEntitlementsData(
  _auth: AuthWithContext,
  _options: ExportEntitlementsDataOptions = {},
): Promise<EntitlementsExportPage> {
  return { snapshots: [], overrides: [], usage: [], nextCursor: null };
}
