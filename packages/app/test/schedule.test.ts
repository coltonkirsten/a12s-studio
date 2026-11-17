import assert from "node:assert/strict";
import { test } from "node:test";
import { pending, studio } from "./studio.ts";

type S = Awaited<ReturnType<typeof studio>>;

const HOUR = 60 * 60 * 1000;

async function setup(t: { after(fn: () => unknown): void }, opts: Parameters<typeof studio>[0] = {}): Promise<S> {
  const s = await studio(opts);
  t.after(() => s.close());
  await s.twoTeams();
  return s;
}

const schedule = (s: S, agent: string, args: Record<string, unknown>) => s.tool(agent, "schedule", args);

function fromSystem(s: S) {
  return s.db
    .prepare(
      "SELECT to_id AS toId, thread_id AS threadId, body, delivery FROM messages WHERE from_id = 'system' ORDER BY rowid",
    )
    .all()
    .map((row) => ({ ...row }));
}

function dueAt(s: S, id: unknown): number {
  return Number(s.db.prepare("SELECT due_at AS d FROM wakes WHERE id = ?").get(String(id))?.d);
}

function makeDue(s: S, id: unknown, at: number): void {
  s.db.prepare("UPDATE wakes SET due_at = ? WHERE id = ?").run(at, String(id));
}

test("set, list and cancel an agent's own wakes", async (t) => {
  const s = await setup(t);
  const thread = (await s.tool("web-lead", "post", { to: "dev", title: "Launch", body: "Go." })).thread;
  const before = Date.now();
  const once = await schedule(s, "web-lead", { action: "set", in_minutes: 30, note: "Check the build.", thread });
  const at = new Date(before + 2 * HOUR).toISOString();
  const daily = await schedule(s, "web-lead", { action: "set", at, repeat_hours: 24, note: "Daily summary." });
  assert.match(String(once.wake), /^w_/);
  assert.ok(Date.parse(String(once.due)) >= before + 30 * 60 * 1000);
  assert.equal(daily.due, at);

  assert.deepEqual(await schedule(s, "web-lead", { action: "list" }), {
    wakes: [
      { id: once.wake, due: once.due, repeat_hours: null, note: "Check the build.", thread },
      { id: daily.wake, due: at, repeat_hours: 24, note: "Daily summary.", thread: null },
    ],
  });
  assert.deepEqual(await schedule(s, "web-lead", { action: "cancel", id: once.wake }), { cancelled: once.wake });
  assert.deepEqual(
    ((await schedule(s, "web-lead", { action: "list" })).wakes as { id: string }[]).map((w) => w.id),
    [daily.wake],
  );
});

test("an agent sees and cancels only its own wakes; another team's wake id is missing", async (t) => {
  const s = await setup(t);
  const mine = await schedule(s, "web-lead", { action: "set", in_minutes: 5, note: "Mine." });
  const missing = await schedule(s, "web-lead", { action: "cancel", id: "w_000000000000" });
  assert.equal(missing.error?.code, "not_found");

  for (const other of ["web-dev", "notes-lead"]) {
    assert.deepEqual(await schedule(s, other, { action: "list" }), { wakes: [] }, other);
    const answer = await schedule(s, other, { action: "cancel", id: mine.wake });
    assert.deepEqual(
      answer.error,
      { ...missing.error, message: missing.error?.message.replace("w_000000000000", String(mine.wake)) },
      other,
    );
  }
  const theirs = await s.tool("notes-lead", "post", { to: "owner", title: "Notes", body: "Hi." });
  const crossed = await schedule(s, "web-lead", { action: "set", in_minutes: 5, note: "x", thread: theirs.thread });
  assert.equal(crossed.error?.code, "not_found");
  assert.equal(((await schedule(s, "web-lead", { action: "list" })).wakes as unknown[]).length, 1);
});

