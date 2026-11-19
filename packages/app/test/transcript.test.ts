import assert from "node:assert/strict";
import { test } from "node:test";
import { assign, index, shares, steps, wholeLines } from "../src/transcript.ts";

const at = (s: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, s)).toISOString();
const ms = (s: number) => Date.UTC(2026, 0, 1, 0, 0, s);
const line = (o: Record<string, unknown>) => JSON.stringify(o);

const user = (s: number, content: unknown, extra = {}) =>
  line({ type: "user", timestamp: at(s), message: { role: "user", content }, ...extra });
const assistant = (s: number, content: unknown[], extra = {}) =>
  line({ type: "assistant", timestamp: at(s), message: { role: "assistant", content }, ...extra });
const call = (s: number, id: string, name: string, input: unknown, extra = {}) =>
  assistant(s, [{ type: "tool_use", id, name, input }], extra);
const result = (s: number, id: string, content: unknown, isError = false, extra = {}) =>
  user(s, [{ type: "tool_result", tool_use_id: id, content, is_error: isError }], extra);

// One Turn as Claude Code writes it: a session-start hook, the instructions, the prompt, a Bash call that fails and
// is tried again, a sub-agent's Read, an API retry, a steered message and the answer.
const TURN = [
  line({
    type: "attachment",
    timestamp: at(0),
    attachment: {
      type: "hook_success",
      hookName: "SessionStart:startup",
      content: "# Owner rules\nNone.",
      exitCode: 0,
      durationMs: 12,
    },
  }),
  line({
    type: "attachment",
    timestamp: at(0),
    attachment: { type: "instructions", files: [{ path: "/home/agent/CLAUDE.md", content: "You are dev." }] },
  }),
  line({ type: "attachment", timestamp: at(0), attachment: { type: "date", date: "2026-01-01" } }),
  line({ type: "queue-operation", operation: "enqueue", timestamp: at(1) }),
  user(1, "Build the page."),
  assistant(2, [{ type: "thinking", thinking: "" }]),
  call(3, "c1", "Bash", { command: "npm test" }),
  result(5, "c1", "exit 1: missing script", true),
  call(6, "c2", "Bash", { command: "npm run test" }),
  result(9, "c2", [{ type: "text", text: "ok" }, { type: "image" }]),
  call(10, "c3", "Read", { file_path: "/home/agent/a.md" }, { isSidechain: true, agentId: "sub1" }),
  result(11, "c3", "contents", false, { isSidechain: true, agentId: "sub1" }),
  line({
    type: "system",
    subtype: "api_error",
    timestamp: at(12),
    error: { message: "Overloaded" },
    retryAttempt: 1,
  }),
  line({ type: "attachment", timestamp: at(13), attachment: { type: "queued_command", prompt: "Also the footer." } }),
  assistant(14, [{ type: "text", text: "Done." }]),
  line({ type: "last-prompt", lastPrompt: "Build the page." }),
];

test("whole lines are taken from a chunk and a cut last line is left for the next send", () => {
  assert.deepEqual(wholeLines(Buffer.from('{"a":1}\n{"b":2}\n{"c"'), 100), {
    lines: ['{"a":1}', '{"b":2}'],
    used: 16,
  });
  assert.deepEqual(wholeLines(Buffer.from('{"c"'), 100), { lines: [], used: 0 });
  // One line longer than the largest send is taken as it is, so the file moves on.
  assert.deepEqual(wholeLines(Buffer.from("x".repeat(8)), 8), { lines: ["x".repeat(8)], used: 8 });
});

test("each line goes to the Turn that started last before it; lines past keeping are dropped", () => {
  const starts = [
    { id: "t1", at: ms(10) },
    { id: "t2", at: ms(20) },
  ];
  const lines = [user(5, "early"), user(10, "a"), line({ type: "ai-title" }), user(19, "b"), user(25, "c")];
  assert.deepEqual(
    Object.fromEntries(assign(lines, starts, 0)),
    // Older than every Turn: the first. No time of its own: with the line before.
    { t1: [lines[0], lines[1], lines[2], lines[3]], t2: [lines[4]] },
  );
  assert.deepEqual(Object.fromEntries(assign(lines, starts, ms(11))), { t1: [lines[3]], t2: [lines[4]] });
  assert.equal(assign(lines, [], 0).size, 0);
});

