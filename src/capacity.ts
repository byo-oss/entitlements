// BYO_STUB: N04 replaces this file (contracts.md "capacity.ts")
import type { EntitlementsRuntime } from "./runtime";
import type { CapacityResult } from "./types";

/**
 * `checkCapacity` (capacity keys only): `allowed = count + adding <= limit`
 * (`"unlimited"` always allows), `over = count > limit`, `reason`
 * `"limit_reached"` when refused, with `upgradeTo` for
 * `count + adding`. `adding` defaults to 1; `count` and `adding` are
 * non-negative integers. Works inside a transaction. A failure answers
 * `onError` (`reason: "error"`), logged. Throws `UNKNOWN_KEY` for a key that
 * isn't a capacity limit.
 * Stub: refuses.
 */
export async function checkCapacity(
  rt: EntitlementsRuntime,
  _organizationId: string,
  key: string,
  opts: { count: number; adding?: number },
): Promise<CapacityResult> {
  return {
    allowed: false,
    reason: "limit_reached",
    key,
    plan: rt.catalog.defaultPlan,
    upgradeTo: [],
    count: opts.count,
    limit: 0,
    over: false,
  };
}
