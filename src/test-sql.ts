/**
 * Test harness for the SQL lane (`*.sql.test.ts`, also usable from the
 * memory lane): a real better-auth on PGlite through Kysely, migrated with
 * better-auth's `getMigrations`. PGlite rejects `IN ()`, applies `unique`
 * and `onDelete`, and runs real transactions. One PGlite connection
 * serializes queries, and an outer-adapter call inside an open transaction
 * may silently join it, so transaction tests rely on the wrapper's tags
 * (`expectNoOuterCalls`), not on "no row after rollback" alone.
 */

import { kyselyAdapter } from "@better-auth/kysely-adapter";
import { PGlite } from "@electric-sql/pglite";
import {
  type BetterAuthOptions,
  type BetterAuthPlugin,
  betterAuth,
} from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { Kysely } from "kysely";
import { KyselyPGlite } from "kysely-pglite";
import {
  mergeAuthOptions,
  type TestAuthConfig,
  testPlugins,
  wrapAdapterFactory,
} from "./test-utils";

export type SqlTestAuthConfig<
  P extends BetterAuthPlugin[] = BetterAuthPlugin[],
> = TestAuthConfig<P> & {
  /**
   * The Kysely adapter's `transaction` option. `false` builds an adapter
   * without real transactions (`transaction(cb)` is `cb(adapter)`).
   * @default true
   */
  transaction?: boolean;
  /** better-auth's `advanced.database.generateId`. @default better-auth's own ids */
  generateId?: "uuid" | "serial";
  /**
   * Another harness's database: this auth runs on the same PGlite and
   * Kysely (no new database, no migration), as a second process would.
   * Its `close()` leaves the shared database open.
   */
  // biome-ignore lint/suspicious/noExplicitAny: as `db` below
  shareWith?: { db: Kysely<any>; pglite: PGlite };
};

/**
 * A migrated PGlite database and a `betterAuth` on it with the test plugins
 * (`organization`, `entitlements({ catalog: testCatalog, ...config.options })`,
 * `config.plugins`, typed on `auth.api`) and the Kysely adapter
 * (`type: "postgres"`) behind the strict wrapper. Call `close()` in
 * `afterAll`/`afterEach`.
 */
export async function createSqlTestAuth<P extends BetterAuthPlugin[] = []>(
  config: SqlTestAuthConfig<P> = {},
) {
  const shared = config.shareWith;
  const pglite = shared?.pglite ?? new PGlite();
  const db =
    shared?.db ??
    // biome-ignore lint/suspicious/noExplicitAny: tables come from the migration, not a typed schema
    new Kysely<any>({ dialect: new KyselyPGlite(pglite).dialect });
  const advanced: BetterAuthOptions["advanced"] = {
    ...config.authOptions?.advanced,
    ...(config.generateId
      ? {
          database: {
            ...config.authOptions?.advanced?.database,
            generateId: config.generateId,
          },
        }
      : {}),
  };
  const options = {
    ...mergeAuthOptions(config.authOptions),
    advanced,
    plugins: testPlugins<P>(config),
  };
  // getMigrations needs the object form of `database`; the auth below uses
  // a wrapped adapter factory on the same Kysely instance
  if (!shared) {
    const { runMigrations } = await getMigrations({
      ...options,
      database: { db, type: "postgres" },
    });
    await runMigrations();
  }
  const auth = betterAuth({
    ...options,
    database: wrapAdapterFactory(
      kyselyAdapter(db, {
        type: "postgres",
        transaction: config.transaction ?? true,
      }),
      config.adapter,
    ),
  });
  return {
    auth,
    /** Raw SQL access to the same database. */
    db,
    pglite,
    close: async () => {
      if (!shared) await db.destroy();
    },
  };
}

/** A SQL-lane auth without extra plugins. */
export type SqlTestAuth = Awaited<
  ReturnType<typeof createSqlTestAuth<[]>>
>["auth"];
