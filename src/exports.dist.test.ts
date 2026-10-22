import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

// PRD #5/#6 (dist half): the built package exports exactly the public list
// (contracts "Final export lists"). Runs only under `pnpm test:dist`, and
// fails, never skips, when `dist/` is missing.

const dist = fileURLToPath(new URL("../dist", import.meta.url));
const require = createRequire(import.meta.url);

const EXPECTED = {
  ".": [
    "ENTITLEMENTS_ERROR_CODES",
    "ENTITLEMENTS_EVENT_TYPES",
    "createEntitlements",
    "defineEntitlements",
    "deleteOrganizationData",
    "entitlements",
    "entitlementsStatements",
    "exportEntitlementsData",
    "upgradeTo",
  ],
  "./catalog": ["defineEntitlements", "upgradeTo"],
  "./client": [
    "defineEntitlements",
    "entitlementsClient",
    "entitlementsStatements",
    "upgradeTo",
  ],
} as const;

const FILES = {
  ".": "index",
  "./catalog": "catalog",
  "./client": "client",
} as const;

/** Catalog helpers that stay internal to the package (contracts §2). */
const INTERNAL = [
  "validateCatalog",
  "isLimitValue",
  "planKeys",
  "canonicalPlanKey",
  "limitKind",
  "isFeatureKey",
  "planEntitlements",
  "MAX_CATALOG_KEYS",
  "PLAN_KEY_PATTERN",
  "entitlementsPathMethods",
];

const keysOf = (module: object) =>
  Object.keys(module)
    .filter((key) => key !== "default" && key !== "__esModule")
    .sort();

describe("dist exports", () => {
  it("dist/ exists (run pnpm build first)", () => {
    expect(
      existsSync(dist),
      `dist missing at ${dist}: run pnpm build first`,
    ).toBe(true);
  });

  for (const [subpath, file] of Object.entries(FILES) as [
    keyof typeof FILES,
    string,
  ][]) {
    const expected = [...EXPECTED[subpath]].sort();

    it(`${subpath}: the built ESM file exports exactly the final list`, async () => {
      const path = `${dist}/${file}.js`;
      expect(existsSync(path), `${path} missing: run pnpm build`).toBe(true);
      const module = await import(pathToFileURL(path).href);
      expect(keysOf(module)).toEqual(expected);
    });

    it(`${subpath}: the built CJS file exports exactly the final list`, () => {
      const path = `${dist}/${file}.cjs`;
      expect(existsSync(path), `${path} missing: run pnpm build`).toBe(true);
      expect(keysOf(require(path))).toEqual(expected);
    });

    it(`${subpath}: no internal catalog helper and no entitlementsPathMethods`, async () => {
      const esm = await import(pathToFileURL(`${dist}/${file}.js`).href);
      const cjs = require(`${dist}/${file}.cjs`);
      for (const name of INTERNAL) {
        expect(esm, `${name} on ${subpath} (ESM)`).not.toHaveProperty(name);
        expect(cjs, `${name} on ${subpath} (CJS)`).not.toHaveProperty(name);
      }
    });
  }

  it("the root and ./client share the same catalog helpers as ./catalog", async () => {
    const root = await import(pathToFileURL(`${dist}/index.js`).href);
    const catalog = await import(pathToFileURL(`${dist}/catalog.js`).href);
    const client = await import(pathToFileURL(`${dist}/client.js`).href);
    for (const name of ["defineEntitlements", "upgradeTo"] as const) {
      expect(typeof catalog[name]).toBe("function");
      expect(root[name]).toBe(catalog[name]);
      expect(client[name]).toBe(catalog[name]);
    }
  });
});
