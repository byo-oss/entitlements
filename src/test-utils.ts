/**
 * Test harness for the memory lane (and, through `wrapAdapter`, the SQL
 * lane). Not part of the package: tests import it, nothing else in `src/`
 * does.
 */
import { runWithTransaction } from "@better-auth/core/context";
import { getAuthTables } from "@better-auth/core/db";
import { type MemoryDB, memoryAdapter } from "@better-auth/memory-adapter";
import {
  type AuthContext,
  type BetterAuthOptions,
  type BetterAuthPlugin,
  betterAuth,
  type DBAdapter,
} from "better-auth";
import { createAuthEndpoint } from "better-auth/api";
import { createAccessControl } from "better-auth/plugins/access";
import { organization } from "better-auth/plugins/organization";
import {
  adminAc,
  defaultStatements,
  memberAc,
  ownerAc,
} from "better-auth/plugins/organization/access";
import { afterEach } from "vitest";
import { IN_CHUNK, isEntitlementsQuery } from "./adapter";
import { type AnyCatalog, defineEntitlements, limitKind } from "./catalog";
import { entitlements } from "./index";
import type { EntitlementsOptions } from "./options";
import { bucketKey } from "./period";
import {
  type EntitlementsRuntime,
  runtimeFromAuth,
  runtimeFromContext,
} from "./runtime";
import {
  type EntitlementOverrideRow,
  type EntitlementSnapshotRow,
  type EntitlementUsageRow,
  encodeOverrideValue,
  type OverrideKind,
  type OverrideValue,
} from "./schema";
import { entitlementsStatements } from "./statements";
import { inTransaction } from "./txn";
import type { BillingSource, BillingState } from "./types";

// ---------------------------------------------------------------------------
// The test catalog (neutral keys)
// ---------------------------------------------------------------------------

/**
 * Plans `free` (default), `pro` and `team`; alias `legacy` → `pro`.
 * Limits: `apiCalls` metered per day, `uploads` per month, `reports` per
 * billing period; `members`, `projects` capacity; `retentionDays` value.
 */
export const testCatalog = defineEntitlements({
  features: ["exports", "sso", "prioritySupport"],
  limits: {
    apiCalls: { kind: "metered", period: "day" },
    uploads: { kind: "metered", period: "month" },
    reports: { kind: "metered", period: "billing" },
    members: { kind: "capacity" },
    projects: { kind: "capacity" },
    retentionDays: { kind: "value" },
  },
  plans: {
    free: {
      features: { exports: false, sso: false, prioritySupport: false },
      limits: {
        apiCalls: 1_000,
        uploads: 10,
        reports: 5,
        members: 5,
        projects: 3,
        retentionDays: 7,
      },
      display: { name: "Free" },
    },
    pro: {
      features: { exports: true, sso: false, prioritySupport: false },
      limits: {
        apiCalls: 50_000,
        uploads: 1_000,
        reports: 100,
        members: 50,
        projects: "unlimited",
        retentionDays: 90,
      },
      display: { name: "Pro" },
    },
    team: {
      features: { exports: true, sso: true, prioritySupport: true },
      limits: {
        apiCalls: "unlimited",
        uploads: "unlimited",
        reports: "unlimited",
        members: 500,
        projects: "unlimited",
        retentionDays: 365,
      },
    },
  },
  defaultPlan: "free",
  planAliases: { legacy: "pro" },
});

export type TestCatalog = typeof testCatalog;

// ---------------------------------------------------------------------------
// Strict adapter wrapper (§2.7, checkable on every lane) + transaction tags
// ---------------------------------------------------------------------------

/** One adapter call as the wrapper sees it. */
export type AdapterCall = {
  method: string;
  model: string;
  /** The argument object as passed (where, limit, data, ...). */
  args: Record<string, unknown>;
  /** `outer`: the base adapter; `trx`: an adapter a real transaction passed in. */
  scope: "outer" | "trx";
};

