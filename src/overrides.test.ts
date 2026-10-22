import type { ByoEvent } from "@byo-oss/core";
import { describe, expect, it, vi } from "vitest";
import { ENTITLEMENTS_ERROR_CODES } from "./error-codes";
import {
  MAX_REASON_LENGTH,
  type OverrideInput,
  removeOverride,
  setOverride,
  toPublicOverride,
  type ValidOverride,
  validateOverride,
} from "./overrides";
import type { EntitlementOverrideRow } from "./schema";
import {
  expectNoOuterCalls,
  getContext,
  getRuntime,
  makeAuth,
  STAFF_ORG_ID,
  seedOrg,
  seedOverride,
} from "./test-utils";

const NOW = new Date("2026-03-10T12:00:00.000Z");
const LATER = new Date("2026-03-10T13:00:00.000Z");

const invalidOverride = expect.objectContaining({
  status: "BAD_REQUEST",
  body: expect.objectContaining({
    code: ENTITLEMENTS_ERROR_CODES.INVALID_OVERRIDE.code,
  }),
});
const overrideNotFound = expect.objectContaining({
  status: "NOT_FOUND",
  body: expect.objectContaining({
    code: ENTITLEMENTS_ERROR_CODES.OVERRIDE_NOT_FOUND.code,
  }),
});

async function setup() {
  const onEvent = vi.fn((_event: ByoEvent) => {});
  // a staff organization id keeps the boot warning quiet
  const auth = makeAuth({
    options: { onEvent, staffOrganizationId: STAFF_ORG_ID },
  });
  const rt = await getRuntime(auth);
  rt.now = () => NOW;
  const { adapter } = await getContext(auth);
  const { organizationId, owner } = await seedOrg(auth);
  const other = await seedOrg(auth);
  const actor = { userId: owner.user.id };
  const rows = async (orgId = organizationId) =>
    adapter.findMany<EntitlementOverrideRow>({
      model: "entitlementOverride",
      where: [{ field: "organizationId", value: orgId }],
      limit: 100,
      sortBy: { field: "createdAt", direction: "asc" },
    });
  const byId = (id: string) =>
    adapter.findOne<EntitlementOverrideRow>({
      model: "entitlementOverride",
      where: [{ field: "id", value: id }],
    });
  const valid = (fields: Partial<ValidOverride>): ValidOverride => ({
    organizationId,
    kind: "feature",
    key: "exports",
    value: true,
    reason: "support ticket 42",
    expiresAt: null,
    ...fields,
  });
  return {
    auth,
    rt,
    onEvent,
    organizationId,
    other: other.organizationId,
    actor,
    rows,
    byId,
    valid,
  };
}

