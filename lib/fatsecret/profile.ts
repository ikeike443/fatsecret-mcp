// profile.get — Signed & Delegated, read-only. See lib/fatsecret/oauth1.ts.
//
// Field shape below is reconstructed from FatSecret's documented method
// description, not a captured real response (no real account was available
// while building this) — confirm against a real get_profile call once
// FATSECRET_ACCESS_TOKEN is set up (README's manual-verification checklist)
// and adjust if any field name is off. Passed through close to raw with
// snake_case -> camelCase only, deliberately not narrowed further, so an
// unexpected/renamed field still surfaces instead of being silently dropped.
import { fatsecretDelegatedRequest } from "./oauth1";

interface RawProfile {
  last_weight_kg?: string;
  last_weight_date_int?: string;
  weight_measure?: string;
  height_measure?: string;
  goal_weight_kg?: string;
  [key: string]: unknown;
}

interface RawProfileGetResponse {
  profile: RawProfile;
}

export async function getProfile() {
  const data = await fatsecretDelegatedRequest<RawProfileGetResponse>(
    "profile.get",
    {}
  );
  const p = data.profile;
  return {
    lastWeightKg: p.last_weight_kg ? Number(p.last_weight_kg) : null,
    lastWeightDateDaysSinceEpoch: p.last_weight_date_int
      ? Number(p.last_weight_date_int)
      : null,
    weightMeasure: p.weight_measure ?? null,
    heightMeasure: p.height_measure ?? null,
    goalWeightKg: p.goal_weight_kg ? Number(p.goal_weight_kg) : null,
    raw: p,
  };
}
