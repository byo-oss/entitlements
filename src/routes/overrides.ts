import type { GenericEndpointContext, Where } from "better-auth";
import {
  APIError,
  createAuthEndpoint,
  sessionMiddleware,
} from "better-auth/api";
import * as z from "zod";
import {
  type EntitlementsRoute,
  requireOrgExists,
  requireStaff,
} from "../access";
import { ENTITLEMENTS_ERROR_CODES } from "../error-codes";
import {
  removeOverride,
  setOverride,
  toPublicOverride,
  validateOverride,
} from "../overrides";
import type { EntitlementsRuntime } from "../runtime";
import { type EntitlementOverrideRow, OVERRIDE_STATUSES } from "../schema";
import { currentAdapter } from "../txn";
import type {
  ListOverridesResponse,
  RemoveOverrideResponse,
  SetOverrideResponse,
} from "../types";

/** Overrides per `listEntitlementOverrides` page. */
export const OVERRIDES_PAGE_SIZE = 50;

/**
 * Most ids a list cursor carries: the rows already returned with the
 * cursor's `createdAt`. A tied group always starts on a page of its own, so
 * up to `MAX_CURSOR_IDS + OVERRIDES_PAGE_SIZE` (250) overrides sharing one
 * `createdAt` can be paged whatever comes before them; past that the next
 * page answers 400 `INVALID_CURSOR`.
 */
export const MAX_CURSOR_IDS = 200;

const SET_ROUTE: EntitlementsRoute = {
  method: "POST",
  path: "/entitlements/override/set",
};
const REMOVE_ROUTE: EntitlementsRoute = {
  method: "POST",
  path: "/entitlements/override/remove",
};
const LIST_ROUTE: EntitlementsRoute = {
  method: "GET",
  path: "/entitlements/overrides",
};

const invalidOverride = () =>
  APIError.from("BAD_REQUEST", ENTITLEMENTS_ERROR_CODES.INVALID_OVERRIDE);

/*
 * The override bodies accept anything: each field is `z.unknown().optional()`,
 * and a body that isn't an object (missing, `null`, an array, a string)
 * reads as `{}`. Nothing is refused before the staff gate, so a caller
 * without access always gets 404; the handler checks the shape after
 * `requireStaff` (and, for set, `requireOrgExists`).
 */
const anything = () => z.unknown().optional();
const SET_BODY = z
  .object({
    organizationId: anything(),
    kind: anything(),
    key: anything(),
    value: anything(),
    reason: anything(),
    expiresAt: anything(),
  })
  .catch({});
const REMOVE_BODY = z.object({ id: anything() }).catch({});

const invalidCursor = () =>
  APIError.from("BAD_REQUEST", ENTITLEMENTS_ERROR_CODES.INVALID_CURSOR);

/**
 * The decoded list cursor: a `createdAt` and the ids already returned with
 * it (empty when no row at `at` has been returned yet).
 */
type ListCursor = { at: string; ids: string[] };

const time = (value: Date | string | number) => new Date(value).getTime();

function toBase64Url(text: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(text)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function fromBase64Url(value: string): string {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) throw new Error("not base64url");
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

/** Opaque base64url JSON of `{ at, ids }`. */
export function encodeListCursor(cursor: ListCursor): string {
  return toBase64Url(JSON.stringify(cursor));
}

/**
 * Decodes a list cursor. A malformed one (not base64url JSON, `at` not a
 * date, `ids` not a list of strings) or one carrying more than
 * `MAX_CURSOR_IDS` ids → 400 `INVALID_CURSOR`. `ids` may be empty.
 */
export function decodeListCursor(value: string): ListCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fromBase64Url(value));
  } catch {
    throw invalidCursor();
  }
  if (typeof parsed !== "object" || parsed === null) throw invalidCursor();
  const { at, ids } = parsed as { at?: unknown; ids?: unknown };
  if (typeof at !== "string" || Number.isNaN(time(at))) throw invalidCursor();
  if (
    !Array.isArray(ids) ||
    ids.length > MAX_CURSOR_IDS ||
    !ids.every((id) => typeof id === "string")
  ) {
    throw invalidCursor();
  }
  return { at, ids: ids as string[] };
}

