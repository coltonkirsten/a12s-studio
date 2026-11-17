import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { HOST, startBroker } from "@a12s-studio/broker/test/harness.ts";
import { deriveState } from "../src/state.ts";
import { studio } from "./studio.ts";

const DAY = 24 * 60 * 60 * 1000;

test("an expiring grant: one note to the lead and one warned call across many ticks; the card stays", async (t) => {
  const broker = await startBroker(t);
  const s = await studio({ broker: broker.socketPath });
  t.after(() => s.close());
  await s.twoTeams();
  await broker.credential("web");
  const grant = await broker.grant("web", { paths: ["/v1/items/**"], expiresAt: broker.clock.now + DAY });
  await broker.grant("notes", { expiresAt: broker.clock.now + 10 * DAY });
  const warned = t.mock.method(s.app.broker, "warned");

  for (let i = 0; i < 5; i++) await s.app.scheduler.tick();

  assert.equal(warned.mock.callCount(), 1);
  const notes = s.db
    .prepare("SELECT to_id, kind, thread_id, body, delivery FROM messages WHERE from_id = 'system'")
    .all();
  assert.deepEqual(
    notes.map((row) => ({ ...row })),
    [
      {
        to_id: "web-lead",
        kind: "note",
        thread_id: null,
        body: `Access to ${HOST} /v1/items/** expires on 2030-01-02T00:00:00.000Z. Use access to request an extension if the team still needs it.`,
        delivery: "queued",
      },
    ],
  );
  const cards = deriveState(s.app, null).needsYou.filter((c) => c.kind === "grant_expiring");
  assert.deepEqual(cards, [
    {
      kind: "grant_expiring",
      teamId: "web",
      grantId: grant.id,
      host: HOST,
      paths: ["/v1/items/**"],
      expiresAt: broker.clock.now + DAY,
    },
  ]);
});

test("a rejected credential is a card until the credential is stored again", async (t) => {
  const broker = await startBroker(t);
  const s = await studio({ broker: broker.socketPath });
  t.after(() => s.close());
  await s.twoTeams();
  await broker.credential("web");
  await broker.grant("web");
  broker.upstream.handle = (_req, res) => res.writeHead(401).end();
  assert.equal((await broker.call(`/${HOST}/v1/items`, { caller: "web-dev" })).status, 502);

  await s.app.scheduler.tick();
  const rejected = () => deriveState(s.app, null).needsYou.filter((c) => c.kind === "credential_rejected");
  assert.deepEqual(rejected(), [{ kind: "credential_rejected", teamId: "web", host: HOST, at: broker.clock.now }]);
  const stored = await s.owner("PUT", `/api/teams/web/credentials/${HOST}`, { scheme: "bearer", secret: "fresh" });
  assert.equal(stored.status, 200);
  assert.deepEqual(rejected(), []);
});

test("a broker that is down shows as down, throws nothing, and the tick still runs the dispatcher", async (t) => {
  const s = await studio({ broker: join(mkdtempSync(join(tmpdir(), "no-broker-")), "admin.sock") });
  t.after(() => s.close());
  t.mock.method(console, "error", () => {});
  const run = t.mock.method(s.app.dispatcher, "run");

  await s.app.scheduler.tick();
  assert.equal(run.mock.callCount(), 1);
  assert.equal(deriveState(s.app, null).broker, "down");
  assert.deepEqual(deriveState(s.app, null).needsYou, []);
});

test("the broker shows as up once it answers", async (t) => {
  const s = await studio();
  t.after(() => s.close());
  assert.equal(deriveState(s.app, null).broker, "down");
  await s.app.scheduler.tick();
  assert.equal(deriveState(s.app, null).broker, "up");
});

test("start ticks at once and stop waits for the tick under way", async (t) => {
  const s = await studio();
  t.after(() => s.close());
  const run = t.mock.method(s.app.dispatcher, "run");
  s.app.scheduler.start();
  await s.app.scheduler.stop();
  assert.equal(run.mock.callCount(), 1);
  assert.equal(deriveState(s.app, null).broker, "up");
});
