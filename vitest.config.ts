import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}"],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/*.sql.test.ts",
      "**/*.stripe.test.ts",
      "**/*.dist.test.ts",
    ],
    env: {
      BYO_EXPECT_BA: "1.7.12",
      BYO_ROOT_BA: "1.7.12",
    },
  },
});
