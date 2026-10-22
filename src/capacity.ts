import { type LimitValue, upgradeTo } from "./catalog";
import { resolveState } from "./resolve";
import type { EntitlementsRuntime } from "./runtime";
import type { CapacityResult } from "./types";
import { assertKey, onErrorAllows } from "./usage";

const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

/**
 * `checkCapacity` (capacity keys only): `allowed = count + adding <= limit`
 * (`"unlimited"` always allows), `over = count > limit`, `reason`
 * `"limit_reached"` when refused, with `upgradeTo` for
 * `count + adding`. `adding` defaults to 1; `count` and `adding` are
 * non-negative integers (else it throws). Works inside a transaction. A
 * degraded `resolveState` answers `rt.options.onError(state.error, {
 * organizationId, key, operation: "checkCapacity" })` with `reason:
 * "error"` and `over: false`, and doesn't log again (the read logged it).
 * Throws `UNKNOWN_KEY` for a key that isn't a capacity limit.
 */
export async function checkCapacity(
  rt: EntitlementsRuntime,
  organizationId: string,
  key: string,
  opts: { count: number; adding?: number },
): Promise<CapacityResult> {
  assertKey(rt, "checkCapacity", key, "capacity limit");
  const count = opts?.count;
  const adding = opts?.adding ?? 1;
  if (!isCount(count) || !isCount(adding)) {
    throw new Error(
      "[@byo-oss/entitlements] checkCapacity: count and adding must be non-negative integers",
    );
  }
  const state = await resolveState(rt, organizationId);
  const plan = state.result.plan.key;
  const limit = state.result.limits[key] as LimitValue;
  if (state.result.degraded) {
    return {
      allowed: onErrorAllows(rt, state.error, {
        organizationId,
        key,
        operation: "checkCapacity",
      }),
      reason: "error",
      key,
      plan,
      upgradeTo: [],
      count,
      limit,
      over: false,
    };
  }
  const allowed = limit === "unlimited" || count + adding <= limit;
  return {
    allowed,
    reason: allowed ? "ok" : "limit_reached",
    key,
    plan,
    upgradeTo: upgradeTo(rt.catalog, { limit: key, atLeast: count + adding }),
    count,
    limit,
    over: limit !== "unlimited" && count > limit,
  };
}
