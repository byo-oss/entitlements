import type { Where } from "better-auth";
import { APIError } from "better-auth/api";
import { findAll } from "./adapter";
import {
  canonicalPlanKey,
  isFeatureKey,
  isLimitValue,
  limitKind,
} from "./catalog";
import { ENTITLEMENTS_ERROR_CODES } from "./error-codes";
import { emit, entitlementsEvent } from "./events";
import { LIVE_OVERRIDE_LIMIT } from "./live-overrides";
import type { EntitlementsRuntime } from "./runtime";
import {
  decodeOverrideValue,
  type EntitlementOverrideRow,
  encodeOverrideValue,
  OVERRIDE_KINDS,
  type OverrideKind,
  type OverrideValue,
} from "./schema";
import { currentAdapter } from "./txn";
import type { EntitlementOverride } from "./types";

/** Longest override `reason`. */
export const MAX_REASON_LENGTH = 500;

const MODEL = "entitlementOverride";

/**
 * `setEntitlementOverride`'s body, as received: only `organizationId` is
 * checked (by the endpoint, before `requireOrgExists`); every other field
 * may be missing or of any type, and `validateOverride` refuses a bad one
 * with `INVALID_OVERRIDE`.
 */
export type OverrideInput = {
  organizationId: string;
  /** A kind other than `plan`, `feature` or `limit` is `INVALID_OVERRIDE`. */
  kind?: unknown;
  key?: unknown;
  /** Left out or `null` for a plan override. */
  value?: unknown;
  reason?: unknown;
  /** A `Date`, a date string, `null` or left out (no expiry). */
  expiresAt?: unknown;
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

// `_why` documents the rule at each call site; the answer is the plain code
const invalid = (_why: string) =>
  APIError.from("BAD_REQUEST", ENTITLEMENTS_ERROR_CODES.INVALID_OVERRIDE);

const isOverrideKind = (kind: unknown): kind is OverrideKind =>
  typeof kind === "string" &&
  (OVERRIDE_KINDS as readonly string[]).includes(kind);

// whether `key` is a key of the catalog for `kind`: a plan itself (not an
// alias), a feature, or a limit of any kind; own keys only
function isCatalogKey(
  rt: EntitlementsRuntime,
  kind: OverrideKind,
  key: string,
): boolean {
  if (key === "") return false;
  if (kind === "plan") return canonicalPlanKey(rt.catalog, key) === key;
  if (kind === "feature") return isFeatureKey(rt.catalog, key);
  return limitKind(rt.catalog, key) !== null;
}

function overrideValue(kind: OverrideKind, value: unknown): OverrideValue {
  if (kind === "plan") {
    if (value === undefined || value === null) return null;
    throw invalid("a plan override takes no value");
  }
  if (kind === "feature") {
    if (typeof value === "boolean") return value;
    throw invalid("a feature value must be true or false");
  }
  if (isLimitValue(value)) return value;
  throw invalid('a limit value must be a non-negative integer or "unlimited"');
}

function expiry(value: unknown, now: Date): Date | null {
  if (value === undefined || value === null) return null;
  const date =
    value instanceof Date
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? new Date(value)
        : null;
  if (!date || Number.isNaN(date.getTime())) {
    throw invalid("expiresAt must be a date");
  }
  if (date.getTime() <= now.getTime()) {
    throw invalid("expiresAt must be in the future");
  }
  return new Date(date.getTime());
}

/**
 * Checks an override against the catalog: `kind` is `plan`, `feature` or
 * `limit`; `key` is a plan, feature or limit key for its `kind` (a plan
 * alias is not a plan key); a feature value is a boolean, a limit value a
 * non-negative integer or `"unlimited"`, a plan value `null` or left out;
 * `expiresAt`, if given, parses and is after `now`; `reason` is 1–500
 * characters after trimming (the trimmed reason is kept). Otherwise 400
 * `INVALID_OVERRIDE`.
 */
export function validateOverride(
  rt: EntitlementsRuntime,
  input: OverrideInput,
  now: Date,
): ValidOverride {
  const { kind, key } = input;
  if (!isOverrideKind(kind)) {
    throw invalid('kind must be "plan", "feature" or "limit"');
  }
  if (typeof key !== "string" || !isCatalogKey(rt, kind, key)) {
    throw invalid(`"${String(key)}" isn't a ${kind} of the catalog`);
  }
  const value = overrideValue(kind, input.value);
  const expiresAt = expiry(input.expiresAt, now);
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (reason.length < 1 || reason.length > MAX_REASON_LENGTH) {
    throw invalid(`reason must be 1-${MAX_REASON_LENGTH} characters`);
  }
  return {
    organizationId: input.organizationId,
    kind,
    key,
    value,
    reason,
    expiresAt,
  };
}

/**
 * Creates an override through `currentAdapter`: first marks the current
 * live one `removed` (`removedBy` = actor, `endedAt` = now) — for `plan`
 * any active plan override of the organization, else the active row of
 * `(organizationId, kind, key)` — then creates the new row (`status:
 * "active"`, `permanent = expiresAt === null`, `createdBy` = actor). Clears
 * the cache entry and emits `entitlements.override.set` (actor = the staff
 * user). Joins the caller's transaction; the event then fires after it
 * commits, never on a rollback.
 */
export async function setOverride(
  rt: EntitlementsRuntime,
  input: ValidOverride,
  actor: { userId: string },
): Promise<EntitlementOverrideRow> {
  const adapter = await currentAdapter(rt);
  const now = rt.now();
  const where: Where[] = [
    { field: "organizationId", value: input.organizationId },
    { field: "status", value: "active" },
    { field: "kind", value: input.kind },
    // one live plan override per organization, whatever its key
    ...(input.kind === "plan" ? [] : [{ field: "key", value: input.key }]),
  ];
  // every active match, not just one: a race can leave two
  const current = await findAll<EntitlementOverrideRow>(adapter, {
    model: MODEL,
    where,
    max: LIVE_OVERRIDE_LIMIT,
  });
  for (const row of current) {
    await adapter.update({
      model: MODEL,
      where: [
        { field: "id", value: row.id },
        { field: "status", value: "active" },
      ],
      update: { status: "removed", removedBy: actor.userId, endedAt: now },
    });
  }
  const created = await adapter.create<
    Omit<EntitlementOverrideRow, "id">,
    EntitlementOverrideRow
  >({
    model: MODEL,
    data: {
      organizationId: input.organizationId,
      status: "active",
      kind: input.kind,
      key: input.key,
      value: encodeOverrideValue(input.value),
      reason: input.reason,
      permanent: input.expiresAt === null,
      expiresAt: input.expiresAt,
      endedAt: null,
      createdBy: actor.userId,
      removedBy: null,
      createdAt: now,
    },
  });
  rt.cache.delete(input.organizationId);
  await emit(
    rt,
    entitlementsEvent("entitlements.override.set", {
      organizationId: input.organizationId,
      actorId: actor.userId,
      overrideId: created.id,
      data: {
        kind: input.kind,
        key: input.key,
        value: input.value,
        expiresAt: input.expiresAt,
      },
      occurredAt: rt.now(),
    }),
    adapter,
  );
  return created;
}

/**
 * Soft-deletes an active override: `status: "removed"`, `removedBy`,
 * `endedAt` = now; clears the cache entry; emits
 * `entitlements.override.removed`. Not found or not active → 404
 * `OVERRIDE_NOT_FOUND`. Returns the updated row. Joins the caller's
 * transaction; the event then fires after it commits.
 */
export async function removeOverride(
  rt: EntitlementsRuntime,
  id: string,
  actor: { userId: string },
): Promise<EntitlementOverrideRow> {
  const notFound = () =>
    APIError.from("NOT_FOUND", ENTITLEMENTS_ERROR_CODES.OVERRIDE_NOT_FOUND);
  const adapter = await currentAdapter(rt);
  const row = await adapter.findOne<EntitlementOverrideRow>({
    model: MODEL,
    where: [{ field: "id", value: id }],
  });
  if (row?.status !== "active") throw notFound();
  const now = rt.now();
  // guarded by status, so a concurrent remove or expiry wins cleanly
  const updated = await adapter.update<EntitlementOverrideRow>({
    model: MODEL,
    where: [
      { field: "id", value: id },
      { field: "status", value: "active" },
    ],
    update: { status: "removed", removedBy: actor.userId, endedAt: now },
  });
  if (!updated) throw notFound();
  rt.cache.delete(row.organizationId);
  await emit(
    rt,
    entitlementsEvent("entitlements.override.removed", {
      organizationId: row.organizationId,
      actorId: actor.userId,
      overrideId: row.id,
      data: { kind: row.kind, key: row.key },
      occurredAt: rt.now(),
    }),
    adapter,
  );
  return updated;
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
