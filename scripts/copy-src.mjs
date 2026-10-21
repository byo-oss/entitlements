#!/usr/bin/env node
/**
 * Prepares the floor lane: copies `src/` to `tests/min/src/` so the same
 * tests run against the pinned 1.7.7 set. Files that carry the line
 * `// lane: latest-only` are skipped. Every better-auth import in the copy
 * must resolve to a package pinned in `tests/min/package.json`; otherwise the
 * lane would silently load the root's newer copy.
 *
 *   node scripts/copy-src.mjs
 *   node scripts/copy-src.mjs --self-test
 */

import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SKIP_MARKER = /^\/\/ lane: latest-only[ \t]*$/m;
const GUARDED = /^(better-auth|@better-auth\/[^/]+|better-call)/;

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^[ \t]*\/\/.*$/gm, "");
}

/** Bare import specifiers of a source file, comments ignored. */
export function specifiersOf(text) {
  const code = stripComments(text);
  const found = new Set();
  const patterns = [
    /\b(?:import|export)\b[^"'`;]*?\bfrom\s*["']([^"']+)["']/g,
    /\bimport\s*["']([^"']+)["']/g,
    /\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\bvi\.(?:mock|doMock|importActual|importMock)\s*\(\s*["']([^"']+)["']/g,
  ];
  for (const re of patterns) {
    for (const m of code.matchAll(re)) found.add(m[1]);
  }
  return [...found];
}

function packageName(spec) {
  const parts = spec.split("/");
  return spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

function copySrc(root) {
  const src = join(root, "src");
  const dest = join(root, "tests", "min", "src");
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  let copied = 0;
  let skipped = 0;
  for (const file of walk(src)) {
    const rel = file.slice(src.length + 1);
    if (
      /\.(ts|tsx)$/.test(file) &&
      SKIP_MARKER.test(readFileSync(file, "utf8"))
    ) {
      skipped++;
      continue;
    }
    const target = join(dest, rel);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(file, target);
    copied++;
  }
  return { dest, copied, skipped };
}

function unpinned(root, dest) {
  const pkg = JSON.parse(
    readFileSync(join(root, "tests", "min", "package.json"), "utf8"),
  );
  const pinned = new Set([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
  ]);
  const bad = [];
  for (const file of walk(dest)) {
    if (!/\.(ts|tsx)$/.test(file)) continue;
    for (const spec of specifiersOf(readFileSync(file, "utf8"))) {
      if (spec.startsWith(".") || spec.startsWith("/")) continue;
      if (!GUARDED.test(spec)) continue;
      const name = packageName(spec);
      if (!pinned.has(name))
        bad.push({ file: file.slice(dest.length + 1), spec, name });
    }
  }
  return bad;
}

function run(root) {
  const { dest, copied, skipped } = copySrc(root);
  const bad = unpinned(root, dest);
  if (bad.length > 0) {
    for (const b of bad) {
      console.error(
        `copy-src: ${b.file} imports "${b.spec}" but ${b.name} is not in tests/min/package.json`,
      );
    }
    process.exit(1);
  }
  console.log(
    `copy-src: ${copied} files copied, ${skipped} latest-only skipped`,
  );
}

function selfTest() {
  const script = fileURLToPath(import.meta.url);
  const base = mkdtempSync(join(tmpdir(), "copy-src-"));
  const failures = [];
  const fixture = (name, files) => {
    const root = join(base, name);
    mkdirSync(join(root, "tests", "min"), { recursive: true });
    writeFileSync(
      join(root, "tests", "min", "package.json"),
      JSON.stringify({
        devDependencies: { "better-auth": "1.7.7", vitest: "4" },
      }),
    );
    for (const [rel, text] of Object.entries(files)) {
      const full = join(root, "src", rel);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, text);
    }
    return root;
  };
  const exitOf = (root) =>
    spawnSync(process.execPath, [script], {
      env: { ...process.env, COPY_SRC_ROOT: root },
      encoding: "utf8",
    });
  const expect = (label, ok) => {
    console.log(`${ok ? "ok  " : "FAIL"} ${label}`);
    if (!ok) failures.push(label);
  };

  const bad = exitOf(
    fixture("bad", {
      "a.ts":
        'import { m } from "@better-auth/mongo-adapter";\nexport { m };\n',
    }),
  );
  expect("unpinned @better-auth/mongo-adapter exits 1", bad.status === 1);
  expect(
    "unpinned import is named",
    bad.stderr.includes("@better-auth/mongo-adapter"),
  );

  const badSub = exitOf(
    fixture("bad-subpath", {
      "a.ts": 'const x = await import("better-call/node");\nexport { x };\n',
    }),
  );
  expect("unpinned better-call subpath exits 1", badSub.status === 1);

  const root = fixture("clean", {
    "a.ts": [
      'import { betterAuth } from "better-auth/plugins/organization";',
      'import { z } from "zod";',
      'import { b } from "./b";',
      '// import { x } from "@better-auth/mongo-adapter";',
      "export { betterAuth, z, b };",
      "",
    ].join("\n"),
    "b.ts": "export const b = 1;\n",
    "latest.ts":
      '// lane: latest-only\nimport { s } from "@better-auth/stripe";\nexport { s };\n',
    "nested/c.ts": "export const c = 2;\n",
  });
  const clean = exitOf(root);
  expect("clean fixture exits 0", clean.status === 0);
  expect(
    "latest-only file is not copied",
    !existsSync(join(root, "tests", "min", "src", "latest.ts")),
  );
  expect(
    "other files are copied, nested too",
    existsSync(join(root, "tests", "min", "src", "a.ts")) &&
      existsSync(join(root, "tests", "min", "src", "nested", "c.ts")),
  );

  rmSync(base, { recursive: true, force: true });
  if (failures.length > 0) {
    console.error(`copy-src self-test: ${failures.length} failure(s)`);
    process.exit(1);
  }
  console.log("copy-src self-test: ok");
}

if (process.argv.includes("--self-test")) selfTest();
else
  run(
    process.env.COPY_SRC_ROOT ??
      resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  );
