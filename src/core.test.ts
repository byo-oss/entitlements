import {
  ByoFanOutError,
  deleteOrganizationData,
  listByoPlugins,
  sweepAll,
} from "@byo-oss/core";
import { describe, expect, it, vi } from "vitest";
import type { EntitlementSnapshotRow } from "./schema";
import {
  type AnyTestAuth,
  fakeSource,
  getContext,
  makeAuth,
  STAFF_ORG_ID,
  seedOrg,
  seedOverride,
  seedUsage,
  setSnapshot,
} from "./test-utils";

// PRD #25 (shared packages): @byo-oss/core reaches entitlements through its
// `byo` hooks, `sweepAll` for the sweep and `deleteOrganizationData` for the
// cleanup fan-out

const MINUTE = 60_000;

/** A snapshot that is idle and due for the sweep. */
const due = () => {
  const now = Date.now();
  return {
    syncedAt: new Date(now - 10 * MINUTE),
    nextSyncAt: new Date(now - MINUTE),
  };
};

async function snapshotOf(auth: AnyTestAuth, organizationId: string) {
  const { adapter } = await getContext(auth);
  return adapter.findOne<EntitlementSnapshotRow>({
    model: "entitlementSnapshot",
    where: [{ field: "organizationId", value: organizationId }],
  });
}

async function rowCounts(auth: AnyTestAuth, organizationId: string) {
  const { adapter } = await getContext(auth);
  const count = (model: string) =>
    adapter.count({
      model,
      where: [{ field: "organizationId", value: organizationId }],
    });
  return {
    snapshots: await count("entitlementSnapshot"),
    overrides: await count("entitlementOverride"),
    usage: await count("entitlementUsage"),
  };
}

async function seedRows(auth: AnyTestAuth, organizationId: string) {
  await setSnapshot(auth, organizationId, { planKey: "pro", status: "active" });
  await seedOverride(auth, { organizationId, kind: "feature", key: "sso" });
  await seedUsage(auth, { organizationId, key: "apiCalls", used: 3 });
}

/** A second BYO plugin: its hooks are spies, and they can be made to throw. */
function otherPlugin() {
  const calls: string[] = [];
  const hooks = {
    sweep: vi.fn(async () => {
      calls.push("sweep");
      return { done: 1, hasMore: false };
    }),
    deleteOrganizationData: vi.fn(
      async (_auth: unknown, _organizationId: string) => {
        calls.push("deleteOrganizationData");
      },
    ),
  };
  return {
    calls,
    hooks,
    plugin: { id: "other", byo: hooks } as unknown as { id: string },
  };
}

describe("@byo-oss/core: discovery", () => {
  it("listByoPlugins finds entitlements with its sweep and deleteOrganizationData hooks", () => {
    const auth = makeAuth({ options: { staffOrganizationId: STAFF_ORG_ID } });
    expect(listByoPlugins(auth)).toEqual([
      { id: "entitlements", hooks: ["sweep", "deleteOrganizationData"] },
    ]);
  });
});

