import { createMcpHandler, withMcpAuth } from "mcp-handler";
import { z } from "zod";
import { verifyBearerToken } from "@/lib/auth";
import {
  searchFoods,
  getFoodDetail,
  searchRecipes,
  getRecipeDetail,
  findFoodByBarcode,
} from "@/lib/fatsecret/foods";
import {
  getFoodDiary,
  getFavoriteFoods,
  getMostEatenFoods,
  getRecentlyEatenFoods,
  createFoodDiaryEntry,
  updateFoodDiaryEntry,
  deleteFoodDiaryEntry,
} from "@/lib/fatsecret/diary";
import { getWeightHistory, updateWeight } from "@/lib/fatsecret/weight";
import { getExerciseDiary, createExerciseEntry } from "@/lib/fatsecret/exercise";
import { getProfile } from "@/lib/fatsecret/profile";

export const maxDuration = 30;

// Shared schema fragments for the write tools below (see README's
// "Write tools are dry-run by default" section for the full reasoning —
// same pattern as fitness-mcp's Hevy write tools).
const confirmSchema = z
  .literal(true)
  .describe(
    "Set to true only after showing the user exactly what will be written (food/serving/quantity/meal/date, or weight, or exercise) in chat and getting their explicit go-ahead. Do not call this tool speculatively or before that confirmation."
  );

const mealSchema = z
  .enum(["breakfast", "lunch", "dinner", "other"])
  .describe("Meal slot, exactly as FatSecret expects it");

const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .optional()
  .describe("ISO date (YYYY-MM-DD). Omit for today.");

