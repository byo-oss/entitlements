// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { defineEntitlements, type LimitValue } from "../catalog";
import type { UsageInfo, Wire } from "../types";
import { defaultLabels } from "./labels";
import { UsageMeter } from "./usage-meter";
import type { UseEntitlementsResult } from "./use-entitlements";

afterEach(cleanup);

const catalog = defineEntitlements({
  features: ["exports"],
  limits: {
    apiCalls: { kind: "metered", period: "day" },
    uploads: { kind: "metered", period: "month" },
    reports: { kind: "metered", period: "billing" },
    members: { kind: "capacity" },
  },
  plans: {
    free: {
      features: { exports: false },
      limits: { apiCalls: 1_000, uploads: 10, reports: 5, members: 5 },
    },
  },
  defaultPlan: "free",
});
type Catalog = typeof catalog;

function entitlements(
  state: {
    used?: number;
    limit?: LimitValue;
    isLoading?: boolean;
    error?: Error | null;
    hasData?: boolean;
  } = {},
): UseEntitlementsResult<Catalog> {
  const hasData = state.hasData ?? !state.isLoading;
  const usage: Wire<UsageInfo> = {
    used: state.used ?? 920,
    remaining: 80,
    resetAt: "2026-10-22T00:00:00.000Z",
  };
  return {
    data: hasData ? ({} as never) : null,
    isLoading: state.isLoading ?? false,
    error: state.error ?? null,
    hasFeature: () => false,
    limit: () => (hasData ? (state.limit ?? 1_000) : null),
    usage: () => (hasData ? usage : null),
    refresh: async () => {},
  };
}

