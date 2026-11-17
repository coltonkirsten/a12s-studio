import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  AgentSettings,
  FileView,
  InboxResponse,
  TurnEventsResponse,
  TurnsResponse,
} from "@a12s-studio/contract/api";
import { OWNER_PORT } from "@a12s-studio/contract/names";
import WebSocket from "ws";
import type { FakeA12s } from "../src/a12s/fake.ts";
import { type A12s, A12sError } from "../src/a12s/port.ts";
import { pending, studio, until } from "./studio.ts";

type S = Awaited<ReturnType<typeof studio>>;

async function setup(t: { after(fn: () => unknown): void }, opts: Parameters<typeof studio>[0] = {}): Promise<S> {
  const s = await studio(opts);
  t.after(() => s.close());
  await s.twoTeams();
  return s;
}

const code = (body: unknown) => (body as { code?: string }).code;
const idOf = (res: { body: unknown }) => String((res.body as { id?: string }).id);

test("every inspector route: an agent that is not there, or is on no team, is a 404", async (t) => {
  const s = await setup(t);
  const routes: [string, string, unknown?][] = [
    ["GET", "/api/agents/<id>"],
    ["PATCH", "/api/agents/<id>", { model: "haiku" }],
    ["GET", "/api/agents/<id>/turns"],
    ["GET", "/api/agents/<id>/turns/t_1/events"],
    ["GET", "/api/agents/<id>/inbox"],
    ["DELETE", "/api/agents/<id>/inbox/m_000000000000"],
    ["POST", "/api/agents/<id>/inbox/clear"],
    ["GET", "/api/agents/<id>/files?path=/home/agent"],
    ["PUT", "/api/agents/<id>/files?path=/home/agent/x.md", { content: "x", encoding: "utf-8" }],
  ];
  for (const [method, path, body] of routes) {
    for (const id of ["web-ghost", "ghost-lead", "nohyphen"]) {
      const res = await s.owner(method, path.replace("<id>", id), body);
      assert.equal(res.status, 404, `${method} ${path} ${id}`);
      assert.equal(code(res.body), "not_found");
    }
  }
});

test("an id of another team's in an agent's URL behaves as a missing one", async (t) => {
  const s = await setup(t);
  await s.owner("PATCH", "/api/teams/notes", { paused: true });
  const theirs = idOf(await s.owner("POST", "/api/teams/notes/threads", { body: "Sources?" }));
  const ask = (await s.owner("GET", `/api/threads/${theirs}/messages`)).body as { messages: { id: string }[] };
  const theirMessage = ask.messages[0]?.id ?? "";
  const missing = "m_000000000000";

  const removed = await s.owner("DELETE", `/api/agents/web-lead/inbox/${theirMessage}`);
  const removedMissing = await s.owner("DELETE", `/api/agents/web-lead/inbox/${missing}`);
  assert.equal(removed.status, 404);
  assert.deepEqual(JSON.parse(JSON.stringify(removed.body).replace(theirMessage, missing)), removedMissing.body);
  // Still queued for the agent it was written to.
  const inbox = (await s.owner("GET", "/api/agents/notes-lead/inbox")).body as InboxResponse;
  assert.deepEqual(
    inbox.messages.map((m) => [m.id, m.sentAs]),
    [[theirMessage, null]],
  );

  s.a12s.setPhase("notes-lead", "Ready");
  const turn = s.a12s.startTurn("notes-lead");
  s.a12s.emit({ type: "tool.started", agent: "notes-lead", at: 1, turn, id: "c1", name: "Read", input: {} });
  const events = await s.owner("GET", `/api/agents/web-lead/turns/${turn}/events`);
  const eventsMissing = await s.owner("GET", "/api/agents/web-lead/turns/t_000/events");
  assert.equal(events.status, eventsMissing.status);
  assert.deepEqual(events.body, eventsMissing.body);
});

