import { entitlementsStatements } from "@byo-oss/entitlements";
import { createAccessControl } from "better-auth/plugins/access";
import {
  adminAc,
  defaultStatements,
  memberAc,
  ownerAc,
} from "better-auth/plugins/organization/access";

// Setup step 2: the entitlements statements go into the app's access control.
export const ac = createAccessControl({
  ...defaultStatements,
  ...entitlementsStatements,
});

// Roles are shared by every organization. A customer's owner can't override
// their own plan: override calls are checked in the staff organization only.
export const roles = {
  owner: ac.newRole({
    ...ownerAc.statements,
    entitlements: ["read", "override"],
  }),
  admin: ac.newRole({
    ...adminAc.statements,
    entitlements: ["read", "override"],
  }),
  member: ac.newRole({ ...memberAc.statements, entitlements: ["read"] }),
};
