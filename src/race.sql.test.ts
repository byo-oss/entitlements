import { afterEach, describe, expect, it, vi } from "vitest";
import { createEntitlements } from "./api";
import type { EntitlementSnapshotRow } from "./schema";
import { readSnapshot, writeSnapshot } from "./snapshot";
import { runSync } from "./sync";
import { createSqlTestAuth, type SqlTestAuthConfig } from "./test-sql";
import {
  type AdapterCall,
  type FakeSource,
  fakeSource,
  getContext,
  getRuntime,
  seedOrg,
  setSnapshot,
  testCatalog,
} from "./test-utils";
import type { BillingState, EntitlementsSweepResult } from "./types";

// RC review 1 #1 on PGlite + Kysely: concurrent snapshot writers (sweep, push,
// refresh, a second process) with deterministic barriers. Every barrier
// sits in `source.resolve` after it computed its state (no query is open
// there, so PGlite's single connection never blocks) or in an adapter
// `before` hook ahead of the call.

const MINUTE = 60_000;

const active = (planKey: string): BillingState => ({
  planKey,
  status: "active",
});

/** A promise with its resolver, and a promise that settles when it is reached. */
function barrier() {
  let release: () => void = () => {};
  let reach: () => void = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reached = new Promise<void>((resolve) => {
    reach = resolve;
  });
  return { release, reach, released, reached };
}
type Barrier = ReturnType<typeof barrier>;

/**
 * Makes `source.resolve` read the provider's state when called, then wait
 * at the barrier set for that call number (1-based), if any.
 */
function holdResolves(source: FakeSource) {
  const holds = new Map<number, Barrier>();
  const resolve = source.resolve;
  let calls = 0;
  source.resolve = async (id, ctx) => {
    calls += 1;
    const state = await resolve(id, ctx);
    const hold = holds.get(calls);
    if (hold) {
      hold.reach();
      await hold.released;
    }
    return state;
  };
  return {
    /** A barrier for resolve call number `n`. */
    at(n: number) {
      const hold = barrier();
      holds.set(n, hold);
      return hold;
    },
    calls: () => calls,
  };
}

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});

type Hook = (call: AdapterCall) => void | Promise<void>;

async function setup(config: SqlTestAuthConfig = {}) {
  const source = fakeSource();
  const onEvent = vi.fn();
  const hooks: { before: Hook | null } = { before: null };
  const sql = await createSqlTestAuth({
    ...config,
    options: { source, cacheTtlMs: 30_000, onEvent, ...config.options },
    adapter: { before: (call) => hooks.before?.(call) },
  });
  closers.push(sql.close);
  const rt = await getRuntime(sql.auth);
  const error = vi.fn();
  rt.logger = { ...rt.logger, error };
  return {
    ...sql,
    rt,
    source,
    onEvent,
    error,
    hooks,
    holds: holdResolves(source),
    api: createEntitlements(sql.auth, testCatalog),
  };
}
type Setup = Awaited<ReturnType<typeof setup>>;

/** A second "process": its own runtime, cache and flights, on the same database. */
async function secondProcess(first: Setup) {
  return setup({ shareWith: { db: first.db, pglite: first.pglite } });
}

/** An organization with a due snapshot on `planKey`, and the provider on `planKey`. */
async function dueOrg(t: Setup, planKey: string) {
  const { organizationId, owner } = await seedOrg(t.auth);
  await setSnapshot(t.auth, organizationId, {
    ...active(planKey),
    syncedAt: new Date(Date.now() - 10 * MINUTE),
    nextSyncAt: new Date(Date.now() - MINUTE),
  });
  t.source.states.set(organizationId, active(planKey));
  return { organizationId, owner };
}

async function snapshotOf(t: Setup, organizationId: string) {
  const { adapter } = await getContext(t.auth);
  return readSnapshot(t.rt, adapter, organizationId);
}

const planChanges = (onEvent: ReturnType<typeof vi.fn>) =>
  onEvent.mock.calls
    .map((call) => call[0])
    .filter((event) => event.type === "entitlements.plan.changed")
    .map((event) => event.data);

