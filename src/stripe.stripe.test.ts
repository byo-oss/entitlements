import { type StripePlan, stripe } from "@better-auth/stripe";
import type { BetterAuthOptions, DBTransactionAdapter } from "better-auth";
import Stripe from "stripe";
import { describe, expect, it, vi } from "vitest";
import { isEntitlementsQuery } from "./adapter";
import { createEntitlements } from "./api";
import { syncOrganization } from "./resolve";
import type { EntitlementSnapshotRow } from "./schema";
import { fromBetterAuthStripe, stripePlans } from "./stripe";
import {
  type AdapterCall,
  type AnyTestAuth,
  expectNoOuterCalls,
  getContext,
  getRuntime,
  IN_TRANSACTION_PROBE_PATH,
  inTransactionProbe,
  makeAuth,
  seedOrg,
  setSnapshot,
  signUpUser,
  testCatalog,
} from "./test-utils";
import { assertLoadedVersions } from "./test-versions";
import { testBillingSource } from "./testing";
import { inTransaction } from "./txn";
import type { BillingSource, BillingState } from "./types";

// The Stripe lane: the real @better-auth/stripe plugin with a fake Stripe
// client (its `webhooks` helper is the real SDK's, so signatures are real),
// webhooks posted through `auth.handler` with a valid signature.

const SECRET = "test_secret";
const sdk = new Stripe(SECRET);
const DAY_MS = 86_400_000;
const PREFIX = "[@byo-oss/entitlements]";

const PRICES = {
  pro: { priceId: "price_pro" },
  team: { priceId: "price_team" },
};

const seconds = (date: Date) => Math.floor(date.getTime() / 1000);
const daysFromNow = (days: number) => new Date(Date.now() + days * DAY_MS);

type LogLine = { level: string; message: string };

type HarnessOptions = {
  /** The Stripe plugin's plans. @default stripePlans(testCatalog, PRICES) */
  plans?: StripePlan[] | (() => Promise<StripePlan[]>);
  /** Reuse a Stripe plugin object (the hot-reload case). */
  plugin?: ReturnType<typeof stripe>;
  /** Extra Stripe plugin options. */
  stripeOptions?: Record<string, unknown>;
  /** The app's own onEvent. */
  onEvent?: (event: Stripe.Event) => Promise<void>;
  /** Runs before every adapter call. */
  before?: (call: AdapterCall) => void | Promise<void>;
  authOptions?: Partial<BetterAuthOptions>;
};

/** Stripe subscriptions the fake client's `subscriptions.retrieve` knows. */
type FakeClient = { subscriptions: Map<string, Record<string, unknown>> };

function fakeStripeClient(): FakeClient & { client: Stripe } {
  const subscriptions = new Map<string, Record<string, unknown>>();
  const client = {
    webhooks: sdk.webhooks,
    subscriptions: {
      retrieve: async (id: string) => {
        const found = subscriptions.get(id);
        if (!found) throw new Error(`no such subscription: ${id}`);
        return found;
      },
    },
    customers: {
      retrieve: async (id: string) => ({ id, deleted: false }),
      update: async (id: string) => ({ id }),
    },
  } as unknown as Stripe;
  return { client, subscriptions };
}

function stripePlugin(
  client: Stripe,
  options: Pick<HarnessOptions, "plans" | "onEvent" | "stripeOptions"> = {},
) {
  return stripe({
    stripeClient: client,
    stripeWebhookSecret: SECRET,
    subscription: {
      enabled: true,
      plans: options.plans ?? stripePlans(testCatalog, PRICES),
    },
    organization: { enabled: true },
    ...(options.onEvent ? { onEvent: options.onEvent } : {}),
    ...options.stripeOptions,
  } as Parameters<typeof stripe>[0]);
}

/** A memory-lane auth with organization, entitlements(fromBetterAuthStripe) and the Stripe plugin. */
function harness(options: HarnessOptions = {}) {
  const logs: LogLine[] = [];
  const fake = fakeStripeClient();
  const plugin = options.plugin ?? stripePlugin(fake.client, options);
  const source = fromBetterAuthStripe();
  const auth = makeAuth({
    options: { source },
    plugins: [plugin, inTransactionProbe()],
    authOptions: {
      logger: {
        level: "debug",
        log: (level, message) => {
          logs.push({ level, message });
        },
      },
      ...options.authOptions,
    },
    adapter: options.before ? { before: options.before } : {},
  });
  return { auth, plugin, source, logs, fake };
}

type Harness = ReturnType<typeof harness>;

const ownLines = (logs: LogLine[], level: string) =>
  logs.filter((l) => l.level === level && l.message.includes(PREFIX));

/** Warnings from the Stripe source (not the plugin's own boot warnings). */
const sourceWarnings = (logs: LogLine[]) =>
  ownLines(logs, "warn").filter((l) =>
    l.message.includes("fromBetterAuthStripe"),
  );

