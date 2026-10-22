import type { DBTransactionAdapter } from "better-auth";
import { findOrganization } from "./adapter";
import {
  type AnyCatalog,
  isFeatureKey,
  type LimitValue,
  limitKind,
  type MeteredPeriod,
  planEntitlements,
  type UpgradeTarget,
  upgradeTo,
} from "./catalog";
import { emit, entitlementsEvent } from "./events";
import type { EntitlementsCheckOperation } from "./options";
import { bucketKey, periodFor, type UsagePeriod } from "./period";
import { resolveState } from "./resolve";
import { type EntitlementsRuntime, singleFlight } from "./runtime";
import type { EntitlementUsageRow } from "./schema";
import { assertOutsideTransaction, currentAdapter } from "./txn";
import type {
  ConsumeResult,
  FeatureCheckResult,
  LimitResult,
  MeteredLimitResult,
  ResolvedState,
  UsageInfo,
} from "./types";

const PREFIX = "[@byo-oss/entitlements]";
const USAGE_MODEL = "entitlementUsage";

/** What a key must be for an operation, as `UNKNOWN_KEY` names it. */
export type KeyKind = "feature" | "metered limit" | "capacity limit" | "limit";

/**
 * Throws `[@byo-oss/entitlements] UNKNOWN_KEY: <operation> got "<key>", which
 * isn't a <kind> of the catalog` unless `key` is one (a programmer error the
 * types would have refused, not a refusal).
 */
export function assertKey(
  rt: EntitlementsRuntime,
  operation: string,
  key: unknown,
  kind: KeyKind,
): asserts key is string {
  const ok =
    typeof key === "string" &&
    (kind === "feature"
      ? isFeatureKey(rt.catalog, key)
      : kind === "limit"
        ? limitKind(rt.catalog, key) !== null
        : limitKind(rt.catalog, key) ===
          (kind === "metered limit" ? "metered" : "capacity"));
  if (!ok) {
    throw new Error(
      `${PREFIX} UNKNOWN_KEY: ${operation} got "${String(key)}", which isn't a ${kind} of the catalog`,
    );
  }
}

/** `rt.options.onError`'s answer as `allowed`. */
export function onErrorAllows(
  rt: EntitlementsRuntime,
  error: unknown,
  info: {
    organizationId: string;
    key: string;
    operation: EntitlementsCheckOperation;
  },
): boolean {
  return rt.options.onError(error, info) === "allow";
}

const meteredPeriod = (rt: EntitlementsRuntime, key: string): MeteredPeriod =>
  (rt.catalog.limits as Record<string, { period: MeteredPeriod }>)[key]
    ?.period as MeteredPeriod;

const remainingOf = (limit: LimitValue, used: number): number | "unlimited" =>
  limit === "unlimited" ? "unlimited" : Math.max(0, limit - used);

/**
 * `upgradeTo` for a check result: only plans strictly better on that key
 * than the organization's current plan (PRD A5(b), RC review 2 NB5).
 * - A feature: the plans that include it, without the current plan (which
 *   can include it when an override or the hook turned it off).
 * - A limit: the plans whose catalog value is `"unlimited"` or at least
 *   `max(atLeast, current + 1)`, where `current` is the current plan's
 *   catalog value for the key, so a plan below it (e.g. `free` for a Pro
 *   organization whose limit an override lowered) is never named. A
 *   current catalog value of `"unlimited"` answers `[]`.
 */
export function upgradeFrom(
  rt: EntitlementsRuntime,
  plan: string,
  target: UpgradeTarget<AnyCatalog>,
): string[] {
  let wanted = target;
  if ("limit" in target) {
    const current = catalogLimit(rt, plan, target.limit);
    if (current === "unlimited") return [];
    if (typeof current === "number") {
      wanted = {
        limit: target.limit,
        atLeast: Math.max(target.atLeast, current + 1),
      };
    }
  }
  return upgradeTo(rt.catalog, wanted).filter((key) => key !== plan);
}

/** A plan's own catalog value for a limit (before overrides and the hook). */
function catalogLimit(
  rt: EntitlementsRuntime,
  plan: string,
  key: string,
): LimitValue | undefined {
  const plans = rt.catalog.plans as Record<
    string,
    { limits: Record<string, LimitValue> } | undefined
  >;
  return plans[plan]?.limits[key];
}

const limitUpgrade = (
  rt: EntitlementsRuntime,
  plan: string,
  key: string,
  atLeast: number,
) => upgradeFrom(rt, plan, { limit: key, atLeast });

