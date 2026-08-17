import { describe, it, expect, beforeEach, vi } from "vitest";

process.env.MCP_BEARER_TOKEN = "test-bearer-token";
process.env.FATSECRET_CLIENT_ID = "test-client-id";
process.env.FATSECRET_CLIENT_SECRET = "test-client-secret";
process.env.FATSECRET_CONSUMER_KEY = "test-consumer-key";
process.env.FATSECRET_CONSUMER_SECRET = "test-consumer-secret";
process.env.FATSECRET_ACCESS_TOKEN = "test-access-token";
process.env.FATSECRET_ACCESS_TOKEN_SECRET = "test-access-token-secret";

// Imported after env vars are set, since route.ts registers tools eagerly at
// module load time (auth itself is checked lazily per-request).
import { POST } from "../../app/api/mcp/route";
import { _resetAppAccessTokenCacheForTests } from "../../lib/fatsecret/appAuth";

function request(body: unknown, headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

async function callMcp(body: unknown, headers: Record<string, string> = {}) {
  const res = await POST(request(body, headers));
  const text = await res.text();
  const dataLine = text.split("\n").find((l) => l.startsWith("data: "));
  const json = dataLine ? JSON.parse(dataLine.slice("data: ".length)) : null;
  return { status: res.status, json, raw: text };
}

const AUTH_HEADER = { authorization: "Bearer test-bearer-token" };

const APP_TOKEN_URL = "https://oauth.fatsecret.com/connect/token";
const API_URL = "https://platform.fatsecret.com/rest/server.api";

function appTokenResponse() {
  return new Response(
    JSON.stringify({ access_token: "app-token", token_type: "Bearer", expires_in: 86400 }),
    { status: 200 }
  );
}

/** Stubs fetch for OAuth2-authenticated (Signed Request) tools: token endpoint + server.api. */
function stubSignedApi(apiResponder: (params: URLSearchParams) => Response) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      if (url === APP_TOKEN_URL) return appTokenResponse();
      expect(url).toBe(API_URL);
      return apiResponder(new URLSearchParams(init.body as string));
    })
  );
}

/** Stubs fetch for OAuth1-authenticated (Signed & Delegated) tools: server.api only. */
function stubDelegatedApi(apiResponder: (params: URLSearchParams) => Response) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe(API_URL);
      return apiResponder(new URLSearchParams(init.body as string));
    })
  );
}

beforeEach(() => {
  vi.unstubAllGlobals();
  _resetAppAccessTokenCacheForTests();
});

describe("POST /api/mcp auth", () => {
  it("rejects requests with no Authorization header", async () => {
    const { status } = await callMcp({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(status).toBe(401);
  });

  it("rejects requests with the wrong bearer token", async () => {
    const { status } = await callMcp(
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      { authorization: "Bearer wrong-token" }
    );
    expect(status).toBe(401);
  });

  it("accepts requests with the correct bearer token", async () => {
    const { status } = await callMcp(
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      AUTH_HEADER
    );
    expect(status).toBe(200);
  });
});

describe("POST /api/mcp tools/list", () => {
  it("lists all 17 tools", async () => {
    const { json } = await callMcp({ jsonrpc: "2.0", id: 1, method: "tools/list" }, AUTH_HEADER);
    const names = json.result.tools.map((t: { name: string }) => t.name).sort();
    expect(names).toEqual(
      [
        "create_exercise_entry",
        "create_food_diary_entry",
        "delete_food_diary_entry",
        "find_food_by_barcode",
        "get_exercise_diary",
        "get_favorite_foods",
        "get_food_detail",
        "get_food_diary",
        "get_most_eaten_foods",
        "get_profile",
        "get_recently_eaten_foods",
        "get_recipe_detail",
        "get_weight_history",
        "search_foods",
        "search_recipes",
        "update_food_diary_entry",
        "update_weight",
      ].sort()
    );
  });
});

describe("POST /api/mcp tools/call — Signed Request (OAuth2, real lib/fatsecret modules, fetch mocked)", () => {
  it("search_foods returns normalized results", async () => {
    stubSignedApi((params) => {
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

    const { json } = await callMcp(
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "search_foods", arguments: { searchExpression: "banana" } },
      },
      AUTH_HEADER
    );

    const result = JSON.parse(json.result.content[0].text);
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

  it("surfaces a FatSecret API error as a tool error instead of crashing the server", async () => {
    stubSignedApi(
      () =>
        new Response(JSON.stringify({ error: { code: 2, message: "Missing search_expression" } }), {
          status: 200,
        })
    );

    const { status, json } = await callMcp(
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "search_foods", arguments: { searchExpression: "x" } },
      },
      AUTH_HEADER
    );

    // The HTTP transport itself should stay healthy (200) even though the
    // underlying tool call failed — MCP reports tool failures inside the
    // result payload, not as an HTTP error.
    expect(status).toBe(200);
    expect(json.result.isError).toBe(true);
  });

  it("get_food_detail resolves food.get.v4 with numeric nutrition fields", async () => {
    stubSignedApi(() =>
      new Response(
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
                calories: "165",
                carbohydrate: "0.00",
                protein: "31.00",
                fat: "3.60",
              },
            },
          },
        }),
        { status: 200 }
      )
    );

    const { json } = await callMcp(
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "get_food_detail", arguments: { foodId: "42" } },
      },
      AUTH_HEADER
    );

    const food = JSON.parse(json.result.content[0].text);
    expect(food.servings[0].calories).toBe(165);
  });
});

