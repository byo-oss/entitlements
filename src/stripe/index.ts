// BYO_STUB: N10 replaces this file (contracts.md "stripe/index.ts")
/**
 * `@byo-oss/entitlements/stripe`: a `BillingSource` built on
 * `@better-auth/stripe` (an optional peer, imported for types only; the
 * source works on `context.getPlugin("stripe")`), and `stripePlans`, which
 * derives the Stripe plugin's `plans` from the catalog.
 */
import type { StripePlan } from "@better-auth/stripe";
import type { AnyCatalog, PlanKey } from "../catalog";
import type { BillingSource } from "../types";

export type FromBetterAuthStripeOptions = {
  /** The source id stored on snapshots. @default "stripe" */
  id?: string;
};

/**
 * The source. `connect` checks the Stripe plugin (subscriptions and
 * organizations enabled; every Stripe plan name a catalog key or alias;
 * warns on `group`), wraps its `onEvent` once (symbol-marked, rebinding on a
 * second instance) to resync before the app's handler on
 * `checkout.session.completed` and `customer.subscription.*`. `resolve`
 * reads `subscription` rows through `ctx.adapter` only.
 * Stub: `resolve` returns null; no `connect`.
 */
export function fromBetterAuthStripe(
  options: FromBetterAuthStripeOptions = {},
): BillingSource {
  return { id: options.id ?? "stripe", resolve: async () => null };
}

/** Price settings per plan: everything a Stripe plugin plan takes except `name` and `limits`. */
export type StripePlanPrices = Omit<StripePlan, "name" | "limits">;

/**
 * The Stripe plugin's `plans`, one per plan key in `prices`, in catalog
 * order: `name` = the plan key, `limits` = that plan's catalog limits (for
 * the plugin's own display; never read back). Throws
 * `[@byo-oss/entitlements] stripePlans: "<key>" is not a plan` for a key
 * outside the catalog.
 * Stub: an empty list.
 */
export function stripePlans<C extends AnyCatalog>(
  _catalog: C,
  _prices: { [K in PlanKey<C>]?: StripePlanPrices },
): StripePlan[] {
  return [];
}
