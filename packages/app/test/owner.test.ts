import assert from "node:assert/strict";
import { test } from "node:test";
import type { MessagesPage } from "@a12s-studio/contract/api";
import type { StudioState } from "@a12s-studio/contract/state";
import { ownerGate } from "../src/owner/gate.ts";
import { deriveState } from "../src/state.ts";
import { OWNER_LOGIN, pending, studio, until } from "./studio.ts";

type S = Awaited<ReturnType<typeof studio>>;

async function setup(t: { after(fn: () => unknown): void }, opts: Parameters<typeof studio>[0] = {}): Promise<S> {
  const s = await studio(opts);
  t.after(() => s.close());
  return s;
}

const LOCAL = { host: "127.0.0.1:7400" };
const TAILNET = { host: "mac.example.ts.net", "x-forwarded-for": "100.64.0.2" };
const JSON_TYPE = { "content-type": "application/json" };

test("ownerGate: who may use the owner listener", () => {
  const cases: [string, string, Record<string, string>, number | null][] = [
    ["local browser read", "GET", LOCAL, null],
    ["localhost read", "GET", { host: "localhost:7400" }, null],
    ["local browser write", "POST", { ...LOCAL, ...JSON_TYPE, origin: "http://127.0.0.1:7400" }, null],
    ["owner through tailscale", "GET", { ...TAILNET, "tailscale-user-login": OWNER_LOGIN }, null],
    [
      "owner write through tailscale",
      "POST",
      { ...TAILNET, ...JSON_TYPE, "tailscale-user-login": OWNER_LOGIN, origin: "https://mac.example.ts.net" },
      null,
    ],
    ["wrong login", "GET", { ...TAILNET, "tailscale-user-login": "someone@example.com" }, 403],
    ["forwarded without identity", "GET", { ...LOCAL, "x-forwarded-for": "100.64.0.2" }, 403],
    ["tailscale header without the login", "GET", { ...LOCAL, "tailscale-user-name": "Someone" }, 403],
    ["foreign Host", "GET", { host: "evil.example:7400" }, 403],
    ["other port", "GET", { host: "127.0.0.1:5173" }, 403],
    ["no Host", "GET", {}, 403],
    ["cross-origin write", "POST", { ...LOCAL, ...JSON_TYPE, origin: "https://evil.example" }, 403],
    ["opaque origin write", "POST", { ...LOCAL, ...JSON_TYPE, origin: "null" }, 403],
    ["form write", "POST", { ...LOCAL, "content-type": "application/x-www-form-urlencoded" }, 415],
    ["write without a type", "DELETE", LOCAL, 415],
    ["WebSocket from Studio's page", "GET", { ...LOCAL, upgrade: "websocket", origin: "http://127.0.0.1:7400" }, null],
    ["WebSocket from another site", "GET", { ...LOCAL, upgrade: "websocket", origin: "https://evil.example" }, 403],
    ["form write named an upgrade", "POST", { ...LOCAL, upgrade: "websocket", "content-type": "text/plain" }, 415],
  ];
  for (const [name, method, headers, status] of cases) {
    assert.equal(ownerGate(method, headers, OWNER_LOGIN)?.status ?? null, status, name);
  }
});

test("the listener refuses before any route runs", async (t) => {
  const s = await setup(t);
  const wrong = await s.owner("POST", "/api/teams", {}, { host: "evil.example" });
  assert.equal(wrong.status, 403);
  assert.equal((wrong.body as { code: string }).code, "not_owner");
  const cross = await s.owner("PATCH", "/api/settings", { paused: true }, { origin: "https://evil.example" });
  assert.equal(cross.status, 403);
  const form = await s.owner("PATCH", "/api/settings", { paused: true }, { "content-type": "text/plain" });
  assert.equal(form.status, 415);
  assert.equal(s.app.repo.settings().paused, false);
});

test("static files: the built app, with index.html for any app route", async (t) => {
  const s = await setup(t);
  for (const path of ["/", "/#/web", "/team/thread", "/../../etc/passwd.txt"]) {
    const res = await s.owner("GET", path);
    assert.equal(res.status, 200, path);
    assert.match(String(res.body), /<title>Studio<\/title>/, path);
  }
  assert.equal((await s.owner("GET", "/api/nothing")).status, 404);
});

