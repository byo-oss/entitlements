#!/usr/bin/env node
/**
 * After `pnpm build`: loads every `exports` entry the way a consumer does,
 * through the package's own name, with `import()` and `require()`, and checks
 * each `types` file exists. `./testing` is ESM only (vitest throws when it is
 * require()d), so it must not offer `require` and `require()` must fail.
 *
 *   node scripts/check-exports.mjs
 *   node scripts/check-exports.mjs --self-test   (parses package.json only)
 */

import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const ESM_ONLY = new Set(["./testing"]);
const EXPECTED = [
  ".",
  "./catalog",
  "./client",
  "./react",
  "./stripe",
  "./testing",
];

/** Static problems with the exports map, and the entries to load. */
function parseExports() {
  const problems = [];
  const entries = [];
  const map = pkg.exports;
  if (!map || typeof map !== "object") {
    return { problems: ["package.json has no exports map"], entries };
  }
  for (const key of EXPECTED) {
    if (!(key in map)) problems.push(`exports is missing "${key}"`);
  }
  for (const [key, value] of Object.entries(map)) {
    if (typeof value !== "object" || value === null) {
      problems.push(`exports["${key}"] must be a conditions object`);
      continue;
    }
    if (!value.types) problems.push(`exports["${key}"] has no types`);
    if (!value.import) problems.push(`exports["${key}"] has no import`);
    if (ESM_ONLY.has(key)) {
      if ("require" in value)
        problems.push(`exports["${key}"] must not offer require`);
    } else if (!value.require) {
      problems.push(`exports["${key}"] has no require`);
    }
    entries.push({ key, ...value });
  }
  return { problems, entries };
}

async function main() {
  const { problems, entries } = parseExports();
  if (process.argv.includes("--self-test")) {
    if (problems.length > 0) {
      for (const p of problems) console.error(`FAIL ${p}`);
      process.exit(1);
    }
    console.log(
      `check-exports self-test: ok (${entries.length} entries: ${entries.map((e) => e.key).join(", ")})`,
    );
    return;
  }

  const failures = [...problems];
  const require = createRequire(join(root, "noop.js"));
  for (const entry of entries) {
    const spec =
      entry.key === "." ? pkg.name : `${pkg.name}/${entry.key.slice(2)}`;
    if (entry.types && !existsSync(join(root, entry.types))) {
      failures.push(`${entry.key}: types file ${entry.types} does not exist`);
    }
    try {
      await import(spec);
    } catch (error) {
      failures.push(`${entry.key}: import() failed: ${error.message}`);
    }
    if (ESM_ONLY.has(entry.key)) {
      try {
        require(spec);
        failures.push(
          `${entry.key}: require() succeeded but the entry is ESM only`,
        );
      } catch (error) {
        if (error.code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") {
          failures.push(
            `${entry.key}: require() failed with ${error.code ?? error.message}, expected ERR_PACKAGE_PATH_NOT_EXPORTED`,
          );
        }
      }
    } else {
      try {
        require(spec);
      } catch (error) {
        failures.push(`${entry.key}: require() failed: ${error.message}`);
      }
    }
  }
  if (failures.length > 0) {
    for (const f of failures) console.error(`FAIL ${f}`);
    process.exit(1);
  }
  console.log(`check-exports: ok (${entries.length} entries)`);
}

await main();
