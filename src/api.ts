import { checkCapacity } from "./capacity";
import type {
  AnyCatalog,
  CapacityKey,
  FeatureKey,
  LimitKey,
  MeteredKey,
} from "./catalog";
import { resolveEntitlements, resolveMany, syncOrganization } from "./resolve";
import {
  type AuthWithContext,
  type EntitlementsRuntime,
  runtimeFromAuth,
} from "./runtime";
import type {
  CapacityResult,
  ConsumeResult,
  EntitlementsResult,
  FeatureCheckResult,
  LimitResult,
  MeteredLimitResult,
} from "./types";
import { consumeUsage, getLimit, hasFeature } from "./usage";

/** `getLimit`'s result for key `K`: metered keys also carry the counter. */
export type GetLimitResult<C extends AnyCatalog, K extends LimitKey<C>> =
  K extends MeteredKey<C> ? MeteredLimitResult<C, K> : LimitResult<C, K>;

/**
 * The typed server API, from `createEntitlements(auth, catalog)`. Every
 * method takes a plain organization id, so an app can wrap it behind its own
 * tenant checks. None throws for a refusal or an outage (see each result);
 * `consumeUsage` and `sync` throw inside a transaction.
 */
export type Entitlements<C extends AnyCatalog> = {
  /** The organization's resolved plan, features, limits and live overrides. */
  get(organizationId: string): Promise<EntitlementsResult<C>>;
  /** `get` for up to 1000 organizations, in the order given. `[]` → `[]`. */
  getMany(organizationIds: readonly string[]): Promise<EntitlementsResult<C>[]>;
  /** Whether the organization has a feature. */
  hasFeature<K extends FeatureKey<C>>(
    organizationId: string,
    feature: K,
  ): Promise<FeatureCheckResult<C, K>>;
  /** A limit of any kind; metered keys also report the counter (nothing consumed). */
  getLimit<K extends LimitKey<C>>(
    organizationId: string,
    key: K,
  ): Promise<GetLimitResult<C, K>>;
  /** Consumes `amount` (default 1) of a metered limit, atomically; a refusal counts nothing. */
  consumeUsage<K extends MeteredKey<C>>(
    organizationId: string,
    key: K,
    options?: { amount?: number },
  ): Promise<ConsumeResult<C, K>>;
  /** Compares an app-supplied `count` (plus `adding`, default 1) with a capacity limit. */
  checkCapacity<K extends CapacityKey<C>>(
    organizationId: string,
    key: K,
    options: { count: number; adding?: number },
  ): Promise<CapacityResult<C, K>>;
  /** Resyncs from the billing source now and returns the fresh result (cache bypassed). */
  sync(organizationId: string): Promise<EntitlementsResult<C>>;
  /** Clears this process's cached result for the organization. */
  invalidate(organizationId: string): Promise<void>;
};

const MISMATCH =
  "[@byo-oss/entitlements] createEntitlements got a different catalog than the plugin";

/** Structural equality over plain data (objects, arrays, primitives). */
function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || !a || !b) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every(
    (key) =>
      Object.hasOwn(b, key) &&
      deepEqual(
        (a as Record<string, unknown>)[key],
        (b as Record<string, unknown>)[key],
      ),
  );
}

/** Whether `given` is the plugin's catalog: the same object, else deeply equal. */
export function sameCatalog(plugin: AnyCatalog, given: AnyCatalog): boolean {
  return plugin === given || deepEqual(plugin, given);
}

/**
 * The typed server API for the entitlements plugin installed on `auth`.
 * `catalog` types the methods and must be the plugin's catalog: checked on
 * the first call, by reference, else by deep equality; otherwise every call
 * throws `[@byo-oss/entitlements] createEntitlements got a different catalog
 * than the plugin`.
 *
 * ```ts
 * export const entitlements = createEntitlements(auth, catalog)
 * await entitlements.hasFeature(orgId, "exports")
 * await entitlements.consumeUsage(orgId, "apiCalls", { amount: 1 })
 * ```
 */
export function createEntitlements<C extends AnyCatalog>(
  auth: AuthWithContext,
  catalog: C,
): Entitlements<C> {
  let runtime: Promise<EntitlementsRuntime> | undefined;
  const rt = (): Promise<EntitlementsRuntime> => {
    runtime ??= runtimeFromAuth(auth, "createEntitlements").then((found) => {
      if (!sameCatalog(found.catalog, catalog)) throw new Error(MISMATCH);
      return found;
    });
    return runtime;
  };
  return {
    get: async (organizationId) =>
      (await resolveEntitlements(
        await rt(),
        organizationId,
      )) as EntitlementsResult<C>,
    getMany: async (organizationIds) =>
      (await resolveMany(
        await rt(),
        organizationIds,
      )) as EntitlementsResult<C>[],
    hasFeature: async (organizationId, feature) =>
      (await hasFeature(await rt(), organizationId, feature)) as never,
    getLimit: async (organizationId, key) =>
      (await getLimit(await rt(), organizationId, key)) as never,
    consumeUsage: async (organizationId, key, options) =>
      (await consumeUsage(await rt(), organizationId, key, options)) as never,
    checkCapacity: async (organizationId, key, options) =>
      (await checkCapacity(await rt(), organizationId, key, options)) as never,
    sync: async (organizationId) =>
      (await syncOrganization(await rt(), organizationId))
        .result as EntitlementsResult<C>,
    invalidate: async (organizationId) => {
      (await rt()).cache.delete(organizationId);
    },
  };
}
