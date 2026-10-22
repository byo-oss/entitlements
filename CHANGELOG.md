# Changelog

## 0.1.0

First release. Plans, features, limits and usage for better-auth apps, kept in your own database.

- **Catalog.** `defineEntitlements` declares features, limits (`metered`, `capacity`, `value`), plans and a default plan once. The catalog is typed and browser-safe (`@byo-oss/entitlements/catalog`), so the server, the web app and a static pricing page share one file. Each plan's `display` copy keeps its own type.
- **Checks.** `createEntitlements(auth, catalog)` returns typed `get`, `getMany`, `hasFeature`, `getLimit`, `consumeUsage` and `checkCapacity`.
  - `consumeUsage` is atomic and never counts a refusal. The first refusal in each period emits `entitlements.usage.limit_reached`.
  - A refusal's `upgradeTo` lists only plans that are strictly better on that key.
  - Results are read-only.
- **Billing state.** A per-organization snapshot is synced from a `BillingSource`. The first-party `@byo-oss/entitlements/stripe` source reads `@better-auth/stripe`'s subscriptions and chains its `onEvent`, so you don't need a second webhook.
  - Concurrent pushes, refreshes and sweeps can't overwrite newer state.
  - `past_due` keeps the plan for `pastDueGraceDays` (default 7).
- **Staff overrides.** Plan, feature or limit overrides with a reason and an optional expiry, set by members of a staff organization. They're kept after they end, for the audit trail.
- **Endpoints.** `getEntitlements`, `refreshEntitlements` and the staff override endpoints. An organization you can't read answers 404.
- **Background work.** `processEntitlementsSync` (and `byo.sweep` for `@byo-oss/core`'s `sweepAll`) resyncs due snapshots, expires overrides and prunes old usage, under one `batchSize` budget per call.
- **Transactions.** Reads and capacity checks work inside your `runWithTransaction`, and so does the sweep, which joins the transaction. Events from a write inside a transaction fire after commit, never on rollback.
- **Lifecycle.** Automatic cleanup after an organization is deleted, plus `deleteOrganizationData`. User deletion clears the override author fields. `exportEntitlementsData` exports everything.
- **React.** `useEntitlements`, `EntitlementGate` and `UsageMeter` on shadcn tokens, with `labels`.
- **Testing.** `@byo-oss/entitlements/testing` has `testBillingSource` (a contract suite for sources) and `memorySource()`.
- **Requirements.** Peers: `better-auth ^1.7.7`, `@better-auth/core ^1.7.7`, `better-call ^1.4.0`, `zod ^4`. Optional peers: `@better-auth/stripe ^1.7.7`, `react`, `vitest`.
