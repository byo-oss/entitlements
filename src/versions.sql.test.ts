import { kyselyAdapter } from "@better-auth/kysely-adapter";
import { PGlite } from "@electric-sql/pglite";
import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { organization } from "better-auth/plugins/organization";
import { Kysely } from "kysely";
import { KyselyPGlite } from "kysely-pglite";
import { describe, expect, it } from "vitest";
import { assertLoadedVersions } from "./test-versions";

const expected = process.env.BYO_EXPECT_BA as string;
// a version that differs from the one this lane expects
const other =
  expected !== "1.7.7" ? "1.7.7" : (process.env.BYO_ROOT_BA as string);

describe("loaded versions (sql lane)", () => {
  it(`loads better-auth ${expected}`, () => {
    expect(expected).toBeTruthy();
    expect(() => assertLoadedVersions()).not.toThrow();
  });

  it("fails when a different version is expected", () => {
    expect(() => assertLoadedVersions(other)).toThrow(expected);
  });

  it("runs better-auth on PGlite through Kysely", async () => {
    const pglite = new PGlite();
    // biome-ignore lint/suspicious/noExplicitAny: tables come from the migration, not a typed schema
    const db = new Kysely<any>({ dialect: new KyselyPGlite(pglite).dialect });
    const options = {
      secret: "test-secret-test-secret-test-secret-00",
      baseURL: "http://localhost:3000",
      emailAndPassword: { enabled: true },
      plugins: [organization()],
    };
    try {
      const { runMigrations } = await getMigrations({
        ...options,
        database: { db, type: "postgres" },
      });
      await runMigrations();
      const auth = betterAuth({
        ...options,
        database: kyselyAdapter(db, { type: "postgres", transaction: true }),
      });
      const ctx = await auth.$context;
      const users = await ctx.adapter.findMany({ model: "user", limit: 10 });
      expect(users).toEqual([]);
      const rows = await db.selectFrom("user").selectAll().execute();
      expect(rows).toEqual([]);
    } finally {
      await db.destroy();
    }
  });
});
