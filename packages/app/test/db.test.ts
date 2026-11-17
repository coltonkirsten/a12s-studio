import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { migrations, openDb, tx } from "../src/db.ts";
import { createRepo } from "../src/repo.ts";
import { boardStatus } from "../src/router.ts";

test("migrations apply to a new file and re-apply as a no-op", () => {
  const file = join(mkdtempSync(join(tmpdir(), "studio-db-")), "studio.db");
  const first = openDb(file);
  assert.equal(first.prepare("PRAGMA journal_mode").get()?.journal_mode, "wal");
  assert.equal(first.prepare("PRAGMA foreign_keys").get()?.foreign_keys, 1);
  first.close();

  const again = openDb(file);
  assert.equal(again.prepare("PRAGMA user_version").get()?.user_version, migrations.length);
  const settings = again.prepare("SELECT key, value FROM settings ORDER BY key").all();
  assert.equal(settings.length, 7);
  assert.deepEqual({ ...settings[0] }, { key: "awake_cap", value: "4" });
  again.close();
});

test("a transaction that throws leaves nothing behind", () => {
  const db = openDb(":memory:");
  const write = () => db.exec("UPDATE settings SET value = '9' WHERE key = 'awake_cap'");
  assert.throws(() =>
    tx(db, () => {
      write();
      throw new Error("stop");
    }),
  );
  assert.equal(db.prepare("SELECT value FROM settings WHERE key = 'awake_cap'").get()?.value, "4");
  tx(db, write);
  assert.equal(db.prepare("SELECT value FROM settings WHERE key = 'awake_cap'").get()?.value, "9");
  // @ts-expect-error an async function would commit before its awaited work ran
  tx(db, async () => {});
});

test("migration 2 turns asks, replies and notes into one kind of message and keeps who needs the owner", () => {
  const file = join(mkdtempSync(join(tmpdir(), "studio-db-")), "studio.db");
  // The tables migration 2 and the reads below touch, as migration 1 made them (turns with only what is read).
  const old = new DatabaseSync(file);
  old.exec(`
    CREATE TABLE teams (id TEXT PRIMARY KEY) STRICT;
    CREATE TABLE agents (
      id TEXT PRIMARY KEY, team_id TEXT NOT NULL REFERENCES teams(id), role TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL DEFAULT 0) STRICT;
    CREATE TABLE threads (
      id TEXT PRIMARY KEY, team_id TEXT NOT NULL REFERENCES teams(id), title TEXT NOT NULL,
      owner_agent_id TEXT NOT NULL REFERENCES agents(id), status TEXT NOT NULL CHECK (status IN ('open','done')),
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL) STRICT;
    CREATE TABLE messages (
      id TEXT PRIMARY KEY, team_id TEXT NOT NULL REFERENCES teams(id), thread_id TEXT REFERENCES threads(id),
      kind TEXT NOT NULL CHECK (kind IN ('ask','reply','note')), from_id TEXT NOT NULL, to_id TEXT,
      ask_id TEXT REFERENCES messages(id), body TEXT NOT NULL, file_name TEXT, implicit INTEGER NOT NULL DEFAULT 0,
      delivery TEXT NOT NULL CHECK (delivery IN ('none','queued','sent','delivered')), a12s_message_id TEXT,
      created_at INTEGER NOT NULL, delivered_at INTEGER) STRICT;
    CREATE TABLE turns (id TEXT PRIMARY KEY, team_id TEXT NOT NULL, thread_id TEXT, cost_usd REAL NOT NULL) STRICT;
    CREATE UNIQUE INDEX messages_one_reply ON messages (ask_id) WHERE kind = 'reply';
    INSERT INTO teams VALUES ('web');
    INSERT INTO agents (id, team_id) VALUES ('web-lead', 'web'), ('web-dev', 'web');
    INSERT INTO threads VALUES ('th_open', 'web', 'Waiting', 'web-lead', 'open', 1, 1),
      ('th_answered', 'web', 'Answered', 'web-lead', 'open', 1, 1);
    INSERT INTO messages (id, team_id, thread_id, kind, from_id, to_id, ask_id, body, delivery, created_at) VALUES
      ('m_ask', 'web', 'th_open', 'ask', 'web-lead', 'owner', NULL, 'Blue or green?', 'none', 100),
      ('m_note', 'web', 'th_open', 'note', 'web-lead', 'owner', NULL, 'Also this.', 'none', 110),
      ('m_done', 'web', 'th_answered', 'ask', 'web-lead', 'owner', NULL, 'Ship it?', 'none', 100),
      ('m_reply', 'web', 'th_answered', 'reply', 'owner', 'web-lead', 'm_done', 'Yes.', 'delivered', 120),
      ('m_queued', 'web', 'th_answered', 'note', 'web-lead', 'web-dev', NULL, 'Staging is up.', 'queued', 130);
    PRAGMA user_version = 1;
  `);
  old.close();

  const db = openDb(file);
  assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, migrations.length);
  assert.equal(db.prepare("PRAGMA foreign_keys").get()?.foreign_keys, 1);
  const columns = db
    .prepare("SELECT name FROM pragma_table_info('messages')")
    .all()
    .map((c) => c.name);
  for (const gone of ["kind", "ask_id", "implicit"]) assert.ok(!columns.includes(gone), gone);
  assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'messages_one_reply'").get(), undefined);
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'messages_turn'").get());

  const repo = createRepo(db).forTeam("web");
  assert.deepEqual([repo.message("m_reply")?.causeId, repo.message("m_reply")?.depth], ["m_done", 1]);
  assert.deepEqual([repo.message("m_ask")?.causeId, repo.message("m_ask")?.depth], [null, 0]);
  const board = new Map(repo.board({ status: "all", limit: 10 }).map((t) => [t.id, boardStatus(t)]));
  assert.equal(board.get("th_open"), "needs_you", "the unanswered ask still needs the owner, with what came after");
  assert.equal(repo.board({ status: "all", limit: 10 }).find((t) => t.id === "th_open")?.forOwner, 2);
  assert.equal(board.get("th_answered"), "open");
  assert.deepEqual([...repo.dispatchable().keys()], ["web-dev"], "a queued note is now a message to deliver");
  db.close();
});

