/**
 * The entitlements catalog: features, limits and plans, declared once and
 * imported by the server, the web app and a static pricing page.
 *
 * This module imports nothing, so it is safe in any bundle. The public
 * subpath `./catalog` (`catalog-entry.ts`) re-exports only
 * `defineEntitlements`, `upgradeTo` and the types; the other helpers here are
 * internal.
 *
 * ```ts
 * export const catalog = defineEntitlements({
 *   features: ["exports", "sso"],
 *   limits: {
 *     apiCalls: { kind: "metered", period: "day" },
 *     members: { kind: "capacity" },
 *     retentionDays: { kind: "value" },
 *   },
 *   plans: {
 *     free: {
 *       features: { exports: false, sso: false },
 *       limits: { apiCalls: 1_000, members: 5, retentionDays: 7 },
 *       display: { name: "Free" },
 *     },
 *     pro: {
 *       features: { exports: true, sso: false },
 *       limits: { apiCalls: 50_000, members: 50, retentionDays: 90 },
 *     },
 *   },
 *   defaultPlan: "free",
 *   planAliases: { legacy: "pro" },
 * });
 * ```
 */

// ---------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------

/** How a metered limit's counter resets: UTC day, UTC month, or the subscription period. */
export type MeteredPeriod = "day" | "month" | "billing";

/** A metered limit: a counter per period, consumed with `consumeUsage`. */
export type MeteredLimitDefinition = {
  readonly kind: "metered";
  readonly period: MeteredPeriod;
};
/** A capacity limit: compared with a count the app supplies, through `checkCapacity`. */
export type CapacityLimitDefinition = { readonly kind: "capacity" };
/** A value limit: a plan setting, read with `getLimit`. */
export type ValueLimitDefinition = { readonly kind: "value" };

export type LimitDefinition =
  | MeteredLimitDefinition
  | CapacityLimitDefinition
  | ValueLimitDefinition;

export type LimitKind = LimitDefinition["kind"];

/** A limit's value in a plan: a non-negative integer, or `"unlimited"`. */
export type LimitValue = number | "unlimited";

/** The display copy a plan may carry when its type isn't known. */
type AnyDisplay = Readonly<Record<string, unknown>> | undefined;

// `display` is optional when `D` includes `undefined` (a plan without one,
// or display not known), required otherwise
type PlanDisplay<D> = undefined extends D
  ? { readonly display?: Exclude<D, undefined> }
  : { readonly display: D };

/**
 * What one plan includes. Every feature and limit key is set, and nothing
 * else. `D` is the plan's display type: `defineEntitlements` infers it
 * from the plan as written (`undefined` when the plan has none); the
 * default is an optional `Readonly<Record<string, unknown>>`.
 */
export type PlanDefinition<
  F extends string = string,
  L extends string = string,
  D = AnyDisplay,
> = {
  readonly features: { readonly [K in F]: boolean };
  readonly limits: { readonly [K in L]: LimitValue };
} & PlanDisplay<D>;

/**
 * A catalog as `defineEntitlements` returns it. `D` maps each plan key to
 * that plan's display type (free-form copy such as a name or tagline,
 * returned as given), so `catalog.plans.pro.display.name` is typed. It
 * defaults to an optional `Readonly<Record<string, unknown>>` per plan.
 */
export type Catalog<
  F extends string = string,
  LD extends Record<string, LimitDefinition> = Record<string, LimitDefinition>,
  P extends string = string,
  A extends string = string,
  D extends { readonly [K in P]: unknown } = { readonly [K in P]: AnyDisplay },
> = {
  readonly features: readonly F[];
  readonly limits: LD;
  readonly plans: {
    readonly [K in P]: PlanDefinition<F, keyof LD & string, D[K]>;
  };
  readonly defaultPlan: P;
  readonly planAliases: { readonly [K in A]: P };
};

/** Any catalog. Functions that work on every catalog take this. */
// biome-ignore lint/suspicious/noExplicitAny: the widest catalog; key types are checked where they're used
export type AnyCatalog = Catalog<any, any, any, any, any>;

