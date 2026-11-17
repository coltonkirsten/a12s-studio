import assert from "node:assert/strict";
import { test } from "node:test";
import type { ToolCall } from "@a12s-studio/contract/api";
import { TOOL_PREFIX } from "@a12s-studio/contract/names";
import type { MessageView } from "@a12s-studio/contract/state";
import { idleRun } from "../src/steer.ts";

const sent = (from: string, at: number): MessageView => ({
  id: `m_${at}`,
  from,
  to: from === "a" ? "b" : "a",
  body: "",
  file: null,
  at,
  cause: null,
  depth: 0,
  delivered: null,
});
const call = (name: string, startedAt: number): ToolCall => ({
  id: `c${startedAt}`,
  name,
  line: "",
  input: "",
  output: null,
  isError: false,
  parent: null,
  startedAt,
  finishedAt: startedAt,
});
const post = (at: number) => call(`${TOOL_PREFIX}post`, at);

test("the idle run counts messages in a row whose sender called nothing but post since the one before", () => {
  const exchanged = [sent("a", 10), sent("b", 20), sent("a", 30), sent("b", 40), sent("a", 50)];
  const cases: [string, Record<string, ToolCall[]>, number][] = [
    ["no calls at all", {}, 5],
    ["only the posts", { a: [post(9), post(29), post(49)], b: [post(19), post(39)] }, 5],
    ["work before the first", { a: [call("Bash", 5), post(9)] }, 4],
    ["work in the middle", { a: [call("Write", 25)] }, 2],
    [
      "work before each",
      { a: [call("Bash", 5), call("Bash", 25), call("Bash", 45)], b: [call("Read", 15), call("Read", 35)] },
      0,
    ],
    ["another agent's work does not count", { b: [call("Bash", 25)] }, 5],
    ["a call at the start belongs to no window", { a: [call("Bash", 0)] }, 5],
  ];
  for (const [name, calls, want] of cases) {
    assert.equal(idleRun(exchanged, 0, new Map(Object.entries(calls))), want, name);
  }
});