export type WrapAdapterOptions = {
  /** Enforce §2.7 on entitlements' queries. @default true */
  strict?: boolean;
  /** Runs before every adapter call (inside transactions too), e.g. to force a conflict or a failure. */
  before?: (call: AdapterCall) => void | Promise<void>;
};

const strictViolations: string[] = [];

/**
 * Returns and clears the violations recorded since the last call. A test
 * that provokes a violation on purpose calls this so the `afterEach` check
 * passes.
 */
export function takeStrictViolations(): string[] {
  return strictViolations.splice(0, strictViolations.length);
}

// A violation inside code that catches errors (degraded reads, hooks, emit)
// would be swallowed; recording it here fails the test anyway.
afterEach(() => {
  const violations = takeStrictViolations();
  if (violations.length > 0) {
    throw new Error(`strict adapter violations:\n${violations.join("\n")}`);
  }
});

const WHERE_METHODS = new Set([
  "findOne",
  "findMany",
  "count",
  "update",
  "updateMany",
  "delete",
  "deleteMany",
  "consumeOne",
  "incrementOne",
]);

const WRAPPED = [
  "create",
  "findOne",
  "findMany",
  "count",
  "update",
  "updateMany",
  "delete",
  "deleteMany",
  "consumeOne",
  "incrementOne",
] as const;

/** Models whose every call is checked; other models only when tagged (`markEntitlementsQuery`). */
const isOwnModel = (model: string) => model.startsWith("entitlement");

/**
 * Models an `outer` call to inside `expectNoOuterCalls` fails the test
 * (besides any tagged query: `markEntitlementsQuery`).
 */
const isTrackedModel = (model: string) =>
  isOwnModel(model) || model === "subscription";

type WhereClause = {
  field: string;
  operator?: string;
  value: unknown;
  connector?: "AND" | "OR";
};

function checkCall(method: string, args: Record<string, unknown>) {
  const model = String(args.model);
  if (!isOwnModel(model) && !isEntitlementsQuery(args)) return;
  const problems: string[] = [];
  if (method === "findMany" && args.limit === undefined) {
    problems.push(`findMany on ${model} without limit`);
  }
  if (WHERE_METHODS.has(method) && Array.isArray(args.where)) {
    const where = args.where as WhereClause[];
    for (const clause of where) {
      if (clause.operator !== "in" && clause.operator !== "not_in") continue;
      const size = Array.isArray(clause.value) ? clause.value.length : -1;
      if (size <= 0 || size > IN_CHUNK) {
        problems.push(
          `${method} on ${model}: ${clause.field} ${clause.operator} with ${size < 0 ? "a non-list" : size} values (allowed 1..${IN_CHUNK})`,
        );
      }
    }
    const connectors = new Set(where.map((c) => c.connector ?? "AND"));
    if (connectors.size > 1) {
      problems.push(
        `${method} on ${model}: where mixes AND and OR (${where.map((c) => `${c.field}:${c.connector ?? "AND"}`).join(", ")})`,
      );
    }
  }
  if (problems.length > 0) {
    strictViolations.push(...problems);
    throw new Error(`[strict adapter] ${problems.join("; ")}`);
  }
}

/** The open `expectNoOuterCalls` probe, if any. */
let probe: { outer: AdapterCall[] } | null = null;

const WRAPPER = Symbol("entitlements test adapter wrapper");

/**
 * Wraps an adapter so every call:
 * - with `strict`, fails on an `entitlement*` call (or a tagged
 *   `organization`/`member`/`user`/`subscription` call) that runs
 *   `findMany` without `limit`, uses `in`/`not_in` with 0 or more than 90
 *   values, or mixes `AND` and `OR` connectors;
 * - runs `options.before`;
 * - is tagged `outer` or `trx`. `transaction(cb)` wraps the adapter it
 *   passes to `cb` as `trx`, except when the underlying adapter has no real
 *   transactions and passes itself (`trx === adapter`): then `cb` gets this
 *   same wrapped object, so `getCurrentAdapter(ctx.adapter) === ctx.adapter`
 *   holds as in production.
 */
