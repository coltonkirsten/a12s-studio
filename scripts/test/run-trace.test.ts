import assert from "node:assert/strict";
import { test } from "node:test";
import type { RunStep, RunSummary } from "@a12s-studio/contract/api";
import { header, step } from "../run-trace.ts";

const run: RunSummary = {
  turn: "t_1",
  team: "web",
  agent: "web-dev",
  thread: "th_abc",
  session: "s",
  status: "failed",
  error: "Tool loop",
  startedAt: Date.UTC(2026, 0, 1, 9, 0, 0),
  finishedAt: Date.UTC(2026, 0, 1, 9, 0, 42),
  costUsd: 0.125,
  index: {
    lines: 30,
    bytes: 20_000,
    unparsed: 0,
    firstAt: Date.UTC(2026, 0, 1, 9, 0, 0),
    lastAt: Date.UTC(2026, 0, 1, 9, 0, 41),
    tools: [
      { name: "Bash", calls: 3, errors: 2, ms: 7500, maxMs: 5000, maxInput: 30 },
      { name: "Read", calls: 1, errors: 0, ms: 100, maxMs: 100, maxInput: 20 },
    ],
    stallMs: 0,
    errors: 2,
    retries: { tool: 2, api: 0 },
    hooks: { runs: 4, errors: 0 },
    subAgents: 0,
  },
};

const tool: RunStep = {
  id: "c1",
  child: null,
  at: Date.UTC(2026, 0, 1, 9, 0, 3),
  kind: "tool",
  agent: "a1",
  name: "Bash",
  text: '{"command":\n"npm test"}',
  output: "exit 1",
  isError: true,
  ms: 2000,
};

test("a run's header says how it went and where it struggled", () => {
  assert.equal(
    header(run),
    "t_1 · web-dev · failed · 2026-01-01 09:00:00 · 42.0s · $0.13 · thread th_abc\n" +
      "  tools Bash×3 (2 failed) 7.5s, Read×1 0.1s | errors 2 | retries tool 2, api 0 | hooks 4 | 30 lines, 20 KB\n" +
      "  error: Tool loop",
  );
});

test("a step is one line, cut, unless the full run is asked for", () => {
  const start = run.index.firstAt;
  assert.equal(step(tool, start, false), '+3.0s [a1] tool Bash (2.0s): {"command": "npm test"} → ✗ exit 1');
  assert.equal(step({ ...tool, output: "x".repeat(300) }, start, false).length, 160);
  assert.equal(step(tool, start, true), '+3.0s [a1] tool Bash (2.0s):\n    {"command":\n    "npm test"}\n  → ✗ exit 1');
});