test("stream: a state on connect, then one after each write, with rising revs", async (t) => {
  const s = await setup(t);
  const stream = s.stream();
  t.after(() => stream.close());
  await stream.next(1);
  assert.equal(stream.events[0]?.event, "state");
  const start = stream.last().rev;

  const created = await s.owner("POST", "/api/teams", {
    name: "Web",
    purpose: "The site.",
    accent: "#007aff",
    template: "website",
    lead: "lead",
  });
  assert.equal(created.status, 200);
  const { rev, id } = created.body as { rev: number; id: string };
  assert.equal(id, "web");
  assert.ok(rev > start);

  // The response's rev is at most the rev of the first state that holds the write.
  const holds = (state: StudioState) => state.teams.some((team) => team.id === "web");
  while (!stream.states().some(holds)) await stream.next(stream.events.length + 1);
  assert.ok(rev <= (stream.states().find(holds)?.rev ?? -1));
  const revs = stream.states().map((state) => state.rev);
  assert.deepEqual(
    revs,
    [...revs].sort((a, b) => a - b),
  );
  assert.equal(new Set(revs).size, revs.length);
});

test("stream: states are coalesced", async (t) => {
  const s = await setup(t);
  await s.twoTeams();
  const stream = s.stream();
  t.after(() => stream.close());
  await stream.next(1);
  for (let i = 0; i < 20; i++) await s.owner("PATCH", "/api/teams/web", { name: `Web ${i}` });
  await new Promise((resolve) => setTimeout(resolve, 120));
  const states = stream.states();
  assert.ok(states.length < 21, `${states.length} states for 20 writes`);
  assert.equal(stream.last().teams.find((team) => team.id === "web")?.name, "Web 19");
});

test("owner thread and post: a message goes to the lead, the thread's owner or the named slug", async (t) => {
  const s = await setup(t);
  await s.twoTeams();
  const thread = await s.owner("POST", "/api/teams/web/threads", { body: "Build the landing page." });
  assert.equal(thread.status, 200);
  const threadId = (thread.body as { id: string }).id;
  await s.app.dispatcher.run();
  assert.equal(pending(s.a12s, "web-lead").length, 1);

  const toDev = await s.owner("POST", `/api/threads/${threadId}/messages`, { body: "Dev, check fonts.", to: "dev" });
  assert.equal(toDev.status, 200);
  await s.app.dispatcher.run();
  assert.equal(pending(s.a12s, "web-dev").length, 1);

  await new Promise((resolve) => setTimeout(resolve, 5));
  const asked = await s.tool("web-lead", "post", { to: "owner", thread: threadId, body: "Blue or green?" });
  const state = await s.stream(`/api/stream?thread=${threadId}`);
  t.after(() => state.close());
  await state.next(1);
  const view = state.last();
  assert.equal(view.open?.id, threadId);
  assert.equal(view.open?.status, "open");
  assert.equal(view.open?.messages.at(-1)?.id, asked.message);
  assert.deepEqual(view.needsYou, []);
  assert.equal(view.teams.find((x) => x.id === "web")?.threads[0]?.unread, 1);

  const answer = await s.owner("POST", `/api/threads/${threadId}/messages`, { body: "Blue." });
  assert.equal(answer.status, 200);
  const page = await s.owner("GET", `/api/threads/${threadId}/messages`);
  const messages = (page.body as MessagesPage).messages;
  assert.deepEqual(
    messages.map((m) => `${m.from}>${m.to}`),
    ["owner>web-lead", "owner>web-dev", "web-lead>owner", "owner>web-lead"],
  );
  assert.equal(
    (await s.owner("POST", `/api/threads/${threadId}/messages`, { body: "x", ask: asked.message })).status,
    400,
    "a message from the owner names no message it answers",
  );
});

test("opening a thread: the seen route reads that thread only", async (t) => {
  const s = await setup(t);
  await s.twoTeams();
  const posted = await s.tool("web-lead", "post", { to: "owner", title: "Colour", body: "Blue or green?" });
  const thread = String(posted.thread);
  await s.tool("notes-lead", "post", { to: "owner", title: "Sources", body: "Which?" });
  const unread = () =>
    deriveState(s.app, null)
      .teams.flatMap((team) => team.threads)
      .filter((x) => x.unread > 0).length;
  assert.equal(unread(), 2);
  const seen = await s.owner("POST", `/api/threads/${thread}/seen`, {});
  assert.equal(seen.status, 200);
  assert.equal(unread(), 1);
  assert.equal((await s.owner("POST", "/api/threads/th_000000000000/seen", {})).status, 404);
});

