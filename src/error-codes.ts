import { defineErrorCodes } from "better-auth";

/**
 * Every error code entitlements answers with. Endpoints throw them with
 * `APIError.from(status, ENTITLEMENTS_ERROR_CODES.X)`.
 * `ORGANIZATION_PLUGIN_REQUIRED` is also thrown at boot (from `init`) as a
 * plain `Error` whose message contains the code.
 */
export const ENTITLEMENTS_ERROR_CODES = defineErrorCodes({
  ORGANIZATION_PLUGIN_REQUIRED:
    "Entitlements needs the better-auth organization plugin installed",
  NOT_ALLOWED: "You are not allowed to do this",
  SESSION_NOT_ACCEPTED: "This session can't be used for entitlements",
  UNKNOWN_KEY: "Unknown feature, limit or plan key",
  INVALID_OVERRIDE: "Invalid override",
  OVERRIDE_NOT_FOUND: "Override not found",
  ORGANIZATION_NOT_FOUND: "Organization not found",
  ENTITLEMENTS_UNAVAILABLE: "Entitlements are unavailable right now",
  // beyond the PRD list: the 400 of `listEntitlementOverrides` for a
  // malformed cursor or a page past the tie bound
  INVALID_CURSOR: "Invalid cursor",
});

export type EntitlementsErrorCode = keyof typeof ENTITLEMENTS_ERROR_CODES;
