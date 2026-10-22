# @byo-oss/entitlements

Plan entitlements as a better-auth plugin: a typed catalog of plans, features and limits, per-organization usage counters and staff overrides, all in the app's own database. `llms.txt` is the full usage reference; read it before wiring this into an app.

## Installing it in an app

The same steps, with checks, ship as a skill: `skills/byo-entitlements/SKILL.md` (`npx skills add byo-oss/entitlements`). Keep the two, and the README's Setup section, in step when setup changes.

1. **Catalog and plugin.** `npm install @byo-oss/entitlements`. Write the catalog with `defineEntitlements` from `@byo-oss/entitlements/catalog`, then add `entitlements({ catalog, staffOrganizationId })` to `betterAuth({ plugins })` after `organization()`. Without a `source`, every organization is on `defaultPlan`; add `fromBetterAuthStripe()` from `@byo-oss/entitlements/stripe` when the app uses `@better-auth/stripe` with organization subscriptions.
2. **Statements into `ac`.** Spread `entitlementsStatements` into `createAccessControl` and give roles `entitlements: ["read"]` (members) or `["read", "override"]` (owner, admin). Pass `ac` and `roles` to `organization()`.
3. **Migration.** `npx @better-auth/cli migrate`, or `generate` and then the repo's drizzle or prisma flow. It adds `entitlementSnapshot`, `entitlementOverride` and `entitlementUsage`. On MongoDB, create unique indexes on `entitlementSnapshot.organizationId` and `entitlementUsage.bucket`.
4. **Client plugin.** Add `entitlementsClient()` from `@byo-oss/entitlements/client` next to `organizationClient()`.
5. **First `hasFeature` call.** `const gate = createEntitlements(auth, catalog)` in server code, then `await gate.hasFeature(organizationId, "exports")`.

Optional: render `useEntitlements`, `EntitlementGate` and `UsageMeter` from `@byo-oss/entitlements/react` (Tailwind v4 needs `@source "<path>/node_modules/@byo-oss/entitlements/dist";`), and call `auth.api.processEntitlementsSync()` from a cron when a `source` is configured.

## Rules

- Gate with `createEntitlements` (`hasFeature`, `getLimit`, `consumeUsage`, `checkCapacity`), never by reading the plugin's tables or comparing plan names. Checks return `{ allowed, reason, upgradeTo }`; build the refusal from that.
- `consumeUsage`, `sync` and `refreshEntitlements` throw inside a transaction. Call them before or after it. Reads and `checkCapacity` work inside one.
- Every duration option is in milliseconds except `pastDueGraceDays`. `maxAge` must be at least 60000; `usageRetention` and `overrideRetention` at least 86400000.
- Never rename a plan key that has subscribers; add a `planAliases` entry. Prices live in Stripe, not the catalog.
- Staff overrides are checked in `staffOrganizationId`, never in the target organization. Without it (or a custom `authorize`) the override endpoints deny every call.
- A custom `acceptSession` replaces the default, so keep its impersonation rule. API-key and bearer sessions on override endpoints are refused there.
- Deleting organizations outside `/organization/delete` needs `deleteOrganizationData(auth, organizationId)`. Export with `exportEntitlementsData`, looping on `nextCursor`.
- A billing provider other than Stripe is a `BillingSource` (`byo-entitlements-<provider>`). Test it with `testBillingSource` from `@byo-oss/entitlements/testing`.

## Working on this repo

- `pnpm install` (run `mise trust` and `mise install` first), then `pnpm typecheck`, `pnpm lint`, `pnpm test`.
- Lanes: `pnpm test:sql` (PGlite through Kysely), `pnpm test:stripe` (real `@better-auth/stripe`, fake Stripe client), `pnpm test:min` (the better-auth 1.7.7 set), `pnpm test:dist` (after `pnpm build`).
- Tests run a real better-auth instance on the memory adapter behind a strict adapter wrapper (`src/test-utils.ts`): every `findMany` needs a `limit`, `in` lists hold 1 to 90 values, no `where` mixes `AND` and `OR`.
- Read the clock through `rt.now()`, and resolve the adapter once per operation with `currentAdapter(rt)`. Never import `@better-auth/core` at runtime.
- Public changes (exports, options, schema, documented behaviour) update `README.md`, `llms.txt` and the skill in the same change.
- Follow the BYO conventions: https://github.com/byo-oss/conventions/blob/main/SPEC.md
