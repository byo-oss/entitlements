import { runWithTransaction } from "@better-auth/core/context";
import { stripe } from "@better-auth/stripe";
import { getCurrentAdapter } from "better-auth";
import Stripe from "stripe";
import { afterEach, describe, expect, it } from "vitest";
import { createEntitlements } from "./api";
import { syncOrganization } from "./resolve";
import { fromBetterAuthStripe, stripePlans } from "./stripe";
import { createSqlTestAuth } from "./test-sql";
import {
  expectNoOuterCalls,
  getContext,
  getRuntime,
  IN_TRANSACTION_PROBE_PATH,
  inTransactionProbe,
  seedOrg,
  testCatalog,
} from "./test-utils";
import { inTransaction } from "./txn";

// PRD #15, the Stripe half, on PGlite + Kysely: `fromBetterAuthStripe` is
// the source, so `resolve` reads `subscription` rows. With real
// transactions the G17 evidence is `expectNoOuterCalls`, which fails any
// outer-adapter call to `subscription` or `entitlement*` and any tagged
// query; without them, detection reads false and the calls work.

const SECRET = "test_secret";
const sdk = new Stripe(SECRET);
const DAY_MS = 86_400_000;

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

class Rollback extends Error {}

function stripePlugin() {
  const client = {
    webhooks: sdk.webhooks,
    subscriptions: {
      retrieve: async (id: string) => {
        throw new Error(`no such subscription: ${id}`);
      },
    },
  } as unknown as Stripe;
  return stripe({
    stripeClient: client,
    stripeWebhookSecret: SECRET,
    subscription: {
      enabled: true,
      plans: stripePlans(testCatalog, {
        pro: { priceId: "price_pro" },
        team: { priceId: "price_team" },
      }),
    },
    organization: { enabled: true },
  });
}

async function setup(transaction = true) {
  const sql = await createSqlTestAuth({
    transaction,
    options: { source: fromBetterAuthStripe() },
    plugins: [stripePlugin(), inTransactionProbe()],
    authOptions: { logger: { disabled: true } },
  });
  closers.push(sql.close);
  const rt = await getRuntime(sql.auth);
  const context = await getContext(sql.auth);
  const { organizationId, owner } = await seedOrg(sql.auth);
  const count = async (table: string) =>
    (
      await sql.db
        .selectFrom(table)
        .selectAll()
        .where("organizationId", "=", organizationId)
        .execute()
    ).length;
  const subscription = (plan: string, extra: Record<string, unknown> = {}) => ({
    model: "subscription",
    data: {
      referenceId: organizationId,
      plan,
      status: "active",
      stripeSubscriptionId: `sub_${plan}_${organizationId}`,
      stripeCustomerId: `cus_${organizationId}`,
      periodStart: new Date(Date.now() - DAY_MS),
      periodEnd: new Date(Date.now() + 29 * DAY_MS),
      cancelAtPeriodEnd: false,
      ...extra,
    },
  });
  return {
    ...sql,
    rt,
    context,
    owner,
    organizationId,
    api: createEntitlements(sql.auth, testCatalog),
    snapshots: () => count("entitlementSnapshot"),
    usage: () => count("entitlementUsage"),
    /** Writes a Stripe `subscription` row for the org through the base adapter. */
    seedSubscription: (plan: string, extra?: Record<string, unknown>) =>
      context.adapter.create(subscription(plan, extra)),
    subscription,
  };
}

