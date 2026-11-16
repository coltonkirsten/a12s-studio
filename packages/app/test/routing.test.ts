import assert from "node:assert/strict";
import { test } from "node:test";
import type { FakeA12s } from "../src/a12s/fake.ts";
import { type A12s, A12sError, type TeamA12s } from "../src/a12s/port.ts";
import { onTurnFinished, ownerPost, ownerThread } from "../src/router.ts";
import { pending, studio } from "./studio.ts";

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

test("an ask is sent, then its asleep receiver is woken", async (t) => {
  const s = await setup(t);
  sleepAll(s.a12s);
  const asked = await s.tool("web-lead", "post", { kind: "ask", to: "dev", title: "Hero", body: "Draft the hero." });
  await s.app.dispatcher.run();

  const [sent, ...rest] = pending(s.a12s, "web-dev");
  assert.equal(rest.length, 0);
  assert.equal(
    sent?.body,
    [
      `thread ${asked.thread} "Hero"`,
      `ask ${asked.message} from lead`,
      "---",
      "Draft the hero.",
      "---",
      `To answer: post(kind="reply", ask="${asked.message}")`,
    ].join("\n"),
  );
  assert.deepEqual(sent?.metadata, { message: asked.message, kind: "ask", from: "lead", thread: asked.thread });
  assert.equal(sent?.replaceKey, asked.message);
  assert.notEqual(s.a12s.agents.get("web-dev")?.phase, "Asleep");
  assert.deepEqual(row(s, asked.message), { delivery: "sent", a12s: sent?.id });
});

test("a reply goes to the asker and wakes it", async (t) => {
  const s = await setup(t);
  const asked = await s.tool("web-lead", "post", { kind: "ask", to: "dev", title: "Hero", body: "Draft it." });
  await s.app.dispatcher.run();
  sleepAll(s.a12s);
  const replied = await s.tool("web-dev", "post", { kind: "reply", ask: asked.message, body: "Drafted." });
  assert.equal(replied.thread, asked.thread);
  await s.app.dispatcher.run();

  const [sent] = pending(s.a12s, "web-lead");
  assert.match(
    sent?.body ?? "",
    new RegExp(`^thread ${asked.thread} "Hero"\nreply ${replied.message} from dev to your ask ${asked.message}\n`),
  );
  assert.doesNotMatch(sent?.body ?? "", /To answer/);
  assert.notEqual(s.a12s.agents.get("web-lead")?.phase, "Asleep");
});

test("a note alone never reaches a12s; it rides with the receiver's next ask", async (t) => {
  const s = await setup(t);
  sleepAll(s.a12s);
  const asked = await s.tool("web-lead", "post", { kind: "ask", to: "owner", title: "Plan", body: "Which colour?" });
  const thread = asked.thread;
  const note = await s.tool("web-lead", "post", { kind: "note", to: "dev", thread, body: "Staging is rebuilt." });
  const open = await s.tool("web-lead", "post", { kind: "note", thread, body: "For the record." });
  await s.app.dispatcher.run();
  assert.equal(s.a12s.agents.get("web-dev")?.inbox.length, 0);
  assert.equal(s.a12s.agents.get("web-dev")?.phase, "Asleep");
  assert.deepEqual(row(s, note.message), { delivery: "queued", a12s: null });
  assert.deepEqual(row(s, open.message), { delivery: "none", a12s: null });
  assert.deepEqual(row(s, asked.message), { delivery: "none", a12s: null });

  const next = await s.tool("web-lead", "post", { kind: "ask", to: "dev", thread, body: "Ship it." });
  await s.app.dispatcher.run();
  const inbox = pending(s.a12s, "web-dev");
  assert.equal(inbox.length, 1);
  assert.match(
    inbox[0]?.body ?? "",
    new RegExp(`\n\nnotes since your last message:\n- \\[${thread}\\] lead: Staging is rebuilt\\.$`),
  );
  assert.deepEqual(row(s, note.message), { delivery: "sent", a12s: inbox[0]?.id });
  assert.deepEqual(row(s, next.message), { delivery: "sent", a12s: inbox[0]?.id });
});

