#!/usr/bin/env node
/**
 * Docs samples compile: every ```ts / ```tsx block in README.md, AGENTS.md,
 * llms.txt, skills/**\/SKILL.md and the byo.dev pages in docs/*.mdx must
 * typecheck when pasted, imports included (no shorthand, no fragments).
 *
 * Each block is written to a scratch directory under the OS temp dir and
 * checked with tsc (strict) against the package's built types:
 * `@byo-oss/entitlements*` resolves to ./dist, everything else to this
 * repo's node_modules. Run `pnpm build` first.
 *
 * Files per document form one small project. A block whose fence has a
 * `title="lib/catalog.ts"` (how docs/*.mdx names files; the site shows it as
 * the block's tab), or whose first line is a path comment
 * (`// lib/catalog.ts`, how the README does it), is written at that path, so
 * a later block can `import { catalog } from "./catalog"`. Other blocks
 * stand alone.
 *
 * Each docs/*.mdx page is its own project, seeded with the named files of
 * docs/quickstart.mdx (`lib/catalog.ts`, `lib/auth.ts`, `lib/gate.ts`, …),
 * so any page can import them. A page's own block at the same path wins.
 *
 * A block tagged ```ts nocheck is skipped. Use it sparingly, only for an
 * illustrative fragment, and say why in a `// nocheck: <reason>` comment line
 * inside the block. On byo.dev that comment line is shown, so prefer a
 * complete block in docs/*.mdx.
 *
 *   node scripts/check-docs-samples.mjs
 *   node scripts/check-docs-samples.mjs --keep       (keep the scratch dir)
 *   node scripts/check-docs-samples.mjs --self-test  (extractor fixtures, no build)
 */

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, posix, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Subpath -> built types, for the package's own name.
const SELF_TYPES = {
  "@byo-oss/entitlements": "dist/index.d.ts",
  "@byo-oss/entitlements/catalog": "dist/catalog.d.ts",
  "@byo-oss/entitlements/client": "dist/client.d.ts",
  "@byo-oss/entitlements/react": "dist/react/index.d.ts",
  "@byo-oss/entitlements/stripe": "dist/stripe/index.d.ts",
  "@byo-oss/entitlements/testing": "dist/testing.d.ts",
};

/** The docs page whose named files seed every other page's project. */
const QUICKSTART = "docs/quickstart.mdx";

/** Documents to scan, relative to the repo root. */
function documents(root) {
  const docs = ["README.md", "AGENTS.md", "llms.txt"];
  const skills = join(root, "skills");
  if (existsSync(skills)) {
    for (const entry of readdirSync(skills, { recursive: true })) {
      if (basename(String(entry)) === "SKILL.md") {
        docs.push(posix.join("skills", String(entry).split("\\").join("/")));
      }
    }
  }
  const pages = join(root, "docs");
  if (existsSync(pages)) {
    for (const entry of readdirSync(pages).sort()) {
      if (entry.endsWith(".mdx")) docs.push(posix.join("docs", entry));
    }
  }
  return docs.filter((doc) => existsSync(join(root, doc)));
}

/**
 * The ```ts and ```tsx blocks of a Markdown-ish text. `line` is the 1-based
 * line of the first code line, `code` is de-indented by the fence's indent.
 */
export function extractBlocks(text) {
  const blocks = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const open = /^(\s*)```(tsx?)\b(.*)$/.exec(lines[i] ?? "");
    if (!open) continue;
    const indent = (open[1] ?? "").length;
    const lang = open[2] ?? "ts";
    const info = (open[3] ?? "").trim().split(/\s+/);
    const body = [];
    let j = i + 1;
    for (; j < lines.length; j++) {
      const line = lines[j] ?? "";
      if (line.trim() === "```") break;
      body.push(
        line.slice(Math.min(indent, line.length - line.trimStart().length)),
      );
    }
    if (j >= lines.length) {
      throw new Error(`unclosed \`\`\`${lang} block opened on line ${i + 1}`);
    }
    blocks.push({
      lang,
      line: i + 2,
      code: body.join("\n"),
      info: (open[3] ?? "").trim(),
      nocheck: info.includes("nocheck"),
    });
    i = j;
  }
  return blocks;
}

/** A relative `.ts`/`.tsx` path inside the scratch project, or null. */
function safePath(path) {
  if (!path || path.startsWith("/") || path.split("/").includes("..")) {
    return null;
  }
  return path;
}