test("Turns: the list, and a Turn's tool log with each call's line and result", async (t) => {
  const s = await setup(t);
  const turn = s.a12s.startTurn("web-dev");
  const at = Date.now();
  const tool = (id: string, name: string, input: unknown, parent?: string) =>
    s.a12s.emit({ type: "tool.started", agent: "web-dev", at, turn, id, name, input, ...(parent ? { parent } : {}) });
  const done = (id: string, name: string, output: unknown, isError = false) =>
    s.a12s.emit({ type: "tool.finished", agent: "web-dev", at: at + 5, turn, id, name, isError, output });
  tool("c1", "Read", { file_path: "/home/agent/src/server.ts" });
  done("c1", "Read", "x".repeat(10_000));
  tool("c2", "Agent", { description: "Check links" });
  tool("c3", "Bash", { command: "npm test" }, "c2");
  done("c3", "Bash", "1 failed", true);

  const running = (await s.owner("GET", `/api/agents/web-dev/turns/${turn}/events`)).body as TurnEventsResponse;
  assert.deepEqual(
    running.calls.map((c) => [c.id, c.line, c.parent, c.isError, c.finishedAt === null]),
    [
      ["c1", "Reading server.ts", null, false, false],
      ["c2", "Working with a sub-agent", null, false, true],
      ["c3", "Running npm test", "c2", true, false],
    ],
  );
  const first = running.calls[0];
  assert.ok(first && first.output !== null && first.output.length < 5000, "a long output is cut");
  assert.equal(JSON.parse(running.calls[1]?.input ?? "null").description, "Check links");

  s.a12s.emit({ type: "text.delta", agent: "web-dev", at, turn, text: "All read." });
  s.a12s.finishTurn("web-dev", { status: "failed", error: "rate limited" });
  const list = (await s.owner("GET", "/api/agents/web-dev/turns")).body as TurnsResponse;
  assert.equal(list.turns[0]?.id, turn);
  assert.equal(list.turns[0]?.status, "failed");
  assert.equal(list.turns[0]?.error, "rate limited");
  assert.equal(list.turns[0]?.text, "All read.");
});

test("Turns: a message steered into the Turn is a row of its log, with its sender and body", async (t) => {
  const s = await setup(t);
  const turn = s.a12s.startTurn("web-dev");
  s.a12s.emit({ type: "tool.started", agent: "web-dev", at: Date.now(), turn, id: "c1", name: "Bash", input: {} });
  const posted = await s.tool("web-lead", "post", { to: "dev", title: "Hero", body: "Use the new logo." });
  await until(() => s.a12s.agents.get("web-dev")?.journal.some((e) => e.type === "turn.steered") === true);

  const log = (await s.owner("GET", `/api/agents/web-dev/turns/${turn}/events`)).body as TurnEventsResponse;
  assert.deepEqual(
    log.calls.map((c) => c.id),
    ["c1"],
  );
  assert.deepEqual(
    log.steered.map((m) => [m.id, m.from, m.body]),
    [[posted.message, "web-lead", "Use the new logo."]],
  );
});

test("an asleep agent: its tool log and files answer asleep, its Turn list still answers", async (t) => {
  const s = await setup(t);
  await s.owner("POST", "/api/agents/web-dev/power", { state: "asleep" });
  for (const path of ["/api/agents/web-dev/turns/t_1/events", "/api/agents/web-dev/files?path=/home/agent"]) {
    const res = await s.owner("GET", path);
    assert.equal(res.status, 409, path);
    assert.equal(code(res.body), "asleep");
  }
  assert.equal((await s.owner("GET", "/api/agents/web-dev/turns")).status, 200);
});

test("Inbox: removing a queued message marks it none, and it is never sent", async (t) => {
  const s = await setup(t);
  await s.owner("PATCH", "/api/teams/web", { paused: true });
  const thread = idOf(await s.owner("POST", "/api/teams/web/threads", { body: "Hero copy.", to: "dev" }));
  const keep = await s.owner("POST", `/api/threads/${thread}/messages`, { body: "And the footer.", to: "dev" });

  const inbox = (await s.owner("GET", "/api/agents/web-dev/inbox")).body as InboxResponse;
  assert.deepEqual(
    inbox.messages.map((m) => [m.body, m.sentAs, m.thread, m.from]),
    [
      ["Hero copy.", null, thread, "owner"],
      ["And the footer.", null, thread, "owner"],
    ],
  );
  const first = inbox.messages[0]?.id;
  const removed = await s.owner("DELETE", `/api/agents/web-dev/inbox/${first}`);
  assert.equal(removed.status, 200);

  await s.owner("PATCH", "/api/teams/web", { paused: false });
  await until(() => pending(s.a12s, "web-dev").length === 1);
  await s.app.dispatcher.run();
  const sent = pending(s.a12s, "web-dev");
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.metadata.message, idOf(keep));
  const thread2 = (await s.owner("GET", `/api/threads/${thread}/messages`)).body as { messages: { id: string }[] };
  assert.ok(
    thread2.messages.some((m) => m.id === first),
    "the message stays in its thread",
  );
  assert.equal((await s.owner("DELETE", `/api/agents/web-dev/inbox/${first}`)).status, 404);
});

