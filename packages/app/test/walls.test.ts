import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { markSeen, ownerThread } from "../src/router.ts";
import { pending, type Studio, studio, type ToolAnswer } from "./studio.ts";

let s: Studio;
// Ids that exist on team notes; from team web they must behave exactly like ids that do not exist.
let notes: { thread: string; message: string; answer: string };
// A thread of team web older than those: a paging cursor that leaked across teams would return it.
let early: string;

before(async () => {
  s = await studio();
  await s.twoTeams();
  early = String((await s.tool("web-lead", "post", { to: "dev", title: "Early", body: "First." })).thread);
  await new Promise((resolve) => setTimeout(resolve, 5));
  const asked = await s.tool("notes-lead", "post", { to: "researcher", title: "Sources", body: "Find three." });
  const thread = String(asked.thread);
  const answered = await s.tool("notes-researcher", "post", { to: "lead", thread, body: "Found them." });
  notes = { thread, message: String(asked.message), answer: String(answered.message) };
});
after(() => s.close());

function sameRefusal(theirs: ToolAnswer, missing: ToolAnswer, theirId: string, missingId: string): void {
  assert.ok(theirs.error, "expected a refusal");
  assert.equal(theirs.error.code, missing.error?.code);
  assert.equal(theirs.error.message.replace(theirId, "<id>"), missing.error?.message.replace(missingId, "<id>"));
  assert.equal(theirs.error.fix, missing.error?.fix);
}

const MISSING_THREAD = "th_000000000000";
const MISSING_MESSAGE = "m_000000000000";

const cases: [string, (id: string) => [string, Record<string, unknown>], "thread" | "message"][] = [
  ["post to a teammate in a thread", (id) => ["post", { to: "dev", thread: id, body: "x" }], "thread"],
  ["read a thread", (id) => ["read", { thread: id }], "thread"],
  ["read a thread before a message", (id) => ["read", { thread: id, before: id }], "thread"],
  ["update_thread", (id) => ["update_thread", { thread: id, status: "done" }], "thread"],
];

for (const [what, call, kind] of cases) {
  test(`${what}: another team's id behaves as a missing one`, async () => {
    const missingId = kind === "thread" ? MISSING_THREAD : MISSING_MESSAGE;
    const [name, theirArgs] = call(notes[kind]);
    const [, missingArgs] = call(missingId);
    sameRefusal(
      await s.tool("web-dev", name, theirArgs),
      await s.tool("web-dev", name, missingArgs),
      notes[kind],
      missingId,
    );
  });
}

test("read: another team's id as a paging cursor reads like a missing one", async () => {
  const board = (before: string) => s.tool("web-lead", "read", { before, status: "all" });
  assert.deepEqual(await board(notes.thread), await board(MISSING_THREAD));
  const thread = (before: string) => s.tool("web-lead", "read", { thread: early, before });
  assert.deepEqual(await thread(notes.message), await thread(MISSING_MESSAGE));
});

test("a scoped repo finds and changes nothing of another team's", () => {
  const web = s.app.repo.forTeam("web");
  const theirs = s.app.repo.forTeam("notes");
  assert.equal(web.agent("notes-lead"), undefined);
  assert.equal(web.thread(notes.thread), undefined);
  assert.equal(web.message(notes.message), undefined);
  assert.deepEqual(web.threadMessages(notes.thread, 10), []);
  assert.deepEqual(web.queuedFor("notes-lead"), []);
  assert.equal(web.lastDelivered("notes-researcher", "t_any"), undefined);

  const thread = theirs.thread(notes.thread);
  const message = theirs.message(notes.message);
  web.updateThread(notes.thread, { status: "done", title: "Taken", ownerAgentId: "web-lead" }, Date.now());
  web.markSeen(notes.thread, Date.now());
  web.markSent(notes.message as `m_${string}`, "m_forged");
  web.removeAgent("notes-lead", Date.now());
  assert.deepEqual(theirs.thread(notes.thread), thread);
  assert.deepEqual(theirs.message(notes.message), message);
  assert.ok(theirs.agent("notes-lead"));
});

test("the owner cannot fire another team's agent through a team", async () => {
  await assert.rejects(s.app.teams.fire("web", "notes-researcher"), { code: "not_found" });
  assert.ok(s.a12s.agents.has("notes-researcher"));
});

test("post to another team's agent is refused and writes nothing", async () => {
  const count = () => Number(s.db.prepare("SELECT count(*) AS n FROM messages").get()?.n);
  const before = count();
  const inbox = pending(s.a12s, "notes-researcher").length;
  for (const to of ["notes-lead", "researcher", "notes-researcher"]) {
    const answer = await s.tool("web-lead", "post", { to, title: "Across", body: "Hello, other team." });
    assert.equal(answer.error?.code, "not_found", to);
  }
  const thread = (await s.tool("web-lead", "read", {})).threads as { id: string }[];
  const note = await s.tool("web-lead", "post", {
    to: "researcher",
    thread: thread[0]?.id,
    body: "psst",
  });
  assert.equal(note.error?.code, "not_found");
  assert.equal(count(), before);
  assert.equal(pending(s.a12s, "notes-researcher").length, inbox);
});

test("update_thread cannot hand a thread to another team's agent", async () => {
  const [thread] = (await s.tool("web-lead", "read", {})).threads as { id: string }[];
  const answer = await s.tool("web-lead", "update_thread", { thread: thread?.id, owner: "researcher" });
  assert.equal(answer.error?.code, "not_found");
});

test("roster and the board show only the caller's team", async () => {
  const roster = await s.tool("web-dev", "roster");
  assert.deepEqual(
    (roster.agents as { name: string }[]).map((a) => a.name),
    ["lead", "dev"],
  );
  assert.equal(roster.you, "dev");
  assert.equal(roster.lead, "lead");
  const board = (await s.tool("web-dev", "read", { status: "all" })).threads as { id: string }[];
  assert.ok(board.length > 0);
  assert.ok(board.every((t) => t.id !== notes.thread));
});

test("Mark read through one team's repo cannot reach another team's thread", () => {
  assert.throws(() => markSeen(s.app.repo.forTeam("web"), notes.thread), { code: "not_found" });
});

test("a cause from another team is never recorded", () => {
  const web = s.app.repo.forTeam("web");
  const id = web.insertMessage(
    { threadId: null, fromId: "system", toId: "web-lead", body: "x", causeId: notes.message as `m_${string}` },
    "none",
    Date.now(),
  );
  assert.deepEqual([web.message(id)?.causeId, web.message(id)?.depth], [null, 0]);
});

test("the owner's scoped repo cannot start a thread for another team's agent", () => {
  assert.throws(() => ownerThread(s.app.repo.forTeam("web"), { body: "x", to: "researcher" }), { code: "not_found" });
});