const findBucket = (adapter: DBTransactionAdapter, bucket: string) =>
  adapter.findOne<EntitlementUsageRow>({
    model: USAGE_MODEL,
    where: [{ field: "bucket", value: bucket }],
  });

/**
 * Makes sure the bucket row exists. One create per bucket at a time in this
 * process (`singleFlight("bucket:<bucket>")`); inside the flight it re-reads
 * first (a caller can arrive after an earlier flight settled), checks the
 * organization exists (`findOrganization`) and creates nothing when it
 * doesn't (returns false), and on a create error (another process won the
 * unique `bucket`) re-reads and rethrows only when the row is still
 * missing. Returns whether the bucket exists.
 */
async function ensureBucket(
  rt: EntitlementsRuntime,
  adapter: DBTransactionAdapter,
  input: {
    bucket: string;
    organizationId: string;
    key: string;
    period: UsagePeriod;
  },
): Promise<boolean> {
  return singleFlight(rt, `bucket:${input.bucket}`, async () => {
    if (await findBucket(adapter, input.bucket)) return true;
    // the resolved state said known; the organization may be gone since
    if (!(await findOrganization(adapter, input.organizationId))) return false;
    const now = rt.now();
    try {
      await adapter.create<
        Omit<EntitlementUsageRow, "id">,
        EntitlementUsageRow
      >({
        model: USAGE_MODEL,
        data: {
          bucket: input.bucket,
          organizationId: input.organizationId,
          key: input.key,
          periodStart: input.period.start,
          periodEnd: input.period.end,
          used: 0,
          refused: 0,
          createdAt: now,
          updatedAt: now,
        },
      });
    } catch (error) {
      if (await findBucket(adapter, input.bucket)) return true;
      throw error;
    }
    return true;
  });
}

/**
 * `consumeUsage` (metered keys only), per the PRD's Checks steps 1–4:
 * guarded `incrementOne` first; on `null`, `findOne` the bucket, create it
 * through `singleFlight` keyed by bucket (re-read on a create error), retry
 * once; refused calls don't count `used` but increment `refused`, and the
 * first refusal per period emits `entitlements.usage.limit_reached`. A
 * refusal answers `reason: "limit_reached"`, or `"not_in_plan"` when the
 * limit is 0 (PRD A5(c); it still counts toward `refused` and emits).
 * `upgradeTo` lists only plans above the current plan's catalog value for
 * the key, never the current plan (A5(b), `upgradeFrom`).
 * An id that isn't an organization (`state.known` false, or no
 * `organization` row when the bucket would be created) answers
 * `{ allowed: false, reason: "not_in_plan", upgradeTo: [] }` and writes
 * nothing: no bucket, no `refused`, no event, no log line.
 * `amount` (default 1) must be a positive integer.
 * Throws `[@byo-oss/entitlements] consumeUsage must run outside a
 * transaction` inside one, and `[@byo-oss/entitlements] UNKNOWN_KEY: …` for
 * a key that isn't a metered limit. Failures answer
 * `rt.options.onError(error, { organizationId, key, operation:
 * "consumeUsage" })` with `reason: "error"`: a degraded `resolveState`
 * answers with `state.error` and is not logged again (the read logged it);
 * a failure of this function's own queries is logged once.
 */
