import { kyselyAdapter } from "@better-auth/kysely-adapter";
import { stripe } from "@better-auth/stripe";
import { PGlite } from "@electric-sql/pglite";
import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { Kysely, sql } from "kysely";
import { KyselyPGlite } from "kysely-pglite";
import type Stripe from "stripe";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSqlTestAuth } from "./test-sql";
import {
  getContext,
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

/** `@better-auth/stripe` with org subscriptions and a client that is never called. */
function testStripe() {
  const fake = {
    webhooks: {},
    subscriptions: {},
  } as unknown as Stripe;
  return stripe({
    stripeClient: fake,
    stripeWebhookSecret: "test_secret",
    subscription: { enabled: true, plans: [] },
    organization: { enabled: true },
  });
}

/** The tables and columns `@better-auth/stripe` owns (org subscriptions on). */
const STRIPE_TABLE = "subscription";
const STRIPE_COLUMN_TABLES = ["user", "organization"] as const;

/** The SQL harness with `@better-auth/stripe` next to organization and entitlements. */
const createStripeSqlAuth = () =>
  createSqlTestAuth({
    plugins: [testStripe()],
    authOptions: { logger: { disabled: true } },
  });

describe("uninstall on PGlite with @better-auth/stripe (PRD #24)", () => {
  let harness: Awaited<ReturnType<typeof createStripeSqlAuth>>;
  /** The schema better-auth, organization and stripe create without entitlements. */
  let baseline: Record<string, string[]>;
  let baselineDb: AnyDb;

  beforeAll(async () => {
    harness = await createStripeSqlAuth();
    baselineDb = new Kysely({
      dialect: new KyselyPGlite(new PGlite()).dialect,
    });
    const { runMigrations } = await getMigrations({
      ...mergeAuthOptions(),
      plugins: [testOrganization(), testStripe()],
      database: { db: baselineDb, type: "postgres" },
    });
    await runMigrations();
    baseline = await describeSchema(baselineDb);
  });
  afterAll(async () => {
    await harness?.close();
    await baselineDb?.destroy();
  });

  it("leaves the subscription table and the Stripe columns on user and organization unchanged", async () => {
    const { auth, db } = harness;
    const { organizationId, owner } = await seedOrg(auth);
    await sql`update ${sql.table("user")} set "stripeCustomerId" = ${"cus_user_1"} where id = ${owner.user.id}`.execute(
      db,
    );
    await sql`update ${sql.table("organization")} set "stripeCustomerId" = ${"cus_org_1"} where id = ${organizationId}`.execute(
      db,
    );
    const context = await getContext(auth);
    await context.adapter.create({
      model: "subscription",
      data: {
        referenceId: organizationId,
        plan: "pro",
        status: "active",
        stripeCustomerId: "cus_org_1",
        stripeSubscriptionId: "sub_1",
        periodStart: new Date("2026-01-01T00:00:00Z"),
        periodEnd: new Date("2026-02-01T00:00:00Z"),
        cancelAtPeriodEnd: false,
      },
    });
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

    // the stripe migration is what the baseline expects
    expect(baseline[STRIPE_TABLE]?.length).toBeGreaterThan(0);
    for (const table of STRIPE_COLUMN_TABLES) {
      expect(baseline[table], table).toEqual(
        expect.arrayContaining([expect.stringMatching(/^stripeCustomerId:/)]),
      );
    }

    const before = await describeSchema(db);
    const added = Object.keys(before)
      .filter((table) => !(table in baseline))
      .sort();
    expect(added).toEqual([...DROP_ORDER].sort());
    const kept = [STRIPE_TABLE, ...STRIPE_COLUMN_TABLES];
    for (const table of kept) {
      expect(before[table], table).toEqual(baseline[table]);
    }
    const countsBefore = await rowCounts(db, kept);
    expect(countsBefore[STRIPE_TABLE]).toBe(1);
    const rowsBefore = await stripeRows(db);

    for (const table of DROP_ORDER) {
      await sql`drop table ${sql.table(table)}`.execute(db);
    }

    const after = await describeSchema(db);
    expect(after).toEqual(baseline);
    for (const table of kept) {
      expect(after[table], table).toEqual(baseline[table]);
    }
    expect(await rowCounts(db, kept)).toEqual(countsBefore);
    expect(await stripeRows(db)).toEqual(rowsBefore);
  });
});

/** The subscription rows and the Stripe customer ids on users and organizations. */
async function stripeRows(db: AnyDb) {
  const subscriptions = await sql`
    select * from ${sql.table(STRIPE_TABLE)} order by id`.execute(db);
  const customers: Record<string, unknown[]> = {};
  for (const table of STRIPE_COLUMN_TABLES) {
    const { rows } = await sql`
      select id, "stripeCustomerId" from ${sql.table(table)} order by id`.execute(
      db,
    );
    customers[table] = rows;
  }
  return { subscriptions: subscriptions.rows, customers };
}