/** The feature keys of a catalog. */
export type FeatureKey<C extends AnyCatalog> = C["features"][number] & string;
/** Every limit key of a catalog. */
export type LimitKey<C extends AnyCatalog> = keyof C["limits"] & string;
/** The plan keys of a catalog (aliases excluded). */
export type PlanKey<C extends AnyCatalog> = keyof C["plans"] & string;
/** The alias keys of a catalog. */
export type PlanAliasKey<C extends AnyCatalog> = keyof C["planAliases"] &
  string;

type LimitKeyOfKind<C extends AnyCatalog, K extends LimitKind> = {
  [L in LimitKey<C>]: C["limits"][L] extends { kind: K } ? L : never;
}[LimitKey<C>];

/** The `metered` limit keys of a catalog (what `consumeUsage` takes). */
export type MeteredKey<C extends AnyCatalog> = LimitKeyOfKind<C, "metered">;
/** The `capacity` limit keys of a catalog (what `checkCapacity` takes). */
export type CapacityKey<C extends AnyCatalog> = LimitKeyOfKind<C, "capacity">;
/** The `value` limit keys of a catalog. */
export type ValueKey<C extends AnyCatalog> = LimitKeyOfKind<C, "value">;

// ---------------------------------------------------------------------------
// Type-level checks for defineEntitlements
// ---------------------------------------------------------------------------

type Lower =
  | "a"
  | "b"
  | "c"
  | "d"
  | "e"
  | "f"
  | "g"
  | "h"
  | "i"
  | "j"
  | "k"
  | "l"
  | "m"
  | "n"
  | "o"
  | "p"
  | "q"
  | "r"
  | "s"
  | "t"
  | "u"
  | "v"
  | "w"
  | "x"
  | "y"
  | "z";
type Digit = "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9";

type RestIsPlanKey<S extends string> = S extends ""
  ? true
  : S extends `${infer H}${infer R}`
    ? H extends Lower | Digit | "_" | "-"
      ? RestIsPlanKey<R>
      : false
    : false;

/** `true` when `K` matches `/^[a-z][a-z0-9_-]*$/` (checked per character). */
export type IsPlanKey<K extends string> = string extends K
  ? true
  : K extends `${infer H}${infer R}`
    ? H extends Lower
      ? RestIsPlanKey<R>
      : false
    : false;

/** `X` with every key outside `Keys` mapped to `never`, so extra keys are errors. */
type Only<X, Keys extends PropertyKey, V> = { readonly [K in Keys]: V } & {
  readonly [K in Exclude<keyof X, Keys>]: never;
};

// `D` is the shared display shape from `defineEntitlements<D>()`; the
// default is the untyped display of the one-call form
type CheckPlan<
  K,
  X,
  F extends string,
  L extends string,
  D extends object = Readonly<Record<string, unknown>>,
> = K extends string
  ? IsPlanKey<K> extends true
    ? {
        readonly features: Only<
          X extends { features: infer XF } ? XF : unknown,
          F,
          boolean
        >;
        readonly limits: Only<
          X extends { limits: infer XL } ? XL : unknown,
          L,
          LimitValue
        >;
        readonly display?: D;
      } & {
        readonly [Extra in Exclude<
          keyof X,
          "features" | "limits" | "display"
        >]: never;
      } & ShapeRules<X, D>
    : `plan key "${K}" must match /^[a-z][a-z0-9_-]*$/`
  : never;

// the keys of `D`, or of each member when `D` is a union
type ShapeKeys<D> = D extends unknown ? keyof D : never;

// With a shared shape `D` (not the untyped default): `display` is required
// when `D` has a required key, and a top-level display key `D` doesn't name
// is an error. The required rule holds even for a `D` with an index signature
type ShapeRules<X, D> = (Record<never, never> extends D
  ? unknown
  : { readonly display: D }) &
  (string extends ShapeKeys<D>
    ? unknown
    : {
        readonly display?: {
          readonly [K in Exclude<
            X extends { display: infer XD } ? keyof XD : never,
            ShapeKeys<D>
          >]: never;
        };
      });

type CheckAlias<K, P extends string> = K extends P
  ? `plan alias "${K & string}" shadows a plan`
  : P;

// each plan's display type as written: the plan's own `display`, or
// `undefined` when it sets none
type PlanDisplays<PL> = {
  readonly [K in keyof PL]: "display" extends keyof PL[K]
    ? PL[K]["display" & keyof PL[K]]
    : undefined;
};

