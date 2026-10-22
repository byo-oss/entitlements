// @vitest-environment happy-dom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defineEntitlements } from "../catalog";
import {
  EntitlementGate,
  type EntitlementGateResult,
} from "./entitlement-gate";
import type { UseEntitlementsResult } from "./use-entitlements";

afterEach(cleanup);

const catalog = defineEntitlements({
  features: ["exports", "sso"],
  limits: { apiCalls: { kind: "metered", period: "day" } },
  plans: {
    free: {
      features: { exports: false, sso: false },
      limits: { apiCalls: 1_000 },
    },
    pro: {
      features: { exports: true, sso: false },
      limits: { apiCalls: 50_000 },
    },
    team: {
      features: { exports: true, sso: true },
      limits: { apiCalls: "unlimited" },
    },
  },
  defaultPlan: "free",
});
type Catalog = typeof catalog;

function entitlements(
  features: Partial<Record<"exports" | "sso", boolean>>,
  isLoading = false,
): UseEntitlementsResult<Catalog> {
  return {
    data: null,
    isLoading,
    error: null,
    hasFeature: (key) => features[key] === true,
    limit: () => null,
    usage: () => null,
    refresh: async () => {},
  };
}

describe("EntitlementGate", () => {
  it("renders children when the feature is allowed", () => {
    const fallback = vi.fn(() => "locked");
    const { container } = render(
      <EntitlementGate
        entitlements={entitlements({ exports: true })}
        feature="exports"
        fallback={fallback}
      >
        <span>export</span>
      </EntitlementGate>,
    );
    expect(container.innerHTML).toBe("<span>export</span>");
    expect(fallback).not.toHaveBeenCalled();
  });

  it("hands the fallback upgradeTo, in catalog order, when a catalog is given", () => {
    let seen: EntitlementGateResult<Catalog> | null = null;
    const { container } = render(
      <EntitlementGate
        entitlements={entitlements({})}
        feature="exports"
        catalog={catalog}
        fallback={(result) => {
          seen = result;
          return <b>upgrade to {result.upgradeTo.join(" or ")}</b>;
        }}
      >
        <span>export</span>
      </EntitlementGate>,
    );
    expect(seen).toEqual({
      allowed: false,
      key: "exports",
      isLoading: false,
      upgradeTo: ["pro", "team"],
    });
    expect(container.innerHTML).toBe("<b>upgrade to pro or team</b>");
  });

  it("gives an empty upgradeTo without a catalog", () => {
    const fallback = vi.fn((_result: EntitlementGateResult<Catalog>) => null);
    render(
      <EntitlementGate
        entitlements={entitlements({})}
        feature="sso"
        fallback={fallback}
      />,
    );
    expect(fallback).toHaveBeenCalledWith({
      allowed: false,
      key: "sso",
      isLoading: false,
      upgradeTo: [],
    });
  });

  it("shows the fallback with isLoading true while loading", () => {
    const fallback = vi.fn((_result: EntitlementGateResult<Catalog>) => (
      <i>loading</i>
    ));
    const { container } = render(
      <EntitlementGate
        entitlements={entitlements({}, true)}
        feature="exports"
        fallback={fallback}
      >
        <span>export</span>
      </EntitlementGate>,
    );
    expect(fallback.mock.calls[0]?.[0].isLoading).toBe(true);
    expect(container.innerHTML).toBe("<i>loading</i>");
  });

  it("renders nothing when denied and no fallback is given", () => {
    const { container } = render(
      <EntitlementGate entitlements={entitlements({})} feature="exports">
        <span>export</span>
      </EntitlementGate>,
    );
    expect(container.innerHTML).toBe("");
  });

  it("rejects feature keys that aren't in the catalog", () => {
    render(
      <EntitlementGate
        entitlements={entitlements({})}
        // @ts-expect-error "nope" is not a feature key
        feature="nope"
      />,
    );
  });
});
