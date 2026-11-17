import assert from "node:assert/strict";
import { test } from "node:test";
import type { A12sEvent as SdkEvent } from "@coltonkirsten/a12s";
import type { A12sEvent } from "../src/a12s/port.ts";
import { toEvent } from "../src/a12s/real.ts";
import { ownerThread } from "../src/router.ts";
import { deriveState } from "../src/state.ts";
import { studio, until } from "./studio.ts";

type S = Awaited<ReturnType<typeof studio>>;

async function setup(t: { after(fn: () => unknown): void }): Promise<S> {
  const s = await studio({ live: true });
  t.after(() => s.close());
  await s.twoTeams();
  await until(() => s.app.live.up());
  return s;
}

const agentView = (s: S, id: string) => {
  const found = deriveState(s.app, null)
    .teams.flatMap((t) => t.agents)
    .find((a) => a.id === id);
  if (!found) throw new Error(`no agent ${id}`);
  return found;
};

// The lead takes an owner ask in a new thread; answers the Turn's id and the thread.
async function leadTurn(s: S, body = "Compare three hosting plans.") {
  const posted = ownerThread(s.app.repo.forTeam("web"), { body });
  await s.app.dispatcher.run();
  const turn = s.a12s.startTurn("web-lead");
  await until(() => agentView(s, "web-lead").turn?.threadId === posted.thread);
  return { turn, thread: posted.thread };
}

function call(turn: string | undefined, id: string, name: string, input: unknown, parent?: string): A12sEvent {
  return {
    type: "tool.started",
    agent: "web-lead",
    at: Date.now(),
    ...(turn ? { turn } : {}),
    id,
    name,
    input,
    ...(parent ? { parent } : {}),
  };
}

function callEnd(turn: string, id: string, name: string): A12sEvent {
  return { type: "tool.finished", agent: "web-lead", at: Date.now(), turn, id, name, isError: false, output: "" };
}

test("an agent that hands work to a background sub-agent stays working until the work ends", async (t) => {
  const s = await setup(t);
  const { turn, thread } = await leadTurn(s);
  s.a12s.emit(call(turn, "call-1", "Agent", { description: "Research pricing", run_in_background: true }));
  s.a12s.startTask("web-lead", {
    id: "task-1",
    kind: "local_agent",
    description: "Research pricing",
    toolUseId: "call-1",
  });
  s.a12s.emit(callEnd(turn, "call-1", "Agent"));
  s.a12s.finishTurn("web-lead");

  await until(() => agentView(s, "web-lead").turn === null);
  const lead = agentView(s, "web-lead");
  assert.equal(lead.presence, "working");
  assert.equal(lead.line, "Working in the background");
  assert.deepEqual(
    lead.work.map((w) => [w.id, w.kind, w.description, w.threadId, w.line]),
    [["task-1", "agent", "Research pricing", thread, null]],
  );

  // The sub-agent's calls arrive between Turns.
  s.a12s.emit(call(undefined, "sub-1", "Read", { file_path: "/home/agent/notes.md" }, "call-1"));
  await until(() => agentView(s, "web-lead").work[0]?.line === "Reading notes.md");
  assert.equal(agentView(s, "web-lead").line, "Working in the background");

  s.a12s.finishTask("web-lead", "task-1");
  await until(() => agentView(s, "web-lead").work.length === 0);
  assert.equal(agentView(s, "web-lead").presence, "awake");
  assert.equal(agentView(s, "web-lead").line, null);

  // The harness reads the result in a Turn of its own, with no Messages: it belongs to the work's thread, once.
  s.a12s.startTurn("web-lead");
  await until(() => agentView(s, "web-lead").turn !== null);
  assert.equal(agentView(s, "web-lead").turn?.threadId, thread);
  s.a12s.finishTurn("web-lead");
  const next = s.a12s.startTurn("web-lead");
  await until(() => agentView(s, "web-lead").turn?.id === next);
  assert.equal(agentView(s, "web-lead").turn?.threadId, null);
});

