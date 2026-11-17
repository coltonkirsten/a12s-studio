import assert from "node:assert/strict";
import { test } from "node:test";
import { TOOL_PREFIX } from "@a12s-studio/contract/names";
import type { LiveText } from "@a12s-studio/contract/state";
import { fakeA12s } from "../src/a12s/fake.ts";
import type { A12sEvent } from "../src/a12s/port.ts";
import { doingNow } from "../src/live.ts";
import { ownerThread } from "../src/router.ts";
import { deriveState } from "../src/state.ts";
import { pending, studio, until } from "./studio.ts";

type S = Awaited<ReturnType<typeof studio>>;

async function setup(t: { after(fn: () => unknown): void }, opts: Parameters<typeof studio>[0] = {}): Promise<S> {
  const s = await studio({ live: true, ...opts });
  t.after(() => s.close());
  await s.twoTeams();
  return s;
}

const delivery = (s: S, id: string) =>
  String(s.db.prepare("SELECT delivery FROM messages WHERE id = ?").get(id)?.delivery);
const agentView = (s: S, id: string) =>
  deriveState(s.app, null)
    .teams.flatMap((t) => t.agents)
    .find((a) => a.id === id);

const fromSystem = (s: S) => s.db.prepare("SELECT count(*) AS n FROM messages WHERE from_id = 'system'").get()?.n;
const failedPost = (agent: string, turn: string): A12sEvent => ({
  type: "tool.finished",
  agent,
  at: Date.now(),
  turn,
  id: `call-${turn}`,
  name: `${TOOL_PREFIX}post`,
  isError: true,
  output: "studio is Unhealthy",
});

test("doingNow: one plain line per tool", () => {
  const cases: [string, unknown, string][] = [
    ["Read", { file_path: "/home/agent/site/server.ts" }, "Reading server.ts"],
    ["Edit", { file_path: "/home/agent/a.css" }, "Editing a.css"],
    ["Write", { file_path: "/home/agent/b.md" }, "Editing b.md"],
    ["NotebookEdit", { notebook_path: "/home/agent/n.ipynb" }, "Editing n.ipynb"],
    ["Bash", { command: "npm test", description: "Run the tests" }, "Running Run the tests"],
    ["Bash", { command: `echo ${"x".repeat(100)}` }, `Running echo ${"x".repeat(55)}`],
    ["Grep", { pattern: "x" }, "Searching"],
    ["Glob", { pattern: "*.ts" }, "Searching"],
    ["WebFetch", { url: "https://example.com/a?b" }, "Browsing example.com"],
    ["WebSearch", { query: "static site generators" }, "Browsing static site generators"],
    ["Agent", {}, "Working with a sub-agent"],
    ["Task", {}, "Working with a sub-agent"],
    [`${TOOL_PREFIX}post`, { to: "dev", thread: "th_1" }, "Writing to dev"],
    [`${TOOL_PREFIX}post`, { thread: "th_1" }, "Writing in the thread"],
    [`${TOOL_PREFIX}read`, {}, "Checking the board"],
    [`${TOOL_PREFIX}update_thread`, {}, "Checking the board"],
    [`${TOOL_PREFIX}roster`, {}, "Checking the roster"],
    [`${TOOL_PREFIX}access`, {}, "Checking access"],
    [`${TOOL_PREFIX}schedule`, {}, "Checking its schedule"],
    ["TodoWrite", {}, "Using TodoWrite"],
    ["Read", null, "Reading a file"],
  ];
  for (const [tool, input, line] of cases) assert.equal(doingNow(tool, input), line, tool);
});

test("turn.started marks the delivered messages and sets the Turn's thread", async (t) => {
  const s = await setup(t);
  const posted = ownerThread(s.app.repo.forTeam("web"), { body: "Plan the launch." });
  await s.app.dispatcher.run();
  assert.equal(delivery(s, posted.message), "sent");

  s.a12s.startTurn("web-lead");
  await until(() => delivery(s, posted.message) === "delivered");
  const lead = agentView(s, "web-lead");
  assert.equal(lead?.presence, "working");
  assert.equal(lead?.line, "Working");
  assert.equal(lead?.turn?.threadId, posted.thread);
});