/** `// lib/catalog.ts` on the first line names the block's file. */
export function pathComment(code) {
  const m = /^\/\/\s*((?:[\w.-]+\/)*[\w.-]+\.tsx?)\b/.exec(
    code.split("\n")[0] ?? "",
  );
  return safePath(m?.[1]);
}

/** `title="lib/catalog.ts"` in a fence's info string names the block's file. */
export function titlePath(info) {
  const m = /title="([^"]+)"/.exec(info ?? "");
  const title = m?.[1];
  if (!title || !/^(?:[\w.-]+\/)*[\w.-]+\.tsx?$/.test(title)) return null;
  return safePath(title);
}

/** The file a block is written at, if it names one: its title, else its path comment. */
export function blockPath(block) {
  return titlePath(block.info) ?? pathComment(block.code);
}

const slug = (doc) => doc.replace(/[^\w]+/g, "-").replace(/^-|-$/g, "");

function selfTest() {
  const text = [
    "# t",
    "```ts",
    "// lib/a.ts",
    "export const a = 1",
    "```",
    "- item",
    "  ```tsx nocheck",
    "  // nocheck: fragment",
    "  <A />",
    "  ```",
    "```css",
    "a {}",
    "```",
    '```ts title="lib/auth.ts"',
    "export const b = 2",
    "```",
    '```ts title="../x.ts"',
    "export const c = 3",
    "```",
  ].join("\n");
  const blocks = extractBlocks(text);
  const checks = [
    ["finds ts and tsx blocks only", blocks.length === 4],
    ["first block starts on its first code line", blocks[0]?.line === 3],
    [
      "path comment names the file",
      pathComment(blocks[0]?.code ?? "") === "lib/a.ts",
    ],
    ["nocheck is read from the info string", blocks[1]?.nocheck === true],
    [
      "indented fences are de-indented",
      blocks[1]?.code.startsWith("// nocheck") === true,
    ],
    ["a plain comment is not a path", pathComment("// not a path") === null],
    ["a parent path is refused", pathComment("// ../x.ts") === null],
    [
      "a fence title names the file",
      blockPath(blocks[2] ?? {}) === "lib/auth.ts",
    ],
    [
      "a title wins over a path comment",
      blockPath({ info: 'title="lib/b.ts"', code: "// lib/a.ts" }) ===
        "lib/b.ts",
    ],
    ["a parent path title is refused", blockPath(blocks[3] ?? {}) === null],
    [
      "a title that isn't a ts file names nothing",
      titlePath('title="terminal"') === null,
    ],
  ];
  let ok = true;
  for (const [name, pass] of checks) {
    console.log(`${pass ? "ok  " : "FAIL"} ${name}`);
    ok &&= pass;
  }
  console.log(
    ok
      ? "check-docs-samples self-test: ok"
      : "check-docs-samples self-test: FAILED",
  );
  process.exit(ok ? 0 : 1);
}

