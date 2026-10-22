import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { CUSTOMER, CUSTOMER_ORGANIZATION_ID, STAFF } from "../src/lib/constants.ts";

// The example's directory: the app runs here against ./e2e.db (e2e.config.ts).
const root = fileURLToPath(new URL("../", import.meta.url));
const dbPath = `${root}e2e.db`;
const exportPath = `${root}.e2e/entitlements-export.json`;

test(
  "a Free org sees the gate, a staff override unlocks it, usage past the limit is refused, checkout moves it to Pro, export and uninstall run",
  { timeout: 120_000 },
  async ({ app, screen }) => {
    const signIn = async (user: { email: string; password: string }) => {
      await app.open("/");
      await screen.getByLabel("Email").fill(user.email);
      await screen.getByLabel("Password").fill(user.password);
      await screen.getByRole("button", "Sign in").tap();
      await expect(screen.getByTestId("whoami")).toHaveText(user.email);
    };
    const signOut = () => screen.getByRole("button", "Sign out").tap();

    // customer: the source has no billing state for the org (read-through writes a
    // snapshot with none), so it's on Free and the gate shows its fallback
    await signIn(CUSTOMER);
    await screen.getByRole("link", "Plan").tap();
    await expect(screen.getByTestId("plan-name")).toHaveText("Free");
    await expect(screen.getByTestId("limit-apiCalls")).toHaveText("3");
    await expect(screen.getByTestId("exports-locked")).toContainText("Upgrade to pro");
    await expect(screen.getByRole("button", "Export data")).toBeHidden();
    await expect(screen.getByText("0 of 3 API calls used this month")).toBeVisible();
    // read-through: that first read resolved from the source and wrote a snapshot with no plan
    const readThrough = new DatabaseSync(dbPath, { readOnly: true });
    const snapshotRows = readThrough
      .prepare('select source, planKey from "entitlementSnapshot" where organizationId = ?')
      .all(CUSTOMER_ORGANIZATION_ID);
    readThrough.close();
    expect(snapshotRows.map((row) => ({ ...row }))).toEqual([{ source: "demo", planKey: null }]);
    await signOut();

    // staff: set a feature override on the customer's org
    await signIn(STAFF);
    await screen.getByRole("link", "Staff").tap();
    await expect(screen.getByTestId("feature-exports")).toHaveText("exports: off");
    await screen.getByLabel("Reason").fill("Trial of exports");
    await screen.getByRole("button", "Set override").tap();
    await expect(screen.getByRole("button", "Remove exports override")).toBeVisible();
    await expect(screen.getByTestId("feature-exports")).toHaveText("exports: on");
    await signOut();

    // customer: the feature is unlocked, in the UI and on the server (`hasFeature`)
    await signIn(CUSTOMER);
    await screen.getByRole("link", "Plan").tap();
    await expect(screen.getByTestId("plan-name")).toHaveText("Free");
    await expect(screen.getByTestId("exports-locked")).toBeHidden();
    await screen.getByRole("button", "Export data").tap();
    await expect(screen.getByText("Export started.")).toBeVisible();

    // consuming past Free's 3 API calls a month: the 4th call is refused
    for (const left of [2, 1, 0]) {
      await screen.getByRole("button", "Call the API").tap();
      await expect(screen.getByText(`Call accepted: ${left} left.`)).toBeVisible();
    }
    await expect(screen.getByText("3 of 3 API calls used this month")).toBeVisible();
    await screen.getByRole("button", "Call the API").tap();
    await expect(
      screen.getByText(/^Refused \(limit_reached\): 3 of 3 API calls used\. Upgrade to pro/),
    ).toBeVisible();
    // a refusal is never counted
    await expect(screen.getByText("3 of 3 API calls used this month")).toBeVisible();
    await signOut();

    // staff: remove the override; the feature is off again
    await signIn(STAFF);
    await screen.getByRole("link", "Staff").tap();
    await screen.getByRole("button", "Remove exports override").tap();
    await expect(screen.getByText("No active overrides.")).toBeVisible();
    await expect(screen.getByTestId("feature-exports")).toHaveText("exports: off");
    await signOut();

    // customer: a checkout moves the org to Pro; the source's `changed` resyncs the
    // snapshot and the page's `refresh()` (refreshEntitlements) shows the new plan
    await signIn(CUSTOMER);
    await screen.getByRole("link", "Plan").tap();
    await expect(screen.getByTestId("plan-name")).toHaveText("Free");
    await screen.getByRole("button", "Simulate checkout to Pro").tap();
    await expect(screen.getByTestId("plan-name")).toHaveText("Pro");
    await expect(screen.getByTestId("limit-apiCalls")).toHaveText("10000");
    await expect(screen.getByText("3 of 10,000 API calls used this month")).toBeVisible();
    await expect(screen.getByTestId("exports-locked")).toBeHidden();
    await expect(screen.getByRole("button", "Export data")).toBeVisible();

    // the exit path: export every org's rows, then drop the three tables
    const output = execFileSync(
      process.execPath,
      ["scripts/export-and-uninstall.ts"],
      {
        cwd: root,
        env: { ...process.env, DB_PATH: dbPath, EXPORT_PATH: exportPath },
        encoding: "utf8",
      },
    );
    // one snapshot row: the customer's, written by read-through and resynced to Pro
    expect(output).toContain("1 snapshots, 1 overrides, 1 usage rows");
    expect(output).toContain(
      "dropped 3 tables: entitlementUsage, entitlementOverride, entitlementSnapshot",
    );

    const exported = JSON.parse(readFileSync(exportPath, "utf8")) as {
      organizations: {
        id: string;
        snapshots: { source: string; planKey: string | null; status: string | null }[];
        overrides: { key: string; status: string; createdByEmail: string | null }[];
        usage: { key: string; used: number; refused: number }[];
      }[];
    };
    const customer = exported.organizations.find(
      (organization) => organization.id === CUSTOMER_ORGANIZATION_ID,
    );
    expect(
      customer?.snapshots.map(({ source, planKey, status }) => ({ source, planKey, status })),
    ).toEqual([{ source: "demo", planKey: "pro", status: "active" }]);
    expect(
      customer?.overrides.map(({ key, status, createdByEmail }) => ({
        key,
        status,
        createdByEmail,
      })),
    ).toEqual([{ key: "exports", status: "removed", createdByEmail: STAFF.email }]);
    expect(
      customer?.usage.map(({ key, used, refused }) => ({ key, used, refused })),
    ).toEqual([{ key: "apiCalls", used: 3, refused: 1 }]);

    const db = new DatabaseSync(dbPath, { readOnly: true });
    const tables = db
      .prepare("select name from sqlite_master where type = 'table' and name like 'entitlement%'")
      .all();
    const authTables = db
      .prepare("select name from sqlite_master where type = 'table' and name in ('user', 'organization', 'member')")
      .all();
    db.close();
    expect(tables).toEqual([]);
    // better-auth's own tables stay
    expect(authTables).toHaveLength(3);
  },
);
