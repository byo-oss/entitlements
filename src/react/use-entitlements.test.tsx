// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defineEntitlements } from "../catalog";
import type { EntitlementsResponse, Wire } from "../types";
import {
  type EntitlementsClientLike,
  useEntitlements,
} from "./use-entitlements";

afterEach(cleanup);

const catalog = defineEntitlements({
  features: ["exports", "sso"],
  limits: {
    apiCalls: { kind: "metered", period: "day" },
    members: { kind: "capacity" },
  },
  plans: {
    free: {
      features: { exports: false, sso: false },
      limits: { apiCalls: 1_000, members: 5 },
    },
    pro: {
      features: { exports: true, sso: false },
      limits: { apiCalls: 50_000, members: "unlimited" },
    },
    team: {
      features: { exports: true, sso: true },
      limits: { apiCalls: "unlimited", members: "unlimited" },
    },
  },
  defaultPlan: "free",
});
type Catalog = typeof catalog;
type Response = Wire<EntitlementsResponse<Catalog>>;

function response(overrides: Partial<Response> = {}): Response {
  return {
    organizationId: "org_1",
    degraded: false,
    plan: { key: "free", display: {}, source: "default" },
    status: null,
    periodEnd: null,
    cancelAtPeriodEnd: false,
    features: { exports: false, sso: false },
    limits: { apiCalls: 1_000, members: 5 },
    overrides: [],
    usage: {
      apiCalls: {
        used: 920,
        remaining: 80,
        resetAt: "2026-10-22T00:00:00.000Z",
      },
    },
    ...overrides,
  };
}

type Answer =
  | { data: unknown; error: null }
  | { data: null; error: { status: number; message?: string } };

/** A client with no server behind it. */
function mockClient(answers: { get?: Answer; refresh?: Answer } = {}) {
  const get = vi.fn(
    async (_input: { query: { organizationId: string } }): Promise<Answer> =>
      answers.get ?? { data: response(), error: null },
  );
  const refresh = vi.fn(
    async (_input: { organizationId: string }): Promise<Answer> =>
      answers.refresh ?? { data: response(), error: null },
  );
  const client: EntitlementsClientLike = { entitlements: { get, refresh } };
  return { client, get, refresh };
}

