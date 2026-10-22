# @byo-oss/entitlements

Plans, features, limits and usage for [better-auth](https://better-auth.com) organizations, kept in your own database. Declare a plan catalog once, then ask one question from anywhere in your app: may this organization do X, and how much of Y is left?

> Community plugin — not affiliated with the better-auth team.

```
npm install @byo-oss/entitlements
```

- **One typed catalog.** Features (booleans), limits (`metered`, `capacity` or `value`), plans that set every key. The API, the web app and a static pricing page import the same file.
- **Billing stays where it is.** Stripe (through `@better-auth/stripe`) knows which plan an organization bought. This package keeps a snapshot of that and decides what the plan allows.
- **Atomic usage counters.** `consumeUsage` is one guarded `incrementOne`: no read-then-write race, and a refusal never counts.
- **Staff overrides.** Comp a feature, raise a limit or put an organization on another plan, with a reason, an optional expiry and an audit trail.
- **Never a 500 for a refusal.** Checks return a result with `allowed`, `reason` and the plans that would unlock it.

## Install

```
npm install @byo-oss/entitlements
```

Peer dependencies: `better-auth` `^1.7.7` and `better-call` `^1.4.0`. Optional peers: `@better-auth/stripe` `^1.7.7` (for `@byo-oss/entitlements/stripe`), `react` (for `/react`) and `vitest` (for `/testing`).

| Subpath | What it holds |
|---|---|
| `@byo-oss/entitlements` | the plugin, `createEntitlements`, `deleteOrganizationData`, `exportEntitlementsData`, `entitlementsStatements`, error codes, types |
| `@byo-oss/entitlements/catalog` | `defineEntitlements`, `upgradeTo` and the catalog types. Imports nothing, so a static site can use it |
| `@byo-oss/entitlements/client` | the better-auth client plugin; re-exports the catalog helpers and `entitlementsStatements` |
| `@byo-oss/entitlements/react` | `useEntitlements`, `EntitlementGate`, `UsageMeter` |
| `@byo-oss/entitlements/stripe` | `fromBetterAuthStripe()` and `stripePlans()` |
| `@byo-oss/entitlements/testing` | `memorySource()` and the `testBillingSource` contract suite (ESM only) |

## Setup

Five steps. Each ends on a check.

1. **Catalog and plugin.** Write the catalog, then add `entitlements()` to `betterAuth({ plugins })` after `organization()`.

   ```ts
   // lib/catalog.ts
   import { defineEntitlements } from "@byo-oss/entitlements/catalog"

   export const catalog = defineEntitlements({
     features: ["exports", "sso", "prioritySupport"],
     limits: {
       apiCalls: { kind: "metered", period: "day" }, // day | month (UTC) | billing (subscription period)
       members: { kind: "capacity" },                // you supply the count
       projects: { kind: "capacity" },
       retentionDays: { kind: "value" },             // a plan setting, read with getLimit
     },
     plans: {
       free: {
         features: { exports: false, sso: false, prioritySupport: false },
         limits: { apiCalls: 1_000, members: 5, projects: 3, retentionDays: 7 },
         display: { name: "Free" },
       },
       pro: {
         features: { exports: true, sso: false, prioritySupport: false },
         limits: { apiCalls: 50_000, members: 50, projects: "unlimited", retentionDays: 90 },
       },
     },
     defaultPlan: "free",
     planAliases: { legacy: "pro" }, // an old plan key still in Stripe maps to its current plan
   })
   ```

   ```ts
   // lib/auth.ts
   import { betterAuth } from "better-auth"
   import { organization } from "better-auth/plugins/organization"
   import { entitlements } from "@byo-oss/entitlements"
   import { catalog } from "./catalog"

   export const auth = betterAuth({
     // ...your existing config
     plugins: [
       organization(), // must come before entitlements(): migrations create tables in plugin order
       entitlements({
         catalog,
         staffOrganizationId: process.env.STAFF_ORGANIZATION_ID, // the vendor's staff organization (see Access)
       }),
     ],
   })
   ```

   - With no `source`, every organization is on `defaultPlan` (plus overrides). That is enough for dev and tests; add `fromBetterAuthStripe()` under Billing sources when you take payments.
   - Without the organization plugin, boot fails with `ORGANIZATION_PLUGIN_REQUIRED`. Without `staffOrganizationId` (or a custom `authorize`), the override endpoints deny every call and boot logs one warning.
   - Never rename a plan key that has subscribers. Add a `planAliases` entry from the old key to the current plan instead.

   Done when the app typechecks and boots.

2. **Statements into `ac`.** Spread `entitlementsStatements` into your access control and give your roles `entitlements` actions.

   ```ts
   // lib/permissions.ts
   import { createAccessControl } from "better-auth/plugins/access"
   import { adminAc, defaultStatements, memberAc, ownerAc } from "better-auth/plugins/organization/access"
   import { entitlementsStatements } from "@byo-oss/entitlements"

   export const ac = createAccessControl({ ...defaultStatements, ...entitlementsStatements })
   export const roles = {
     owner: ac.newRole({ ...ownerAc.statements, entitlements: ["read", "override"] }),
     admin: ac.newRole({ ...adminAc.statements, entitlements: ["read", "override"] }),
     member: ac.newRole({ ...memberAc.statements, entitlements: ["read"] }),
   }
   ```

   Then pass them to the plugin: `organization({ ac, roles })`.
   - `entitlements:read` lets a member see their own organization's plan, features, limits and usage.
   - `entitlements:override` is only ever checked in the staff organization, never in the organization being changed. A customer organization's owner holds the action but is not a member of the staff organization, so they cannot override their own plan.

   Done when `ac` includes `entitlements` and the roles typecheck.

3. **Migration.** Generate the tables the way the app already does: `npx @better-auth/cli migrate`, or `npx @better-auth/cli generate` and then your drizzle or prisma flow. It adds `entitlementSnapshot`, `entitlementOverride` and `entitlementUsage` and changes nothing on better-auth's own tables. On MongoDB, create the two unique indexes under Schema first. Done when the migration is applied to the dev database.

4. **Client plugin.** Add `entitlementsClient()` to the auth client.

   ```ts
   // lib/auth-client.ts
   import { createAuthClient } from "better-auth/react"
   import { organizationClient } from "better-auth/client/plugins"
   import { entitlementsClient } from "@byo-oss/entitlements/client"

   export const authClient = createAuthClient({
     plugins: [organizationClient(), entitlementsClient()],
   })
   ```

   Done when `authClient.entitlements.get` typechecks.

5. **First `hasFeature` call.** Create the typed server API and gate something.

   ```ts
   // lib/gate.ts (server only)
   import { createEntitlements } from "@byo-oss/entitlements"
   import { auth } from "./auth"
   import { catalog } from "./catalog"

   export const gate = createEntitlements(auth, catalog)

   export async function canExport(organizationId: string) {
     return gate.hasFeature(organizationId, "exports")
     // { allowed: false, reason: "not_in_plan", key: "exports", plan: "free", upgradeTo: ["pro"] }
   }
   ```

   `"exprts"` is a type error. Done when a Free organization gets `allowed: false` with `upgradeTo: ["pro"]`.

## Catalog

- Feature, limit and plan keys are string-literal unions. Each plan must set every key and nothing else; a gap is a type error and a boot error.
- Limit values are non-negative integers or `"unlimited"`. `display` is free-form metadata returned as given. Prices are not part of the catalog.
- Plan keys match `/^[a-z][a-z0-9_-]*$/`, because `@better-auth/stripe` lowercases plan names. At most 150 feature and limit keys together.
- Limit kinds:
  - `metered` with a `period`: counted by `consumeUsage`. `day` and `month` are UTC calendar periods; `billing` follows the snapshot's subscription period while the organization is entitled and in period, else the UTC month.
  - `capacity`: you pass the current count to `checkCapacity` (you know which roles are free).
  - `value`: a plan setting you read with `getLimit`, such as `retentionDays`.
- `upgradeTo(catalog, { feature: "sso" })` and `upgradeTo(catalog, { limit: "projects", atLeast: 10 })` return the plan keys that would unlock it, in catalog order.
- The catalog passed to `createEntitlements` must be the one the plugin was given (same reference, else deep equality), or the first call throws `[@byo-oss/entitlements] createEntitlements got a different catalog than the plugin`.

## Options

Every duration is in milliseconds except `pastDueGraceDays` (days). A value given in the wrong unit fails boot instead of silently meaning milliseconds, which is what the floors are for.

| Option | Default | Notes |
|---|---|---|
| `catalog` | required | From `defineEntitlements`. |
| `source` | none | A `BillingSource`. Unset: every organization is on `defaultPlan` (plus overrides); nothing writes snapshots. |
| `isEntitled` | `active`, `trialing`, and `past_due` within the grace window | `(snapshot, now) => boolean`. Any other status falls back to `defaultPlan`. |
| `pastDueGraceDays` | `7` | Days a `past_due` organization keeps its plan, counted from `pastDueSince` (this package's own timestamp, not Stripe's period, which can move forward before payment). In days, not ms. Must be at least 0. |
| `resolveEntitlements` | none | `({ organizationId, plan, snapshot, features, limits }) => { features?, limits? }`, sync or async. Keys returned replace the plan's values. Runs after a plan override and before feature and limit overrides. |
| `staffOrganizationId` | none | The vendor's staff organization. An empty string fails boot. |
| `authorize` | organization-role check | `({ session, headers, organizationId, permissions }) => boolean`. Called with the target organization for member reads and with `staffOrganizationId` for staff calls. |
| `acceptSession` | refuses impersonated sessions on staff calls and on every POST | `({ session, headers, kind: "member" \| "staff", method, path }) => boolean`. `false` answers 403 `SESSION_NOT_ACCEPTED`. |
| `onEvent` | none | `(event) => void \| Promise<void>`. Errors are logged and never fail the call. |
| `onError` | `() => "deny"` | `(error, { organizationId, key, operation }) => "allow" \| "deny"`: what `hasFeature`, `consumeUsage` and `checkCapacity` answer when the database or source throws. Always logged. |
| `cacheTtlMs` | `30000` | In-process cache of resolved entitlements, at most 10 000 organizations. `0` turns it off. Integer, at least 0. Usage counters are never cached. |
| `maxAge` | `3600000` (1 hour) | A snapshot older than this is served, then refreshed in the background. Integer, **at least 60000** (1 minute). |
| `usageRetention` | `7776000000` (90 days) | The sweep deletes `entitlementUsage` rows whose period ended longer ago. Integer, **at least 86400000** (1 day). |
| `overrideRetention` | `31536000000` (365 days) | The sweep deletes removed or expired overrides that ended longer ago. Integer, **at least 86400000** (1 day). `overrideRetention: 365` fails boot. |
| `organizationCleanup` | `true` | Delete an organization's rows after `/organization/delete`. |
| `maxAttempts` | `5` | Resolve attempts before a snapshot is counted `failed` (it keeps its last good state). Integer, at least 1. |
| `batchSize` | `100` | Snapshots claimed per sweep call. Integer, 1 to 1000. |
| `leaseMs` | `300000` (5 minutes) | How long a sweep claim lasts before another sweep may take it. Integer, at least 1. |
| `schema` | none | Rename tables and columns (better-auth's `mergeSchema`). |

Boot validation throws `[@byo-oss/entitlements] …` for: a bad catalog (missing or unknown key, bad plan key, bad limit, bad alias, more than 150 keys), `defaultPlan` not in `plans`, an empty `staffOrganizationId`, a source without a non-empty `id` or a `resolve` function (`"none"` is reserved), and a numeric option out of range.

The default `acceptSession` refuses impersonated sessions and nothing else. Refusing API-key and bearer callers on the override endpoints is your choice; a custom `acceptSession` replaces the default, so it keeps the impersonation rule and adds that one:

```ts
// lib/auth-options.ts
import { betterAuth } from "better-auth"
import { organization } from "better-auth/plugins/organization"
import { entitlements } from "@byo-oss/entitlements"
import { catalog } from "./catalog"

export const auth = betterAuth({
  plugins: [
    organization(),
    entitlements({
      catalog,
      staffOrganizationId: process.env.STAFF_ORGANIZATION_ID,
      // plan-level adjustments: paid seats override the plan's member limit
      resolveEntitlements: ({ snapshot }) =>
        snapshot?.seats ? { limits: { members: snapshot.seats } } : {},
      acceptSession: ({ session, kind, method, path, headers }) => {
        // the default's rule: no impersonated sessions on staff calls or POSTs
        if (session.session.impersonatedBy && (kind === "staff" || method === "POST")) return false
        // your own rule: no bearer or API-key callers on the override endpoints
        const bearer = headers?.get("authorization")?.startsWith("Bearer ")
        if (path.startsWith("/entitlements/override") && (bearer || headers?.has("x-api-key"))) return false
        return true
      },
    }),
  ],
})
```

## API

### Endpoints

Endpoints need a session. There is no credential-free route. GET endpoints: `/entitlements/get`, `/entitlements/overrides`; every other route is POST. List the two GETs if your app classifies GET requests, for example to allow impersonated sessions to read.

| `auth.api` key | Method and path | Kind | Input | Returns |
|---|---|---|---|---|
| `getEntitlements` | GET `/entitlements/get` | gated: `entitlements:read` in `organizationId`, or in the staff organization | `organizationId` | the resolved result plus `usage` per metered key (`{ used, remaining, resetAt }`). Staff callers also get each override's `id`, `reason` and `createdBy` |
| `refreshEntitlements` | POST `/entitlements/refresh` | gated, same rule | `organizationId` | the same, after a sync that bypasses the cache. Call it when the user returns from checkout |
| `setEntitlementOverride` | POST `/entitlements/override/set` | gated: `entitlements:override` in the staff organization | `organizationId, kind, key, value, reason, expiresAt?` | `{ override }` |
| `removeEntitlementOverride` | POST `/entitlements/override/remove` | gated: `entitlements:override` in the staff organization | `id` | `{ ok: true }` |
| `listEntitlementOverrides` | GET `/entitlements/overrides` | gated: `entitlements:read` in the staff organization | `organizationId?, status?, cursor?` | `{ overrides, nextCursor }`, newest first, up to 50 per page |
| `processEntitlementsSync` | none | server-only | none | `{ synced, skipped, retrying, failed, expired, pruned, hasMore }` |

The client exposes them as `client.entitlements.get({ query })`, `.refresh({ organizationId })`, `.override.set(body)`, `.override.remove({ id })` and `.overrides({ query })`.

`getEntitlements` and `refreshEntitlements` answer 503 `ENTITLEMENTS_UNAVAILABLE` instead of a degraded plan, so a UI never shows the default plan as if it were real.

### Server functions

`createEntitlements(auth, catalog)` returns the first eight, typed by your catalog. They take a plain organization id, so you can wrap them behind your own tenant checks. Reads and checks never throw for a refusal or an outage. The last three rows are not on that object: `deleteOrganizationData` and `exportEntitlementsData` are separate imports from `@byo-oss/entitlements`, and `processEntitlementsSync` is an `auth.api` call.

| Function | Kind | Returns |
|---|---|---|
| `get(orgId)` | server function | plan (`key`, `display`, `source`), `status`, `periodEnd`, `cancelAtPeriodEnd`, `features`, `limits`, applied `overrides`, `degraded` |
| `getMany(orgIds)` | server function | `get` for up to 1000 ids, in order. `[]` returns `[]` with no query; more than 1000 throws |
| `hasFeature(orgId, feature)` | server function | `{ allowed, reason, key, plan, upgradeTo }` |
| `getLimit(orgId, key)` | server function | `{ key, plan, limit, allowed, reason, upgradeTo, degraded }`; metered keys add `{ used, remaining, resetAt }`. Consumes nothing. A limit of 0 reads `not_in_plan`; a metered key with nothing left reads `limit_reached` |
| `consumeUsage(orgId, key, { amount? })` | server function | `{ allowed, reason, used, limit, remaining, resetAt, firstRefusal, plan, upgradeTo }`. Metered keys only; `amount` is a positive integer (default 1) |
| `checkCapacity(orgId, key, { count, adding? })` | server function | `{ allowed, reason, count, limit, over, plan, upgradeTo }`. Capacity keys only; `allowed` is `count + adding <= limit` |
| `sync(orgId)` | server function | the fresh result; also refreshes a stale snapshot. Throws when the source or database fails, and inside a transaction |
| `invalidate(orgId)` | server function | clears this process's cache entry |
| `deleteOrganizationData(auth, orgId)` | server function | deletes the organization's rows (see Uninstall and Lifecycle) |
| `exportEntitlementsData(auth, options)` | server function | one page of rows (see Export) |
| `processEntitlementsSync` | server-only | via `auth.api`, see Freshness |

`reason` is `"ok"`, `"not_in_plan"`, `"limit_reached"` or `"error"`. Bad arguments throw a programmer error, never a refusal:

- A key of the wrong kind (a feature where a metered key is expected, say) throws `[@byo-oss/entitlements] UNKNOWN_KEY: …`.
- An invalid `amount` throws `[@byo-oss/entitlements] consumeUsage: amount must be a positive integer`.
- An invalid `count` or `adding` throws `[@byo-oss/entitlements] checkCapacity: count and adding must be non-negative integers`.

Only the first carries the `UNKNOWN_KEY` code; the other two are plain `Error`s with those messages.

```ts
// lib/guard.ts (server only)
import { gate } from "./gate"

export async function guardApiCall(organizationId: string): Promise<Response | null> {
  const r = await gate.consumeUsage(organizationId, "apiCalls")
  if (r.allowed) return null
  const status = r.reason === "error" ? 503 : 429
  return new Response("Limit reached", {
    status,
    headers: { "retry-after": String(Math.ceil((r.resetAt.getTime() - Date.now()) / 1000)) },
  })
}
```

**Failure policy.** When the database, the billing source or your `resolveEntitlements` hook throws, `get`, `getMany` and `getLimit` answer from `defaultPlan` with `degraded: true`, and `hasFeature`, `consumeUsage` and `checkCapacity` answer what `onError` says, with `reason: "error"`. Each failure is logged once. An id that isn't an organization answers `defaultPlan` without `degraded` and writes nothing.

**Capacity race.** `checkCapacity` compares a count you supply, so two concurrent creates can both pass. To close it, lock a parent row (`SELECT … FOR UPDATE` on the organization) inside the transaction that counts and creates, or use SERIALIZABLE. After a downgrade `over` is true while `count > limit`, so a UI can show the organization above its new limit; nothing is deleted.

### Access

For `getEntitlements` and `refreshEntitlements`:

1. `authorize` in the target organization (`kind: "member"`); if that fails, `authorize` in the staff organization (`kind: "staff"`). Override endpoints always use the staff organization.
2. Neither passes: 404 `ORGANIZATION_NOT_FOUND`, whether or not the organization exists.
3. `acceptSession`; `false` answers 403 `SESSION_NOT_ACCEPTED`. The default refuses an impersonated session (`session.session.impersonatedBy`) on staff calls and on every POST, and allows impersonated member reads.
4. On a staff path the target organization must exist, else 404.

The default `authorize` looks up the caller's `member` row in the organization it is asked about and runs the organization plugin's `hasPermission` for that role. It never looks at role names or the session's active organization.

Override rules: `key` must be in the catalog for its `kind` (a plan alias is not a plan key); a `feature` value is a boolean; a `limit` value is a non-negative integer or `"unlimited"`; a `plan` override takes no value; `expiresAt`, if given, is in the future; `reason` is 1 to 500 characters. Anything else is 400 `INVALID_OVERRIDE`. An override replaces the plan's value rather than taking the larger, so staff can also restrict. Setting a new override for the same `(organization, kind, key)` marks the old one `removed`; there is at most one live plan override per organization.

### Errors

`ENTITLEMENTS_ERROR_CODES` holds these.

| Code | Status | When |
|---|---|---|
| `ORGANIZATION_PLUGIN_REQUIRED` | boot error | the organization plugin is missing |
| `ORGANIZATION_NOT_FOUND` | 404 | every gate failure and any unknown organization |
| `SESSION_NOT_ACCEPTED` | 403 | `acceptSession` returned false |
| `NOT_ALLOWED` | 403 | reserved; gates answer 404 |
| `INVALID_OVERRIDE` | 400 | an override failed validation |
| `OVERRIDE_NOT_FOUND` | 404 | removing a missing or non-active override |
| `ENTITLEMENTS_UNAVAILABLE` | 503 | a degraded read, a sync that threw, a usage read that threw |
| `INVALID_CURSOR` | 400 | a malformed list cursor, or a page past the tie bound |
| `UNKNOWN_KEY` | thrown `Error`, not HTTP | a key of the wrong kind from untyped callers. A bad `amount`, `count` or `adding` throws a plain `Error` with its own message instead |

### Events

Pass `onEvent` to receive these (`actorId` is the staff user for overrides and `null` otherwise). `data` never holds free text, so an override's `reason` stays out.

| `type` | When | `subject` | `data` |
|---|---|---|---|
| `entitlements.plan.changed` | a snapshot write changes the resolved plan key. Overrides never emit it: a plan override changes the plan without this event | organization | `{ from, to, status }` |
| `entitlements.override.set` | an override is created or replaced | `entitlementOverride` | `{ kind, key, value, expiresAt }` |
| `entitlements.override.removed` | staff removed an override (expiry emits nothing) | `entitlementOverride` | `{ kind, key }` |
| `entitlements.usage.limit_reached` | the first refusal of a metered key in a period | organization | `{ key, limit, periodEnd }` |

To tell the owners about a limit, route the event to [`@byo-oss/notifications`](https://github.com/byo-oss/notifications). `auth.api.notify` exists only when that package is installed and its `inbox()` plugin is in `plugins`; without it the call does not compile. Use the event's `type` as the notification `type` (SPEC P2), so the inbox's throttling and preferences apply to it:

```ts
// lib/auth-notify.ts
import { betterAuth } from "better-auth"
import { organization } from "better-auth/plugins/organization"
import { inbox } from "@byo-oss/notifications"
import { entitlements } from "@byo-oss/entitlements"
import { catalog } from "./catalog"

export const auth = betterAuth({
  plugins: [
    organization(),
    inbox(),
    entitlements({
      catalog,
      // annotate the return type so TypeScript doesn't infer `auth` from itself
      onEvent: async (event): Promise<void> => {
        if (event.type !== "entitlements.usage.limit_reached") return
        await auth.api.notify({
          body: {
            organizationId: event.organizationId,
            roles: ["owner", "admin"],
            type: event.type,
            title: `You reached your ${event.data.key} limit`,
            href: "/billing",
          },
        })
      },
    }),
  ],
})
```

### React

`@byo-oss/entitlements/react` has a headless hook and two thin components. Pass your auth client as a prop; there is no global.

```tsx
// components/exports.tsx
import { EntitlementGate, UsageMeter, useEntitlements } from "@byo-oss/entitlements/react"
import { authClient } from "../lib/auth-client"
import { catalog } from "../lib/catalog"

function ExportButton() {
  return <button type="button">Export</button>
}

export function Exports({ organizationId }: { organizationId: string }) {
  const entitlements = useEntitlements<typeof catalog>({ client: authClient, organizationId })
  return (
    <>
      <EntitlementGate
        entitlements={entitlements}
        feature="exports"
        catalog={catalog}
        fallback={({ upgradeTo }) => <a href="/billing">Upgrade to {upgradeTo[0]}</a>}
      >
        <ExportButton />
      </EntitlementGate>
      <UsageMeter entitlements={entitlements} limitKey="apiCalls" catalog={catalog} />
    </>
  )
}
```

- `useEntitlements` returns `{ data, isLoading, error, hasFeature(key), limit(key), usage(key), refresh() }`. `refresh()` calls `refreshEntitlements`; use it on return from checkout.
- `EntitlementGate` renders `children` when the feature is on, else `fallback(result)`; the result carries `upgradeTo` when you pass `catalog`. It renders no markup of its own.
- `UsageMeter` renders a `role="progressbar"` with `aria-valuenow`, `aria-valuemin`, `aria-valuemax` and an `aria-valuetext` such as "920 of 1,000 API calls used today". It uses shadcn tokens (`bg-muted`, `bg-primary`, `text-muted-foreground`); `className` styles the wrapper and `barClassName` the bar. `labels` overrides every string (`usage`, `loading`, `error`); the defaults are in `defaultLabels`.
- There are no router links and no repeated elements, so there is no `onNavigate` or `renderItem`.
- Tailwind v4 skips `node_modules`. Add this to the CSS file that imports Tailwind, with the path relative to that file:

  ```css
  @source "../node_modules/@byo-oss/entitlements/dist";
  ```

### Billing sources

A `BillingSource` tells the package what an organization has bought:

```ts
// the shape of BillingSource, which @byo-oss/entitlements exports
import type { AuthContext, DBTransactionAdapter } from "better-auth"
import type { BillingState } from "@byo-oss/entitlements"

export interface BillingSource {
  readonly id: string
  resolve(organizationId: string, ctx: { adapter: DBTransactionAdapter }): Promise<BillingState | null>
  connect?(context: AuthContext, changed: (organizationId: string) => Promise<void>): void | Promise<void>
}
```

`resolve` returns the current state (`planKey`, `status`, `periodStart`, `periodEnd`, `cancelAtPeriodEnd`, `seats`, `sourceRef`), or `null` for no subscription, and reads through `ctx.adapter`. A throw means "try again later": reads fall back to `defaultPlan` with `degraded: true` and the sweep backs off. There is no permanent-failure type, so a source that can't answer never drops an organization's paid plan.

**Stripe.** `fromBetterAuthStripe()` reads the `subscription` table of `@better-auth/stripe` and never writes it. Derive that plugin's `plans` from the catalog with `stripePlans` so the two can't drift:

```ts
// lib/auth-stripe.ts
import Stripe from "stripe"
import { betterAuth } from "better-auth"
import { organization } from "better-auth/plugins/organization"
import { stripe } from "@better-auth/stripe"
import { entitlements } from "@byo-oss/entitlements"
import { fromBetterAuthStripe, stripePlans } from "@byo-oss/entitlements/stripe"
import { ac, roles } from "./permissions"
import { catalog } from "./catalog"

export const auth = betterAuth({
  plugins: [
    organization({ ac, roles }),
    stripe({
      stripeClient: new Stripe(process.env.STRIPE_SECRET_KEY!),
      stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET!,
      organization: { enabled: true },
      subscription: {
        enabled: true,
        plans: stripePlans(catalog, { pro: { priceId: process.env.STRIPE_PRO_PRICE_ID! } }),
      },
    }),
    entitlements({ catalog, source: fromBetterAuthStripe() }),
  ],
})
```

- `stripePlans` sets each plan's `name` to the plan key and its `limits` to the catalog's limits. Those are for the Stripe plugin's own display and are never read back; Stripe holds which plan and status, the catalog holds what the plan allows.
- At boot it fails when a Stripe plan name isn't a catalog plan or alias, when `subscription.enabled` or `organization.enabled` is off, or when the Stripe plugin is missing. A plan with `group` logs a warning: one live plan per organization.
- It wraps the Stripe plugin's `onEvent` once. On `checkout.session.completed` and `customer.subscription.created`, `.updated` and `.deleted` it finds the organization, resyncs it, then calls your handler. An event for a user, a deleted organization or nothing known answers 200 and resyncs nothing; a failed resync throws, so the webhook answers 400 and Stripe redelivers. Create one `stripe()` plugin per `betterAuth()` instance.
- `resolve` picks the entitled subscription (active, then trialing, then past_due; latest `periodEnd` breaks ties). With none, it keeps the latest ended row so the snapshot records the last status.

**In tests.** `memorySource()` from `@byo-oss/entitlements/testing` is a settable in-memory source: `await source.set(organizationId, { planKey: "pro", status: "active" })`, and `source.setFailure(error)` makes `resolve` throw.

## Schema

The three tables are a public contract. They reference `organization` with `onDelete: "cascade"`; `user` references use `set null`. Nothing is added to `user`, `organization`, `member` or the Stripe plugin's tables. Rename any of it with the `schema` option.

**`entitlementSnapshot`**: one row per organization, the cached billing state.

| Field | Type | Notes |
|---|---|---|
| `id` | string | generated |
| `organizationId` | string, **unique** | references `organization.id`, cascade |
| `source` | string | the source's `id`, or `"none"`. A row whose `source` differs from the configured source's `id` counts as missing |
| `planKey` | string? | the source's plan key, lowercased; null = no subscription |
| `status` | string? | the provider status, verbatim |
| `periodStart`, `periodEnd` | date? | |
| `cancelAtPeriodEnd` | boolean | default `false` |
| `seats` | number? | paid quantity, when the provider has one |
| `pastDueSince` | date? | when this snapshot first saw `past_due`; null otherwise (the grace clock) |
| `sourceRef` | string? | for example the Stripe subscription id |
| `version` | number | default 0; every state write increments it |
| `syncedAt` | date | last successful resolve |
| `nextSyncAt` | date, indexed | when the sweep should resync |
| `syncState` | `"idle"` \| `"syncing"` | default `"idle"`; the sweep's claim |
| `syncClaimedAt` | date? | lease start |
| `syncAttempts` | number | default 0; reset on success |
| `syncError` | string? | last error, cleared on the next success |
| `createdAt`, `updatedAt` | date | |

**`entitlementOverride`**: staff grants, kept after they end.

| Field | Type | Notes |
|---|---|---|
| `id` | string | generated |
| `organizationId` | string, indexed | references `organization.id`, cascade |
| `status` | `"active"` \| `"removed"` \| `"expired"` | indexed |
| `kind` | `"plan"` \| `"feature"` \| `"limit"` | |
| `key` | string | a plan, feature or limit key |
| `value` | string | JSON: plan `null`; feature `true` or `false`; limit a non-negative integer or `"unlimited"` |
| `reason` | string | required, 1 to 500 characters |
| `permanent` | boolean | true when `expiresAt` is null |
| `expiresAt` | date? | null = until removed |
| `endedAt` | date? | set when removed or expired |
| `createdBy`, `removedBy` | string?, indexed | reference `user.id`, `set null` |
| `createdAt` | date | |

**`entitlementUsage`**: one counter per organization, metered key and period.

| Field | Type | Notes |
|---|---|---|
| `id` | string | generated |
| `bucket` | string, **unique** | `${organizationId}:${key}:${periodStart ISO}`, the race-safe lookup key |
| `organizationId` | string, indexed | references `organization.id`, cascade |
| `key` | string | metered limit key |
| `periodStart`, `periodEnd` | date | `periodEnd` is indexed (retention prune) |
| `used` | number | default 0 |
| `refused` | number | default 0; refusals this period (the first emits `limit_reached`) |
| `createdAt`, `updatedAt` | date | |

Indexes are declared on the plugin schema (`index: true`, `unique: true`).

**Don't read these tables from app code.** They are a contract for migrations and exports, not an API. Gate through `createEntitlements`, `auth.api.*` and the client, so the day you move to another tool only those call sites change (see Outgrowing this).

**MongoDB.** The adapter creates no unique indexes from the schema, so two are required: `entitlementSnapshot.organizationId` and `entitlementUsage.bucket`, both unique. Without them, concurrent first writes from several processes can create duplicates and over-allow.

## Freshness

The billing provider is the source of truth; the snapshot is a cache of it. It is kept fresh five ways:

1. **Push.** A source's events resync one organization at once (Stripe: the events listed under Billing sources). `memorySource().set` does the same in tests.
2. **Read-through.** The first read of an organization with no snapshot resolves from the source and writes one (also when there is no subscription, so the next read is local). Reads inside a transaction resolve without writing.
3. **Background refresh.** A snapshot older than `maxAge` is served, then refreshed: through `context.runInBackground` when `advanced.backgroundTasks.handler` is configured, else marked due so the next sweep takes it.
4. **Sweep.** Call `auth.api.processEntitlementsSync()` from a cron (every minute is fine) and again while `hasMore` is true, or let `sweepAll(auth)` from `@byo-oss/core` run every installed BYO plugin. It claims due snapshots with a lease, resolves them, backs off (1 minute, doubling, capped at `maxAge`) on a throwing source, marks overrides past `expiresAt` as `expired`, and prunes old usage and override rows. After `maxAttempts` a snapshot counts as `failed`: it keeps its last good state and is retried at the normal pace, never frozen. Without a `source` only expiry and pruning run.
5. **Refresh after checkout.** `refreshEntitlements` always bypasses the cache and syncs now. Call it when the user returns from checkout, because the webhook may arrive later. Writes the Stripe plugin makes outside its webhook (the `/subscription/success` redirect, upgrade, cancel) are picked up by the next of these.

**Staleness across processes.** Each process caches resolved entitlements for up to `cacheTtlMs` (default 30 seconds) and clears its own entry on its own writes (sync, override) and on `invalidate`. A write made in another process can therefore show up here up to `cacheTtlMs` late. `refreshEntitlements` is never stale. Set `cacheTtlMs: 0` to read through every time, and call `invalidate(orgId)` when an app-side input to `resolveEntitlements` changes. Usage counters are never cached.

**`incrementOne` atomicity.** `consumeUsage` is one `incrementOne` guarded on `used <= limit - amount`, so the count and the limit check happen in one statement.

| Adapter | Guarantee |
|---|---|
| Kysely, Drizzle (better-auth 1.7.7 and later) | the guard is re-applied on the `UPDATE` itself: exact |
| Memory, Prisma, MongoDB | native guarded increment: exact |
| A custom adapter without its own `incrementOne` | better-auth's fallback guards on the prior value and retries 5 times, then throws. Under contention `consumeUsage` answers `onError` (deny by default) rather than over-allowing |

Earlier better-auth versions guard only a subquery on Postgres, which is why the peer floor is `^1.7.7`.

## Inside a transaction

Every function and endpoint reads and writes through better-auth's `getCurrentAdapter`, so a call made inside your `runWithTransaction` uses that transaction instead of the outer connection. The rules apply to adapters with real transactions; on one without (Kysely without `transaction: true`) detection reads "outside", which is safe because there is nothing to wait on or roll back.

- `get`, `getMany`, `hasFeature`, `getLimit` and `checkCapacity` work inside a transaction. They may read the cache but never write it, never persist a snapshot (a missing one resolves without writing) and never schedule a refresh; the next read outside a transaction refreshes.
- `consumeUsage`, `sync(orgId)` and `refreshEntitlements` throw `[@byo-oss/entitlements] <name> must run outside a transaction`, because a bucket or snapshot create could abort your transaction and a consumption rolled back with it would be invisible to others. Call them before or after the transaction.
- `processEntitlementsSync`, `byo.sweep` and `@byo-oss/core`'s `sweepAll` join your transaction instead of throwing, and roll back with it: the sweep only updates and deletes existing rows, so it can't abort the transaction with a create conflict. Their `plan.changed` events are emitted before you commit.
  - Inside a joined transaction the cache entry is cleared before the commit, so a read made outside the transaction in that window can re-cache the old state until `cacheTtlMs`. Override writes made inside a transaction behave the same way.
  - On Postgres, a database error inside a joined sweep aborts your transaction: the sweep reports `retrying` and your commit then fails. Run sweeps outside app transactions unless you want them to roll back together.
- Override writes (`setEntitlementOverride`, `removeEntitlementOverride`) join the transaction and roll back with it.
- **Events fire before you commit.** The public `better-auth` entry exports no after-commit hook, so 0.1.0 emits an event when the adapter write returns. Inside a caller's transaction (an override write, or a sweep) an event can therefore announce a write that later rolls back. Emitting after commit is a follow-up.
- The source's `resolve` receives the current adapter.

## Delivery guarantees

- **Syncs** write absolute state, so a repeat is harmless.
- **`consumeUsage`** counts exactly once per call that returns `allowed`, and refusals never count. A caller that retries a call it believes failed can count twice; v0 has no idempotency key.
- **Events** are best-effort and at most once, in-process. An `onEvent` that throws is logged and never fails the call.
- **Sweeps** are at-least-once with an atomic claim and a lease; two sweeps never both own a row.
- **Lifecycle cleanup** failures are logged without failing the response; run `deleteOrganizationData` to retry.

### Lifecycle

- Deleting an organization through `/organization/delete` removes its usage rows, overrides and snapshot (`organizationCleanup`, on by default). For deletes made another way, call `deleteOrganizationData(auth, organizationId)`, for example:

  ```ts
  // lib/purge.ts (server only)
  import { deleteOrganizationData } from "@byo-oss/entitlements"
  import { auth } from "./auth"

  export async function purgeOrganization(organizationId: string): Promise<void> {
    await deleteOrganizationData(auth, organizationId)
  }
  ```

- With `organizationCleanup: false`, SQL adapters still cascade through the foreign keys; the memory adapter and MongoDB keep the rows until `deleteOrganizationData` runs.
- Deleting a user clears `createdBy` and `removedBy` on overrides (a hook, so memory and MongoDB match SQL's `set null`). Overrides keep their author after that person leaves the staff organization.
- Nothing is stored per member, so there is no member cleanup.

## Outgrowing this

**Signs it is time to move:**

- you bill by usage;
- you need credits, rollover or top-ups;
- you sell add-ons across several live plans;
- non-engineers need to edit plans;
- entitlements must be answered across regions faster than one database can.

**Targets:** Stripe Entitlements (booleans only; your numeric limits stay in code), Autumn (features, limits and usage), Schematic, Stigg.

**Field mappings:**

| This package | Stripe Entitlements | Autumn |
|---|---|---|
| a catalog feature | an `entitlements.feature` whose `lookup_key` is the feature key, plus a `product_feature` on each plan's product that includes it | `features.create` with type `boolean`, and the plan `items[]` that include it |
| a metered limit | no counterpart: keep the number in code | `features.create` with type `metered` (consumable), plan `items[]` with `included` (or `unlimited`) and `reset.interval` from the period |
| a capacity or value limit | no counterpart: keep the number in code | a plan `items[]` entry carrying the included amount |
| an override | none | a custom plan, or `balances.create` |
| usage rows (`entitlementUsage`) | none | `balances.update` at cut-over |

**Steps:**

1. Run both in parallel: keep calling `consumeUsage` and mirror each call to the new tool's `track`.
2. Backfill the new tool from `exportEntitlementsData` (snapshots, overrides, usage).
3. Cut over the call sites. The surface to replace is small: the `createEntitlements` methods and the React hook.
4. Uninstall this package.

## Export

`exportEntitlementsData(auth, { organizationId?, cursor?, limit? })` returns snapshots, overrides (every status) and usage rows as plain JSON in the documented schema. Every row carries `organizationId`; overrides also carry `createdByEmail` and `removedByEmail`. `limit` is 1 to 1000 (default 100). A page holds rows of one model, in the order snapshots, overrides, usage; the other lists are empty.

```ts
// scripts/export.ts (server only)
import { writeFile } from "node:fs/promises"
import { exportEntitlementsData } from "@byo-oss/entitlements"
import { auth } from "../lib/auth"

export async function exportOrganization(organizationId: string): Promise<void> {
  let cursor: string | null = null
  let n = 0
  do {
    const page = await exportEntitlementsData(auth, { organizationId, cursor })
    await writeFile(`entitlements-${n++}.json`, JSON.stringify(page))
    cursor = page.nextCursor
  } while (cursor)
}
```

Pages use an offset over `id` order, so a row deleted mid-export shifts later rows back and one of them can be missed; export from a quiet database. The catalog is not exported because it is your own code. A malformed cursor throws `[@byo-oss/entitlements] invalid export cursor`.

The staff list (`listEntitlementOverrides`) uses a keyset cursor instead and pages up to 50 per page. Overrides that share one `createdAt` page out correctly up to 250 rows; past that the next page answers 400 `INVALID_CURSOR`. Staff-written rows never come close.

## Uninstall

1. Remove `entitlements()` from `plugins`. If you used `stripePlans`, replace it with a plain `plans` array; the Stripe plugin keeps working.
2. Drop the tables, in this order:

   ```sql
   drop table "entitlementUsage";
   drop table "entitlementOverride";
   drop table "entitlementSnapshot";
   ```

   None references another, so any order works. Nothing remains on better-auth's tables or the Stripe plugin's.

## Community adapters

A billing provider other than Stripe is a package named `byo-entitlements-<provider>` that exports a `BillingSource` (for example `byo-entitlements-polar`). Known adapters: none yet. The contract:

- `id` is a non-empty string other than `"none"`; it is stored on snapshots.
- `resolve(organizationId, { adapter })` returns the current `BillingState` or `null`, reads only through `ctx.adapter`, never mutates its inputs and throws to retry.
- `connect(context, changed)`, if present, wires the provider's push. Call `await changed(organizationId)` after a change and let its rejection propagate, so the provider retries. `changed` has already logged it.
- Moving from a paid state to `null`, or to a state without `periodEnd`, must end on `defaultPlan`.

Run the contract suite (vitest, ESM) against it. `setup` builds a real better-auth with your source and an organization (the catalog needs a plan other than `defaultPlan`); `failing` builds one whose `resolve` always throws. Replace the `Map` below with your provider's client:

```ts
// src/source.test.ts
import { betterAuth } from "better-auth"
import { memoryAdapter } from "better-auth/adapters/memory"
import { getAuthTables } from "better-auth/db"
import { organization } from "better-auth/plugins/organization"
import { entitlements, type BillingSource, type BillingState } from "@byo-oss/entitlements"
import { defineEntitlements } from "@byo-oss/entitlements/catalog"
import { testBillingSource } from "@byo-oss/entitlements/testing"

const catalog = defineEntitlements({
  features: ["exports"],
  limits: { projects: { kind: "capacity" } },
  plans: {
    free: { features: { exports: false }, limits: { projects: 3 } },
    pro: { features: { exports: true }, limits: { projects: "unlimited" } },
  },
  defaultPlan: "free",
})

// stands in for your package's source
function createSource(states: Map<string, BillingState | null>, failing = false): BillingSource {
  return {
    id: "acme",
    async resolve(organizationId) {
      if (failing) throw new Error("provider is down")
      const state = states.get(organizationId)
      return state ? structuredClone(state) : null
    },
  }
}

async function build(source: BillingSource) {
  const options = {
    secret: "test_secret",
    emailAndPassword: { enabled: true },
    plugins: [organization(), entitlements({ catalog, source })],
  }
  // the memory adapter needs one empty array per table
  const tables: Record<string, object[]> = {}
  for (const table of Object.keys(getAuthTables(options))) tables[table] = []
  const auth = betterAuth({ ...options, database: memoryAdapter(tables) })
  const { user } = await auth.api.signUpEmail({
    body: { email: "owner@acme.test", password: "test_secret", name: "Owner" },
  })
  const created = await auth.api.createOrganization({
    body: { name: "Acme", slug: "acme", userId: user.id },
  })
  return { auth, organizationId: created.id }
}

testBillingSource({
  name: "acme source",
  setup: async () => {
    const states = new Map<string, BillingState | null>()
    const source = createSource(states)
    return {
      source,
      ...(await build(source)),
      setState: async (organizationId, state) => {
        states.set(organizationId, state)
      },
    }
  },
  failing: async () => {
    const source = createSource(new Map(), true)
    return { source, ...(await build(source)) }
  },
})
```

## What this is not (yet)

Not in v0:

- Checkout, the customer portal, invoices and seat sync to Stripe: `@better-auth/stripe` does these.
- Usage-based billing (reporting usage to Stripe Meters) and invoicing: Stripe Billing Meters, Metronome, Orb.
- Credits, rollover, top-ups, spend limits and reserve/finalize locks: Autumn, Schematic.
- Abuse rate limits (per IP, per key): better-auth `rateLimit`.
- Percentage rollouts and temporary flags: your feature-flag tool.
- Prices in the catalog: prices live in Stripe.
- Counting seats or members: you supply the count.

Later, when someone needs it:

- user-scoped subscriptions (organizations only for now);
- add-ons and several live plans per organization;
- `BillingSource.list` and a backfill for every organization's snapshot;
- a direct Stripe API source with its own webhook, for apps without `@better-auth/stripe`;
- a Polar source;
- idempotency keys on `consumeUsage`;
- an export-to-Stripe-Entitlements script and an Autumn config generator.

## License

MIT
