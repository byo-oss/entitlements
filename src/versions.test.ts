import { describe, expect, it } from "vitest";
import { assertLoadedVersions } from "./test-versions";

const expected = process.env.BYO_EXPECT_BA as string;
// a version no lane loads, so it always differs from the one expected
const other = "0.0.0";

describe("loaded versions (memory lane)", () => {
  it(`loads better-auth ${expected}`, () => {
    expect(expected).toBeTruthy();
    expect(() => assertLoadedVersions()).not.toThrow();
  });

  it("fails when a different version is expected", () => {
    expect(() => assertLoadedVersions(other)).toThrow(expected);
  });
});
