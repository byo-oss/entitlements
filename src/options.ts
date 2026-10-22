import type { ByoEventHandler } from "@byo-oss/core";
import { defaultAcceptSession } from "./access";
import {
  type AnyCatalog,
  type FeatureKey,
  type LimitKey,
  type LimitValue,
  type PlanKey,
  validateCatalog,
} from "./catalog";
import type {
  EntitlementSnapshotRow,
  EntitlementsSchemaOption,
} from "./schema";
import { isDefaultEntitled } from "./snapshot";
import type { EntitlementsAction } from "./statements";
import type { BillingSource } from "./types";

const PREFIX = "[@byo-oss/entitlements]";

// ---------------------------------------------------------------------------
// Option types
// ---------------------------------------------------------------------------

/** A better-auth session as entitlements reads it (`getSessionFromCtx`). */
export type EntitlementsSession = {
  session: {
    id: string;
    userId: string;
    /** Set by the admin plugin while an admin impersonates the user. */
    impersonatedBy?: string | null;
  } & Record<string, unknown>;
  user: { id: string; email: string } & Record<string, unknown>;
};

/** What `authorize` receives (SPEC §4.3). */
export type EntitlementsAuthorizeInput = {
  session: EntitlementsSession;
  headers: Headers | undefined;
  /**
   * The organization the permission is checked in: the target organization
   * for member reads, `staffOrganizationId` for staff calls. Undefined →
   * deny.
   */
  organizationId: string | undefined;
  permissions: { entitlements: EntitlementsAction[] };
};

/** Decides whether a session holds `permissions` in `organizationId`. */
export type EntitlementsAuthorize = (
  input: EntitlementsAuthorizeInput,
) => boolean | Promise<boolean>;

/** What `acceptSession` receives, after `authorize` passed. */
export type EntitlementsAcceptSessionInput = {
  session: EntitlementsSession;
  headers: Headers | undefined;
  /** `member`: the caller's own organization; `staff`: through the staff organization. */
  kind: "member" | "staff";
  method: "GET" | "POST";
  /** The endpoint path, e.g. `/entitlements/override/set`. */
  path: string;
};

/** Returns false to refuse a session (403 `SESSION_NOT_ACCEPTED`). */
export type EntitlementsAcceptSession = (
  input: EntitlementsAcceptSessionInput,
) => boolean | Promise<boolean>;

/** What `resolveEntitlements` receives: the plan after a plan override, before feature/limit overrides. */
export type ResolveEntitlementsInput<C extends AnyCatalog = AnyCatalog> = {
  organizationId: string;
  plan: PlanKey<C>;
  /** The billing snapshot, or null (no source, not yet resolved, or degraded). */
  snapshot: EntitlementSnapshotRow | null;
  features: Record<FeatureKey<C>, boolean>;
  limits: Record<LimitKey<C>, LimitValue>;
};

/** App adjustments to the plan: the keys returned replace the plan's values. */
export type ResolveEntitlementsHook<C extends AnyCatalog = AnyCatalog> = (
  input: ResolveEntitlementsInput<C>,
) =>
  | {
      features?: Partial<Record<FeatureKey<C>, boolean>>;
      limits?: Partial<Record<LimitKey<C>, LimitValue>>;
    }
  | Promise<{
      features?: Partial<Record<FeatureKey<C>, boolean>>;
      limits?: Partial<Record<LimitKey<C>, LimitValue>>;
    }>;

/** Which statuses keep the billed plan. */
export type IsEntitled = (
  snapshot: EntitlementSnapshotRow,
  now: Date,
) => boolean;

/** The check `onError` answers for. */
export type EntitlementsCheckOperation =
  | "hasFeature"
  | "consumeUsage"
  | "checkCapacity";

/** What a check answers when the database or the source throws. */
export type EntitlementsOnError = (
  error: unknown,
  info: {
    organizationId: string;
    key: string;
    operation: EntitlementsCheckOperation;
  },
) => "allow" | "deny";