describe("sweep vs push (RC review 1 #1)", () => {
  it("the sweep claims, a push writes, then the sweep writes: the push's newer state stays and refreshEntitlements returns it", async () => {
    const t = await setup();
    const { organizationId, owner } = await dueOrg(t, "pro");
    // the sweep resolves "pro" and is held before its write
    const sweepHold = t.holds.at(1);
    const sweep = runSync(t.rt);
    await sweepHold.reached;
    expect((await snapshotOf(t, organizationId))?.syncState).toBe("syncing");

    // the provider moves to team and pushes; the push resolves after the claim
    t.source.states.set(organizationId, active("team"));
    await t.source.changed?.(organizationId);
    expect(await snapshotOf(t, organizationId)).toMatchObject({
      planKey: "team",
      syncState: "idle",
    });

    sweepHold.release();
    expect(await sweep).toMatchObject({ synced: 1, retrying: 0, failed: 0 });
    expect(await snapshotOf(t, organizationId)).toMatchObject({
      planKey: "team",
      syncState: "idle",
      syncClaimedAt: null,
      version: 2, // the claim, then the push
    });
    expect((await t.api.get(organizationId)).plan.key).toBe("team");
    const refreshed = await t.auth.api.refreshEntitlements({
      body: { organizationId },
      headers: owner.headers,
    });
    expect(refreshed.plan.key).toBe("team");
    expect(planChanges(t.onEvent)).toEqual([
      { from: "pro", to: "team", status: "active" },
    ]);
    expect(t.error).not.toHaveBeenCalled();
  });

  it("the review's case: the push resolves the new state, the sweep writes its older one first, then the push's write loses and its retry wins", async () => {
    const t = await setup();
    const { organizationId } = await dueOrg(t, "pro");
    // call 1: the sweep resolves "pro", held
    const sweepHold = t.holds.at(1);
    const sweep = runSync(t.rt);
    await sweepHold.reached;
    // call 2: the push resolves "team" (it read the claimed row), held
    t.source.states.set(organizationId, active("team"));
    const pushHold = t.holds.at(2);
    const push = t.source.changed?.(organizationId);
    await pushHold.reached;

    // the sweep writes its older state first
    sweepHold.release();
    expect(await sweep).toMatchObject({ synced: 1 });
    expect((await snapshotOf(t, organizationId))?.planKey).toBe("pro");

    // the push's write loses the version guard; it reads, resolves and
    // writes again instead of reporting success with the sweep's state
    pushHold.release();
    await push;
    expect(t.holds.calls()).toBe(3);
    expect(await snapshotOf(t, organizationId)).toMatchObject({
      planKey: "team",
      syncState: "idle",
      version: 3, // claim, sweep write, push retry
    });
    expect((await t.api.get(organizationId)).plan.key).toBe("team");
    expect(t.error).not.toHaveBeenCalled();
  });

  it("a push that read the row before the sweep's claim loses its write and resolves again after it", async () => {
    const t = await setup();
    const { organizationId } = await dueOrg(t, "pro");
    // call 1: the push reads the idle row, resolves "pro" (the provider
    // hasn't moved yet), and is held
    const pushHold = t.holds.at(1);
    const push = t.source.changed?.(organizationId);
    await pushHold.reached;
    // the provider moves; the sweep claims (version moves) and resolves "team"
    t.source.states.set(organizationId, active("team"));
    const sweepHold = t.holds.at(2);
    const sweep = runSync(t.rt);
    await sweepHold.reached;

    // the push writes first, but its version is from before the claim
    pushHold.release();
    await push;
    expect(t.holds.calls()).toBe(3);
    expect((await snapshotOf(t, organizationId))?.planKey).toBe("team");
    sweepHold.release();
    expect(await sweep).toMatchObject({ synced: 1 });
    expect(await snapshotOf(t, organizationId)).toMatchObject({
      planKey: "team",
      syncState: "idle",
    });
  });
});