export function wrapAdapter<A extends Omit<DBAdapter, "transaction">>(
  adapter: A,
  options: WrapAdapterOptions = {},
  scope: "outer" | "trx" = "outer",
): A {
  const { strict = true, before } = options;
  const wrapped: Record<string | symbol, unknown> = { ...adapter };
  wrapped[WRAPPER] = scope;
  for (const method of WRAPPED) {
    const original = (adapter as Record<string, unknown>)[method] as
      | ((args: Record<string, unknown>) => Promise<unknown>)
      | undefined;
    if (!original) continue;
    wrapped[method] = async (args: Record<string, unknown>) => {
      const call: AdapterCall = {
        method,
        model: String(args.model),
        args,
        scope,
      };
      if (strict) checkCall(method, args);
      if (
        scope === "outer" &&
        probe &&
        (isTrackedModel(call.model) || isEntitlementsQuery(args))
      ) {
        probe.outer.push(call);
        const message = `[outer adapter] ${method} on ${call.model} ran on the outer adapter inside runWithTransaction`;
        strictViolations.push(message);
        throw new Error(message);
      }
      if (before) await before(call);
      return original.call(adapter, args);
    };
  }
  const transaction = (adapter as { transaction?: unknown }).transaction as
    | (<R>(
        cb: (trx: Omit<DBAdapter, "transaction">) => Promise<R>,
      ) => Promise<R>)
    | undefined;
  if (transaction) {
    wrapped.transaction = <R>(
      cb: (trx: Omit<DBAdapter, "transaction">) => Promise<R>,
    ) =>
      transaction.call(adapter, (trx) =>
        cb(
          (trx as unknown) === adapter
            ? (wrapped as unknown as A)
            : wrapAdapter(trx, options, "trx"),
        ),
      );
  }
  return wrapped as unknown as A;
}

/** Wraps an adapter factory (`memoryAdapter(db)`, `kyselyAdapter(db)`) with `wrapAdapter`. */
export function wrapAdapterFactory(
  factory: (options: BetterAuthOptions) => DBAdapter,
  options: WrapAdapterOptions = {},
): (options: BetterAuthOptions) => DBAdapter {
  return (authOptions) => wrapAdapter(factory(authOptions), options);
}

/** Whether the adapter has real transactions (`transaction: false` adapters pass themselves). */
export function hasRealTransactions(adapter: DBAdapter): boolean {
  const config = (
    adapter as { options?: { adapterConfig?: { transaction?: unknown } } }
  ).options?.adapterConfig;
  return !!config && config.transaction !== false && !!config.transaction;
}

/**
 * Runs `fn` inside `runWithTransaction(ctx.adapter, …)` and fails if any
 * call to an `entitlement*` or `subscription` model, or any tagged query
 * (`markEntitlementsQuery`: entitlements' `organization`, `member` and
 * `user` reads), went to the outer adapter meanwhile (the call itself throws, so a single-connection
 * database can't hang on it, and the violation is recorded even if the
 * code under test swallows the throw). Returns `fn`'s result. Throws for an
 * adapter without real transactions, where every call is "outer" by
 * design.
 */
export async function expectNoOuterCalls<T>(
  auth: AnyTestAuth,
  fn: () => Promise<T>,
): Promise<T> {
  const context = await getContext(auth);
  if (!(context.adapter as unknown as Record<symbol, unknown>)[WRAPPER]) {
    throw new Error("expectNoOuterCalls needs the strict test wrapper");
  }
  if (!hasRealTransactions(context.adapter)) {
    throw new Error(
      "expectNoOuterCalls needs an adapter with real transactions",
    );
  }
  if (probe) throw new Error("expectNoOuterCalls can't be nested");
  const current = { outer: [] as AdapterCall[] };
  probe = current;
  let result: T;
  try {
    result = await runWithTransaction(context.adapter, fn);
  } finally {
    probe = null;
  }
  if (current.outer.length > 0) {
    throw new Error(
      `outer adapter calls inside runWithTransaction: ${current.outer.map((c) => `${c.method} ${c.model}`).join(", ")}`,
    );
  }
  return result;
}

