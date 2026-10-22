import type {
  BetterAuthOptions,
  BetterAuthPlugin,
  DBTransactionAdapter,
} from "better-auth";
import { createAuthMiddleware, isAPIError } from "better-auth/api";
import {
  type AuthWithContext,
  type EntitlementsRuntime,
  runtimeFromAuth,
} from "./runtime";
import { currentAdapter } from "./txn";

const PREFIX = "[@byo-oss/entitlements]";

/** One `hooks.after` entry, as better-auth plugins declare them. */
export type AfterHook = NonNullable<
  NonNullable<BetterAuthPlugin["hooks"]>["after"]
>[number];

/** `databaseHooks.user.delete.after`. */
export type UserDeleteHook = NonNullable<
  NonNullable<
    NonNullable<
      NonNullable<BetterAuthOptions["databaseHooks"]>["user"]
    >["delete"]
  >["after"]
>;

/** The models an organization's data lives in, in delete order. */
const ORGANIZATION_MODELS = [
  "entitlementUsage",
  "entitlementOverride",
  "entitlementSnapshot",
] as const;

/**
 * Deletes every row of the organization, one `deleteMany` per model, then
 * drops its cache entry. The counts `deleteMany` returns aren't used.
 */
async function deleteRows(
  rt: EntitlementsRuntime,
  adapter: DBTransactionAdapter,
  organizationId: string,
): Promise<void> {
  for (const model of ORGANIZATION_MODELS) {
    await adapter.deleteMany({
      model,
      where: [{ field: "organizationId", value: organizationId }],
    });
  }
  rt.cache.delete(organizationId);
}

/**
 * Deletes an organization's `entitlementUsage`, `entitlementOverride` and
 * `entitlementSnapshot` rows explicitly (`deleteMany` per model, never
 * relying on cascades, which the memory adapter and MongoDB don't apply)
 * through `getCurrentAdapter`, so it joins a caller's transaction, and
 * clears the organization's cache entry. Also `byo.deleteOrganizationData`.
 *
 * Throws `[@byo-oss/entitlements] deleteOrganizationData needs the
 * entitlements plugin installed on this auth instance` without the plugin,
 * and for an empty `organizationId`. A database error is thrown to the
 * caller.
 */
export async function deleteOrganizationData(
  auth: AuthWithContext,
  organizationId: string,
): Promise<void> {
  const rt = await runtimeFromAuth(auth, "deleteOrganizationData");
  if (typeof organizationId !== "string" || organizationId === "") {
    throw new Error(
      `${PREFIX} deleteOrganizationData needs a non-empty organizationId`,
    );
  }
  await deleteRows(rt, await currentAdapter(rt), organizationId);
}

/** The deleted organization's id from `/organization/delete`'s response, if any. */
function deletedOrganizationId(returned: unknown): string | null {
  if (typeof returned !== "object" || returned === null) return null;
  const id = (returned as { id?: unknown }).id;
  return typeof id === "string" && id !== "" ? id : null;
}

/**
 * The `hooks.after` entry for `/organization/delete` (installed when
 * `organizationCleanup` is on):
 * - reads the id from the endpoint's response (`ctx.context.returned`),
 *   never from the request body, and skips when the response is an
 *   `APIError` (the hook also runs after a failed call);
 * - deletes like `deleteOrganizationData`;
 * - logs a failure without failing the response: the organization is
 *   already gone, and `deleteOrganizationData` can be run again later.
 */
export function organizationCleanupHook(rt: EntitlementsRuntime): AfterHook[] {
  return [
    {
      matcher: (ctx) => ctx.path === "/organization/delete",
      handler: createAuthMiddleware(async (ctx) => {
        const returned: unknown = ctx.context.returned;
        if (isAPIError(returned)) return;
        const organizationId = deletedOrganizationId(returned);
        if (!organizationId) return;
        try {
          await deleteRows(rt, await currentAdapter(rt), organizationId);
        } catch (error) {
          rt.logger.error(
            `${PREFIX} cleanup after /organization/delete failed for organization ${organizationId}; run deleteOrganizationData to retry`,
            error,
          );
        }
      }),
    },
  ];
}

/**
 * `databaseHooks.user.delete.after`: nulls `createdBy` and `removedBy` on
 * that user's overrides through the adapter captured in `init`
 * (`currentAdapter`), so the memory adapter and MongoDB match SQL's
 * `set null`. Errors are logged, never thrown: the user is already deleted.
 */
export function userDeleteHook(rt: EntitlementsRuntime): UserDeleteHook {
  return async (user) => {
    const userId = (user as { id?: unknown } | null | undefined)?.id;
    if (typeof userId !== "string" || userId === "") return;
    try {
      const adapter = await currentAdapter(rt);
      for (const field of ["createdBy", "removedBy"] as const) {
        await adapter.updateMany({
          model: "entitlementOverride",
          where: [{ field, value: userId }],
          update: { [field]: null },
        });
      }
    } catch (error) {
      rt.logger.error(
        `${PREFIX} clearing override authorship after deleting user ${userId} failed`,
        error,
      );
    }
  };
}
