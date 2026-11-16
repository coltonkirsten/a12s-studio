import assert from "node:assert/strict";
import { test } from "node:test";
import { A12sError as SdkError, type A12sEvent as SdkEvent } from "@coltonkirsten/a12s";
import { A12sError, type A12sEvent } from "../src/a12s/port.ts";
import { costTotalUsd, portError, toEvent } from "../src/a12s/real.ts";

const envelope = { v: 1, agentComputer: "web-lead", session: "s1", turn: "t1", seq: 4, ts: "2026-01-02T03:04:05.678Z" };
const at = Date.UTC(2026, 0, 2, 3, 4, 5, 678);

test("a12s events become port events", () => {
  const cases: [string, SdkEvent, A12sEvent | null][] = [
    [
      "phase with a failure",
      {
        ...envelope,
        turn: "",
        type: "agent_computer.phase",
        data: { phase: "Error", error: { reason: "no image", retryable: false } },
      },
      { type: "agent_computer.phase", agent: "web-lead", at, phase: "Error", error: "no image" },
    ],
    [
      "Unhealthy is an error",
      { ...envelope, turn: "", type: "agent_computer.phase", data: { phase: "Unhealthy" } },
      { type: "agent_computer.phase", agent: "web-lead", at, phase: "Error", error: "Unhealthy" },
    ],
    [
      "turn.started lists the delivered Messages",
      {
        ...envelope,
        type: "turn.started",
        data: {
          harness: { kind: "claude-code", version: "1" },
          resumed: false,
          prompt: "",
          cwd: "/home/agent",
          inbox: {
            batch: "b1",
            pendingAfter: 0,
            messages: [
              { id: "m_A", seq: 1, sender: "studio", via: "token:web", createdAt: envelope.ts, bytes: 3 },
              { id: "m_B", seq: 2, sender: "studio", via: "token:web", createdAt: envelope.ts, bytes: 3 },
            ],
          },
        },
      },
      { type: "turn.started", agent: "web-lead", at, turn: "t1", session: "s1", messageIds: ["m_A", "m_B"] },
    ],
    [
      "a background Turn in a new session delivers nothing and has no session id yet",
      {
        ...envelope,
        // a12s sends null where its SDK types a string.
        session: null as unknown as string,
        type: "turn.started",
        data: {
          harness: { kind: "claude-code", version: "1" },
          resumed: true,
          prompt: "",
          cwd: "",
          reason: "background",
        },
      },
      { type: "turn.started", agent: "web-lead", at, turn: "t1", session: "", messageIds: [] },
    ],
    [
      "text.delta",
      { ...envelope, type: "text.delta", data: { text: "Hi" } },
      { type: "text.delta", agent: "web-lead", at, turn: "t1", text: "Hi" },
    ],
    [
      "a sub-agent's tool call keeps its parent",
      { ...envelope, type: "tool.started", data: { id: "u2", name: "Read", input: { file_path: "a" }, parent: "u1" } },
      {
        type: "tool.started",
        agent: "web-lead",
        at,
        turn: "t1",
        id: "u2",
        name: "Read",
        input: { file_path: "a" },
        parent: "u1",
      },
    ],
    [
      "tool.finished",
      { ...envelope, type: "tool.finished", data: { id: "u2", name: "Read", isError: true, output: "nope" } },
      {
        type: "tool.finished",
        agent: "web-lead",
        at,
        turn: "t1",
        id: "u2",
        name: "Read",
        isError: true,
        output: "nope",
      },
    ],
    [
      "turn.finished carries cost and tokens",
      {
        ...envelope,
        type: "turn.finished",
        data: {
          status: "failed",
          error: "Failed to authenticate",
          usage: { costUsd: 9, modelUsage: { a: { costUSD: 0.25 }, b: { costUSD: 0.5 } } },
          tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
        },
      },
      {
        type: "turn.finished",
        agent: "web-lead",
        at,
        turn: "t1",
        session: "s1",
        status: "failed",
        error: "Failed to authenticate",
        costTotalUsd: 0.75,
        tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
      },
    ],
    ["gap", { ...envelope, type: "gap", data: {} }, { type: "gap" }],
    ["egress.denied is dropped", { ...envelope, type: "egress.denied", data: { host: "x", port: 443 } }, null],
    [
      "inbox.changed is dropped",
      { ...envelope, type: "inbox.changed", data: {} as Extract<SdkEvent, { type: "inbox.changed" }>["data"] },
      null,
    ],
  ];
  for (const [name, input, want] of cases) assert.deepEqual(toEvent(input), want, name);
});

test("a Turn's cost is the sum of modelUsage", () => {
  const cases: [unknown, number][] = [
    [null, 0],
    ["text", 0],
    [{}, 0],
    [{ costUsd: 0.3 }, 0.3],
    [{ costUsd: 0.3, modelUsage: {} }, 0],
    [{ modelUsage: { a: { costUSD: 0.1 }, b: { costUSD: 0.2 }, c: { inputTokens: 5 }, d: null } }, 0.1 + 0.2],
  ];
  for (const [usage, want] of cases) assert.equal(costTotalUsd(usage), want, JSON.stringify(usage));
});

test("a12s errors become port errors", () => {
  const refused = new TypeError("fetch failed", {
    cause: Object.assign(new Error("connect"), { code: "ECONNREFUSED" }),
  });
  const bug = new RangeError("bug");
  const cases: [string, unknown, { code: string; message: string; fix?: string | undefined } | Error][] = [
    [
      "a known code keeps its message and fix",
      new SdkError(403, { code: "out_of_prefix", message: "web-x is outside", fix: "use web-" }),
      { code: "out_of_prefix", message: "web-x is outside", fix: "use web-" },
    ],
    [
      "a Message too late to withdraw is busy",
      new SdkError(409, { code: "already_delivered", message: "m_1 was delivered" }),
      { code: "busy", message: "m_1 was delivered", fix: undefined },
    ],
    [
      "an unknown code is other",
      new SdkError(500, { code: "internal", message: "docker" }),
      { code: "other", message: "docker", fix: undefined },
    ],
    [
      "a refused connection is unreachable",
      refused,
      {
        code: "unreachable",
        message: "a12s is not answering.",
        fix: "Start Docker; the Fleet's Controller starts with it.",
      },
    ],
    ["anything else is left alone", bug, bug],
  ];
  for (const [name, input, want] of cases) {
    const got = portError(input);
    if (want instanceof Error) assert.equal(got, want, name);
    else {
      assert.ok(got instanceof A12sError, name);
      assert.deepEqual({ code: got.code, message: got.message, fix: got.fix }, want, name);
    }
  }
});