describe("sweep vs refresh (RC review 1 #1)", () => {
  it("the sweep claims and resolves the old state, a refresh resolves the new one: the sweep writes first, the refresh retries and answers the new plan", async () => {
    const t = await setup();
    const { organizationId, owner } = await dueOrg(t, "pro");
    const sweepHold = t.holds.at(1);
    const sweep = runSync(t.rt);
    await sweepHold.reached;
    t.source.states.set(organizationId, active("team"));
    const refreshHold = t.holds.at(2);
    const refresh = t.auth.api.refreshEntitlements({
      body: { organizationId },
      headers: owner.headers,
    });
    await refreshHold.reached;

    sweepHold.release();
    await sweep;
    refreshHold.release();
    const refreshed = await refresh;
    expect(refreshed.plan.key).toBe("team");
    expect(t.holds.calls()).toBe(3);
    expect((await snapshotOf(t, organizationId))?.planKey).toBe("team");
    expect((await t.api.get(organizationId)).plan.key).toBe("team");
  });

  it("the refresh writes while the sweep holds its claim: the sweep's write loses and the refresh's state stays", async () => {
    const t = await setup();
    const { organizationId, owner } = await dueOrg(t, "pro");
    const sweepHold = t.holds.at(1);
    const sweep = runSync(t.rt);
    await sweepHold.reached;
    t.source.states.set(organizationId, active("team"));
    const refreshed = await t.auth.api.refreshEntitlements({
      body: { organizationId },
      headers: owner.headers,
    });
    expect(refreshed.plan.key).toBe("team");
    sweepHold.release();
    expect((await sweep) satisfies EntitlementsSweepResult).toMatchObject({
      synced: 1,
    });
    expect((await snapshotOf(t, organizationId))?.planKey).toBe("team");
    expect((await t.api.get(organizationId)).plan.key).toBe("team");
  });
});

describe("two concurrent pushes (RC review 1 #1)", () => {
  it("in one process: the second push waits for the first and stores the latest state", async () => {
    const t = await setup();
    const { organizationId } = await dueOrg(t, "free");
    t.source.states.set(organizationId, active("pro"));
    const firstHold = t.holds.at(1);
    const first = t.source.changed?.(organizationId);
    await firstHold.reached;
    t.source.states.set(organizationId, active("team"));
    const second = t.source.changed?.(organizationId);
    firstHold.release();
    await Promise.all([first, second]);
    expect(t.holds.calls()).toBe(2);
    expect((await snapshotOf(t, organizationId))?.planKey).toBe("team");
    expect((await t.api.get(organizationId)).plan.key).toBe("team");
  });

  it("in two processes: the push that resolved the older state loses its write and retries; the latest state stays", async () => {
    const a = await setup();
    const b = await secondProcess(a);
    const { organizationId } = await dueOrg(a, "free");
    // process A resolves "pro" and is held
    a.source.states.set(organizationId, active("pro"));
    const aHold = a.holds.at(1);
    const pushA = a.source.changed?.(organizationId);
    await aHold.reached;
    // the provider moves on; process B's push writes "team"
    a.source.states.set(organizationId, active("team"));
    b.source.states.set(organizationId, active("team"));
    await b.source.changed?.(organizationId);
    expect((await snapshotOf(a, organizationId))?.planKey).toBe("team");

    aHold.release();
    await pushA;
    expect(a.holds.calls()).toBe(2);
    expect((await snapshotOf(a, organizationId))?.planKey).toBe("team");
    expect((await a.api.get(organizationId)).plan.key).toBe("team");
    expect((await b.api.get(organizationId)).plan.key).toBe("team");
    expect(a.error).not.toHaveBeenCalled();
    expect(b.error).not.toHaveBeenCalled();
  });
});

