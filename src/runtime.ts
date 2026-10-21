import type { AuthContext } from "better-auth";
import { createCache, type EntitlementsCache } from "./cache";
import type { AnyCatalog } from "./catalog";
import {
  ENTITLEMENTS_DEFAULTS,
  type ResolvedEntitlementsOptions,
} from "./options";

const PREFIX = "[@byo-oss/entitlements]";

/** Logger shape the runtime uses: better-auth's `context.logger` fits. */
export type EntitlementsLogger = {
  debug: (message: string, ...args: unknown[]) => void;
  info: (message: string, ...args: unknown[]) => void;
  warn: (message: string, ...args: unknown[]) => void;
  error: (message: string, ...args: unknown[]) => void;
};

/**
 * Everything a module needs, created once per `entitlements()` call and
 * passed as the first argument (`rt`) to every service function.
 *
 * - `options`: the resolved options (`resolveOptions`).
 * - `catalog`: `options.catalog`.
 * - `context`: better-auth's context, captured in the plugin's `init`; null
 *   until then (use `requireContext`).
 * - `logger`: `context.logger` after `init`, `console` before.
 * - `cache`: the in-process LRU of resolved state (`cache.ts`).
 * - `flights`: the per-process single-flight map (`singleFlight`).
 * - `warned`: keys already warned about (`warnOnce`).
 * - `now`: the clock. Every module reads time through it, so a test can
 *   replace it.
 */
export type EntitlementsRuntime<C extends AnyCatalog = AnyCatalog> = {
  readonly options: ResolvedEntitlementsOptions<C>;
  readonly catalog: C;
  context: AuthContext | null;
  logger: EntitlementsLogger;
  readonly cache: EntitlementsCache;
  readonly flights: Map<string, Promise<unknown>>;
  readonly warned: Set<string>;
  now: () => Date;
};

const consoleLogger: EntitlementsLogger = {
  debug: (message, ...args) => console.debug(message, ...args),
  info: (message, ...args) => console.info(message, ...args),
  warn: (message, ...args) => console.warn(message, ...args),
  error: (message, ...args) => console.error(message, ...args),
};

/** Builds the runtime for resolved options. `init` fills `context` and `logger`. */
export function createRuntime<C extends AnyCatalog>(
  options: ResolvedEntitlementsOptions<C>,
): EntitlementsRuntime<C> {
  return {
    options,
    catalog: options.catalog,
    context: null,
    logger: consoleLogger,
    cache: createCache({
      ttlMs: options.cacheTtlMs,
      maxEntries: ENTITLEMENTS_DEFAULTS.cacheMaxEntries,
    }),
    flights: new Map(),
    warned: new Set(),
    now: () => new Date(),
  };
}

/** The captured context; throws when the plugin's `init` hasn't run. */
export function requireContext(rt: EntitlementsRuntime): AuthContext {
  if (!rt.context) {
    throw new Error(
      `${PREFIX} the plugin isn't initialized yet: add entitlements() to betterAuth({ plugins }) and await auth.$context`,
    );
  }
  return rt.context;
}

/**
 * Runs `fn` once per `key` at a time in this process: concurrent callers
 * with the same key share the first caller's promise. The entry is removed
 * when it settles, so a later call runs `fn` again.
 */
export function singleFlight<T>(
  rt: EntitlementsRuntime,
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  const running = rt.flights.get(key);
  if (running) return running as Promise<T>;
  const promise = fn().finally(() => {
    if (rt.flights.get(key) === promise) rt.flights.delete(key);
  });
  rt.flights.set(key, promise);
  return promise;
}

/** Logs `message` as a warning the first time `key` is seen in this process. */
export function warnOnce(
  rt: EntitlementsRuntime,
  key: string,
  message: string,
): void {
  if (rt.warned.has(key)) return;
  rt.warned.add(key);
  rt.logger.warn(`${PREFIX} ${message}`);
}

/**
 * Any better-auth instance (your `auth`). Loose on purpose: a typed
 * instance's `$context` doesn't assign to the generic `AuthContext`.
 */
export type AuthWithContext = { $context: Promise<object> };

/** The plugin id. */
export const PLUGIN_ID = "entitlements";

/**
 * The runtime of the entitlements plugin installed on `auth`. Awaits
 * `auth.$context` (so `init` has run) and reads the plugin's `options`,
 * which is the runtime. Throws
 * `[@byo-oss/entitlements] <caller> needs the entitlements plugin installed on this auth instance`.
 */
export async function runtimeFromAuth(
  auth: AuthWithContext,
  caller: string,
): Promise<EntitlementsRuntime> {
  const context = (await auth.$context) as AuthContext;
  const plugin = context.options.plugins?.find((p) => p.id === PLUGIN_ID) as
    | { options?: EntitlementsRuntime }
    | undefined;
  const rt = plugin?.options;
  if (!rt || typeof rt !== "object" || !("catalog" in rt) || !rt.flights) {
    throw new Error(
      `${PREFIX} ${caller} needs the entitlements plugin installed on this auth instance`,
    );
  }
  return rt;
}
