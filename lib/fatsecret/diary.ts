// food_entries.*, food_entry.*, foods.get_favorites/get_most_eaten/
// get_recently_eaten — Signed & Delegated, operate on the authenticated
// FatSecret user's own food diary. See lib/fatsecret/oauth1.ts.
//
// Response shapes for food_entries.get / food_entry.create / .edit are
// reconstructed from FatSecret's documented method descriptions, not a
// captured real response — confirm against a real account once
// FATSECRET_ACCESS_TOKEN is set up (README's manual-verification
// checklist) and adjust field names if any are off.
import { fatsecretDelegatedRequest } from "./oauth1";
import { asArray, toFoodSearchResult, type RawFoodSearchItem } from "./foods";
import { toFatSecretDate } from "./date";

// --- food_entries.get --------------------------------------------------

interface RawFoodEntry {
  food_entry_id: string;
  food_entry_name: string;
  food_id: string;
  serving_id: string;
  number_of_units: string;
  meal: string;
  date_int: string;
  calories?: string;
  carbohydrate?: string;
  protein?: string;
  fat?: string;
}

interface RawFoodEntriesGetResponse {
  // FatSecret's XML-ism: an empty day comes back as "" (empty string)
  // rather than an absent/empty-array key.
  food_entries: { food_entry?: RawFoodEntry | RawFoodEntry[] } | "";
}

function toFoodEntry(e: RawFoodEntry) {
  const num = (v: string | undefined) => (v === undefined ? null : Number(v));
  return {
    foodEntryId: e.food_entry_id,
    name: e.food_entry_name,
    foodId: e.food_id,
    servingId: e.serving_id,
    numberOfUnits: Number(e.number_of_units),
    meal: e.meal,
    dateDaysSinceEpoch: Number(e.date_int),
    calories: num(e.calories),
    carbohydrateG: num(e.carbohydrate),
    proteinG: num(e.protein),
    fatG: num(e.fat),
  };
}

export async function getFoodDiary(date?: string) {
  const data = await fatsecretDelegatedRequest<RawFoodEntriesGetResponse>(
    "food_entries.get",
    { date: toFatSecretDate(date) }
  );
  if (data.food_entries === "") return { entries: [] };
  return { entries: asArray(data.food_entries.food_entry).map(toFoodEntry) };
}

// --- foods.get_favorites / get_most_eaten / get_recently_eaten ---------

interface RawCompactFoodsResponse {
  foods_favorite?: { food?: RawFoodSearchItem | RawFoodSearchItem[] } | "";
  foods_most_eaten?: { food?: RawFoodSearchItem | RawFoodSearchItem[] } | "";
  foods_recently_eaten?:
    | { food?: RawFoodSearchItem | RawFoodSearchItem[] }
    | "";
}

export async function getFavoriteFoods() {
  const data = await fatsecretDelegatedRequest<RawCompactFoodsResponse>(
    "foods.get_favorites",
    {}
  );
  const wrapper = data.foods_favorite;
  return { foods: wrapper === "" || !wrapper ? [] : asArray(wrapper.food).map(toFoodSearchResult) };
}

export async function getMostEatenFoods(meal?: string) {
  const data = await fatsecretDelegatedRequest<RawCompactFoodsResponse>(
    "foods.get_most_eaten",
    { meal }
  );
  const wrapper = data.foods_most_eaten;
  return { foods: wrapper === "" || !wrapper ? [] : asArray(wrapper.food).map(toFoodSearchResult) };
}

export async function getRecentlyEatenFoods(meal?: string) {
  const data = await fatsecretDelegatedRequest<RawCompactFoodsResponse>(
    "foods.get_recently_eaten",
    { meal }
  );
  const wrapper = data.foods_recently_eaten;
  return { foods: wrapper === "" || !wrapper ? [] : asArray(wrapper.food).map(toFoodSearchResult) };
}

// --- food_entry.create / .edit / .delete --------------------------------

export interface FoodDiaryEntryInput {
  foodId: string;
  servingId: string;
  quantity: number;
  meal: "breakfast" | "lunch" | "dinner" | "other";
  date?: string;
}

// FatSecret wraps the created/edited entry's id as { value: "..." } in some
// documented examples and as a bare string in others — accept both so a
// real response either way is handled instead of silently producing
// `undefined`.
function unwrapId(value: string | { value: string }): string {
  return typeof value === "string" ? value : value.value;
}

interface RawFoodEntryWriteResponse {
  food_entry_id: string | { value: string };
}

export async function createFoodDiaryEntry(input: FoodDiaryEntryInput) {
  const data = await fatsecretDelegatedRequest<RawFoodEntryWriteResponse>(
    "food_entry.create",
    {
      food_id: input.foodId,
      serving_id: input.servingId,
      quantity: input.quantity,
      meal: input.meal,
      date: toFatSecretDate(input.date),
    }
  );
  return { foodEntryId: unwrapId(data.food_entry_id) };
}

export async function updateFoodDiaryEntry(
  foodEntryId: string,
  input: Partial<FoodDiaryEntryInput>
) {
  const data = await fatsecretDelegatedRequest<RawFoodEntryWriteResponse>(
    "food_entry.edit",
    {
      food_entry_id: foodEntryId,
      food_id: input.foodId,
      serving_id: input.servingId,
      quantity: input.quantity,
      meal: input.meal,
      date: input.date === undefined ? undefined : toFatSecretDate(input.date),
    }
  );
  return { foodEntryId: unwrapId(data.food_entry_id) };
}

export async function deleteFoodDiaryEntry(foodEntryId: string) {
  await fatsecretDelegatedRequest<unknown>("food_entry.delete", {
    food_entry_id: foodEntryId,
  });
  return { deleted: true, foodEntryId };
}
