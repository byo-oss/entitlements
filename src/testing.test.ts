import type { DBTransactionAdapter } from "better-auth";
import { describe, expect, it, vi } from "vitest";
import {
  type AnyTestAuth,
  getRuntime,
  makeAuth,
  seedOrg,
  setSnapshot,
  takeStrictViolations,
} from "./test-utils";
import {
  type BillingSourceTestSetup,
  billingSourceCases,
  type TestBillingSourceOptions,
  testBillingSource,
} from "./testing/contract";
import { memorySource } from "./testing/memory-source";
import type { BillingSource, BillingState } from "./types";

const DAY_MS = 86_400_000;
const CTX = { adapter: {} as DBTransactionAdapter };

const paid = (planKey = "pro"): BillingState => ({
  planKey,
  status: "active",
  periodStart: new Date(Date.now() - 5 * DAY_MS),
  periodEnd: new Date(Date.now() + 25 * DAY_MS),
  cancelAtPeriodEnd: false,
  seats: 2,
  sourceRef: "sub_1",
});

// ---------------------------------------------------------------------------
// memorySource passes the contract suite
// ---------------------------------------------------------------------------

async function memorySetup(): Promise<BillingSourceTestSetup> {
  const source = memorySource();
  const auth = makeAuth({ options: { source } });
  const { organizationId } = await seedOrg(auth);
  return { source, auth, organizationId, setState: source.set };
}

async function memoryFailing() {
  const source = memorySource();
  source.setFailure(new Error("provider is down"));
  const auth = makeAuth({ options: { source } });
  const { organizationId } = await seedOrg(auth);
  return { source, auth, organizationId };
}

testBillingSource({
  name: "memorySource() passes testBillingSource",
  setup: memorySetup,
  failing: memoryFailing,
});

// ---------------------------------------------------------------------------
// memorySource itself
// ---------------------------------------------------------------------------