describe("inside a transaction with fromBetterAuthStripe (PRD #15, PGlite)", () => {
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

  it("hasFeature, getLimit and checkCapacity with a missing snapshot read Stripe's rows through the transaction and persist nothing", async () => {
    const t = await setup();
    await t.seedSubscription("pro");
    const [feature, limit, capacity] = await expectNoOuterCalls(
      t.auth,
      async () => [
        await t.api.hasFeature(t.organizationId, "exports"),
        await t.api.getLimit(t.organizationId, "apiCalls"),
        await t.api.checkCapacity(t.organizationId, "members", { count: 10 }),
      ],
    );
    expect(feature).toMatchObject({ allowed: true, plan: "pro" });
    expect(limit).toMatchObject({ limit: 50_000, used: 0 });
    expect(capacity).toMatchObject({ allowed: true, limit: 50 });
    expect(await t.snapshots()).toBe(0);
    expect(await t.usage()).toBe(0);
    expect(t.rt.cache.get(t.organizationId)).toBeUndefined();
  });

  it("sees a subscription row the caller wrote in its own transaction, and nothing of it after a rollback", async () => {
    const t = await setup();
    await expect(
      expectNoOuterCalls(t.auth, async () => {
        const trx = await getCurrentAdapter(t.context.adapter);
        await trx.create(t.subscription("team"));
        expect((await t.api.hasFeature(t.organizationId, "sso")).allowed).toBe(
          true,
        );
        throw new Rollback();
      }),
    ).rejects.toBeInstanceOf(Rollback);
    expect(await t.snapshots()).toBe(0);
    expect(t.rt.cache.get(t.organizationId)).toBeUndefined();
    // outside: the row was rolled back, so the org is on the default plan
    expect((await t.api.hasFeature(t.organizationId, "sso")).allowed).toBe(
      false,
    );
    expect((await t.api.get(t.organizationId)).plan.key).toBe("free");
  });

  it("consumeUsage, sync and refreshEntitlements throw the documented error and write nothing", async () => {
    const t = await setup();
    await t.seedSubscription("pro");
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
    expect(await t.snapshots()).toBe(0);
    expect(await t.usage()).toBe(0);
    const fresh = await t.auth.api.refreshEntitlements({
      body: { organizationId: t.organizationId },
      headers: t.owner.headers,
    });
    expect(fresh.plan).toMatchObject({ key: "pro", source: "billing" });
    expect(await t.snapshots()).toBe(1);
  });

  it("a signed webhook resyncs outside any transaction and updates the snapshot", async () => {
    const t = await setup();
    await t.context.adapter.update({
      model: "organization",
      where: [{ field: "id", value: t.organizationId }],
      update: { stripeCustomerId: `cus_${t.organizationId}` },
    });
    await t.seedSubscription("pro");
    expect((await t.api.get(t.organizationId)).plan.key).toBe("pro");
    const end = Math.floor((Date.now() + 30 * DAY_MS) / 1000);
    const payload = JSON.stringify({
      id: "evt_sql",
      object: "event",
      type: "customer.subscription.updated",
      data: {
        object: {
          id: `sub_pro_${t.organizationId}`,
          object: "subscription",
          customer: `cus_${t.organizationId}`,
          status: "active",
          metadata: {},
          cancel_at_period_end: false,
          items: {
            data: [
              {
                id: "si_sql",
                quantity: 1,
                price: { id: "price_team", recurring: { interval: "month" } },
                current_period_start: end - 30 * 86_400,
                current_period_end: end,
              },
            ],
          },
        },
      },
    });
    const response = await t.auth.handler(
      new Request("http://localhost:3000/api/auth/stripe/webhook", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "stripe-signature": sdk.webhooks.generateTestHeaderString({
            payload,
            secret: SECRET,
          }),
        },
        body: payload,
      }),
    );
    expect(response.status).toBe(200);
    const rows = await t.db
      .selectFrom("entitlementSnapshot")
      .selectAll()
      .where("organizationId", "=", t.organizationId)
      .execute();
    expect(rows.map((r) => [r.planKey, r.source])).toEqual([
      ["team", "stripe"],
    ]);
    expect((await t.api.get(t.organizationId)).plan.key).toBe("team");
  });
});

describe("fromBetterAuthStripe on Kysely without real transactions (transaction: false)", () => {
  it("detection reads false inside runWithTransaction, and consumeUsage and refreshEntitlements work", async () => {
    const t = await setup(false);
    await t.seedSubscription("pro");
    const result = await runWithTransaction(t.context.adapter, async () => {
      expect(await inTransaction(t.rt)).toBe(false);
      const consumed = await t.api.consumeUsage(t.organizationId, "apiCalls", {
        amount: 3,
      });
      const fresh = await t.auth.api.refreshEntitlements({
        body: { organizationId: t.organizationId },
        headers: t.owner.headers,
      });
      return { consumed, fresh };
    });
    expect(result.consumed).toMatchObject({ allowed: true, used: 3 });
    expect(result.fresh.plan.key).toBe("pro");
    expect(await t.snapshots()).toBe(1);
    expect(await t.usage()).toBe(1);
  });
});
