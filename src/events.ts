import type { ByoEvent, ByoEventHandler } from "@byo-oss/core";
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
 * Hands an event to `onEvent`. Awaits the handler, catches and logs anything
 * it throws, and never throws itself, so a consumer can't fail the call that
 * caused the event.
 */
export async function emit(
  target: {
    options: { onEvent: ByoEventHandler | null };
    logger: EmitLogger;
  },
  event: EntitlementsEvent,
): Promise<void> {
  const handler = target.options.onEvent;
  if (!handler) return;
  try {
    await handler(event as unknown as ByoEvent);
  } catch (error) {
    try {
      target.logger.error(
        `[@byo-oss/entitlements] onEvent failed for ${event.type}`,
        error,
      );
    } catch {
      // a broken logger must not fail the call either
    }
  }
}