test("Inbox: removing a sent message withdraws exactly that one", async (t) => {
  const s = await setup(t);
  const thread = String((await s.tool("web-lead", "post", { to: "dev", title: "T", body: "One." })).thread);
  await s.tool("web-lead", "post", { to: "dev", thread, body: "FYI." });
  await s.tool("web-lead", "post", { to: "dev", thread, body: "Two." });
  await until(() => pending(s.a12s, "web-dev").length === 3);

  const inbox = (await s.owner("GET", "/api/agents/web-dev/inbox")).body as InboxResponse;
  const [one, fyi, two] = inbox.messages;
  assert.deepEqual(
    inbox.messages.map((m) => m.body),
    ["One.", "FYI.", "Two."],
  );
  assert.equal(new Set(inbox.messages.map((m) => m.sentAs)).size, 3, "each message is its own a12s Message");
  assert.equal((await s.owner("DELETE", `/api/agents/web-dev/inbox/${fyi?.id}`)).status, 200);
  const left = (await s.owner("GET", "/api/agents/web-dev/inbox")).body as InboxResponse;
  assert.deepEqual(
    left.messages.map((m) => m.body),
    ["One.", "Two."],
  );
  assert.deepEqual(
    pending(s.a12s, "web-dev").map((m) => m.metadata.message),
    [one?.id, two?.id],
  );
  await s.app.dispatcher.run();
  assert.equal(pending(s.a12s, "web-dev").length, 2);
});

test("Inbox: a message a Turn has already taken cannot be removed", async (t) => {
  const s = await setup(t);
  await s.tool("web-lead", "post", { to: "dev", title: "T", body: "One." });
  await until(() => pending(s.a12s, "web-dev").length === 1);
  const [message] = ((await s.owner("GET", "/api/agents/web-dev/inbox")).body as InboxResponse).messages;
  // a12s has handed it to a Turn whose turn.started the app has not read yet.
  for (const m of s.a12s.agents.get("web-dev")?.inbox ?? []) m.state = "claimed";
  const res = await s.owner("DELETE", `/api/agents/web-dev/inbox/${message?.id}`);
  assert.equal(res.status, 409);
  const after = ((await s.owner("GET", "/api/agents/web-dev/inbox")).body as InboxResponse).messages;
  assert.deepEqual(
    after.map((m) => m.id),
    [message?.id],
  );
});

test("Inbox: clear withdraws everything pending and marks queued and sent messages none", async (t) => {
  const s = await setup(t);
  const thread = String((await s.tool("web-lead", "post", { to: "dev", title: "T", body: "One." })).thread);
  await until(() => pending(s.a12s, "web-dev").length === 1);
  await s.owner("PATCH", "/api/teams/web", { paused: true });
  await s.tool("web-lead", "post", { to: "dev", thread, body: "Two." });
  const cleared = await s.owner("POST", "/api/agents/web-dev/inbox/clear", {});
  assert.equal(cleared.status, 200);
  assert.deepEqual(((await s.owner("GET", "/api/agents/web-dev/inbox")).body as InboxResponse).messages, []);
  assert.equal(pending(s.a12s, "web-dev").length, 0);
  await s.owner("PATCH", "/api/teams/web", { paused: false });
  await s.app.dispatcher.run();
  assert.equal(pending(s.a12s, "web-dev").length, 0);
});

