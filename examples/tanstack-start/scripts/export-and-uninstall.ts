/**
 * The exit path: export every organization's entitlements data to a JSON
 * file, then drop the three entitlements tables. Afterwards remove
 * `entitlements()` from `src/lib/auth-options.ts`; nothing else in the
 * database belongs to the plugin.
 *
 *   node scripts/export-and-uninstall.ts            # writes ./entitlements-export.json
 *   EXPORT_PATH=out.json node scripts/export-and-uninstall.ts
 */
import { writeFileSync } from "node:fs";
import {
  type ExportedOverride,
  type ExportedSnapshot,
  type ExportedUsage,
  exportEntitlementsData,
} from "@byo-oss/entitlements";
import { betterAuth } from "better-auth";
import { authOptions } from "../src/lib/auth-options.ts";

/** The documented uninstall order. None references another, so any order works. */
const DROP_ORDER = [
  "entitlementUsage",
  "entitlementOverride",
  "entitlementSnapshot",
] as const;

const exportPath = process.env.EXPORT_PATH ?? "./entitlements-export.json";
const auth = betterAuth(authOptions);
const { adapter } = await auth.$context;

type OrganizationExport = {
  id: string;
  name: string;
  snapshots: ExportedSnapshot[];
  overrides: ExportedOverride[];
  usage: ExportedUsage[];
};

/** Every organization, a page at a time. */
async function listOrganizations() {
  const pageSize = 100;
  const organizations: { id: string; name: string }[] = [];
  for (let offset = 0; ; offset += pageSize) {
    const page = await adapter.findMany<{ id: string; name: string }>({
      model: "organization",
      limit: pageSize,
      offset,
      sortBy: { field: "id", direction: "asc" },
    });
    organizations.push(...page);
    if (page.length < pageSize) return organizations;
  }
}

/** One organization's rows: `exportEntitlementsData` pages until `nextCursor` is null. */
async function exportOrganization(organization: { id: string; name: string }) {
  const out: OrganizationExport = {
    id: organization.id,
    name: organization.name,
    snapshots: [],
    overrides: [],
    usage: [],
  };
  let cursor: string | null = null;
  do {
    const page = await exportEntitlementsData(auth, {
      organizationId: organization.id,
      cursor,
    });
    out.snapshots.push(...page.snapshots);
    out.overrides.push(...page.overrides);
    out.usage.push(...page.usage);
    cursor = page.nextCursor;
  } while (cursor !== null);
  return out;
}

const organizations: OrganizationExport[] = [];
for (const organization of await listOrganizations()) {
  organizations.push(await exportOrganization(organization));
}

const total = (list: "snapshots" | "overrides" | "usage") =>
  organizations.reduce((sum, organization) => sum + organization[list].length, 0);
const counts = {
  organizations: organizations.length,
  snapshots: total("snapshots"),
  overrides: total("overrides"),
  usage: total("usage"),
};

writeFileSync(
  exportPath,
  `${JSON.stringify({ exportedAt: new Date().toISOString(), organizations }, null, 2)}\n`,
);
console.log(
  `exported ${counts.organizations} organizations to ${exportPath}: ` +
    `${counts.snapshots} snapshots, ${counts.overrides} overrides, ${counts.usage} usage rows`,
);

// Drop only once the export is on disk.
const database = authOptions.database;
for (const table of DROP_ORDER) {
  database.exec(`DROP TABLE IF EXISTS "${table}"`);
}
database.close();
console.log(`dropped ${DROP_ORDER.length} tables: ${DROP_ORDER.join(", ")}`);
console.log(`counts: ${JSON.stringify(counts)}`);
