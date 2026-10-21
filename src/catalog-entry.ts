/**
 * `@byo-oss/entitlements/catalog`: the catalog API, safe in any bundle
 * (imports nothing outside this package). `.` and `./client` re-export the
 * same names. The catalog helpers that resolution uses internally are not
 * part of the public API.
 */
export {
  type AnyCatalog,
  type CapacityKey,
  type CapacityLimitDefinition,
  type Catalog,
  type CatalogInput,
  defineEntitlements,
  type FeatureKey,
  type LimitDefinition,
  type LimitKey,
  type LimitKind,
  type LimitValue,
  type MeteredKey,
  type MeteredLimitDefinition,
  type MeteredPeriod,
  type PlanAliasKey,
  type PlanDefinition,
  type PlanKey,
  type UpgradeTarget,
  upgradeTo,
  type ValueKey,
  type ValueLimitDefinition,
} from "./catalog";
