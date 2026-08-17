import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { _resetAppAccessTokenCacheForTests } from "./appAuth";
import {
  asArray,
  searchFoods,
  getFoodDetail,
  searchRecipes,
  getRecipeDetail,
  findFoodByBarcode,
} from "./foods";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  process.env.FATSECRET_CLIENT_ID = "test-client-id";
  process.env.FATSECRET_CLIENT_SECRET = "test-client-secret";
  _resetAppAccessTokenCacheForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
  process.env = { ...ORIGINAL_ENV };
});

function tokenResponse() {
  return new Response(
    JSON.stringify({ access_token: "app-token", token_type: "Bearer", expires_in: 86400 }),
    { status: 200 }
  );
}

/** Stubs fetch: the OAuth2 token endpoint always succeeds; everything else is handed to apiResponder. */
function stubApi(apiResponder: (params: URLSearchParams) => Response) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      if (url === "https://oauth.fatsecret.com/connect/token") return tokenResponse();
      expect(url).toBe("https://platform.fatsecret.com/rest/server.api");
      return apiResponder(new URLSearchParams(init.body as string));
    })
  );
}

describe("asArray", () => {
  it("normalizes undefined/null, a single item, and an array", () => {
    expect(asArray(undefined)).toEqual([]);
    expect(asArray(null)).toEqual([]);
    expect(asArray("x")).toEqual(["x"]);
    expect(asArray(["x", "y"])).toEqual(["x", "y"]);
  });
});

describe("searchFoods", () => {
  it("normalizes a single-result response (object, not array) into a one-item list", async () => {
    stubApi((params) => {
      expect(params.get("method")).toBe("foods.search");
      expect(params.get("search_expression")).toBe("banana");
      return new Response(
        JSON.stringify({
          foods: {
            food: {
              food_id: "1",
              food_name: "Banana",
              food_type: "Generic",
              food_url: "https://example.com/banana",
              food_description: "Per 100g - Calories: 89kcal",
            },
            max_results: "20",
            total_results: "1",
            page_number: "0",
          },
        }),
        { status: 200 }
      );
    });

    const result = await searchFoods("banana");
    expect(result.totalResults).toBe(1);
    expect(result.foods).toEqual([
      {
        foodId: "1",
        name: "Banana",
        type: "Generic",
        brandName: null,
        description: "Per 100g - Calories: 89kcal",
        url: "https://example.com/banana",
      },
    ]);
  });

  it("normalizes a multi-result response (array) unchanged", async () => {
    stubApi(
      () =>
        new Response(
          JSON.stringify({
            foods: {
              food: [
                {
                  food_id: "1",
                  food_name: "Apple",
                  food_type: "Generic",
                  food_url: "https://example.com/apple",
                  food_description: "Per 100g - Calories: 52kcal",
                },
                {
                  food_id: "2",
                  food_name: "Apple Pie",
                  food_type: "Generic",
                  food_url: "https://example.com/apple-pie",
                  brand_name: "Grandma's",
                  food_description: "Per slice - Calories: 296kcal",
                },
              ],
              max_results: "20",
              total_results: "2",
              page_number: "0",
            },
          }),
          { status: 200 }
        )
    );

    const result = await searchFoods("apple");
    expect(result.foods.map((f) => f.foodId)).toEqual(["1", "2"]);
    expect(result.foods[1].brandName).toBe("Grandma's");
  });
});

