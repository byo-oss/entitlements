import type { EntitlementOverride } from "@byo-oss/entitlements/client";
import { useEntitlements } from "@byo-oss/entitlements/react";
import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { authClient } from "../lib/auth-client";
import { type AppCatalog, catalog } from "../lib/catalog";
import { CUSTOMER_ORGANIZATION_ID } from "../lib/constants";

export const Route = createFileRoute("/staff")({ component: StaffPage });

type Feature = AppCatalog["features"][number];
// The fields the list shows (dates arrive as strings, so they are left out).
type OverrideRow = Pick<EntitlementOverride, "id" | "kind" | "key" | "value" | "reason">;

// The staff page: members of the staff organization with
// `entitlements: ["override"]` set and remove overrides on a customer org.
function StaffPage() {
  const { data: session, isPending } = authClient.useSession();
  if (isPending) return null;
  if (!session) return <p>Sign in as staff.</p>;
  return <Overrides organizationId={CUSTOMER_ORGANIZATION_ID} />;
}

function Overrides({ organizationId }: { organizationId: string }) {
  // Staff read a customer's entitlements through the staff organization.
  const entitlements = useEntitlements<AppCatalog>({
    client: authClient,
    organizationId,
  });
  const [overrides, setOverrides] = useState<OverrideRow[]>([]);
  const [feature, setFeature] = useState<Feature>("exports");
  const [enabled, setEnabled] = useState(true);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  const loadOverrides = useCallback(async () => {
    const { data, error } = await authClient.entitlements.overrides({
      query: { organizationId, status: "active" },
    });
    if (error) {
      setError(error.message ?? `Request failed (${error.status})`);
      return;
    }
    setOverrides(data.overrides);
  }, [organizationId]);

  useEffect(() => {
    void loadOverrides();
  }, [loadOverrides]);

  const reload = async () => {
    await loadOverrides();
    await entitlements.refresh();
  };

  return (
    <div style={{ display: "grid", gap: 24, maxWidth: 640 }}>
      <section>
        <h1>Staff</h1>
        <p>
          Organization <code>{organizationId}</code> is on{" "}
          <strong data-testid="staff-plan">
            {entitlements.data?.plan.key ?? "…"}
          </strong>
          .
        </p>
        <ul>
          {catalog.features.map((key) => (
            <li key={key} data-testid={`feature-${key}`}>
              {key}: {entitlements.hasFeature(key) ? "on" : "off"}
            </li>
          ))}
        </ul>
      </section>

      <form
        style={{ display: "grid", gap: 8, maxWidth: 360 }}
        onSubmit={async (event) => {
          event.preventDefault();
          const { error } = await authClient.entitlements.override.set({
            organizationId,
            kind: "feature",
            key: feature,
            value: enabled,
            reason,
          });
          setError(error ? (error.message ?? `Request failed (${error.status})`) : null);
          if (!error) {
            setReason("");
            await reload();
          }
        }}
      >
        <h2>Set a feature override</h2>
        <label>
          Feature
          <select
            value={feature}
            onChange={(e) => setFeature(e.target.value as Feature)}
          >
            {catalog.features.map((key) => (
              <option key={key} value={key}>
                {key}
              </option>
            ))}
          </select>
        </label>
        <label>
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          Enabled
        </label>
        <label>
          Reason
          <input value={reason} onChange={(e) => setReason(e.target.value)} required />
        </label>
        <button type="submit">Set override</button>
        {error ? <p role="alert">{error}</p> : null}
      </form>

      <section>
        <h2>Active overrides</h2>
        {overrides.length === 0 ? (
          <p>No active overrides.</p>
        ) : (
          <ul>
            {overrides.map((override) => (
              <li key={override.id}>
                {override.kind} {override.key} = {JSON.stringify(override.value)} (
                {override.reason}){" "}
                <button
                  type="button"
                  onClick={async () => {
                    const { error } = await authClient.entitlements.override.remove({
                      id: override.id,
                    });
                    setError(
                      error ? (error.message ?? `Request failed (${error.status})`) : null,
                    );
                    if (!error) await reload();
                  }}
                >
                  Remove {override.key} override
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
