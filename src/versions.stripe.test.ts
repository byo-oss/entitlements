import { describe, expect, it } from "vitest";
import { assertLoadedVersions } from "./test-versions";

const expected = process.env.BYO_EXPECT_BA as string;
// a version that differs from the one this lane expects
const other =
  expected !== "1.7.7" ? "1.7.7" : (process.env.BYO_ROOT_BA as string);

describe("loaded versions (stripe lane)", () => {
  it(`loads better-auth ${expected}`, () => {
    expect(expected).toBeTruthy();
    expect(() =>
      assertLoadedVersions(undefined, { stripe: true }),
    ).not.toThrow();
  });

  it("fails when a different version is expected", () => {
    expect(() => assertLoadedVersions(other, { stripe: true })).toThrow(
      expected,
    );
  });
});
