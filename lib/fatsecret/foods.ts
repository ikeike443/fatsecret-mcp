// FatSecret "Signed Request" food/recipe methods — read-only, no per-user
// authorization needed. See lib/fatsecret/appAuth.ts for the OAuth 2.0
// Client Credentials plumbing this calls into.
import { fatsecretAppRequest } from "./appAuth";

// FatSecret's JSON responses come from an XML-oriented API: a field that
// can repeat (foods.food, servings.serving, ...) is a *single object* when
// there's exactly one result and an *array* when there's more than one —
// never an empty array for zero results (the parent key is just absent
// instead). asArray() normalizes all three cases to a plain array so
// callers never have to special-case "did I get one result or many".
export function asArray<T>(value: T | T[] | undefined | null): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

// --- foods.search --------------------------------------------------------

// Exported: this compact shape (id/name/type/description) is also what
// foods.get_favorites, foods.get_most_eaten, and foods.get_recently_eaten
// return per FatSecret's docs, so lib/fatsecret/diary.ts reuses it rather
// than duplicating the mapping.
export interface RawFoodSearchItem {
  food_id: string;
  food_name: string;
  food_type: string;
  food_url: string;
  brand_name?: string;
  // A human-readable one-line nutrition summary, e.g. "Per 100g - Calories:
  // 52kcal | Fat: 0.17g | Carbs: 13.81g | Protein: 0.26g" — genuinely useful
  // as-is, so it's passed through rather than parsed.
  food_description: string;
}

interface RawFoodsSearchResponse {
  foods: {
    food?: RawFoodSearchItem | RawFoodSearchItem[];
    max_results: string;
    total_results: string;
    page_number: string;
  };
}

export function toFoodSearchResult(f: RawFoodSearchItem) {
  return {
    foodId: f.food_id,
    name: f.food_name,
    type: f.food_type,
    brandName: f.brand_name ?? null,
    description: f.food_description,
    url: f.food_url,
  };
}

export async function searchFoods(
  searchExpression: string,
  pageNumber = 0,
  maxResults = 20
) {
  const data = await fatsecretAppRequest<RawFoodsSearchResponse>(
    "foods.search",
    {
      search_expression: searchExpression,
      page_number: pageNumber,
      max_results: Math.min(Math.max(maxResults, 1), 50),
    }
  );
  return {
    pageNumber: Number(data.foods.page_number),
    totalResults: Number(data.foods.total_results),
    foods: asArray(data.foods.food).map(toFoodSearchResult),
  };
}

// --- food.get --------------------------------------------------------------

interface RawServing {
  serving_id: string;
  serving_description: string;
  serving_url?: string;
  metric_serving_amount?: string;
  metric_serving_unit?: string;
  number_of_units?: string;
  measurement_description?: string;
  calories: string;
  carbohydrate: string;
  protein: string;
  fat: string;
  saturated_fat?: string;
  polyunsaturated_fat?: string;
  monounsaturated_fat?: string;
  trans_fat?: string;
  cholesterol?: string;
  sodium?: string;
  potassium?: string;
  fiber?: string;
  sugar?: string;
  vitamin_a?: string;
  vitamin_c?: string;
  calcium?: string;
  iron?: string;
}

interface RawFoodDetail {
  food_id: string;
  food_name: string;
  food_type: string;
  food_url: string;
  brand_name?: string;
  servings: {
    serving?: RawServing | RawServing[];
  };
}

interface RawFoodGetResponse {
  food: RawFoodDetail;
}

// Numeric nutrition fields arrive as strings (again, an XML-API-ism) —
// convert the ones we surface to numbers so callers don't have to.
function toServing(s: RawServing) {
  const num = (v: string | undefined) => (v === undefined ? null : Number(v));
  return {
    servingId: s.serving_id,
    description: s.serving_description,
    metricServingAmount: num(s.metric_serving_amount),
    metricServingUnit: s.metric_serving_unit ?? null,
    calories: num(s.calories),
    carbohydrateG: num(s.carbohydrate),
    proteinG: num(s.protein),
    fatG: num(s.fat),
    saturatedFatG: num(s.saturated_fat),
    transFatG: num(s.trans_fat),
    cholesterolMg: num(s.cholesterol),
    sodiumMg: num(s.sodium),
    potassiumMg: num(s.potassium),
    fiberG: num(s.fiber),
    sugarG: num(s.sugar),
  };
}

