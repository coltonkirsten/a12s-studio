import type { ModelCosts } from "./a12s/port.ts";

// What a Turn reports about money: each model's running total in its harness session (section 7.4).
export type SessionCosts = { session: string | null; modelCostsUsd: ModelCosts };

// A Turn's share of its session's totals. `previous` is the agent's last Turn before it that had a session.
// A total counts in full whenever it cannot be a continuation of the previous one: another session, a model the
// previous Turn did not list, or a total smaller than before.
export function turnCost(turn: SessionCosts, previous: SessionCosts | undefined): number {
  if (turn.session === null) return 0;
  const before = previous?.session === turn.session ? previous.modelCostsUsd : {};
  let usd = 0;
  for (const [model, total] of Object.entries(turn.modelCostsUsd)) {
    const earlier = before[model];
    usd += earlier !== undefined && earlier <= total ? total - earlier : total;
  }
  return usd;
}
