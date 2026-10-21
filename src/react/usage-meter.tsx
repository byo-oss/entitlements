// BYO_STUB: N11 replaces this file (contracts.md "react/usage-meter.tsx")
import type { ReactNode } from "react";
import type { AnyCatalog, MeteredKey } from "../catalog";
import type { UsageMeterLabels } from "./labels";
import type { UseEntitlementsResult } from "./use-entitlements";

export type UsageMeterProps<C extends AnyCatalog = AnyCatalog> = {
  entitlements: UseEntitlementsResult<C>;
  limitKey: MeteredKey<C>;
  /** Classes on the outer element. */
  className?: string;
  /** Classes on the filled bar. */
  barClassName?: string;
  /** Overrides any default string. */
  labels?: Partial<UsageMeterLabels>;
};

/**
 * A progress bar on shadcn tokens (`bg-muted`, `bg-primary`,
 * `text-muted-foreground`) with `role="progressbar"`, `aria-valuenow`,
 * `aria-valuemin`, `aria-valuemax` and `aria-valuetext`. Stub: renders
 * nothing.
 */
export function UsageMeter<C extends AnyCatalog = AnyCatalog>(
  _props: UsageMeterProps<C>,
): ReactNode {
  return null;
}
