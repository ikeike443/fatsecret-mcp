// exercise_entries.* — Signed & Delegated, operate on the authenticated
// FatSecret user's own exercise diary. See lib/fatsecret/oauth1.ts.
//
// getExerciseDiary's method name/response envelope ("exercise_entries" /
// "exercise_entry") are confirmed against a real account — but a real
// response also revealed the exercise diary isn't only "manually logged
// workouts with an id", the way food_entries.get's entries are. An entry
// synced from a connected health app (observed: {exercise_id: "184",
// exercise_name: "Google Health Connect", minutes: "1440", calories:
// "1655"}, i.e. a full day's aggregated activity) has NO exercise_entry_id
// and NO date_int at all — those keys are simply absent, not present-as-
// null. Every field below is therefore optional and defaults to null
// rather than assumed-present, and the full raw entry is kept under `raw`
// so nothing is silently lost for entry shapes this module doesn't
// otherwise model. It's still unconfirmed whether a *manually*-logged
// exercise (via the FatSecret app, not a connected health app) has an id/
// date the same way food_entries.get's entries do — if you log one
// manually and re-check, update this comment with what you find.
//
// createExerciseEntry's method name ("exercise_entries.create") and params
// remain an unverified best-effort guess (no reference implementation
// found, and the discovery above suggests the exercise diary's real data
// model may not even be "individual creatable entries" the way food
// diary entries are) — confirm against
// https://platform.fatsecret.com/docs/guides, and consider testing this
// only after logging (and inspecting the shape of) a manual entry via the
// FatSecret app first, before trusting a real write through this function.
import { fatsecretDelegatedRequest } from "./oauth1";
import { asArray } from "./foods";
import { toFatSecretDate } from "./date";

interface RawExerciseEntry {
  exercise_entry_id?: string;
  exercise_id?: string;
  exercise_name: string;
  minutes: string;
  calories?: string;
  date_int?: string;
  [key: string]: unknown;
}

interface RawExerciseEntriesGetResponse {
  exercise_entries: { exercise_entry?: RawExerciseEntry | RawExerciseEntry[] } | "";
}

export async function getExerciseDiary(date?: string) {
  const data = await fatsecretDelegatedRequest<RawExerciseEntriesGetResponse>(
    "exercise_entries.get",
    { date: toFatSecretDate(date) }
  );
  if (data.exercise_entries === "") return { entries: [] };
  return {
    entries: asArray(data.exercise_entries.exercise_entry).map((e) => ({
      exerciseEntryId: e.exercise_entry_id ?? null,
      exerciseId: e.exercise_id ?? null,
      name: e.exercise_name,
      minutes: Number(e.minutes),
      calories: e.calories ? Number(e.calories) : null,
      dateDaysSinceEpoch: e.date_int !== undefined ? Number(e.date_int) : null,
      raw: e,
    })),
  };
}

export interface CreateExerciseEntryInput {
  exerciseId: string;
  minutes: number;
  date?: string;
}

interface RawExerciseEntryWriteResponse {
  exercise_entry_id: string | { value: string };
}

export async function createExerciseEntry(input: CreateExerciseEntryInput) {
  const data = await fatsecretDelegatedRequest<RawExerciseEntryWriteResponse>(
    "exercise_entries.create",
    {
      exercise_id: input.exerciseId,
      minutes: input.minutes,
      date: toFatSecretDate(input.date),
    }
  );
  const id = data.exercise_entry_id;
  return { exerciseEntryId: typeof id === "string" ? id : id.value };
}
