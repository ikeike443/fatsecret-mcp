// FatSecret's delegated methods take dates as an integer day count since
// the Unix epoch (1970-01-01 UTC) rather than an ISO date string — e.g.
// food_entries.get's "date" param, weight.update's "date" param.
const MS_PER_DAY = 1000 * 60 * 60 * 24;

/** ISO date string (YYYY-MM-DD) or Date -> FatSecret's "days since epoch". Defaults to today (UTC). */
export function toFatSecretDate(date?: string | Date): number {
  const d = date === undefined ? new Date() : new Date(date);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`Invalid date: ${String(date)}`);
  }
  return Math.floor(d.getTime() / MS_PER_DAY);
}

/** FatSecret's "days since epoch" -> ISO date string (YYYY-MM-DD, UTC). */
export function fromFatSecretDate(daysSinceEpoch: number): string {
  return new Date(daysSinceEpoch * MS_PER_DAY).toISOString().slice(0, 10);
}
