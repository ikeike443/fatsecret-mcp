import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getExerciseDiary, createExerciseEntry } from "./exercise";

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

describe("getExerciseDiary", () => {
  it("returns an empty list for an empty day", async () => {
    stubApi((params) => {
      expect(params.get("method")).toBe("exercise_entries.get");
      return new Response(JSON.stringify({ exercise_entries: "" }), { status: 200 });
    });
    expect(await getExerciseDiary("2026-08-17")).toEqual({ entries: [] });
  });

  it("normalizes entries and converts numeric fields", async () => {
    stubApi(
      () =>
        new Response(
          JSON.stringify({
            exercise_entries: {
              exercise_entry: {
                exercise_entry_id: "1",
                exercise_id: "50",
                exercise_name: "Running",
                minutes: "30",
                calories: "300",
                date_int: "20678",
              },
            },
          }),
          { status: 200 }
        )
    );
    const diary = await getExerciseDiary("2026-08-17");
    expect(diary.entries).toEqual([
      {
        exerciseEntryId: "1",
        exerciseId: "50",
        name: "Running",
        minutes: 30,
        calories: 300,
        dateDaysSinceEpoch: 20678,
      },
    ]);
  });
});

describe("createExerciseEntry", () => {
  it("sends exercise_id/minutes/date and unwraps the returned id", async () => {
    stubApi((params) => {
      expect(params.get("method")).toBe("exercise_entries.create");
      expect(params.get("exercise_id")).toBe("50");
      expect(params.get("minutes")).toBe("30");
      return new Response(JSON.stringify({ exercise_entry_id: "1" }), { status: 200 });
    });
    const result = await createExerciseEntry({ exerciseId: "50", minutes: 30, date: "2026-08-17" });
    expect(result).toEqual({ exerciseEntryId: "1" });
  });

  it("unwraps a { value } wrapped id", async () => {
    stubApi(
      () => new Response(JSON.stringify({ exercise_entry_id: { value: "2" } }), { status: 200 })
    );
    const result = await createExerciseEntry({ exerciseId: "51", minutes: 45 });
    expect(result).toEqual({ exerciseEntryId: "2" });
  });
});