test("the schedule tool's limits: 20 wakes, hourly repeats, a time in the future, one way to say when", async (t) => {
  const s = await setup(t);
  for (let i = 0; i < 20; i++) {
    assert.equal((await schedule(s, "web-dev", { action: "set", in_minutes: 10 + i, note: `n${i}` })).error, undefined);
  }
  const full = await schedule(s, "web-dev", { action: "set", in_minutes: 60, note: "21st" });
  assert.equal(full.error?.code, "too_many_wakes");
  assert.equal((await schedule(s, "web-lead", { action: "set", in_minutes: 5, note: "Room." })).error, undefined);

  const refused = [
    { action: "set", in_minutes: 5, repeat_hours: 0.5, note: "x" },
    { action: "set", in_minutes: 5, repeat_hours: 0, note: "x" },
    { action: "set", in_minutes: 0.5, note: "x" },
    { action: "set", note: "x" },
    { action: "set", in_minutes: 5, at: new Date(Date.now() + HOUR).toISOString(), note: "x" },
    { action: "set", at: new Date(Date.now() - 1000).toISOString(), note: "x" },
    { action: "set", at: "2030-01-01T09:00:00", note: "x" },
    { action: "set", in_minutes: 5 },
    { action: "set", in_minutes: 5, note: "" },
    { action: "set", in_minutes: 5, note: "x".repeat(501) },
    { action: "cancel" },
    { action: "list", note: "x" },
    { action: "set", in_minutes: 5, note: "x", team: "notes" },
  ];
  for (const args of refused) {
    assert.ok((await schedule(s, "web-lead", args)).error, JSON.stringify(args));
  }
  assert.equal(((await schedule(s, "web-lead", { action: "list" })).wakes as unknown[]).length, 1);
});

test("a due wake becomes exactly one system message in its thread, across a restart between ticks", async (t) => {
  const first = await studio();
  await first.twoTeams();
  const thread = (await first.tool("web-lead", "post", { to: "owner", title: "Ops", body: "?" })).thread;
  first.a12s.setPhase("web-lead", "Asleep");
  const wake = await schedule(first, "web-lead", { action: "set", in_minutes: 1, note: "Check the deploy.", thread });
  makeDue(first, wake.wake, Date.now() - 1000);
  await first.app.scheduler.tick();
  await first.close();

  const s = await studio({ dbFile: first.dbFile, a12s: first.a12s });
  t.after(() => s.close());
  await s.app.scheduler.tick();
  await s.app.scheduler.tick();

  assert.deepEqual(fromSystem(s), [
    { toId: "web-lead", threadId: thread, body: `scheduled wake ${wake.wake}: Check the deploy.`, delivery: "sent" },
  ]);
  assert.equal(s.db.prepare("SELECT count(*) AS n FROM wakes").get()?.n, 0);
  assert.notEqual(s.a12s.agents.get("web-lead")?.phase, "Asleep", "the message woke the agent");
  assert.match(pending(s.a12s, "web-lead")[0]?.body ?? "", /^thread th_\w+ "Ops"\nmessage m_\w+ from system\n---\n/);
});

test("a repeating wake fires once and moves forward past now, keeping its time of day", async (t) => {
  const s = await setup(t);
  const wake = await schedule(s, "web-dev", { action: "set", in_minutes: 1, repeat_hours: 2, note: "Tidy up." });
  const due = Date.now() - 5 * HOUR - 1000;
  makeDue(s, wake.wake, due);
  await s.app.scheduler.tick();

  const next = dueAt(s, wake.wake);
  assert.ok(next > Date.now() && next <= Date.now() + 2 * HOUR, "the next time is the first one after now");
  assert.equal((next - due) % (2 * HOUR), 0, "on the wake's own cycle");
  assert.equal(fromSystem(s).length, 1);
  await s.app.scheduler.tick();
  assert.equal(fromSystem(s).length, 1, "not due again yet");
});

test("a wake that fires while its team is paused is held like any message", async (t) => {
  const s = await setup(t);
  await s.app.teams.pause("web");
  const wake = await schedule(s, "web-dev", { action: "set", in_minutes: 1, note: "Wake up." });
  makeDue(s, wake.wake, Date.now() - 1000);
  await s.app.scheduler.tick();
  assert.deepEqual(
    fromSystem(s).map((m) => m.delivery),
    ["queued"],
  );
  assert.equal(s.a12s.agents.get("web-dev")?.phase, "Asleep");
});