/** The object `defineEntitlements` takes, as the app writes it. */
export type CatalogInput<
  F extends string,
  LD extends Record<string, LimitDefinition>,
  PL extends Record<string, unknown>,
  AL extends Record<string, keyof PL & string>,
  D extends object = Readonly<Record<string, unknown>>,
> = {
  readonly features: readonly F[];
  readonly limits: LD;
  readonly plans: PL & {
    readonly [K in keyof PL]: CheckPlan<
      K,
      PL[K],
      NoInfer<F>,
      NoInfer<keyof LD & string>,
      D
    >;
  };
  readonly defaultPlan: NoInfer<keyof PL & string>;
  readonly planAliases?: AL & {
    readonly [K in keyof AL]: CheckAlias<K, NoInfer<keyof PL & string>>;
  };
};

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

/** At most this many feature and limit keys together. */
export const MAX_CATALOG_KEYS = 150;

/** Plan keys (and alias keys) match this: `@better-auth/stripe` lowercases plan names. */
export const PLAN_KEY_PATTERN = /^[a-z][a-z0-9_-]*$/;

const PREFIX = "[@byo-oss/entitlements]";

const METERED_PERIODS: readonly string[] = ["day", "month", "billing"];
const LIMIT_KINDS: readonly string[] = ["metered", "capacity", "value"];