test("one reply per ask, no reply to a reply, and only the receiver replies", async (t) => {
  const s = await setup(t);
  const asked = await s.tool("web-lead", "post", { kind: "ask", to: "dev", title: "Hero", body: "Draft it." });
  assert.equal(
    (await s.tool("web-lead", "post", { kind: "reply", ask: asked.message, body: "Me?" })).error?.code,
    "not_yours",
  );
  const replied = await s.tool("web-dev", "post", { kind: "reply", ask: asked.message, body: "Drafted." });
  assert.equal(typeof replied.message, "string");
  assert.equal(
    (await s.tool("web-dev", "post", { kind: "reply", ask: asked.message, body: "Again." })).error?.code,
    "replied",
  );
  assert.equal(
    (await s.tool("web-lead", "post", { kind: "reply", ask: replied.message, body: "Thanks." })).error?.code,
    "not_an_ask",
  );
  assert.throws(
    () => ownerPost(s.app.repo.forTeam("web"), String(asked.thread), { body: "x", ask: String(asked.message) }),
    {
      code: "not_yours",
    },
  );
});

test("post refuses fields that do not belong to its kind, and asks to oneself", async (t) => {
  const s = await setup(t);
  const thread = (await s.tool("web-lead", "post", { kind: "ask", to: "dev", title: "T", body: "b" })).thread;
  for (const [args, code] of [
    [{ kind: "ask", to: "dev", body: "b" }, "missing_thread"],
    [{ kind: "ask", to: "dev", thread, title: "T", body: "b" }, "thread_or_title"],
    [{ kind: "ask", thread, body: "b" }, "missing_to"],
    [{ kind: "ask", to: "lead", thread, body: "b" }, "self"],
    [{ kind: "ask", to: "dev", thread, ask: "m_x", body: "b" }, "bad_field"],
    [{ kind: "reply", ask: "m_x", to: "dev", body: "b" }, "bad_field"],
    [{ kind: "reply", body: "b" }, "missing_ask"],
    [{ kind: "note", body: "b" }, "missing_thread"],
    [{ kind: "note", thread, title: "T", body: "b" }, "bad_field"],
  ] as const) {
    assert.equal((await s.tool("web-lead", "post", args)).error?.code, code, JSON.stringify(args));
  }
  assert.ok((await s.tool("web-lead", "post", { kind: "note", thread, body: "" })).error, "an empty body is refused");
});

test("the owner's asks are sent first", async (t) => {
  const s = await setup(t);
  await s.app.teams.pause(null);
  // Apart in time, so the order is decided by who wrote, not by a tie.
  const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
  await s.tool("web-lead", "post", { kind: "ask", to: "dev", title: "Oldest", body: "From the lead." });
  await tick();
  await s.tool("notes-lead", "post", { kind: "ask", to: "researcher", title: "Older", body: "From a lead." });
  await tick();
  ownerThread(s.app.repo.forTeam("web"), { body: "From the owner." });
  await s.app.dispatcher.run();
  assert.equal(pending(s.a12s, "web-lead").length, 0, "nothing is sent while everything is paused");

  await s.app.teams.resume(null);
  const first = pending(s.a12s, "web-lead")[0];
  const later = [...pending(s.a12s, "web-dev"), ...pending(s.a12s, "notes-researcher")];
  assert.equal(later.length, 2);
  for (const other of later) assert.ok(seq(first?.id ?? "") < seq(other.id), "the owner's ask went out first");
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
    pending(s.a12s, "web-dev").map((m) => m.body.split("\n---\n")[1]),
    ["Ready?", "one", "two", "three"],
  );
  const lead = pending(s.a12s, "web-lead");
  assert.equal(lead.length, 1);
  assert.match(
    lead[0]?.body ?? "",
    /^ask m_\w+ from system\n---\nYou were paused mid-turn\. Continue where you stopped\.\n---$/,
  );
  for (const name of ["web-lead", "web-dev"]) assert.notEqual(s.a12s.agents.get(name)?.phase, "Asleep", name);
});

test("an agent in error gets nothing until it recovers", async (t) => {
  const s = await setup(t);
  s.a12s.setPhase("web-dev", "Error", "out of memory");
  const asked = await s.tool("web-lead", "post", { kind: "ask", to: "dev", title: "T", body: "b" });
  await s.app.dispatcher.run();
  assert.equal(pending(s.a12s, "web-dev").length, 0);
  assert.equal(row(s, asked.message).delivery, "queued");
  s.a12s.setPhase("web-dev", "Ready");
  await s.app.dispatcher.run();
  assert.equal(pending(s.a12s, "web-dev").length, 1);
});

