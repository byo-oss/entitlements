import type { ByoPlugin } from "@byo-oss/core";
import type { BetterAuthPlugin } from "better-auth";
import type { AnyCatalog } from "./catalog";
import { ENTITLEMENTS_ERROR_CODES } from "./error-codes";
import {
  deleteOrganizationData,
  organizationCleanupHook,
  userDeleteHook,
} from "./lifecycle";
import { type EntitlementsOptions, resolveOptions } from "./options";
import { syncOrganization } from "./resolve";
import { overrideEndpoints } from "./routes/overrides";
import { readEndpoints } from "./routes/read";
import { sweepEndpoints } from "./routes/sweep";
import { createRuntime, PLUGIN_ID, runtimeFromAuth } from "./runtime";
import { buildSchema } from "./schema";
import { runSync } from "./sync";

const PREFIX = "[@byo-oss/entitlements]";

/**
 * Plan entitlements for better-auth: features, limits and usage per
 * organization, in your own database. Requires the organization plugin
 * (list it before this one).
 *
 * ```ts
 * betterAuth({
 *   plugins: [organization(), entitlements({ catalog, source })],
 * })
 * ```
 */
export const entitlements = <C extends AnyCatalog>(
  options: EntitlementsOptions<C>,
) => {
  const rt = createRuntime(resolveOptions(options));
  return {
    id: PLUGIN_ID,
    schema: buildSchema(rt.options.schema),
    endpoints: {
      ...readEndpoints(rt),
      ...overrideEndpoints(rt),
      ...sweepEndpoints(rt),
    },
    init: async (context) => {
      if (
        !context.options.plugins?.some((plugin) => plugin.id === "organization")
      ) {
        throw new Error(
          `${PREFIX} ${ENTITLEMENTS_ERROR_CODES.ORGANIZATION_PLUGIN_REQUIRED.code}: add organization() to plugins before entitlements(); every entitlements table references organization`,
        );
      }
      rt.context = context;
      rt.logger = context.logger;
      if (!rt.options.staffOrganizationId && !rt.options.authorize) {
        context.logger.warn(
          `${PREFIX} no staffOrganizationId and no authorize: the override endpoints will deny every call`,
        );
      }
      // `changed` logs a failed resync once and rethrows it to the source
      await rt.options.source?.connect?.(context, async (organizationId) => {
        try {
          await syncOrganization(rt, organizationId);
        } catch (error) {
          rt.logger.error(
            `${PREFIX} resync after a billing change failed for organization ${organizationId}`,
            error,
          );
          throw error;
        }
      });
      return {
        options: {
          databaseHooks: {
            user: { delete: { after: userDeleteHook(rt) } },
          },
        },
      };
    },
    hooks: {
      after: rt.options.organizationCleanup ? organizationCleanupHook(rt) : [],
    },
    $ERROR_CODES: ENTITLEMENTS_ERROR_CODES,
    // the runtime: `runtimeFromAuth` reads it for the exported functions
    options: rt,
    byo: {
      sweep: async (auth) =>
        runSync(await runtimeFromAuth(auth, "processEntitlementsSync")),
      deleteOrganizationData: (auth, organizationId) =>
        deleteOrganizationData(auth, organizationId),
    },
  } satisfies ByoPlugin<BetterAuthPlugin>;
};

export type EntitlementsPlugin = ReturnType<typeof entitlements>;

export {
  createEntitlements,
  type Entitlements,
  type GetLimitResult,
} from "./api";
// the public catalog API (the same list as catalog-entry.ts)
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
export {
  ENTITLEMENTS_ERROR_CODES,
  type EntitlementsErrorCode,
} from "./error-codes";
export {
  ENTITLEMENTS_EVENT_TYPES,
  type EntitlementsEvent,
  type EntitlementsEventData,
  type EntitlementsEventType,
} from "./events";
export {
  type EntitlementsExportPage,
  type ExportEntitlementsDataOptions,
  type ExportedOverride,
  type ExportedSnapshot,
  type ExportedUsage,
  exportEntitlementsData,
} from "./export";
export { deleteOrganizationData } from "./lifecycle";
export type {
  EntitlementsAcceptSession,
  EntitlementsAcceptSessionInput,
  EntitlementsAuthorize,
  EntitlementsAuthorizeInput,
  EntitlementsCheckOperation,
  EntitlementsOnError,
  EntitlementsOptions,
  EntitlementsSession,
  IsEntitled,
  ResolveEntitlementsHook,
  ResolveEntitlementsInput,
} from "./options";
export type {
  EntitlementOverrideRow,
  EntitlementSnapshotRow,
  EntitlementsSchemaOption,
  EntitlementUsageRow,
  OverrideKind,
  OverrideStatus,
  SyncState,
} from "./schema";
export {
  type EntitlementsAction,
  entitlementsStatements,
} from "./statements";
export type {
  AppliedOverride,
  BillingSource,
  BillingState,
  CapacityResult,
  CheckReason,
  ConsumeResult,
  EntitlementOverride,
  EntitlementsResponse,
  EntitlementsResponseOverride,
  EntitlementsResult,
  EntitlementsSweepResult,
  FeatureCheckResult,
  LimitResult,
  ListOverridesResponse,
  MeteredLimitResult,
  PlanSource,
  RemoveOverrideResponse,
  SetOverrideResponse,
  UsageInfo,
  Wire,
} from "./types";
