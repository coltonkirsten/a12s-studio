import assert from "node:assert/strict";
import { test } from "node:test";
import type { Delivered, MessageView, ThreadView } from "@a12s-studio/contract/state";
import { chainRows, chainTotals, deliveryLine } from "./chain.ts";

let n = 0;
function msg(from: string, to: string, delivered: Delivered | null = null, body = "b"): MessageView {
  n += 1;
  return { id: `m_${n}`, from, to, body, file: null, at: n, cause: null, depth: 0, delivered };
}
const joined = (turn: string, costUsd: number | null = null): Delivered => ({ turn, steered: true, at: 0, costUsd });
const started = (turn: string, costUsd: number | null = null): Delivered => ({ turn, steered: false, at: 0, costUsd });

test("the delivery line says how a message reached its agent", () => {
  const rows: [MessageView, string | null][] = [
    [msg("owner", "web-dev"), "waiting for Dev"],
    [msg("web-lead", "web-dev", started("t1")), "woke Dev"],
    [msg("web-lead", "web-ux-writer", joined("t1")), "joined Ux writer's turn"],
    [msg("web-lead", "owner"), null],
  ];
  for (const [m, line] of rows) assert.equal(deliveryLine(m), line, `${m.from}>${m.to}`);
});

test("chain rows keep order, cause and depth, and show a Turn's cost on its first message only", () => {
  const owner = msg("owner", "web-lead", started("t1", 0.5));
  const ask = { ...msg("web-lead", "web-dev", started("t2", 0.25)), cause: owner.id, depth: 1 };
  const answer = { ...msg("web-dev", "web-lead", joined("t1", 0.5)), cause: ask.id, depth: 2 };
  const running = { ...msg("web-lead", "web-dev", joined("t2", 0.25)), cause: answer.id, depth: 3 };
  const unfinished = msg("owner", "web-dev", started("t3"));
  const rows = chainRows([owner, ask, answer, running, unfinished]);
  assert.deepEqual(
    rows.map((r) => [r.depth, r.from, r.to, r.cause, r.delivery, r.turnCostUsd]),
    [
      [0, "owner", "web-lead", null, "woke Lead", 0.5],
      [1, "web-lead", "web-dev", owner.id, "woke Dev", 0.25],
      [2, "web-dev", "web-lead", ask.id, "joined Lead's turn", null],
      [3, "web-lead", "web-dev", answer.id, "joined Dev's turn", null],
      [0, "owner", "web-dev", null, "woke Dev", null],
    ],
  );
});

test("a row's start is the body on one line, cut", () => {
  const [short, long] = chainRows([
    msg("owner", "web-lead", null, "Two\n  lines."),
    msg("owner", "web-lead", null, "x".repeat(200)),
  ]);
  assert.equal(short?.start, "Two lines.");
  assert.equal(long?.start.length, 80);
  assert.ok(long?.start.endsWith("…"));
});

test("the totals are the thread's messages and its chain", () => {
  const thread: ThreadView = {
    id: "th_1",
    teamId: "web",
    title: "T",
    ownerId: "web-lead",
    status: "open",
    messages: [msg("owner", "web-lead"), msg("web-lead", "owner")],
    hasMore: false,
    chain: { depth: 12, turns: 7, costUsd: 1.25 },
  };
  assert.deepEqual(chainTotals(thread), { messages: 2, depth: 12, turns: 7, costUsd: 1.25 });
});
