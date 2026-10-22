#!/usr/bin/env node
// PRD #28: the README follows SPEC §8.1 and carries every required section and fact.
// Usage: node scripts/check-readme.mjs [README.md] | --self-test
import { readFileSync } from "node:fs";

const DISCLAIMER =
  "Community plugin — not affiliated with the better-auth team.";

// SPEC §8.1 order (pitch first, then these); other sections may sit between them.
const ORDERED = [
  "Install",
  "Setup",
  "Options",
  "API",
  "Delivery guarantees",
  "What this is not (yet)",
];
// Required anywhere (PRD #28 and the design sections the README documents).
const REQUIRED_HEADINGS = [
  "Schema",
  "Freshness",
  "Inside a transaction",
  "Outgrowing this",
  "Export",
  "Uninstall",
  "Community adapters",
];
const REQUIRED_STRINGS = [
  ["options table header", /^\|\s*Option\s*\|/m],
  ["API table with a kind column", /^\|[^\n]*\bKind\b[^\n]*\|/m],
  ["incrementOne adapter notes", /incrementOne/],
  ["cache staleness bound", /cacheTtlMs/],
  [
    "MongoDB index requirement",
    /MongoDB[\s\S]{0,400}entitlementSnapshot\.organizationId[\s\S]{0,400}entitlementUsage\.bucket|MongoDB[\s\S]{0,400}entitlementUsage\.bucket[\s\S]{0,400}entitlementSnapshot\.organizationId/,
  ],
  [
    "GET endpoint list",
    /GET[\s\S]{0,300}\/entitlements\/get[\s\S]{0,300}\/entitlements\/overrides/,
  ],
  ["staff list page size", /up to 50 per page/],
  ["Stripe Entitlements mapping", /Stripe Entitlements/],
  ["Autumn mapping", /Autumn/],
  ["Tailwind @source line", /@source/],
  ["community adapter naming", /byo-entitlements-/],
];

export function checkReadme(text) {
  const errors = [];
  const lines = text.split("\n");
  const headings = lines
    .map((l, i) => ({ m: /^##\s+(.+?)\s*$/.exec(l), i }))
    .filter((h) => h.m)
    .map((h) => ({ title: h.m[1], line: h.i }));
  const find = (name) =>
    headings.find(
      (h) =>
        h.title === name ||
        h.title.startsWith(`${name} `) ||
        h.title.startsWith(`${name}:`),
    );
  if (!/^#\s+\S/.test(lines[0] ?? ""))
    errors.push("first line must be the `# ` title");
  const top = lines.slice(0, 20).join("\n");
  if (!top.includes(DISCLAIMER))
    errors.push(
      `disclaimer (SPEC 1.4) not in the first 20 lines: "${DISCLAIMER}"`,
    );
  let last = -1;
  for (const name of ORDERED) {
    const h = find(name);
    if (!h) {
      errors.push(`missing section "## ${name}"`);
      continue;
    }
    if (h.line < last)
      errors.push(`section "## ${name}" is out of SPEC §8.1 order`);
    last = Math.max(last, h.line);
  }
  for (const name of REQUIRED_HEADINGS)
    if (!find(name)) errors.push(`missing section "## ${name}"`);
  for (const [label, re] of REQUIRED_STRINGS)
    if (!re.test(text)) errors.push(`missing: ${label}`);
  return errors;
}

function selfTest() {
  const good = [
    "# @byo-oss/entitlements",
    "",
    "Plans, features and limits for better-auth apps.",
    "",
    `> ${DISCLAIMER}`,
    "## Install",
    "## Setup",
    "1. a",
    "## Options",
    "| Option | Default |",
    "## API",
    "| Endpoint | Kind |",
    "GET endpoints: `/entitlements/get`, `/entitlements/overrides`. Staff list: up to 50 per page.",
    "## Schema",
    "## Freshness",
    "cacheTtlMs bounds staleness. incrementOne is atomic.",
    "## Inside a transaction",
    "## Delivery guarantees",
    "## Outgrowing this",
    "Stripe Entitlements, Autumn.",
    "## Export",
    "## Uninstall",
    "MongoDB: create entitlementSnapshot.organizationId and entitlementUsage.bucket.",
    "## Community adapters",
    "byo-entitlements-<provider>. `@source`.",
    "## What this is not (yet)",
  ].join("\n");
  const cases = [
    ["valid README passes", good, 0],
    ["missing disclaimer fails", good.replace(DISCLAIMER, "x"), 1],
    ["missing section fails", good.replace("## Uninstall", "## Removal"), 1],
    [
      "out of order fails",
      good
        .replace("## Install", "## Placeholder")
        .replace(
          "## What this is not (yet)",
          "## What this is not (yet)\n## Install",
        ),
      1,
    ],
    ["missing MongoDB note fails", good.replace("MongoDB:", "Mongo:"), 1],
  ];
  let ok = true;
  for (const [name, text, expectErrors] of cases) {
    const n = checkReadme(text).length;
    const pass = expectErrors === 0 ? n === 0 : n > 0;
    console.log(
      `${pass ? "ok  " : "FAIL"} ${name}${pass ? "" : ` (${n} errors)`}`,
    );
    ok &&= pass;
  }
  console.log(
    ok ? "check-readme self-test: ok" : "check-readme self-test: FAILED",
  );
  process.exit(ok ? 0 : 1);
}

if (process.argv.includes("--self-test")) selfTest();
else {
  const file = process.argv[2] ?? "README.md";
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    console.error(`check-readme: ${file} not found`);
    process.exit(1);
  }
  const errors = checkReadme(text);
  for (const e of errors) console.error(`check-readme: ${e}`);
  console.log(
    errors.length
      ? `check-readme: ${errors.length} problem(s)`
      : "check-readme: ok",
  );
  process.exit(errors.length ? 1 : 0);
}
