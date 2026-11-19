import assert from "node:assert/strict";
import { test } from "node:test";
import type { FakeA12s } from "../src/a12s/fake.ts";
import { type A12s, A12sError, type TeamA12s } from "../src/a12s/port.ts";
import { changeThread, markSeen, ownerPost, ownerThread, systemMessage } from "../src/router.ts";
import { deriveState } from "../src/state.ts";
import { bodyOf, pending, studio, until } from "./studio.ts";

type S = Awaited<ReturnType<typeof studio>>;

async function setup(t: { after(fn: () => unknown): void }, opts: Parameters<typeof studio>[0] = {}): Promise<S> {
  const s = await studio(opts);
  t.after(() => s.close());
  await s.twoTeams();
  return s;
}

function sleepAll(a12s: FakeA12s): void {
  for (const name of a12s.agents.keys()) a12s.setPhase(name, "Asleep");
}

function row(s: S, id: unknown) {
  const r = s.db.prepare("SELECT delivery, a12s_message_id AS a12s FROM messages WHERE id = ?").get(String(id));
  return { ...r };
}

// The chain record of a message: its cause, its depth, the Turn that took it and whether it joined that Turn.
function chain(s: S, id: unknown) {
  const r = s.db
    .prepare("SELECT cause_id AS cause, depth, turn_id AS turn, steered FROM messages WHERE id = ?")
    .get(String(id));
  return { ...r };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
const delivered = (s: S, id: unknown) => row(s, id).delivery === "delivered";
const startedTurns = (s: S, agent: string) =>
  s.a12s.agents.get(agent)?.journal.filter((e) => e.type === "turn.started").length ?? 0;

const seq = (id: string) => Number(id.slice(2));

// Fails the given send calls (counted from 1) after or instead of passing them to the fake.
function failingSends(fail: (n: number) => "before" | "after" | null) {
  return (fake: FakeA12s): A12s => {
    let n = 0;
    return {
      ...fake,
      forTeam(token): TeamA12s {
        const client = fake.forTeam(token);
        return {
          ...client,
          async send(name, message) {
            const when = fail(++n);
            if (when === "before") throw new A12sError("inbox_full", "Inbox full.");
            const sent = await client.send(name, message);
            if (when === "after") throw new Error("the app stopped here");
            return sent;
          },
        };
      },
    };
  };
}

test("a message is sent, then its asleep receiver is woken", async (t) => {
  const s = await setup(t);
  sleepAll(s.a12s);
  const posted = await s.tool("web-lead", "post", { to: "dev", title: "Hero", body: "Draft the hero." });
  await s.app.dispatcher.run();

  const [sent, ...rest] = pending(s.a12s, "web-dev");
  assert.equal(rest.length, 0);
  assert.equal(
    sent?.body,
    [`thread ${posted.thread} "Hero"`, `message ${posted.message} from lead`, "---", "Draft the hero.", "---"].join(
      "\n",
    ),
  );
  assert.deepEqual(sent?.metadata, { message: posted.message, from: "lead", thread: posted.thread });
  assert.equal(sent?.replaceKey, posted.message);
  assert.notEqual(s.a12s.agents.get("web-dev")?.phase, "Asleep");
  assert.deepEqual(row(s, posted.message), { delivery: "sent", a12s: sent?.id });
});

test("a message to the owner reaches no a12s inbox and wakes nobody", async (t) => {
  const s = await setup(t);
  sleepAll(s.a12s);
  const owner = await s.tool("web-lead", "post", { to: "owner", title: "Plan", body: "Blue or green?" });
  await s.app.dispatcher.run();
  assert.deepEqual(row(s, owner.message), { delivery: "none", a12s: null });
  for (const agent of s.a12s.agents.values()) {
    assert.equal(agent.inbox.length, 0);
    assert.equal(agent.phase, "Asleep");
  }
});

test("a message for a working agent joins its running Turn and starts none", async (t) => {
  const s = await setup(t, { live: true });
  const turn = s.a12s.startTurn("web-dev");
  const posted = await s.tool("web-lead", "post", { to: "dev", title: "Hero", body: "Use the new logo." });
  await s.app.dispatcher.run();
  await until(() => delivered(s, posted.message));
  assert.deepEqual(chain(s, posted.message), { cause: null, depth: 0, turn, steered: 1 });
  assert.equal(startedTurns(s, "web-dev"), 1);
  assert.equal(s.a12s.agents.get("web-dev")?.current?.turn, turn, "the Turn goes on");
  assert.equal(s.app.live.agent("web-dev")?.turn?.id, turn);

  s.a12s.finishTurn("web-dev");
  await until(() => s.app.repo.turnTeam(turn) === "web");
  assert.deepEqual(chain(s, posted.message), { cause: null, depth: 0, turn, steered: 1 });
});

test("a message that misses the running Turn starts the next and is delivered once", async (t) => {
  const s = await setup(t, { live: true });
  const first = s.a12s.startTurn("web-dev");
  s.a12s.missTurn("web-dev");
  const posted = await s.tool("web-lead", "post", { to: "dev", title: "Hero", body: "Use the new logo." });
  await s.app.dispatcher.run();
  await until(() => delivered(s, posted.message));
  const next = s.a12s.agents.get("web-dev")?.current?.turn;
  assert.notEqual(next, first);
  assert.deepEqual(chain(s, posted.message), { cause: null, depth: 0, turn: next, steered: 0 });
  const received = [...(s.a12s.agents.get("web-dev")?.journal ?? [])].flatMap((e) =>
    e.type === "turn.started" || e.type === "turn.steered" ? e.messageIds : [],
  );
  assert.equal(received.filter((id) => id === row(s, posted.message).a12s).length, 1);
});

test("a resync during a Turn leaves a message that joined it as it was recorded", async (t) => {
  const s = await setup(t, { live: true });
  const turn = s.a12s.startTurn("web-dev");
  const joined = await s.tool("web-lead", "post", { to: "dev", title: "Hero", body: "Use the new logo." });
  await s.app.dispatcher.run();
  await until(() => delivered(s, joined.message));
  // A second message stays in the a12s inbox, so the resync reads that inbox, which also lists the first.
  const dev = s.a12s.agents.get("web-dev");
  assert.ok(dev);
  const { inbox: _, ...spec } = dev.spec;
  dev.spec = spec;
  const waiting = await s.tool("web-lead", "post", { to: "dev", thread: joined.thread, body: "And the tagline." });
  await s.app.dispatcher.run();
  dev.phase = "Ready";
  s.a12s.emit({ type: "gap" });
  await until(() => s.app.live.agent("web-dev")?.phase === "Ready");
  await tick();
  assert.equal(row(s, waiting.message).delivery, "sent");
  assert.deepEqual(chain(s, joined.message), { cause: null, depth: 0, turn, steered: 1 });
});

test("a message that joined a Turn while the feed was down is recorded as joined when the Turn is stored", async (t) => {
  const s = await setup(t, { live: true });
  await until(() => s.app.live.up());
  const turn = s.a12s.startTurn("web-dev");
  // The feed is down when a12s reports the message as steered, so only the resync tells of it.
  s.a12s.setReachable(false);
  await until(() => !s.app.live.up());
  const posted = await s.tool("web-lead", "post", { to: "dev", title: "Hero", body: "Use the new logo." });
  await s.app.dispatcher.run();
  await tick();
  s.a12s.setReachable(true);
  await until(() => delivered(s, posted.message), 3000);
  assert.deepEqual(chain(s, posted.message), { cause: null, depth: 0, turn, steered: 0 });

  s.a12s.finishTurn("web-dev");
  await until(() => s.app.repo.turnTeam(turn) === "web");
  assert.deepEqual(chain(s, posted.message), { cause: null, depth: 0, turn, steered: 1 });
});

test("an agent without the steering policy gets a message at its next Turn", async (t) => {
  const s = await setup(t, { live: true });
  const dev = s.a12s.agents.get("web-dev");
  assert.ok(dev);
  const { inbox: _, ...spec } = dev.spec;
  dev.spec = spec;
  s.a12s.startTurn("web-dev");
  const posted = await s.tool("web-lead", "post", { to: "dev", title: "Hero", body: "Use the new logo." });
  await s.app.dispatcher.run();
  await tick();
  assert.equal(row(s, posted.message).delivery, "sent");
  s.a12s.finishTurn("web-dev");
  const next = s.a12s.startTurn("web-dev");
  await until(() => delivered(s, posted.message));
  assert.deepEqual(chain(s, posted.message), { cause: null, depth: 0, turn: next, steered: 0 });
});

test("cause and depth follow a chain through three senders, and a post outside a Turn has none", async (t) => {
  const s = await setup(t, { live: true });
  const web = s.app.repo.forTeam("web");
  const owner = ownerThread(web, { body: "Ship the hero." });
  await s.app.dispatcher.run();
  const leadTurn = s.a12s.startTurn("web-lead");
  await until(() => delivered(s, owner.message) && s.app.live.agent("web-lead")?.turn?.id === leadTurn);

  const toDev = await s.tool("web-lead", "post", { to: "dev", thread: owner.thread, body: "Draft it." });
  await s.app.dispatcher.run();
  const devTurn = s.a12s.startTurn("web-dev");
  await until(() => delivered(s, toDev.message) && s.app.live.agent("web-dev")?.turn?.id === devTurn);

  const toLead = await s.tool("web-dev", "post", { to: "lead", thread: owner.thread, body: "Which logo?" });
  await until(() => delivered(s, toLead.message));
  const again = await s.tool("web-lead", "post", { to: "dev", thread: owner.thread, body: "The new one." });
  await until(() => delivered(s, again.message));

  assert.deepEqual(chain(s, owner.message), { cause: null, depth: 0, turn: leadTurn, steered: 0 });
  assert.deepEqual(chain(s, toDev.message), { cause: owner.message, depth: 1, turn: devTurn, steered: 0 });
  assert.deepEqual(chain(s, toLead.message), { cause: toDev.message, depth: 2, turn: leadTurn, steered: 1 });
  assert.deepEqual(chain(s, again.message), { cause: toLead.message, depth: 3, turn: devTurn, steered: 1 });

  s.a12s.finishTurn("web-lead");
  await until(() => s.app.live.agent("web-lead")?.turn === null);
  const outside = await s.tool("web-lead", "post", { to: "owner", thread: owner.thread, body: "Progress: done." });
  assert.deepEqual(chain(s, outside.message), { cause: null, depth: 0, turn: null, steered: 0 });
});

test("no post is refused for what it answers or for how many came before it", async (t) => {
  const s = await setup(t);
  const thread = (await s.tool("web-lead", "post", { to: "dev", title: "Ping", body: "0" })).thread;
  for (let i = 1; i <= 40; i++) {
    const answer = await s.tool(i % 2 ? "web-dev" : "web-lead", "post", {
      to: i % 2 ? "lead" : "dev",
      thread,
      body: `${i}`,
    });
    assert.equal(answer.error, undefined, `message ${i}`);
  }
  assert.equal(s.app.repo.forTeam("web").threadMessages(String(thread), 100).length, 41);
});

test("post takes thread or title, refuses itself as receiver and any field it does not name", async (t) => {
  const s = await setup(t);
  const thread = (await s.tool("web-lead", "post", { to: "dev", title: "T", body: "b" })).thread;
  for (const [args, code] of [
    [{ to: "dev", body: "b" }, "missing_thread"],
    [{ to: "dev", thread, title: "T", body: "b" }, "thread_or_title"],
    [{ to: "lead", thread, body: "b" }, "self"],
    [{ to: "nobody", thread, body: "b" }, "not_found"],
    [{ kind: "ask", to: "dev", thread, body: "b" }, "invalid_input"],
    [{ ask: "m_x", to: "dev", thread, body: "b" }, "invalid_input"],
  ] as const) {
    assert.equal((await s.tool("web-lead", "post", args)).error?.code, code, JSON.stringify(args));
  }
  assert.ok((await s.tool("web-lead", "post", { to: "dev", thread, body: "" })).error, "an empty body is refused");
  assert.equal(s.app.repo.forTeam("web").threadMessages(String(thread), 10).length, 1, "nothing refused was written");
});

test("an answer that names no receiver is refused with who to name; named, it reaches whoever asked", async (t) => {
  const s = await setup(t);
  const asked = await s.tool("web-lead", "post", { to: "dev", title: "Format", body: "JSON lines or CSV?" });
  const { thread } = ownerThread(s.app.repo.forTeam("web"), { body: "Which colour?", to: "dev" });
  await s.app.dispatcher.run();
  sleepAll(s.a12s);
  const unread = () => deriveState(s.app, null).teams[0]?.threads.find((x) => x.id === thread)?.unread;
  const written = () => s.db.prepare("SELECT count(*) AS n FROM messages").get()?.n;
  const before = written();

  for (const args of [
    { thread: asked.thread, body: "JSON lines." },
    { thread, body: "Green." },
  ]) {
    const refused = await s.tool("web-dev", "post", args);
    assert.match(refused.error?.message ?? "", /A post needs to: a teammate's name from roster, or "owner"\./);
  }
  assert.equal(written(), before, "nothing refused was written");

  await s.tool("web-dev", "post", { to: "lead", thread: asked.thread, body: "JSON lines." });
  await s.tool("web-dev", "post", { to: "owner", thread, body: "Green." });
  await s.app.dispatcher.run();
  assert.match(pending(s.a12s, "web-lead").at(-1)?.body ?? "", /from dev\n---\nJSON lines\./);
  assert.notEqual(s.a12s.agents.get("web-lead")?.phase, "Asleep", "the asker is woken by the answer");
  assert.equal(unread(), 1, "the owner's thread shows its answer as unread");
});

test("the owner's messages are sent first", async (t) => {
  const s = await setup(t);
  await s.app.teams.pause(null);
  // Apart in time, so the order is decided by who wrote, not by a tie.
  await s.tool("web-lead", "post", { to: "dev", title: "Oldest", body: "From the lead." });
  await tick();
  await s.tool("notes-lead", "post", { to: "researcher", title: "Older", body: "From a lead." });
  await tick();
  ownerThread(s.app.repo.forTeam("web"), { body: "From the owner." });
  await s.app.dispatcher.run();
  assert.equal(pending(s.a12s, "web-lead").length, 0, "nothing is sent while everything is paused");

  await s.app.teams.resume(null);
  const first = pending(s.a12s, "web-lead")[0];
  const later = [...pending(s.a12s, "web-dev"), ...pending(s.a12s, "notes-researcher")];
  assert.equal(later.length, 2);
  for (const other of later) assert.ok(seq(first?.id ?? "") < seq(other.id), "the owner's message went out first");
});

test("a team pause holds delivery, puts its agents to sleep, and resume delivers in order", async (t) => {
  const s = await setup(t);
  const web = s.app.repo.forTeam("web");
  ownerThread(web, { body: "Plan the launch." });
  await s.app.dispatcher.run();
  s.a12s.startTurn("web-lead");
  const thread = ownerThread(web, { body: "Ready?", to: "dev" }).thread;
  await s.app.dispatcher.run();
  assert.equal(pending(s.a12s, "web-dev").length, 1, "sent before the pause, not yet taken");

  await s.app.teams.pause("web");
  for (const name of ["web-lead", "web-dev"]) assert.equal(s.a12s.agents.get(name)?.phase, "Asleep", name);
  assert.equal(s.a12s.agents.get("web-lead")?.turns[0]?.status, "interrupted");
  assert.notEqual(s.a12s.agents.get("notes-lead")?.phase, "Asleep", "another team is not paused");

  for (const body of ["one", "two", "three"]) ownerPost(web, thread, { body, to: "dev" });
  await s.app.dispatcher.run();
  assert.equal(pending(s.a12s, "web-dev").length, 1, "nothing more is sent while paused");
  assert.equal(s.a12s.agents.get("web-dev")?.phase, "Asleep");

  await s.app.teams.resume("web");
  assert.deepEqual(
    pending(s.a12s, "web-dev").map((m) => bodyOf(m.body)),
    ["Ready?", "one", "two", "three"],
  );
  const lead = pending(s.a12s, "web-lead");
  assert.equal(lead.length, 1);
  assert.match(
    lead[0]?.body ?? "",
    /^message m_\w+ from system\n---\nYou were paused while working, and any background work was stopped\. Continue where you stopped\.\n---$/,
  );
  for (const name of ["web-lead", "web-dev"]) assert.notEqual(s.a12s.agents.get(name)?.phase, "Asleep", name);
});

test("an agent in error gets nothing until it recovers", async (t) => {
  const s = await setup(t);
  s.a12s.setPhase("web-dev", "Error", "out of memory");
  const posted = await s.tool("web-lead", "post", { to: "dev", title: "T", body: "b" });
  await s.app.dispatcher.run();
  assert.equal(pending(s.a12s, "web-dev").length, 0);
  assert.equal(row(s, posted.message).delivery, "queued");
  s.a12s.setPhase("web-dev", "Ready");
  await s.app.dispatcher.run();
  assert.equal(pending(s.a12s, "web-dev").length, 1);
});

test("a failed send stays queued and the next run sends it", async (t) => {
  const s = await setup(t, { wrap: failingSends((n) => (n === 1 ? "before" : null)) });
  sleepAll(s.a12s);
  const posted = await s.tool("web-lead", "post", { to: "dev", title: "T", body: "b" });
  await s.app.dispatcher.run();
  assert.equal(row(s, posted.message).delivery, "sent");
  assert.equal(pending(s.a12s, "web-dev").length, 1);
});

test("a restart between commit and send delivers once", async (t) => {
  const first = await studio();
  await first.twoTeams();
  sleepAll(first.a12s);
  const { message } = ownerThread(first.app.repo.forTeam("web"), { body: "Committed, never sent." });
  await first.close();

  const s = await studio({ dbFile: first.dbFile, a12s: first.a12s });
  t.after(() => s.close());
  await s.app.dispatcher.run();
  await s.app.dispatcher.run();
  const inbox = pending(s.a12s, "web-lead");
  assert.equal(inbox.length, 1);
  assert.deepEqual(row(s, message), { delivery: "sent", a12s: inbox[0]?.id });
});

test("a restart after a12s took the send but before it was recorded replaces, not duplicates", async (t) => {
  const first = await studio({ wrap: failingSends(() => "after") });
  await first.twoTeams();
  sleepAll(first.a12s);
  const { message } = ownerThread(first.app.repo.forTeam("web"), { body: "Sent, not recorded." });
  await first.app.dispatcher.run();
  assert.equal(pending(first.a12s, "web-lead").length, 1);
  assert.equal(row(first, message).delivery, "queued");
  await first.close();

  const s = await studio({ dbFile: first.dbFile, a12s: first.a12s });
  t.after(() => s.close());
  await s.app.dispatcher.run();
  const inbox = pending(s.a12s, "web-lead");
  assert.equal(inbox.length, 1);
  assert.equal(s.a12s.agents.get("web-lead")?.inbox.filter((m) => m.state === "replaced").length, 1);
  assert.deepEqual(row(s, message), { delivery: "sent", a12s: inbox[0]?.id });
});

test("a thread is unread from an agent's message to the owner until the owner opens it or writes there", async (t) => {
  const s = await setup(t);
  const web = s.app.repo.forTeam("web");
  const unread = (thread: string) => deriveState(s.app, null).teams[0]?.threads.find((x) => x.id === thread)?.unread;
  const status = async (thread: unknown) =>
    ((await s.tool("web-dev", "read", { status: "all" })).threads as { id: string; status: string }[]).find(
      (b) => b.id === thread,
    )?.status;

  const { thread } = ownerThread(web, { body: "Which colour?", to: "lead" });
  assert.equal(unread(thread), 0, "the owner's own message is read");
  await tick();
  for (const body of ["Blue or green?", "Or teal?"]) await s.tool("web-lead", "post", { to: "owner", thread, body });
  await s.tool("web-lead", "post", { to: "dev", thread, body: "Hold the palette." });
  assert.equal(unread(thread), 2, "messages to the owner, and only those");
  assert.equal(await status(thread), "open", "agents see the thread's own status");
  assert.deepEqual(deriveState(s.app, null).needsYou, [], "a message to the owner is not a Needs You card");

  await tick();
  ownerPost(web, thread, { body: "Green." });
  assert.equal(unread(thread), 0, "writing in the thread is reading it");

  await tick();
  await s.tool("web-lead", "post", { to: "owner", thread, body: "Done, and here it is." });
  changeThread(web, thread, { status: "done" });
  assert.equal(unread(thread), 1, "a done thread still shows what came after the owner looked");
  await tick();
  markSeen(web, thread);
  assert.equal(unread(thread), 0, "opening the thread reads it");
});

test("an unaddressed owner message goes to the thread's owner and wakes it", async (t) => {
  const s = await setup(t);
  const thread = String((await s.tool("web-lead", "post", { to: "owner", title: "Colour", body: "Blue?" })).thread);
  sleepAll(s.a12s);
  const web = s.app.repo.forTeam("web");
  const answer = ownerPost(web, thread, { body: "Green." });
  await s.app.dispatcher.run();
  assert.equal(web.message(answer.message)?.toId, "web-lead");
  assert.match(pending(s.a12s, "web-lead")[0]?.body ?? "", /^thread th_\w+ "Colour"\nmessage m_\w+ from owner\n/);
  assert.notEqual(s.a12s.agents.get("web-lead")?.phase, "Asleep");
});

test("an owner message steered into a Turn answered in plain output leaves the answer in its thread", async (t) => {
  const s = await setup(t, { live: true });
  const web = s.app.repo.forTeam("web");
  const first = ownerThread(web, { title: "Build", body: "Build the page." });
  await s.app.dispatcher.run();
  const turn = s.a12s.startTurn("web-lead");
  await until(() => delivered(s, first.message));
  // The lead posts in the first thread, so only the second gets an answer on its behalf.
  await s.tool("web-lead", "post", { to: "owner", thread: first.thread, body: "Building." });
  const second = ownerThread(web, { title: "Question", body: "What is left?" });
  await s.app.dispatcher.run();
  await until(() => delivered(s, second.message));
  assert.equal(chain(s, second.message).steered, 1);

  s.a12s.emit({ type: "text.delta", agent: "web-lead", at: Date.now(), turn, text: "Only the footer is left." });
  s.a12s.finishTurn("web-lead");
  await until(() => s.app.repo.turnTeam(turn) === "web");
  const [, answer] = web.threadMessages(second.thread, 10);
  assert.deepEqual(answer && [answer.fromId, answer.toId, answer.body, answer.causeId, answer.depth, answer.delivery], [
    "web-lead",
    "owner",
    "Only the footer is left.",
    second.message,
    1,
    "none",
  ]);
  assert.equal(web.threadMessages(first.thread, 10).length, 2, "a thread the agent posted in gets nothing");
});

test("a failed send holds the agent's later messages, so they arrive in order", async (t) => {
  const s = await setup(t, { wrap: failingSends((n) => (n === 1 ? "before" : null)) });
  const web = s.app.repo.forTeam("web");
  const thread = String((await s.tool("web-lead", "post", { to: "owner", title: "T", body: "b" })).thread);
  for (const body of ["one", "two", "three"]) ownerPost(web, thread, { body, to: "dev" });
  await s.app.dispatcher.run();
  assert.equal(pending(s.a12s, "web-dev").length, 0, "the second message does not overtake the failed first");

  await s.app.dispatcher.run();
  assert.deepEqual(
    pending(s.a12s, "web-dev").map((m) => bodyOf(m.body)),
    ["one", "two", "three"],
  );
});

test("an agent paused with a message still in its inbox is woken on resume", async (t) => {
  const s = await setup(t);
  ownerThread(s.app.repo.forTeam("web"), { body: "Sent, not yet taken." });
  await s.app.dispatcher.run();
  await s.app.teams.pause("web");
  assert.equal(s.a12s.agents.get("web-lead")?.phase, "Asleep");

  await s.app.teams.resume("web");
  assert.equal(pending(s.a12s, "web-lead").length, 1);
  assert.notEqual(s.a12s.agents.get("web-lead")?.phase, "Asleep");
  assert.equal(s.a12s.agents.get("web-dev")?.phase, "Asleep", "an agent with nothing waiting stays asleep");
});

test("a pause during a delivery run leaves nobody awake", async (t) => {
  const s = await setup(t);
  sleepAll(s.a12s);
  ownerThread(s.app.repo.forTeam("web"), { body: "Posted just before the pause." });
  const run = s.app.dispatcher.run();
  await s.app.teams.pause("web");
  await run;
  assert.equal(s.a12s.agents.get("web-lead")?.phase, "Asleep");
});

test("a message to an agent who has left the team is recorded, not queued", async (t) => {
  const s = await setup(t);
  const web = s.app.repo.forTeam("web");
  await s.app.teams.fire("web", "web-dev");
  const id = systemMessage(web, "web-dev", "Access approved.");
  assert.equal(row(s, id).delivery, "none");
});
