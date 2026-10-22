/**
 * `@byo-oss/entitlements/stripe`: a `BillingSource` built on
 * `@better-auth/stripe` (an optional peer, imported for types only; the
 * source works on `context.getPlugin("stripe")`), and `stripePlans`, which
 * derives the Stripe plugin's `plans` from the catalog.
 */
import type { StripeOptions, StripePlan } from "@better-auth/stripe";
import type { AuthContext, DBTransactionAdapter } from "better-auth";
import { findOrganization, markEntitlementsQuery } from "../adapter";
import {
  type AnyCatalog,
  canonicalPlanKey,
  type PlanKey,
  planEntitlements,
  planKeys,
} from "../catalog";
import {
  type EntitlementsRuntime,
  runtimeFromContext,
  warnOnce,
} from "../runtime";
import { currentAdapter } from "../txn";
import type { BillingSource, BillingState } from "../types";

const PREFIX = "[@byo-oss/entitlements]";
const CALLER = "fromBetterAuthStripe";

export type FromBetterAuthStripeOptions = {
  /** The source id stored on snapshots. @default "stripe" */
  id?: string;
};

// ---------------------------------------------------------------------------
// Stripe shapes this module reads (kept local: `stripe` is not a dependency)
// ---------------------------------------------------------------------------

type StripeEventLike = {
  type: string;
  data: { object: Record<string, unknown> };
};

type SubscriptionRow = {
  id: string;
  plan: string | null;
  referenceId: string;
  stripeCustomerId?: string | null;
  stripeSubscriptionId?: string | null;
  status: string | null;
  periodStart?: Date | string | null;
  periodEnd?: Date | string | null;
  cancelAtPeriodEnd?: boolean | null;
  seats?: number | null;
};

type StripePluginLike = { id: string; options?: StripeOptions };

type OnEvent = (event: StripeEventLike) => Promise<void>;

/** What the `onEvent` wrapper acts for: the instance that connected last. */
type Binding = {
  context: AuthContext;
  changed: (organizationId: string) => Promise<void>;
};

// a registered symbol, so a re-evaluated module (dev hot reload, or the ESM
// and CJS builds side by side) still finds the wrapper it installed
const MARKER: unique symbol = Symbol.for(
  "@byo-oss/entitlements/stripe:onEvent",
) as never;

type WrappedOnEvent = OnEvent & { [MARKER]?: Binding };

const SUBSCRIPTION_EVENTS = new Set([
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
]);
const CHECKOUT_COMPLETED = "checkout.session.completed";

/** Entitled statuses, highest priority first. */
const ENTITLED_STATUSES = ["active", "trialing", "past_due"] as const;
const ENTITLED_LIMIT = 10;
const ANY_STATUS_LIMIT = 20;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const asString = (value: unknown): string | null =>
  typeof value === "string" && value !== "" ? value : null;

/** A Stripe expandable field: an id string or an object with an `id`. */
const idOf = (value: unknown): string | null =>
  asString(value) ??
  (typeof value === "object" && value !== null
    ? asString((value as { id?: unknown }).id)
    : null);

const metadataReferenceId = (object: Record<string, unknown>): string | null =>
  asString(
    (object.metadata as Record<string, unknown> | null | undefined)
      ?.referenceId,
  );