describe("validateOverride", () => {
  const base: OverrideInput = {
    organizationId: "org_1",
    kind: "feature",
    key: "exports",
    value: true,
    reason: "support ticket 42",
  };

  it("accepts each kind and normalizes the result", async () => {
    const { rt } = await setup();
    expect(validateOverride(rt, base, NOW)).toEqual({
      organizationId: "org_1",
      kind: "feature",
      key: "exports",
      value: true,
      reason: "support ticket 42",
      expiresAt: null,
    });
    expect(
      validateOverride(
        rt,
        { ...base, kind: "plan", key: "team", value: undefined },
        NOW,
      ),
    ).toMatchObject({ kind: "plan", key: "team", value: null });
    expect(
      validateOverride(
        rt,
        { ...base, kind: "plan", key: "pro", value: null },
        NOW,
      ),
    ).toMatchObject({ value: null });
    for (const [key, value] of [
      ["apiCalls", 0],
      ["members", 25],
      ["retentionDays", "unlimited"],
    ] as const) {
      expect(
        validateOverride(rt, { ...base, kind: "limit", key, value }, NOW),
      ).toMatchObject({ kind: "limit", key, value });
    }
    expect(validateOverride(rt, { ...base, value: false }, NOW)).toMatchObject({
      value: false,
    });
  });

  it("parses expiresAt (Date or string) and trims the reason", async () => {
    const { rt } = await setup();
    expect(
      validateOverride(
        rt,
        { ...base, expiresAt: LATER.toISOString(), reason: "  trial  " },
        NOW,
      ),
    ).toMatchObject({ expiresAt: LATER, reason: "trial" });
    expect(
      validateOverride(rt, { ...base, expiresAt: LATER }, NOW),
    ).toMatchObject({ expiresAt: LATER });
    expect(
      validateOverride(rt, { ...base, expiresAt: null }, NOW).expiresAt,
    ).toBeNull();
    expect(
      validateOverride(
        rt,
        { ...base, reason: "x".repeat(MAX_REASON_LENGTH) },
        NOW,
      ).reason,
    ).toHaveLength(MAX_REASON_LENGTH);
  });

  const rejects = (
    rt: Awaited<ReturnType<typeof setup>>["rt"],
    input: OverrideInput,
  ) => {
    let thrown: unknown;
    try {
      validateOverride(rt, input, NOW);
    } catch (error) {
      thrown = error;
    }
    expect(thrown, JSON.stringify(input)).toEqual(invalidOverride);
  };

  it("refuses a kind other than plan, feature or limit", async () => {
    const { rt } = await setup();
    for (const kind of ["", "Feature", "usage", "snapshot"]) {
      rejects(rt, { ...base, kind });
    }
  });

  it("refuses a key that isn't in the catalog for its kind", async () => {
    const { rt } = await setup();
    rejects(rt, { ...base, key: "" });
    rejects(rt, { ...base, key: "nope" });
    rejects(rt, { ...base, key: "apiCalls" }); // a limit, not a feature
    rejects(rt, { ...base, key: "toString" });
    rejects(rt, { ...base, key: "__proto__" });
    rejects(rt, { ...base, kind: "limit", key: "exports", value: 1 });
    rejects(rt, { ...base, kind: "limit", key: "constructor", value: 1 });
    rejects(rt, { ...base, kind: "plan", key: "gold", value: null });
    rejects(rt, { ...base, kind: "plan", key: "exports", value: null });
    // an alias stands for a billing plan key, not a catalog plan
    rejects(rt, { ...base, kind: "plan", key: "legacy", value: null });
    rejects(rt, { ...base, kind: "plan", key: "", value: null });
  });

  it("refuses a value invalid for its kind", async () => {
    const { rt } = await setup();
    for (const value of ["true", 1, null, undefined, {}]) {
      rejects(rt, { ...base, value });
    }
    for (const value of [
      -1,
      1.5,
      "5",
      "Unlimited",
      true,
      null,
      undefined,
      Number.NaN,
      Infinity,
    ]) {
      rejects(rt, { ...base, kind: "limit", key: "members", value });
    }
    for (const value of [true, false, "pro", 0]) {
      rejects(rt, { ...base, kind: "plan", key: "pro", value });
    }
  });

  it("refuses an expiresAt that doesn't parse or isn't in the future", async () => {
    const { rt } = await setup();
    rejects(rt, { ...base, expiresAt: "not a date" });
    rejects(rt, { ...base, expiresAt: "" });
    rejects(rt, { ...base, expiresAt: new Date(Number.NaN) });
    rejects(rt, { ...base, expiresAt: NOW });
    rejects(rt, { ...base, expiresAt: new Date(NOW.getTime() - 1) });
    rejects(rt, { ...base, expiresAt: "2020-01-01T00:00:00.000Z" });
    rejects(rt, { ...base, expiresAt: 123 as unknown as string });
  });

  it("refuses a reason outside 1-500 characters after trimming", async () => {
    const { rt } = await setup();
    rejects(rt, { ...base, reason: "" });
    rejects(rt, { ...base, reason: "   \n\t " });
    rejects(rt, { ...base, reason: "x".repeat(MAX_REASON_LENGTH + 1) });
    rejects(rt, { ...base, reason: undefined as unknown as string });
  });
});

