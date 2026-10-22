// lane: latest-only
import { type ByoEvent, createEventBus } from "@byo-oss/core";
import { inbox } from "@byo-oss/notifications";
import { describe, expect, it, vi } from "vitest";
import { createEntitlements } from "./api";
import { ENTITLEMENTS_EVENT_TYPES, type EntitlementsEvent } from "./events";
import {
  type AnyTestAuth,
  fakeSource,
  getRuntime,
  makeAuth,
  seedOrg,
  seedStaff,
  setSnapshot,
  testCatalog,
} from "./test-utils";

// PRD #25 (events: shapes, a throwing onEvent, once per period) and J10
// (limit_reached through a real @byo-oss/notifications auth.api.notify)

const NOW = new Date("2026-03-10T12:00:00.000Z");
const DAY_END = new Date("2026-03-11T00:00:00.000Z");
const NEXT_DAY = new Date("2026-03-11T09:00:00.000Z");

const EVENT_TYPE = /^[^.]+\.[^.]+\.[^.]+$/;

/** The `ByoEvent` contract, checked at runtime on every event. */
function expectByoEvent(event: ByoEvent) {
  expect(event.type).toMatch(EVENT_TYPE);
  expect(event.occurredAt).toBeInstanceOf(Date);
  expect(event.subject).toEqual({
    type: expect.any(String),
    id: expect.any(String),
  });
  expect(typeof event.organizationId).toBe("string");
  expect(event.actorId === null || typeof event.actorId === "string").toBe(
    true,
  );
  expect(event).not.toHaveProperty("userId");
  expect(Object.getPrototypeOf(event.data)).toBe(Object.prototype);
}

async function setup(
  config: {
    onEvent?: (event: ByoEvent) => void | Promise<void>;
    staff?: boolean;
  } = {},
) {
  const events: ByoEvent[] = [];
  const onEvent = vi.fn(async (event: ByoEvent) => {
    events.push(event);
    await config.onEvent?.(event);
  });
  const source = fakeSource();
  const limits: Record<string, number> = { apiCalls: 1 };
  const auth = makeAuth({
    options: {
      source,
      cacheTtlMs: 0,
      onEvent,
      resolveEntitlements: () => ({ limits: { ...limits } }),
      ...(config.staff === false ? {} : { staffOrganizationId: "org_staff" }),
    },
  });
  const rt = await getRuntime(auth);
  let now = NOW;
  rt.now = () => new Date(now.getTime());
  const error = vi.fn();
  rt.logger = { ...rt.logger, error };
  const api = createEntitlements(auth, testCatalog);
  return {
    auth,
    rt,
    api,
    source,
    events,
    limits,
    onEvent,
    error,
    setNow: (date: Date) => {
      now = date;
    },
    ofType: (type: string) => events.filter((event) => event.type === type),
    /** The one event of this type, failing when there are none or several. */
    one: (type: string) => {
      const found = events.filter((event) => event.type === type);
      expect(found).toHaveLength(1);
      return found[0] as ByoEvent;
    },
  };
}

type Setup = Awaited<ReturnType<typeof setup>>;

/** Makes the free plan's `apiCalls` limit tiny, so a refusal is one call away. */
async function refusalOrg(t: Setup, limit = 1) {
  const { organizationId, owner } = await seedOrg(t.auth);
  t.limits.apiCalls = limit;
  return { organizationId, owner };
}