test("the steps of a Turn: prompts, text, tool calls with their results and times, hooks, errors", () => {
  const got = steps(TURN, 4000, false).map(({ at: _, ...s }) => s);
  const base = { id: null, child: null, agent: null, name: "", output: null, isError: false, ms: null };
  assert.deepEqual(got, [
    { ...base, kind: "hook", name: "SessionStart:startup", text: "# Owner rules\nNone.", ms: 12 },
    {
      ...base,
      kind: "context",
      name: "instructions",
      text: JSON.stringify({
        type: "instructions",
        files: [{ path: "/home/agent/CLAUDE.md", content: "You are dev." }],
      }),
    },
    { ...base, kind: "prompt", text: "Build the page." },
    {
      ...base,
      kind: "tool",
      id: "c1",
      name: "Bash",
      text: '{"command":"npm test"}',
      output: "exit 1: missing script",
      isError: true,
      ms: 2000,
    },
    {
      ...base,
      kind: "tool",
      id: "c2",
      name: "Bash",
      text: '{"command":"npm run test"}',
      output: "ok\n[image]",
      ms: 3000,
    },
    {
      ...base,
      kind: "tool",
      id: "c3",
      agent: "sub1",
      name: "Read",
      text: '{"file_path":"/home/agent/a.md"}',
      output: "contents",
      ms: 1000,
    },
    { ...base, kind: "error", name: "api_error", text: "Overloaded (retry 1)", isError: true },
    { ...base, kind: "prompt", name: "steered", text: "Also the footer." },
    { ...base, kind: "text", text: "Done." },
  ]);
  // In full, the context the harness adds is kept too.
  assert.ok(steps(TURN, 4000, true).some((s) => s.kind === "context" && s.name === "date"));
  // Texts are cut at the limit.
  assert.equal(steps([user(0, "x".repeat(10))], 4, false)[0]?.text, "xxxx…");
});

test("the index counts tools, errors, retries, hooks and sub-agents, and finds the longest wait on the model", () => {
  const lines = [...TURN, "not json"];
  assert.deepEqual(index(lines, 1234), {
    lines: TURN.length + 1,
    bytes: 1234,
    unparsed: 1,
    firstAt: ms(0),
    lastAt: ms(14),
    tools: [
      { name: "Bash", calls: 2, errors: 1, ms: 5000, maxMs: 3000, maxInput: 26 },
      { name: "Read", calls: 1, errors: 0, ms: 1000, maxMs: 1000, maxInput: 32 },
    ],
    // From the steered message to the answer; the three seconds of the second Bash call are a tool's, not a stall.
    stallMs: 1000,
    errors: 2,
    retries: { tool: 1, api: 1 },
    hooks: { runs: 1, errors: 0 },
    subAgents: 1,
  });
});

test("a run's steps are in the order they were written, whichever file was sent first", () => {
  const side = { isSidechain: true, agentId: "a1" };
  const sub = [call(3, "c2", "Read", {}, side), result(4, "c2", "text", false, side)];
  const main = [user(1, "Go."), call(2, "c1", "Agent", {}), result(5, "c1", "done")];
  const order = (lines: string[]) => steps(lines, 100, false).map((s) => [s.kind, s.name, s.output]);
  const expected = [
    ["prompt", "", null],
    ["tool", "Agent", "done"],
    ["tool", "Read", "text"],
  ];
  assert.deepEqual(order([...sub, ...main]), expected);
  assert.deepEqual(order([...main, ...sub]), expected);
  assert.deepEqual(
    index([...sub, ...main], 0).tools.map((t) => t.name),
    ["Agent", "Read"],
  );
});

test("a stall is a gap no tool call spans", () => {
  const lines = [
    user(0, "Go."),
    call(1, "c1", "Bash", {}),
    result(61, "c1", "ok"),
    assistant(301, [{ type: "text", text: "Done." }]),
  ];
  assert.equal(index(lines, 0).stallMs, 240_000);
});

test("an Agent call names the sub-agent it started, and each agent's share of the spend is by priced tokens", () => {
  const side = { isSidechain: true, agentId: "a1" };
  const usage = (input: number, output: number) => ({ input_tokens: input, output_tokens: output });
  const said = (s: number, id: string, u: unknown, extra = {}) =>
    line({ type: "assistant", timestamp: at(s), message: { id, role: "assistant", content: [], usage: u }, ...extra });
  const lines = [
    // One response written as two lines, with its usage on each: counted once.
    said(1, "m1", usage(100, 0)),
    said(1, "m1", usage(100, 0)),
    call(2, "c1", "Agent", {}),
    said(3, "m2", usage(0, 20), side),
    result(4, "c1", "done", false, { toolUseResult: { agentId: "a1" } }),
  ];
  assert.equal(steps(lines, 100, false).find((s) => s.id === "c1")?.child, "a1");
  assert.deepEqual(shares(lines), [
    { agent: null, share: 0.5 },
    { agent: "a1", share: 0.5 },
  ]);
  assert.deepEqual(shares([user(0, "Go.")]), []);
});