// newest first, ties by id
const newestFirst = (a: EntitlementOverrideRow, b: EntitlementOverrideRow) =>
  time(b.createdAt) - time(a.createdAt) ||
  (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * One page of overrides, newest first, with the keyset cursor (contracts
 * D9 and its amendment): `createdAt lte at` (plus the filters, all AND)
 * sorted `createdAt` desc, `limit = page + 1 + ids.length`; the cursor's
 * ids are dropped and ties ordered by id in code.
 *
 * The next cursor:
 * - the next row is strictly older than the page's last row →
 *   `{ at: next.createdAt, ids: [] }`, so no ids carry into an older
 *   timestamp;
 * - the page ends inside a tied group → `{ at, ids }` with every id already
 *   returned at that `createdAt` (the cursor's ids too, while consecutive
 *   pages stay inside it). A tied group that would start partway through
 *   a page and run past its end starts the next page instead (this page
 *   stops short of 50), so its ids count from a page boundary and up to
 *   250 tied rows page out whatever precedes them.
 */
async function listPage(
  rt: EntitlementsRuntime,
  input: {
    organizationId?: string;
    status?: (typeof OVERRIDE_STATUSES)[number];
    cursor?: string;
  },
): Promise<ListOverridesResponse> {
  const cursor =
    input.cursor !== undefined ? decodeListCursor(input.cursor) : null;
  const where: Where[] = [];
  if (input.organizationId !== undefined) {
    where.push({ field: "organizationId", value: input.organizationId });
  }
  if (input.status !== undefined) {
    where.push({ field: "status", value: input.status });
  }
  if (cursor) {
    where.push({
      field: "createdAt",
      operator: "lte",
      value: new Date(cursor.at),
    });
  }
  const seen = new Set(cursor?.ids ?? []);
  const adapter = await currentAdapter(rt);
  const rows = await adapter.findMany<EntitlementOverrideRow>({
    model: "entitlementOverride",
    where,
    sortBy: { field: "createdAt", direction: "desc" },
    limit: OVERRIDES_PAGE_SIZE + 1 + seen.size,
  });
  const candidates = rows.filter((row) => !seen.has(row.id)).sort(newestFirst);
  let page = candidates.slice(0, OVERRIDES_PAGE_SIZE);
  let next = candidates[OVERRIDES_PAGE_SIZE];
  let last = page.at(-1);
  if (last && next && time(next.createdAt) === time(last.createdAt)) {
    const at = time(last.createdAt);
    // still inside the cursor's timestamp: the group began on an earlier page
    const continuing = cursor !== null && time(cursor.at) === at;
    const start = page.findIndex((row) => time(row.createdAt) === at);
    if (!continuing && start > 0) {
      // the group starts partway through: stop before it
      page = page.slice(0, start);
      next = candidates[start];
      last = page.at(-1);
    }
  }
  let nextCursor: string | null = null;
  if (last && next) {
    const at = time(last.createdAt);
    if (time(next.createdAt) < at) {
      nextCursor = encodeListCursor({
        at: new Date(time(next.createdAt)).toISOString(),
        ids: [],
      });
    } else {
      const carried = cursor && time(cursor.at) === at ? cursor.ids : [];
      const ids = page
        .filter((row) => time(row.createdAt) === at)
        .map((row) => row.id);
      nextCursor = encodeListCursor({
        at: new Date(at).toISOString(),
        ids: [...carried, ...ids],
      });
    }
  }
  return { overrides: page.map(toPublicOverride), nextCursor };
}

/**
 * The staff endpoints, each `sessionMiddleware` then `requireStaff`:
 * - `setEntitlementOverride` (POST `/entitlements/override/set`,
 *   `entitlements:override`): `requireOrgExists`, `validateOverride`,
 *   `setOverride` → `{ override }`. The body schema accepts anything, so
 *   a caller without access gets 404 whatever it sends; after the gates a
 *   missing or empty `organizationId` and every override rule (`kind`,
 *   `key`, `value`, `reason`, `expiresAt`, each of any JSON type) answer
 *   400 `INVALID_OVERRIDE`. A plan override's `value` may be left out or
 *   `null`.
 * - `removeEntitlementOverride` (POST `/entitlements/override/remove`,
 *   `entitlements:override`): `removeOverride` → `{ ok: true }`. Loose
 *   too: after the gate a missing or non-string `id` is 400
 *   `INVALID_OVERRIDE`.
 * - `listEntitlementOverrides` (GET `/entitlements/overrides`,
 *   `entitlements:read`): newest first, 50 per page, keyset cursor; a
 *   malformed cursor or a page past the tie bound (250 overrides sharing
 *   one `createdAt`) → 400 `INVALID_CURSOR`.
 * Writes go through `currentAdapter`, so inside a caller's transaction they
 * join it.
 */
export function overrideEndpoints(rt: EntitlementsRuntime) {
  return {
    setEntitlementOverride: createAuthEndpoint(
      "/entitlements/override/set",
      {
        method: "POST",
        // loose on purpose (every field unknown, any body at all): a
        // non-staff caller gets 404 whatever it sends, and every shape or
        // override rule is checked after the gates (400 INVALID_OVERRIDE)
        body: SET_BODY,
        use: [sessionMiddleware],
      },
      async (ctx): Promise<SetOverrideResponse> => {
        const { session } = await requireStaff(
          ctx as unknown as GenericEndpointContext,
          rt,
          "override",
          SET_ROUTE,
        );
        const body = ctx.body;
        const { organizationId } = body;
        if (typeof organizationId !== "string" || organizationId === "") {
          throw invalidOverride();
        }
        await requireOrgExists(rt, await currentAdapter(rt), organizationId);
        const valid = validateOverride(
          rt,
          { ...body, organizationId },
          rt.now(),
        );
        const row = await setOverride(rt, valid, { userId: session.user.id });
        return { override: toPublicOverride(row) };
      },
    ),
    removeEntitlementOverride: createAuthEndpoint(
      "/entitlements/override/remove",
      {
        method: "POST",
        // loose for the same reason as set: the gate answers first
        body: REMOVE_BODY,
        use: [sessionMiddleware],
      },
      async (ctx): Promise<RemoveOverrideResponse> => {
        const { session } = await requireStaff(
          ctx as unknown as GenericEndpointContext,
          rt,
          "override",
          REMOVE_ROUTE,
        );
        const { id } = ctx.body;
        if (typeof id !== "string" || id === "") throw invalidOverride();
        await removeOverride(rt, id, { userId: session.user.id });
        return { ok: true };
      },
    ),
    listEntitlementOverrides: createAuthEndpoint(
      "/entitlements/overrides",
      {
        method: "GET",
        query: z.object({
          organizationId: z.string().min(1).optional(),
          status: z.enum(OVERRIDE_STATUSES).optional(),
          cursor: z.string().optional(),
        }),
        use: [sessionMiddleware],
      },
      async (ctx): Promise<ListOverridesResponse> => {
        await requireStaff(
          ctx as unknown as GenericEndpointContext,
          rt,
          "read",
          LIST_ROUTE,
        );
        return listPage(rt, ctx.query);
      },
    ),
  };
}
