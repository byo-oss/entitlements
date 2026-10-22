#!/usr/bin/env node
/**
 * After `pnpm build`: follows the built chunks from each `exports` entry and
 * checks which packages they import. Only import/export statements count
 * (`import ... from`, `export ... from`, bare `import "x"`, `import()`,
 * `require()`), never comments or JSDoc. Subpaths reduce to package names
 * (`zod/v4/core` is `zod`); `node:` builtins, relative paths and the package's
 * own name are ignored.
 *
 *   1. entries reachable from "." import neither `stripe` nor `@better-auth/stripe`
 *   2. "./catalog" imports no bare specifier at all
 *   3. "./stripe" runtime files (.js/.cjs) do not import `@better-auth/stripe`
 *      (its .d.ts files may import the types)
 *   4. every bare specifier in any dist file is in dependencies or peerDependencies
 *
 *   node scripts/check-imports.mjs
 *   node scripts/check-imports.mjs --self-test   (fixtures, no build)
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { builtinModules } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DIST_FILE = /\.(?:js|cjs|mjs|d\.ts|d\.cts|d\.mts)$/;
const RUNTIME_FILE = /\.(?:js|cjs|mjs)$/;
const PROVIDER_SDKS = new Set(["stripe", "@better-auth/stripe"]);

/** Blanks comments, keeps strings (a `//` inside a string is not a comment). */
export function stripComments(text) {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    const next = text[i + 1];
    if (c === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (c === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end === -1 ? text.length : end + 2;
      out += text.slice(i, stop).replace(/[^\n]/g, " ");
      i = stop;
    } else if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < text.length && text[j] !== c) j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** Every module specifier named by an import/export/require in `text`. */
export function specifiersOf(text) {
  const code = stripComments(text);
  const found = new Set();
  const patterns = [
    /\b(?:import|export)\b[^"'`;]*?\bfrom\s*["']([^"']+)["']/g,
    /\bimport\s*["']([^"']+)["']/g,
    /\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const re of patterns) {
    for (const m of code.matchAll(re)) found.add(m[1]);
  }
  return [...found];
}

const BUILTINS = new Set(builtinModules);

/** Package name of a bare specifier, or null for relative, `node:` and builtins. */
export function bareName(spec, ownName) {
  if (spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("node:"))
    return null;
  const parts = spec.split("/");
  const name = spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
  if (BUILTINS.has(name) || name === ownName) return null;
  return name;
}

function walk(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

/** Candidate files for a relative specifier written in `from`. */
function resolveRelative(from, spec) {
  const base = resolve(dirname(from), spec);
  const candidates = [base];
  const swaps = { ".js": ".d.ts", ".cjs": ".d.cts", ".mjs": ".d.mts" };
  for (const [ext, dts] of Object.entries(swaps)) {
    if (base.endsWith(ext)) candidates.push(base.slice(0, -ext.length) + dts);
  }
  if (!/\.[a-z]+$/.test(base)) {
    candidates.push(
      `${base}.js`,
      `${base}.cjs`,
      `${base}.d.ts`,
      `${base}.d.cts`,
      join(base, "index.js"),
      join(base, "index.d.ts"),
    );
  }
  return candidates.filter((f) => existsSync(f) && statSync(f).isFile());
}

/** Files reachable from `start` by following relative specifiers. */
function reachable(start, cache) {
  const seen = new Set();
  const queue = [start];
  while (queue.length > 0) {
    const file = queue.pop();
    if (seen.has(file) || !existsSync(file)) continue;
    seen.add(file);
    for (const spec of cache(file)) {
      if (!spec.startsWith(".")) continue;
      for (const next of resolveRelative(file, spec)) queue.push(next);
    }
  }
  return seen;
}

/** Violations as { rule, file, spec } for the package at `root` (with a built dist/). */
export function check(root) {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const declared = new Set([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.peerDependencies ?? {}),
  ]);
  const violations = [];
  const memo = new Map();
  const specsOf = (file) => {
    if (!memo.has(file))
      memo.set(file, specifiersOf(readFileSync(file, "utf8")));
    return memo.get(file);
  };
  const bareOf = (file) =>
    specsOf(file)
      .map((s) => ({ spec: s, name: bareName(s, pkg.name) }))
      .filter((s) => s.name);
  const rel = (file) => file.slice(root.length + 1);

  const entryFiles = (key) => {
    const value = pkg.exports?.[key];
    if (!value) return [];
    return [value.types, value.import, value.require]
      .filter(Boolean)
      .map((p) => join(root, p));
  };
  const filesFor = (key) => {
    const files = new Set();
    for (const entry of entryFiles(key)) {
      if (!existsSync(entry)) {
        violations.push({
          rule: 0,
          file: rel(entry),
          spec: "entry file is missing",
        });
        continue;
      }
      for (const f of reachable(entry, specsOf)) files.add(f);
    }
    return files;
  };

  // rule 1: the root never imports a provider SDK
  for (const file of filesFor(".")) {
    for (const { spec, name } of bareOf(file)) {
      if (PROVIDER_SDKS.has(name))
        violations.push({ rule: 1, file: rel(file), spec });
    }
  }
  // rule 2: the catalog imports nothing
  for (const file of filesFor("./catalog")) {
    for (const { spec } of bareOf(file))
      violations.push({ rule: 2, file: rel(file), spec });
  }
  // rule 3: ./stripe has no runtime @better-auth/stripe import
  for (const file of filesFor("./stripe")) {
    if (!RUNTIME_FILE.test(file)) continue;
    for (const { spec, name } of bareOf(file)) {
      if (name === "@better-auth/stripe")
        violations.push({ rule: 3, file: rel(file), spec });
    }
  }
  // rule 4: every bare specifier is a declared dependency or peer
  for (const file of walk(join(root, "dist")).filter((f) =>
    DIST_FILE.test(f),
  )) {
    for (const { spec, name } of bareOf(file)) {
      if (!declared.has(name))
        violations.push({ rule: 4, file: rel(file), spec });
    }
  }
  return violations;
}

function selfTest() {
  const base = mkdtempSync(join(tmpdir(), "check-imports-"));
  const exportsMap = {};
  for (const [key, dir] of [
    [".", "index"],
    ["./catalog", "catalog"],
    ["./client", "client"],
    ["./react", "react/index"],
    ["./stripe", "stripe/index"],
    ["./testing", "testing"],
  ]) {
    exportsMap[key] = {
      types: `./dist/${dir}.d.ts`,
      import: `./dist/${dir}.js`,
      ...(key === "./testing" ? {} : { require: `./dist/${dir}.cjs` }),
    };
  }
  const pkg = {
    name: "@byo-oss/entitlements",
    exports: exportsMap,
    dependencies: { "@byo-oss/core": "^0.1.0" },
    peerDependencies: {
      "@better-auth/core": "^1.7.7",
      "better-auth": "^1.7.7",
      "better-call": "^1.4.0",
      "@better-auth/stripe": "^1.7.7",
      react: ">=18",
      zod: "^4.0.0",
    },
  };
  const clean = {
    "index.js":
      'import { z } from "zod/v4/core";\nimport { x } from "./chunk-A.js";\nexport { z, x };\n',
    "index.cjs": 'const { z } = require("zod");\nmodule.exports = { z };\n',
    "index.d.ts":
      'import { BetterAuthPlugin } from "better-auth";\nexport type P = BetterAuthPlugin;\n',
    "chunk-A.js":
      'import { createCore } from "@byo-oss/core";\nimport fs from "node:fs";\nexport const x = createCore(fs);\n',
    "catalog.js": "export const catalog = 1;\n",
    "catalog.cjs": "exports.catalog = 1;\n",
    "catalog.d.ts": "export declare const catalog = 1;\n",
    "client.js": 'import "better-auth/client";\n',
    "client.cjs": 'require("better-auth/client");\n',
    "client.d.ts":
      'import type { X } from "better-call";\nexport type Y = X;\n',
    "react/index.js": 'import { useState } from "react";\n',
    "react/index.cjs": 'require("react");\n',
    "react/index.d.ts": "export {};\n",
    "stripe/index.js": 'import { x } from "../chunk-A.js";\nexport { x };\n',
    "stripe/index.cjs":
      'const x = require("../chunk-A.js");\nmodule.exports = x;\n',
    "stripe/index.d.ts":
      'import type { StripePlugin } from "@better-auth/stripe";\nexport type S = StripePlugin;\n',
    "testing.js": 'export * from "./chunk-A.js";\n',
    "testing.d.ts": "export {};\n",
  };
  const cases = [
    {
      name: "clean build with a zod subpath and a type-only stripe .d.ts passes",
      files: {},
      rules: [],
    },
    {
      name: "JSDoc example importing a self subpath and an undeclared package is ignored",
      files: {
        "index.js":
          '/**\n * @example\n * import { stripe } from "@byo-oss/entitlements/stripe";\n * import x from "left-pad";\n */\n// import y from "stripe";\nimport { z } from "zod";\nexport { z };\n',
        "index.d.ts": '/** import("stripe") */\nexport {};\n',
      },
      rules: [],
    },
    {
      name: "rule 1: root imports stripe",
      files: {
        "index.js": 'import Stripe from "stripe";\nexport { Stripe };\n',
      },
      rules: [1, 4],
    },
    {
      name: "rule 1: root reaches @better-auth/stripe through a chunk",
      files: {
        "chunk-A.js":
          'import { stripe } from "@better-auth/stripe";\nexport const x = stripe;\n',
      },
      rules: [1, 3],
    },
    {
      name: "rule 2: catalog imports a bare specifier",
      files: {
        "catalog.js": 'import { z } from "zod";\nexport const catalog = z;\n',
      },
      rules: [2],
    },
    {
      name: "rule 2: catalog .d.ts imports a bare specifier",
      files: {
        "catalog.d.ts":
          'import type { z } from "zod";\nexport type C = z.ZodType;\n',
      },
      rules: [2],
    },
    {
      name: "rule 3: stripe .js imports @better-auth/stripe",
      files: {
        "stripe/index.js":
          'import { stripe } from "@better-auth/stripe";\nexport { stripe };\n',
      },
      rules: [3],
    },
    {
      name: "rule 3: stripe .cjs requires @better-auth/stripe",
      files: {
        "stripe/index.cjs":
          'module.exports = require("@better-auth/stripe");\n',
      },
      rules: [3],
    },
    {
      name: "rule 4: undeclared package",
      files: { "client.js": 'import l from "left-pad";\nexport { l };\n' },
      rules: [4],
    },
    {
      name: "a declared peer's subpath (@better-auth/core/context) passes",
      files: {
        "chunk-A.js":
          'import { queueAfterTransactionHook } from "@better-auth/core/context";\nexport const x = queueAfterTransactionHook;\n',
      },
      rules: [],
    },
    {
      name: "rule 4: an undeclared @better-auth package at runtime",
      files: {
        "client.js":
          'import { x } from "@better-auth/memory-adapter";\nexport { x };\n',
      },
      rules: [4],
    },
    {
      name: "multi-line and minified imports are seen",
      files: {
        "client.js": 'import {\n  a,\n  b,\n} from "left-pad";\nexport{a,b};\n',
        "react/index.js": 'export*from"left-pad2";\n',
      },
      rules: [4, 4],
    },
  ];
  const failures = [];
  cases.forEach((c, n) => {
    const root = join(base, `case-${n}`);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify(pkg));
    for (const [file, text] of Object.entries({ ...clean, ...c.files })) {
      const full = join(root, "dist", file);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, text);
    }
    const got = check(root).map((v) => v.rule);
    const ok =
      JSON.stringify([...got].sort()) === JSON.stringify([...c.rules].sort());
    console.log(
      `${ok ? "ok  " : "FAIL"} ${c.name}${ok ? "" : ` (rules ${JSON.stringify(got)}, expected ${JSON.stringify(c.rules)})`}`,
    );
    if (!ok) failures.push(c.name);
  });
  rmSync(base, { recursive: true, force: true });
  if (failures.length > 0) {
    console.error(`check-imports self-test: ${failures.length} failure(s)`);
    process.exit(1);
  }
  console.log("check-imports self-test: ok");
}

if (process.argv.includes("--self-test")) {
  selfTest();
} else {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  if (!existsSync(join(root, "dist"))) {
    console.error("check-imports: dist/ does not exist, run pnpm build first");
    process.exit(1);
  }
  const violations = check(root);
  if (violations.length > 0) {
    for (const v of violations)
      console.error(`FAIL rule ${v.rule}: ${v.file} imports "${v.spec}"`);
    process.exit(1);
  }
  console.log("check-imports: ok");
}
