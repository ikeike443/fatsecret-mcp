import { timingSafeEqual } from "node:crypto";

/**
 * Constant-time string comparison, safe for comparing secrets against
 * user-supplied input without leaking length/prefix via timing.
 */
export function timingSafeEqualStrings(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
