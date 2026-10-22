import type { ReactNode } from "react";
import type { AnyCatalog, MeteredKey, MeteredPeriod } from "../catalog";
import { defaultLabels, type UsageMeterLabels } from "./labels";
import type { UseEntitlementsResult } from "./use-entitlements";

export type UsageMeterProps<C extends AnyCatalog = AnyCatalog> = {
  entitlements: UseEntitlementsResult<C>;
  limitKey: MeteredKey<C>;
  /**
   * The catalog, so the default text can name the period ("used today");
   * without it `labels.usage` gets `period: null`.
   */
  catalog?: C;
  /** Classes on the outer element. */
  className?: string;
  /** Classes on the filled bar. */
  barClassName?: string;
  /** Classes appended to the text line's defaults. */
  textClassName?: string;
  /** Overrides any default string. */
  labels?: Partial<UsageMeterLabels>;
};

const join = (...classes: (string | undefined)[]) =>
  classes.filter(Boolean).join(" ");

function periodOf(catalog: AnyCatalog | undefined, key: string) {
  const definition = (
    catalog?.limits as
      | Record<string, { kind: string; period?: MeteredPeriod }>
      | undefined
  )?.[key];
  return definition?.kind === "metered" && definition.period
    ? definition.period
    : null;
}

/**
 * A progress bar on shadcn tokens (`bg-muted`, `bg-primary`,
 * `text-muted-foreground`) with `role="progressbar"`, `aria-valuenow`,
 * `aria-valuemin`, `aria-valuemax` and `aria-valuetext`.
 *
 * The text line is a polite live region (`aria-live="polite"`,
 * `aria-atomic="true"`), so a changed count is announced; `textClassName`
 * adds classes to it.
 *
 * For an `"unlimited"` limit the bar stays empty and `aria-valuemax` equals
 * the amount used (at least 1), so the values stay valid.
 */
export function UsageMeter<C extends AnyCatalog = AnyCatalog>(
  props: UsageMeterProps<C>,
): ReactNode {
  const { entitlements, limitKey, catalog, className, barClassName } = props;
  const labels: UsageMeterLabels = { ...defaultLabels, ...props.labels };
  const outer = join("w-full space-y-1", className);
  const text = join("text-sm text-muted-foreground", props.textClassName);

  const usage = entitlements.usage(limitKey);
  const limit = entitlements.limit(limitKey);

  if (!usage || limit === null) {
    if (entitlements.error && !entitlements.data) {
      return (
        <div className={outer}>
          <p role="alert" className={text}>
            {labels.error}
          </p>
        </div>
      );
    }
    if (entitlements.isLoading) {
      return (
        <div className={outer}>
          <div
            role="progressbar"
            aria-busy="true"
            aria-valuemin={0}
            aria-valuetext={labels.loading}
            className="h-2 w-full overflow-hidden rounded-full bg-muted"
          />
          <p className={text} aria-live="polite" aria-atomic="true">
            {labels.loading}
          </p>
        </div>
      );
    }
    return null;
  }

  const { used } = usage;
  const unlimited = limit === "unlimited";
  const max = unlimited ? Math.max(used, 1) : Math.max(limit, 1);
  const now = Math.min(used, max);
  const percent = unlimited ? 0 : Math.round((now / max) * 100);
  const valueText = labels.usage({
    used,
    limit,
    limitKey,
    period: periodOf(catalog, limitKey),
  });

  return (
    <div className={outer}>
      <div
        role="progressbar"
        aria-valuenow={now}
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuetext={valueText}
        className="h-2 w-full overflow-hidden rounded-full bg-muted"
      >
        <div
          className={join("h-full bg-primary", barClassName)}
          style={{ width: `${percent}%` }}
        />
      </div>
      <p className={text} aria-live="polite" aria-atomic="true">
        {valueText}
      </p>
    </div>
  );
}
