import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  getFoodDiary,
  getFavoriteFoods,
  getMostEatenFoods,
  getRecentlyEatenFoods,
  createFoodDiaryEntry,
  updateFoodDiaryEntry,
  deleteFoodDiaryEntry,
} from "./diary";

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

describe("getFoodDiary", () => {
  it("returns an empty list when FatSecret reports an empty day (food_entries: '')", async () => {
    stubApi((params) => {
      expect(params.get("method")).toBe("food_entries.get");
      expect(params.get("date")).toBeTruthy();
      return new Response(JSON.stringify({ food_entries: "" }), { status: 200 });
    });
    expect(await getFoodDiary("2026-08-17")).toEqual({ entries: [] });
  });

  it("normalizes a single entry and converts numeric fields", async () => {
    stubApi(
      () =>
        new Response(
          JSON.stringify({
            food_entries: {
              food_entry: {
                food_entry_id: "1001",
                food_entry_name: "Banana",
                food_id: "1",
                serving_id: "100",
                number_of_units: "1.000",
                meal: "breakfast",
                date_int: "20678",
                calories: "89",
                carbohydrate: "22.84",
                protein: "1.09",
                fat: "0.33",
              },
            },
          }),
          { status: 200 }
        )
    );

    const diary = await getFoodDiary("2026-08-17");
    expect(diary.entries).toEqual([
      {
        foodEntryId: "1001",
        name: "Banana",
        foodId: "1",
        servingId: "100",
        numberOfUnits: 1,
        meal: "breakfast",
        dateDaysSinceEpoch: 20678,
        calories: 89,
        carbohydrateG: 22.84,
        proteinG: 1.09,
        fatG: 0.33,
      },
    ]);
  });
});

describe("getFavoriteFoods / getMostEatenFoods / getRecentlyEatenFoods", () => {
  it("getFavoriteFoods normalizes foods_favorite.food", async () => {
    stubApi((params) => {
      expect(params.get("method")).toBe("foods.get_favorites");
      return new Response(
        JSON.stringify({
          foods_favorite: {
            food: {
              food_id: "1",
              food_name: "Banana",
              food_type: "Generic",
              food_url: "https://example.com/banana",
              food_description: "Per 100g - Calories: 89kcal",
            },
          },
        }),
        { status: 200 }
      );
    });
    const result = await getFavoriteFoods();
    expect(result.foods).toHaveLength(1);
    expect(result.foods[0].foodId).toBe("1");
  });

  it("getMostEatenFoods passes the optional meal filter and handles an empty response", async () => {
    stubApi((params) => {
      expect(params.get("method")).toBe("foods.get_most_eaten");
      expect(params.get("meal")).toBe("lunch");
      return new Response(JSON.stringify({ foods_most_eaten: "" }), { status: 200 });
    });
    expect(await getMostEatenFoods("lunch")).toEqual({ foods: [] });
  });

  it("getRecentlyEatenFoods works with no meal filter", async () => {
    stubApi((params) => {
      expect(params.get("method")).toBe("foods.get_recently_eaten");
      expect(params.has("meal")).toBe(false);
      return new Response(JSON.stringify({ foods_recently_eaten: "" }), { status: 200 });
    });
    expect(await getRecentlyEatenFoods()).toEqual({ foods: [] });
  });
});

describe("createFoodDiaryEntry / updateFoodDiaryEntry / deleteFoodDiaryEntry", () => {
  it("createFoodDiaryEntry sends the right params and unwraps a bare-string id", async () => {
    stubApi((params) => {
      expect(params.get("method")).toBe("food_entry.create");
      expect(params.get("food_id")).toBe("1");
      expect(params.get("serving_id")).toBe("100");
      expect(params.get("quantity")).toBe("1.5");
      expect(params.get("meal")).toBe("lunch");
      return new Response(JSON.stringify({ food_entry_id: "5555" }), { status: 200 });
    });
    const result = await createFoodDiaryEntry({
      foodId: "1",
      servingId: "100",
      quantity: 1.5,
      meal: "lunch",
      date: "2026-08-17",
    });
    expect(result).toEqual({ foodEntryId: "5555" });
  });

  it("createFoodDiaryEntry unwraps a { value } wrapped id", async () => {
    stubApi(
      () => new Response(JSON.stringify({ food_entry_id: { value: "5556" } }), { status: 200 })
    );
    const result = await createFoodDiaryEntry({
      foodId: "1",
      servingId: "100",
      quantity: 1,
      meal: "dinner",
    });
    expect(result).toEqual({ foodEntryId: "5556" });
  });

  it("updateFoodDiaryEntry only sends the provided fields (others omitted, not empty-string)", async () => {
    stubApi((params) => {
      expect(params.get("method")).toBe("food_entry.edit");
      expect(params.get("food_entry_id")).toBe("5555");
      expect(params.get("quantity")).toBe("2");
      expect(params.has("food_id")).toBe(false);
      expect(params.has("serving_id")).toBe(false);
      expect(params.has("meal")).toBe(false);
      return new Response(JSON.stringify({ food_entry_id: "5555" }), { status: 200 });
    });
    await updateFoodDiaryEntry("5555", { quantity: 2 });
  });

  it("deleteFoodDiaryEntry sends food_entry_id and reports success", async () => {
    stubApi((params) => {
      expect(params.get("method")).toBe("food_entry.delete");
      expect(params.get("food_entry_id")).toBe("5555");
      return new Response(JSON.stringify({}), { status: 200 });
    });
    expect(await deleteFoodDiaryEntry("5555")).toEqual({ deleted: true, foodEntryId: "5555" });
  });
});
