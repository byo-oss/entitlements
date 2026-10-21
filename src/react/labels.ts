// BYO_STUB: N11 replaces this file (contracts.md "react/labels.ts")

/** Every string `UsageMeter` renders, with English defaults. */
export type UsageMeterLabels = {
  /** The visible text and `aria-valuetext`, e.g. "920 of 1,000 API calls used today". */
  usage: (input: {
    used: number;
    limit: number | "unlimited";
    limitKey: string;
    period: "day" | "month" | "billing" | null;
  }) => string;
  /** Shown while loading. */
  loading: string;
  /** Shown when the hook has an error. */
  error: string;
};

/** The English defaults. Stub: empty strings. */
export const defaultLabels: UsageMeterLabels = {
  usage: () => "",
  loading: "",
  error: "",
};