describe("getFoodDetail", () => {
  it("converts numeric-string nutrition fields to numbers and normalizes servings", async () => {
    stubApi((params) => {
      expect(params.get("method")).toBe("food.get.v4");
      expect(params.get("food_id")).toBe("42");
      return new Response(
        JSON.stringify({
          food: {
            food_id: "42",
            food_name: "Chicken Breast",
            food_type: "Generic",
            food_url: "https://example.com/chicken",
            servings: {
              serving: {
                serving_id: "100",
                serving_description: "100 g",
                metric_serving_amount: "100.000",
                metric_serving_unit: "g",
                calories: "165",
                carbohydrate: "0.00",
                protein: "31.00",
                fat: "3.60",
                sodium: "74",
              },
            },
          },
        }),
        { status: 200 }
      );
    });

    const food = await getFoodDetail("42");
    expect(food.servings).toEqual([
      {
        servingId: "100",
        description: "100 g",
        metricServingAmount: 100,
        metricServingUnit: "g",
        calories: 165,
        carbohydrateG: 0,
        proteinG: 31,
        fatG: 3.6,
        saturatedFatG: null,
        transFatG: null,
        cholesterolMg: null,
        sodiumMg: 74,
        potassiumMg: null,
        fiberG: null,
        sugarG: null,
      },
    ]);
  });

  it("respects FATSECRET_FOOD_GET_METHOD for accounts without v4 access", async () => {
    process.env.FATSECRET_FOOD_GET_METHOD = "food.get";
    stubApi((params) => {
      expect(params.get("method")).toBe("food.get");
      return new Response(
        JSON.stringify({
          food: {
            food_id: "42",
            food_name: "Chicken Breast",
            food_type: "Generic",
            food_url: "https://example.com/chicken",
            servings: { serving: [] },
          },
        }),
        { status: 200 }
      );
    });
    await getFoodDetail("42");
  });
});

describe("searchRecipes / getRecipeDetail", () => {
  it("searchRecipes normalizes results and pulls caloriesPerServing from recipe_nutrition", async () => {
    stubApi(
      () =>
        new Response(
          JSON.stringify({
            recipes: {
              recipe: {
                recipe_id: "9",
                recipe_name: "Omelette",
                recipe_description: "A simple omelette",
                recipe_nutrition: { calories: "220" },
              },
              max_results: "20",
              total_results: "1",
              page_number: "0",
            },
          }),
          { status: 200 }
        )
    );

    const result = await searchRecipes("omelette");
    expect(result.recipes).toEqual([
      {
        recipeId: "9",
        name: "Omelette",
        description: "A simple omelette",
        imageUrl: null,
        caloriesPerServing: 220,
      },
    ]);
  });

  it("getRecipeDetail sorts directions by direction_number and normalizes ingredients", async () => {
    stubApi(
      () =>
        new Response(
          JSON.stringify({
            recipe: {
              recipe_id: "9",
              recipe_name: "Omelette",
              recipe_description: "A simple omelette",
              number_of_servings: "2",
              recipe_ingredients: {
                ingredient: [
                  { food_id: "1", ingredient_description: "2 eggs" },
                  { ingredient_description: "pinch of salt" },
                ],
              },
              recipe_directions: {
                direction: [
                  { direction_number: "2", direction_description: "Cook until set." },
                  { direction_number: "1", direction_description: "Whisk the eggs." },
                ],
              },
            },
          }),
          { status: 200 }
        )
    );

    const recipe = await getRecipeDetail("9");
    expect(recipe.servings).toBe(2);
    expect(recipe.ingredients).toEqual([
      { foodId: "1", description: "2 eggs" },
      { foodId: null, description: "pinch of salt" },
    ]);
    expect(recipe.directions).toEqual(["Whisk the eggs.", "Cook until set."]);
  });
});

describe("findFoodByBarcode", () => {
  it("reports found:false when FatSecret returns food_id value '0'", async () => {
    stubApi((params) => {
      expect(params.get("method")).toBe("food.find_id_for_barcode");
      expect(params.get("barcode")).toBe("0000000000000");
      return new Response(JSON.stringify({ food_id: { value: "0" } }), { status: 200 });
    });
    const result = await findFoodByBarcode("0000000000000");
    expect(result).toEqual({ found: false, foodId: null });
  });

  it("reports found:true with the resolved foodId otherwise", async () => {
    stubApi(
      () => new Response(JSON.stringify({ food_id: { value: "12345" } }), { status: 200 })
    );
    const result = await findFoodByBarcode("012345678905", "US");
    expect(result).toEqual({ found: true, foodId: "12345" });
  });
});
