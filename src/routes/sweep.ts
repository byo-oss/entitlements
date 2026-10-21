// BYO_STUB: N07 replaces this file (contracts.md "routes/sweep.ts")
import { createAuthEndpoint } from "better-auth/api";
import * as z from "zod";
import type { EntitlementsRuntime } from "../runtime";
import { runSync } from "../sync";

/**
 * `processEntitlementsSync`: `createAuthEndpoint.serverOnly` (no path),
 * returns `runSync(rt)`. Call it from a cron
 * (`auth.api.processEntitlementsSync()`), again while `hasMore` is true.
 */
export function sweepEndpoints(rt: EntitlementsRuntime) {
  return {
    processEntitlementsSync: createAuthEndpoint.serverOnly(
      {
        method: "POST",
        body: z.object({}).optional(),
      },
      async () => runSync(rt),
    ),
  };
}
