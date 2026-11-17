import assert from "node:assert/strict";
import { test } from "node:test";
import { turnCost } from "../src/cost.ts";
import { studio, until } from "./studio.ts";

const cases: {
  name: string;
  previous?: { session: string | null; modelCostsUsd: Record<string, number> };
  turn: { session: string | null; modelCostsUsd: Record<string, number> };
  usd: number;
}[] = [
  {
    name: "the first Turn counts in full",
    turn: { session: "s1", modelCostsUsd: { sonnet: 0.4 } },
    usd: 0.4,
  },
  {
    name: "two Turns in one session: only the growth",
    previous: { session: "s1", modelCostsUsd: { sonnet: 0.4 } },
    turn: { session: "s1", modelCostsUsd: { sonnet: 0.75 } },
    usd: 0.35,
  },
  {
    name: "a new session counts in full",
    previous: { session: "s1", modelCostsUsd: { sonnet: 0.4 } },
    turn: { session: "s2", modelCostsUsd: { sonnet: 0.1 } },
    usd: 0.1,
  },
  {
    name: "a model missing from the previous Turn counts in full",
    previous: { session: "s1", modelCostsUsd: { sonnet: 0.4 } },
    turn: { session: "s1", modelCostsUsd: { sonnet: 0.5, opus: 0.3 } },
    usd: 0.4,
  },
  {
    name: "a smaller total than before counts in full",
    previous: { session: "s1", modelCostsUsd: { sonnet: 0.4 } },
    turn: { session: "s1", modelCostsUsd: { sonnet: 0.25 } },
    usd: 0.25,
  },
  {
    name: "no session costs nothing",
    previous: { session: "s1", modelCostsUsd: { sonnet: 0.4 } },
    turn: { session: null, modelCostsUsd: { sonnet: 0.9 } },
    usd: 0,
  },
  {
    name: "a sub-agent's model counts from its first appearance, the agent's own by its growth",
    previous: { session: "s1", modelCostsUsd: { sonnet: 1 } },
    turn: { session: "s1", modelCostsUsd: { sonnet: 1.2, haiku: 0.05 } },
    usd: 0.25,
  },
  {
    name: "a model the Turn does not report adds nothing",
    previous: { session: "s1", modelCostsUsd: { sonnet: 1, haiku: 0.05 } },
    turn: { session: "s1", modelCostsUsd: { sonnet: 1.1 } },
    usd: 0.1,
  },
  {
    name: "no growth costs nothing",
    previous: { session: "s1", modelCostsUsd: { sonnet: 1 } },
    turn: { session: "s1", modelCostsUsd: { sonnet: 1 } },
    usd: 0,
  },
];

for (const { name, previous, turn, usd } of cases) {
  test(`cost rule: ${name}`, () => {
    assert.ok(Math.abs(turnCost(turn, previous) - usd) < 1e-9, `${turnCost(turn, previous)} != ${usd}`);
  });
}

test("a stored Turn's cost is its share of the session's totals, past a Turn that had no session", async (t) => {
  const s = await studio({ live: true });
  t.after(() => s.close());
  await s.twoTeams();
  await until(() => s.app.live.up());
  const cost = () =>
    s.db
      .prepare("SELECT cost_usd AS usd FROM turns WHERE agent_id = 'web-lead' ORDER BY finished_at, rowid")
      .all()
      .map((r) => Math.round(Number(r.usd) * 100) / 100);
  let n = 0;
  // Each Turn as a12s reports it, so its session can be any value, none included.
  const turn = async (session: string | null, modelCostsUsd: Record<string, number>) => {
    const id = `t_cost${++n}`;
    const at = Date.now();
    s.a12s.emit({ type: "turn.started", agent: "web-lead", at, turn: id, messageIds: [] });
    s.a12s.emit({
      type: "turn.finished",
      agent: "web-lead",
      at,
      turn: id,
      session,
      status: "completed",
      modelCostsUsd,
    });
    while (cost().length < n) await new Promise((resolve) => setTimeout(resolve, 5));
  };

  await turn("s1", { sonnet: 0.5 });
  await turn("s1", { sonnet: 0.8 });
  await turn(null, {});
  await turn("s1", { sonnet: 1.1, haiku: 0.2 });
  await turn("s2", { sonnet: 0.15 });
  assert.deepEqual(cost(), [0.5, 0.3, 0, 0.5, 0.15]);
});
