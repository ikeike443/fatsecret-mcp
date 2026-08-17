// weights.get_month / weight.update — Signed & Delegated, operate on the
// authenticated FatSecret user's own weight diary. See lib/fatsecret/oauth1.ts.
// Reportedly Premier-plan gated (see README) — confirm when registering.
//
// Response/param shapes below are reconstructed from FatSecret's documented
// method descriptions, not a captured real response — confirm against a
// real account once FATSECRET_ACCESS_TOKEN is set up (README's
// manual-verification checklist) and adjust field names if any are off.
import { fatsecretDelegatedRequest } from "./oauth1";
import { asArray } from "./foods";
import { toFatSecretDate, fromFatSecretDate } from "./date";

interface RawWeightDay {
  date_int: string;
  weight_kg: string;
  weight_comment?: string;
}

interface RawWeightsGetMonthResponse {
  month: {
    from_date_int?: string;
    to_date_int?: string;
    day?: RawWeightDay | RawWeightDay[];
  };
}

/** date: any day within the target month (defaults to today, UTC). */
export async function getWeightHistory(date?: string) {
  const data = await fatsecretDelegatedRequest<RawWeightsGetMonthResponse>(
    "weights.get_month.v2",
    { date: toFatSecretDate(date) }
  );
  return {
    entries: asArray(data.month.day).map((d) => ({
      date: fromFatSecretDate(Number(d.date_int)),
      weightKg: Number(d.weight_kg),
      comment: d.weight_comment ?? null,
    })),
  };
}

export interface UpdateWeightInput {
  weightKg: number;
  date?: string;
  comment?: string;
  /** Optional current height in cm, if updating it alongside weight. */
  heightCm?: number;
  /** Optional goal weight in kg. */
  goalWeightKg?: number;
}

export async function updateWeight(input: UpdateWeightInput) {
  // weight_type/height_type pin the unit of the numeric fields below to kg
  // /cm explicitly, since FatSecret's profile-level unit preference
  // otherwise controls how these are interpreted.
  await fatsecretDelegatedRequest<unknown>("weight.update", {
    date: toFatSecretDate(input.date),
    current_weight_kg: input.weightKg,
    weight_type: "kg",
    current_height_cm: input.heightCm,
    height_type: input.heightCm === undefined ? undefined : "cm",
    goal_weight_kg: input.goalWeightKg,
    comment: input.comment,
  });
  return { updated: true, date: toFatSecretDate(input.date), weightKg: input.weightKg };
}