/** Path of `inTransactionProbe`'s endpoint (under `/api/auth`). */
export const IN_TRANSACTION_PROBE_PATH = "/test/in-transaction";

/**
 * A test-only plugin with one endpoint, `testInTransaction` (GET
 * `/test/in-transaction`, no session needed), that answers
 * `{ inTransaction: await inTransaction(rt) }` from inside a request, so a
 * test can show detection reads false in a plain `auth.handler` request.
 * Pass it in `config.plugins`; it comes after entitlements.
 */
export function inTransactionProbe() {
  return {
    id: "entitlements-test-probe",
    endpoints: {
      testInTransaction: createAuthEndpoint(
        IN_TRANSACTION_PROBE_PATH,
        { method: "GET" },
        async (ctx) => ({
          inTransaction: await inTransaction(
            runtimeFromContext(ctx.context, "inTransactionProbe"),
          ),
        }),
      ),
    },
  } satisfies BetterAuthPlugin;
}

// ---------------------------------------------------------------------------
// Roles: entitlements statements spread into the app's access control
// ---------------------------------------------------------------------------

export const testStatements = {
  ...defaultStatements,
  ...entitlementsStatements,
} as const;
export const testAc = createAccessControl(testStatements);

/**
 * Global roles (the org plugin applies them in every organization):
 * - `owner`, `admin`: their default org permissions plus read and override
 * - `member`: read
 * - `billing`: no entitlements actions
 * - `overrideOnly`: override without read
 */
export const testRoles = {
  owner: testAc.newRole({
    ...ownerAc.statements,
    entitlements: ["read", "override"],
  }),
  admin: testAc.newRole({
    ...adminAc.statements,
    entitlements: ["read", "override"],
  }),
  member: testAc.newRole({ ...memberAc.statements, entitlements: ["read"] }),
  billing: testAc.newRole({ ...memberAc.statements }),
  overrideOnly: testAc.newRole({
    ...memberAc.statements,
    entitlements: ["override"],
  }),
};

export type TestRole = keyof typeof testRoles;

/** The organization plugin as tests install it. */
export const testOrganization = () =>
  organization({ ac: testAc, roles: testRoles });

// ---------------------------------------------------------------------------
// betterAuth on the memory adapter
// ---------------------------------------------------------------------------

export const TEST_PASSWORD = "password-1234";

/** better-auth options shared by both lanes. Passwords are not hashed, to keep tests fast. */
export const baseAuthOptions = {
  baseURL: "http://localhost:3000",
  secret: "byo-entitlements-test-secret-0123456789",
  emailAndPassword: {
    enabled: true,
    password: {
      hash: async (password: string) => `plain:${password}`,
      verify: async ({ hash, password }: { hash: string; password: string }) =>
        hash === `plain:${password}`,
    },
  },
  // the admin plugin's field, so tests can mark a session as impersonated
  session: {
    additionalFields: {
      impersonatedBy: { type: "string", required: false, input: false },
    },
  },
} satisfies Partial<BetterAuthOptions>;

/**
 * Merges extra better-auth options over the base, keeping the base
 * `session.additionalFields.impersonatedBy` and `emailAndPassword.password`.
 */