describe("setOverride", () => {
  it("creates an active row with every field set", async () => {
    const { rt, valid, actor, organizationId, rows } = await setup();
    const row = await setOverride(
      rt,
      valid({ kind: "limit", key: "members", value: 25 }),
      actor,
    );
    expect(row).toMatchObject({
      organizationId,
      status: "active",
      kind: "limit",
      key: "members",
      value: "25",
      reason: "support ticket 42",
      permanent: true,
      expiresAt: null,
      endedAt: null,
      createdBy: actor.userId,
      removedBy: null,
      createdAt: NOW,
    });
    expect(await rows()).toEqual([expect.objectContaining({ id: row.id })]);
    expect(toPublicOverride(row)).toMatchObject({ value: 25 });

    const expiring = await setOverride(
      rt,
      valid({ key: "sso", expiresAt: LATER }),
      actor,
    );
    expect(expiring).toMatchObject({
      permanent: false,
      expiresAt: LATER,
      value: "true",
    });
  });

  it("a second plan override removes the first, whatever its key", async () => {
    const { rt, valid, actor, byId, rows } = await setup();
    const first = await setOverride(
      rt,
      valid({ kind: "plan", key: "pro", value: null }),
      actor,
    );
    const later = new Date(NOW.getTime() + 60_000);
    rt.now = () => later;
    const second = await setOverride(
      rt,
      valid({ kind: "plan", key: "team", value: null }),
      { userId: "staff-2" },
    );
    expect(await byId(first.id)).toMatchObject({
      status: "removed",
      removedBy: "staff-2",
      endedAt: later,
    });
    expect(await byId(second.id)).toMatchObject({
      status: "active",
      key: "team",
      createdBy: "staff-2",
    });
    expect(
      (await rows()).filter((r) => r.status === "active").map((r) => r.id),
    ).toEqual([second.id]);
  });

  it("replaces a feature or limit override by (organization, kind, key) only", async () => {
    const { rt, valid, actor, byId, other } = await setup();
    const exports = await setOverride(rt, valid({ key: "exports" }), actor);
    const sso = await setOverride(rt, valid({ key: "sso" }), actor);
    const members = await setOverride(
      rt,
      valid({ kind: "limit", key: "members", value: 10 }),
      actor,
    );
    const elsewhere = await setOverride(
      rt,
      valid({ organizationId: other, key: "exports" }),
      actor,
    );
    const plan = await setOverride(
      rt,
      valid({ kind: "plan", key: "pro", value: null }),
      actor,
    );

    const exports2 = await setOverride(
      rt,
      valid({ key: "exports", value: false }),
      actor,
    );
    const members2 = await setOverride(
      rt,
      valid({ kind: "limit", key: "members", value: "unlimited" }),
      actor,
    );
    expect((await byId(exports.id))?.status).toBe("removed");
    expect((await byId(members.id))?.status).toBe("removed");
    for (const kept of [sso, elsewhere, plan, exports2, members2]) {
      expect((await byId(kept.id))?.status).toBe("active");
    }
  });

  it("removes every active duplicate a race left behind", async () => {
    const { auth, rt, valid, actor, organizationId, byId } = await setup();
    const a = await seedOverride(auth, {
      organizationId,
      kind: "plan",
      key: "pro",
    });
    const b = await seedOverride(auth, {
      organizationId,
      kind: "plan",
      key: "team",
    });
    const ended = await seedOverride(auth, {
      organizationId,
      kind: "plan",
      key: "pro",
      status: "removed",
      endedAt: new Date(NOW.getTime() - 1000),
    });
    const c = await setOverride(
      rt,
      valid({ kind: "plan", key: "team", value: null }),
      actor,
    );
    expect((await byId(a.id))?.status).toBe("removed");
    expect((await byId(b.id))?.status).toBe("removed");
    // an ended row keeps its own end
    expect(await byId(ended.id)).toMatchObject({
      status: "removed",
      endedAt: new Date(NOW.getTime() - 1000),
      removedBy: null,
    });
    expect((await byId(c.id))?.status).toBe("active");
  });

  it("emits override.set with the decoded value and no reason, and clears the cache entry", async () => {
    const { rt, valid, actor, organizationId, onEvent } = await setup();
    const clear = vi.spyOn(rt.cache, "delete");
    await setOverride(
      rt,
      valid({ kind: "plan", key: "pro", value: null }),
      actor,
    );
    onEvent.mockClear();
    clear.mockClear();
    const row = await setOverride(
      rt,
      valid({ kind: "plan", key: "team", value: null, expiresAt: LATER }),
      actor,
    );
    expect(clear).toHaveBeenCalledWith(organizationId);
    // a replace emits one set event, no removed event
    expect(onEvent).toHaveBeenCalledTimes(1);
    const event = onEvent.mock.calls[0]?.[0];
    expect(event).toEqual({
      type: "entitlements.override.set",
      occurredAt: NOW,
      actorId: actor.userId,
      organizationId,
      subject: { type: "entitlementOverride", id: row.id },
      data: { kind: "plan", key: "team", value: null, expiresAt: LATER },
    });
    expect(JSON.stringify(event)).not.toContain("support ticket");

    onEvent.mockClear();
    await setOverride(
      rt,
      valid({ kind: "limit", key: "apiCalls", value: 7 }),
      actor,
    );
    expect(onEvent.mock.calls[0]?.[0]).toMatchObject({
      data: { kind: "limit", key: "apiCalls", value: 7, expiresAt: null },
    });
  });

  it("writes through the current adapter, so it joins a caller's transaction", async () => {
    const { auth, rt, valid, actor, byId } = await setup();
    const first = await setOverride(rt, valid({ key: "exports" }), actor);
    const second = await expectNoOuterCalls(auth, () =>
      setOverride(rt, valid({ key: "exports", value: false }), actor),
    );
    expect((await byId(first.id))?.status).toBe("removed");
    expect((await byId(second.id))?.status).toBe("active");
  });
});