export async function consumeUsage(
  rt: EntitlementsRuntime,
  organizationId: string,
  key: string,
  opts?: { amount?: number },
): Promise<ConsumeResult> {
  await assertOutsideTransaction(rt, "consumeUsage");
  assertKey(rt, "consumeUsage", key, "metered limit");
  const amount = opts?.amount ?? 1;
  if (!Number.isInteger(amount) || amount < 1) {
    throw new Error(
      `${PREFIX} consumeUsage: amount must be a positive integer`,
    );
  }

  const state = await resolveState(rt, organizationId);
  const now = rt.now();
  const plan = state.result.plan.key;
  const limit = state.result.limits[key] as LimitValue;
  const period = periodFor(meteredPeriod(rt, key), state, now);
  const info = { organizationId, key, operation: "consumeUsage" as const };
  const errorResult = (error: unknown): ConsumeResult => ({
    allowed: onErrorAllows(rt, error, info),
    reason: "error",
    key,
    plan,
    upgradeTo: [],
    used: 0,
    limit,
    remaining: remainingOf(limit, 0),
    resetAt: period.end,
    firstRefusal: false,
  });
  if (state.result.degraded) return errorResult(state.error);
  const unknown = (): ConsumeResult => ({
    allowed: false,
    reason: "not_in_plan",
    key,
    plan,
    upgradeTo: [],
    used: 0,
    limit,
    remaining: remainingOf(limit, 0),
    resetAt: period.end,
    firstRefusal: false,
  });
  if (!state.known) return unknown();

  const bucket = bucketKey(organizationId, key, period.start);
  const target = { bucket, organizationId, key, period };
  let refusal: EntitlementUsageRow | null;
  let firstRefusal: boolean;
  try {
    const adapter = await currentAdapter(rt);
    if (limit === "unlimited" || amount <= limit) {
      const consume = () =>
        adapter.incrementOne<EntitlementUsageRow>({
          model: USAGE_MODEL,
          where:
            limit === "unlimited"
              ? [{ field: "bucket", value: bucket }]
              : [
                  { field: "bucket", value: bucket },
                  { field: "used", operator: "lte", value: limit - amount },
                ],
          increment: { used: amount },
          set: { updatedAt: now },
        });
      let row = await consume();
      if (!row && !(await findBucket(adapter, bucket))) {
        if (!(await ensureBucket(rt, adapter, target))) return unknown();
        row = await consume();
      }
      if (row) {
        return {
          allowed: true,
          reason: "ok",
          key,
          plan,
          upgradeTo: limitUpgrade(rt, plan, key, row.used),
          used: row.used,
          limit,
          remaining: remainingOf(limit, row.used),
          resetAt: period.end,
          firstRefusal: false,
        };
      }
      if (limit === "unlimited") {
        throw new Error(
          `${PREFIX} consumeUsage: the usage bucket ${bucket} disappeared`,
        );
      }
      // the bucket exists: the guard refused
    } else {
      // amount > limit (a 0 limit included): refused before any consume, so
      // the bucket may not exist yet
      if (!(await ensureBucket(rt, adapter, target))) return unknown();
    }
    // the first refusal is the increment that moves `refused` from 0 to 1;
    // decided by the guard rather than the returned row, because an adapter
    // may hand back a row object that later increments have already changed
    const refuse = (first: boolean) =>
      adapter.incrementOne<EntitlementUsageRow>({
        model: USAGE_MODEL,
        where: first
          ? [
              { field: "bucket", value: bucket },
              { field: "refused", value: 0 },
            ]
          : [{ field: "bucket", value: bucket }],
        increment: { refused: 1 },
        set: { updatedAt: now },
      });
    refusal = await refuse(true);
    firstRefusal = refusal !== null;
    refusal ??= await refuse(false);
    if (!refusal) {
      throw new Error(
        `${PREFIX} consumeUsage: the usage bucket ${bucket} disappeared`,
      );
    }
  } catch (error) {
    rt.logger.error(
      `${PREFIX} consumeUsage failed for organization ${organizationId} (${key}); answering onError`,
      error,
    );
    return errorResult(error);
  }

  const numericLimit = limit as number;
  if (firstRefusal) {
    await emit(
      rt,
      entitlementsEvent("entitlements.usage.limit_reached", {
        organizationId,
        actorId: null,
        data: { key, limit: numericLimit, periodEnd: period.end },
        occurredAt: rt.now(),
      }),
    );
  }
  return {
    allowed: false,
    reason: numericLimit === 0 ? "not_in_plan" : "limit_reached",
    key,
    plan,
    upgradeTo: limitUpgrade(rt, plan, key, refusal.used + amount),
    used: refusal.used,
    limit,
    remaining: remainingOf(limit, refusal.used),
    resetAt: period.end,
    firstRefusal,
  };
}

/**
 * The counter of a metered key for the current period of `state`, read
 * with `findOne` on the bucket (no row → `used: 0`). Never creates a
 * bucket. `remaining = max(0, limit - used)`, or `"unlimited"`. A query
 * error throws; it never logs (its caller logs once: `getLimit`, or the
 * read endpoints, which answer 503).
 */
export async function readUsage(
  rt: EntitlementsRuntime,
  adapter: DBTransactionAdapter,
  organizationId: string,
  key: string,
  state: ResolvedState,
): Promise<UsageInfo> {
  const period = periodFor(meteredPeriod(rt, key), state, rt.now());
  const row = await findBucket(
    adapter,
    bucketKey(organizationId, key, period.start),
  );
  const used = row?.used ?? 0;
  const limit = state.result.limits[key] as LimitValue;
  return { used, remaining: remainingOf(limit, used), resetAt: period.end };
}