export function mergeAuthOptions(extra?: Partial<BetterAuthOptions>) {
  return {
    ...baseAuthOptions,
    ...extra,
    emailAndPassword: {
      ...baseAuthOptions.emailAndPassword,
      ...extra?.emailAndPassword,
    },
    session: {
      ...baseAuthOptions.session,
      ...extra?.session,
      additionalFields: {
        ...baseAuthOptions.session.additionalFields,
        ...extra?.session?.additionalFields,
      },
    },
  };
}

export type TestAuthConfig<P extends BetterAuthPlugin[] = BetterAuthPlugin[]> =
  {
    /** Entitlements options over `{ catalog: testCatalog }`. */
    options?: Partial<EntitlementsOptions<AnyCatalog>>;
    /** Extra better-auth options (merged over the base). */
    authOptions?: Partial<BetterAuthOptions>;
    /** Plugins after organization() and entitlements(); their endpoints are typed on `auth.api`. */
    plugins?: P;
    /** Install the organization plugin. @default true */
    organization?: boolean;
    /** Adapter wrapper options. @default { strict: true } */
    adapter?: WrapAdapterOptions;
  };

/**
 * The plugin list for a test config. Typed as organization + entitlements
 * + `config.plugins`, so `auth.api` carries every plugin's endpoints (also
 * when `organization: false`, where calling the org endpoints would fail).
 */
export function testPlugins<P extends BetterAuthPlugin[] = []>(
  config: TestAuthConfig<P>,
) {
  const plugins: BetterAuthPlugin[] = [
    ...(config.organization === false ? [] : [testOrganization()]),
    entitlements({ catalog: testCatalog, ...config.options }),
    ...(config.plugins ?? []),
  ];
  return plugins as unknown as [
    ReturnType<typeof testOrganization>,
    ReturnType<typeof entitlements<AnyCatalog>>,
    ...P,
  ];
}

function seededMemoryDB(options: BetterAuthOptions): MemoryDB {
  const tables = getAuthTables(options);
  return Object.keys(tables).reduce<MemoryDB>((db, table) => {
    db[table] = [];
    return db;
  }, {});
}

/**
 * A real `betterAuth` with `organization({ ac, roles })` (unless turned
 * off), `entitlements({ catalog: testCatalog, ...config.options })` and the
 * memory adapter behind the strict wrapper. `config.plugins` come last, and
 * their endpoints are typed on `auth.api`.
 */
export function makeAuth<P extends BetterAuthPlugin[] = []>(
  config: TestAuthConfig<P> = {},
) {
  const options = {
    ...mergeAuthOptions(config.authOptions),
    plugins: testPlugins<P>(config),
  };
  const memoryDB = seededMemoryDB(options);
  return betterAuth({
    ...options,
    database: wrapAdapterFactory(memoryAdapter(memoryDB), config.adapter),
  });
}

/**
 * Any test auth (memory or SQL lane). Loose on purpose so helpers work with
 * both.
 */
// biome-ignore lint/suspicious/noExplicitAny: helpers accept either lane's auth
export type AnyTestAuth = { api: any; $context: Promise<any> };

/** better-auth's context (adapter, internalAdapter, options) of a test auth. */
export async function getContext(auth: AnyTestAuth): Promise<AuthContext> {
  return (await auth.$context) as AuthContext;
}

/** The entitlements runtime of a test auth. */
export function getRuntime(auth: AnyTestAuth): Promise<EntitlementsRuntime> {
  return runtimeFromAuth(auth, "test");
}

// ---------------------------------------------------------------------------
// Users, sessions, organizations
// ---------------------------------------------------------------------------

export type TestUser = {
  user: { id: string; email: string; name: string };
  /** A cookie for this user's session. */
  headers: Headers;
};

const cookieFrom = (headers: Headers) =>
  new Headers({
    cookie: headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; "),
  });

/** Signs up a user (email/password) and returns them with session headers. */
export async function signUpUser(
  auth: AnyTestAuth,
  email: string,
  name?: string,
): Promise<TestUser> {
  const { headers, response } = await auth.api.signUpEmail({
    body: {
      email,
      password: TEST_PASSWORD,
      name: name ?? email.split("@")[0] ?? email,
    },
    returnHeaders: true,
  });
  return {
    user: response.user as TestUser["user"],
    headers: cookieFrom(headers as Headers),
  };
}