async function seedSubscription(
  auth: AnyTestAuth,
  row: {
    referenceId: string;
    plan: string;
    status: string;
    stripeSubscriptionId?: string | null;
    stripeCustomerId?: string | null;
    periodStart?: Date | null;
    periodEnd?: Date | null;
    cancelAtPeriodEnd?: boolean;
    seats?: number | null;
  },
) {
  const { adapter } = await getContext(auth);
  return adapter.create<Record<string, unknown>, { id: string }>({
    model: "subscription",
    data: {
      stripeSubscriptionId: null,
      stripeCustomerId: null,
      periodStart: null,
      periodEnd: null,
      cancelAtPeriodEnd: false,
      seats: null,
      ...row,
    },
  });
}

async function setCustomer(
  auth: AnyTestAuth,
  organizationId: string,
  stripeCustomerId: string,
) {
  const { adapter } = await getContext(auth);
  await adapter.update({
    model: "organization",
    where: [{ field: "id", value: organizationId }],
    update: { stripeCustomerId },
  });
}

async function snapshotOf(
  auth: AnyTestAuth,
  organizationId: string,
): Promise<EntitlementSnapshotRow | null> {
  const { adapter } = await getContext(auth);
  return adapter.findOne<EntitlementSnapshotRow>({
    model: "entitlementSnapshot",
    where: [{ field: "organizationId", value: organizationId }],
  });
}

/** A Stripe subscription object as the webhook carries it (item-level periods). */
function stripeSubscription(input: {
  id: string;
  customer: string;
  priceId: string;
  status?: string;
  metadata?: Record<string, string>;
  periodEnd?: Date;
}) {
  const end = input.periodEnd ?? daysFromNow(30);
  return {
    id: input.id,
    object: "subscription",
    customer: input.customer,
    status: input.status ?? "active",
    metadata: input.metadata ?? {},
    cancel_at_period_end: false,
    cancel_at: null,
    canceled_at: null,
    ended_at: null,
    trial_start: null,
    trial_end: null,
    schedule: null,
    items: {
      object: "list",
      data: [
        {
          id: `si_${input.id}`,
          object: "subscription_item",
          quantity: 1,
          price: {
            id: input.priceId,
            object: "price",
            recurring: { interval: "month" },
          },
          current_period_start: seconds(new Date(end.getTime() - 30 * DAY_MS)),
          current_period_end: seconds(end),
        },
      ],
    },
  };
}

let eventSeq = 0;
function stripeEvent(type: string, object: Record<string, unknown>) {
  eventSeq += 1;
  return {
    id: `evt_${eventSeq}`,
    object: "event",
    type,
    api_version: "2025-01-27",
    created: seconds(new Date()),
    livemode: false,
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
    data: { object },
  };
}

/** Posts an event to /stripe/webhook with a valid signature; returns the response. */
async function postWebhook(auth: AnyTestAuth, event: object, payload?: string) {
  const body = payload ?? JSON.stringify(event);
  const signature = sdk.webhooks.generateTestHeaderString({
    payload: body,
    secret: SECRET,
  });
  return (
    auth as unknown as { handler: (r: Request) => Promise<Response> }
  ).handler(
    new Request("http://localhost:3000/api/auth/stripe/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "stripe-signature": signature,
      },
      body,
    }),
  );
}

/** The `onEvent` the Stripe plugin calls, as installed now. */
const installedOnEvent = (plugin: ReturnType<typeof stripe>) =>
  (plugin.options as { onEvent?: (event: unknown) => Promise<void> }).onEvent;

/** An org with a Stripe customer and an active `pro` subscription row. */
async function paidOrg(h: Harness, n: string) {
  const { organizationId, owner } = await seedOrg(h.auth);
  await setCustomer(h.auth, organizationId, `cus_${n}`);
  await seedSubscription(h.auth, {
    referenceId: organizationId,
    plan: "pro",
    status: "active",
    stripeSubscriptionId: `sub_${n}`,
    stripeCustomerId: `cus_${n}`,
    periodStart: daysFromNow(-5),
    periodEnd: daysFromNow(25),
  });
  return { organizationId, owner };
}

// ---------------------------------------------------------------------------
// PRD #3
// ---------------------------------------------------------------------------

