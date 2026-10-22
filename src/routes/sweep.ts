import { createAuthEndpoint } from "better-auth/api";
import * as z from "zod";
import type { EntitlementsRuntime } from "../runtime";
import { runSync } from "../sync";
import type { EntitlementsSweepResult } from "../types";

/**
 * `processEntitlementsSync`: `createAuthEndpoint.serverOnly` (no path, so
 * no HTTP route), returns `runSync(rt)`. Call it from a cron
 * (`auth.api.processEntitlementsSync()`), again while `hasMore` is true.
 */
export function sweepEndpoints(rt: EntitlementsRuntime) {
  return {
    processEntitlementsSync: createAuthEndpoint.serverOnly(
      {
        method: "POST",
        body: z.object({}).optional(),
      },
      async (): Promise<EntitlementsSweepResult> => runSync(rt),
    ),
  };
}
