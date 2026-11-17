import type { Grant } from "@a12s-studio/contract/broker-admin";

const DAY = 24 * 60 * 60 * 1000;

/** The methods a grant may list (build-spec 9.3). */
export const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

/** A grant's lifetime in days; null is no expiry. */
export type Lifetime = number | null;

const DAYS = [1, 7, 30, 90];

/** The lifetimes the owner picks from: the usual ones, the one an agent asked for, and no expiry last. */
export function lifetimes(wanted: Lifetime): Lifetime[] {
  const days = wanted === null || DAYS.includes(wanted) ? DAYS : [...DAYS, wanted].toSorted((a, b) => a - b);
  return [...days, null];
}

export function lifetimeLabel(days: Lifetime): string {
  if (days === null) return "No expiry";
  return days === 1 ? "1 day" : `${days} days`;
}

export function expiresAt(days: Lifetime, now: number): number | undefined {
  return days === null ? undefined : now + days * DAY;
}

/** "Expires in 5 days": whole days, rounded, so a grant made for seven days reads seven until a half-day has gone. */
export function expiryText(at: number | null, now: number): string {
  if (at === null) return "No expiry";
  const left = at - now;
  if (left <= 0) return "Expired";
  if (left < DAY) return "Expires in under a day";
  const days = Math.round(left / DAY);
  return days === 1 ? "Expires in 1 day" : `Expires in ${days} days`;
}

/** Grants the broker still honours: not revoked and not past their expiry, whether or not the sweep has seen it. */
export function activeGrants(grants: Grant[], now: number): Grant[] {
  return grants.filter(
    (g) => g.revokedAt === null && g.expiredAt === null && (g.expiresAt === null || g.expiresAt > now),
  );
}
