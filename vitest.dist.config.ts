import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.dist.test.ts"],
    env: {
      BYO_EXPECT_BA: "1.7.16",
    },
  },
});
