import { kyselyAdapter } from "@better-auth/kysely-adapter";
import { PGlite } from "@electric-sql/pglite";
import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { Kysely, sql } from "kysely";
import { KyselyPGlite } from "kysely-pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSqlTestAuth } from "./test-sql";
import {
  mergeAuthOptions,
  seedOrg,
  seedOverride,
  seedUsage,
  setSnapshot,
  signIn,
  testOrganization,
} from "./test-utils";

/**
 * The documented uninstall: drop these tables, in this order (README
 * "Uninstall" lists the same three, in the same order). None references
 * another, so plain `drop table` (RESTRICT) works in any order.
 */
const DROP_ORDER = [
  "entitlementUsage",
  "entitlementOverride",
  "entitlementSnapshot",
] as const;

// biome-ignore lint/suspicious/noExplicitAny: tables come from the migration
type AnyDb = Kysely<any>;

/** Every public table with its columns (name, type, nullability), sorted. */
async function describeSchema(db: AnyDb) {
  const { rows } = await sql<{
    table_name: string;
    column_name: string;
    data_type: string;
    is_nullable: string;
  }>`
    select table_name, column_name, data_type, is_nullable
    from information_schema.columns
    where table_schema = 'public'
    order by table_name, column_name`.execute(db);
  const tables: Record<string, string[]> = {};
  for (const row of rows) {
    tables[row.table_name] ??= [];
    tables[row.table_name]?.push(
      `${row.column_name}:${row.data_type}:${row.is_nullable}`,
    );
  }
  return tables;
}

/** Row counts of the given tables. */
async function rowCounts(db: AnyDb, tables: string[]) {
  const out: Record<string, number> = {};
  for (const table of tables) {
    const { rows } = await sql<{ n: number }>`
      select count(*)::int as n from ${sql.table(table)}`.execute(db);
    out[table] = rows[0]?.n ?? -1;
  }
  return out;
}

describe("uninstall on PGlite (PRD #24)", () => {
  let harness: Awaited<ReturnType<typeof createSqlTestAuth>>;
  /** The schema better-auth and the organization plugin create without entitlements. */
  let baseline: Record<string, string[]>;
  let baselineDb: AnyDb;

  beforeAll(async () => {
    harness = await createSqlTestAuth();
    baselineDb = new Kysely({
      dialect: new KyselyPGlite(new PGlite()).dialect,
    });
    const { runMigrations } = await getMigrations({
      ...mergeAuthOptions(),
      plugins: [testOrganization()],
      database: { db: baselineDb, type: "postgres" },
    });
    await runMigrations();
    baseline = await describeSchema(baselineDb);
  });
  afterAll(async () => {
    await harness?.close();
    await baselineDb?.destroy();
  });

  it("drops the three tables in the documented order and leaves better-auth's tables unchanged", async () => {
    const { auth, db } = harness;
    const { organizationId, owner } = await seedOrg(auth);
    await setSnapshot(auth, organizationId, {
      planKey: "pro",
      status: "active",
    });
    await seedOverride(auth, {
      organizationId,
      kind: "feature",
      key: "sso",
      createdBy: owner.user.id,
    });
    await seedUsage(auth, { organizationId, key: "apiCalls", used: 2 });

    const before = await describeSchema(db);
    // the drop list is exactly the plugin's tables
    const added = Object.keys(before)
      .filter((table) => !(table in baseline))
      .sort();
    expect(added).toEqual([...DROP_ORDER].sort());
    // the plugin adds no columns to better-auth's tables
    for (const [table, columns] of Object.entries(baseline)) {
      expect(before[table], table).toEqual(columns);
    }
    const authTables = Object.keys(baseline).sort();
    const countsBefore = await rowCounts(db, authTables);
    expect(countsBefore.organization).toBeGreaterThan(0);

    for (const table of DROP_ORDER) {
      await sql`drop table ${sql.table(table)}`.execute(db);
    }

    const after = await describeSchema(db);
    expect(after).toEqual(baseline);
    expect(await rowCounts(db, authTables)).toEqual(countsBefore);

    // the app keeps working without the plugin on the same database
    const app = betterAuth({
      ...mergeAuthOptions(),
      plugins: [testOrganization()],
      database: kyselyAdapter(db, { type: "postgres" }),
    });
    const headers = await signIn(app, owner.user.email);
    const organizations = await app.api.listOrganizations({ headers });
    expect(organizations.map((org: { id: string }) => org.id)).toContain(
      organizationId,
    );
  });
});