test("Files: a folder, a file, and a write; any path outside /home/agent is refused before a12s", async (t) => {
  const s = await setup(t);
  const files = s.a12s.agents.get("web-dev")?.files;
  files?.set("/home/agent/memory/notes.md", new TextEncoder().encode("- the site is in ~/site\n"));
  const dir = (await s.owner("GET", "/api/agents/web-dev/files?path=/home/agent")).body as FileView;
  assert.equal(dir.kind, "dir");
  assert.deepEqual(dir.kind === "dir" && dir.entries.map((e) => [e.name, e.kind]), [["memory", "dir"]]);
  const notes = (await s.owner("GET", "/api/agents/web-dev/files?path=/home/agent/memory/notes.md")).body;
  assert.equal((notes as FileView & { content: string }).content, "- the site is in ~/site\n");

  const put = await s.owner("PUT", "/api/agents/web-dev/files?path=/home/agent/memory/notes.md", {
    content: "- moved to ~/web\n",
    encoding: "utf-8",
  });
  assert.equal(put.status, 200);
  assert.equal(new TextDecoder().decode(files?.get("/home/agent/memory/notes.md")), "- moved to ~/web\n");
  await s.owner("PUT", "/api/agents/web-dev/files?path=/home/agent/logo.bin", {
    content: Buffer.from([0, 1, 2, 255]).toString("base64"),
    encoding: "base64",
  });
  assert.deepEqual([...(files?.get("/home/agent/logo.bin") ?? [])], [0, 1, 2, 255]);

  for (const path of ["/etc/passwd", "/home/agent/../../etc/passwd", "/home/agent/memory/../../x", "", "notes.md"]) {
    const read = await s.owner("GET", `/api/agents/web-dev/files?path=${encodeURIComponent(path)}`);
    assert.equal(read.status, 400, path);
    assert.equal(code(read.body), "outside_home");
    const write = await s.owner("PUT", `/api/agents/web-dev/files?path=${encodeURIComponent(path)}`, {
      content: "x",
      encoding: "utf-8",
    });
    assert.equal(write.status, 400, path);
  }
  assert.equal(files?.has("/etc/passwd"), false);
  assert.equal((await s.owner("GET", "/api/agents/web-dev/files")).status, 400);
});

test("Settings: PATCH takes all six fields, writes the spec again and the row; null is a12s's default", async (t) => {
  const s = await setup(t);
  const before = (await s.owner("GET", "/api/agents/web-dev")).body as AgentSettings;
  assert.equal(before.cpu, null);
  assert.equal(before.memory, null);

  const patch: AgentSettings = {
    role: "Writes and tests the code. Prefers small changes.",
    model: "opus",
    sleepAfterIdle: "30m",
    compactMinTokens: 50000,
    cpu: 2,
    memory: "4Gi",
  };
  assert.equal((await s.owner("PATCH", "/api/agents/web-dev", patch)).status, 200);
  assert.deepEqual((await s.owner("GET", "/api/agents/web-dev")).body, patch);
  const spec = s.a12s.agents.get("web-dev")?.spec;
  assert.equal(spec?.harness.model, "opus");
  assert.deepEqual(spec?.power, { sleepAfterIdle: "30m", compactBeforeSleep: { minTokens: 50000 } });
  assert.deepEqual(spec?.resources, { cpu: 2, memory: "4Gi" });
  assert.match(spec?.instructions ?? "", /Prefers small changes\.$/);

  await s.owner("PATCH", "/api/agents/web-dev", { cpu: null, memory: null });
  assert.equal(s.a12s.agents.get("web-dev")?.spec.resources, undefined);
  assert.deepEqual((await s.owner("GET", "/api/agents/web-dev")).body, { ...patch, cpu: null, memory: null });

  for (const bad of [{ team: "notes" }, { cpu: 0 }, { compactMinTokens: -1 }, { memory: "" }, { model: "" }]) {
    assert.equal((await s.owner("PATCH", "/api/agents/web-dev", bad)).status, 400, JSON.stringify(bad));
  }
});

test("Settings: a spec a12s refuses changes nothing in the row", async (t) => {
  const s = await setup(t, {
    wrap: (fake) => ({
      ...fake,
      putAgent: async (name, spec, mode) => {
        if (spec.resources?.memory === "1Ki") throw new A12sError("other", "memory is below the minimum");
        return fake.putAgent(name, spec, mode);
      },
    }),
  });
  assert.equal((await s.owner("PATCH", "/api/agents/web-dev", { memory: "1Ki", model: "opus" })).status, 502);
  const now = (await s.owner("GET", "/api/agents/web-dev")).body as AgentSettings;
  assert.equal(now.memory, null);
  assert.notEqual(now.model, "opus");
});

// Each terminal a12s opened, with its size.
function recordTerminals(opened: string[]) {
  return (fake: FakeA12s): A12s => ({
    ...fake,
    forTeam(token) {
      const team = fake.forTeam(token);
      return {
        ...team,
        async openTerminal(name, size) {
          const terminal = await team.openTerminal(name, size);
          opened.push(`${name} ${size.rows}x${size.cols}`);
          return terminal;
        },
      };
    },
  });
}