describe("@byo-oss/core: sweepAll reaches entitlements' byo.sweep", () => {
  it("syncs a due organization through the billing source and reports the plugin's counts", async () => {
    const source = fakeSource();
    const auth = makeAuth({
      options: { source, cacheTtlMs: 0, staffOrganizationId: STAFF_ORG_ID },
    });
    const { organizationId } = await seedOrg(auth);
    await setSnapshot(auth, organizationId, due());
    source.states.set(organizationId, { planKey: "pro", status: "active" });

    const result = await sweepAll(auth);

    expect(result).toMatchObject({ hasMore: false, timedOut: false });
    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({
      pluginId: "entitlements",
      runs: 1,
      last: { synced: 1, hasMore: false },
    });
    expect(result.results[0]?.error).toBeUndefined();
    expect(source.calls).toHaveLength(1);
    expect((await snapshotOf(auth, organizationId))?.planKey).toBe("pro");
  });

  it("calls the sweep again while it reports hasMore, then stops", async () => {
    const source = fakeSource();
    const auth = makeAuth({
      options: {
        source,
        cacheTtlMs: 0,
        batchSize: 1,
        staffOrganizationId: STAFF_ORG_ID,
      },
    });
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const { organizationId } = await seedOrg(auth);
      await setSnapshot(auth, organizationId, due());
      source.states.set(organizationId, { planKey: "team", status: "active" });
      ids.push(organizationId);
    }
    const result = await sweepAll(auth);
    expect(result.hasMore).toBe(false);
    expect(result.results[0]?.runs).toBeGreaterThan(1);
    for (const id of ids) {
      expect((await snapshotOf(auth, id))?.planKey).toBe("team");
    }
  });

  it("runs next to another BYO plugin, in plugin order, and one plugin's failure doesn't stop the other", async () => {
    const other = otherPlugin();
    other.hooks.sweep.mockRejectedValueOnce(new Error("other sweep broke"));
    const source = fakeSource();
    const auth = makeAuth({
      options: { source, cacheTtlMs: 0, staffOrganizationId: STAFF_ORG_ID },
      plugins: [other.plugin],
    });
    const { organizationId } = await seedOrg(auth);
    await setSnapshot(auth, organizationId, due());
    source.states.set(organizationId, { planKey: "pro", status: "active" });
    const onError = vi.fn();

    const result = await sweepAll(auth, { onError });

    expect(result.results.map((r) => r.pluginId)).toEqual([
      "entitlements",
      "other",
    ]);
    expect(result.results[0]).toMatchObject({ last: { synced: 1 } });
    expect(result.results[1]?.error).toBeInstanceOf(Error);
    expect(onError).toHaveBeenCalledTimes(1);
    expect((await snapshotOf(auth, organizationId))?.planKey).toBe("pro");
  });
});

describe("@byo-oss/core: deleteOrganizationData fans out to entitlements' cleanup", () => {
  it("deletes the organization's snapshot, overrides and usage, and leaves other organizations alone", async () => {
    const auth = makeAuth({ options: { staffOrganizationId: STAFF_ORG_ID } });
    const { organizationId } = await seedOrg(auth);
    const kept = await seedOrg(auth);
    await seedRows(auth, organizationId);
    await seedRows(auth, kept.organizationId);
    expect(await rowCounts(auth, organizationId)).toEqual({
      snapshots: 1,
      overrides: 1,
      usage: 1,
    });

    await deleteOrganizationData(auth, organizationId);

    expect(await rowCounts(auth, organizationId)).toEqual({
      snapshots: 0,
      overrides: 0,
      usage: 0,
    });
    expect(await rowCounts(auth, kept.organizationId)).toEqual({
      snapshots: 1,
      overrides: 1,
      usage: 1,
    });
  });

  it("reaches entitlements and the other plugin; a failing plugin ends in a ByoFanOutError after the cleanup ran", async () => {
    const other = otherPlugin();
    other.hooks.deleteOrganizationData.mockRejectedValueOnce(
      new Error("other cleanup broke"),
    );
    const auth = makeAuth({
      options: { staffOrganizationId: STAFF_ORG_ID },
      plugins: [other.plugin],
    });
    const { organizationId } = await seedOrg(auth);
    await seedRows(auth, organizationId);

    const failure = await deleteOrganizationData(auth, organizationId).then(
      () => null,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(ByoFanOutError);
    expect((failure as ByoFanOutError).failures.map((f) => f.pluginId)).toEqual(
      ["other"],
    );
    expect(other.hooks.deleteOrganizationData).toHaveBeenCalledWith(
      expect.anything(),
      organizationId,
    );
    // entitlements ran first and finished its cleanup
    expect(await rowCounts(auth, organizationId)).toEqual({
      snapshots: 0,
      overrides: 0,
      usage: 0,
    });
  });
});
