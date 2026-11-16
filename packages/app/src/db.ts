import { DatabaseSync } from "node:sqlite";

const migrations: string[] = [
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
];

export function openDb(file: string): DatabaseSync {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  const row = db.prepare("PRAGMA user_version").get();
  const applied = Number(row?.user_version ?? 0);
  migrations.slice(applied).forEach((sql, i) => {
    tx(db, () => {
      db.exec(sql);
      db.exec(`PRAGMA user_version = ${applied + i + 1}`);
    });
  });
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
