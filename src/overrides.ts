// BYO_STUB: N05 replaces this file (contracts.md "overrides.ts")
import { APIError } from "better-auth/api";
import { ENTITLEMENTS_ERROR_CODES } from "./error-codes";
import type { EntitlementsRuntime } from "./runtime";
import {
  decodeOverrideValue,
  type EntitlementOverrideRow,
  type OverrideKind,
  type OverrideValue,
} from "./schema";
import type { EntitlementOverride } from "./types";

/** Longest override `reason`. */
export const MAX_REASON_LENGTH = 500;

/** `setEntitlementOverride`'s body, as received (`kind` unchecked). */
export type OverrideInput = {
  organizationId: string;
  /** Any string: a kind other than `plan`, `feature` or `limit` is `INVALID_OVERRIDE`. */
  kind: string;
  key: string;
  value?: unknown;
  reason: string;
  expiresAt?: Date | string | null;
};

/** An override that passed `validateOverride`. */
export type ValidOverride = {
  organizationId: string;
  kind: OverrideKind;
  key: string;
  /** plan → null, feature → boolean, limit → integer or `"unlimited"`. */
  value: OverrideValue;
  reason: string;
  expiresAt: Date | null;
};

/**
 * Checks an override against the catalog: `kind` is `plan`, `feature` or
 * `limit`; `key` is a plan, feature or limit key for its `kind`; a feature value is a boolean, a limit value a
 * non-negative integer or `"unlimited"`, a plan value null/absent;
 * `expiresAt`, if given, parses and is after `now`; `reason` is 1–500
 * characters after trimming. Otherwise 400 `INVALID_OVERRIDE`.
 * Stub: always 400.
 */
export function validateOverride(
  _rt: EntitlementsRuntime,
  _input: OverrideInput,
  _now: Date,
): ValidOverride {
  throw APIError.from("BAD_REQUEST", ENTITLEMENTS_ERROR_CODES.INVALID_OVERRIDE);
}

/**
 * Creates an override through `currentAdapter`: first marks the current
 * live one `removed` (`removedBy` = actor, `endedAt` = now) — for `plan`
 * any active plan override of the organization, else the active row of
 * `(organizationId, kind, key)` — then creates the new row (`status:
 * "active"`, `permanent = expiresAt === null`, `createdBy` = actor). Clears
 * the cache entry and emits `entitlements.override.set` (actor = the staff
 * user). Joins the caller's transaction. Stub: 403 `NOT_ALLOWED`.
 */
export async function setOverride(
  _rt: EntitlementsRuntime,
  _input: ValidOverride,
  _actor: { userId: string },
): Promise<EntitlementOverrideRow> {
  throw APIError.from("FORBIDDEN", ENTITLEMENTS_ERROR_CODES.NOT_ALLOWED);
}

/**
 * Soft-deletes an active override: `status: "removed"`, `removedBy`,
 * `endedAt` = now; clears the cache entry; emits
 * `entitlements.override.removed`. Not found or not active → 404
 * `OVERRIDE_NOT_FOUND`. Returns the updated row. Stub: 404.
 */
export async function removeOverride(
  _rt: EntitlementsRuntime,
  _id: string,
  _actor: { userId: string },
): Promise<EntitlementOverrideRow> {
  throw APIError.from("NOT_FOUND", ENTITLEMENTS_ERROR_CODES.OVERRIDE_NOT_FOUND);
}

/** A row as the staff endpoints return it (value decoded). */
export function toPublicOverride(
  row: EntitlementOverrideRow,
): EntitlementOverride {
  return {
    id: row.id,
    organizationId: row.organizationId,
    status: row.status,
    kind: row.kind,
    key: row.key,
    value: decodeOverrideValue(row.kind, row.value) ?? null,
    reason: row.reason,
    expiresAt: row.expiresAt ?? null,
    endedAt: row.endedAt ?? null,
    createdBy: row.createdBy ?? null,
    removedBy: row.removedBy ?? null,
    createdAt: row.createdAt,
  };
}
