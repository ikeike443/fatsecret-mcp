import { describe, it, expect } from "vitest";
import { timingSafeEqualStrings } from "./timingSafeEqualStrings";

describe("timingSafeEqualStrings", () => {
  it("returns true for identical strings", () => {
    expect(timingSafeEqualStrings("abc123", "abc123")).toBe(true);
  });

  it("returns false for different strings of the same length", () => {
    expect(timingSafeEqualStrings("abc123", "xyz789")).toBe(false);
  });

  it("returns false for strings of different lengths", () => {
    expect(timingSafeEqualStrings("short", "a-much-longer-string")).toBe(false);
  });

  it("returns false when compared against an empty string", () => {
    expect(timingSafeEqualStrings("abc123", "")).toBe(false);
  });
});
