const DOLLARS = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

/** An amount as the owner reads it: "$1,234.50". */
export function usd(amount: number): string {
  return DOLLARS.format(amount);
}

/** What the owner typed in a dollar field, such as "12.5" or "$1,200"; null unless it is whole cents, not negative. */
export function parseUsd(text: string): number | null {
  const plain = text.trim().replace(/^\$\s*/, "");
  if (!/^(\d{1,3}(,\d{3})+|\d*)(\.\d{1,2})?$/.test(plain) || !/\d/.test(plain)) return null;
  return Number(plain.replaceAll(",", ""));
}

/** How full today's budget is, from 0 to 1. A budget of zero holds everything, so it is full. */
export function budgetUsed(spent: number, daily: number): number {
  return daily > 0 ? Math.min(1, spent / daily) : 1;
}
