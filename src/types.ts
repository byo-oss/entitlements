import type { AuthContext, DBTransactionAdapter } from "better-auth";
import type {
  AnyCatalog,
  FeatureKey,
  LimitKey,
  LimitValue,
  MeteredKey,
  PlanKey,
} from "./catalog";
import type {
  EntitlementSnapshotRow,
  OverrideKind,
  OverrideStatus,
} from "./schema";

// ---------------------------------------------------------------------------
// Billing sources (SPEC §10.3, §10.7)
// ---------------------------------------------------------------------------

/** One organization's billing state, as a source reports it. */
export type BillingState = {
  /** The provider's plan key (lowercased when stored), or null. */
  planKey: string | null;
  /** The provider status, verbatim (`active`, `trialing`, `past_due`, …). */
  status: string | null;
  periodStart?: Date | null;
  periodEnd?: Date | null;
  cancelAtPeriodEnd?: boolean;
  /** Paid quantity, when the provider has one. */
  seats?: number | null;
  /** The provider's id for this state, e.g. a subscription id. */
  sourceRef?: string | null;
};

/**
 * Where billing state comes from. A throw from `resolve` means "try again
 * later" (the sweep backs off; reads fall back to `defaultPlan` with
 * `degraded: true`). There is no permanent-failure type: a source that can't
 * answer must never drop an organization's paid plan.
 */
