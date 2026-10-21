import { type DBTransactionAdapter, getCurrentAdapter } from "better-auth";
import { type EntitlementsRuntime, requireContext } from "./runtime";

/**
 * The adapter every read and write goes through:
 * `getCurrentAdapter(context.adapter)`, so a call made inside the app's
 * `runWithTransaction` uses that transaction. Resolve it once per operation
 * and pass it down (and to `source.resolve`).
 */
export function currentAdapter(
  rt: EntitlementsRuntime,
): Promise<DBTransactionAdapter> {
  return getCurrentAdapter(requireContext(rt).adapter);
}

/**
 * Whether the call runs inside a real transaction:
 * `getCurrentAdapter(context.adapter) !== context.adapter`. better-auth runs
 * each request under `runWithAdapter(context.adapter)` and
 * `runWithTransaction` swaps in the transaction adapter, so the two differ
 * exactly inside a transaction. On an adapter without real transactions
 * (`transaction(cb)` is `cb(adapter)`) this reads `false`, which is safe:
 * there is nothing to wait on or roll back.
 */
export async function inTransaction(rt: EntitlementsRuntime): Promise<boolean> {
  const base = requireContext(rt).adapter;
  return (await getCurrentAdapter(base)) !== base;
}

/**
 * Throws `[@byo-oss/entitlements] <name> must run outside a transaction`
 * when called inside one (`consumeUsage`, `sync`, `refreshEntitlements`).
 */
export async function assertOutsideTransaction(
  rt: EntitlementsRuntime,
  name: string,
): Promise<void> {
  if (await inTransaction(rt)) {
    throw new Error(
      `[@byo-oss/entitlements] ${name} must run outside a transaction`,
    );
  }
}