test("a sub-agent inside the Turn is listed from its call and gone when the call or the Turn ends", async (t) => {
  const s = await setup(t);
  const { turn, thread } = await leadTurn(s);
  s.a12s.emit(call(turn, "call-2", "Task", { description: "Check the links" }));
  await until(() => agentView(s, "web-lead").work.length === 1);
  assert.deepEqual(
    agentView(s, "web-lead").work.map((w) => [w.id, w.kind, w.description, w.threadId]),
    [["call-2", "agent", "Check the links", thread]],
  );

  s.a12s.emit(call(turn, "sub-2", "Grep", { pattern: "href" }, "call-2"));
  await until(() => agentView(s, "web-lead").work[0]?.line === "Searching");
  assert.equal(agentView(s, "web-lead").line, "Working with a sub-agent");
  s.a12s.emit(callEnd(turn, "call-2", "Task"));
  await until(() => agentView(s, "web-lead").work.length === 0);
  assert.equal(agentView(s, "web-lead").presence, "working");

  // An interrupted Turn never finishes its calls.
  s.a12s.emit(call(turn, "call-3", "Agent", { description: "Draft the summary" }));
  await until(() => agentView(s, "web-lead").work.length === 1);
  s.a12s.finishTurn("web-lead", { status: "interrupted" });
  await until(() => agentView(s, "web-lead").turn === null);
  assert.deepEqual(agentView(s, "web-lead").work, []);
  assert.equal(agentView(s, "web-lead").presence, "awake");
});

test("a background command and a detached process are tasks with no line", async (t) => {
  const s = await setup(t);
  const { turn, thread } = await leadTurn(s);
  s.a12s.emit(call(turn, "call-b", "Bash", { command: "npm run build", run_in_background: true }));
  s.a12s.startTask("web-lead", { id: "task-b", kind: "local_bash", description: "npm run build", toolUseId: "call-b" });
  s.a12s.finishTurn("web-lead");
  s.a12s.startTask("web-lead", { id: "proc-1", kind: "process", description: "a preview server" });

  await until(() => agentView(s, "web-lead").work.length === 2);
  const lead = agentView(s, "web-lead");
  assert.equal(lead.presence, "working");
  assert.deepEqual(
    lead.work.map((w) => [w.id, w.kind, w.description, w.threadId, w.line]),
    [
      ["task-b", "task", "npm run build", thread, null],
      ["proc-1", "task", "a preview server", null, null],
    ],
  );
});

test("work ends with the harness session: Asleep, Stopping and Error empty it; Busy and Ready keep it", async (t) => {
  const s = await setup(t);
  for (const phase of ["Asleep", "Stopping", "Error"] as const) {
    s.a12s.setPhase("web-lead", "Ready");
    s.a12s.startTask("web-lead", { id: `task-${phase}`, kind: "local_agent", description: "Research" });
    await until(() => agentView(s, "web-lead").work.length === 1);
    s.a12s.startTurn("web-lead");
    s.a12s.finishTurn("web-lead");
    await until(() => agentView(s, "web-lead").turn === null);
    assert.equal(agentView(s, "web-lead").work.length, 1, `${phase}: Busy and back to Ready keep it`);

    s.a12s.setPhase("web-lead", phase);
    await until(() => agentView(s, "web-lead").work.length === 0);
    assert.notEqual(agentView(s, "web-lead").presence, "working", phase);
    s.a12s.finishTask("web-lead", `task-${phase}`);
  }
});

test("a resync takes background work from a12s's status", async (t) => {
  const s = await setup(t);
  const { turn, thread } = await leadTurn(s);
  s.a12s.emit(call(turn, "call-k", "Agent", { description: "Known" }));
  s.a12s.startTask("web-lead", { id: "task-k", kind: "local_agent", description: "Known", toolUseId: "call-k" });
  s.a12s.startTask("web-lead", { id: "task-gone", kind: "local_bash", description: "Ended unseen" });
  s.a12s.finishTurn("web-lead");
  s.a12s.emit(call(undefined, "sub-k", "Read", { file_path: "/home/agent/a.md" }, "call-k"));
  await until(() => agentView(s, "web-lead").work[0]?.line === "Reading a.md");

  // A Turn of the dev with a sub-agent in it, then events lost: a12s ended one task and started another.
  const devTurn = s.a12s.startTurn("web-dev");
  s.a12s.emit({
    type: "tool.started",
    agent: "web-dev",
    at: Date.now(),
    turn: devTurn,
    id: "call-f",
    name: "Agent",
    input: { description: "Foreground" },
  });
  await until(() => agentView(s, "web-dev").work.length === 1);
  const lead = s.a12s.agents.get("web-lead");
  assert.ok(lead);
  lead.background = lead.background.filter((task) => task.id !== "task-gone");
  lead.background.push({
    id: "task-new",
    kind: "local_agent",
    description: "Unseen",
    startedAt: 1,
    toolUseId: "call-n",
  });
  s.a12s.emit({ type: "gap" });

  await until(() => agentView(s, "web-lead").work.some((w) => w.id === "task-new"));
  assert.deepEqual(
    agentView(s, "web-lead").work.map((w) => [w.id, w.kind, w.description, w.threadId, w.startedAt > 1, w.line]),
    [
      ["task-new", "agent", "Unseen", null, false, null],
      ["task-k", "agent", "Known", thread, true, "Reading a.md"],
    ],
  );
  assert.deepEqual(agentView(s, "web-dev").work, [], "work a12s does not list as background is dropped");

  s.a12s.emit(call(undefined, "sub-n", "WebSearch", { query: "plan prices" }, "call-n"));
  await until(() => agentView(s, "web-lead").work[0]?.line === "Browsing plan prices");
});

