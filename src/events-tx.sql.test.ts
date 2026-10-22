import { runWithTransaction } from "@better-auth/core/context";
import type { ByoEvent } from "@byo-oss/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSqlTestAuth } from "./test-sql";
import {
  expectNoOuterCalls,
  fakeSource,
  getContext,
  getRuntime,
  STAFF_ORG_ID,
  seedOrg,
  seedStaff,
  setSnapshot,
} from "./test-utils";

// PRD A8 on PGlite + Kysely: an event from a write that joined the caller's
// transaction fires after the commit, never on a rollback; a write on the
// base adapter (or on an adapter without real transactions) emits at once.

const NOW = new Date("2026-03-10T12:00:00.000Z");
const MINUTE = 60_000;

class Rollback extends Error {}

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

async function setup(transaction = true) {
  const events: ByoEvent[] = [];
  const state = { fail: false };
  const onEvent = vi.fn(async (event: ByoEvent) => {
    if (state.fail) throw new Error("consumer down");
    events.push(event);
  });
  const source = fakeSource();
  const sql = await createSqlTestAuth({
    transaction,
    options: {
      source,
      cacheTtlMs: 0,
      onEvent,
      staffOrganizationId: STAFF_ORG_ID,
    },
  });
  closers.push(sql.close);
  const rt = await getRuntime(sql.auth);
  const context = await getContext(sql.auth);
  const error = vi.fn();
  rt.logger = { ...rt.logger, error };
  const { staff } = await seedStaff(sql.auth, STAFF_ORG_ID);
  const { organizationId } = await seedOrg(sql.auth);
  onEvent.mockClear();
  const setSso = () =>
    sql.auth.api.setEntitlementOverride({
      body: {
        organizationId,
        kind: "feature",
        key: "sso",
        value: true,
        reason: "pilot",
      },
      headers: staff.admin.headers,
    });
  const overrides = async () =>
    sql.db
      .selectFrom("entitlementOverride")
      .selectAll()
      .where("organizationId", "=", organizationId)
      .execute();
  return {
    ...sql,
    rt,
    context,
    source,
    staff,
    organizationId,
    events,
    state,
    onEvent,
    error,
    setSso,
    overrides,
  };
}

describe("events after commit (SQL, real transactions)", () => {
  it("an override set inside a transaction emits nothing until the commit, then exactly once", async () => {
    const t = await setup();
    const id = await expectNoOuterCalls(t.auth, async () => {
      const { override } = await t.setSso();
      expect(t.onEvent).not.toHaveBeenCalled();
      return override.id;
    });
    expect(t.onEvent).toHaveBeenCalledTimes(1);
    expect(t.events).toEqual([
      expect.objectContaining({
        type: "entitlements.override.set",
        organizationId: t.organizationId,
        actorId: t.staff.admin.user.id,
        subject: { type: "entitlementOverride", id },
        data: { kind: "feature", key: "sso", value: true, expiresAt: null },
      }),
    ]);
  });

  it("an override set and removed inside a rolled-back transaction never emits", async () => {
    const t = await setup();
    await expect(
      expectNoOuterCalls(t.auth, async () => {
        const { override } = await t.setSso();
        await t.auth.api.removeEntitlementOverride({
          body: { id: override.id },
          headers: t.staff.admin.headers,
        });
        throw new Rollback("roll back");
      }),
    ).rejects.toBeInstanceOf(Rollback);
    expect(t.onEvent).not.toHaveBeenCalled();
    expect(await t.overrides()).toHaveLength(0);
  });

  it("a sweep inside a committed transaction emits plan.changed after the commit", async () => {
    const t = await setup();
    t.rt.now = () => new Date(NOW.getTime());
    await setSnapshot(t.auth, t.organizationId, {
      syncedAt: new Date(NOW.getTime() - 10 * MINUTE),
      nextSyncAt: new Date(NOW.getTime() - MINUTE),
    });
    t.source.states.set(t.organizationId, { planKey: "pro", status: "active" });
    await expectNoOuterCalls(t.auth, async () => {
      expect(await t.auth.api.processEntitlementsSync()).toMatchObject({
        synced: 1,
      });
      expect(t.onEvent).not.toHaveBeenCalled();
    });
    expect(t.events).toEqual([
      expect.objectContaining({
        type: "entitlements.plan.changed",
        organizationId: t.organizationId,
        occurredAt: NOW,
        data: { from: "free", to: "pro", status: "active" },
      }),
    ]);
  });

  it("a sweep inside a rolled-back transaction never emits", async () => {
    const t = await setup();
    t.rt.now = () => new Date(NOW.getTime());
    await setSnapshot(t.auth, t.organizationId, {
      nextSyncAt: new Date(NOW.getTime() - MINUTE),
    });
    t.source.states.set(t.organizationId, { planKey: "pro", status: "active" });
    await expect(
      expectNoOuterCalls(t.auth, async () => {
        expect(await t.auth.api.processEntitlementsSync()).toMatchObject({
          synced: 1,
        });
        throw new Rollback("roll back");
      }),
    ).rejects.toBeInstanceOf(Rollback);
    expect(t.onEvent).not.toHaveBeenCalled();
  });

  it("a write on the base adapter emits before the call returns", async () => {
    const t = await setup();
    const { override } = await t.setSso();
    expect(t.onEvent).toHaveBeenCalledTimes(1);
    expect(t.events[0]).toMatchObject({
      type: "entitlements.override.set",
      subject: { id: override.id },
    });
  });

  it("a throwing onEvent after the commit is logged and fails nothing", async () => {
    const t = await setup();
    t.state.fail = true;
    const id = await expectNoOuterCalls(t.auth, async () => {
      const { override } = await t.setSso();
      return override.id;
    });
    expect(t.onEvent).toHaveBeenCalledTimes(1);
    expect(t.error).toHaveBeenCalledWith(
      "[@byo-oss/entitlements] onEvent failed for entitlements.override.set",
      expect.any(Error),
    );
    // the commit stands
    expect(await t.overrides()).toMatchObject([
      { id, key: "sso", status: "active" },
    ]);
  });
});

describe("events on Kysely without real transactions (transaction: false)", () => {
  it("an override write inside runWithTransaction emits at once", async () => {
    const t = await setup(false);
    await runWithTransaction(t.context.adapter, async () => {
      await t.setSso();
      // nothing to wait on: the write is already durable
      expect(t.onEvent).toHaveBeenCalledTimes(1);
    });
    expect(t.onEvent).toHaveBeenCalledTimes(1);
  });
});
