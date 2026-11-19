import assert from "node:assert/strict";
import { test } from "node:test";
import type { RunIndex, RunStep, RunSummary } from "@a12s-studio/contract/api";
import { type ThreadId, TOOL_PREFIX } from "@a12s-studio/contract/names";
import { callLabel, flagsOf, groupRuns, squashedScale, waterfall } from "./runs.ts";

const quiet: RunIndex = {
  lines: 10,
  bytes: 100,
  unparsed: 0,
  firstAt: 0,
  lastAt: 1000,
  tools: [{ name: "Bash", calls: 1, errors: 0, ms: 500, maxMs: 500, maxInput: 20 }],
  stallMs: 0,
  errors: 0,
  retries: { tool: 0, api: 0 },
  hooks: { runs: 0, errors: 0 },
  subAgents: 0,
};

function run(turn: string, thread: ThreadId | null, agent: string, startedAt: number, index: Partial<RunIndex> = {}) {
  return {
    turn,
    team: "web",
    agent,
    thread,
    session: "s",
    status: "completed",
    error: null,
    startedAt,
    finishedAt: startedAt + 1000,
    costUsd: 0.25,
    index: { ...quiet, ...index },
  } satisfies RunSummary;
}

test("a run's flags come from its index: errors, retries, a long stall, a slow tool, a big post", () => {
  assert.deepEqual(flagsOf(quiet), []);
  const loud = flagsOf({
    ...quiet,
    errors: 2,
    retries: { tool: 1, api: 2 },
    stallMs: 300_000,
    tools: [
      { name: "Bash", calls: 3, errors: 1, ms: 200_000, maxMs: 180_000, maxInput: 30 },
      { name: `${TOOL_PREFIX}post`, calls: 1, errors: 0, ms: 100, maxMs: 100, maxInput: 9000 },
    ],
  });
  assert.deepEqual(
    loud.map((f) => [f.kind, f.label]),
    [
      ["error", "2 errors"],
      ["retry", "1 tool, 2 API retries"],
      ["stall", "stalled 5 min"],
      ["slow", "Bash took 3 min"],
      ["post", "post of 9k characters"],
    ],
  );
});

test("runs group by thread, newest activity first, with their agents, cost and flags", () => {
  const groups = groupRuns([
    run("t3", "th_b", "web-dev", 5000, { errors: 1 }),
    run("t2", "th_a", "web-dev", 3000),
    run("t1", "th_a", "web-lead", 1000, { errors: 1 }),
    run("t0", null, "web-lead", 0),
  ]);
  assert.deepEqual(
    groups.map((g) => [g.key, g.runs.map((r) => r.turn), g.agents, g.costUsd, g.flags.map((f) => f.label)]),
    [
      ["th_b", ["t3"], ["web-dev"], 0.25, ["1 run: errors"]],
      ["th_a", ["t1", "t2"], ["web-dev", "web-lead"], 0.5, ["1 run: errors"]],
      ["web:none", ["t0"], ["web-lead"], 0.25, []],
    ],
  );
});

test("idle time longer than the gap is squashed to a fixed width; busy time shares the rest", () => {
  // Two busy seconds an hour apart, 100 px wide with a 10 px gap: each second gets 45 px.
  const { x, breaks } = squashedScale(
    [
      [0, 1000],
      [3_601_000, 3_602_000],
    ],
    100,
    60_000,
    10,
  );
  assert.deepEqual([x(0), x(1000), x(3_601_000), x(3_602_000)], [0, 45, 55, 100]);
  assert.deepEqual(breaks, [{ x: 45, ms: 3_600_000 }]);
  // A short pause is drawn to scale, not squashed.
  const near = squashedScale(
    [
      [0, 1000],
      [2000, 3000],
    ],
    300,
    60_000,
    10,
  );
  assert.deepEqual([near.x(1000), near.x(2000), near.breaks.length], [100, 200, 0]);
});

const step = (over: Partial<RunStep>): RunStep => ({
  id: null,
  child: null,
  at: 0,
  kind: "tool",
  agent: null,
  name: "Bash",
  text: "{}",
  output: null,
  isError: false,
  ms: 10,
  ...over,
});

test("the waterfall nests each sub-agent's calls and last text under the call that started it", () => {
  const rows = waterfall([
    step({ id: "c1", name: "Agent", child: "a1", text: '{"description":"Look around"}' }),
    step({ id: "c2", agent: "a1", name: "Read" }),
    step({ kind: "text", agent: "a1", name: "", text: "Found it." }),
    step({ kind: "error", name: "api_error", text: "Overloaded" }),
    step({ id: "c3", name: "Bash" }),
    step({ kind: "prompt", agent: "a9", name: "", text: "Find the links." }),
    step({ id: "c4", agent: "a9", name: "Grep" }),
  ]);
  assert.deepEqual(
    rows.map((r) => [r.kind, r.kind === "agent" ? r.id : r.step.id, r.depth, r.kind === "agent" ? r.label : ""]),
    [
      ["call", "c1", 0, ""],
      ["agent", "a1", 1, "Look around"],
      ["call", "c2", 1, ""],
      ["error", null, 0, ""],
      ["call", "c3", 0, ""],
      ["agent", "a9", 1, "Find the links."],
      ["call", "c4", 1, ""],
    ],
  );
  assert.equal(rows[1]?.kind === "agent" && rows[1].text, "Found it.");
  assert.equal(callLabel(rows[0]?.kind === "call" ? rows[0].step : step({})), "Look around");
});