describe("events: shapes (PRD #25)", () => {
  it("ENTITLEMENTS_EVENT_TYPES lists the four event types", () => {
    expect([...ENTITLEMENTS_EVENT_TYPES].sort()).toEqual([
      "entitlements.override.removed",
      "entitlements.override.set",
      "entitlements.plan.changed",
      "entitlements.usage.limit_reached",
    ]);
  });

  it("plan.changed: from, to and status; subject the organization; actorId null", async () => {
    const t = await setup();
    const { organizationId } = await seedOrg(t.auth);
    await setSnapshot(t.auth, organizationId, {
      planKey: "free",
      status: "active",
    });
    t.source.states.set(organizationId, { planKey: "pro", status: "active" });
    await t.api.sync(organizationId);
    const event = t.one("entitlements.plan.changed");
    expect(t.events).toHaveLength(1);
    expectByoEvent(event);
    expect(event).toEqual({
      type: "entitlements.plan.changed",
      occurredAt: NOW,
      actorId: null,
      organizationId,
      subject: { type: "organization", id: organizationId },
      data: { from: "free", to: "pro", status: "active" },
    });
    // an unchanged resync emits nothing
    await t.api.sync(organizationId);
    expect(t.ofType("entitlements.plan.changed")).toHaveLength(1);
  });

  it("override.set and override.removed: subject the override, actorId the staff user, no reason", async () => {
    const t = await setup();
    const { staff } = await seedStaff(t.auth, "org_staff");
    const { organizationId } = await seedOrg(t.auth);
    const reason = "customer asked for a trial";
    const set = await t.auth.api.setEntitlementOverride({
      headers: staff.admin.headers,
      body: {
        organizationId,
        kind: "feature",
        key: "exports",
        value: true,
        reason,
      },
    });
    const setEvent = t.one("entitlements.override.set");
    expectByoEvent(setEvent);
    expect(setEvent).toMatchObject({
      type: "entitlements.override.set",
      organizationId,
      actorId: staff.admin.user.id,
      subject: { type: "entitlementOverride", id: set.override.id },
      data: { kind: "feature", key: "exports", value: true, expiresAt: null },
    });
    expect(setEvent.occurredAt).toBeInstanceOf(Date);

    await t.auth.api.removeEntitlementOverride({
      headers: staff.owner.headers,
      body: { id: set.override.id },
    });
    const removedEvent = t.one("entitlements.override.removed");
    expectByoEvent(removedEvent);
    expect(removedEvent).toMatchObject({
      type: "entitlements.override.removed",
      organizationId,
      actorId: staff.owner.user.id,
      subject: { type: "entitlementOverride", id: set.override.id },
      data: { kind: "feature", key: "exports" },
    });
    // free text stays out of events
    expect(JSON.stringify(t.events)).not.toContain(reason);
    expect(setEvent.data).not.toHaveProperty("reason");
    expect(removedEvent.data).not.toHaveProperty("reason");
  });

  it("limit_reached: key, limit and periodEnd; subject the organization; actorId null", async () => {
    const t = await setup();
    const { organizationId } = await refusalOrg(t, 2);
    await t.api.consumeUsage(organizationId, "apiCalls", { amount: 2 });
    expect(t.events).toHaveLength(0);
    const refused = await t.api.consumeUsage(organizationId, "apiCalls");
    expect(refused).toMatchObject({ allowed: false, firstRefusal: true });
    const event = t.one("entitlements.usage.limit_reached");
    expect(t.events).toHaveLength(1);
    expectByoEvent(event);
    expect(event).toEqual({
      type: "entitlements.usage.limit_reached",
      occurredAt: NOW,
      actorId: null,
      organizationId,
      subject: { type: "organization", id: organizationId },
      data: { key: "apiCalls", limit: 2, periodEnd: DAY_END },
    });
  });

  it("every emitted type is one of the four, and each event assigns to EntitlementsEvent", async () => {
    const t = await setup();
    const { staff } = await seedStaff(t.auth, "org_staff");
    const { organizationId } = await refusalOrg(t);
    await t.api.consumeUsage(organizationId, "apiCalls");
    await t.api.consumeUsage(organizationId, "apiCalls");
    await t.auth.api.setEntitlementOverride({
      headers: staff.admin.headers,
      body: {
        organizationId,
        kind: "feature",
        key: "sso",
        value: true,
        reason: "demo",
      },
    });
    t.source.states.set(organizationId, { planKey: "team", status: "active" });
    await t.api.sync(organizationId);
    const types = new Set<string>(ENTITLEMENTS_EVENT_TYPES);
    expect(t.events.length).toBeGreaterThanOrEqual(3);
    for (const event of t.events) {
      expect(types.has(event.type)).toBe(true);
      const typed = event as EntitlementsEvent;
      expect(typed.organizationId).toBe(organizationId);
    }
  });
});

describe("events: a throwing onEvent never fails the call (PRD #25)", () => {
  it("a throwing handler: consumeUsage, sync and the override endpoints still succeed and the error is logged", async () => {
    const t = await setup({
      onEvent: () => {
        throw new Error("consumer broke");
      },
    });
    const { staff } = await seedStaff(t.auth, "org_staff");
    const { organizationId } = await refusalOrg(t);

    await t.api.consumeUsage(organizationId, "apiCalls");
    await expect(
      t.api.consumeUsage(organizationId, "apiCalls"),
    ).resolves.toMatchObject({ allowed: false, firstRefusal: true });

    t.source.states.set(organizationId, { planKey: "pro", status: "active" });
    await expect(t.api.sync(organizationId)).resolves.toBeDefined();

    const set = await t.auth.api.setEntitlementOverride({
      headers: staff.admin.headers,
      body: {
        organizationId,
        kind: "feature",
        key: "sso",
        value: true,
        reason: "demo",
      },
    });
    await expect(
      t.auth.api.removeEntitlementOverride({
        headers: staff.admin.headers,
        body: { id: set.override.id },
      }),
    ).resolves.toEqual({ ok: true });

    // every event reached the handler, and each failure was logged
    expect(t.onEvent).toHaveBeenCalledTimes(4);
    expect(t.error).toHaveBeenCalledTimes(4);
    expect(String(t.error.mock.calls[0]?.[0])).toContain(
      "onEvent failed for entitlements.usage.limit_reached",
    );
  });

  it("a rejecting async handler is caught the same way", async () => {
    const t = await setup({
      onEvent: async () => {
        throw new Error("consumer rejected");
      },
    });
    const { organizationId } = await refusalOrg(t);
    await t.api.consumeUsage(organizationId, "apiCalls");
    await expect(
      t.api.consumeUsage(organizationId, "apiCalls"),
    ).resolves.toMatchObject({ allowed: false });
    expect(t.onEvent).toHaveBeenCalledTimes(1);
    expect(t.error).toHaveBeenCalledTimes(1);
  });

  it("a throwing handler behind createEventBus is reported by the bus and the call still succeeds", async () => {
    const seen: ByoEvent[] = [];
    const busErrors = vi.fn();
    const onEvent = createEventBus(
      [
        () => {
          throw new Error("first consumer broke");
        },
        (event) => {
          seen.push(event);
        },
      ],
      { onError: busErrors },
    );
    const t = await setup({ onEvent });
    const { organizationId } = await refusalOrg(t);
    await t.api.consumeUsage(organizationId, "apiCalls");
    await expect(
      t.api.consumeUsage(organizationId, "apiCalls"),
    ).resolves.toMatchObject({ allowed: false });
    // the bus caught it: entitlements' own handler never saw a throw
    expect(busErrors).toHaveBeenCalledTimes(1);
    expect(seen).toHaveLength(1);
    expect(t.error).not.toHaveBeenCalled();
  });
});

