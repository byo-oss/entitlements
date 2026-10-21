// BYO_STUB: N11 replaces this file (contracts.md "react/entitlement-gate.tsx")
import type { ReactNode } from "react";
import type { AnyCatalog, FeatureKey, PlanKey } from "../catalog";
import type { UseEntitlementsResult } from "./use-entitlements";

/** What `fallback` receives when the feature isn't allowed. */
export type EntitlementGateResult<C extends AnyCatalog = AnyCatalog> = {
  allowed: false;
  key: FeatureKey<C>;
  isLoading: boolean;
  /** Plans that include the feature, in catalog order. */
  upgradeTo: PlanKey<C>[];
};

export type EntitlementGateProps<C extends AnyCatalog = AnyCatalog> = {
  /** What `useEntitlements` returned. */
  entitlements: UseEntitlementsResult<C>;
  feature: FeatureKey<C>;
  /** The catalog, for `upgradeTo` in the fallback result; without it `upgradeTo` is `[]`. */
  catalog?: C;
  children?: ReactNode;
  fallback?: (result: EntitlementGateResult<C>) => ReactNode;
};

/**
 * Renders `children` when the feature is allowed, else `fallback(result)`.
 * No markup of its own. Stub: renders nothing.
 */
export function EntitlementGate<C extends AnyCatalog = AnyCatalog>(
  _props: EntitlementGateProps<C>,
): ReactNode {
  return null;
}
