import { describe, it, expect } from "vitest";
import { toFatSecretDate, fromFatSecretDate } from "./date";

describe("toFatSecretDate / fromFatSecretDate", () => {
  it("converts the epoch itself to day 0", () => {
    expect(toFatSecretDate("1970-01-01")).toBe(0);
    expect(fromFatSecretDate(0)).toBe("1970-01-01");
  });

  it("round-trips a known date", () => {
    const days = toFatSecretDate("2026-08-17");
    expect(fromFatSecretDate(days)).toBe("2026-08-17");
  });

  it("defaults to today when no date is given", () => {
    const today = new Date().toISOString().slice(0, 10);
    expect(fromFatSecretDate(toFatSecretDate())).toBe(today);
  });

  it("throws on an invalid date string", () => {
    expect(() => toFatSecretDate("not-a-date")).toThrow(/Invalid date/);
  });
});
