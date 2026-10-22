import { describe, expect, it, vi } from "vitest";
import { createEntitlements } from "./api";
import type { EntitlementSnapshotRow, EntitlementUsageRow } from "./schema";
import {
  fakeSource,
  getContext,
  getRuntime,
  makeAuth,
  seedOrg,
  testCatalog,
} from "./test-utils";

// PRD #11, end to end: a throwing source, a real organization with no
// snapshot row, and each check through `createEntitlements` answers what
// `onError` says, with `reason: "error"` and exactly one log line per call

async function setup(answer: "allow" | "deny") {
  const source = fakeSource();
  const sourceError = new Error("billing provider down");
  source.failWith = sourceError;
  const onError = vi.fn(() => answer);
  const auth = makeAuth({ options: { source, onError, cacheTtlMs: 0 } });
  const rt = await getRuntime(auth);
  const error = vi.fn();
  rt.logger = { ...rt.logger, error };
  const { organizationId } = await seedOrg(auth);
  const rows = async (model: string) => {
    const { adapter } = await getContext(auth);
    return adapter.findMany<EntitlementSnapshotRow | EntitlementUsageRow>({
      model,
      where: [{ field: "organizationId", value: organizationId }],
      limit: 10,
    });
  };
  return {
    api: createEntitlements(auth, testCatalog),
    source,
    sourceError,
    onError,
    error,
    organizationId,
    rows,
  };
}

describe.each(["allow", "deny"] as const)(
  "a throwing source with onError → %s",
  (answer) => {
    it("hasFeature, consumeUsage and checkCapacity answer onError with reason error, one log line each", async () => {
      const t = await setup(answer);
      const allowed = answer === "allow";
      const checks = [
        {
          operation: "hasFeature",
          key: "exports",
          run: () => t.api.hasFeature(t.organizationId, "exports"),
        },
        {
          operation: "consumeUsage",
          key: "apiCalls",
          run: () => t.api.consumeUsage(t.organizationId, "apiCalls"),
        },
        {
          operation: "checkCapacity",
          key: "members",
          run: () =>
            t.api.checkCapacity(t.organizationId, "members", { count: 1 }),
        },
      ] as const;
      for (const check of checks) {
        t.error.mockClear();
        t.onError.mockClear();
        const callsBefore = t.source.calls.length;
        const result = await check.run();
        expect(result).toMatchObject({
          allowed,
          reason: "error",
          key: check.key,
        });
        // the source was really asked, and failed
        expect(t.source.calls.length).toBe(callsBefore + 1);
        expect(t.error).toHaveBeenCalledTimes(1);
        expect(t.onError).toHaveBeenCalledTimes(1);
        expect(t.onError).toHaveBeenCalledWith(t.sourceError, {
          organizationId: t.organizationId,
          key: check.key,
          operation: check.operation,
        });
      }
      // nothing persisted: no snapshot, no consumed usage
      expect(await t.rows("entitlementSnapshot")).toHaveLength(0);
      const usage = (await t.rows("entitlementUsage")) as EntitlementUsageRow[];
      expect(usage.every((row) => row.used === 0)).toBe(true);
    });
  },
);