test("migration 3 keeps every role as a first version by the owner, and the role column goes", () => {
  const file = join(mkdtempSync(join(tmpdir(), "studio-db-")), "studio.db");
  const old = new DatabaseSync(file);
  for (const sql of migrations.slice(0, 2)) old.exec(sql);
  old.exec(`
    PRAGMA user_version = 2;
    INSERT INTO teams (id, name, purpose, accent, daily_budget_usd, a12s_token, created_at)
      VALUES ('web', 'Web', 'p', '#000000', 25, 't', 1);
    INSERT INTO agents (id, team_id, slug, role, model, sleep_after_idle, compact_min_tokens, created_at, removed_at)
      VALUES ('web-lead', 'web', 'lead', 'Plans.', 'sonnet', '15m', 0, 10, NULL),
             ('web-dev', 'web', 'dev', 'Codes.\nTests.', 'sonnet', '15m', 0, 20, NULL),
             ('web-qa', 'web', 'qa', 'Tested.', 'sonnet', '15m', 0, 30, 40);
  `);
  old.close();

  const db = openDb(file);
  assert.deepEqual(
    db
      .prepare("SELECT team_id, agent_id, body, author, created_at FROM rules ORDER BY id")
      .all()
      .map((row) => ({ ...row })),
    [
      { team_id: "web", agent_id: "web-lead", body: "Plans.", author: "owner", created_at: 10 },
      { team_id: "web", agent_id: "web-dev", body: "Codes.\nTests.", author: "owner", created_at: 20 },
      { team_id: "web", agent_id: "web-qa", body: "Tested.", author: "owner", created_at: 30 },
    ],
  );
  const columns = db.prepare("SELECT name FROM pragma_table_info('agents')").all();
  assert.ok(!columns.some((c) => c.name === "role"));
  db.close();
});

test("migration 4 gives every message a receiver, and no thread newly needs the owner", () => {
  const file = join(mkdtempSync(join(tmpdir(), "studio-db-")), "studio.db");
  const old = new DatabaseSync(file);
  for (const sql of migrations.slice(0, 3)) old.exec(sql);
  old.exec(`
    PRAGMA user_version = 3;
    INSERT INTO teams (id, name, purpose, accent, daily_budget_usd, a12s_token, created_at)
      VALUES ('web', 'Web', 'p', '#000000', 25, 't', 1);
    INSERT INTO agents (id, team_id, slug, model, sleep_after_idle, compact_min_tokens, created_at)
      VALUES ('web-lead', 'web', 'lead', 'sonnet', '15m', 0, 10), ('web-dev', 'web', 'dev', 'sonnet', '15m', 0, 20);
    INSERT INTO threads (id, team_id, title, owner_agent_id, status, owner_seen_at, created_at, updated_at) VALUES
      ('th_quiet', 'web', 'Quiet', 'web-lead', 'open', 50, 1, 1),
      ('th_waiting', 'web', 'Waiting', 'web-lead', 'open', 50, 1, 1);
    INSERT INTO messages (id, team_id, thread_id, from_id, to_id, body, cause_id, depth, delivery, created_at) VALUES
      ('m_seen', 'web', 'th_quiet', 'web-lead', 'owner', 'Done.', NULL, 0, 'none', 40),
      ('m_record', 'web', 'th_quiet', 'web-dev', NULL, 'Staging is rebuilt.', 'm_seen', 1, 'none', 60),
      ('m_ask', 'web', 'th_waiting', 'web-lead', 'owner', 'Blue or green?', NULL, 0, 'none', 70),
      ('m_progress', 'web', 'th_waiting', 'web-lead', NULL, 'Still waiting.', NULL, 0, 'none', 80),
      ('m_sent', 'web', 'th_waiting', 'web-lead', 'web-dev', 'Hold on.', NULL, 0, 'queued', 90);
  `);
  old.close();

  const db = openDb(file);
  assert.equal(db.prepare("PRAGMA foreign_keys").get()?.foreign_keys, 1);
  assert.throws(
    () =>
      db.exec(
        "INSERT INTO messages (id, team_id, from_id, body, delivery, created_at) VALUES ('m', 'web', 'system', 'b', 'none', 1)",
      ),
    /NOT NULL/,
  );
  const repo = createRepo(db).forTeam("web");
  assert.deepEqual(
    ["m_seen", "m_record", "m_ask", "m_progress", "m_sent"].map((id) => repo.message(id)?.toId),
    ["owner", "owner", "owner", "owner", "web-dev"],
  );
  assert.deepEqual([repo.message("m_record")?.causeId, repo.message("m_record")?.depth], ["m_seen", 1]);
  const board = new Map(repo.board({ status: "all", limit: 10 }).map((t) => [t.id, boardStatus(t)]));
  assert.equal(board.get("th_quiet"), "open", "what was written to nobody asks for nobody now");
  assert.equal(board.get("th_waiting"), "needs_you");
  assert.deepEqual([...repo.dispatchable().keys()], ["web-dev"]);
  db.close();
});
