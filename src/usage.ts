// BYO_STUB: N04 replaces this file (contracts.md "usage.ts")
import type { DBTransactionAdapter } from "better-auth";
import type { EntitlementsRuntime } from "./runtime";
import type {
  ConsumeResult,
  FeatureCheckResult,
  LimitResult,
  MeteredLimitResult,
  ResolvedState,
  UsageInfo,
} from "./types";

/**
 * `consumeUsage` (metered keys only), per PRD Checks: guarded
 * `incrementOne` first; on `null`, `findOne` the bucket, create it through
 * `singleFlight` keyed by bucket (re-read on a create error), retry once;
 * refused calls don't count `used` but increment `refused`, and the first
 * refusal per period emits `entitlements.usage.limit_reached`.
 * `amount` (default 1) must be a positive integer.
 * Throws `[@byo-oss/entitlements] consumeUsage must run outside a
 * transaction` inside one, and `[@byo-oss/entitlements] UNKNOWN_KEY: …` for
 * a key that isn't a metered limit. Failures answer
 * `rt.options.onError(error, { organizationId, key, operation:
 * "consumeUsage" })` with `reason: "error"`: a degraded `resolveState`
 * answers with `state.error` and is not logged again (the read logged it);
 * a failure of this function's own queries is logged once.
 * Stub: refuses without touching the database.
 */
export async function consumeUsage(
  rt: EntitlementsRuntime,
  _organizationId: string,
  key: string,
  _opts?: { amount?: number },
): Promise<ConsumeResult> {
  return {
    allowed: false,
    reason: "limit_reached",
    key,
    plan: rt.catalog.defaultPlan,
    upgradeTo: [],
    used: 0,
    limit: 0,
    remaining: 0,
    resetAt: rt.now(),
    firstRefusal: false,
  };
}

/**
 * The counter of a metered key for the current period of `state`, read
 * with `findOne` on the bucket (no row → `used: 0`). Never creates a
 * bucket. `remaining = max(0, limit - used)`, or `"unlimited"`. A query
 * error throws; it never logs (its caller logs once: `getLimit`, or the
 * read endpoints, which answer 503).
 * Stub: `used: 0`.
 */
export async function readUsage(
  rt: EntitlementsRuntime,
  _adapter: DBTransactionAdapter,
  _organizationId: string,
  _key: string,
  _state: ResolvedState,
): Promise<UsageInfo> {
  return { used: 0, remaining: 0, resetAt: rt.now() };
}

/**
 * `getLimit` for any kind: `{ limit, degraded, ... }`; metered keys also
 * get `{ used, remaining, resetAt }` (`readUsage`; no bucket is created).
 * `allowed`/`reason`: `"not_in_plan"` when the limit is 0, metered keys
 * `"limit_reached"` when `remaining` is 0, else `"ok"`. A failure answers
 * `defaultPlan` with `degraded: true` (`reason: "error"`): a degraded
 * `resolveState` is not logged again (the read logged it); a `readUsage`
 * throw is logged once here.
 * Throws `UNKNOWN_KEY` for a key that isn't a limit.
 * Stub: limit 0, not degraded.
 */
export async function getLimit(
  rt: EntitlementsRuntime,
  _organizationId: string,
  key: string,
): Promise<LimitResult | MeteredLimitResult> {
  return {
    allowed: false,
    reason: "not_in_plan",
    key,
    plan: rt.catalog.defaultPlan,
    upgradeTo: [],
    limit: 0,
    degraded: false,
  };
}

/**
 * `hasFeature`: `allowed` = the resolved feature value; `reason`
 * `"not_in_plan"` when false, with `upgradeTo`. A degraded `resolveState`
 * answers `rt.options.onError(state.error, { organizationId, key,
 * operation: "hasFeature" })` with `reason: "error"` and doesn't log again
 * (the read logged it). Throws `UNKNOWN_KEY` for a key that isn't a
 * feature.
 * Stub: not allowed.
 */
export async function hasFeature(
  rt: EntitlementsRuntime,
  _organizationId: string,
  feature: string,
): Promise<FeatureCheckResult> {
  return {
    allowed: false,
    reason: "not_in_plan",
    key: feature,
    plan: rt.catalog.defaultPlan,
    upgradeTo: [],
  };
}
