import {
  EntitlementGate,
  UsageMeter,
  useEntitlements,
} from "@byo-oss/entitlements/react";
import type { LimitKey } from "@byo-oss/entitlements/catalog";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { callApi, exportData, simulateCheckout } from "../lib/actions";
import { authClient } from "../lib/auth-client";
import { type AppCatalog, catalog, meteredKeys } from "../lib/catalog";
import { CUSTOMER_ORGANIZATION_ID } from "../lib/constants";

export const Route = createFileRoute("/plan")({ component: PlanPage });

const limitKeys = Object.keys(catalog.limits) as LimitKey<AppCatalog>[];

// The customer page: the organization's plan, usage and a gated feature.
function PlanPage() {
  const { data: session, isPending } = authClient.useSession();
  if (isPending) return null;
  if (!session) return <p>Sign in to see your plan.</p>;
  // A real app reads the active organization; the example has one customer.
  return <Plan organizationId={CUSTOMER_ORGANIZATION_ID} />;
}

function Plan({ organizationId }: { organizationId: string }) {
  const entitlements = useEntitlements<AppCatalog>({
    client: authClient,
    organizationId,
  });
  const [apiMessage, setApiMessage] = useState<string | null>(null);
  const [exportMessage, setExportMessage] = useState<string | null>(null);

  if (entitlements.error && !entitlements.data) {
    return <p role="alert">Couldn't load the plan: {entitlements.error.message}</p>;
  }
  const plan = entitlements.data?.plan;

  return (
    <div style={{ display: "grid", gap: 24, maxWidth: 560 }}>
      <section>
        <h1>Plan</h1>
        <p data-testid="plan-name">
          {plan ? String(plan.display.name ?? plan.key) : "Loading plan"}
        </p>
        <table>
          <tbody>
            {limitKeys.map((key) => (
              <tr key={key}>
                <th scope="row" style={{ textAlign: "left", paddingRight: 16 }}>
                  {key}
                </th>
                <td data-testid={`limit-${key}`}>{String(entitlements.limit(key) ?? "…")}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {plan?.key === "pro" ? null : (
          <button
            type="button"
            onClick={async () => {
              await simulateCheckout({ data: { organizationId } });
              await entitlements.refresh();
            }}
          >
            Simulate checkout to Pro
          </button>
        )}
      </section>

      <section style={{ display: "grid", gap: 8 }}>
        <h2>Usage</h2>
        {meteredKeys.map((key) => (
          <UsageMeter
            key={key}
            entitlements={entitlements}
            limitKey={key}
            catalog={catalog}
          />
        ))}
        <div>
          <button
            type="button"
            onClick={async () => {
              const result = await callApi({ data: { organizationId } });
              setApiMessage(
                result.allowed
                  ? `Call accepted: ${result.remaining} left.`
                  : `Refused (${result.reason}): ${result.used} of ${result.limit} API calls used. ` +
                      `Upgrade to ${result.upgradeTo.join(" or ")} for more.`,
              );
              await entitlements.refresh();
            }}
          >
            Call the API
          </button>
          {apiMessage ? <p role="status">{apiMessage}</p> : null}
        </div>
      </section>

      <section>
        <h2>Exports</h2>
        <EntitlementGate
          entitlements={entitlements}
          feature="exports"
          catalog={catalog}
          fallback={({ isLoading, upgradeTo }) =>
            isLoading ? (
              <p>Checking your plan…</p>
            ) : (
              <p data-testid="exports-locked">
                Exports aren't on your plan. Upgrade to {upgradeTo.join(" or ")} to
                export your data.
              </p>
            )
          }
        >
          <button
            type="button"
            onClick={async () => {
              const result = await exportData({ data: { organizationId } });
              setExportMessage(
                result.allowed ? "Export started." : `Export refused (${result.reason}).`,
              );
            }}
          >
            Export data
          </button>
          {exportMessage ? <p role="status">{exportMessage}</p> : null}
        </EntitlementGate>
      </section>
    </div>
  );
}