function fail(message: string): never {
  throw new Error(`${PREFIX} ${message}`);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const has = (object: object, key: string) => Object.hasOwn(object, key);

/** Whether `value` is a valid limit value: a non-negative integer or `"unlimited"`. */
export function isLimitValue(value: unknown): value is LimitValue {
  return (
    value === "unlimited" ||
    (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
  );
}

/**
 * Checks a catalog and throws a `[@byo-oss/entitlements] …` error for the
 * first problem found. `defineEntitlements` and the plugin both run it.
 *
 * Rules, in order:
 * - `features` is a list of unique, non-empty strings;
 * - each limit has kind `metered` (with period `day`, `month` or
 *   `billing`), `capacity` or `value`, and no key is both a feature and a
 *   limit;
 * - at most 150 feature and limit keys together;
 * - at least one plan; plan keys match `/^[a-z][a-z0-9_-]*$/`;
 * - every plan sets every feature (a boolean) and every limit (a
 *   non-negative integer or `"unlimited"`), and no unknown key or field;
 * - `defaultPlan` is a plan;
 * - an alias key matches the plan-key pattern, doesn't shadow a plan, and
 *   points to a plan.
 */
export function validateCatalog(catalog: unknown): void {
  if (!isRecord(catalog)) {
    fail("catalog is required (build it with defineEntitlements)");
  }
  if (!Array.isArray(catalog.features)) {
    fail("catalog.features must be an array");
  }
  const features = new Set<string>();
  for (const feature of catalog.features as unknown[]) {
    if (typeof feature !== "string" || feature === "") {
      fail("catalog.features must hold non-empty strings");
    }
    if (features.has(feature)) fail(`feature "${feature}" is listed twice`);
    features.add(feature);
  }
  if (!isRecord(catalog.limits)) fail("catalog.limits must be an object");
  const limits = catalog.limits as Record<string, unknown>;
  for (const [key, definition] of Object.entries(limits)) {
    if (features.has(key)) fail(`"${key}" is both a feature and a limit`);
    if (
      !isRecord(definition) ||
      !LIMIT_KINDS.includes(String(definition.kind))
    ) {
      fail(`limit "${key}" needs kind "metered", "capacity" or "value"`);
    }
    if (
      definition.kind === "metered" &&
      !METERED_PERIODS.includes(String(definition.period))
    ) {
      fail(`metered limit "${key}" needs period "day", "month" or "billing"`);
    }
  }
  const limitKeys = Object.keys(limits);
  const keyCount = features.size + limitKeys.length;
  if (keyCount > MAX_CATALOG_KEYS) {
    fail(
      `the catalog has ${keyCount} feature and limit keys; at most ${MAX_CATALOG_KEYS} are allowed`,
    );
  }
  if (!isRecord(catalog.plans)) fail("catalog.plans must be an object");
  const plans = catalog.plans as Record<string, unknown>;
  if (Object.keys(plans).length === 0) {
    fail("catalog.plans needs at least one plan");
  }
  for (const [planKey, plan] of Object.entries(plans)) {
    if (!PLAN_KEY_PATTERN.test(planKey)) {
      fail(
        `plan key "${planKey}" must match /^[a-z][a-z0-9_-]*$/ (@better-auth/stripe lowercases plan names)`,
      );
    }
    if (!isRecord(plan)) fail(`plan "${planKey}" must be an object`);
    for (const field of Object.keys(plan)) {
      if (field !== "features" && field !== "limits" && field !== "display") {
        fail(`plan "${planKey}" sets unknown field "${field}"`);
      }
    }
    if (!isRecord(plan.features)) fail(`plan "${planKey}" needs features`);
    if (!isRecord(plan.limits)) fail(`plan "${planKey}" needs limits`);
    const planFeatures = plan.features as Record<string, unknown>;
    const planLimits = plan.limits as Record<string, unknown>;
    for (const feature of features) {
      if (!has(planFeatures, feature)) {
        fail(`plan "${planKey}" is missing feature "${feature}"`);
      }
      if (typeof planFeatures[feature] !== "boolean") {
        fail(`plan "${planKey}" feature "${feature}" must be true or false`);
      }
    }
    for (const key of Object.keys(planFeatures)) {
      if (!features.has(key)) {
        fail(`plan "${planKey}" sets unknown feature "${key}"`);
      }
    }
    for (const key of limitKeys) {
      if (!has(planLimits, key)) {
        fail(`plan "${planKey}" is missing limit "${key}"`);
      }
      if (!isLimitValue(planLimits[key])) {
        fail(
          `plan "${planKey}" limit "${key}" must be a non-negative integer or "unlimited"`,
        );
      }
    }
    for (const key of Object.keys(planLimits)) {
      if (!has(limits, key)) {
        fail(`plan "${planKey}" sets unknown limit "${key}"`);
      }
    }
    if (plan.display !== undefined && !isRecord(plan.display)) {
      fail(`plan "${planKey}" display must be an object`);
    }
  }
  if (
    typeof catalog.defaultPlan !== "string" ||
    !has(plans, catalog.defaultPlan)
  ) {
    fail(`defaultPlan "${String(catalog.defaultPlan)}" is not in plans`);
  }
  if (catalog.planAliases === undefined) return;
  if (!isRecord(catalog.planAliases)) {
    fail("catalog.planAliases must be an object");
  }
  for (const [alias, target] of Object.entries(catalog.planAliases)) {
    if (!PLAN_KEY_PATTERN.test(alias)) {
      fail(`plan alias "${alias}" must match /^[a-z][a-z0-9_-]*$/`);
    }
    if (has(plans, alias)) fail(`plan alias "${alias}" shadows a plan`);
    if (typeof target !== "string" || !has(plans, target)) {
      fail(
        `plan alias "${alias}" points to "${String(target)}", which is not in plans`,
      );
    }
  }
}

/**
 * Declares the catalog with one display shape for every plan. Call it with
 * the shape as the type argument, then call the result with the catalog:
 *
 * ```ts
 * const catalog = defineEntitlements<PlanCopy>()({ ... });
 * ```
 *
 * Each plan's `display` must be assignable to `D`: required when `D` has a
 * required key, and a top-level key `D` doesn't name is an error. Each plan keeps its
 * own display literal, as in the one-call form.
 *
 * It is curried because TypeScript has no partial type-argument inference:
 * giving `D` explicitly would force `F`, `LD`, `PL` and `AL` to be given too,
 * so the shape is fixed first and the catalog's own types are inferred from
 * the second call.
 */
export function defineEntitlements<
  D extends object = Readonly<Record<string, unknown>>,
>(): <
  const F extends string,
  const LD extends Record<string, LimitDefinition>,
  const PL extends Record<string, unknown>,
  const AL extends Record<string, keyof PL & string> = Record<never, never>,
>(
  catalog: CatalogInput<F, LD, PL, AL, D>,
) => Catalog<F, LD, keyof PL & string, keyof AL & string, PlanDisplays<PL>>;
/**
 * Declares the catalog. Checks it with `validateCatalog` (a bad catalog is
 * a type error, and throws here too) and returns it typed, with
 * `planAliases` defaulted to `{}`. Each plan keeps its `display` type, so a
 * pricing page reads `catalog.plans.pro.display.name` typed.
 */
export function defineEntitlements<
  const F extends string,
  const LD extends Record<string, LimitDefinition>,
  const PL extends Record<string, unknown>,
  const AL extends Record<string, keyof PL & string> = Record<never, never>,
>(
  catalog: CatalogInput<F, LD, PL, AL>,
): Catalog<F, LD, keyof PL & string, keyof AL & string, PlanDisplays<PL>>;
export function defineEntitlements(...args: unknown[]): unknown {
  // no arguments: the shape was fixed by the type argument; return the definer
  if (args.length === 0) return (catalog: unknown) => buildCatalog(catalog);
  return buildCatalog(args[0]);
}

function buildCatalog(input: unknown): unknown {
  validateCatalog(input);
  const catalog = input as CatalogInput<
    string,
    Record<string, LimitDefinition>,
    Record<string, unknown>,
    Record<string, string>
  >;
  return {
    features: catalog.features,
    limits: catalog.limits,
    plans: catalog.plans,
    defaultPlan: catalog.defaultPlan,
    planAliases: catalog.planAliases ?? {},
  };
}

/** The plan keys, in catalog order. */
export function planKeys<C extends AnyCatalog>(catalog: C): PlanKey<C>[] {
  return Object.keys(catalog.plans) as PlanKey<C>[];
}

/**
 * The catalog plan a billing plan key stands for: the key itself when it is
 * a plan, its alias target when it is an alias, else `null`.
 */
export function canonicalPlanKey<C extends AnyCatalog>(
  catalog: C,
  key: string | null | undefined,
): PlanKey<C> | null {
  if (!key) return null;
  if (has(catalog.plans, key)) return key as PlanKey<C>;
  // a catalog not built by defineEntitlements may leave planAliases out
  const aliases = (catalog.planAliases ?? {}) as Record<string, string>;
  if (has(aliases, key)) return aliases[key] as PlanKey<C>;
  return null;
}

/** The kind of a limit key, or `null` when the key isn't a limit. */
export function limitKind<C extends AnyCatalog>(
  catalog: C,
  key: string,
): LimitKind | null {
  if (!has(catalog.limits, key)) return null;
  return (catalog.limits as Record<string, LimitDefinition>)[key]?.kind ?? null;
}

/** Whether `key` is a feature of the catalog. */
export function isFeatureKey<C extends AnyCatalog>(
  catalog: C,
  key: string,
): key is FeatureKey<C> {
  return (catalog.features as readonly string[]).includes(key);
}

/**
 * A plan's features, limits and display as fresh copies (never the
 * catalog's own objects, so callers may adjust them). Throws for a key that
 * isn't a plan.
 */
export function planEntitlements<C extends AnyCatalog>(
  catalog: C,
  plan: PlanKey<C>,
): {
  features: Record<FeatureKey<C>, boolean>;
  limits: Record<LimitKey<C>, LimitValue>;
  display: Record<string, unknown>;
} {
  if (!has(catalog.plans, plan)) fail(`unknown plan "${plan}"`);
  const definition = (catalog.plans as Record<string, PlanDefinition>)[
    plan
  ] as PlanDefinition;
  return {
    features: { ...definition.features } as Record<FeatureKey<C>, boolean>,
    limits: { ...definition.limits } as Record<LimitKey<C>, LimitValue>,
    display: { ...(definition.display ?? {}) },
  };
}

/** What `upgradeTo` looks for: a feature, or a limit of at least `atLeast`. */
export type UpgradeTarget<C extends AnyCatalog> =
  | { feature: FeatureKey<C> }
  | { limit: LimitKey<C>; atLeast: number };

/**
 * The plan keys, in catalog order, whose plan includes `feature`, or whose
 * `limit` is `"unlimited"` or at least `atLeast`. Refusals carry it so an
 * app can say "upgrade to Pro".
 */
export function upgradeTo<C extends AnyCatalog>(
  catalog: C,
  target: UpgradeTarget<C>,
): PlanKey<C>[] {
  const plans = catalog.plans as Record<string, PlanDefinition>;
  return planKeys(catalog).filter((key) => {
    const plan = plans[key] as PlanDefinition;
    if ("feature" in target) {
      return (
        (plan.features as Record<string, boolean>)[target.feature] === true
      );
    }
    const value = (plan.limits as Record<string, LimitValue>)[target.limit];
    return value === "unlimited" || (value ?? -1) >= target.atLeast;
  });
}
