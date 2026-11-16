const DAY = 24 * 60 * 60 * 1000;

function dayStart(ms: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** Mail-style: a time today, then Yesterday, a weekday this week, a date this year, a full date before. */
export function shortTime(at: number, now: number, locale?: string): string {
  const date = new Date(at);
  const days = Math.round((dayStart(now) - dayStart(at)) / DAY);
  if (days <= 0) return date.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" });
  if (days === 1) return "Yesterday";
  if (days < 7) return date.toLocaleDateString(locale, { weekday: "long" });
  if (date.getFullYear() === new Date(now).getFullYear()) {
    return date.toLocaleDateString(locale, { day: "numeric", month: "short" });
  }
  return date.toLocaleDateString(locale, { day: "numeric", month: "short", year: "numeric" });
}