describe("useEntitlements", () => {
  it("is loading first, then holds the response", async () => {
    const { client, get } = mockClient({
      get: {
        data: response({
          plan: { key: "pro", display: {}, source: "billing" },
          features: { exports: true, sso: false },
          limits: { apiCalls: 50_000, members: "unlimited" },
        }),
        error: null,
      },
    });
    const { result } = renderHook(() =>
      useEntitlements<Catalog>({ client, organizationId: "org_1" }),
    );

    expect(result.current.isLoading).toBe(true);
    expect(result.current.data).toBeNull();
    expect(result.current.hasFeature("exports")).toBe(false);
    expect(result.current.limit("apiCalls")).toBeNull();
    expect(result.current.usage("apiCalls")).toBeNull();

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith({ query: { organizationId: "org_1" } });
    expect(result.current.error).toBeNull();
    expect(result.current.data?.plan.key).toBe("pro");
    expect(result.current.hasFeature("exports")).toBe(true);
    expect(result.current.hasFeature("sso")).toBe(false);
    expect(result.current.limit("apiCalls")).toBe(50_000);
    expect(result.current.limit("members")).toBe("unlimited");
    expect(result.current.usage("apiCalls")).toEqual({
      used: 920,
      remaining: 80,
      resetAt: "2026-10-22T00:00:00.000Z",
    });
  });

  it("reports an error result from the client", async () => {
    const { client } = mockClient({
      get: { data: null, error: { status: 404, message: "Not found" } },
    });
    const { result } = renderHook(() =>
      useEntitlements<Catalog>({ client, organizationId: "org_1" }),
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.data).toBeNull();
    expect(result.current.error?.message).toBe("Not found");
    expect((result.current.error as Error & { status?: number }).status).toBe(
      404,
    );
    expect(result.current.hasFeature("exports")).toBe(false);
    expect(result.current.limit("members")).toBeNull();
  });

  it("reports a thrown request as an error", async () => {
    const { client, get } = mockClient();
    get.mockRejectedValueOnce(new Error("network down"));
    const { result } = renderHook(() =>
      useEntitlements<Catalog>({ client, organizationId: "org_1" }),
    );
    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.error?.message).toBe("network down");
    expect(result.current.isLoading).toBe(false);
  });

  it("refresh calls refreshEntitlements and stores the answer", async () => {
    const { client, get, refresh } = mockClient({
      refresh: {
        data: response({
          plan: { key: "team", display: {}, source: "billing" },
          features: { exports: true, sso: true },
        }),
        error: null,
      },
    });
    const { result } = renderHook(() =>
      useEntitlements<Catalog>({ client, organizationId: "org_1" }),
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.hasFeature("sso")).toBe(false);

    await act(async () => {
      await result.current.refresh();
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledWith({ organizationId: "org_1" });
    expect(get).toHaveBeenCalledTimes(1);
    expect(result.current.hasFeature("sso")).toBe(true);
    expect(result.current.data?.plan.key).toBe("team");
    expect(result.current.isLoading).toBe(false);
  });

  it("keeps the last data when a refresh fails, and clears the error after a good one", async () => {
    const { client, refresh } = mockClient();
    const { result } = renderHook(() =>
      useEntitlements<Catalog>({ client, organizationId: "org_1" }),
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    refresh.mockResolvedValueOnce({
      data: null,
      error: { status: 503, message: "unavailable" },
    });
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.error?.message).toBe("unavailable");
    expect(result.current.data?.plan.key).toBe("free");

    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.error).toBeNull();
  });

  it("loads again when the organization changes, without showing the old one", async () => {
    const { client, get } = mockClient();
    get.mockImplementation(async ({ query }) => ({
      data: response({
        organizationId: query.organizationId,
        features: { exports: query.organizationId === "org_2", sso: false },
      }),
      error: null,
    }));
    const { result, rerender } = renderHook(
      ({ organizationId }) =>
        useEntitlements<Catalog>({ client, organizationId }),
      { initialProps: { organizationId: "org_1" } },
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.data?.organizationId).toBe("org_1");

    rerender({ organizationId: "org_2" });
    expect(result.current.isLoading).toBe(true);
    expect(result.current.data).toBeNull();
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.data?.organizationId).toBe("org_2");
    expect(result.current.hasFeature("exports")).toBe(true);
    expect(get).toHaveBeenCalledTimes(2);
  });

  it("ignores a stale answer that arrives after the organization changed", async () => {
    const { client, get } = mockClient();
    let release: (value: Answer) => void = () => {};
    get.mockImplementationOnce(
      () =>
        new Promise<Answer>((resolve) => {
          release = resolve;
        }),
    );
    get.mockImplementationOnce(async ({ query }) => ({
      data: response({ organizationId: query.organizationId }),
      error: null,
    }));
    const { result, rerender } = renderHook(
      ({ organizationId }) =>
        useEntitlements<Catalog>({ client, organizationId }),
      { initialProps: { organizationId: "org_1" } },
    );
    rerender({ organizationId: "org_2" });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    await act(async () => {
      release({ data: response({ organizationId: "org_1" }), error: null });
    });
    expect(result.current.data?.organizationId).toBe("org_2");
  });
});

describe("useEntitlements types", () => {
  it("rejects keys that aren't in the catalog", () => {
    const { client } = mockClient();
    const { result } = renderHook(() =>
      useEntitlements<Catalog>({ client, organizationId: "org_1" }),
    );
    // @ts-expect-error "nope" is not a feature key
    result.current.hasFeature("nope");
    // @ts-expect-error "nope" is not a limit key
    result.current.limit("nope");
    // @ts-expect-error "members" is a capacity key, not a metered one
    result.current.usage("members");
    // @ts-expect-error "nope" is not a metered key
    result.current.usage("nope");
    expect(result.current.hasFeature("sso")).toBe(false);
  });
});
