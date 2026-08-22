import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getProfile } from "./profile";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  process.env.FATSECRET_CONSUMER_KEY = "ck";
  process.env.FATSECRET_CONSUMER_SECRET = "cs";
  process.env.FATSECRET_ACCESS_TOKEN = "tok";
  process.env.FATSECRET_ACCESS_TOKEN_SECRET = "ts";
});

afterEach(() => {
  vi.unstubAllGlobals();
  process.env = { ...ORIGINAL_ENV };
});

describe("getProfile", () => {
  it("converts numeric-string fields and keeps the raw profile for anything else", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        expect(url).toBe("https://platform.fatsecret.com/rest/server.api");
        const params = new URLSearchParams(init.body as string);
        expect(params.get("method")).toBe("profile.get");
        return new Response(
          JSON.stringify({
            profile: {
              last_weight_kg: "70.5",
              last_weight_date_int: "20678",
              weight_measure: "Kg",
              height_cm: "176.00",
              height_measure: "Cm",
              goal_weight_kg: "65.0",
            },
          }),
          { status: 200 }
        );
      })
    );

    const profile = await getProfile();
    expect(profile.lastWeightKg).toBe(70.5);
    expect(profile.lastWeightDateDaysSinceEpoch).toBe(20678);
    // Confirmed against a real account: weight_measure/height_measure come
    // back capitalized ("Kg"/"Cm"), not lowercase — passed through as-is.
    expect(profile.weightMeasure).toBe("Kg");
    expect(profile.heightCm).toBe(176);
    expect(profile.heightMeasure).toBe("Cm");
    expect(profile.goalWeightKg).toBe(65.0);
    expect(profile.raw).toMatchObject({ last_weight_kg: "70.5" });
  });

  it("handles missing optional fields gracefully", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ profile: {} }), { status: 200 }))
    );
    const profile = await getProfile();
    expect(profile.lastWeightKg).toBeNull();
    expect(profile.heightCm).toBeNull();
    expect(profile.goalWeightKg).toBeNull();
  });
});
