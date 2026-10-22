import type { DBTransactionAdapter, GenericEndpointContext } from "better-auth";
import {
  APIError,
  createAuthEndpoint,
  sessionMiddleware,
} from "better-auth/api";
import * as z from "zod";
import {
  type EntitlementsRoute,
  type ReaderAccess,
  requireReader,
} from "../access";
import { limitKind } from "../catalog";
import { ENTITLEMENTS_ERROR_CODES } from "../error-codes";
import {
  emptyOverrideSet,
  type LiveOverrideSet,
  liveOverrides,
} from "../live-overrides";
import { resolveState, syncOrganization } from "../resolve";
import type { EntitlementsRuntime } from "../runtime";
import type { EntitlementOverrideRow } from "../schema";
import { assertOutsideTransaction, currentAdapter } from "../txn";
import type {
  AppliedOverride,
  EntitlementsResponse,
  EntitlementsResponseOverride,
  ResolvedState,
  UsageInfo,
} from "../types";
import { readUsage } from "../usage";

const PREFIX = "[@byo-oss/entitlements]";
const UNAVAILABLE = ENTITLEMENTS_ERROR_CODES.ENTITLEMENTS_UNAVAILABLE;

const GET_ROUTE: EntitlementsRoute = {
  method: "GET",
  path: "/entitlements/get",
};
const REFRESH_ROUTE: EntitlementsRoute = {
  method: "POST",
  path: "/entitlements/refresh",
};

const unavailable = () => APIError.from("SERVICE_UNAVAILABLE", UNAVAILABLE);

// the metered keys of the catalog, in catalog order
function meteredKeys(rt: EntitlementsRuntime): string[] {
  return Object.keys(rt.catalog.limits).filter(
    (key) => limitKind(rt.catalog, key) === "metered",
  );
}

// the live row behind an applied override: the plan override, or the row of
// its feature or limit key
function rowFor(
  set: LiveOverrideSet,
  applied: AppliedOverride,
): EntitlementOverrideRow | null {
  if (applied.kind === "plan") return set.plan;
  const byKey = applied.kind === "feature" ? set.features : set.limits;
  return byKey.get(applied.key) ?? null;
}

// a fresh object per override, so a member never gets a staff field (not
// even one set to undefined)
const memberOverride = (
  applied: AppliedOverride,
): EntitlementsResponseOverride => ({
  kind: applied.kind,
  key: applied.key,
  expiresAt: applied.expiresAt,
});

/**
 * The body of both read endpoints for a resolved state:
 * - a degraded state → 503 (its read already logged);
 * - `usage` per metered key through `readUsage` (no bucket is created);
 * - members get each override's `{ kind, key, expiresAt }`; staff callers
 *   also get `id`, `reason` and `createdBy` from the live rows.
 * A `readUsage` throw, or a throw from the live-row read, is logged once
 * here and answers 503.
 */
async function respond(
  rt: EntitlementsRuntime,
  access: ReaderAccess,
  state: ResolvedState,
): Promise<EntitlementsResponse> {
  const { result } = state;
  if (result.degraded) throw unavailable();
  const { organizationId } = result;
  let adapter: DBTransactionAdapter;
  const usage: Record<string, UsageInfo> = {};
  try {
    adapter = await currentAdapter(rt);
    for (const key of meteredKeys(rt)) {
      usage[key] = await readUsage(rt, adapter, organizationId, key, state);
    }
  } catch (error) {
    rt.logger.error(
      `${PREFIX} reading usage for organization ${organizationId} failed; answering ${UNAVAILABLE.code}`,
      error,
    );
    throw unavailable();
  }
  let overrides: EntitlementsResponseOverride[];
  if (access.kind === "staff") {
    let set: LiveOverrideSet;
    try {
      set =
        (await liveOverrides(rt, adapter, [organizationId], rt.now())).get(
          organizationId,
        ) ?? emptyOverrideSet();
    } catch (error) {
      rt.logger.error(
        `${PREFIX} reading the overrides of organization ${organizationId} failed; answering ${UNAVAILABLE.code}`,
        error,
      );
      throw unavailable();
    }
    overrides = result.overrides.map((applied) => {
      const row = rowFor(set, applied);
      if (!row) return memberOverride(applied);
      return {
        ...memberOverride(applied),
        id: row.id,
        reason: row.reason,
        createdBy: row.createdBy ?? null,
      };
    });
  } else {
    overrides = result.overrides.map(memberOverride);
  }
  const { overrides: _applied, ...rest } = result;
  return { ...rest, overrides, usage } as EntitlementsResponse;
}

/**
 * `getEntitlements` (GET `/entitlements/get`) and `refreshEntitlements`
 * (POST `/entitlements/refresh`). Both: `sessionMiddleware`, then
 * `requireReader`; answer `EntitlementsResponse` (usage per metered key).
 * Members get each override's `{ kind, key, expiresAt }`; staff callers
 * also get its `id`, `reason` and `createdBy`.
 * 503 `ENTITLEMENTS_UNAVAILABLE` instead of a result when:
 * - `getEntitlements`: `resolveState` came back degraded;
 * - `refreshEntitlements`: `syncOrganization` threw (logged once here), or
 *   its fresh state came back degraded;
 * - either: `readUsage` or the staff live-row read threw (logged once).
 * `refreshEntitlements` runs `syncOrganization` (cache bypassed) and, inside
 * a transaction, throws `assertOutsideTransaction(rt, "refreshEntitlements")`
 * (not a 503).
 */
export function readEndpoints(rt: EntitlementsRuntime) {
  return {
    getEntitlements: createAuthEndpoint(
      "/entitlements/get",
      {
        method: "GET",
        query: z.object({ organizationId: z.string().min(1) }),
        use: [sessionMiddleware],
      },
      async (ctx): Promise<EntitlementsResponse> => {
        const { organizationId } = ctx.query;
        const access = await requireReader(
          ctx as unknown as GenericEndpointContext,
          rt,
          organizationId,
          GET_ROUTE,
        );
        return respond(rt, access, await resolveState(rt, organizationId));
      },
    ),
    refreshEntitlements: createAuthEndpoint(
      "/entitlements/refresh",
      {
        method: "POST",
        body: z.object({ organizationId: z.string().min(1) }),
        use: [sessionMiddleware],
      },
      async (ctx): Promise<EntitlementsResponse> => {
        // a programmer error, not an outage: it propagates as is
        await assertOutsideTransaction(rt, "refreshEntitlements");
        const { organizationId } = ctx.body;
        const access = await requireReader(
          ctx as unknown as GenericEndpointContext,
          rt,
          organizationId,
          REFRESH_ROUTE,
        );
        let state: ResolvedState;
        try {
          state = await syncOrganization(rt, organizationId);
        } catch (error) {
          rt.logger.error(
            `${PREFIX} refreshing organization ${organizationId} failed; answering ${UNAVAILABLE.code}`,
            error,
          );
          throw unavailable();
        }
        return respond(rt, access, state);
      },
    ),
  };
}