describe("sweep vs sweep after a lease expiry (RC review 2 NB1)", () => {
  it("sweep A's lease runs out, sweep B claims the row; A's lost write leaves B's claim in place and B's write lands", async () => {
    const a = await setup();
    const b = await secondProcess(a);
    const { organizationId } = await dueOrg(a, "pro");
    const startedAt = new Date();
    a.rt.now = () => startedAt;
    // sweep A claims at startedAt, resolves "pro" and is held
    const aHold = a.holds.at(1);
    const sweepA = runSync(a.rt);
    await aHold.reached;
    const claimA = await snapshotOf(a, organizationId);
    expect(claimA?.syncState).toBe("syncing");
    expect(new Date(claimA?.syncClaimedAt as Date).getTime()).toBe(
      startedAt.getTime(),
    );

    // A's lease runs out: sweep B (another process) releases the stale
    // claim, claims the row again, resolves "team" and is held
    const later = new Date(startedAt.getTime() + a.rt.options.leaseMs + MINUTE);
    b.rt.now = () => later;
    b.source.states.set(organizationId, active("team"));
    const bHold = b.holds.at(1);
    const sweepB = runSync(b.rt);
    await bHold.reached;
    const claimB = await snapshotOf(a, organizationId);
    expect(claimB?.syncState).toBe("syncing");
    expect(new Date(claimB?.syncClaimedAt as Date).getTime()).toBe(
      later.getTime(),
    );

    // A's write loses the version guard; its release must not free B's claim
    aHold.release();
    expect(await sweepA).toMatchObject({ synced: 1, retrying: 0, failed: 0 });
    const afterA = await snapshotOf(a, organizationId);
    expect(afterA).toMatchObject({
      planKey: "pro",
      syncState: "syncing",
      version: claimB?.version,
    });
    expect(new Date(afterA?.syncClaimedAt as Date).getTime()).toBe(
      later.getTime(),
    );

    // B's write lands
    bHold.release();
    expect(await sweepB).toMatchObject({ synced: 1, retrying: 0, failed: 0 });
    expect(await snapshotOf(a, organizationId)).toMatchObject({
      planKey: "team",
      syncState: "idle",
      syncClaimedAt: null,
      syncAttempts: 0,
      version: (claimB?.version ?? 0) + 1,
    });
    expect(planChanges(b.onEvent)).toEqual([
      { from: "pro", to: "team", status: "active" },
    ]);
    expect(a.error).not.toHaveBeenCalled();
    expect(b.error).not.toHaveBeenCalled();
  });
});

describe("the create-conflict path never overwrites a newer row (RC review 1 #1)", () => {
  it("a create that loses the unique organizationId to another process returns null and leaves that row", async () => {
    const a = await setup();
    const b = await secondProcess(a);
    const { organizationId } = await seedOrg(a.auth);
    // A's create is held until B has created the row
    const created = barrier();
    a.hooks.before = async (call) => {
      if (call.method === "create" && call.model === "entitlementSnapshot") {
        created.reach();
        await created.released;
      }
    };
    const { adapter } = await getContext(a.auth);
    const write = writeSnapshot(a.rt, organizationId, active("pro"), {
      previous: null,
      adapter,
    });
    await created.reached;
    b.source.states.set(organizationId, active("team"));
    await b.source.changed?.(organizationId);
    created.release();
    expect(await write).toBeNull();
    expect(await snapshotOf(a, organizationId)).toMatchObject({
      planKey: "team",
      version: 0,
    });
    // the conflict logged nothing (the unique violation was expected)
    expect(a.error).not.toHaveBeenCalled();
  });

  it("a push whose create found a row written meanwhile retries and stores the latest state", async () => {
    const a = await setup();
    const b = await secondProcess(a);
    const { organizationId } = await seedOrg(a.auth);
    // A's push read no row and resolves "pro", held
    a.source.states.set(organizationId, active("pro"));
    const aHold = a.holds.at(1);
    const pushA = a.source.changed?.(organizationId);
    await aHold.reached;
    // B creates the row with "team"; the provider says team from now on
    a.source.states.set(organizationId, active("team"));
    b.source.states.set(organizationId, active("team"));
    await b.source.changed?.(organizationId);

    aHold.release();
    await pushA;
    expect(a.holds.calls()).toBe(2);
    const rows = await a.db
      .selectFrom("entitlementSnapshot")
      .selectAll()
      .where("organizationId", "=", organizationId)
      .execute();
    expect(rows).toHaveLength(1);
    expect(rows[0] as EntitlementSnapshotRow).toMatchObject({
      planKey: "team",
      version: 1, // B's create, then A's retry
    });
  });
});
