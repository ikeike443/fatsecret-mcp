import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getWeightHistory, updateWeight } from "./weight";
import { toFatSecretDate } from "./date";

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

function stubApi(responder: (params: URLSearchParams) => Response) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("https://platform.fatsecret.com/rest/server.api");
      return responder(new URLSearchParams(init.body as string));
    })
  );
}

describe("getWeightHistory", () => {
  it("calls weights.get_month.v2 and normalizes a single day into a list, converting date_int back to ISO", async () => {
    stubApi((params) => {
      expect(params.get("method")).toBe("weights.get_month.v2");
      return new Response(
        JSON.stringify({
          month: {
            day: {
              date_int: String(toFatSecretDate("2026-08-17")),
              weight_kg: "70.5",
              weight_comment: "morning",
            },
          },
        }),
        { status: 200 }
      );
    });
    const history = await getWeightHistory("2026-08-17");
    expect(history.entries).toEqual([{ date: "2026-08-17", weightKg: 70.5, comment: "morning" }]);
  });

  it("handles multiple days and a missing comment", async () => {
    stubApi(
      () =>
        new Response(
          JSON.stringify({
            month: {
              day: [
                { date_int: "20677", weight_kg: "71.0" },
                { date_int: "20678", weight_kg: "70.5" },
              ],
            },
          }),
          { status: 200 }
        )
    );
    const history = await getWeightHistory();
    expect(history.entries.map((e) => e.weightKg)).toEqual([71.0, 70.5]);
    expect(history.entries[0].comment).toBeNull();
  });
});

describe("updateWeight", () => {
  it("sends weight_type=kg and omits height/goal fields when not provided", async () => {
    stubApi((params) => {
      expect(params.get("method")).toBe("weight.update");
      expect(params.get("current_weight_kg")).toBe("70.5");
      expect(params.get("weight_type")).toBe("kg");
      expect(params.has("current_height_cm")).toBe(false);
      expect(params.has("height_type")).toBe(false);
      expect(params.has("goal_weight_kg")).toBe(false);
      return new Response(JSON.stringify({}), { status: 200 });
    });
    const result = await updateWeight({ weightKg: 70.5, date: "2026-08-17" });
    expect(result.updated).toBe(true);
    expect(result.weightKg).toBe(70.5);
  });

  it("includes height_type=cm only when heightCm is provided", async () => {
    stubApi((params) => {
      expect(params.get("current_height_cm")).toBe("175");
      expect(params.get("height_type")).toBe("cm");
      expect(params.get("goal_weight_kg")).toBe("65");
      return new Response(JSON.stringify({}), { status: 200 });
    });
    await updateWeight({ weightKg: 70.5, heightCm: 175, goalWeightKg: 65 });
  });
});