describe("POST /api/mcp tools/call — Signed & Delegated (OAuth1, real lib/fatsecret modules, fetch mocked)", () => {
  it("get_food_diary returns diary entries for a date", async () => {
    stubDelegatedApi((params) => {
      expect(params.get("method")).toBe("food_entries.get");
      return new Response(
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
            },
          },
        }),
        { status: 200 }
      );
    });

    const { json } = await callMcp(
      {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: { name: "get_food_diary", arguments: { date: "2026-08-17" } },
      },
      AUTH_HEADER
    );

    const diary = JSON.parse(json.result.content[0].text);
    expect(diary.entries[0].name).toBe("Banana");
  });

  it("create_food_diary_entry is rejected before touching the FatSecret API when confirm is not true", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { status, json } = await callMcp(
      {
        jsonrpc: "2.0",
        id: 6,
        method: "tools/call",
        params: {
          name: "create_food_diary_entry",
          arguments: { foodId: "1", servingId: "100", quantity: 1, meal: "breakfast" },
        },
      },
      AUTH_HEADER
    );

    expect(status).toBe(200);
    expect(json.result.isError).toBe(true);
    expect(json.result.content[0].text).toMatch(/confirm/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("create_food_diary_entry POSTs food_entry.create and returns the new id when confirmed", async () => {
    stubDelegatedApi((params) => {
      expect(params.get("method")).toBe("food_entry.create");
      expect(params.get("food_id")).toBe("1");
      expect(params.get("quantity")).toBe("1.5");
      return new Response(JSON.stringify({ food_entry_id: "5555" }), { status: 200 });
    });

    const { json } = await callMcp(
      {
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: {
          name: "create_food_diary_entry",
          arguments: {
            foodId: "1",
            servingId: "100",
            quantity: 1.5,
            meal: "lunch",
            confirm: true,
          },
        },
      },
      AUTH_HEADER
    );

    const result = JSON.parse(json.result.content[0].text);
    expect(result).toEqual({ foodEntryId: "5555" });
  });

  it("delete_food_diary_entry is rejected before touching the FatSecret API when confirm is not true", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { json } = await callMcp(
      {
        jsonrpc: "2.0",
        id: 8,
        method: "tools/call",
        params: { name: "delete_food_diary_entry", arguments: { foodEntryId: "5555" } },
      },
      AUTH_HEADER
    );

    expect(json.result.isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("update_weight is rejected before touching the FatSecret API when confirm is not true", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { json } = await callMcp(
      {
        jsonrpc: "2.0",
        id: 9,
        method: "tools/call",
        params: { name: "update_weight", arguments: { weightKg: 70 } },
      },
      AUTH_HEADER
    );

    expect(json.result.isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("update_weight PUTs the weight when confirmed", async () => {
    stubDelegatedApi((params) => {
      expect(params.get("method")).toBe("weight.update");
      expect(params.get("current_weight_kg")).toBe("70.5");
      return new Response(JSON.stringify({}), { status: 200 });
    });

    const { json } = await callMcp(
      {
        jsonrpc: "2.0",
        id: 10,
        method: "tools/call",
        params: { name: "update_weight", arguments: { weightKg: 70.5, confirm: true } },
      },
      AUTH_HEADER
    );

    const result = JSON.parse(json.result.content[0].text);
    expect(result.updated).toBe(true);
  });

  it("create_exercise_entry is rejected before touching the FatSecret API when confirm is not true", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { json } = await callMcp(
      {
        jsonrpc: "2.0",
        id: 11,
        method: "tools/call",
        params: { name: "create_exercise_entry", arguments: { exerciseId: "50", minutes: 30 } },
      },
      AUTH_HEADER
    );

    expect(json.result.isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("get_profile returns the normalized profile", async () => {
    stubDelegatedApi((params) => {
      expect(params.get("method")).toBe("profile.get");
      return new Response(
        JSON.stringify({ profile: { last_weight_kg: "70.5" } }),
        { status: 200 }
      );
    });

    const { json } = await callMcp(
      {
        jsonrpc: "2.0",
        id: 12,
        method: "tools/call",
        params: { name: "get_profile", arguments: {} },
      },
      AUTH_HEADER
    );

    const profile = JSON.parse(json.result.content[0].text);
    expect(profile.lastWeightKg).toBe(70.5);
  });
});
