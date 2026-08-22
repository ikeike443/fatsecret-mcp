// profile.get — Signed & Delegated, read-only. See lib/fatsecret/oauth1.ts.
//
// Verified against a real profile.get response (see PR history): the shape
// below — including height_cm, added after that verification — matches a
// real account's response. weight_measure/height_measure come back
// capitalized ("Kg"/"Cm"), not lowercase; passed through as-is rather than
// normalized, since nothing here depends on their case. Still passed
// through close to raw with snake_case -> camelCase only, deliberately not
// narrowed further, so an unexpected/renamed field still surfaces via `raw`
// instead of being silently dropped.
import { fatsecretDelegatedRequest } from "./oauth1";

interface RawProfile {
  last_weight_kg?: string;
  last_weight_date_int?: string;
  weight_measure?: string;
  height_cm?: string;
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
    heightCm: p.height_cm ? Number(p.height_cm) : null,
    heightMeasure: p.height_measure ?? null,
    goalWeightKg: p.goal_weight_kg ? Number(p.goal_weight_kg) : null,
    raw: p,
  };
}
