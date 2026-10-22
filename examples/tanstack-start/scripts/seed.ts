import { betterAuth } from "better-auth";
import { authOptions } from "../src/lib/auth-options.ts";
import {
  CUSTOMER,
  CUSTOMER_ORGANIZATION_ID,
  STAFF,
  STAFF_ORGANIZATION_ID,
} from "../src/lib/constants.ts";

const auth = betterAuth(authOptions);
const { adapter, internalAdapter } = await auth.$context;

async function ensureUser(user: typeof CUSTOMER) {
  const existing = await internalAdapter.findUserByEmail(user.email);
  if (existing) return existing.user.id;
  const { user: created } = await auth.api.signUpEmail({ body: user });
  return created.id;
}

/**
 * Organizations with fixed ids, which the API can't set, so they go through
 * the adapter. `owner` is the only member.
 */
async function ensureOrganization(
  organization: { id: string; name: string; slug: string },
  ownerId: string,
) {
  const existing = await adapter.findOne({
    model: "organization",
    where: [{ field: "id", value: organization.id }],
  });
  if (existing) return;
  await adapter.create({
    model: "organization",
    forceAllowId: true,
    data: { ...organization, createdAt: new Date() },
  });
  await adapter.create({
    model: "member",
    data: {
      organizationId: organization.id,
      userId: ownerId,
      role: "owner",
      createdAt: new Date(),
    },
  });
}

const customerId = await ensureUser(CUSTOMER);
const staffId = await ensureUser(STAFF);

// The customer's organization has no billing state, so it's on Free.
await ensureOrganization(
  { id: CUSTOMER_ORGANIZATION_ID, name: "Acme", slug: "acme" },
  customerId,
);
// The staff organization (`staffOrganizationId`): its owner may set overrides.
await ensureOrganization(
  { id: STAFF_ORGANIZATION_ID, name: "Example Staff", slug: "staff" },
  staffId,
);

console.log(
  `seeded: ${CUSTOMER.email} (owner of ${CUSTOMER_ORGANIZATION_ID}), ${STAFF.email} (owner of ${STAFF_ORGANIZATION_ID})`,
);