function main() {
  const keep = process.argv.includes("--keep");
  if (!existsSync(join(ROOT, "dist", "index.d.ts"))) {
    console.error(
      "check-docs-samples: dist/ is missing; run `pnpm build` first",
    );
    process.exit(1);
  }
  const tscJs = join(ROOT, "node_modules", "typescript", "lib", "tsc.js");
  if (!existsSync(tscJs)) {
    console.error(
      "check-docs-samples: typescript is not installed; run `pnpm install`",
    );
    process.exit(1);
  }

  const scratch = mkdtempSync(join(tmpdir(), "byo-docs-samples-"));
  // Bare imports (better-auth, react, stripe, …) resolve through this link.
  symlinkSync(join(ROOT, "node_modules"), join(scratch, "node_modules"), "dir");

  const problems = [];
  const origin = new Map(); // scratch file (posix, relative) -> { doc, line }
  const counts = new Map(); // doc -> { checked, skipped }
  let checked = 0;
  let skipped = 0;

  const write = (file, code, at) => {
    const target = join(scratch, ...file.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    // `export {}` makes a block without imports a module, so blocks never
    // share a global scope
    writeFileSync(target, `${code}\nexport {}\n`);
    origin.set(file, at);
  };

  const docs = documents(ROOT);
  // the quickstart's named files, written into every other page's project
  const seed = [];
  if (docs.includes(QUICKSTART)) {
    try {
      const text = readFileSync(join(ROOT, QUICKSTART), "utf8");
      const named = new Set();
      for (const block of extractBlocks(text)) {
        const rel = blockPath(block);
        if (block.nocheck || !rel || named.has(rel)) continue;
        named.add(rel);
        seed.push({ rel, code: block.code, line: block.line });
      }
    } catch {
      // reported below, when the quickstart itself is read
    }
  }

  for (const doc of docs) {
    let blocks;
    try {
      blocks = extractBlocks(readFileSync(join(ROOT, doc), "utf8"));
    } catch (error) {
      problems.push(`${doc}: ${error.message}`);
      continue;
    }
    const count = { checked: 0, skipped: 0 };
    counts.set(doc, count);
    const used = new Set();
    for (const block of blocks) {
      if (block.nocheck) {
        skipped++;
        count.skipped++;
        if (!/^\s*\/\/.*nocheck/m.test(block.code)) {
          problems.push(
            `${doc}:${block.line}: a nocheck block needs a "// nocheck: <why>" comment line inside it`,
          );
        }
        continue;
      }
      const ext = block.lang === "tsx" ? "tsx" : "ts";
      let rel = blockPath(block) ?? `snippets/line-${block.line}.${ext}`;
      if (used.has(rel))
        rel = rel.replace(/(\.tsx?)$/, `-line-${block.line}$1`);
      used.add(rel);
      write(posix.join(slug(doc), rel), block.code, { doc, line: block.line });
      checked++;
      count.checked++;
    }
    if (doc.startsWith("docs/") && doc !== QUICKSTART) {
      for (const file of seed) {
        if (used.has(file.rel)) continue; // the page's own block wins
        write(posix.join(slug(doc), file.rel), file.code, {
          doc: QUICKSTART,
          line: file.line,
        });
      }
    }
  }

  const paths = {
    "better-auth": [join(ROOT, "node_modules/better-auth/dist/index.d.mts")],
  };
  for (const [name, types] of Object.entries(SELF_TYPES)) {
    paths[name] = [join(ROOT, types)];
  }
  writeFileSync(
    join(scratch, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "Preserve",
        moduleResolution: "bundler",
        lib: ["ES2022", "DOM", "DOM.Iterable"],
        jsx: "react-jsx",
        strict: true,
        noUncheckedIndexedAccess: true,
        verbatimModuleSyntax: true,
        skipLibCheck: true,
        noEmit: true,
        esModuleInterop: true,
        forceConsistentCasingInFileNames: true,
        paths,
      },
      include: ["**/*.ts", "**/*.tsx"],
      exclude: ["node_modules"],
    }),
  );

  if (checked > 0) {
    const run = spawnSync(
      process.execPath,
      [tscJs, "-p", join(scratch, "tsconfig.json"), "--pretty", "false"],
      { cwd: scratch, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
    const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
    let lastOrigin = null;
    for (const raw of output.split("\n")) {
      if (!raw.trim()) continue;
      const m = /^(.+?)\((\d+),(\d+)\): (error TS\d+: .*)$/.exec(raw);
      const file = m
        ? relative(scratch, resolve(scratch, m[1] ?? ""))
            .split("\\")
            .join("/")
        : "";
      const at = origin.get(file);
      if (m && at) {
        lastOrigin = at;
        problems.push(`${at.doc}:${at.line + Number(m[2]) - 1}: ${m[4]}`);
      } else if (/^\s/.test(raw) && lastOrigin) {
        problems.push(`  ${raw.trim()}`); // a continuation of the last error
      } else {
        problems.push(raw);
      }
    }
    if (run.status !== 0 && problems.length === 0) {
      problems.push(`tsc exited ${run.status ?? run.signal} without output`);
    }
  }

  if (keep) console.error(`check-docs-samples: scratch kept at ${scratch}`);
  else rmSync(scratch, { recursive: true, force: true });

  // a seeded quickstart file fails once per page that imports it: report it once
  for (const problem of new Set(problems))
    console.error(`check-docs-samples: ${problem}`);
  for (const [doc, count] of counts) {
    console.log(
      `check-docs-samples:   ${doc}: ${count.checked} checked, ${count.skipped} skipped`,
    );
  }
  const summary = `${checked} block(s) checked, ${skipped} skipped (nocheck)`;
  if (problems.length > 0) {
    console.error(`check-docs-samples: FAILED, ${summary}`);
    process.exit(1);
  }
  console.log(`check-docs-samples: ok, ${summary}`);
}

if (process.argv.includes("--self-test")) selfTest();
else main();
