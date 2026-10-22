import { createEntitlements } from "@byo-oss/entitlements";
import { betterAuth } from "better-auth";
import { tanstackStartCookies } from "better-auth/tanstack-start";
import { authOptions } from "./auth-options.ts";
import { catalog } from "./catalog.ts";

export const auth = betterAuth({
  ...authOptions,
  // tanstackStartCookies goes last so it sees cookies the others set
  plugins: [...authOptions.plugins, tanstackStartCookies()],
});

/** The typed server API: methods take a plain organization id. */
export const entitlements = createEntitlements(auth, catalog);
