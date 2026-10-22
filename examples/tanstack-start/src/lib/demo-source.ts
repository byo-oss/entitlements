import type { BillingSource, BillingState } from "@byo-oss/entitlements";

/**
 * A stand-in billing provider, so the example shows read-through, snapshots
 * and refresh without a Stripe account. Billing state lives in memory in the
 * server process: every organization starts with none (Free), and
 * `simulateCheckout` in `actions.ts` moves one to Pro the way a checkout
 * webhook would.
 *
 * Production apps pass a real source instead, such as `fromBetterAuthStripe()`
 * from `@byo-oss/entitlements/stripe`.
 */
const states = new Map<string, BillingState>();
let changed: ((organizationId: string) => Promise<void>) | null = null;

export const demoSource = {
  id: "demo",
  // Read-through: the plugin calls this for an organization with no snapshot,
  // and on refresh. No billing state answers `null`, which is the default plan.
  async resolve(organizationId) {
    const state = states.get(organizationId);
    return state ? { ...state } : null;
  },
  // The plugin hands over `changed` at boot; calling it resyncs one
  // organization's snapshot now (what a webhook handler does).
  connect(_context, onChanged) {
    changed = onChanged;
  },
} satisfies BillingSource;

/** What a completed checkout reports: Pro, active, for the next 30 days. */
export async function checkoutToPro(organizationId: string): Promise<void> {
  if (!changed) throw new Error("The demo billing source isn't connected yet");
  const periodStart = new Date();
  const periodEnd = new Date(periodStart.getTime() + 30 * 86_400_000);
  states.set(organizationId, {
    planKey: "pro",
    status: "active",
    periodStart,
    periodEnd,
  });
  await changed(organizationId);
}
