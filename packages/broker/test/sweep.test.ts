import assert from "node:assert/strict";
import { test } from "node:test";
import { audit, openDb } from "../src/db.ts";
import { sweep } from "../src/sweep.ts";

test("the sweep stamps and audits each grant past its expiry once, and leaves the rest alone", () => {
  const db = openDb(":memory:");
  const insert = db.prepare(
    `INSERT INTO grants (id, team_id, host, methods, paths, expires_at, revoked_at, created_at)
     VALUES (?, 'web', 'api.example.com', '["GET"]', '["/v1/items"]', ?, ?, 0)`,
  );
  insert.run("g_past", 1000, null);
  insert.run("g_now", 2000, null);
  insert.run("g_later", 2001, null);
  insert.run("g_never", null, null);
  insert.run("g_revoked", 1000, 500);

  sweep(db, 2000);
  sweep(db, 2000);

  const stamped = db.prepare("SELECT id, expired_at FROM grants WHERE expired_at IS NOT NULL ORDER BY id").all();
  assert.deepEqual(
    stamped.map((row) => ({ ...row })),
    [
      { id: "g_now", expired_at: 2000 },
      { id: "g_past", expired_at: 2000 },
    ],
  );
  const rows = db.prepare("SELECT at, team_id, actor, action, host, grant_id FROM audit ORDER BY grant_id").all();
  assert.deepEqual(
    rows.map((row) => ({ ...row })),
    [
      { at: 2000, team_id: "web", actor: "broker", action: "grant.expire", host: "api.example.com", grant_id: "g_now" },
      {
        at: 2000,
        team_id: "web",
        actor: "broker",
        action: "grant.expire",
        host: "api.example.com",
        grant_id: "g_past",
      },
    ],
  );
});

test("the audit table refuses an actor it does not know", () => {
  const db = openDb(":memory:");
  // @ts-expect-error only agent, owner and broker act
  assert.throws(() => audit(db, 0, { teamId: "web", actor: "someone", action: "call" }));
});
