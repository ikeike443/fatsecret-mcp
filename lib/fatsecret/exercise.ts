// exercise_entries.* — Signed & Delegated, operate on the authenticated
// FatSecret user's own exercise diary. See lib/fatsecret/oauth1.ts.
//
// UNVERIFIED: unlike foods.search/food.get/food_entries.get/weights.get_month
// (each confirmed against a working third-party FatSecret client — see the
// PR description for sources), no reference implementation of FatSecret's
// exercise_entries.* methods was found while building this. The method
// name/params below are a best-effort guess following the same
// {resource}.{verb} + days-since-epoch date convention every other
// FatSecret method uses — confirm the exact method name and parameters
// against https://platform.fatsecret.com/docs/guides once you have API
// access, before relying on create_exercise_entry for a real write.
import { fatsecretDelegatedRequest } from "./oauth1";
import { asArray } from "./foods";
import { toFatSecretDate } from "./date";

interface RawExerciseEntry {
  exercise_entry_id: string;
  exercise_id?: string;
  exercise_name: string;
  minutes: string;
  calories?: string;
  date_int: string;
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
      exerciseEntryId: e.exercise_entry_id,
      exerciseId: e.exercise_id ?? null,
      name: e.exercise_name,
      minutes: Number(e.minutes),
      calories: e.calories ? Number(e.calories) : null,
      dateDaysSinceEpoch: Number(e.date_int),
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
