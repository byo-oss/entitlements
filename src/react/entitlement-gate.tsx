import type { ReactNode } from "react";
import {
  type AnyCatalog,
  type FeatureKey,
  type PlanKey,
  upgradeTo,
} from "../catalog";
import type { UseEntitlementsResult } from "./use-entitlements";

/** What `fallback` receives when the feature isn't allowed. */
export type EntitlementGateResult<C extends AnyCatalog = AnyCatalog> = {
  allowed: false;
  key: FeatureKey<C>;
  isLoading: boolean;
  /** Plans that include the feature, in catalog order, without the plan the organization is already on. */
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
 * No markup of its own. While loading the feature is not allowed, so
 * `fallback` runs with `isLoading: true`.
 */
export function EntitlementGate<C extends AnyCatalog = AnyCatalog>(
  props: EntitlementGateProps<C>,
): ReactNode {
  const { entitlements, feature, catalog, children, fallback } = props;
  if (entitlements.hasFeature(feature)) return children ?? null;
  if (!fallback) return null;
  const currentPlan = entitlements.data?.plan.key;
  return fallback({
    allowed: false,
    key: feature,
    isLoading: entitlements.isLoading,
    upgradeTo: catalog
      ? upgradeTo(catalog, { feature }).filter((plan) => plan !== currentPlan)
      : [],
  });
}