test("phases become presence, tools the line, text.delta a live event", async (t) => {
  const s = await setup(t);
  const stream = s.stream();
  t.after(() => stream.close());
  await stream.next(1);

  s.a12s.setPhase("web-dev", "Asleep");
  await until(() => agentView(s, "web-dev")?.presence === "asleep");
  s.a12s.setPhase("web-dev", "Error", "Image pull failed");
  await until(() => agentView(s, "web-dev")?.presence === "error");
  assert.equal(agentView(s, "web-dev")?.error, "Image pull failed");
  await until(() => stream.states().some((state) => state.needsYou.some((n) => n.kind === "agent_error")));

  const turn = s.a12s.startTurn("web-lead");
  const at = Date.now();
  s.a12s.emit({ type: "text.delta", agent: "web-lead", at, turn, text: "Looking " });
  await until(() => agentView(s, "web-lead")?.line === "Writing");
  s.a12s.emit({ type: "tool.started", agent: "web-lead", at, turn, id: "c1", name: "Bash", input: { command: "ls" } });
  s.a12s.emit({ type: "tool.started", agent: "web-lead", at, turn, id: "c2", name: "Read", input: {}, parent: "c1" });
  await until(() => agentView(s, "web-lead")?.line === "Running ls");
  s.a12s.emit({ type: "text.delta", agent: "web-lead", at, turn, text: "around." });
  await until(() => agentView(s, "web-lead")?.turn?.text === "Looking around.");
  // A tool is still running, so the line stays.
  assert.equal(agentView(s, "web-lead")?.line, "Running ls");
  const live = stream.events.filter((e) => e.event === "live").map((e) => e.data as LiveText);
  assert.deepEqual(live, [
    { agent: "web-lead", turn, text: "Looking " },
    { agent: "web-lead", turn, text: "around." },
  ]);

  s.a12s.finishTurn("web-lead");
  await until(() => agentView(s, "web-lead")?.turn === null);
  assert.equal(agentView(s, "web-lead")?.line, null);
  assert.equal(agentView(s, "web-lead")?.presence, "awake");
});

test("turn.finished writes the turns row and the implicit answer, set off by the owner's message", async (t) => {
  const s = await setup(t);
  const posted = ownerThread(s.app.repo.forTeam("web"), { body: "What is 2 + 2?" });
  await s.app.dispatcher.run();
  const turn = s.a12s.startTurn("web-lead");
  s.a12s.emit({ type: "text.delta", agent: "web-lead", at: Date.now(), turn, text: "It is 4." });
  s.a12s.finishTurn("web-lead", { modelCostsUsd: { "claude-haiku-4-5": 0.01 } });

  await until(() => s.app.repo.turnTeam(turn) === "web");
  const row = { ...s.db.prepare("SELECT * FROM turns WHERE id = ?").get(turn) };
  assert.equal(row.agent_id, "web-lead");
  assert.equal(row.thread_id, posted.thread);
  assert.equal(row.status, "completed");
  assert.deepEqual(JSON.parse(String(row.model_costs)), { "claude-haiku-4-5": 0.01 });
  const messages = s.app.repo.forTeam("web").threadMessages(posted.thread, 10);
  assert.deepEqual(
    messages.map((m) => [m.fromId, m.toId, m.body, m.causeId, m.depth]),
    [
      ["owner", "web-lead", "What is 2 + 2?", null, 0],
      ["web-lead", "owner", "It is 4.", posted.message, 1],
    ],
  );
});

test("a lost feed shows a12s down, and the next feed resyncs what was missed", async (t) => {
  const s = await setup(t);
  await until(() => s.app.live.up());
  const posted = ownerThread(s.app.repo.forTeam("web"), { body: "Status?" });
  await s.app.dispatcher.run();

  s.a12s.setReachable(false);
  await until(() => !s.app.live.up());
  assert.equal(deriveState(s.app, null).a12s, "down");

  // While the feed is down the lead takes the message and finishes; no event reaches the app.
  s.a12s.startTurn("web-lead");
  s.a12s.finishTurn("web-lead");
  s.a12s.setPhase("web-dev", "Asleep");
  assert.equal(delivery(s, posted.message), "sent");

  s.a12s.setReachable(true);
  await until(() => s.app.live.up(), 3000);
  await until(() => delivery(s, posted.message) === "delivered");
  assert.equal(s.db.prepare("SELECT count(*) AS n FROM turns").get()?.n, 1);
  assert.equal(agentView(s, "web-dev")?.presence, "asleep");
  // No Studio call failed in that Turn, so nobody is asked to post again.
  assert.equal(fromSystem(s), 0);
});

test("presence is unknown until a12s has reported a phase", async (t) => {
  const s = await setup(t, { live: false });
  assert.equal(agentView(s, "web-lead")?.presence, "unknown");
  s.app.live.start();
  await until(() => agentView(s, "web-lead")?.presence === "awake");
});

