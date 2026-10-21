// BYO_STUB: N09 replaces this file (contracts.md "testing/contract.ts")
import type { BillingSource, BillingState } from "../types";

/**
 * A test auth for the contract suite: a real `betterAuth` (memory adapter)
 * with the organization plugin, `entitlements({ catalog, source })` and the
 * source's own plugins, plus one existing organization. The catalog must
 * have at least one plan other than `defaultPlan`.
 */
export type BillingSourceTestSetup = {
  source: BillingSource;
  auth: { $context: Promise<object> };
  /** An existing organization with no billing state yet. */
  organizationId: string;
  /** Makes the provider report `state` for the organization (`null`: none). */
  setState(organizationId: string, state: BillingState | null): Promise<void>;
};

export type TestBillingSourceOptions = {
  /** Suite name. @default `BillingSource "<source.id>"` */
  name?: string;
  /** Builds a fresh setup; called once per test. */
  setup: () => Promise<BillingSourceTestSetup>;
  /** Builds a setup whose source's `resolve` always throws. Required. */
  failing: () => Promise<Omit<BillingSourceTestSetup, "setState">>;
};

/**
 * Registers the `BillingSource` contract suite with vitest (`describe`/`it`):
 * the call shape; `null` for an organization without state; the state set
 * comes back; inputs aren't mutated; a throwing `resolve` gives a
 * `degraded` resolution and persists nothing; a paid state going to `null`,
 * or to one without `periodEnd`, ends with `planKey`/`periodEnd` null and
 * `defaultPlan`; `connect`, when present, is awaited and `changed`
 * resyncs. ESM only (imports `vitest`).
 * Stub: registers nothing.
 */
export function testBillingSource(_options: TestBillingSourceOptions): void {}
