import { queueAfterTransactionHook } from "@better-auth/core/context";
import type { ByoEvent, ByoEventHandler } from "@byo-oss/core";
import { getCurrentAdapter } from "better-auth";
import type { LimitValue } from "./catalog";
import type { OverrideKind } from "./schema";

/** Every event type entitlements emits through `onEvent`. */
export const ENTITLEMENTS_EVENT_TYPES = [
  "entitlements.plan.changed",
  "entitlements.override.set",
  "entitlements.override.removed",
  "entitlements.usage.limit_reached",
] as const;

export type EntitlementsEventType = (typeof ENTITLEMENTS_EVENT_TYPES)[number];

/** `data` per event type. Never a reason or other free text. */
export type EntitlementsEventData = {
  /** A write changed the resolved plan key. */
  "entitlements.plan.changed": {
    from: string;
    to: string;
    status: string | null;
  };
  /** An override was created or replaced. */
  "entitlements.override.set": {
    kind: OverrideKind;
    key: string;
    value: boolean | LimitValue | null;
    expiresAt: Date | null;
  };
  /** Staff removed an override (expiry emits nothing). */
  "entitlements.override.removed": { kind: OverrideKind; key: string };
  /** The first refusal of a metered key in a period. */
  "entitlements.usage.limit_reached": {
    key: string;
    limit: number;
    periodEnd: Date;
  };
};

type SubjectOf<T extends EntitlementsEventType> = T extends
  | "entitlements.override.set"
  | "entitlements.override.removed"
  ? { type: "entitlementOverride"; id: string }
  : { type: "organization"; id: string };

/**
 * An entitlements event: a `ByoEvent` with a typed `type`, `subject` and
 * `data`. `organizationId` is always set. `actorId` is the staff user for
 * overrides and `null` for syncs and usage.
 */
export type EntitlementsEvent<
  T extends EntitlementsEventType = EntitlementsEventType,
> = T extends EntitlementsEventType
  ? Omit<ByoEvent, "type" | "subject" | "data" | "organizationId"> & {
      type: T;
      organizationId: string;
      subject: SubjectOf<T>;
      data: EntitlementsEventData[T];
    }
  : never;

/**
 * Builds an event; subject the organization, or the override for
 * `override.*` (pass `overrideId`). Callers pass `occurredAt: rt.now()`, so
 * a test clock applies; the `new Date()` fallback is only for callers
 * without a runtime.
 */
export function entitlementsEvent<T extends EntitlementsEventType>(
  type: T,
  input: {
    organizationId: string;
    actorId: string | null;
    data: EntitlementsEventData[T];
    /** Required for `override.*` events: the override row's id. */
    overrideId?: string;
    /** Pass `rt.now()`. */
    occurredAt?: Date;
  },
): EntitlementsEvent<T> {
  const subject =
    type === "entitlements.override.set" ||
    type === "entitlements.override.removed"
      ? { type: "entitlementOverride", id: input.overrideId ?? "" }
      : { type: "organization", id: input.organizationId };
  return {
    type,
    occurredAt: input.occurredAt ?? new Date(),
    actorId: input.actorId,
    organizationId: input.organizationId,
    subject,
    data: input.data,
  } as unknown as EntitlementsEvent<T>;
}

/** Logger shape `emit` uses: better-auth's `context.logger` fits. */
export type EmitLogger = {
  error: (message: string, ...args: unknown[]) => void;
};

/**
 * Hands an event to `onEvent`, after the write that caused it commits.
 *
 * - `adapter` is the adapter the write used; without it, the runtime's
 *   current adapter (`getCurrentAdapter(context.adapter)`).
 * - A write made through the base adapter (`context.adapter`) is durable when
 *   it returns, so the handler runs now, awaited. So does every write on an
 *   adapter without real transactions, and a call without a context.
 * - A write that joined a caller's transaction (`runWithTransaction`) queues
 *   the handler with `queueAfterTransactionHook`: it runs once the
 *   transaction commits and is dropped if it rolls back.
 *
 * Never throws or rejects: the handler's error is caught and logged inside
 * the queued hook (an uncaught one would rethrow after the commit), `onError`
 * is passed as well, and a broken logger is ignored. The event is built
 * before queueing, so `occurredAt` is the time of the write.
 */
export async function emit(
  target: {
    options: { onEvent: ByoEventHandler | null };
    logger: EmitLogger;
    context?: { adapter: unknown } | null;
  },
  event: EntitlementsEvent,
  adapter?: unknown,
): Promise<void> {
  const handler = target.options.onEvent;
  if (!handler) return;
  const report = (error: unknown) => {
    try {
      target.logger.error(
        `[@byo-oss/entitlements] onEvent failed for ${event.type}`,
        error,
      );
    } catch {
      // a broken logger must not fail the call either
    }
  };
  const run = async () => {
    try {
      await handler(event as unknown as ByoEvent);
    } catch (error) {
      report(error);
    }
  };
  try {
    const base = target.context?.adapter;
    if (base === undefined) return await run();
    const used =
      adapter ??
      (await getCurrentAdapter(
        base as Parameters<typeof getCurrentAdapter>[0],
      ));
    if (used === base) await run();
    else
      await queueAfterTransactionHook(run, {
        onError: async (error) => report(error),
      });
  } catch (error) {
    report(error);
  }
}