describe("memorySource()", () => {
  it("has an id, which defaults to memory", () => {
    expect(memorySource().id).toBe("memory");
    expect(memorySource({ id: "mine" }).id).toBe("mine");
  });

  it("resolves null for an organization it knows nothing about", async () => {
    expect(await memorySource().resolve("org_x", CTX)).toBeNull();
  });

  it("starts with the initial states, as copies", async () => {
    const state = paid();
    const source = memorySource({ initial: { a: state, b: null } });
    state.planKey = "changed";
    expect((await source.resolve("a", CTX))?.planKey).toBe("pro");
    expect(await source.resolve("b", CTX)).toBeNull();
  });

  it("stores and returns copies of a state, dates included", async () => {
    const source = memorySource();
    const state = paid();
    await source.set("a", state);
    const first = await source.resolve("a", CTX);
    expect(first).toEqual(state);
    expect(first).not.toBe(state);
    expect(first?.periodEnd).not.toBe(state.periodEnd);
    state.status = "canceled";
    state.periodEnd?.setTime(0);
    if (first) first.periodEnd?.setTime(0);
    const second = await source.resolve("a", CTX);
    expect(second?.status).toBe("active");
    expect(second?.periodEnd?.getTime()).toBeGreaterThan(Date.now());
  });

  it("keeps fields as given: an absent field stays absent", async () => {
    const source = memorySource();
    await source.set("a", { planKey: null, status: "canceled" });
    expect(await source.resolve("a", CTX)).toEqual({
      planKey: null,
      status: "canceled",
    });
  });

  it("clears a state with null", async () => {
    const source = memorySource({ initial: { a: paid() } });
    await source.set("a", null);
    expect(await source.resolve("a", CTX)).toBeNull();
  });

  it("setFailure makes resolve throw that error until it is cleared", async () => {
    const source = memorySource({ initial: { a: paid() } });
    const error = new Error("boom");
    source.setFailure(error);
    await expect(source.resolve("a", CTX)).rejects.toBe(error);
    await expect(source.resolve("other", CTX)).rejects.toBe(error);
    source.setFailure(null);
    expect((await source.resolve("a", CTX))?.planKey).toBe("pro");
  });

  it("set before connect only stores", async () => {
    const source = memorySource();
    await expect(source.set("a", paid())).resolves.toBeUndefined();
    expect((await source.resolve("a", CTX))?.planKey).toBe("pro");
  });

  it("connect stores changed, and set awaits it with the organization id", async () => {
    const source = memorySource();
    const order: string[] = [];
    const changed = vi.fn(async (organizationId: string) => {
      await Promise.resolve();
      order.push(`changed:${organizationId}`);
    });
    await source.connect?.({} as never, changed);
    await source.set("a", paid());
    order.push("set returned");
    expect(changed).toHaveBeenCalledExactlyOnceWith("a");
    expect(order).toEqual(["changed:a", "set returned"]);
  });

  it("set rethrows a rejection of changed as is", async () => {
    const source = memorySource();
    const failure = new Error("resync failed");
    await source.connect?.(
      {} as never,
      vi.fn(async () => {
        throw failure;
      }),
    );
    await expect(source.set("a", paid())).rejects.toBe(failure);
  });

  it("set resyncs through the plugin, and logs a failed resync once, in the plugin", async () => {
    const source = memorySource();
    const auth = makeAuth({ options: { source } });
    const { organizationId } = await seedOrg(auth);
    const rt = await getRuntime(auth);

    await source.set(organizationId, paid("team"));
    const state = await rt.cache.get(organizationId);
    expect(state?.result.plan.key).toBe("team");

    // an unknown organization: the resync throws; the plugin logs it, set doesn't
    const error = vi.spyOn(rt.logger, "error").mockImplementation(() => {});
    try {
      const rejection = await source.set("org_missing", paid()).then(
        () => null,
        (e: unknown) => e,
      );
      expect(rejection).toBeInstanceOf(Error);
      expect(String((rejection as Error).message)).toContain("not found");
      expect(error).toHaveBeenCalledTimes(1);
      expect(error.mock.calls[0]?.[1]).toBe(rejection);
    } finally {
      error.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// The suite fails against sources that break the contract (one fixture each)
// ---------------------------------------------------------------------------

type Fixture = {
  store: Map<string, BillingState | null>;
  source: BillingSource;
  changed: ((organizationId: string) => Promise<void>) | null;
  set(organizationId: string, state: BillingState | null): Promise<void>;
};

const copy = (state: BillingState | null | undefined): BillingState | null =>
  state
    ? {
        ...state,
        periodStart: state.periodStart ? new Date(state.periodStart) : null,
        periodEnd: state.periodEnd ? new Date(state.periodEnd) : null,
      }
    : null;

/** A correct push source over a map; each broken fixture patches one thing. */
function fixture(patch?: (fx: Fixture) => void): Fixture {
  const fx: Fixture = {
    store: new Map(),
    changed: null,
    source: {
      id: "fixture",
      resolve: async (organizationId) => copy(fx.store.get(organizationId)),
      connect: (_context, changed) => {
        fx.changed = changed;
      },
    },
    set: async (organizationId, state) => {
      fx.store.set(organizationId, copy(state));
      if (fx.changed) await fx.changed(organizationId);
    },
  };
  patch?.(fx);
  return fx;
}

async function setupFixture(
  patch?: (fx: Fixture) => void,
): Promise<BillingSourceTestSetup & { fx: Fixture }> {
  const fx = fixture(patch);
  const auth = makeAuth({ options: { source: fx.source } });
  const { organizationId } = await seedOrg(auth);
  return {
    source: fx.source,
    auth,
    organizationId,
    setState: (id, state) => fx.set(id, state),
    fx,
  };
}

/** A failing fixture: `resolve` throws unless the patch changes that. */
async function failingFixture(patch?: (fx: Fixture) => void) {
  const setup = await setupFixture((fx) => {
    fx.source.resolve = async () => {
      throw new Error("provider is down");
    };
    patch?.(fx);
  });
  return { ...setup, setState: undefined };
}

const CASES = {
  shape: "has the shape of a BillingSource",
  none: "resolves null for an organization with no state",
  given: "resolves the state it was given",
  context: "does not mutate the context it is given",
  copies: "returns copies and does not change the state it was given",
  failing: "rejects when it fails: the read is degraded and persists nothing",
  toNull: "going from a paid state to null falls back to defaultPlan",
  toNoEnd:
    "going from a paid state to a state without periodEnd falls back to defaultPlan",
  connect: "connect, when present, is awaited and changed triggers a resync",
} as const;

async function failedCases(
  options: TestBillingSourceOptions,
): Promise<string[]> {
  const failed: string[] = [];
  const spies = [
    vi.spyOn(console, "error").mockImplementation(() => {}),
    vi.spyOn(console, "warn").mockImplementation(() => {}),
  ];
  try {
    for (const { name, run } of billingSourceCases(options)) {
      try {
        await run();
      } catch {
        failed.push(name);
      }
      // a fixture can leave strict-adapter noise behind; that isn't under test
      takeStrictViolations();
    }
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
  return failed;
}

const brokenSetup = (patch: (fx: Fixture) => void) => ({
  setup: () => setupFixture(patch),
  failing: memoryFailing,
});

describe("testBillingSource against broken sources", () => {
  it("registers every check of the contract", () => {
    const names = billingSourceCases({
      setup: memorySetup,
      failing: memoryFailing,
    }).map((c) => c.name);
    expect(names).toEqual(Object.values(CASES));
  });

  it("passes for a correct push source", async () => {
    expect(await failedCases(brokenSetup(() => {}))).toEqual([]);
  }, 60_000);

  it("passes for a correct source without connect", async () => {
    const options = brokenSetup((fx) => {
      fx.source.connect = undefined;
    });
    expect(await failedCases(options)).toEqual([]);
  }, 60_000);

  it("passes for memorySource()", async () => {
    expect(
      await failedCases({ setup: memorySetup, failing: memoryFailing }),
    ).toEqual([]);
  }, 60_000);

  const broken: [
    string,
    (fx: Fixture) => void,
    (typeof CASES)[keyof typeof CASES],
  ][] = [
    [
      "resolve returns a plain value, not a promise",
      (fx) => {
        fx.source.resolve = ((id: string) =>
          copy(fx.store.get(id))) as unknown as BillingSource["resolve"];
      },
      CASES.shape,
    ],
    [
      "resolve answers undefined when it has no state",
      (fx) => {
        fx.source.resolve = async (id) =>
          copy(fx.store.get(id)) ?? (undefined as unknown as null);
      },
      CASES.none,
    ],
    [
      "resolve drops periodEnd",
      (fx) => {
        fx.source.resolve = async (id) => {
          const state = copy(fx.store.get(id));
          return state && { ...state, periodEnd: null };
        };
      },
      CASES.given,
    ],
    [
      "resolve writes to the context it is given",
      (fx) => {
        fx.source.resolve = async (id, ctx) => {
          (ctx as { adapter: unknown }).adapter = null;
          return copy(fx.store.get(id));
        };
      },
      CASES.context,
    ],
    [
      "resolve hands out the object it stores",
      (fx) => {
        fx.set = async (id, state) => {
          fx.store.set(id, state);
          if (fx.changed) await fx.changed(id);
        };
        fx.source.resolve = async (id) => fx.store.get(id) ?? null;
      },
      CASES.copies,
    ],
    [
      "going to null is ignored",
      (fx) => {
        const set = fx.set;
        fx.set = async (id, state) => {
          if (state !== null) await set(id, state);
        };
      },
      CASES.toNull,
    ],
    [
      "a new state is merged over the old one, keeping a stale periodEnd",
      (fx) => {
        fx.set = async (id, state) => {
          const previous = fx.store.get(id);
          fx.store.set(
            id,
            state && {
              ...(previous ?? { planKey: null, status: null }),
              ...state,
            },
          );
          if (fx.changed) await fx.changed(id);
        };
      },
      CASES.toNoEnd,
    ],
    [
      "resolve reads a copy taken at connect time",
      (fx) => {
        let view = new Map<string, BillingState | null>();
        fx.source.connect = (_context, changed) => {
          fx.changed = changed;
          view = new Map(fx.store);
        };
        fx.source.resolve = async (id) => copy(view.get(id));
      },
      CASES.connect,
    ],
  ];

  for (const [label, patch, expected] of broken) {
    it(`fails "${expected}" when ${label}`, async () => {
      const failed = await failedCases(brokenSetup(patch));
      expect(failed).toContain(expected);
    }, 60_000);
  }

  it(`fails "${CASES.failing}" when the failing source swallows its error`, async () => {
    const failed = await failedCases({
      setup: memorySetup,
      failing: () =>
        failingFixture((fx) => {
          fx.source.resolve = async () => null;
        }),
    });
    expect(failed).toContain(CASES.failing);
    expect(failed).toEqual([CASES.failing]);
  }, 60_000);

  it(`fails "${CASES.failing}" when the failing source writes a snapshot before it throws`, async () => {
    const failed = await failedCases({
      setup: memorySetup,
      failing: async () => {
        const holder: { auth?: AnyTestAuth } = {};
        const setup = await setupFixture((fx) => {
          fx.source.resolve = async (id) => {
            if (holder.auth) {
              await setSnapshot(holder.auth, id, { planKey: "pro" });
            }
            throw new Error("provider is down");
          };
        });
        holder.auth = setup.auth as unknown as AnyTestAuth;
        return setup;
      },
    });
    expect(failed).toEqual([CASES.failing]);
  }, 60_000);

  it("fails the failing check when the failing source does not fail", async () => {
    // a correct source: resolve answers, so nothing degrades
    const failed = await failedCases({
      setup: memorySetup,
      failing: () => setupFixture(),
    });
    expect(failed).toEqual([CASES.failing]);
  }, 60_000);

  it("does not leave strict adapter violations behind", () => {
    expect(takeStrictViolations()).toEqual([]);
  });
});
