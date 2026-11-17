import { DatabaseSync } from "node:sqlite";

export const migrations: string[] = [
  `
  CREATE TABLE settings (
    key TEXT PRIMARY KEY, value TEXT NOT NULL
  ) STRICT;
  INSERT INTO settings (key, value) VALUES
    ('awake_cap', '4'),
    ('default_daily_budget_usd', '25'),
    ('min_free_disk_gb', '15'),
    ('paused', 'false'),
    ('default_model', '"sonnet"'),
    ('default_sleep_after_idle', '"15m"'),
    ('default_compact_min_tokens', '100000');

  CREATE TABLE teams (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL, purpose TEXT NOT NULL, accent TEXT NOT NULL,
    lead_agent_id TEXT,
    daily_budget_usd REAL NOT NULL,
    paused INTEGER NOT NULL DEFAULT 0,
    a12s_token TEXT NOT NULL,
    created_at INTEGER NOT NULL, deleted_at INTEGER
  ) STRICT;

  CREATE TABLE agents (
    id TEXT PRIMARY KEY,
    team_id TEXT NOT NULL REFERENCES teams(id),
    slug TEXT NOT NULL, role TEXT NOT NULL, model TEXT NOT NULL,
    sleep_after_idle TEXT NOT NULL, compact_min_tokens INTEGER NOT NULL,
    cpu REAL, memory TEXT,
    created_at INTEGER NOT NULL, removed_at INTEGER,
    UNIQUE (team_id, slug)
  ) STRICT;

  CREATE TABLE threads (
    id TEXT PRIMARY KEY,
    team_id TEXT NOT NULL REFERENCES teams(id),
    title TEXT NOT NULL,
    owner_agent_id TEXT NOT NULL REFERENCES agents(id),
    status TEXT NOT NULL CHECK (status IN ('open','done')),
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX threads_board ON threads (team_id, status, updated_at DESC);

  CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    team_id TEXT NOT NULL REFERENCES teams(id),
    thread_id TEXT REFERENCES threads(id),
    kind TEXT NOT NULL CHECK (kind IN ('ask','reply','note')),
    from_id TEXT NOT NULL,
    to_id TEXT,
    ask_id TEXT REFERENCES messages(id),
    body TEXT NOT NULL,
    file_name TEXT,
    implicit INTEGER NOT NULL DEFAULT 0,
    delivery TEXT NOT NULL CHECK (delivery IN ('none','queued','sent','delivered')),
    a12s_message_id TEXT,
    created_at INTEGER NOT NULL, delivered_at INTEGER
  ) STRICT;
  CREATE INDEX messages_thread ON messages (thread_id, created_at);
  CREATE INDEX messages_queue ON messages (to_id, delivery, created_at);
  CREATE UNIQUE INDEX messages_one_reply ON messages (ask_id) WHERE kind = 'reply';
  CREATE INDEX messages_a12s ON messages (a12s_message_id);

  CREATE TABLE wakes (
    id TEXT PRIMARY KEY,
    team_id TEXT NOT NULL REFERENCES teams(id),
    agent_id TEXT NOT NULL REFERENCES agents(id),
    thread_id TEXT REFERENCES threads(id),
    note TEXT NOT NULL,
    due_at INTEGER NOT NULL,
    repeat_seconds INTEGER CHECK (repeat_seconds IS NULL OR repeat_seconds >= 3600),
    created_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX wakes_due ON wakes (due_at);

  CREATE TABLE turns (
    id TEXT PRIMARY KEY,
    team_id TEXT NOT NULL REFERENCES teams(id),
    agent_id TEXT NOT NULL REFERENCES agents(id),
    thread_id TEXT REFERENCES threads(id),
    session TEXT,
    status TEXT NOT NULL,
    error TEXT,
    started_at INTEGER, finished_at INTEGER NOT NULL,
    tokens_in INTEGER, tokens_out INTEGER, tokens_cache_read INTEGER, tokens_cache_write INTEGER,
    model_costs TEXT NOT NULL DEFAULT '{}',
    cost_usd REAL NOT NULL DEFAULT 0,
    acked_at INTEGER
  ) STRICT;
  CREATE INDEX turns_spend ON turns (team_id, finished_at);
  CREATE INDEX turns_agent ON turns (agent_id, finished_at DESC);
  `,
  // One kind of message, and the chain record. A thread still needs the owner where an ask to them had no reply.
  // messages is rebuilt, not altered: kind has a CHECK and ask_id a reference, which DROP COLUMN cannot remove.
  `
  ALTER TABLE threads ADD COLUMN owner_seen_at INTEGER NOT NULL DEFAULT 0;
  UPDATE threads SET owner_seen_at = coalesce(
    (SELECT min(a.created_at) - 1 FROM messages a WHERE a.thread_id = threads.id AND a.to_id = 'owner'
       AND a.kind = 'ask' AND NOT EXISTS (SELECT 1 FROM messages r WHERE r.ask_id = a.id AND r.kind = 'reply')),
    CAST(unixepoch('subsec') * 1000 AS INTEGER));

  CREATE TABLE messages_new (
    id TEXT PRIMARY KEY,
    team_id TEXT NOT NULL REFERENCES teams(id),
    thread_id TEXT REFERENCES threads(id),
    from_id TEXT NOT NULL,
    to_id TEXT,
    body TEXT NOT NULL,
    file_name TEXT,
    cause_id TEXT REFERENCES messages(id),
    depth INTEGER NOT NULL DEFAULT 0,
    delivery TEXT NOT NULL CHECK (delivery IN ('none','queued','sent','delivered')),
    a12s_message_id TEXT,
    turn_id TEXT,
    steered INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL, delivered_at INTEGER
  ) STRICT;
  INSERT INTO messages_new (id, team_id, thread_id, from_id, to_id, body, file_name, cause_id, depth, delivery,
      a12s_message_id, created_at, delivered_at)
    SELECT id, team_id, thread_id, from_id, to_id, body, file_name, ask_id, ask_id IS NOT NULL, delivery,
      a12s_message_id, created_at, delivered_at FROM messages ORDER BY rowid;
  DROP TABLE messages;
  ALTER TABLE messages_new RENAME TO messages;
  CREATE INDEX messages_thread ON messages (thread_id, created_at);
  CREATE INDEX messages_queue ON messages (to_id, delivery, created_at);
  CREATE INDEX messages_a12s ON messages (a12s_message_id);
  CREATE INDEX messages_turn ON messages (turn_id);
  `,
  `
  CREATE TABLE rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    team_id TEXT REFERENCES teams(id),
    agent_id TEXT REFERENCES agents(id),
    body TEXT NOT NULL,
    author TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    CHECK (agent_id IS NULL OR team_id IS NOT NULL)
  ) STRICT;
  CREATE INDEX rules_scope ON rules (team_id, agent_id, id DESC);
  INSERT INTO rules (team_id, agent_id, body, author, created_at)
    SELECT team_id, id, role, 'owner', created_at FROM agents ORDER BY created_at, rowid;
  ALTER TABLE agents DROP COLUMN role;
  `,
  // Every message names its receiver. One written to nobody was there for the owner to read, so it becomes a message
  // to them, counted as read in a thread that did not need them. messages is rebuilt: ALTER cannot add NOT NULL.
  `
  UPDATE threads SET owner_seen_at = max(owner_seen_at,
      (SELECT max(r.created_at) FROM messages r WHERE r.thread_id = threads.id AND r.to_id IS NULL))
    WHERE EXISTS (SELECT 1 FROM messages r WHERE r.thread_id = threads.id AND r.to_id IS NULL)
      AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.thread_id = threads.id AND m.to_id = 'owner'
        AND m.created_at > threads.owner_seen_at);

  CREATE TABLE messages_new (
    id TEXT PRIMARY KEY,
    team_id TEXT NOT NULL REFERENCES teams(id),
    thread_id TEXT REFERENCES threads(id),
    from_id TEXT NOT NULL,
    to_id TEXT NOT NULL,
    body TEXT NOT NULL,
    file_name TEXT,
    cause_id TEXT REFERENCES messages(id),
    depth INTEGER NOT NULL DEFAULT 0,
    delivery TEXT NOT NULL CHECK (delivery IN ('none','queued','sent','delivered')),
    a12s_message_id TEXT,
    turn_id TEXT,
    steered INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL, delivered_at INTEGER
  ) STRICT;
  INSERT INTO messages_new
    SELECT id, team_id, thread_id, from_id, coalesce(to_id, 'owner'), body, file_name, cause_id, depth, delivery,
      a12s_message_id, turn_id, steered, created_at, delivered_at FROM messages ORDER BY rowid;
  DROP TABLE messages;
  ALTER TABLE messages_new RENAME TO messages;
  CREATE INDEX messages_thread ON messages (thread_id, created_at);
  CREATE INDEX messages_queue ON messages (to_id, delivery, created_at);
  CREATE INDEX messages_a12s ON messages (a12s_message_id);
  CREATE INDEX messages_turn ON messages (turn_id);
  `,
];

// Migrations run with foreign keys off, as SQLite's procedure for rebuilding a table requires (dropping the old table
// would otherwise delete through its references); each checks them before it commits.
export function openDb(file: string): DatabaseSync {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = OFF;");
  const row = db.prepare("PRAGMA user_version").get();
  const applied = Number(row?.user_version ?? 0);
  migrations.slice(applied).forEach((sql, i) => {
    tx(db, () => {
      db.exec(sql);
      const broken = db.prepare("PRAGMA foreign_key_check").get();
      if (broken) throw new Error(`migration ${applied + i + 1} breaks a reference: ${JSON.stringify(broken)}`);
      db.exec(`PRAGMA user_version = ${applied + i + 1}`);
    });
  });
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

// An async fn would commit before its awaited work ran, so the type refuses a Promise.
export function tx<T>(db: DatabaseSync, fn: () => T extends Promise<unknown> ? never : T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