/** Signs the user in again and returns headers for a new session. */
export async function signIn(
  auth: AnyTestAuth,
  email: string,
): Promise<Headers> {
  const { headers } = await auth.api.signInEmail({
    body: { email, password: TEST_PASSWORD },
    returnHeaders: true,
  });
  return cookieFrom(headers as Headers);
}

/**
 * Headers for a new session of this user that an admin is impersonating
 * (`session.impersonatedBy` set, as the admin plugin does).
 */
export async function impersonatedHeaders(
  auth: AnyTestAuth,
  email: string,
  adminId = "admin-user",
): Promise<Headers> {
  const headers = await signIn(auth, email);
  const session = await auth.api.getSession({ headers });
  const context = await getContext(auth);
  await context.adapter.update({
    model: "session",
    where: [{ field: "id", value: session.session.id }],
    update: { impersonatedBy: adminId },
  });
  return headers;
}

/** Adds a member through the org plugin's server-only `addMember`. */
export async function addMember(
  auth: AnyTestAuth,
  input: {
    organizationId: string;
    userId: string;
    role: TestRole | TestRole[];
  },
): Promise<{ id: string; userId: string; organizationId: string }> {
  return auth.api.addMember({ body: input });
}

let seq = 0;
const nextSeq = () => {
  seq += 1;
  return seq;
};

/**
 * Creates an organization through the org plugin, owned by `owner` (a new
 * user unless given). Returns its id and the owner.
 */
export async function seedOrg(
  auth: AnyTestAuth,
  input: { name?: string; slug?: string; owner?: TestUser } = {},
): Promise<{ organizationId: string; owner: TestUser }> {
  const n = nextSeq();
  const owner =
    input.owner ??
    (await signUpUser(auth, `owner${n}@acme.test`, `Owner ${n}`));
  const name = input.name ?? `Org ${n}`;
  const organization = await auth.api.createOrganization({
    body: { name, slug: input.slug ?? `org-${n}-${Date.now()}` },
    headers: owner.headers,
  });
  return { organizationId: organization.id as string, owner };
}

/** Id of the staff organization `seedStaff` creates. Pass it as `staffOrganizationId`. */
export const STAFF_ORG_ID = "org_staff";
/** The staff organization id for `generateId: "uuid"`. */
export const STAFF_ORG_UUID = "00000000-0000-4000-8000-00000000057a";

/** `STAFF_ORG_UUID` for `"uuid"` ids, `STAFF_ORG_ID` otherwise. */
export function staffOrgIdFor(generateId?: "uuid" | "serial"): string {
  if (generateId === "serial") {
    throw new Error('seedStaff does not support generateId: "serial"');
  }
  return generateId === "uuid" ? STAFF_ORG_UUID : STAFF_ORG_ID;
}

/**
 * Creates the staff organization with a fixed id (so it can be passed as
 * `staffOrganizationId` before it exists) and one staff user per test role,
 * keyed by role. Default id: `staffOrgIdFor(<the auth's generateId>)`.
 */
export async function seedStaff(
  auth: AnyTestAuth,
  staffOrganizationId?: string,
): Promise<{ staffOrganizationId: string; staff: Record<TestRole, TestUser> }> {
  const context = await getContext(auth);
  const id =
    staffOrganizationId ??
    staffOrgIdFor(
      context.options.advanced?.database?.generateId as
        | "uuid"
        | "serial"
        | undefined,
    );
  await context.adapter.create({
    model: "organization",
    data: { id, name: "Staff", slug: `staff-${id}`, createdAt: new Date() },
    forceAllowId: true,
  });
  const staff = {} as Record<TestRole, TestUser>;
  for (const role of Object.keys(testRoles) as TestRole[]) {
    staff[role] = await signUpUser(
      auth,
      `${role.toLowerCase()}-${nextSeq()}@staff.test`,
      `Staff ${role}`,
    );
    await addMember(auth, {
      organizationId: id,
      userId: staff[role].user.id,
      role,
    });
  }
  return { staffOrganizationId: id, staff };
}

