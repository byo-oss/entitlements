import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  /** True until the first answer (data or error) for this organization. */
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

type State<C extends AnyCatalog> = {
  organizationId: string;
  data: Wire<EntitlementsResponse<C>> | null;
  error: Error | null;
  settled: boolean;
};

function toError(cause: unknown): Error {
  if (cause instanceof Error) return cause;
  return new Error(typeof cause === "string" ? cause : "Request failed");
}

/**
 * Loads one organization's entitlements through a better-auth client and
 * keeps the answer in component state. The client is a prop (no global);
 * `refresh` re-reads with the cache bypassed and keeps the previous data
 * visible while it runs. Changing `organizationId` starts a new load.
 */
export function useEntitlements<C extends AnyCatalog = AnyCatalog>(input: {
  client: EntitlementsClientLike;
  organizationId: string;
}): UseEntitlementsResult<C> {
  const { client, organizationId } = input;
  const [state, setState] = useState<State<C>>({
    organizationId,
    data: null,
    error: null,
    settled: false,
  });

  // The latest client, without re-running the load when its identity changes.
  const clientRef = useRef(client);
  clientRef.current = client;
  // Only the newest request may write state.
  const requestId = useRef(0);

  const run = useCallback(
    async (kind: "get" | "refresh"): Promise<void> => {
      const id = ++requestId.current;
      let data: Wire<EntitlementsResponse<C>> | null = null;
      let error: Error | null = null;
      try {
        const api = clientRef.current.entitlements;
        const result =
          kind === "get"
            ? await api.get({ query: { organizationId } })
            : await api.refresh({ organizationId });
        if (result.error) {
          error = Object.assign(
            new Error(
              result.error.message ??
                `Request failed with status ${result.error.status}`,
            ),
            { status: result.error.status },
          );
        } else {
          data = result.data as Wire<EntitlementsResponse<C>>;
        }
      } catch (cause) {
        error = toError(cause);
      }
      if (id !== requestId.current) return;
      setState((previous) => ({
        organizationId,
        // A failed call keeps the last good answer for the same organization.
        data:
          data ??
          (previous.organizationId === organizationId ? previous.data : null),
        error,
        settled: true,
      }));
    },
    [organizationId],
  );

  useEffect(() => {
    void run("get");
    return () => {
      // Drop an answer that arrives after unmount or an organization change.
      requestId.current++;
    };
  }, [run]);

  const current = state.organizationId === organizationId;
  const data = current ? state.data : null;
  const error = current ? state.error : null;
  const isLoading = !current || !state.settled;

  const refresh = useCallback(() => run("refresh"), [run]);

  return useMemo<UseEntitlementsResult<C>>(
    () => ({
      data,
      isLoading,
      error,
      hasFeature: (key) =>
        (data?.features as Record<string, boolean> | undefined)?.[key] === true,
      limit: (key) =>
        (data?.limits as Record<string, LimitValue> | undefined)?.[key] ?? null,
      usage: (key) =>
        (data?.usage as Record<string, Wire<UsageInfo>> | undefined)?.[key] ??
        null,
      refresh,
    }),
    [data, isLoading, error, refresh],
  );
}
