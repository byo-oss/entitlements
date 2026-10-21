/**
 * Entitlements' permission statements, in better-auth's access-control
 * format. This module imports nothing, so it is also exported from
 * `@byo-oss/entitlements/client`.
 *
 * - `read`: see an organization's plan, features, limits and usage
 * - `override`: set and remove overrides (checked in the staff organization)
 *
 * ```ts
 * import { createAccessControl } from "better-auth/plugins/access"
 * import { defaultStatements } from "better-auth/plugins/organization/access"
 * import { entitlementsStatements } from "@byo-oss/entitlements"
 * export const ac = createAccessControl({ ...defaultStatements, ...entitlementsStatements })
 * ```
 *
 * Suggested roles: in customer organizations every role gets `read`; in the
 * staff organization `owner` and `admin` get both, `member` gets `read`.
 */
export const entitlementsStatements = {
  entitlements: ["read", "override"],
} as const;

export type EntitlementsAction =
  (typeof entitlementsStatements.entitlements)[number];