describe("events: limit_reached once per period (PRD #25)", () => {
  it("many refusals in one period emit once; the next period's first refusal emits again", async () => {
    const t = await setup();
    const { organizationId } = await refusalOrg(t);
    await t.api.consumeUsage(organizationId, "apiCalls");
    const refusals = await Promise.all(
      Array.from({ length: 10 }, () =>
        t.api.consumeUsage(organizationId, "apiCalls"),
      ),
    );
    expect(refusals.every((r) => !r.allowed)).toBe(true);
    expect(refusals.filter((r) => r.firstRefusal)).toHaveLength(1);
    expect(t.ofType("entitlements.usage.limit_reached")).toHaveLength(1);

    // another key in the same period is its own bucket
    await t.api.consumeUsage(organizationId, "uploads", { amount: 1 });
    expect(t.ofType("entitlements.usage.limit_reached")).toHaveLength(1);

    t.setNow(NEXT_DAY);
    await t.api.consumeUsage(organizationId, "apiCalls");
    await t.api.consumeUsage(organizationId, "apiCalls");
    await t.api.consumeUsage(organizationId, "apiCalls");
    const reached = t.ofType("entitlements.usage.limit_reached");
    expect(reached).toHaveLength(2);
    expect(reached[0]?.data).toMatchObject({ periodEnd: DAY_END });
    expect(reached[1]?.data).toMatchObject({
      periodEnd: new Date("2026-03-12T00:00:00.000Z"),
    });
  });
});

describe("events: J10, limit_reached through @byo-oss/notifications (PRD #25)", () => {
  it("an event-bus consumer that calls auth.api.notify creates the notification", async () => {
    const busErrors = vi.fn();
    // `auth` is read inside the consumer, after both exist
    let authRef: AnyTestAuth | null = null;
    const onEvent = createEventBus(
      [
        async (event) => {
          if (event.type !== "entitlements.usage.limit_reached") return;
          if (!event.organizationId) return;
          const data = event.data as { key: string; limit: number };
          await authRef?.api.notify({
            body: {
              organizationId: event.organizationId,
              roles: ["owner"],
              type: event.type,
              title: `You reached your ${data.key} limit`,
              href: "/settings/billing",
              data: { key: data.key, limit: data.limit },
            },
          });
        },
      ],
      { onError: busErrors },
    );
    const source = fakeSource();
    const auth = makeAuth({
      options: {
        source,
        cacheTtlMs: 0,
        onEvent,
        resolveEntitlements: () => ({ limits: { apiCalls: 1 } }),
      },
      plugins: [inbox()],
    });
    const rt = await getRuntime(auth);
    rt.now = () => NOW;
    authRef = auth;
    const { organizationId, owner } = await seedOrg(auth);
    const member = await seedOrg(auth);
    const api = createEntitlements(auth, testCatalog);

    const listFor = (headers: Headers) =>
      auth.api.listNotifications({ headers, query: { filter: "all" } });
    expect((await listFor(owner.headers)).notifications).toHaveLength(0);

    await api.consumeUsage(organizationId, "apiCalls");
    expect((await listFor(owner.headers)).notifications).toHaveLength(0);

    const refused = await api.consumeUsage(organizationId, "apiCalls");
    expect(refused).toMatchObject({ allowed: false, firstRefusal: true });
    // more refusals in the period notify nobody again
    await api.consumeUsage(organizationId, "apiCalls");

    expect(busErrors).not.toHaveBeenCalled();
    const { notifications } = await listFor(owner.headers);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      type: "entitlements.usage.limit_reached",
      title: "You reached your apiCalls limit",
      href: "/settings/billing",
      organizationId,
      userId: owner.user.id,
    });
    // another organization's owner sees nothing
    expect((await listFor(member.owner.headers)).notifications).toHaveLength(0);
  });
});