/** `allowed`/`reason` of a limit: 0 → not in plan; nothing left → limit reached. */
function limitVerdict(
  limit: LimitValue,
  remaining: number | "unlimited" | null,
): Pick<LimitResult, "allowed" | "reason"> {
  if (limit === 0) return { allowed: false, reason: "not_in_plan" };
  if (remaining === 0) return { allowed: false, reason: "limit_reached" };
  return { allowed: true, reason: "ok" };
}

/**
 * `getLimit` for any kind: `{ limit, degraded, ... }`; metered keys also
 * get `{ used, remaining, resetAt }` (`readUsage`; no bucket is created).
 * `allowed`/`reason`: `"not_in_plan"` when the limit is 0, metered keys
 * `"limit_reached"` when `remaining` is 0, else `"ok"`; `upgradeTo` lists
 * the plans with at least 1 (metered: `used + 1`) and more than the current
 * plan's catalog value, never the current one (`upgradeFrom`). A failure answers
 * `defaultPlan` with `degraded: true`, `allowed: false` and
 * `reason: "error"`: a degraded `resolveState` is not logged again (the read
 * logged it); a `readUsage` throw is logged once here.
 * Throws `UNKNOWN_KEY` for a key that isn't a limit. Works inside a
 * transaction.
 */
export async function getLimit(
  rt: EntitlementsRuntime,
  organizationId: string,
  key: string,
): Promise<LimitResult | MeteredLimitResult> {
  assertKey(rt, "getLimit", key, "limit");
  const metered = limitKind(rt.catalog, key) === "metered";
  const state = await resolveState(rt, organizationId);

  const failed = (
    plan: string,
    limit: LimitValue,
  ): LimitResult | MeteredLimitResult => {
    const base: LimitResult = {
      allowed: false,
      reason: "error",
      key,
      plan,
      upgradeTo: [],
      limit,
      degraded: true,
    };
    if (!metered) return base;
    const period = periodFor(meteredPeriod(rt, key), state, rt.now());
    return {
      ...base,
      used: 0,
      remaining: remainingOf(limit, 0),
      resetAt: period.end,
    };
  };

  if (state.result.degraded) {
    return failed(
      state.result.plan.key,
      state.result.limits[key] as LimitValue,
    );
  }
  const plan = state.result.plan.key;
  const limit = state.result.limits[key] as LimitValue;
  if (!metered) {
    return {
      ...limitVerdict(limit, null),
      key,
      plan,
      upgradeTo: limitUpgrade(rt, plan, key, 1),
      limit,
      degraded: false,
    };
  }
  let usage: UsageInfo;
  try {
    usage = await readUsage(
      rt,
      await currentAdapter(rt),
      organizationId,
      key,
      state,
    );
  } catch (error) {
    rt.logger.error(
      `${PREFIX} getLimit failed to read usage for organization ${organizationId} (${key}); answering defaultPlan (degraded)`,
      error,
    );
    const fallback = rt.catalog.defaultPlan as string;
    return failed(
      fallback,
      planEntitlements(rt.catalog, fallback).limits[key] as LimitValue,
    );
  }
  return {
    ...limitVerdict(limit, usage.remaining),
    key,
    plan,
    upgradeTo: limitUpgrade(rt, plan, key, usage.used + 1),
    limit,
    degraded: false,
    ...usage,
  };
}

/**
 * `hasFeature`: `allowed` = the resolved feature value; `reason`
 * `"not_in_plan"` when false; `upgradeTo` lists the plans with the feature,
 * never the current one (`upgradeFrom`).
 * A degraded `resolveState` answers `rt.options.onError(state.error, {
 * organizationId, key, operation: "hasFeature" })` with `reason: "error"`
 * and doesn't log again (the read logged it). Throws `UNKNOWN_KEY` for a key
 * that isn't a feature. Works inside a transaction.
 */
export async function hasFeature(
  rt: EntitlementsRuntime,
  organizationId: string,
  feature: string,
): Promise<FeatureCheckResult> {
  assertKey(rt, "hasFeature", feature, "feature");
  const state = await resolveState(rt, organizationId);
  const plan = state.result.plan.key;
  if (state.result.degraded) {
    return {
      allowed: onErrorAllows(rt, state.error, {
        organizationId,
        key: feature,
        operation: "hasFeature",
      }),
      reason: "error",
      key: feature,
      plan,
      upgradeTo: [],
    };
  }
  const allowed = state.result.features[feature] === true;
  return {
    allowed,
    reason: allowed ? "ok" : "not_in_plan",
    key: feature,
    plan,
    upgradeTo: upgradeFrom(rt, plan, { feature }),
  };
}
