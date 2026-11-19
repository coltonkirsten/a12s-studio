import assert from "node:assert/strict";
import { test } from "node:test";
import type { A12sEvent as SdkEvent } from "@coltonkirsten/a12s";
import type { A12sEvent } from "../src/a12s/port.ts";
import { modelCostsUsd, refusal, streamEvents, toEvent } from "../src/a12s/real.ts";

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
      "phase without one",
      { ...envelope, turn: "", type: "agent_computer.phase", data: { phase: "Asleep" } },
      { type: "agent_computer.phase", agent: "web-lead", at, phase: "Asleep" },
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
      { type: "turn.started", agent: "web-lead", at, turn: "t1", messageIds: ["m_A", "m_B"] },
    ],
    [
      "a background Turn delivers nothing",
      {
        ...envelope,
        type: "turn.started",
        data: {
          harness: { kind: "claude-code", version: "1" },
          resumed: true,
          prompt: "",
          cwd: "",
          reason: "background",
        },
      },
      { type: "turn.started", agent: "web-lead", at, turn: "t1", messageIds: [] },
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
        modelCostsUsd: { a: 0.25, b: 0.5 },
        tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
      },
    ],
    [
      "a Turn that ended before the harness started has no session and no cost",
      {
        ...envelope,
        // a12s sends null where its SDK types a string.
        session: null as unknown as string,
        type: "turn.finished",
        data: { status: "failed", error: "no credential", usage: null },
      },
      {
        type: "turn.finished",
        agent: "web-lead",
        at,
        turn: "t1",
        session: null,
        status: "failed",
        error: "no credential",
        modelCostsUsd: {},
      },
    ],
    [
      "service.phase: Unhealthy is an error, with the failed check as its reason",
      {
        ...envelope,
        agentComputer: "",
        type: "service.phase",
        data: { service: "web-addon-narrate", phase: "Unhealthy", health: "GET /healthz: 500", restarts: 2 },
      },
      { type: "service.phase", service: "web-addon-narrate", at, phase: "Error", error: "GET /healthz: 500" },
    ],
    [
      "service.phase: a failed start keeps a12s's reason",
      {
        ...envelope,
        agentComputer: "",
        type: "service.phase",
        data: {
          service: "web-addon-narrate",
          phase: "Error",
          restarts: 5,
          error: { reason: "exited 1", retryable: true },
        },
      },
      { type: "service.phase", service: "web-addon-narrate", at, phase: "Error", error: "exited 1" },
    ],
    [
      "service.phase: Ready",
      {
        ...envelope,
        agentComputer: "",
        type: "service.phase",
        data: { service: "web-addon-narrate", phase: "Ready", health: "ok", restarts: 0 },
      },
      { type: "service.phase", service: "web-addon-narrate", at, phase: "Ready" },
    ],
    ["egress.denied is dropped", { ...envelope, type: "egress.denied", data: { host: "x", port: 443 } }, null],
    [
      "inbox.changed is dropped",
      { ...envelope, type: "inbox.changed", data: {} as Extract<SdkEvent, { type: "inbox.changed" }>["data"] },
      null,
    ],
  ];
  for (const [name, input, want] of cases) assert.deepEqual(toEvent(input), want, name);
});

test("turn.steered lists the Messages that joined the running Turn", () => {
  const steered = {
    ...envelope,
    type: "turn.steered" as const,
    data: {
      requestId: "r1",
      inbox: {
        batch: "b2",
        pendingAfter: 0,
        messages: [{ id: "m_C", seq: 3, sender: "studio", via: "token:web", createdAt: envelope.ts, bytes: 3 }],
      },
    },
  };
  assert.deepEqual(toEvent(steered), { type: "turn.steered", agent: "web-lead", at, turn: "t1", messageIds: ["m_C"] });
});

test("a Turn's cost is each model's running total", () => {
  const cases: [unknown, Record<string, number>][] = [
    [null, {}],
    ["text", {}],
    [{}, {}],
    [{ costUsd: 0.3 }, {}],
    [{ modelUsage: { a: { costUSD: 0.1 }, b: { costUSD: 0.2 }, c: { inputTokens: 5 }, d: null } }, { a: 0.1, b: 0.2 }],
  ];
  for (const [usage, want] of cases) assert.deepEqual(modelCostsUsd(usage), want, JSON.stringify(usage));
});

test("a12s refusals become port errors", () => {
  const cases: [string, number, string, { code: string; message: string; fix: string | undefined }][] = [
    [
      "a known code keeps its message and fix",
      403,
      '{"code":"out_of_prefix","message":"web-x is outside","fix":"use web-"}',
      { code: "out_of_prefix", message: "web-x is outside", fix: "use web-" },
    ],
    [
      "a Message too late to withdraw is busy",
      409,
      '{"code":"already_delivered","message":"m_1 was delivered"}',
      { code: "busy", message: "m_1 was delivered", fix: undefined },
    ],
    [
      "a sleeping agent",
      503,
      '{"code":"asleep","message":"web-lead is asleep","fix":"wake it"}',
      { code: "asleep", message: "web-lead is asleep", fix: "wake it" },
    ],
    [
      "an unknown code is other",
      500,
      '{"code":"internal","message":"docker"}',
      { code: "other", message: "docker", fix: undefined },
    ],
    [
      "a code that names an Object method is other",
      400,
      '{"code":"constructor","message":"odd"}',
      { code: "other", message: "odd", fix: undefined },
    ],
    [
      "an answer that is not a12s's",
      502,
      "Bad Gateway",
      { code: "other", message: "a12s answered 502: Bad Gateway", fix: undefined },
    ],
    ["JSON that is not a refusal", 500, "null", { code: "other", message: "a12s answered 500: null", fix: undefined }],
  ];
  for (const [name, status, body, want] of cases) {
    const got = refusal(status, body);
    assert.deepEqual({ code: got.code, message: got.message, fix: got.fix }, want, name);
  }
});

test("an event stream is read frame by frame, whatever the chunks", async () => {
  const delta = { ...envelope, type: "text.delta", data: { text: "Hi" } };
  const wire = [
    "event: gap\ndata: {}\n\n",
    `id: b-1\ndata: ${JSON.stringify(delta)}\n\n`,
    ": keepalive\n\n",
    `id: b-2\ndata: ${JSON.stringify({ ...envelope, type: "inbox.changed", data: {} })}\n\n`,
    'event: head\ndata: {"id":"b-2"}\n\n',
    `id: b-3\ndata: ${JSON.stringify(delta)}`,
  ].join("");
  const want = [{ type: "gap" }, { type: "text.delta", agent: "web-lead", at, turn: "t1", text: "Hi" }, "head"];
  for (const size of [1, 7, wire.length]) {
    const chunks = Array.from({ length: Math.ceil(wire.length / size) }, (_, i) =>
      wire.slice(i * size, (i + 1) * size),
    );
    assert.deepEqual(await Array.fromAsync(streamEvents(chunks)), want, `chunks of ${size}`);
  }
});
