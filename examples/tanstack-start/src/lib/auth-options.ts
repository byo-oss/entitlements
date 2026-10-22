import { DatabaseSync } from "node:sqlite";
import { entitlements } from "@byo-oss/entitlements";
import type { BetterAuthOptions } from "better-auth";
import { organization } from "better-auth/plugins/organization";
import { ac, roles } from "./access.ts";
import { catalog } from "./catalog.ts";
import { STAFF_ORGANIZATION_ID } from "./constants.ts";
import { demoSource } from "./demo-source.ts";

// Setup step 1: the catalog and the plugin. Shared with scripts/migrate.ts,
// scripts/seed.ts and scripts/export-and-uninstall.ts, which run under plain
// Node and so can't import the TanStack cookie plugin.
export const authOptions = {
  // node:sqlite ships with Node; better-auth's Kysely adapter takes it as is
  database: new DatabaseSync(process.env.DB_PATH ?? "./example.db"),
  emailAndPassword: { enabled: true },
  plugins: [
    organization({ ac, roles }), // before entitlements(): tables are created in plugin order
    // `demoSource` is an in-memory stand-in for a billing provider (see
    // demo-source.ts). Production apps pass a real source, such as
    // `fromBetterAuthStripe()` from `@byo-oss/entitlements/stripe`.
    entitlements({
      catalog,
      source: demoSource,
      staffOrganizationId: STAFF_ORGANIZATION_ID,
    }),
  ],
} satisfies BetterAuthOptions;
