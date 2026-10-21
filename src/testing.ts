/**
 * `@byo-oss/entitlements/testing` (ESM only; `vitest` is an optional peer):
 * the `BillingSource` contract suite and a settable in-memory source.
 */
export {
  type BillingSourceTestSetup,
  type TestBillingSourceOptions,
  testBillingSource,
} from "./testing/contract";
export {
  type MemorySource,
  type MemorySourceOptions,
  memorySource,
} from "./testing/memory-source";
