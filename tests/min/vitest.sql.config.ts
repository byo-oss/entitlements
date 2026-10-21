import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.sql.test.ts"],
    // PGlite migration + seeding is slow when files run side by side
    testTimeout: 30_000,
    hookTimeout: 30_000,
    env: {
      BYO_EXPECT_BA: "1.7.7",
      BYO_ROOT_BA: "1.7.12",
    },
  },
});