test("a Turn that lost a Studio call while the app was stopped gets one message to post again", async (t) => {
  const a12s = fakeA12s();
  const first = await studio({ a12s, live: true });
  await first.twoTeams();
  ownerThread(first.app.repo.forTeam("web"), { body: "Report when the build is green." });
  await first.app.dispatcher.run();
  const turn = a12s.startTurn("web-lead");
  await until(() => first.app.live.agent("web-lead")?.turn?.id === turn);
  await first.close();

  // The app is stopped: the lead's post fails in a12s, and it ends its Turn.
  a12s.emit(failedPost("web-lead", turn));
  a12s.finishTurn("web-lead");

  const s = await studio({ a12s, dbFile: first.dbFile, live: true });
  t.after(() => s.close());
  await until(() => pending(a12s, "web-lead").length === 1);
  assert.match(
    pending(a12s, "web-lead")[0]?.body ?? "",
    /^message m_\w+ from system\n---\na12s Studio could not be reached/,
  );
  assert.equal(fromSystem(s), 1);

  // The Turn that takes the message is followed whole: a failed call in it is a refusal the lead has read.
  const next = a12s.startTurn("web-lead");
  a12s.emit(failedPost("web-lead", next));
  a12s.finishTurn("web-lead");
  await until(() => s.app.repo.turnTeam(next) === "web");
  // A resync finds both Turns stored and asks nothing again.
  a12s.setPhase("web-dev", "Asleep");
  a12s.emit({ type: "gap" });
  await until(() => agentView(s, "web-dev")?.presence === "asleep");
  assert.equal(fromSystem(s), 1);
});

test("a Turn already running when the app starts is stored whole, from a12s", async (t) => {
  const a12s = fakeA12s();
  const first = await studio({ a12s, live: true });
  await first.twoTeams();
  const posted = ownerThread(first.app.repo.forTeam("web"), { body: "What is 2 + 2?" });
  await first.app.dispatcher.run();
  await first.close();
  const turn = a12s.startTurn("web-lead");
  a12s.emit({ type: "text.delta", agent: "web-lead", at: Date.now(), turn, text: "It is " });

  const s = await studio({ a12s, dbFile: first.dbFile, live: true });
  t.after(() => s.close());
  await until(() => s.app.live.agent("web-lead")?.phase === "Busy");
  a12s.emit({ type: "text.delta", agent: "web-lead", at: Date.now(), turn, text: "4." });
  await until(() => agentView(s, "web-lead")?.turn?.text === "4.");
  a12s.finishTurn("web-lead");

  await until(() => s.app.repo.turnTeam(turn) === "web");
  assert.equal(s.db.prepare("SELECT thread_id FROM turns WHERE id = ?").get(turn)?.thread_id, posted.thread);
  const last = s.app.repo.forTeam("web").threadMessages(posted.thread, 10).at(-1);
  assert.deepEqual([last?.fromId, last?.toId, last?.body], ["web-lead", "owner", "It is 4."]);
  assert.equal(fromSystem(s), 0);
});

test("a gap resyncs", async (t) => {
  const s = await setup(t);
  await until(() => s.app.live.up());
  const dev = s.a12s.agents.get("web-dev");
  assert.ok(dev);
  dev.phase = "Asleep";
  s.a12s.emit({ type: "gap" });
  await until(() => agentView(s, "web-dev")?.presence === "asleep");
});

test("a new app over the same database derives the same state", async (t) => {
  const a12s = fakeA12s();
  const first = await studio({ a12s, live: true });
  await first.twoTeams();
  const posted = ownerThread(first.app.repo.forTeam("web"), { body: "Hello?" });
  await first.app.dispatcher.run();
  first.a12s.startTurn("web-lead");
  first.a12s.finishTurn("web-lead");
  await until(() => first.db.prepare("SELECT count(*) AS n FROM turns").get()?.n === 1);
  await until(() => first.app.live.agent("web-lead")?.phase === "Ready");
  const before = deriveState(first.app, posted.thread);
  await first.close();

  const second = await studio({ a12s, dbFile: first.dbFile, live: true });
  t.after(() => second.close());
  await until(() => second.app.live.up() && second.app.live.agent("web-lead") !== undefined);
  assert.deepEqual(deriveState(second.app, posted.thread), before);
});

test("an agent hired after the feed opened shows the phase a12s reported while it was being made", async (t) => {
  // Like real a12s, the write answers after the new agent computer's phase events have gone out.
  const s = await setup(t, {
    wrap: (fake) => ({
      ...fake,
      async putAgent(name, spec, mode) {
        await fake.putAgent(name, spec, mode);
        await new Promise((resolve) => setTimeout(resolve, 20));
      },
    }),
  });
  await until(() => s.app.live.up());
  await s.app.teams.hire("web", { slug: "writer", role: "Writes copy.", model: "haiku" });
  await until(() => agentView(s, "web-writer")?.presence === "awake");
});
