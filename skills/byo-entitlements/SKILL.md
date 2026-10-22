---
name: byo-entitlements
description: Plan entitlements for better-auth apps with @byo-oss/entitlements. Use when gating features by plan, enforcing usage or seat limits per organization, adding a typed plan catalog, syncing plans from Stripe, letting staff comp a feature or raise a limit, or showing plan usage in the UI.
---

# @byo-oss/entitlements

A better-auth plugin: a typed catalog of plans, features and limits, a per-organization snapshot of the billing state, atomic usage counters and staff overrides, all in the app's own database. Stripe (through `@better-auth/stripe`) says which plan an organization bought; the catalog says what it allows.

The API reference is `node_modules/@byo-oss/entitlements/llms.txt` once the package is installed. Read it before writing calls; this skill covers wiring and the gotchas. Requires `better-auth` `^1.7.7` and the organization plugin.

## Setup

Work through these in order. Each step ends on a check; move on only when it holds.

1. **Catalog and plugin.** `npm install @byo-oss/entitlements` (use the repo's package manager). Write the catalog with `defineEntitlements` from `@byo-oss/entitlements/catalog`: `features` (booleans), `limits` (`metered` with a `period` of `day`, `month` or `billing`; `capacity`; `value`), `plans` that set every key, a `defaultPlan`, optional `planAliases`. Add `entitlements({ catalog, staffOrganizationId })` to `betterAuth({ plugins })` **after** `organization()`. With the Stripe plugin, add `source: fromBetterAuthStripe()` from `@byo-oss/entitlements/stripe` and build the Stripe plugin's `plans` with `stripePlans(catalog, { pro: { priceId } })`. Done when the app typechecks and boots; without `staffOrganizationId` the log warns that override endpoints will deny.

2. **Statements into `ac`.** Spread `entitlementsStatements` into `createAccessControl({ ...defaultStatements, ...entitlementsStatements })`, give roles `entitlements: ["read"]` (members) or `["read", "override"]` (owner, admin), and pass `ac` and `roles` to `organization()`. `override` is only ever checked in the staff organization, so a customer organization's owner cannot override their own plan. Done when the roles typecheck.

3. **Migration.** Generate tables the way the repo already does: `npx @better-auth/cli migrate`, or `npx @better-auth/cli generate` and then the repo's drizzle or prisma flow. It adds `entitlementSnapshot`, `entitlementOverride` and `entitlementUsage`, with nothing on better-auth's own tables. On MongoDB, create unique indexes on `entitlementSnapshot.organizationId` and `entitlementUsage.bucket` first. Done when the migration is written and applied to the dev database.

4. **Client plugin.** Add `entitlementsClient()` from `@byo-oss/entitlements/client` to `createAuthClient({ plugins })`, next to `organizationClient()`. Done when `authClient.entitlements.get` typechecks.

5. **First `hasFeature` call.** In server code, `export const gate = createEntitlements(auth, catalog)`, then `await gate.hasFeature(organizationId, "exports")`. Done when a Free organization gets `{ allowed: false, reason: "not_in_plan", upgradeTo: ["pro"] }`.

## Using it

- **Gate a feature:** `const r = await gate.hasFeature(orgId, "exports"); if (!r.allowed) ...` and build the refusal from `r.upgradeTo`.
- **Meter usage:** `const r = await gate.consumeUsage(orgId, "apiCalls")`. Refusals never count. Map `!r.allowed` to 429 (503 when `r.reason === "error"`) and use `r.resetAt` for `retry-after`. `r.firstRefusal` is true once per period.
- **Check a count:** `await gate.checkCapacity(orgId, "members", { count })` before creating the row. The count is the app's; two concurrent creates can both pass, so lock the organization row in a transaction if that matters.
- **Read a setting:** `await gate.getLimit(orgId, "retentionDays")`.
- **After checkout:** call `refreshEntitlements` (`authClient.entitlements.refresh({ organizationId })`, or the hook's `refresh()`) when the user returns, because the webhook may arrive later.
- **UI:** `useEntitlements({ client: authClient, organizationId })`, `<EntitlementGate entitlements feature fallback />` and `<UsageMeter entitlements limitKey />` from `@byo-oss/entitlements/react`. Tailwind v4 skips `node_modules`: add `@source "<relative path>/node_modules/@byo-oss/entitlements/dist";` to the CSS file that imports Tailwind.
- **Cron:** with a `source`, call `auth.api.processEntitlementsSync()` every minute, and again while `hasMore` is true. Without the cron (and without `advanced.backgroundTasks.handler`), a stale snapshot is marked due but only a push or `refreshEntitlements` updates it.

## Rules

- Gate through `createEntitlements`. Leave the plugin's tables to it; use `auth.api.*`, the client, the React exports and the exported functions.
- Every duration option is in milliseconds, except `pastDueGraceDays` (days). Floors: `maxAge` 60000, `usageRetention` and `overrideRetention` 86400000. A value in the wrong unit fails boot.
- `consumeUsage`, `sync` and `refreshEntitlements` throw inside a transaction; call them outside. Reads and `checkCapacity` work inside one.
- Never rename a plan key that has subscribers; map the old key with `planAliases`.
- A custom `acceptSession` replaces the default, so keep the rule that refuses impersonated sessions (`session.session.impersonatedBy`) on staff calls and POSTs.
- Deleting an organization through `/organization/delete` cleans up by itself. Deletes made another way call `deleteOrganizationData(auth, organizationId)`.
- Route `entitlements.usage.limit_reached` from `onEvent` to `auth.api.notify` when the app uses `@byo-oss/notifications`.

## Another billing provider

A provider other than Stripe is a `BillingSource` (`id`, `resolve(organizationId, { adapter })`, optional `connect`): resolve returns the current state or `null`, and throws to retry. Name the package `byo-entitlements-<provider>` and test it with the contract suite (vitest, ESM):

```ts
import { testBillingSource } from "@byo-oss/entitlements/testing"
testBillingSource({ setup, failing })
```

Done when the suite passes.