describe("UsageMeter", () => {
  it("renders a progressbar with aria values and the usage text", () => {
    render(
      <UsageMeter
        entitlements={entitlements()}
        limitKey="apiCalls"
        catalog={catalog}
      />,
    );
    const bar = screen.getByRole("progressbar");
    expect(bar.getAttribute("aria-valuenow")).toBe("920");
    expect(bar.getAttribute("aria-valuemin")).toBe("0");
    expect(bar.getAttribute("aria-valuemax")).toBe("1000");
    expect(bar.getAttribute("aria-valuetext")).toBe(
      "920 of 1,000 API calls used today",
    );
    expect(screen.getByText("920 of 1,000 API calls used today")).toBeTruthy();
  });

  it("names the period from the catalog, and leaves it out without one", () => {
    const { rerender } = render(
      <UsageMeter
        entitlements={entitlements({ used: 3, limit: 10 })}
        limitKey="uploads"
        catalog={catalog}
      />,
    );
    expect(screen.getByRole("progressbar").getAttribute("aria-valuetext")).toBe(
      "3 of 10 uploads used this month",
    );
    rerender(
      <UsageMeter
        entitlements={entitlements({ used: 3, limit: 5 })}
        limitKey="reports"
        catalog={catalog}
      />,
    );
    expect(screen.getByRole("progressbar").getAttribute("aria-valuetext")).toBe(
      "3 of 5 reports used this billing period",
    );
    rerender(
      <UsageMeter
        entitlements={entitlements({ used: 3, limit: 5 })}
        limitKey="reports"
      />,
    );
    expect(screen.getByRole("progressbar").getAttribute("aria-valuetext")).toBe(
      "3 of 5 reports used",
    );
  });

  it("uses shadcn tokens and the class props", () => {
    const { container } = render(
      <UsageMeter
        entitlements={entitlements()}
        limitKey="apiCalls"
        className="mt-2"
        barClassName="bg-destructive"
      />,
    );
    const outer = container.firstElementChild as HTMLElement;
    expect(outer.className).toContain("mt-2");
    const bar = screen.getByRole("progressbar");
    expect(bar.className).toContain("bg-muted");
    const fill = bar.firstElementChild as HTMLElement;
    expect(fill.className).toContain("bg-primary");
    expect(fill.className).toContain("bg-destructive");
    expect(fill.style.width).toBe("92%");
    expect(container.querySelector(".text-muted-foreground")).not.toBeNull();
  });

  it("appends textClassName to the text line's default classes", () => {
    render(
      <UsageMeter
        entitlements={entitlements()}
        limitKey="apiCalls"
        textClassName="font-medium"
      />,
    );
    const line = screen.getByText("920 of 1,000 API calls used");
    expect(line.className).toContain("text-sm");
    expect(line.className).toContain("text-muted-foreground");
    expect(line.className).toContain("font-medium");
  });

  it("makes the text line a polite live region and keeps the aria values", () => {
    render(<UsageMeter entitlements={entitlements()} limitKey="apiCalls" />);
    const line = screen.getByText("920 of 1,000 API calls used");
    expect(line.getAttribute("aria-live")).toBe("polite");
    expect(line.getAttribute("aria-atomic")).toBe("true");
    const bar = screen.getByRole("progressbar");
    expect(bar.getAttribute("aria-valuenow")).toBe("920");
    expect(bar.getAttribute("aria-valuemax")).toBe("1000");
  });

  it("clamps the value when usage is over the limit", () => {
    render(
      <UsageMeter
        entitlements={entitlements({ used: 1_200 })}
        limitKey="apiCalls"
      />,
    );
    const bar = screen.getByRole("progressbar");
    expect(bar.getAttribute("aria-valuenow")).toBe("1000");
    expect(bar.getAttribute("aria-valuemax")).toBe("1000");
    expect(bar.getAttribute("aria-valuetext")).toBe(
      "1,200 of 1,000 API calls used",
    );
    expect((bar.firstElementChild as HTMLElement).style.width).toBe("100%");
  });

  it("keeps valid aria values for an unlimited limit", () => {
    render(
      <UsageMeter
        entitlements={entitlements({ used: 40, limit: "unlimited" })}
        limitKey="apiCalls"
        catalog={catalog}
      />,
    );
    const bar = screen.getByRole("progressbar");
    expect(bar.getAttribute("aria-valuenow")).toBe("40");
    expect(bar.getAttribute("aria-valuemax")).toBe("40");
    expect(bar.getAttribute("aria-valuetext")).toBe(
      "40 API calls used today (unlimited)",
    );
    expect((bar.firstElementChild as HTMLElement).style.width).toBe("0%");
  });

  it("labels overrides every string", () => {
    const received: unknown[] = [];
    const { rerender } = render(
      <UsageMeter
        entitlements={entitlements()}
        limitKey="apiCalls"
        catalog={catalog}
        labels={{
          usage: (input) => {
            received.push(input);
            return `${input.used}/${input.limit} (${input.period})`;
          },
        }}
      />,
    );
    expect(screen.getByRole("progressbar").getAttribute("aria-valuetext")).toBe(
      "920/1000 (day)",
    );
    expect(received[0]).toEqual({
      used: 920,
      limit: 1_000,
      limitKey: "apiCalls",
      period: "day",
    });

    rerender(
      <UsageMeter
        entitlements={entitlements({ isLoading: true })}
        limitKey="apiCalls"
        labels={{ loading: "Chargement" }}
      />,
    );
    expect(screen.getByText("Chargement")).toBeTruthy();
    expect(screen.getByRole("progressbar").getAttribute("aria-valuetext")).toBe(
      "Chargement",
    );

    rerender(
      <UsageMeter
        entitlements={entitlements({
          hasData: false,
          error: new Error("boom"),
        })}
        limitKey="apiCalls"
        labels={{ error: "Indisponible" }}
      />,
    );
    expect(screen.getByRole("alert").textContent).toBe("Indisponible");
  });

  it("has English defaults for loading and error", () => {
    const { rerender } = render(
      <UsageMeter
        entitlements={entitlements({ isLoading: true })}
        limitKey="apiCalls"
      />,
    );
    expect(screen.getByText(defaultLabels.loading)).toBeTruthy();
    const loading = screen.getByRole("progressbar");
    expect(loading.getAttribute("aria-busy")).toBe("true");
    expect(loading.hasAttribute("aria-valuenow")).toBe(false);

    rerender(
      <UsageMeter
        entitlements={entitlements({
          hasData: false,
          error: new Error("boom"),
        })}
        limitKey="apiCalls"
      />,
    );
    expect(screen.getByRole("alert").textContent).toBe(defaultLabels.error);
  });

  it("humanizes the limit key in the default text", () => {
    expect(
      defaultLabels.usage({
        used: 1,
        limit: 2,
        limitKey: "retentionDays",
        period: null,
      }),
    ).toBe("1 of 2 retention days used");
  });

  it("rejects limit keys that aren't metered", () => {
    render(
      <UsageMeter
        entitlements={entitlements()}
        // @ts-expect-error "members" is a capacity key
        limitKey="members"
      />,
    );
  });
});