test("one team's work never shows in another team's view", async (t) => {
  const s = await setup(t);
  s.a12s.startTask("web-lead", { id: "task-w", kind: "local_agent", description: "Research pricing" });
  await until(() => agentView(s, "web-lead").work.length === 1);
  const notes = deriveState(s.app, null).teams.find((team) => team.id === "notes");
  assert.ok(notes);
  assert.ok(notes.agents.every((a) => a.work.length === 0 && a.presence !== "working"));
  assert.doesNotMatch(JSON.stringify(notes), /task-w|Research pricing/);
});

test("pause asks an agent with background work to continue, and not one without", async (t) => {
  const s = await setup(t);
  s.a12s.startTask("web-lead", { id: "task-p", kind: "local_agent", description: "Research pricing" });
  await until(() => agentView(s, "web-lead").presence === "working");
  assert.equal(agentView(s, "web-dev").presence, "awake");

  await s.app.teams.pause("web");
  const asked = s.db.prepare("SELECT to_id FROM messages WHERE from_id = 'system'").all();
  assert.deepEqual(
    asked.map((m) => m.to_id),
    ["web-lead"],
  );
  assert.deepEqual(s.a12s.agents.get("web-lead")?.background, [], "sleep ends background work");
});

test("an agent with background work and a held queue shows working, not waiting", async (t) => {
  const s = await setup(t);
  s.app.repo.forTeam("web").setPaused(true);
  ownerThread(s.app.repo.forTeam("web"), { body: "When you have a moment." });
  await s.app.dispatcher.run();
  assert.equal(agentView(s, "web-lead").presence, "waiting");

  s.a12s.startTask("web-lead", { id: "task-h", kind: "local_agent", description: "Research pricing" });
  await until(() => agentView(s, "web-lead").presence === "working");
  assert.equal(agentView(s, "web-lead").waitingFor, undefined);
});

test("a12s task events and calls between Turns become port events", () => {
  const envelope = { v: 1, agentComputer: "web-lead", session: "s1", turn: "", seq: 9, ts: "2026-01-02T03:04:05.678Z" };
  const at = Date.UTC(2026, 0, 2, 3, 4, 5, 678);
  const cases: [SdkEvent, A12sEvent][] = [
    [
      {
        ...envelope,
        turn: "t1",
        type: "task.started",
        data: { id: "a1", kind: "local_agent", description: "Research", toolUseId: "u1" },
      },
      {
        type: "task.started",
        agent: "web-lead",
        at,
        turn: "t1",
        id: "a1",
        kind: "local_agent",
        description: "Research",
        toolUseId: "u1",
      },
    ],
    [
      { ...envelope, type: "task.started", data: { id: "p1", kind: "process", description: "a server" } },
      { type: "task.started", agent: "web-lead", at, id: "p1", kind: "process", description: "a server" },
    ],
    [
      {
        ...envelope,
        type: "task.finished",
        data: { id: "a1", kind: "local_agent", description: "Research", status: "completed" },
      },
      { type: "task.finished", agent: "web-lead", at, id: "a1" },
    ],
    [
      { ...envelope, type: "tool.started", data: { id: "u2", name: "Read", input: {}, parent: "u1" } },
      { type: "tool.started", agent: "web-lead", at, id: "u2", name: "Read", input: {}, parent: "u1" },
    ],
    [
      { ...envelope, type: "tool.finished", data: { id: "u2", name: "Read", isError: false, parent: "u1" } },
      {
        type: "tool.finished",
        agent: "web-lead",
        at,
        id: "u2",
        name: "Read",
        isError: false,
        output: undefined,
        parent: "u1",
      },
    ],
  ];
  for (const [sdk, port] of cases) assert.deepEqual(toEvent(sdk), port, sdk.type);
});