test("a failed send stays queued and the next run sends it", async (t) => {
  const s = await setup(t, { wrap: failingSends((n) => (n === 1 ? "before" : null)) });
  sleepAll(s.a12s);
  const asked = await s.tool("web-lead", "post", { kind: "ask", to: "dev", title: "T", body: "b" });
  await s.app.dispatcher.run();
  assert.equal(row(s, asked.message).delivery, "sent");
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

test("the owner answers an agent's question with a reply that wakes the agent", async (t) => {
  const s = await setup(t);
  const asked = await s.tool("web-lead", "post", { kind: "ask", to: "owner", title: "Colour", body: "Blue or green?" });
  const board = (await s.tool("web-dev", "read", {})).threads as { id: string; status: string }[];
  assert.equal(board.find((b) => b.id === asked.thread)?.status, "needs_you");
  sleepAll(s.a12s);

  const web = s.app.repo.forTeam("web");
  const answer = ownerPost(web, String(asked.thread), { body: "Green.", ask: String(asked.message) });
  await s.app.dispatcher.run();
  assert.match(
    pending(s.a12s, "web-lead")[0]?.body ?? "",
    /^thread th_\w+ "Colour"\nreply m_\w+ from owner to your ask/,
  );
  assert.equal(row(s, answer.message).delivery, "sent");
  assert.throws(() => ownerPost(web, String(asked.thread), { body: "Blue.", ask: String(asked.message) }), {
    code: "replied",
  });
  const after = (await s.tool("web-dev", "read", {})).threads as { id: string; status: string }[];
  assert.equal(after.find((b) => b.id === asked.thread)?.status, "open");

  const plain = ownerPost(web, String(asked.thread), { body: "Also the footer." });
  assert.equal(web.message(plain.message)?.toId, "web-lead", "an unaddressed owner ask goes to the thread's owner");
});

test("an owner ask answered in plain output is kept as an implicit note; the ask stays open", async (t) => {
  const s = await setup(t);
  const web = s.app.repo.forTeam("web");
  const posted = ownerThread(web, { title: "Question", body: "What is left?" });
  const other = ownerThread(web, { title: "Other", body: "And here?" });
  await s.app.dispatcher.run();
  const startedAt = Date.now();
  s.a12s.startTurn("web-lead");
  const messageIds = s.a12s.agents.get("web-lead")?.current?.messageIds ?? [];
  assert.equal(messageIds.length, 2);
  await s.tool("web-lead", "post", { kind: "note", thread: other.thread, body: "Posted properly here." });
  s.a12s.finishTurn("web-lead");

  const finished = { agentId: "web-lead", startedAt, messageIds };
  onTurnFinished(web, { ...finished, status: "failed", text: "Half an answer." });
  onTurnFinished(web, { ...finished, status: "completed", text: "  " });
  assert.equal(web.threadMessages(posted.thread, 10).length, 1);

  onTurnFinished(web, { ...finished, status: "completed", text: "Only the footer is left." });
  const [, note] = web.threadMessages(posted.thread, 10);
  assert.deepEqual(
    note && {
      kind: note.kind,
      from: note.fromId,
      to: note.toId,
      body: note.body,
      implicit: note.implicit,
      delivery: note.delivery,
    },
    { kind: "note", from: "web-lead", to: "owner", body: "Only the footer is left.", implicit: true, delivery: "none" },
  );
  assert.equal(web.threadMessages(other.thread, 10).length, 2, "a thread the agent posted in gets no implicit note");
  assert.equal(web.hasReply(posted.message), false);
});

test("a failed send holds the agent's later messages, so they arrive in order", async (t) => {
  const s = await setup(t, { wrap: failingSends((n) => (n === 1 ? "before" : null)) });
  const web = s.app.repo.forTeam("web");
  const thread = String((await s.tool("web-lead", "post", { kind: "ask", to: "owner", title: "T", body: "b" })).thread);
  await s.tool("web-lead", "post", { kind: "note", to: "dev", thread, body: "A note." });
  for (const body of ["one", "two"]) ownerPost(web, thread, { body, to: "dev" });
  await s.app.dispatcher.run();
  assert.equal(pending(s.a12s, "web-dev").length, 0, "the second ask does not overtake the failed first");

  await s.app.dispatcher.run();
  const bodies = pending(s.a12s, "web-dev").map((m) => m.body);
  assert.deepEqual(
    bodies.map((b) => b.split("\n---\n")[1]),
    ["one", "two"],
  );
  assert.match(bodies[0] ?? "", /A note\./, "the notes ride on the first message");
  assert.doesNotMatch(bodies[1] ?? "", /A note\./, "and only on the first");
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

test("a reply to an asker who has left the team is recorded, not queued", async (t) => {
  const s = await setup(t);
  const asked = await s.tool("web-dev", "post", { kind: "ask", to: "lead", title: "Review", body: "Look?" });
  await s.app.teams.fire("web", "web-dev");
  const replied = await s.tool("web-lead", "post", { kind: "reply", ask: asked.message, body: "Looks good." });
  assert.equal(row(s, replied.message).delivery, "none");
});
