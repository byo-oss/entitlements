/** Every string `UsageMeter` renders, with English defaults. */
export type UsageMeterLabels = {
  /** The visible text and `aria-valuetext`, e.g. "920 of 1,000 API calls used today". */
  usage: (input: {
    used: number;
    limit: number | "unlimited";
    limitKey: string;
    /** The key's period from `UsageMeter`'s `catalog` prop; null without one. */
    period: "day" | "month" | "billing" | null;
  }) => string;
  /** Shown while loading. */
  loading: string;
  /** Shown when the hook has an error. */
  error: string;
};

const ACRONYMS = new Set([
  "ai",
  "api",
  "cdn",
  "id",
  "ip",
  "sms",
  "sso",
  "ui",
  "url",
]);

/** "apiCalls" → "API calls"; "uploads" → "uploads". */
function nameOf(limitKey: string): string {
  const words = limitKey
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .toLowerCase()
    .split(" ")
    .filter(Boolean)
    .map((word) => (ACRONYMS.has(word) ? word.toUpperCase() : word));
  return words.join(" ");
}

const PERIOD_TEXT = {
  day: "today",
  month: "this month",
  billing: "this billing period",
} as const;

const number = (value: number) => value.toLocaleString("en-US");

/** The English defaults. */
export const defaultLabels: UsageMeterLabels = {
  usage: ({ used, limit, limitKey, period }) => {
    const when = period === null ? "" : ` ${PERIOD_TEXT[period]}`;
    const name = nameOf(limitKey);
    return limit === "unlimited"
      ? `${number(used)} ${name} used${when} (unlimited)`
      : `${number(used)} of ${number(limit)} ${name} used${when}`;
  },
  loading: "Loading usage",
  error: "Usage unavailable",
};
