/**
 * Proves a lane loaded the better-auth set it claims to. Every lane runs the
 * same tests against a different install (latest at the root, the 1.7.7 floor
 * in `tests/min`), so each version test starts here: a lane that resolved the
 * wrong packages fails loudly instead of passing for the wrong reason.
 */

import { getBetterAuthVersion } from "@better-auth/core/context";
import { stripe } from "@better-auth/stripe";
import { organization } from "better-auth/plugins/organization";

export function assertLoadedVersions(
  expected: string | undefined = process.env.BYO_EXPECT_BA,
  opts?: { stripe?: boolean },
): void {
  if (!expected) {
    throw new Error("assertLoadedVersions: no expected version");
  }
  const loaded: Record<string, string> = {
    "@better-auth/core (getBetterAuthVersion)": getBetterAuthVersion(),
    "better-auth (organization plugin)": organization().version,
  };
  if (opts?.stripe) {
    loaded["@better-auth/stripe"] = stripe({
      stripeClient: {} as never,
      stripeWebhookSecret: "test_secret",
    }).version;
  }
  const mismatches = Object.entries(loaded)
    .filter(([, actual]) => actual !== expected)
    .map(([name, actual]) => `${name} is ${actual}, expected ${expected}`);
  if (mismatches.length > 0) {
    throw new Error(`assertLoadedVersions: ${mismatches.join("; ")}`);
  }
}