const handler = createMcpHandler(
  (server) => {
    // --- Phase 2: food/recipe search — Signed Request, no user auth needed.

    server.registerTool(
      "search_foods",
      {
        title: "Search FatSecret foods",
        description:
          "Search FatSecret's food database by name (generic and branded foods). Returns candidate foods (id, name, brand, one-line nutrition summary) — use get_food_detail with a returned foodId for full per-serving nutrition before logging it to the diary.",
        inputSchema: z.object({
          searchExpression: z.string().min(1).describe("Food name or partial name to search for"),
          pageNumber: z.number().int().min(0).optional().describe("Zero-based page number (default 0)"),
          maxResults: z.number().int().min(1).max(50).optional().describe("Results per page, max 50 (default 20)"),
        }),
      },
      async ({ searchExpression, pageNumber, maxResults }) => {
        const results = await searchFoods(searchExpression, pageNumber, maxResults);
        return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
      }
    );

    server.registerTool(
      "get_food_detail",
      {
        title: "Get FatSecret food detail",
        description:
          "Get full per-serving nutrition detail (calories, macros, and more) for a single food by its foodId (obtain the id from search_foods, find_food_by_barcode, or a food diary entry).",
        inputSchema: z.object({
          foodId: z.string().min(1).describe("FatSecret food_id"),
        }),
      },
      async ({ foodId }) => {
        const food = await getFoodDetail(foodId);
        return { content: [{ type: "text", text: JSON.stringify(food, null, 2) }] };
      }
    );

    server.registerTool(
      "search_recipes",
      {
        title: "Search FatSecret recipes",
        description:
          "Search FatSecret's recipe database by name/keyword. Returns candidate recipes (id, name, description, per-serving calories) — use get_recipe_detail with a returned recipeId for full ingredients/directions.",
        inputSchema: z.object({
          searchExpression: z.string().min(1).describe("Recipe name or keyword to search for"),
          pageNumber: z.number().int().min(0).optional().describe("Zero-based page number (default 0)"),
          maxResults: z.number().int().min(1).max(50).optional().describe("Results per page, max 50 (default 20)"),
        }),
      },
      async ({ searchExpression, pageNumber, maxResults }) => {
        const results = await searchRecipes(searchExpression, pageNumber, maxResults);
        return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
      }
    );

    server.registerTool(
      "get_recipe_detail",
      {
        title: "Get FatSecret recipe detail",
        description:
          "Get full ingredients and step-by-step directions for a single recipe by its recipeId (obtain the id from search_recipes).",
        inputSchema: z.object({
          recipeId: z.string().min(1).describe("FatSecret recipe_id"),
        }),
      },
      async ({ recipeId }) => {
        const recipe = await getRecipeDetail(recipeId);
        return { content: [{ type: "text", text: JSON.stringify(recipe, null, 2) }] };
      }
    );

    server.registerTool(
      "find_food_by_barcode",
      {
        title: "Find FatSecret food by barcode",
        description:
          "Resolve a GTIN-13 barcode to a FatSecret foodId (use get_food_detail on the result for nutrition). Requires the 'barcode' OAuth2 scope and may be gated to FatSecret Premier plans — see README.",
        inputSchema: z.object({
          barcode: z.string().min(1).describe("GTIN-13 barcode digits"),
          region: z.string().length(2).optional().describe("Optional two-letter region code (e.g. 'US', 'JP')"),
        }),
      },
      async ({ barcode, region }) => {
        const result = await findFoodByBarcode(barcode, region);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
    );

    // --- Phase 4 read: diary/weight/exercise/profile — Signed & Delegated,
    // requires the one-time OAuth1 setup (see README Phase 3 /
    // scripts/fatsecret-oauth-setup.ts).

    server.registerTool(
      "get_food_diary",
      {
        title: "Get FatSecret food diary for a date",
        description: "List the user's logged food diary entries for a given date (default: today).",
        inputSchema: z.object({ date: dateSchema }),
      },
      async ({ date }) => {
        const diary = await getFoodDiary(date);
        return { content: [{ type: "text", text: JSON.stringify(diary, null, 2) }] };
      }
    );

    server.registerTool(
      "get_favorite_foods",
      {
        title: "Get FatSecret favorite foods",
        description: "List the user's favorited foods.",
        inputSchema: z.object({}),
      },
      async () => {
        const result = await getFavoriteFoods();
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
    );

    server.registerTool(
      "get_most_eaten_foods",
      {
        title: "Get FatSecret most-eaten foods",
        description: "List the foods the user eats most often, optionally filtered to one meal.",
        inputSchema: z.object({ meal: mealSchema.optional() }),
      },
      async ({ meal }) => {
        const result = await getMostEatenFoods(meal);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
    );

    server.registerTool(
      "get_recently_eaten_foods",
      {
        title: "Get FatSecret recently-eaten foods",
        description: "List foods the user has logged recently, optionally filtered to one meal.",
        inputSchema: z.object({ meal: mealSchema.optional() }),
      },
      async ({ meal }) => {
        const result = await getRecentlyEatenFoods(meal);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
    );

    server.registerTool(
      "get_weight_history",
      {
        title: "Get FatSecret weight history",
        description:
          "List logged weight entries for the month containing the given date (default: today). May require a FatSecret Premier plan — see README.",
        inputSchema: z.object({ date: dateSchema }),
      },
      async ({ date }) => {
        const history = await getWeightHistory(date);
        return { content: [{ type: "text", text: JSON.stringify(history, null, 2) }] };
      }
    );

    server.registerTool(
      "get_exercise_diary",
      {
        title: "Get FatSecret exercise diary for a date",
        description: "List the user's logged exercise entries for a given date (default: today).",
        inputSchema: z.object({ date: dateSchema }),
      },
      async ({ date }) => {
        const diary = await getExerciseDiary(date);
        return { content: [{ type: "text", text: JSON.stringify(diary, null, 2) }] };
      }
    );

    server.registerTool(
      "get_profile",
      {
        title: "Get FatSecret profile",
        description: "Get the authenticated user's FatSecret profile summary (last logged weight, unit preferences, goal weight).",
        inputSchema: z.object({}),
      },
      async () => {
        const profile = await getProfile();
        return { content: [{ type: "text", text: JSON.stringify(profile, null, 2) }] };
      }
    );

    // --- Phase 4 write — all require confirm:true, same dry-run-by-default
    // design as fitness-mcp's Hevy write tools (see README).

    server.registerTool(
      "create_food_diary_entry",
      {
        title: "Log a food diary entry",
        description:
          "Log a food to the user's FatSecret diary for a given date/meal. THIS IS A REAL WRITE. Show the user the exact food, serving, quantity, meal, and date in chat and get explicit go-ahead before calling. foodId and servingId must come from a prior search_foods/get_food_detail call — never guess them.",
        inputSchema: z.object({
          foodId: z.string().min(1).describe("FatSecret food_id, from search_foods/get_food_detail"),
          servingId: z.string().min(1).describe("FatSecret serving_id, from get_food_detail's servings list"),
          quantity: z.number().positive().describe("Number of servings (e.g. 1.5)"),
          meal: mealSchema,
          date: dateSchema,
          confirm: confirmSchema,
        }),
      },
      async ({ foodId, servingId, quantity, meal, date }) => {
        const result = await createFoodDiaryEntry({ foodId, servingId, quantity, meal, date });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
    );

    server.registerTool(
      "update_food_diary_entry",
      {
        title: "Update a food diary entry",
        description:
          "Update an existing FatSecret food diary entry (quantity/meal/date/food/serving). THIS IS A REAL WRITE. Show the user the exact new values and get explicit go-ahead before calling. Only the fields provided are changed.",
        inputSchema: z.object({
          foodEntryId: z.string().min(1).describe("The diary entry's id, from get_food_diary"),
          foodId: z.string().min(1).optional(),
          servingId: z.string().min(1).optional(),
          quantity: z.number().positive().optional(),
          meal: mealSchema.optional(),
          date: dateSchema,
          confirm: confirmSchema,
        }),
      },
      async ({ foodEntryId, foodId, servingId, quantity, meal, date }) => {
        const result = await updateFoodDiaryEntry(foodEntryId, {
          foodId,
          servingId,
          quantity,
          meal,
          date,
        });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
    );

    server.registerTool(
      "delete_food_diary_entry",
      {
        title: "Delete a food diary entry",
        description:
          "Delete an existing FatSecret food diary entry. THIS IS A REAL WRITE and cannot be undone. Confirm with the user which entry (show its name/date/meal from get_food_diary) before calling.",
        inputSchema: z.object({
          foodEntryId: z.string().min(1).describe("The diary entry's id, from get_food_diary"),
          confirm: confirmSchema,
        }),
      },
      async ({ foodEntryId }) => {
        const result = await deleteFoodDiaryEntry(foodEntryId);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
    );

    server.registerTool(
      "update_weight",
      {
        title: "Log/update a FatSecret weight entry",
        description:
          "Log or update the user's weight for a given date (default: today). THIS IS A REAL WRITE. Show the user the exact weight (kg) and date and get explicit go-ahead before calling. May require a FatSecret Premier plan — see README.",
        inputSchema: z.object({
          weightKg: z.number().positive().describe("Weight in kilograms"),
          date: dateSchema,
          comment: z.string().optional(),
          heightCm: z.number().positive().optional().describe("Optional: also update height (cm)"),
          goalWeightKg: z.number().positive().optional().describe("Optional: also update goal weight (kg)"),
          confirm: confirmSchema,
        }),
      },
      async ({ weightKg, date, comment, heightCm, goalWeightKg }) => {
        const result = await updateWeight({ weightKg, date, comment, heightCm, goalWeightKg });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
    );

    server.registerTool(
      "create_exercise_entry",
      {
        title: "Log a FatSecret exercise entry",
        description:
          "Log an exercise to the user's FatSecret exercise diary. THIS IS A REAL WRITE. Show the user the exact exercise, duration, and date and get explicit go-ahead before calling. exerciseId should come from the user or a prior lookup — never guess it.",
        inputSchema: z.object({
          exerciseId: z.string().min(1).describe("FatSecret exercise_id"),
          minutes: z.number().positive().describe("Duration in minutes"),
          date: dateSchema,
          confirm: confirmSchema,
        }),
      },
      async ({ exerciseId, minutes, date }) => {
        const result = await createExerciseEntry({ exerciseId, minutes, date });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
    );
  },
  {
    serverInfo: { name: "fatsecret-mcp", version: "0.1.0" },
  }
);

const authedHandler = withMcpAuth(handler, verifyBearerToken, {
  required: true,
});

export { authedHandler as GET, authedHandler as POST };
