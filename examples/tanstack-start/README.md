# @byo-oss/entitlements × TanStack Start

TanStack Start + better-auth (SQLite via `node:sqlite`) + `@byo-oss/entitlements`, with an
end-to-end suite that proves the wiring: a customer organization on Free sees a gated feature's
upgrade prompt, staff set an override that unlocks it, API calls past the plan's limit are refused,
and the export and uninstall script leaves no entitlements tables behind.

Needs Node 22.13+ (for `node:sqlite` and running `.ts` scripts; 22.18+ strips types by default).

```
pnpm install
pnpm migrate     # creates example.db (better-auth, organization and entitlements tables)
pnpm seed        # a customer organization on Free, a staff organization, a user for each
pnpm dev         # http://localhost:3000
```

Sign in as the customer (`customer@example.dev` / `customer-password-123`) and open **Plan**: the
plan's limits, a usage meter for API calls, **Call the API** (3 calls a month on Free, then
refused) and the gated **Exports** section. Sign out, sign in as staff (`staff@example.dev` /
`staff-password-123`), open **Staff** and set an `exports` override on the customer's
organization; the customer's Plan page now shows **Export data**. Remove it again from the same
page.

## The five setup steps

1. **Catalog and plugin.** `src/lib/catalog.ts` declares the plans (`free`, `pro`), features
   (`exports`, `prioritySupport`) and limits (`apiCalls` metered per month, `members` and
   `projects` capacity, `retentionDays` a value). `src/lib/auth-options.ts` installs
   `organization({ ac, roles })` and then `entitlements({ catalog, staffOrganizationId })`.
   `organization()` comes first: migrations create tables in plugin order.
2. **Statements into `ac`.** `src/lib/access.ts` spreads `entitlementsStatements` (from
   `@byo-oss/entitlements`) into
   `createAccessControl`. Every role gets `read`; `owner` and `admin` also get `override`, which
   only counts in the staff organization.
3. **Migration.** `scripts/migrate.ts` runs better-auth's `getMigrations`, which creates
   `entitlementSnapshot`, `entitlementOverride` and `entitlementUsage`.
4. **Client plugin.** `src/lib/auth-client.ts` adds `entitlementsClient()`.
5. **First `hasFeature` call.** `src/lib/actions.ts` is a server function that checks
   `entitlements.hasFeature(organizationId, "exports")` before exporting.

## Where the pieces are

- `src/lib/auth.ts`: adds `tanstackStartCookies()` last, for server functions, and
  `createEntitlements(auth, catalog)`, the typed server API.
- `src/lib/actions.ts`: two server functions. Each first checks that the signed-in user has
  `entitlements: ["read"]` in the organization (the typed API takes a plain organization id, so
  the app proves the tenant). `exportData` calls `hasFeature`; `callApi` calls
  `consumeUsage(organizationId, "apiCalls")` and returns the refusal (`reason: "limit_reached"`,
  `upgradeTo`).
- `src/routes/plan.tsx`: `useEntitlements`, a `UsageMeter` per metered key, and
  `EntitlementGate` around **Export data** with an upgrade fallback.
- `src/routes/staff.tsx`: `client.entitlements.override.set`, `.overrides` and
  `.override.remove`. Staff read the customer's entitlements through the staff organization.
- `scripts/seed.ts`: creates both organizations with fixed ids (`acme-org`, and `staff-org`,
  which the plugin is told about) and makes each user the owner of one.
- `scripts/export-and-uninstall.ts`: the exit path (below).

The plugin has no billing `source`, so every organization is on the catalog's `defaultPlan` (Free)
plus its overrides. Production apps pass a real source, such as `fromBetterAuthStripe()` from
`@byo-oss/entitlements/stripe`.

The components use shadcn CSS variables and Tailwind classes. This example doesn't set Tailwind
up, so they render unstyled. With Tailwind v4, add the `@source` line from the package README.

## Export and uninstall

```
pnpm export-and-uninstall   # writes ./entitlements-export.json, then drops the tables
```

The script runs `exportEntitlementsData` for every organization, paging until `nextCursor` is
null, and writes the rows (snapshots, overrides with their authors' emails, usage) to
`EXPORT_PATH` (default `./entitlements-export.json`). Then it drops `entitlementUsage`,
`entitlementOverride` and `entitlementSnapshot`, in that order, and prints the counts. Afterwards
remove `entitlements()` from `src/lib/auth-options.ts`; better-auth's own tables are untouched.

## Packed tarball

`pnpm-workspace.yaml` overrides `@byo-oss/entitlements` to
`.tarballs/byo-oss-entitlements-0.1.0.tgz`, packed from the package's checkout, so the example
runs against what would be published. Pack it into `.tarballs/` (git-ignored) before
`pnpm install`. `@byo-oss/core` comes from npm. To use the published package, delete the
`overrides` block.

## End-to-end tests

`tests/entitlements.e2e.ts` runs on [e2e](https://www.npmjs.com/package/e2e), with no agent
steps, so it needs no model or API key:

```
npx e2e-web install chromium   # once
pnpm test:e2e
```

The runner starts the app on a free port against a fresh `e2e.db` (migrated and seeded by
`e2e:serve`). It checks:

- the customer's organization is on Free and the gate shows its upgrade fallback;
- staff set an `exports` override and the customer's gate unlocks (and the server's
  `hasFeature` allows the export);
- three API calls are accepted, the fourth is refused with `limit_reached`, and the meter stays
  at 3 of 3;
- staff remove the override;
- the export and uninstall script exports the override and the usage row (there is no
  snapshot row, because the plugin has no billing source), and afterwards no `entitlement*`
  table is left.

e2e needs Node 22.22.3+ or 24.8+.