describe("the Stripe lane's versions (PRD #3)", () => {
  it("loads the expected better-auth and @better-auth/stripe", () => {
    expect(() =>
      assertLoadedVersions(undefined, { stripe: true }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// stripePlans
// ---------------------------------------------------------------------------

describe("stripePlans", () => {
  it("names each plan by its key and carries its catalog limits, in catalog order", () => {
    const plans = stripePlans(testCatalog, {
      team: { priceId: "price_team", seatPriceId: "price_seat" },
      pro: {
        priceId: "price_pro",
        annualDiscountPriceId: "price_pro_year",
        freeTrial: { days: 14 },
      },
    });
    expect(plans.map((p) => p.name)).toEqual(["pro", "team"]);
    expect(plans[0]).toMatchObject({
      name: "pro",
      priceId: "price_pro",
      annualDiscountPriceId: "price_pro_year",
      freeTrial: { days: 14 },
      limits: testCatalog.plans.pro.limits,
    });
    expect(plans[1]).toMatchObject({
      name: "team",
      seatPriceId: "price_seat",
      limits: testCatalog.plans.team.limits,
    });
    // a copy: the plugin may keep it without touching the catalog
    expect(plans[0]?.limits).not.toBe(testCatalog.plans.pro.limits);
  });

  it("throws for a key that isn't a plan (aliases included)", () => {
    expect(() =>
      stripePlans(testCatalog, { enterprise: { priceId: "p" } } as never),
    ).toThrow(
      '[@byo-oss/entitlements] stripePlans: "enterprise" is not a plan',
    );
    expect(() =>
      stripePlans(testCatalog, { legacy: { priceId: "p" } } as never),
    ).toThrow('"legacy" is not a plan');
  });
});

// ---------------------------------------------------------------------------
// PRD #19: boot checks
// ---------------------------------------------------------------------------

describe("fromBetterAuthStripe at boot (PRD #19)", () => {
  it("fails boot without the Stripe plugin", async () => {
    const auth = makeAuth({
      options: { source: fromBetterAuthStripe() },
      authOptions: { logger: { disabled: true } },
    });
    await expect(auth.$context).rejects.toThrow(
      "[@byo-oss/entitlements] fromBetterAuthStripe needs the Stripe plugin",
    );
  });

  it("fails boot without subscriptions or organizations enabled", async () => {
    const fake = fakeStripeClient();
    const noSubscriptions = makeAuth({
      options: { source: fromBetterAuthStripe() },
      plugins: [
        stripe({
          stripeClient: fake.client,
          stripeWebhookSecret: SECRET,
          organization: { enabled: true },
        }),
      ],
      authOptions: { logger: { disabled: true } },
    });
    await expect(noSubscriptions.$context).rejects.toThrow(
      "[@byo-oss/entitlements] fromBetterAuthStripe needs Stripe subscriptions",
    );
    const noOrganizations = makeAuth({
      options: { source: fromBetterAuthStripe() },
      plugins: [
        stripe({
          stripeClient: fake.client,
          stripeWebhookSecret: SECRET,
          subscription: { enabled: true, plans: [] },
        }),
      ],
      authOptions: { logger: { disabled: true } },
    });
    await expect(noOrganizations.$context).rejects.toThrow(
      "[@byo-oss/entitlements] fromBetterAuthStripe needs organization subscriptions",
    );
  });

  it("fails boot when a Stripe plan name isn't a catalog plan or alias", async () => {
    const h = harness({
      plans: [{ name: "pro", priceId: "price_pro" }, { name: "enterprise" }],
    });
    await expect(h.auth.$context).rejects.toThrow(
      '[@byo-oss/entitlements] fromBetterAuthStripe: the Stripe plan "enterprise" isn\'t a plan or alias',
    );
  });

  it("accepts aliases and names in any case", async () => {
    const h = harness({
      plans: [{ name: "Pro", priceId: "price_pro" }, { name: "legacy" }],
    });
    await expect(h.auth.$context).resolves.toBeDefined();
  });

  it("awaits async plans: an unknown name in them fails boot, a group in them warns before boot ends", async () => {
    const late = <T>(value: T) =>
      new Promise<T>((resolve) => setTimeout(() => resolve(value), 20));
    const bad = harness({
      plans: () => late([{ name: "pro" }, { name: "gold" }]),
    });
    await expect(bad.auth.$context).rejects.toThrow('Stripe plan "gold"');

    const good = harness({
      plans: () => late([{ name: "pro", priceId: "price_pro", group: "main" }]),
    });
    await good.auth.$context;
    const warnings = ownLines(good.logs, "warn").filter((l) =>
      l.message.includes('sets group "main"'),
    );
    expect(warnings).toHaveLength(1);
  });

  it("warns once per plan that sets group", async () => {
    const h = harness({
      plans: [
        { name: "pro", priceId: "price_pro", group: "main" },
        { name: "team", priceId: "price_team" },
      ],
    });
    const context = await getContext(h.auth);
    const plugin = context.options.plugins?.find(
      (p) => p.id === "entitlements",
    );
    await plugin?.init?.(context);
    const warnings = ownLines(h.logs, "warn").filter((l) =>
      l.message.includes("group"),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toContain('"pro"');
  });
});

// ---------------------------------------------------------------------------
// PRD #19: resolve
// ---------------------------------------------------------------------------

describe("fromBetterAuthStripe resolve (PRD #19)", () => {
  async function resolveFor(h: Harness, organizationId: string) {
    const { adapter } = await getContext(h.auth);
    await h.auth.$context;
    return h.source.resolve(organizationId, {
      adapter: adapter as unknown as DBTransactionAdapter,
    });
  }

  it("no rows → null", async () => {
    const h = harness();
    const { organizationId } = await seedOrg(h.auth);
    expect(await resolveFor(h, organizationId)).toBeNull();
  });

  it("picks the entitled row over a newer canceled one", async () => {
    const h = harness();
    const { organizationId } = await seedOrg(h.auth);
    await seedSubscription(h.auth, {
      referenceId: organizationId,
      plan: "pro",
      status: "active",
      stripeSubscriptionId: "sub_active",
      periodEnd: daysFromNow(10),
    });
    await seedSubscription(h.auth, {
      referenceId: organizationId,
      plan: "team",
      status: "canceled",
      stripeSubscriptionId: "sub_newer",
      periodEnd: daysFromNow(40),
    });
    expect(await resolveFor(h, organizationId)).toMatchObject({
      planKey: "pro",
      status: "active",
      sourceRef: "sub_active",
    });
    const result = (
      await syncOrganization(await getRuntime(h.auth), organizationId)
    ).result;
    expect(result.plan).toMatchObject({ key: "pro", source: "billing" });
  });

  it("ranks active > trialing > past_due, ties by latest periodEnd", async () => {
    const h = harness();
    const { organizationId } = await seedOrg(h.auth);
    const rows: [string, string, number | null][] = [
      ["past_due", "team", 90],
      ["trialing", "team", 60],
      ["active", "pro", 5],
      ["active", "team", 20],
      ["active", "pro", null],
    ];
    for (const [status, plan, days] of rows) {
      await seedSubscription(h.auth, {
        referenceId: organizationId,
        plan,
        status,
        periodEnd: days === null ? null : daysFromNow(days),
      });
    }
    expect(await resolveFor(h, organizationId)).toMatchObject({
      planKey: "team",
      status: "active",
    });

    const other = (await seedOrg(h.auth)).organizationId;
    await seedSubscription(h.auth, {
      referenceId: other,
      plan: "pro",
      status: "past_due",
      periodEnd: daysFromNow(50),
    });
    await seedSubscription(h.auth, {
      referenceId: other,
      plan: "team",
      status: "trialing",
      periodEnd: daysFromNow(3),
    });
    expect(await resolveFor(h, other)).toMatchObject({
      planKey: "team",
      status: "trialing",
    });
  });

  it("falls back to the latest ended row, else any row", async () => {
    const h = harness();
    const { organizationId } = await seedOrg(h.auth);
    await seedSubscription(h.auth, {
      referenceId: organizationId,
      plan: "pro",
      status: "canceled",
      periodEnd: daysFromNow(-60),
    });
    await seedSubscription(h.auth, {
      referenceId: organizationId,
      plan: "team",
      status: "canceled",
      periodEnd: daysFromNow(-3),
    });
    await seedSubscription(h.auth, {
      referenceId: organizationId,
      plan: "pro",
      status: "incomplete_expired",
      periodEnd: null,
    });
    const state = await resolveFor(h, organizationId);
    expect(state).toMatchObject({ planKey: "team", status: "canceled" });
    // not entitled: the snapshot keeps the status, the plan is the default
    const rt = await getRuntime(h.auth);
    const { result, snapshot } = await syncOrganization(rt, organizationId);
    expect(result.plan.key).toBe("free");
    expect(snapshot?.status).toBe("canceled");

    const other = (await seedOrg(h.auth)).organizationId;
    await seedSubscription(h.auth, {
      referenceId: other,
      plan: "pro",
      status: "incomplete",
    });
    expect(await resolveFor(h, other)).toMatchObject({
      planKey: "pro",
      status: "incomplete",
      periodEnd: null,
    });
  });

  it("maps the row: lowercased plan, dates, flags, seats, the Stripe id; an empty plan is no plan", async () => {
    const h = harness();
    const { organizationId } = await seedOrg(h.auth);
    const periodStart = daysFromNow(-2);
    const periodEnd = daysFromNow(28);
    await seedSubscription(h.auth, {
      referenceId: organizationId,
      plan: "PRO",
      status: "active",
      stripeSubscriptionId: "sub_map",
      periodStart,
      periodEnd,
      cancelAtPeriodEnd: true,
      seats: 4,
    });
    const state = await resolveFor(h, organizationId);
    expect(state).toEqual({
      planKey: "pro",
      status: "active",
      periodStart,
      periodEnd,
      cancelAtPeriodEnd: true,
      seats: 4,
      sourceRef: "sub_map",
    });

    const other = (await seedOrg(h.auth)).organizationId;
    await seedSubscription(h.auth, {
      referenceId: other,
      plan: "",
      status: "canceled",
    });
    expect(await resolveFor(h, other)).toMatchObject({
      planKey: null,
      status: "canceled",
      periodEnd: null,
    });
  });

  it("reads only, with tagged findMany calls (limit 10, then 20) through ctx.adapter", async () => {
    const calls: AdapterCall[] = [];
    const h = harness({
      before: (call) => {
        if (call.model === "subscription") calls.push(call);
      },
    });
    const { organizationId } = await seedOrg(h.auth);
    await seedSubscription(h.auth, {
      referenceId: organizationId,
      plan: "pro",
      status: "canceled",
    });
    calls.length = 0;
    await resolveFor(h, organizationId);
    expect(calls.map((c) => [c.method, c.args.limit])).toEqual([
      ["findMany", 10],
      ["findMany", 20],
    ]);
    expect(calls.every((c) => isEntitlementsQuery(c.args))).toBe(true);
    expect(calls.every((c) => c.args.sortBy === undefined)).toBe(true);
    expect(calls[0]?.args.where).toEqual([
      { field: "referenceId", value: organizationId },
      {
        field: "status",
        operator: "in",
        value: ["active", "trialing", "past_due"],
      },
    ]);

    // a sync writes the snapshot, never Stripe's tables
    calls.length = 0;
    await syncOrganization(await getRuntime(h.auth), organizationId);
    expect(calls.map((c) => c.method)).toEqual(["findMany", "findMany"]);
  });
});

// ---------------------------------------------------------------------------
// PRD #18: the webhook push
// ---------------------------------------------------------------------------

describe("Stripe webhooks (PRD #18)", () => {
  it("a signed customer.subscription.updated updates the snapshot, then the app's onEvent runs once", async () => {
    let auth: AnyTestAuth | null = null;
    const seen: { type: string; plan: string | null | undefined }[] = [];
    const h = harness({
      onEvent: async (event) => {
        const organizationId = (
          event.data.object as { metadata?: { org?: string } }
        ).metadata?.org as string;
        const row = auth ? await snapshotOf(auth, organizationId) : null;
        seen.push({ type: event.type, plan: row?.planKey });
      },
    });
    auth = h.auth;
    const { organizationId } = await paidOrg(h, "upd");
    const rt = await getRuntime(h.auth);
    // warm: the org reads pro
    expect(
      (await createEntitlements(h.auth, testCatalog).get(organizationId)).plan
        .key,
    ).toBe("pro");

    const event = stripeEvent(
      "customer.subscription.updated",
      stripeSubscription({
        id: "sub_upd",
        customer: "cus_upd",
        priceId: "price_team",
        metadata: { org: organizationId },
      }),
    );
    const response = await postWebhook(h.auth, event);
    expect(response.status).toBe(200);
    expect((await snapshotOf(h.auth, organizationId))?.planKey).toBe("team");
    // the app's handler ran once, after the resync
    expect(seen).toEqual([
      { type: "customer.subscription.updated", plan: "team" },
    ]);
    // and the cache was refreshed: the next read is the new plan
    expect(
      (await createEntitlements(h.auth, testCatalog).get(organizationId)).plan
        .key,
    ).toBe("team");
    expect(ownLines(h.logs, "error")).toHaveLength(0);
    expect(rt.context).toBe(await getContext(h.auth));
  });

  it("a failed resync answers 400; across a redelivery the app handler runs once overall", async () => {
    let failNext = false;
    const onEvent = vi.fn(async () => {});
    const h = harness({
      onEvent,
      before: (call) => {
        if (
          failNext &&
          call.model === "subscription" &&
          call.method === "findMany" &&
          isEntitlementsQuery(call.args)
        ) {
          failNext = false;
          throw new Error("database is down");
        }
      },
    });
    const { organizationId } = await paidOrg(h, "fail");
    const event = stripeEvent(
      "customer.subscription.updated",
      stripeSubscription({
        id: "sub_fail",
        customer: "cus_fail",
        priceId: "price_team",
      }),
    );
    const payload = JSON.stringify(event);

    failNext = true;
    const first = await postWebhook(h.auth, event, payload);
    expect(first.status).toBe(400);
    expect(onEvent).not.toHaveBeenCalled();
    expect(await snapshotOf(h.auth, organizationId)).toBeNull();
    // the failure is logged once by entitlements (the Stripe plugin logs its own line)
    expect(ownLines(h.logs, "error")).toHaveLength(1);

    // Stripe redelivers the same event
    const second = await postWebhook(h.auth, event, payload);
    expect(second.status).toBe(200);
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect((await snapshotOf(h.auth, organizationId))?.planKey).toBe("team");
    expect(ownLines(h.logs, "error")).toHaveLength(1);
  });

  it("an event for a user's subscription answers 200 and writes no snapshot", async () => {
    const onEvent = vi.fn(async () => {});
    const h = harness({ onEvent });
    const { user } = await signUpUser(h.auth, "solo@acme.test");
    await seedSubscription(h.auth, {
      referenceId: user.id,
      plan: "pro",
      status: "active",
      stripeSubscriptionId: "sub_user",
      stripeCustomerId: "cus_user",
    });
    const response = await postWebhook(
      h.auth,
      stripeEvent(
        "customer.subscription.updated",
        stripeSubscription({
          id: "sub_user",
          customer: "cus_user",
          priceId: "price_team",
        }),
      ),
    );
    expect(response.status).toBe(200);
    expect(await snapshotOf(h.auth, user.id)).toBeNull();
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(
      ownLines(h.logs, "debug").some((l) => l.message.includes(user.id)),
    ).toBe(true);
  });

  it("an event for a deleted organization answers 200 and writes no snapshot", async () => {
    const h = harness();
    const { organizationId } = await paidOrg(h, "gone");
    const { adapter } = await getContext(h.auth);
    await adapter.delete({
      model: "organization",
      where: [{ field: "id", value: organizationId }],
    });
    const response = await postWebhook(
      h.auth,
      stripeEvent(
        "customer.subscription.deleted",
        stripeSubscription({
          id: "sub_gone",
          customer: "cus_gone",
          priceId: "price_pro",
        }),
      ),
    );
    expect(response.status).toBe(200);
    expect(await snapshotOf(h.auth, organizationId)).toBeNull();
    expect(ownLines(h.logs, "error")).toHaveLength(0);
  });

  it("checkout.session.completed finds the organization by client_reference_id", async () => {
    const h = harness();
    const { organizationId } = await seedOrg(h.auth);
    await setCustomer(h.auth, organizationId, "cus_co");
    // the row the plugin's upgrade endpoint creates before checkout
    const row = await seedSubscription(h.auth, {
      referenceId: organizationId,
      plan: "team",
      status: "incomplete",
      stripeCustomerId: "cus_co",
    });
    h.fake.subscriptions.set(
      "sub_co",
      stripeSubscription({
        id: "sub_co",
        customer: "cus_co",
        priceId: "price_team",
      }),
    );
    const response = await postWebhook(
      h.auth,
      stripeEvent("checkout.session.completed", {
        id: "cs_1",
        object: "checkout.session",
        mode: "subscription",
        client_reference_id: organizationId,
        customer: "cus_co",
        subscription: "sub_co",
        metadata: { subscriptionId: row.id },
      }),
    );
    expect(response.status).toBe(200);
    const snapshot = await snapshotOf(h.auth, organizationId);
    expect(snapshot).toMatchObject({ planKey: "team", status: "active" });
  });

  it("finds the organization in the documented order", async () => {
    const h = harness();
    await h.auth.$context;
    const onEvent = installedOnEvent(h.plugin) as (e: unknown) => Promise<void>;
    const org = async () => (await seedOrg(h.auth)).organizationId;
    const [rowOrg, metaOrg, customerOrg, refOrg, rowOrg2] = [
      await org(),
      await org(),
      await org(),
      await org(),
      await org(),
    ];
    await seedSubscription(h.auth, {
      referenceId: rowOrg as string,
      plan: "pro",
      status: "active",
      stripeSubscriptionId: "sub_row",
    });
    await seedSubscription(h.auth, {
      referenceId: metaOrg as string,
      plan: "pro",
      status: "active",
    });
    await seedSubscription(h.auth, {
      referenceId: customerOrg as string,
      plan: "pro",
      status: "active",
    });
    await seedSubscription(h.auth, {
      referenceId: refOrg as string,
      plan: "team",
      status: "active",
    });
    await seedSubscription(h.auth, {
      referenceId: rowOrg2 as string,
      plan: "team",
      status: "active",
      stripeSubscriptionId: "sub_row2",
    });
    await setCustomer(h.auth, customerOrg as string, "cus_only");
    const has = async (id: string) => (await snapshotOf(h.auth, id)) !== null;

    // subscription events: the row by stripeSubscriptionId beats metadata and customer
    await onEvent(
      stripeEvent("customer.subscription.updated", {
        id: "sub_row",
        customer: "cus_only",
        metadata: { referenceId: metaOrg },
      }),
    );
    expect([
      await has(rowOrg as string),
      await has(metaOrg as string),
      await has(customerOrg as string),
    ]).toEqual([true, false, false]);
    // no row: metadata.referenceId beats the customer
    await onEvent(
      stripeEvent("customer.subscription.created", {
        id: "sub_unknown",
        customer: "cus_only",
        metadata: { referenceId: metaOrg },
      }),
    );
    expect([
      await has(metaOrg as string),
      await has(customerOrg as string),
    ]).toEqual([true, false]);
    // neither: organization.stripeCustomerId
    await onEvent(
      stripeEvent("customer.subscription.deleted", {
        id: "sub_unknown",
        customer: { id: "cus_only" },
      }),
    );
    expect(await has(customerOrg as string)).toBe(true);

    // checkout: client_reference_id beats metadata, which beats the row
    await onEvent(
      stripeEvent("checkout.session.completed", {
        client_reference_id: refOrg,
        metadata: { referenceId: rowOrg2 },
        subscription: "sub_row2",
      }),
    );
    expect([await has(refOrg as string), await has(rowOrg2 as string)]).toEqual(
      [true, false],
    );
    await onEvent(
      stripeEvent("checkout.session.completed", { subscription: "sub_row2" }),
    );
    expect(await has(rowOrg2 as string)).toBe(true);
  });

  it("other events go straight to the app's handler, with no lookup", async () => {
    const calls: AdapterCall[] = [];
    const onEvent = vi.fn(async () => {});
    const h = harness({
      onEvent,
      before: (call) => {
        if (
          isEntitlementsQuery(call.args) ||
          call.model.startsWith("entitlement")
        )
          calls.push(call);
      },
    });
    await h.auth.$context;
    calls.length = 0;
    const response = await postWebhook(
      h.auth,
      stripeEvent("invoice.paid", { id: "in_1", customer: "cus_x" }),
    );
    expect(response.status).toBe(200);
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([]);
  });

  it("re-connecting from the same context rebinds silently: one wrapper, no warning", async () => {
    const onEvent = vi.fn(async () => {});
    const h = harness({ onEvent });
    const context = await getContext(h.auth);
    const wrapper = installedOnEvent(h.plugin);
    expect(wrapper).not.toBe(onEvent);
    const plugin = context.options.plugins?.find(
      (p) => p.id === "entitlements",
    );
    await plugin?.init?.(context);
    await h.source.connect?.(context, async (id) => {
      await syncOrganization(await getRuntime(h.auth), id);
    });
    expect(installedOnEvent(h.plugin)).toBe(wrapper);
    expect(sourceWarnings(h.logs)).toHaveLength(0);

    const { organizationId } = await paidOrg(h, "re");
    const response = await postWebhook(
      h.auth,
      stripeEvent(
        "customer.subscription.updated",
        stripeSubscription({
          id: "sub_re",
          customer: "cus_re",
          priceId: "price_team",
        }),
      ),
    );
    expect(response.status).toBe(200);
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect((await snapshotOf(h.auth, organizationId))?.planKey).toBe("team");
  });

  it("a second betterAuth() on the same Stripe plugin object wraps once, warns once, and resyncs the second instance", async () => {
    const onEvent = vi.fn(async () => {});
    const first = harness({ onEvent });
    await first.auth.$context;
    const wrapper = installedOnEvent(first.plugin);

    const second = harness({ plugin: first.plugin });
    await second.auth.$context;
    expect(installedOnEvent(first.plugin)).toBe(wrapper);
    expect(sourceWarnings(first.logs)).toHaveLength(0);
    const warnings = ownLines(second.logs, "warn").filter((l) =>
      l.message.includes("same Stripe plugin object"),
    );
    expect(warnings).toHaveLength(1);

    // the same org id story on both databases: only the second resyncs
    const a = await paidOrg(first, "two");
    const b = await paidOrg(second, "two");
    const response = await postWebhook(
      second.auth,
      stripeEvent(
        "customer.subscription.updated",
        stripeSubscription({
          id: "sub_two",
          customer: "cus_two",
          priceId: "price_team",
        }),
      ),
    );
    expect(response.status).toBe(200);
    expect((await snapshotOf(second.auth, b.organizationId))?.planKey).toBe(
      "team",
    );
    expect(await snapshotOf(first.auth, a.organizationId)).toBeNull();
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(sourceWarnings(second.logs)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// PRD #21 (J3)
// ---------------------------------------------------------------------------

describe("refresh after checkout (PRD #21, J3)", () => {
  it("with the webhook delayed, refreshEntitlements returns the new plan at once", async () => {
    const h = harness();
    const { organizationId, owner } = await seedOrg(h.auth);
    const api = createEntitlements(h.auth, testCatalog);
    expect((await api.get(organizationId)).plan.key).toBe("free");
    expect(
      (await snapshotOf(h.auth, organizationId))?.planKey ?? null,
    ).toBeNull();

    // checkout finished; the plugin's success redirect wrote the row, no webhook yet
    await seedSubscription(h.auth, {
      referenceId: organizationId,
      plan: "team",
      status: "active",
      stripeSubscriptionId: "sub_j3",
      periodStart: daysFromNow(0),
      periodEnd: daysFromNow(30),
    });
    // the cached read still says free
    expect((await api.get(organizationId)).plan.key).toBe("free");

    const fresh = await h.auth.api.refreshEntitlements({
      body: { organizationId },
      headers: owner.headers,
    });
    expect(fresh.plan).toMatchObject({ key: "team", source: "billing" });
    expect((await api.get(organizationId)).plan.key).toBe("team");
  });
});

// ---------------------------------------------------------------------------
// PRD #20: the contract suite
// ---------------------------------------------------------------------------

async function writeState(
  auth: AnyTestAuth,
  organizationId: string,
  state: BillingState | null,
) {
  const { adapter } = await getContext(auth);
  await adapter.deleteMany({
    model: "subscription",
    where: [{ field: "referenceId", value: organizationId }],
  });
  if (!state) return;
  await seedSubscription(auth, {
    referenceId: organizationId,
    // `plan` is required; an empty name is how a row says "no plan"
    plan: state.planKey ?? "",
    status: state.status ?? "incomplete",
    stripeSubscriptionId: state.sourceRef ?? `sub_${organizationId}`,
    periodStart: state.periodStart ? new Date(state.periodStart) : null,
    periodEnd: state.periodEnd ? new Date(state.periodEnd) : null,
    cancelAtPeriodEnd: state.cancelAtPeriodEnd ?? false,
    seats: state.seats ?? null,
  });
}

testBillingSource({
  name: "fromBetterAuthStripe() passes testBillingSource (PRD #20)",
  setup: async () => {
    const h = harness();
    const { organizationId } = await seedOrg(h.auth);
    return {
      source: h.source,
      auth: h.auth,
      organizationId,
      setState: (id, state) => writeState(h.auth, id, state),
    };
  },
  failing: async () => {
    const h = harness({
      before: (call) => {
        if (call.model === "subscription" && isEntitlementsQuery(call.args)) {
          throw new Error("subscription table unavailable");
        }
      },
    });
    const { organizationId } = await seedOrg(h.auth);
    return { source: h.source as BillingSource, auth: h.auth, organizationId };
  },
});

describe("the contract suite's setState (PRD #20)", () => {
  it('expresses { planKey: null, status: "canceled" } as a subscription row', async () => {
    const h = harness();
    const { organizationId } = await seedOrg(h.auth);
    await writeState(h.auth, organizationId, {
      planKey: "pro",
      status: "active",
    });
    await writeState(h.auth, organizationId, {
      planKey: null,
      status: "canceled",
    });
    const { adapter } = await getContext(h.auth);
    const rows = await adapter.findMany<{ plan: string; status: string }>({
      model: "subscription",
      where: [{ field: "referenceId", value: organizationId }],
      limit: 10,
    });
    expect(rows.map((r) => [r.plan, r.status])).toEqual([["", "canceled"]]);
    expect(
      await h.source.resolve(organizationId, {
        adapter: adapter as unknown as DBTransactionAdapter,
      }),
    ).toMatchObject({ planKey: null, status: "canceled", periodEnd: null });
  });
});

// ---------------------------------------------------------------------------
// PRD #15, the Stripe half on the memory lane
// ---------------------------------------------------------------------------

describe("inside a transaction with fromBetterAuthStripe (PRD #15, memory)", () => {
  async function setup() {
    const h = harness();
    const { organizationId, owner } = await paidOrg(h, "trx");
    const rt = await getRuntime(h.auth);
    const context = await getContext(h.auth);
    return {
      ...h,
      rt,
      context,
      organizationId,
      owner,
      api: createEntitlements(h.auth, testCatalog),
    };
  }

  it("detection reads true inside runWithTransaction, false outside and in a plain request", async () => {
    const t = await setup();
    expect(await inTransaction(t.rt)).toBe(false);
    expect(await expectNoOuterCalls(t.auth, () => inTransaction(t.rt))).toBe(
      true,
    );
    const response = await t.auth.handler(
      new Request(`http://localhost:3000/api/auth${IN_TRANSACTION_PROBE_PATH}`),
    );
    expect(await response.json()).toEqual({ inTransaction: false });
  });

  it("hasFeature, getLimit and checkCapacity read Stripe's rows through the transaction and persist nothing", async () => {
    const t = await setup();
    const results = await expectNoOuterCalls(t.auth, async () => [
      await t.api.hasFeature(t.organizationId, "exports"),
      await t.api.getLimit(t.organizationId, "apiCalls"),
      await t.api.checkCapacity(t.organizationId, "members", { count: 10 }),
    ]);
    expect(results[0]).toMatchObject({ allowed: true, plan: "pro" });
    expect(results[1]).toMatchObject({ limit: 50_000, used: 0 });
    expect(results[2]).toMatchObject({ allowed: true, limit: 50 });
    expect(await snapshotOf(t.auth, t.organizationId)).toBeNull();
    expect(t.rt.cache.get(t.organizationId)).toBeUndefined();
    const { adapter } = t.context;
    expect(
      await adapter.count({
        model: "entitlementUsage",
        where: [{ field: "organizationId", value: t.organizationId }],
      }),
    ).toBe(0);
  });

  it("a stale snapshot is served inside and schedules no refresh", async () => {
    const t = await setup();
    await setSnapshot(t.auth, t.organizationId, {
      planKey: "team",
      status: "active",
      syncedAt: new Date(Date.now() - t.rt.options.maxAge - 60_000),
    });
    const result = await expectNoOuterCalls(t.auth, () =>
      t.api.get(t.organizationId),
    );
    expect(result.plan.key).toBe("team");
    // nothing ran in the background: the row still says team, not pro
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await snapshotOf(t.auth, t.organizationId))?.planKey).toBe("team");
  });

  it("consumeUsage, sync and refreshEntitlements throw the documented error", async () => {
    const t = await setup();
    await expectNoOuterCalls(t.auth, async () => {
      await expect(
        t.api.consumeUsage(t.organizationId, "apiCalls"),
      ).rejects.toThrow(
        "[@byo-oss/entitlements] consumeUsage must run outside a transaction",
      );
      await expect(syncOrganization(t.rt, t.organizationId)).rejects.toThrow(
        "[@byo-oss/entitlements] sync must run outside a transaction",
      );
      await expect(
        t.auth.api.refreshEntitlements({
          body: { organizationId: t.organizationId },
          headers: t.owner.headers,
        }),
      ).rejects.toThrow(
        "[@byo-oss/entitlements] refreshEntitlements must run outside a transaction",
      );
    });
    expect(await snapshotOf(t.auth, t.organizationId)).toBeNull();
    // outside, the same calls work and read Stripe's row
    const fresh = await t.auth.api.refreshEntitlements({
      body: { organizationId: t.organizationId },
      headers: t.owner.headers,
    });
    expect(fresh.plan.key).toBe("pro");
    expect(
      (await t.api.consumeUsage(t.organizationId, "apiCalls")).allowed,
    ).toBe(true);
  });
});
