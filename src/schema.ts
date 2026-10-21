import type { BetterAuthPlugin, InferOptionSchema } from "better-auth";
import { mergeSchema } from "better-auth/db";
import type { LimitValue } from "./catalog";

type PluginSchema = NonNullable<BetterAuthPlugin["schema"]>;

// Model order is the migration order. None references another, so the three
// tables can be dropped in any order (uninstall).

const entitlementSnapshot = {
  fields: {
    organizationId: {
      type: "string",
      required: true,
      unique: true,
      references: { model: "organization", field: "id", onDelete: "cascade" },
    },
    source: { type: "string", required: true },
    planKey: { type: "string", required: false },
    status: { type: "string", required: false },
    periodStart: { type: "date", required: false },
    periodEnd: { type: "date", required: false },
    cancelAtPeriodEnd: {
      type: "boolean",
      required: true,
      defaultValue: false,
    },
    seats: { type: "number", required: false },
    pastDueSince: { type: "date", required: false },
    sourceRef: { type: "string", required: false },
    version: { type: "number", required: true, defaultValue: 0 },
    syncedAt: { type: "date", required: true },
    nextSyncAt: { type: "date", required: true, index: true },
    syncState: { type: "string", required: true, defaultValue: "idle" },
    syncClaimedAt: { type: "date", required: false },
    syncAttempts: { type: "number", required: true, defaultValue: 0 },
    syncError: { type: "string", required: false },
    createdAt: { type: "date", required: true },
    updatedAt: { type: "date", required: true },
  },
} as const;

const entitlementOverride = {
  fields: {
    organizationId: {
      type: "string",
      required: true,
      index: true,
      references: { model: "organization", field: "id", onDelete: "cascade" },
    },
    status: { type: "string", required: true, index: true },
    kind: { type: "string", required: true },
    key: { type: "string", required: true },
    value: { type: "string", required: true },
    reason: { type: "string", required: true },
    permanent: { type: "boolean", required: true },
    expiresAt: { type: "date", required: false },
    endedAt: { type: "date", required: false },
    createdBy: {
      type: "string",
      required: false,
      index: true,
      references: { model: "user", field: "id", onDelete: "set null" },
    },
    removedBy: {
      type: "string",
      required: false,
      index: true,
      references: { model: "user", field: "id", onDelete: "set null" },
    },
    createdAt: { type: "date", required: true },
  },
} as const;

const entitlementUsage = {
  fields: {
    bucket: { type: "string", required: true, unique: true },
    organizationId: {
      type: "string",
      required: true,
      index: true,
      references: { model: "organization", field: "id", onDelete: "cascade" },
    },
    key: { type: "string", required: true },
    periodStart: { type: "date", required: true },
    periodEnd: { type: "date", required: true, index: true },
    used: { type: "number", required: true, defaultValue: 0 },
    refused: { type: "number", required: true, defaultValue: 0 },
    createdAt: { type: "date", required: true },
    updatedAt: { type: "date", required: true },
  },
} as const;

/** The three models, as declared (read-only reference; `buildSchema` copies it). */
export const fullSchema = {
  entitlementSnapshot,
  entitlementOverride,
  entitlementUsage,
} satisfies PluginSchema;

export type EntitlementsSchema = typeof fullSchema;

/** The model names, in migration order. */
export const ENTITLEMENTS_MODELS = [
  "entitlementSnapshot",
  "entitlementOverride",
  "entitlementUsage",
] as const;

export type EntitlementsModel = (typeof ENTITLEMENTS_MODELS)[number];

/** `options.schema`: rename tables (`modelName`) and columns (`fields`). */
export type EntitlementsSchemaOption = InferOptionSchema<EntitlementsSchema>;

/**
 * The plugin schema with the app's renames applied. Returns a fresh deep
 * copy every call, because `mergeSchema` writes renames into its input.
 */
export function buildSchema(
  renames?: EntitlementsSchemaOption,
): EntitlementsSchema {
  return mergeSchema(structuredClone(fullSchema), renames);
}

// ---------------------------------------------------------------------------
// Rows (as the adapter returns them; optional columns are `T | null`)
// ---------------------------------------------------------------------------

export type SyncState = "idle" | "syncing";

export type EntitlementSnapshotRow = {
  id: string;
  organizationId: string;
  /** The source's `id`, or `"none"` when no source is configured. */
  source: string;
  /** The source's plan key, lowercased; null = no subscription. */
  planKey: string | null;
  /** The provider status, verbatim. */
  status: string | null;
  periodStart: Date | null;
  periodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  seats: number | null;
  /** When this snapshot first saw `past_due`; null otherwise (the grace clock). */
  pastDueSince: Date | null;
  sourceRef: string | null;
  /** Incremented by every state write (the sweep's write guard). */
  version: number;
  syncedAt: Date;
  nextSyncAt: Date;
  syncState: SyncState;
  syncClaimedAt: Date | null;
  syncAttempts: number;
  syncError: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type OverrideKind = "plan" | "feature" | "limit";
export type OverrideStatus = "active" | "removed" | "expired";

export const OVERRIDE_KINDS = ["plan", "feature", "limit"] as const;
export const OVERRIDE_STATUSES = ["active", "removed", "expired"] as const;

export type EntitlementOverrideRow = {
  id: string;
  organizationId: string;
  status: OverrideStatus;
  kind: OverrideKind;
  /** A plan, feature or limit key of the catalog. */
  key: string;
  /** JSON: plan → `null`, feature → `true | false`, limit → integer or `"unlimited"`. */
  value: string;
  reason: string;
  /** True when `expiresAt` is null. */
  permanent: boolean;
  expiresAt: Date | null;
  endedAt: Date | null;
  createdBy: string | null;
  removedBy: string | null;
  createdAt: Date;
};

export type EntitlementUsageRow = {
  id: string;
  /** `${organizationId}:${key}:${periodStart ISO}` */
  bucket: string;
  organizationId: string;
  key: string;
  periodStart: Date;
  periodEnd: Date;
  used: number;
  refused: number;
  createdAt: Date;
  updatedAt: Date;
};

/** An override's decoded value: plan → null, feature → boolean, limit → a limit value. */
export type OverrideValue = boolean | LimitValue | null;

/** Encodes an override value for the `value` column (JSON). */
export function encodeOverrideValue(value: OverrideValue): string {
  return JSON.stringify(value);
}

/**
 * Decodes the `value` column. Returns `undefined` for a value that isn't
 * valid for `kind`, so a hand-edited row is ignored rather than trusted.
 */
export function decodeOverrideValue(
  kind: OverrideKind,
  raw: string,
): OverrideValue | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (kind === "plan") return value === null ? null : undefined;
  if (kind === "feature") return typeof value === "boolean" ? value : undefined;
  if (
    value === "unlimited" ||
    (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
  ) {
    return value as LimitValue;
  }
  return undefined;
}
