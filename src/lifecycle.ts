// BYO_STUB: N08 replaces this file (contracts.md "lifecycle.ts")
import type { BetterAuthOptions, BetterAuthPlugin } from "better-auth";
import type { AuthWithContext, EntitlementsRuntime } from "./runtime";

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

/**
 * Deletes an organization's `entitlementUsage`, `entitlementOverride` and
 * `entitlementSnapshot` rows explicitly (`deleteMany` per model, never
 * relying on cascades) through `getCurrentAdapter`, so it joins a caller's
 * transaction; clears the cache entry. Also `byo.deleteOrganizationData`.
 * Throws `[@byo-oss/entitlements] deleteOrganizationData needs the
 * entitlements plugin installed on this auth instance` without the plugin.
 * Stub: does nothing.
 */
export async function deleteOrganizationData(
  _auth: AuthWithContext,
  _organizationId: string,
): Promise<void> {}

/**
 * The `hooks.after` entry for `/organization/delete` (installed when
 * `organizationCleanup` is on): reads the id from `ctx.context.returned`,
 * skips when it is an `APIError` (failed call), deletes like
 * `deleteOrganizationData`, and logs failures without failing the
 * response. Stub: no hooks.
 */
export function organizationCleanupHook(_rt: EntitlementsRuntime): AfterHook[] {
  return [];
}

/**
 * `databaseHooks.user.delete.after`: nulls `createdBy` and `removedBy` on
 * overrides for that user, through the adapter captured in `init`
 * (`currentAdapter`), so memory and MongoDB match SQL's `set null`. Errors
 * are logged. Stub: does nothing.
 */
export function userDeleteHook(_rt: EntitlementsRuntime): UserDeleteHook {
  return async () => {};
}
