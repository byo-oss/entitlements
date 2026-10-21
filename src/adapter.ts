import type { DBTransactionAdapter, Where } from "better-auth";

// Cloudflare D1 binds at most 100 parameters per query, so `in` lists are
// split into chunks that leave room for the rest of the where clause (§2.7)
export const IN_CHUNK = 90;

/** Page size of `findManyIn` and `findAll` (`findMany` returns 100 rows unless given a limit). */
export const FIND_PAGE = 1000;

// ---------------------------------------------------------------------------
// Query tagging, for the strict test wrapper
// ---------------------------------------------------------------------------

const taggedQueries = new WeakSet<object>();

/**
 * Marks a query object as issued by entitlements. The strict adapter wrapper
 * in `test-utils.ts` checks every `entitlement*` model call and, for other
 * models (`organization`, `member`, `user`, `subscription`), only queries
 * marked here, so better-auth's and other plugins' own queries pass
 * untouched. Costs nothing in production.
 */
export function markEntitlementsQuery<T extends object>(query: T): T {
  taggedQueries.add(query);
  return query;
}

/** Whether `markEntitlementsQuery` marked this query object. */
export function isEntitlementsQuery(query: unknown): boolean {
  return (
    typeof query === "object" && query !== null && taggedQueries.has(query)
  );
}

// ---------------------------------------------------------------------------
// Chunking and paging (§2.7)
// ---------------------------------------------------------------------------

/** Splits `values` into chunks of `size`. An empty list gives no chunks, so no query runs. */
export function chunk<T>(values: readonly T[], size = IN_CHUNK): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < values.length; i += size) {
    chunks.push(values.slice(i, i + size));
  }
  return chunks;
}

/**
 * Every row whose `field` is one of `values`, however many values or
 * matching rows there are: deduped values, chunks of 90, each chunk paged at
 * 1000 sorted by id until exhausted. No query runs for an empty `values`.
 * `where` is AND-ed with the `in` clause, so it must not use `OR`.
 */
export async function findManyIn<T>(
  adapter: DBTransactionAdapter,
  {
    model,
    field,
    values,
    where = [],
    select,
  }: {
    model: string;
    field: string;
    values: readonly string[];
    where?: Where[];
    select?: string[];
  },
): Promise<T[]> {
  const rows: T[] = [];
  for (const part of chunk([...new Set(values)])) {
    for (let offset = 0; ; offset += FIND_PAGE) {
      const page = await adapter.findMany<T>(
        markEntitlementsQuery({
          model,
          where: [...where, { field, operator: "in" as const, value: part }],
          limit: FIND_PAGE,
          offset,
          sortBy: { field: "id", direction: "asc" as const },
          ...(select ? { select } : {}),
        }),
      );
      rows.push(...page);
      if (page.length < FIND_PAGE) break;
    }
  }
  return rows;
}

/**
 * Every row matching `where`, paged at 1000 sorted by id, stopping after
 * `max` rows. For reads that must be whole but are bounded.
 */
export async function findAll<T>(
  adapter: DBTransactionAdapter,
  {
    model,
    where,
    select,
    max,
  }: { model: string; where: Where[]; select?: string[]; max: number },
): Promise<T[]> {
  const rows: T[] = [];
  for (let offset = 0; rows.length < max; offset += FIND_PAGE) {
    const limit = Math.min(FIND_PAGE, max - rows.length);
    const page = await adapter.findMany<T>(
      markEntitlementsQuery({
        model,
        where,
        limit,
        offset,
        sortBy: { field: "id", direction: "asc" as const },
        ...(select ? { select } : {}),
      }),
    );
    rows.push(...page);
    if (page.length < limit) break;
  }
  return rows;
}

// ---------------------------------------------------------------------------
// organization / member reads (tagged, so the strict wrapper checks them)
// ---------------------------------------------------------------------------

export type MemberRow = {
  id: string;
  userId: string;
  organizationId: string;
  role: string;
  createdAt: Date;
};

export type OrganizationRow = {
  id: string;
  name: string;
  slug: string;
  createdAt: Date;
};

/** The `member` row of `userId` in `organizationId`, or null. */
export function findMember(
  adapter: DBTransactionAdapter,
  { userId, organizationId }: { userId: string; organizationId: string },
): Promise<MemberRow | null> {
  return adapter.findOne<MemberRow>(
    markEntitlementsQuery({
      model: "member",
      where: [
        { field: "userId", value: userId },
        { field: "organizationId", value: organizationId },
      ],
    }),
  );
}

/** The `organization` row, or null. */
export function findOrganization(
  adapter: DBTransactionAdapter,
  organizationId: string,
): Promise<OrganizationRow | null> {
  return adapter.findOne<OrganizationRow>(
    markEntitlementsQuery({
      model: "organization",
      where: [{ field: "id", value: organizationId }],
    }),
  );
}
