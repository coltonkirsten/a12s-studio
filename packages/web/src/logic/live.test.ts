import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentView, StudioState } from "@a12s-studio/contract/state";

import { appendLive } from "./live.ts";

function agent(id: string, turn: string | null, text = ""): AgentView {
  return {
    id,
    slug: id.split("-")[1] ?? id,
    roleLine: "",
    model: "sonnet",
    presence: turn ? "working" : "asleep",
    line: null,
    turn: turn ? { id: turn, threadId: null, startedAt: 0, text } : null,
    queued: 0,
  };
}

function state(agents: AgentView[]): StudioState {
  return {
    rev: 7,
    a12s: "up",
    broker: "up",
    settings: {
      awakeCap: 4,
      defaultDailyBudgetUsd: 25,
      minFreeDiskGb: 15,
      paused: false,
      defaultModel: "sonnet",
      defaultSleepAfterIdle: "15m",
      defaultCompactMinTokens: 100000,
    },
    teams: [
      {
        id: "web",
        name: "Website",
        purpose: "",
        accent: "#0a84ff",
        paused: false,
        leadId: "web-lead",
        budget: { dailyUsd: 25, spentTodayUsd: 0, held: false },
        agents,
        threads: [],
      },
    ],
    needsYou: [],
    open: null,
  };
}

function textOf(s: StudioState, id: string): string | undefined {
  return s.teams[0]?.agents.find((a) => a.id === id)?.turn?.text;
}

test("appendLive appends to the matching agent's Turn only", () => {
  const before = state([agent("web-lead", "t1", "Hel"), agent("web-dev", "t2", "x")]);
  const after = appendLive(before, { agent: "web-lead", turn: "t1", text: "lo" });
  assert.equal(textOf(after, "web-lead"), "Hello");
  assert.equal(textOf(after, "web-dev"), "x");
  assert.equal(textOf(before, "web-lead"), "Hel");
  assert.equal(after.rev, 7);
});

test("appendLive ignores text for another Turn or an idle agent", () => {
  const before = state([agent("web-lead", "t1", "a"), agent("web-dev", null)]);
  assert.equal(textOf(appendLive(before, { agent: "web-lead", turn: "t0", text: "b" }), "web-lead"), "a");
  assert.equal(appendLive(before, { agent: "web-dev", turn: "t2", text: "b" }).teams[0]?.agents[1]?.turn, null);
});

test("appendLive keeps the last 4000 characters", () => {
  const before = state([agent("web-lead", "t1", "a".repeat(3999))]);
  const text = textOf(appendLive(before, { agent: "web-lead", turn: "t1", text: "bc" }), "web-lead") ?? "";
  assert.equal(text.length, 4000);
  assert.ok(text.endsWith("abc"));
});