test("owner routes refuse another team's thread and unknown agents like missing ones", async (t) => {
  const s = await setup(t);
  await s.twoTeams();
  const thread = await s.owner("POST", "/api/teams/web/threads", { body: "Hello." });
  const id = (thread.body as { id: string }).id;
  const toOther = await s.owner("POST", `/api/threads/${id}/messages`, { body: "Hi.", to: "researcher" });
  assert.equal(toOther.status, 404);
  assert.equal((await s.owner("POST", "/api/teams/nope/threads", { body: "Hi." })).status, 404);
  assert.equal((await s.owner("POST", "/api/agents/notes-ghost/stop")).status, 404);
  assert.equal((await s.owner("POST", "/api/teams/web/threads", { body: "" })).status, 400);
  assert.equal((await s.owner("POST", "/api/teams/web/threads", { body: "Hi.", from: "x" })).status, 400);
});

test("agents: hire, patch model, power, fire", async (t) => {
  const s = await setup(t);
  await s.twoTeams();
  const hired = await s.owner("POST", "/api/teams/web/agents", {
    slug: "writer",
    role: "Writes copy.",
    model: "haiku",
  });
  assert.deepEqual((hired.body as { id: string }).id, "web-writer");
  assert.equal(s.a12s.agents.get("web-writer")?.spec.harness.model, "haiku");

  assert.equal((await s.owner("PATCH", "/api/agents/web-lead", { model: "haiku" })).status, 200);
  assert.equal(s.a12s.agents.get("web-lead")?.spec.harness.model, "haiku");
  assert.equal(s.app.repo.forTeam("web").agent("web-lead")?.model, "haiku");

  assert.equal((await s.owner("POST", "/api/agents/web-dev/power", { state: "asleep" })).status, 200);
  assert.equal(s.a12s.agents.get("web-dev")?.phase, "Asleep");
  assert.equal((await s.owner("DELETE", "/api/agents/web-writer")).status, 200);
  assert.equal(s.a12s.agents.has("web-writer"), false);
  assert.equal((await s.owner("DELETE", "/api/agents/web-lead")).status, 409);
});

test("settings: pause holds owner messages and shows agents waiting; resume delivers", async (t) => {
  const s = await setup(t, { live: true });
  await s.twoTeams();
  assert.equal((await s.owner("PATCH", "/api/settings", { paused: true })).status, 200);
  await s.owner("POST", "/api/teams/web/threads", { body: "Start." });
  await s.app.dispatcher.run();
  assert.equal(pending(s.a12s, "web-lead").length, 0);
  const stream = s.stream();
  t.after(() => stream.close());
  await stream.next(1);
  const lead = stream.last().teams[0]?.agents.find((a) => a.id === "web-lead");
  assert.equal(lead?.presence, "waiting");
  assert.equal(lead?.waitingFor, "paused");
  assert.equal(lead?.queued, 1);

  await s.owner("PATCH", "/api/settings", { paused: false });
  assert.equal(pending(s.a12s, "web-lead").length, 1);
});

test("a failed Turn is a Needs You card until it is acked", async (t) => {
  const s = await setup(t, { live: true });
  await s.twoTeams();
  await s.owner("POST", "/api/teams/web/threads", { body: "Start." });
  await s.app.dispatcher.run();
  s.a12s.startTurn("web-lead");
  s.a12s.finishTurn("web-lead", { status: "failed", error: "Failed to authenticate" });
  const turn = s.a12s.agents.get("web-lead")?.turns[0]?.id ?? "";
  await until(() => s.app.repo.turnTeam(turn) !== undefined);

  const stream = s.stream();
  t.after(() => stream.close());
  await stream.next(1);
  const items = stream.last().needsYou;
  assert.deepEqual(
    items.map((i) => (i.kind === "failed_turn" ? [i.agentId, i.error] : i.kind)),
    [["web-lead", "Failed to authenticate"]],
  );
  assert.equal((await s.owner("POST", `/api/turns/${turn}/ack`)).status, 200);
  assert.equal((await s.owner("POST", "/api/turns/t_nope/ack")).status, 404);
  await until(() => stream.last().needsYou.length === 0);
});