function connect(s: S, path: string, headers: Record<string, string> = {}) {
  const socket = new WebSocket(`ws://127.0.0.1:${s.ownerPort}${path}`, {
    headers: { host: `127.0.0.1:${OWNER_PORT}`, origin: `http://127.0.0.1:${OWNER_PORT}`, ...headers },
  });
  // The HTTP status the upgrade was answered with: 101 when the socket opened.
  const refused = new Promise<number>((resolve) => {
    socket.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
    socket.on("upgrade", (res) => resolve(res.statusCode ?? 0));
    socket.on("error", () => {});
  });
  const opened = new Promise<void>((resolve) => socket.on("open", resolve));
  const closed = new Promise<{ code: number; reason: string }>((resolve) =>
    socket.on("close", (code, reason) => resolve({ code, reason: reason.toString() })),
  );
  return { socket, refused, opened, closed };
}

test("terminal: ownerGate, the Origin rule and the agent's team are checked before a12s is asked", async (t) => {
  const opened: string[] = [];
  const s = await setup(t, { wrap: recordTerminals(opened) });
  const cases: [string, string, Record<string, string>, number][] = [
    ["another site's page", "/api/agents/web-dev/terminal", { origin: "https://evil.example" }, 403],
    ["an opaque origin", "/api/agents/web-dev/terminal", { origin: "null" }, 403],
    ["a foreign Host", "/api/agents/web-dev/terminal", { host: "evil.example:7400" }, 403],
    ["forwarded without identity", "/api/agents/web-dev/terminal", { "x-forwarded-for": "100.64.0.2" }, 403],
    ["an agent that is not there", "/api/agents/web-ghost/terminal", {}, 404],
    ["an agent on no team", "/api/agents/ghost-lead/terminal", {}, 404],
    ["another path", "/api/stream", {}, 404],
  ];
  for (const [what, path, headers, status] of cases) {
    const term = connect(s, path, headers);
    const answered = await term.refused;
    term.socket.terminate();
    assert.equal(answered, status, what);
  }
  assert.deepEqual(opened, []);
  assert.equal((await s.owner("GET", "/api/agents/web-dev/terminal")).status, 426);
});

test("terminal: bytes both ways at the size asked for, and a close that ends the a12s terminal", async (t) => {
  const opened: string[] = [];
  const s = await setup(t, { wrap: recordTerminals(opened) });
  const term = connect(s, "/api/agents/web-dev/terminal?rows=30&cols=100");
  await term.opened;
  await until(() => opened.length === 1);
  assert.deepEqual(opened, ["web-dev 30x100"]);
  // The fake's terminal echoes what it is sent.
  const echoed = new Promise<Buffer>((resolve) => term.socket.once("message", (data) => resolve(data as Buffer)));
  term.socket.send(Buffer.from("ls -la\r"));
  assert.equal((await echoed).toString(), "ls -la\r");
  term.socket.close();
  assert.equal((await term.closed).code, 1005);

  const odd = connect(s, "/api/agents/web-dev/terminal?rows=0&cols=many");
  await odd.opened;
  await until(() => opened.length === 2);
  assert.equal(opened[1], "web-dev 24x80");
  odd.socket.close();
  await odd.closed;
});

test("terminal: an asleep agent's terminal closes with asleep, for the inspector's Wake", async (t) => {
  const s = await setup(t);
  await s.owner("POST", "/api/agents/web-dev/power", { state: "asleep" });
  const term = connect(s, "/api/agents/web-dev/terminal");
  assert.deepEqual(await term.closed, { code: 1011, reason: "asleep" });
});

test("terminal: what is typed while a12s opens the terminal reaches it", async (t) => {
  const s = await setup(t, {
    wrap: (fake) => ({
      ...fake,
      forTeam(token) {
        const team = fake.forTeam(token);
        return {
          ...team,
          async openTerminal(name, size) {
            await new Promise((resolve) => setTimeout(resolve, 50));
            return team.openTerminal(name, size);
          },
        };
      },
    }),
  });
  const term = connect(s, "/api/agents/web-dev/terminal");
  const echoed = new Promise<Buffer>((resolve) => term.socket.once("message", (data) => resolve(data as Buffer)));
  await term.opened;
  term.socket.send(Buffer.from("ls\r"));
  assert.equal((await echoed).toString(), "ls\r");
  term.socket.close();
  await term.closed;
});

test("terminal: a frame over the limit closes that terminal and nothing else", async (t) => {
  const s = await setup(t);
  const term = connect(s, "/api/agents/web-dev/terminal");
  await term.opened;
  term.socket.send(Buffer.alloc(65 * 1024, "x"));
  assert.equal((await term.closed).code, 1009);
  assert.equal((await s.owner("GET", "/api/agents/web-dev")).status, 200);
});