function toDate(value: Date | string | number | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

const timeOf = (row: SubscriptionRow): number | null =>
  toDate(row.periodEnd)?.getTime() ?? null;

function toBillingState(row: SubscriptionRow): BillingState {
  return {
    // an empty plan name stands for "no plan"
    planKey: asString(row.plan)?.toLowerCase() ?? null,
    status: row.status ?? null,
    periodStart: toDate(row.periodStart),
    periodEnd: toDate(row.periodEnd),
    cancelAtPeriodEnd: row.cancelAtPeriodEnd === true,
    seats: typeof row.seats === "number" ? row.seats : null,
    sourceRef: row.stripeSubscriptionId ?? null,
  };
}

/** The entitled row: active > trialing > past_due, ties by latest `periodEnd`. */
function pickEntitled(rows: SubscriptionRow[]): SubscriptionRow | null {
  let best: SubscriptionRow | null = null;
  let bestRank = Number.POSITIVE_INFINITY;
  let bestTime = Number.NEGATIVE_INFINITY;
  for (const row of rows) {
    const rank = (ENTITLED_STATUSES as readonly (string | null)[]).indexOf(
      row.status,
    );
    if (rank < 0) continue;
    const time = timeOf(row) ?? Number.NEGATIVE_INFINITY;
    if (
      best === null ||
      rank < bestRank ||
      (rank === bestRank && time > bestTime)
    ) {
      best = row;
      bestRank = rank;
      bestTime = time;
    }
  }
  return best;
}

/** The row with the latest non-null `periodEnd`, else any row. */
function pickLatest(rows: SubscriptionRow[]): SubscriptionRow | null {
  let best: SubscriptionRow | null = null;
  let bestTime: number | null = null;
  for (const row of rows) {
    const time = timeOf(row);
    if (time !== null && (bestTime === null || time > bestTime)) {
      best = row;
      bestTime = time;
    }
  }
  return best ?? rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// resolve
// ---------------------------------------------------------------------------

async function resolveFromSubscriptions(
  organizationId: string,
  adapter: DBTransactionAdapter,
): Promise<BillingState | null> {
  const entitled = await adapter.findMany<SubscriptionRow>(
    markEntitlementsQuery({
      model: "subscription",
      where: [
        { field: "referenceId", value: organizationId },
        {
          field: "status",
          operator: "in" as const,
          value: [...ENTITLED_STATUSES],
        },
      ],
      limit: ENTITLED_LIMIT,
    }),
  );
  const picked = pickEntitled(entitled);
  if (picked) return toBillingState(picked);
  // none entitled: keep the last status (no sort; picked in code)
  const any = await adapter.findMany<SubscriptionRow>(
    markEntitlementsQuery({
      model: "subscription",
      where: [{ field: "referenceId", value: organizationId }],
      limit: ANY_STATUS_LIMIT,
    }),
  );
  const latest = pickLatest(any);
  return latest ? toBillingState(latest) : null;
}

// ---------------------------------------------------------------------------
// connect: boot checks and the onEvent wrapper
// ---------------------------------------------------------------------------

function stripePluginOf(context: AuthContext): StripePluginLike {
  const getPlugin = (
    context as unknown as { getPlugin?: (id: string) => unknown }
  ).getPlugin;
  const plugin = (
    typeof getPlugin === "function"
      ? getPlugin("stripe")
      : context.options.plugins?.find((p) => p.id === "stripe")
  ) as StripePluginLike | null | undefined;
  if (!plugin?.options) {
    throw new Error(
      `${PREFIX} ${CALLER} needs the Stripe plugin: add stripe({ ... }) from @better-auth/stripe to plugins`,
    );
  }
  const { options } = plugin;
  if (!options.subscription?.enabled) {
    throw new Error(
      `${PREFIX} ${CALLER} needs Stripe subscriptions: pass subscription: { enabled: true, plans } to stripe()`,
    );
  }
  if (!options.organization?.enabled) {
    throw new Error(
      `${PREFIX} ${CALLER} needs organization subscriptions: pass organization: { enabled: true } to stripe()`,
    );
  }
  return plugin;
}

/** Awaits the Stripe plugin's `plans` and checks every name against the catalog. */
async function checkPlans(
  rt: EntitlementsRuntime,
  options: StripeOptions,
): Promise<void> {
  const given = (options.subscription as { plans?: unknown } | undefined)
    ?.plans as StripePlan[] | (() => StripePlan[] | Promise<StripePlan[]>);
  const plans = (typeof given === "function" ? await given() : given) as
    | StripePlan[]
    | undefined;
  if (!Array.isArray(plans)) {
    throw new Error(
      `${PREFIX} ${CALLER}: the Stripe plugin's subscription.plans must be a list (or a function returning one)`,
    );
  }
  for (const plan of plans) {
    const name = typeof plan?.name === "string" ? plan.name : "";
    if (!canonicalPlanKey(rt.catalog, name.toLowerCase())) {
      throw new Error(
        `${PREFIX} ${CALLER}: the Stripe plan "${name}" isn't a plan or alias of the entitlements catalog`,
      );
    }
    if (plan.group !== undefined && plan.group !== null) {
      warnOnce(
        rt,
        `stripe-group:${name}`,
        `${CALLER}: the Stripe plan "${name}" sets group "${plan.group}"; entitlements supports one live plan per organization and ignores groups`,
      );
    }
  }
}

/** The organization id a subscription or checkout event points to, or null. */
async function candidateOrganization(
  adapter: DBTransactionAdapter,
  event: StripeEventLike,
): Promise<string | null> {
  const object = event.data?.object ?? {};
  const subscriptionReference = async (stripeSubscriptionId: string | null) => {
    if (!stripeSubscriptionId) return null;
    const row = await adapter.findOne<SubscriptionRow>(
      markEntitlementsQuery({
        model: "subscription",
        where: [{ field: "stripeSubscriptionId", value: stripeSubscriptionId }],
      }),
    );
    return asString(row?.referenceId);
  };
  if (event.type === CHECKOUT_COMPLETED) {
    return (
      asString(object.client_reference_id) ??
      metadataReferenceId(object) ??
      (await subscriptionReference(idOf(object.subscription)))
    );
  }
  const fromRow = await subscriptionReference(asString(object.id));
  if (fromRow) return fromRow;
  const fromMetadata = metadataReferenceId(object);
  if (fromMetadata) return fromMetadata;
  const customer = idOf(object.customer);
  if (!customer) return null;
  const organization = await adapter.findOne<{ id: string }>(
    markEntitlementsQuery({
      model: "organization",
      where: [{ field: "stripeCustomerId", value: customer }],
    }),
  );
  return asString(organization?.id);
}

/** Resyncs the organization an event belongs to, when it is a live one. */
async function resyncFor(
  binding: Binding,
  event: StripeEventLike,
): Promise<void> {
  const rt = runtimeFromContext(binding.context, CALLER);
  const adapter = await currentAdapter(rt);
  const candidate = await candidateOrganization(adapter, event);
  if (!candidate) {
    rt.logger.debug(
      `${PREFIX} ${CALLER}: ${event.type} matches no organization; nothing to resync`,
    );
    return;
  }
  const organization = await findOrganization(adapter, candidate);
  if (!organization) {
    rt.logger.debug(
      `${PREFIX} ${CALLER}: ${event.type} belongs to "${candidate}", which isn't an existing organization; nothing to resync`,
    );
    return;
  }
  // `changed` logs a failure itself; the rejection reaches the Stripe
  // plugin, which answers 400 so Stripe redelivers
  await binding.changed(organization.id);
}

/**
 * Wraps the Stripe plugin's `onEvent` once. The wrapper resyncs first, for
 * checkout and subscription events, then calls the app's handler. A later
 * connect only rebinds it.
 */
function bindOnEvent(
  rt: EntitlementsRuntime,
  options: StripeOptions,
  binding: Binding,
): void {
  const current = options.onEvent as WrappedOnEvent | undefined;
  const bound = current?.[MARKER];
  if (bound) {
    if (bound.context !== binding.context) {
      rt.logger.warn(
        `${PREFIX} ${CALLER}: another betterAuth() instance connected to the same Stripe plugin object, and its webhooks now resync this instance only. Create one stripe() plugin per instance`,
      );
    }
    bound.context = binding.context;
    bound.changed = binding.changed;
    return;
  }
  const app = current as OnEvent | undefined;
  const state: Binding = { ...binding };
  const wrapper: WrappedOnEvent = async (event) => {
    if (
      event.type === CHECKOUT_COMPLETED ||
      SUBSCRIPTION_EVENTS.has(event.type)
    ) {
      await resyncFor(state, event);
    }
    await app?.(event);
  };
  wrapper[MARKER] = state;
  options.onEvent = wrapper as unknown as StripeOptions["onEvent"];
}

// ---------------------------------------------------------------------------
// The source
// ---------------------------------------------------------------------------

/**
 * A `BillingSource` reading `@better-auth/stripe`'s `subscription` table.
 *
 * - `connect(context, changed)` (awaited by the plugin's `init`) requires the
 *   Stripe plugin with `subscription.enabled` and `organization.enabled`,
 *   awaits its `plans` (a list or an async function) and fails boot when a
 *   plan name isn't a catalog plan or alias. A plan with `group` logs a
 *   warning (one live plan per organization).
 * - It wraps the Stripe plugin's `onEvent` once (symbol-marked). On
 *   `checkout.session.completed` and `customer.subscription.created`,
 *   `.updated` and `.deleted` the wrapper finds the organization, resyncs
 *   it, then calls your handler; other events go straight to your handler.
 *   An event for a user, a deleted organization or nothing known resyncs
 *   nothing (the webhook answers 200); a failed resync throws, so Stripe
 *   redelivers. Connecting again from the same context rebinds silently;
 *   another `betterAuth()` instance on the same Stripe plugin object takes
 *   the wrapper over and logs a warning. Create one Stripe plugin per
 *   instance.
 * - `resolve` reads `subscription` rows through `ctx.adapter` only and never
 *   writes them: the entitled row (active > trialing > past_due, latest
 *   `periodEnd` first), else the latest ended row, else null.
 */
export function fromBetterAuthStripe(
  options: FromBetterAuthStripeOptions = {},
): BillingSource {
  return {
    id: options.id ?? "stripe",
    resolve: (organizationId, ctx) =>
      resolveFromSubscriptions(organizationId, ctx.adapter),
    connect: async (context, changed) => {
      const rt = runtimeFromContext(context, CALLER);
      const plugin = stripePluginOf(context);
      const stripeOptions = plugin.options as StripeOptions;
      await checkPlans(rt, stripeOptions);
      bindOnEvent(rt, stripeOptions, { context, changed });
    },
  };
}

// ---------------------------------------------------------------------------
// stripePlans
// ---------------------------------------------------------------------------

/** Price settings per plan: everything a Stripe plugin plan takes except `name` and `limits`. */
export type StripePlanPrices = Omit<StripePlan, "name" | "limits">;

/**
 * The Stripe plugin's `plans`, one per plan key in `prices`, in catalog
 * order: `name` = the plan key, `limits` = that plan's catalog limits (for
 * the plugin's own display; never read back). Throws
 * `[@byo-oss/entitlements] stripePlans: "<key>" is not a plan` for a key
 * outside the catalog.
 */
export function stripePlans<C extends AnyCatalog>(
  catalog: C,
  prices: { [K in PlanKey<C>]?: StripePlanPrices },
): StripePlan[] {
  const keys = planKeys(catalog) as string[];
  const given = prices as Record<string, StripePlanPrices | undefined>;
  for (const key of Object.keys(given)) {
    if (!keys.includes(key)) {
      throw new Error(`${PREFIX} stripePlans: "${key}" is not a plan`);
    }
  }
  const plans: StripePlan[] = [];
  for (const key of keys) {
    const price = given[key];
    if (price === undefined) continue;
    plans.push({
      ...price,
      name: key,
      limits: { ...planEntitlements(catalog, key as PlanKey<C>).limits },
    });
  }
  return plans;
}