// ---------------------------------------------------------------------------
// Row seeders: raw writes with every required field filled, for tests that
// must not depend on later modules (G16). They go through the wrapped adapter.
// ---------------------------------------------------------------------------

/**
 * Creates or replaces the organization's snapshot row directly. Without a
 * configured source, resolution ignores snapshots (every organization is on
 * `defaultPlan`), so pass `options: { source: fakeSource() }` to `makeAuth`
 * when a seeded plan should resolve. Defaults:
 * `source` = the configured source id (`"none"` without one), every state
 * field null / false, `version: 0`, `syncState: "idle"`, `syncedAt` now,
 * `nextSyncAt` now + `maxAge`, `syncAttempts: 0`. `fields` override any of
 * them. No events, no cache changes.
 */
export async function setSnapshot(
  auth: AnyTestAuth,
  organizationId: string,
  fields: Partial<Omit<EntitlementSnapshotRow, "id" | "organizationId">> = {},
): Promise<EntitlementSnapshotRow> {
  const context = await getContext(auth);
  const rt = await getRuntime(auth);
  const now = new Date();
  const data = {
    source: rt.options.sourceId,
    planKey: null,
    status: null,
    periodStart: null,
    periodEnd: null,
    cancelAtPeriodEnd: false,
    seats: null,
    pastDueSince: null,
    sourceRef: null,
    version: 0,
    syncedAt: now,
    nextSyncAt: new Date(now.getTime() + rt.options.maxAge),
    syncState: "idle" as const,
    syncClaimedAt: null,
    syncAttempts: 0,
    syncError: null,
    createdAt: now,
    updatedAt: now,
    ...fields,
  };
  const existing = await context.adapter.findOne<EntitlementSnapshotRow>({
    model: "entitlementSnapshot",
    where: [{ field: "organizationId", value: organizationId }],
  });
  if (existing) {
    const updated = await context.adapter.update<EntitlementSnapshotRow>({
      model: "entitlementSnapshot",
      where: [{ field: "id", value: existing.id }],
      update: data,
    });
    return updated as EntitlementSnapshotRow;
  }
  return context.adapter.create<
    Omit<EntitlementSnapshotRow, "id">,
    EntitlementSnapshotRow
  >({
    model: "entitlementSnapshot",
    data: { organizationId, ...data },
  });
}

/**
 * Inserts an override row directly. Defaults: `status: "active"`,
 * `reason: "test"`, `expiresAt: null` (so `permanent: true`), `createdAt`
 * now; `value` encoded from `value` (default: plan → null, feature → true,
 * limit → "unlimited").
 */
export async function seedOverride(
  auth: AnyTestAuth,
  input: {
    organizationId: string;
    kind: OverrideKind;
    key: string;
    value?: OverrideValue;
  } & Partial<
    Omit<
      EntitlementOverrideRow,
      "id" | "organizationId" | "kind" | "key" | "value"
    >
  >,
): Promise<EntitlementOverrideRow> {
  const { adapter } = await getContext(auth);
  const { value, ...rest } = input;
  const decoded =
    value !== undefined
      ? value
      : input.kind === "plan"
        ? null
        : input.kind === "feature"
          ? true
          : "unlimited";
  const expiresAt = rest.expiresAt ?? null;
  return adapter.create<
    Omit<EntitlementOverrideRow, "id">,
    EntitlementOverrideRow
  >({
    model: "entitlementOverride",
    data: {
      status: "active",
      reason: "test",
      permanent: expiresAt === null,
      endedAt: null,
      createdBy: null,
      removedBy: null,
      createdAt: new Date(),
      ...rest,
      expiresAt,
      value: encodeOverrideValue(decoded),
    },
  });
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The harness's own current period for a metered key (independent of
 * `periodFor`): `day` → the UTC day of `now`; `month` and `billing` → the
 * UTC month (`billing` as for an organization without an entitled
 * snapshot period).
 */
