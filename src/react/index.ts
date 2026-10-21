/**
 * `@byo-oss/entitlements/react`: a headless hook and two thin components.
 * Pass your better-auth client as a prop; there is no global client.
 */
export {
  EntitlementGate,
  type EntitlementGateProps,
  type EntitlementGateResult,
} from "./entitlement-gate";
export { defaultLabels, type UsageMeterLabels } from "./labels";
export { UsageMeter, type UsageMeterProps } from "./usage-meter";
export {
  type EntitlementsClientLike,
  type UseEntitlementsResult,
  useEntitlements,
} from "./use-entitlements";
