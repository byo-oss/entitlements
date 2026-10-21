// BYO_STUB: N11 replaces this file (contracts.md "react/use-entitlements.ts")
import type {
  AnyCatalog,
  FeatureKey,
  LimitKey,
  LimitValue,
  MeteredKey,
} from "../catalog";
import type { EntitlementsResponse, UsageInfo, Wire } from "../types";

/** A better-auth fetch result. */
type ClientResult<T> = Promise<
  | { data: T; error: null }
  | { data: null; error: { status: number; message?: string } }
>;

/**
 * The part of a better-auth client (`createAuthClient({ plugins:
 * [entitlementsClient()] })`) the hook calls.
 */
export type EntitlementsClientLike = {
  entitlements: {
    get: (input: {
      query: { organizationId: string };
    }) => ClientResult<unknown>;
    refresh: (input: { organizationId: string }) => ClientResult<unknown>;
  };
};

/** What `useEntitlements` returns. */
export type UseEntitlementsResult<C extends AnyCatalog = AnyCatalog> = {
  /** The last response (dates as ISO strings), or null before the first. */
  data: Wire<EntitlementsResponse<C>> | null;
  isLoading: boolean;
  error: Error | null;
  /** The resolved feature value; false while loading. */
  hasFeature: (key: FeatureKey<C>) => boolean;
  /** The resolved limit, or null while loading. */
  limit: (key: LimitKey<C>) => LimitValue | null;
  /** A metered key's usage, or null while loading. */
  usage: (key: MeteredKey<C>) => Wire<UsageInfo> | null;
  /** Calls `refreshEntitlements` (e.g. on return from checkout) and stores the answer. */
  refresh: () => Promise<void>;
};

/**
 * Loads an organization's entitlements through `client` (no global
 * client). All state lives in the hook; it reloads when `organizationId`
 * changes. Stub: always loading.
 */
export function useEntitlements<C extends AnyCatalog = AnyCatalog>(_input: {
  client: EntitlementsClientLike;
  organizationId: string;
}): UseEntitlementsResult<C> {
  return {
    data: null,
    isLoading: true,
    error: null,
    hasFeature: () => false,
    limit: () => null,
    usage: () => null,
    refresh: async () => {},
  };
}