function defaultUsagePeriod(
  period: string,
  now: Date,
): { start: Date; end: Date } {
  if (period === "day") {
    const start = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
    return { start, end: new Date(start.getTime() + DAY_MS) };
  }
  return {
    start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
    end: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)),
  };
}

/**
 * Inserts a usage counter row directly (`bucket` from `bucketKey`).
 * Defaults: the key's current period as the harness computes it (`day` →
 * the UTC day of `rt.now()`; `month` and `billing` → the UTC month), so
 * pass `periodStart`/`periodEnd` for a snapshot's billing period;
 * `used: 0`, `refused: 0`. Throws for a key that isn't a metered limit of
 * the plugin's catalog. No events, no cache changes.
 */
export async function seedUsage(
  auth: AnyTestAuth,
  input: {
    organizationId: string;
    key: string;
    periodStart?: Date;
    periodEnd?: Date;
    used?: number;
    refused?: number;
  },
): Promise<EntitlementUsageRow> {
  const { adapter } = await getContext(auth);
  const rt = await getRuntime(auth);
  if (limitKind(rt.catalog, input.key) !== "metered") {
    throw new Error(`seedUsage: "${input.key}" isn't a metered limit`);
  }
  const definition = (rt.catalog.limits as Record<string, { period: string }>)[
    input.key
  ] as { period: string };
  const now = rt.now();
  const period = defaultUsagePeriod(definition.period, now);
  const periodStart = input.periodStart ?? period.start;
  const periodEnd = input.periodEnd ?? period.end;
  return adapter.create<Omit<EntitlementUsageRow, "id">, EntitlementUsageRow>({
    model: "entitlementUsage",
    data: {
      bucket: bucketKey(input.organizationId, input.key, periodStart),
      organizationId: input.organizationId,
      key: input.key,
      periodStart,
      periodEnd,
      used: input.used ?? 0,
      refused: input.refused ?? 0,
      createdAt: now,
      updatedAt: now,
    },
  });
}

// ---------------------------------------------------------------------------
// A fake billing source
// ---------------------------------------------------------------------------

export type FakeSource = BillingSource & {
  /** State per organization; missing = no subscription. */
  states: Map<string, BillingState | null>;
  /** Every `resolve` call, in order, with the adapter it was given. */
  calls: { organizationId: string; adapter: unknown }[];
  /** When set, `resolve` throws it. */
  failWith: unknown;
  /** `connect` calls so far. */
  connects: number;
  /** The `changed` callback from the last `connect`, or null. */
  changed: ((organizationId: string) => Promise<void>) | null;
};

/**
 * A `BillingSource` for tests: `resolve` returns a copy of
 * `states.get(organizationId)` (or null) and records the call; `failWith`
 * makes it throw. `connect: false` leaves `connect` out.
 */
export function fakeSource(
  options: { id?: string; connect?: boolean } = {},
): FakeSource {
  const source: FakeSource = {
    id: options.id ?? "fake",
    states: new Map(),
    calls: [],
    failWith: null,
    connects: 0,
    changed: null,
    resolve: async (organizationId, ctx) => {
      source.calls.push({ organizationId, adapter: ctx.adapter });
      if (source.failWith) throw source.failWith;
      const state = source.states.get(organizationId);
      return state ? { ...state } : null;
    },
  };
  if (options.connect !== false) {
    source.connect = (_context, changed) => {
      source.connects += 1;
      source.changed = changed;
    };
  }
  return source;
}
