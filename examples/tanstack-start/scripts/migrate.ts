// Setup step 3: the migration creates better-auth's, the organization
// plugin's and the three entitlements tables.
import { getMigrations } from "better-auth/db/migration";
import { authOptions } from "../src/lib/auth-options.ts";

const { runMigrations, toBeCreated, toBeAdded } = await getMigrations(authOptions);
await runMigrations();
console.log(
  `migrated: ${toBeCreated.length} tables created, ${toBeAdded.length} altered`,
);
