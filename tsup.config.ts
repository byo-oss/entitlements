import { defineConfig } from "tsup";

const external = [
  "react",
  "better-auth",
  "better-call",
  "zod",
  "@byo-oss/core",
  "@better-auth/stripe",
  "stripe",
  "vitest",
];

export default defineConfig([
  {
    entry: {
      index: "src/index.ts",
      // the public catalog API only (catalog.ts also holds internal helpers)
      catalog: "src/catalog-entry.ts",
      client: "src/client.ts",
      "stripe/index": "src/stripe/index.ts",
    },
    format: ["esm", "cjs"],
    dts: true,
    // clean is done in the build script: with parallel configs, tsup's
    // own clean races the other config's output and can delete emitted files
    clean: false,
    external,
  },
  {
    // ESM only: vitest throws when it's require()d
    entry: { testing: "src/testing.ts" },
    format: ["esm"],
    dts: true,
    clean: false,
    external,
  },
  {
    entry: {
      "react/index": "src/react/index.ts",
    },
    format: ["esm", "cjs"],
    dts: true,
    clean: false,
    external,
    banner: { js: '"use client";' },
  },
]);