export type EntitlementsOptions<C extends AnyCatalog = AnyCatalog> = {
  /** From `defineEntitlements`. Required. */
  catalog: C;
  /**
   * Where billing state comes from. Unset: every organization is on
   * `defaultPlan` (plus overrides).
   */
  source?: BillingSource;
  /**
   * Which snapshots keep their billed plan. Default: `active`, `trialing`,
   * and `past_due` while `now < pastDueSince + pastDueGraceDays`. Every other
   * status falls back to `defaultPlan`.
   */
  isEntitled?: IsEntitled;
  /**
   * Days a `past_due` organization keeps its plan, counted from
   * `pastDueSince`.
   * @default 7
   */
  pastDueGraceDays?: number;
  /** App adjustments, applied after a plan override and before feature/limit overrides. */
  resolveEntitlements?: ResolveEntitlementsHook<C>;
  /** The vendor's staff organization: its members with `entitlements:override` manage overrides. */
  staffOrganizationId?: string;
  /** Default: an organization-role check through the organization plugin's `hasPermission`. */
  authorize?: EntitlementsAuthorize;
  /** Default: refuse impersonated sessions on staff calls and on every POST. */
  acceptSession?: EntitlementsAcceptSession;
  /**
   * Receives every event; for a write inside a transaction, after it
   * commits. Errors are logged and never fail the call.
   */
  onEvent?: ByoEventHandler;
  /**
   * What `hasFeature`, `consumeUsage` and `checkCapacity` answer when the
   * database or the source throws. Always logged.
   * @default () => "deny"
   */
  onError?: EntitlementsOnError;
  /**
   * In-process cache of resolved entitlements, in ms (10 000 organizations
   * at most). `0` turns it off. Usage counters are never cached.
   * @default 30000
   */
  cacheTtlMs?: number;
  /**
   * A snapshot older than this (ms) is served, then refreshed in the
   * background. At least 60000 (1 minute).
   * @default 3600000 (1 hour)
   */
  maxAge?: number;
  /**
   * The sweep deletes `entitlementUsage` rows whose period ended longer ago
   * than this (ms). At least 86400000 (1 day).
   * @default 7776000000 (90 days)
   */
  usageRetention?: number;
  /**
   * The sweep deletes removed or expired overrides that ended longer ago
   * than this (ms). At least 86400000 (1 day).
   * @default 31536000000 (365 days)
   */
  overrideRetention?: number;
  /**
   * Delete an organization's rows after `/organization/delete`.
   * @default true
   */
  organizationCleanup?: boolean;
  /**
   * Resolve attempts before a snapshot is counted `failed` (it keeps its
   * last good state and is retried at `maxAge`).
   * @default 5
   */
  maxAttempts?: number;
  /**
   * Snapshots claimed per sweep call (1 to 1000).
   * @default 100
   */
  batchSize?: number;
  /**
   * How long a sweep claim lasts before another sweep may take it (ms).
   * @default 300000 (5 minutes)
   */
  leaseMs?: number;
  /** Rename tables and columns (`mergeSchema`). */
  schema?: EntitlementsSchemaOption;
};

/** `options` with every default applied. Built once by `resolveOptions`. */
export type ResolvedEntitlementsOptions<C extends AnyCatalog = AnyCatalog> = {
  catalog: C;
  source: BillingSource | null;
  /** `source.id`, or `"none"` without a source (stored on snapshots). */
  sourceId: string;
  isEntitled: IsEntitled;
  pastDueGraceDays: number;
  resolveEntitlements: ResolveEntitlementsHook<C> | null;
  staffOrganizationId: string | null;
  /** The app's `authorize`, or null for the default org-role check (`access.ts`). */
  authorize: EntitlementsAuthorize | null;
  acceptSession: EntitlementsAcceptSession;
  onEvent: ByoEventHandler | null;
  onError: EntitlementsOnError;
  cacheTtlMs: number;
  maxAge: number;
  usageRetention: number;
  overrideRetention: number;
  organizationCleanup: boolean;
  maxAttempts: number;
  batchSize: number;
  leaseMs: number;
  schema: EntitlementsSchemaOption | undefined;
};

const DAY = 24 * 60 * 60 * 1000;

/** The defaults table (PRD Options). */
export const ENTITLEMENTS_DEFAULTS = {
  pastDueGraceDays: 7,
  cacheTtlMs: 30_000,
  /** Entries in the in-process cache. */
  cacheMaxEntries: 10_000,
  maxAge: 60 * 60 * 1000,
  usageRetention: 90 * DAY,
  overrideRetention: 365 * DAY,
  organizationCleanup: true,
  maxAttempts: 5,
  batchSize: 100,
  leaseMs: 5 * 60 * 1000,
} as const;

/**
 * Smallest `maxAge` (ms): 1 minute. Every duration option is in ms, so a
 * value given in days or hours fails boot instead of meaning milliseconds.
 */
export const MIN_MAX_AGE = 60_000;
/** Smallest `usageRetention` and `overrideRetention` (ms): 1 day. */
export const MIN_RETENTION = 86_400_000;

/** Most snapshots one sweep call claims. */
export const MAX_BATCH_SIZE = 1000;