export interface BillingSource {
  /** Stored on every snapshot (`entitlementSnapshot.source`). */
  readonly id: string;
  /**
   * The current state for one organization; `null` = no subscription.
   * Read through `ctx.adapter`, so a call inside the app's transaction stays
   * on it. Throw to retry.
   */
  resolve(
    organizationId: string,
    ctx: { adapter: DBTransactionAdapter },
  ): Promise<BillingState | null>;
  /**
   * Optional: wire the provider's push. Awaited once from the plugin's
   * `init`. Call `changed(organizationId)` when an organization's state
   * changed; it resyncs and throws when the resync failed, so the source can
   * turn that into a provider retry.
   */
  connect?(
    context: AuthContext,
    changed: (organizationId: string) => Promise<void>,
  ): void | Promise<void>;
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/** Where the resolved plan came from. */
export type PlanSource = "billing" | "default" | "override";

/** A live override as resolution reports it (no reason, no author). */
export type AppliedOverride = {
  kind: OverrideKind;
  key: string;
  expiresAt: Date | null;
};

/**
 * What `get` returns for one organization. Read-only: a result served from
 * (or stored in) the cache is deep-frozen and shared between callers, so
 * copy it before changing anything.
 */
export type EntitlementsResult<C extends AnyCatalog = AnyCatalog> = {
  organizationId: string;
  /** True when the database or the source failed and this is `defaultPlan`. */
  degraded: boolean;
  plan: {
    key: PlanKey<C>;
    display: Record<string, unknown>;
    source: PlanSource;
  };
  /** The snapshot's provider status (null without a subscription). */
  status: string | null;
  periodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  features: Record<FeatureKey<C>, boolean>;
  limits: Record<LimitKey<C>, LimitValue>;
  overrides: AppliedOverride[];
};

/**
 * A resolution plus what the checks need beyond the result: the snapshot it
 * was computed from (null without one), whether `isEntitled` held for it
 * (false without a snapshot), whether the id is an organization and, for a
 * degraded one, the error. What the cache stores (never a degraded state,
 * never an unknown id). A cached state, and the result returned from it, is
 * deep-frozen: results are read-only.
 */
export type ResolvedState<C extends AnyCatalog = AnyCatalog> = {
  result: EntitlementsResult<C>;
  snapshot: EntitlementSnapshotRow | null;
  entitled: boolean;
  /**
   * False when the id isn't an organization (no `organization` row): the
   * result answers `defaultPlan`, nothing is cached, and `consumeUsage`
   * refuses with `not_in_plan` without writing. True otherwise, a degraded
   * state included.
   */
  known: boolean;
  /**
   * Set whenever `result.degraded`: what the database, the source or the
   * `resolveEntitlements` hook threw. The read that degraded already logged
   * it; a check answers `onError(error, …)` with it and doesn't log again.
   */
  error?: unknown;
};

// ---------------------------------------------------------------------------
// Checks (never throw for a refusal)
// ---------------------------------------------------------------------------

export type CheckReason = "ok" | "not_in_plan" | "limit_reached" | "error";

/** Fields every check result carries. */
export type CheckResultBase<C extends AnyCatalog, K extends string> = {
  allowed: boolean;
  reason: CheckReason;
  key: K;
  /** The organization's resolved plan key. */
  plan: PlanKey<C>;
  /** Plans that would allow it, in catalog order (`upgradeTo`). */
  upgradeTo: PlanKey<C>[];
};

/** `hasFeature`. */
export type FeatureCheckResult<
  C extends AnyCatalog = AnyCatalog,
  K extends string = FeatureKey<C>,
> = CheckResultBase<C, K>;

/** A metered key's counter for the current period. */
export type UsageInfo = {
  used: number;
  remaining: number | "unlimited";
  /** When the current period ends (the counter resets). */
  resetAt: Date;
};

/** `getLimit` on a capacity or value key. */
export type LimitResult<
  C extends AnyCatalog = AnyCatalog,
  K extends string = LimitKey<C>,
> = CheckResultBase<C, K> & {
  limit: LimitValue;
  /** True when this answer is `defaultPlan` because of a failure. */
  degraded: boolean;
};

/** `getLimit` on a metered key: the limit plus the counter (read, not consumed). */
export type MeteredLimitResult<
  C extends AnyCatalog = AnyCatalog,
  K extends string = MeteredKey<C>,
> = LimitResult<C, K> & UsageInfo;

/** `consumeUsage`. */
export type ConsumeResult<
  C extends AnyCatalog = AnyCatalog,
  K extends string = MeteredKey<C>,
> = CheckResultBase<C, K> &
  UsageInfo & {
    limit: LimitValue;
    /** True for the first refusal of this key in this period. */
    firstRefusal: boolean;
  };

/** `checkCapacity`. */
export type CapacityResult<
  C extends AnyCatalog = AnyCatalog,
  K extends string = LimitKey<C>,
> = CheckResultBase<C, K> & {
  count: number;
  limit: LimitValue;
  /** `count > limit`: already above the limit (e.g. after a downgrade). */
  over: boolean;
};

// ---------------------------------------------------------------------------
// Endpoint bodies (dates are `Date` on the server; see `Wire` for JSON)
// ---------------------------------------------------------------------------

/** An override as the staff endpoints return it. */
export type EntitlementOverride = {
  id: string;
  organizationId: string;
  status: OverrideStatus;
  kind: OverrideKind;
  key: string;
  /** Decoded: plan → null, feature → boolean, limit → integer or `"unlimited"`. */
  value: boolean | LimitValue | null;
  reason: string;
  expiresAt: Date | null;
  endedAt: Date | null;
  createdBy: string | null;
  removedBy: string | null;
  createdAt: Date;
};

/**
 * An override in `getEntitlements`: members get `{ kind, key, expiresAt }`;
 * staff callers also get the row's `id`, `reason` and `createdBy`.
 */
export type EntitlementsResponseOverride = AppliedOverride & {
  /** Staff callers only. */
  id?: string;
  /** Staff callers only. */
  reason?: string;
  /** Staff callers only. */
  createdBy?: string | null;
};

/** `getEntitlements` and `refreshEntitlements`. */
export type EntitlementsResponse<C extends AnyCatalog = AnyCatalog> = Omit<
  EntitlementsResult<C>,
  "overrides"
> & {
  overrides: EntitlementsResponseOverride[];
  usage: Record<MeteredKey<C>, UsageInfo>;
};

/** `setEntitlementOverride`. */
export type SetOverrideResponse = { override: EntitlementOverride };
/** `removeEntitlementOverride`. */
export type RemoveOverrideResponse = { ok: true };
/** `listEntitlementOverrides`: 50 per page, newest first. */
export type ListOverridesResponse = {
  overrides: EntitlementOverride[];
  nextCursor: string | null;
};

/** `T` as it arrives over HTTP: every `Date` becomes an ISO string. */
export type Wire<T> = T extends Date
  ? string
  : T extends readonly (infer U)[]
    ? Wire<U>[]
    : T extends object
      ? { [K in keyof T]: Wire<T[K]> }
      : T;

// ---------------------------------------------------------------------------
// Background work (SPEC §5)
// ---------------------------------------------------------------------------

/**
 * What `processEntitlementsSync` returns. A `type` alias (not an interface),
 * so it assigns to `@byo-oss/core`'s `ByoSweepResult`.
 */
export type EntitlementsSweepResult = {
  /** Snapshots resynced (including those a push wrote first). */
  synced: number;
  /** Rows another sweep had claimed. */
  skipped: number;
  /** Resolves that threw and were scheduled again. */
  retrying: number;
  /** Rows that reached `maxAttempts` (kept, retried at `maxAge`). */
  failed: number;
  /** Live overrides marked `expired`. */
  expired: number;
  /** Usage rows and ended overrides deleted past retention. */
  pruned: number;
  hasMore: boolean;
};
