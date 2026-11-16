import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { ownerThread } from "../src/router.ts";
import { pending, type Studio, studio, type ToolAnswer } from "./studio.ts";

let s: Studio;
// Ids that exist on team notes; from team web they must behave exactly like ids that do not exist.
let notes: { thread: string; ask: string; reply: string };

before(async () => {
  s = await studio();
  await s.twoTeams();
  const asked = await s.tool("notes-lead", "post", {
    kind: "ask",
    to: "researcher",
    title: "Sources",
    body: "Find three.",
  });
  const replied = await s.tool("notes-researcher", "post", { kind: "reply", ask: asked.message, body: "Found them." });
  notes = { thread: String(asked.thread), ask: String(asked.message), reply: String(replied.message) };
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

const cases: [string, (id: string) => [string, Record<string, unknown>], "thread" | "ask" | "reply"][] = [
  ["post ask into a thread", (id) => ["post", { kind: "ask", to: "dev", thread: id, body: "x" }], "thread"],
  ["post note into a thread", (id) => ["post", { kind: "note", thread: id, body: "x" }], "thread"],
  ["post reply to an ask", (id) => ["post", { kind: "reply", ask: id, body: "x" }], "ask"],
  ["post reply to a reply", (id) => ["post", { kind: "reply", ask: id, body: "x" }], "reply"],
  ["read a thread", (id) => ["read", { thread: id }], "thread"],
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
  await s.tool("web-lead", "post", { kind: "ask", to: "dev", title: "Hero", body: "Draft it." });
  const theirs = await s.tool("web-lead", "read", { before: notes.thread, status: "all" });
  const missing = await s.tool("web-lead", "read", { before: MISSING_THREAD, status: "all" });
  assert.deepEqual(theirs, missing);
});

test("post to another team's agent is refused and writes nothing", async () => {
  const count = () => Number(s.db.prepare("SELECT count(*) AS n FROM messages").get()?.n);
  const before = count();
  const inbox = pending(s.a12s, "notes-researcher").length;
  for (const to of ["notes-lead", "researcher", "notes-researcher"]) {
    const answer = await s.tool("web-lead", "post", { kind: "ask", to, title: "Across", body: "Hello, other team." });
    assert.equal(answer.error?.code, "not_found", to);
  }
  const thread = (await s.tool("web-lead", "read", {})).threads as { id: string }[];
  const note = await s.tool("web-lead", "post", {
    kind: "note",
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

test("the owner's scoped repo cannot start a thread for another team's agent", () => {
  assert.throws(() => ownerThread(s.app.repo.forTeam("web"), { body: "x", to: "researcher" }), { code: "not_found" });
});
