import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.stripe.test.ts"],
    env: {
      BYO_EXPECT_BA: "1.7.16",
      BYO_ROOT_BA: "1.7.16",
    },
  },
});
