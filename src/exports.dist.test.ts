// BYO_STUB: N13 replaces this file (contracts.md "exports.dist.test.ts")
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";

const dist = fileURLToPath(new URL("../dist", import.meta.url));

describe("dist exports", () => {
  it("checks the built package", () => {
    if (!existsSync(dist)) {
      throw new Error("dist missing: run pnpm build first");
    }
    throw new Error("stub not yet replaced by N13");
  });
});