describe("removeOverride", () => {
  it("soft-deletes an active override, clears the cache entry and emits override.removed", async () => {
    const { rt, valid, actor, organizationId, onEvent, byId } = await setup();
    const row = await setOverride(
      rt,
      valid({ kind: "limit", key: "members", value: 9 }),
      actor,
    );
    onEvent.mockClear();
    const clear = vi.spyOn(rt.cache, "delete");
    const later = new Date(NOW.getTime() + 5_000);
    rt.now = () => later;
    const removed = await removeOverride(rt, row.id, { userId: "staff-2" });
    expect(removed).toMatchObject({
      id: row.id,
      status: "removed",
      removedBy: "staff-2",
      endedAt: later,
      createdBy: actor.userId,
    });
    expect(await byId(row.id)).toMatchObject({ status: "removed" });
    expect(clear).toHaveBeenCalledWith(organizationId);
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent.mock.calls[0]?.[0]).toEqual({
      type: "entitlements.override.removed",
      occurredAt: later,
      actorId: "staff-2",
      organizationId,
      subject: { type: "entitlementOverride", id: row.id },
      data: { kind: "limit", key: "members" },
    });
  });

  it("answers 404 OVERRIDE_NOT_FOUND for a missing, removed or expired override", async () => {
    const { auth, rt, actor, organizationId, onEvent } = await setup();
    const expired = await seedOverride(auth, {
      organizationId,
      kind: "feature",
      key: "sso",
      status: "expired",
      endedAt: NOW,
    });
    const active = await seedOverride(auth, {
      organizationId,
      kind: "feature",
      key: "exports",
    });
    await removeOverride(rt, active.id, actor);
    onEvent.mockClear();
    for (const id of ["missing-id", expired.id, active.id]) {
      await expect(removeOverride(rt, id, actor)).rejects.toEqual(
        overrideNotFound,
      );
    }
    expect(onEvent).not.toHaveBeenCalled();
  });

  it("joins a caller's transaction", async () => {
    const { auth, rt, actor, organizationId, byId } = await setup();
    const row = await seedOverride(auth, {
      organizationId,
      kind: "feature",
      key: "exports",
    });
    await expectNoOuterCalls(auth, () => removeOverride(rt, row.id, actor));
    expect((await byId(row.id))?.status).toBe("removed");
  });
});