export async function getFoodDetail(foodId: string) {
  // "food.get.v4" is FatSecret's latest versioned food.get variant with the
  // richest per-serving nutrient breakdown (falls back gracefully — the API
  // treats an unknown version suffix as an error, so if v4 isn't available
  // on your plan, drop to plain "food.get" via FATSECRET_FOOD_GET_METHOD).
  const method = process.env.FATSECRET_FOOD_GET_METHOD ?? "food.get.v4";
  const data = await fatsecretAppRequest<RawFoodGetResponse>(method, {
    food_id: foodId,
  });
  const food = data.food;
  return {
    foodId: food.food_id,
    name: food.food_name,
    type: food.food_type,
    brandName: food.brand_name ?? null,
    url: food.food_url,
    servings: asArray(food.servings.serving).map(toServing),
  };
}

// --- recipes.search / recipe.get -------------------------------------------

interface RawRecipeSearchItem {
  recipe_id: string;
  recipe_name: string;
  recipe_description: string;
  recipe_image?: string;
  recipe_nutrition?: {
    calories?: string;
    carbohydrate?: string;
    protein?: string;
    fat?: string;
  };
}

interface RawRecipesSearchResponse {
  recipes: {
    recipe?: RawRecipeSearchItem | RawRecipeSearchItem[];
    max_results: string;
    total_results: string;
    page_number: string;
  };
}

function toRecipeSearchResult(r: RawRecipeSearchItem) {
  const n = r.recipe_nutrition;
  return {
    recipeId: r.recipe_id,
    name: r.recipe_name,
    description: r.recipe_description,
    imageUrl: r.recipe_image ?? null,
    caloriesPerServing: n?.calories ? Number(n.calories) : null,
  };
}

export async function searchRecipes(
  searchExpression: string,
  pageNumber = 0,
  maxResults = 20
) {
  const data = await fatsecretAppRequest<RawRecipesSearchResponse>(
    "recipes.search",
    {
      search_expression: searchExpression,
      page_number: pageNumber,
      max_results: Math.min(Math.max(maxResults, 1), 50),
    }
  );
  return {
    pageNumber: Number(data.recipes.page_number),
    totalResults: Number(data.recipes.total_results),
    recipes: asArray(data.recipes.recipe).map(toRecipeSearchResult),
  };
}

interface RawRecipeIngredient {
  food_id?: string;
  ingredient_description: string;
  ingredient_url?: string;
}

interface RawRecipeDetail {
  recipe_id: string;
  recipe_name: string;
  recipe_description: string;
  number_of_servings?: string;
  recipe_url?: string;
  recipe_ingredients?: {
    ingredient?: RawRecipeIngredient | RawRecipeIngredient[];
  };
  recipe_directions?: {
    direction?:
      | { direction_number: string; direction_description: string }
      | { direction_number: string; direction_description: string }[];
  };
}

interface RawRecipeGetResponse {
  recipe: RawRecipeDetail;
}

export async function getRecipeDetail(recipeId: string) {
  const data = await fatsecretAppRequest<RawRecipeGetResponse>("recipe.get", {
    recipe_id: recipeId,
  });
  const r = data.recipe;
  return {
    recipeId: r.recipe_id,
    name: r.recipe_name,
    description: r.recipe_description,
    servings: r.number_of_servings ? Number(r.number_of_servings) : null,
    url: r.recipe_url ?? null,
    ingredients: asArray(r.recipe_ingredients?.ingredient).map((i) => ({
      foodId: i.food_id ?? null,
      description: i.ingredient_description,
    })),
    directions: asArray(r.recipe_directions?.direction)
      .sort((a, b) => Number(a.direction_number) - Number(b.direction_number))
      .map((d) => d.direction_description),
  };
}

// --- food.find_id_for_barcode -----------------------------------------------

// Unverified against a real response — FatSecret's docs describe this
// method but the exact JSON shape below (a wrapped { value: "..." }) is
// reconstructed from third-party FatSecret client implementations, not a
// captured real response. "0" means no food is associated with the
// barcode. Requires the "barcode" OAuth2 scope (see
// lib/fatsecret/appAuth.ts's defaultScope / FATSECRET_OAUTH2_SCOPE) and is
// reported to be Premier-plan gated — confirm both when registering.
interface RawFindIdForBarcodeResponse {
  food_id: { value: string };
}

export async function findFoodByBarcode(barcode: string, region?: string) {
  const data = await fatsecretAppRequest<RawFindIdForBarcodeResponse>(
    "food.find_id_for_barcode",
    { barcode, region }
  );
  const foodId = data.food_id.value;
  if (foodId === "0") return { found: false as const, foodId: null };
  return { found: true as const, foodId };
}