/** The `source` stored on snapshots written without a configured source. */
export const NO_SOURCE_ID = "none";

const deny: EntitlementsOnError = () => "deny";

function fail(message: string): never {
  throw new Error(`${PREFIX} ${message}`);
}

function numberOption(
  options: Record<string, unknown>,
  name: string,
  fallback: number,
  rule: { min: number; integer?: boolean; max?: number; hint?: string },
): number {
  const value = options[name];
  if (value === undefined) return fallback;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    (rule.integer && !Number.isInteger(value)) ||
    value < rule.min ||
    (rule.max !== undefined && value > rule.max)
  ) {
    const kind = rule.integer ? "an integer" : "a number";
    const range =
      rule.max !== undefined
        ? `from ${rule.min} to ${rule.max}`
        : `of at least ${rule.min}`;
    return fail(
      `${name} must be ${kind} ${range}${rule.hint ? ` (${rule.hint})` : ""}`,
    );
  }
  return value;
}

/**
 * Applies the defaults and runs boot validation (§2.5). Each problem throws
 * a `[@byo-oss/entitlements] …` error:
 * - the catalog rules (`validateCatalog`);
 * - `staffOrganizationId` set to an empty string;
 * - a `source` without a non-empty `id` (`"none"` is reserved) or a
 *   `resolve` function;
 * - a numeric option out of range (`maxAge` at least 1 minute,
 *   `usageRetention`/`overrideRetention` at least 1 day, all in ms).
 *
 * Checks that need better-auth (the organization plugin, `source.connect`)
 * run in the plugin's `init`.
 */
export function resolveOptions<C extends AnyCatalog>(
  options: EntitlementsOptions<C>,
): ResolvedEntitlementsOptions<C> {
  if (typeof options !== "object" || options === null) {
    fail("options are required: entitlements({ catalog })");
  }
  validateCatalog(options.catalog);
  if (options.staffOrganizationId === "") {
    fail(
      "staffOrganizationId is an empty string; set your staff organization's id, or leave it out",
    );
  }
  const { source } = options;
  if (source !== undefined) {
    if (
      typeof source !== "object" ||
      source === null ||
      typeof source.id !== "string" ||
      source.id === ""
    ) {
      fail("source needs a non-empty id");
    }
    if (source.id === NO_SOURCE_ID) {
      fail(`source.id "${NO_SOURCE_ID}" is reserved for "no source"`);
    }
    if (typeof source.resolve !== "function") {
      fail("source needs a resolve function");
    }
  }
  const raw = options as unknown as Record<string, unknown>;
  const d = ENTITLEMENTS_DEFAULTS;
  const pastDueGraceDays = numberOption(
    raw,
    "pastDueGraceDays",
    d.pastDueGraceDays,
    { min: 0 },
  );
  return {
    catalog: options.catalog,
    source: source ?? null,
    sourceId: source?.id ?? NO_SOURCE_ID,
    isEntitled:
      options.isEntitled ??
      ((snapshot, now) => isDefaultEntitled(snapshot, now, pastDueGraceDays)),
    pastDueGraceDays,
    resolveEntitlements: options.resolveEntitlements ?? null,
    staffOrganizationId: options.staffOrganizationId ?? null,
    authorize: options.authorize ?? null,
    acceptSession: options.acceptSession ?? defaultAcceptSession,
    onEvent: options.onEvent ?? null,
    onError: options.onError ?? deny,
    cacheTtlMs: numberOption(raw, "cacheTtlMs", d.cacheTtlMs, {
      min: 0,
      integer: true,
    }),
    maxAge: numberOption(raw, "maxAge", d.maxAge, {
      min: MIN_MAX_AGE,
      integer: true,
      hint: "ms; 1 minute",
    }),
    usageRetention: numberOption(raw, "usageRetention", d.usageRetention, {
      min: MIN_RETENTION,
      integer: true,
      hint: "ms; 1 day",
    }),
    overrideRetention: numberOption(
      raw,
      "overrideRetention",
      d.overrideRetention,
      { min: MIN_RETENTION, integer: true, hint: "ms; 1 day" },
    ),
    organizationCleanup: options.organizationCleanup ?? d.organizationCleanup,
    maxAttempts: numberOption(raw, "maxAttempts", d.maxAttempts, {
      min: 1,
      integer: true,
    }),
    batchSize: numberOption(raw, "batchSize", d.batchSize, {
      min: 1,
      max: MAX_BATCH_SIZE,
      integer: true,
    }),
    leaseMs: numberOption(raw, "leaseMs", d.leaseMs, { min: 1, integer: true }),
    schema: options.schema,
  };
}
