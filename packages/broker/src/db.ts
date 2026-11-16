import { DatabaseSync } from "node:sqlite";
import type { AuditAction, AuditActor, Grant } from "@a12s-studio/contract/broker-admin";
import type { GrantId, RequestId } from "@a12s-studio/contract/names";

const migrations: string[] = [
  `
  CREATE TABLE credentials (
    team_id TEXT NOT NULL, host TEXT NOT NULL,
    scheme TEXT NOT NULL CHECK (scheme IN ('bearer','basic','header')),
    username TEXT CHECK ((username IS NOT NULL) = (scheme = 'basic')),
    header_name TEXT CHECK ((header_name IS NOT NULL) = (scheme = 'header')),
    nonce BLOB NOT NULL, secret_enc BLOB NOT NULL,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    rejected_at INTEGER,
    PRIMARY KEY (team_id, host)
  ) STRICT;

  CREATE TABLE grants (
    id TEXT PRIMARY KEY,
    team_id TEXT NOT NULL, host TEXT NOT NULL,
    methods TEXT NOT NULL,
    paths TEXT NOT NULL,
    expires_at INTEGER,
    request_id TEXT,
    created_at INTEGER NOT NULL, warned_at INTEGER, revoked_at INTEGER, expired_at INTEGER
  ) STRICT;
  CREATE INDEX grants_match ON grants (team_id, host);

  CREATE TABLE requests (
    id TEXT PRIMARY KEY,
    team_id TEXT NOT NULL, agent_id TEXT NOT NULL, host TEXT NOT NULL,
    methods TEXT NOT NULL, paths TEXT NOT NULL, reason TEXT NOT NULL, days INTEGER,
    status TEXT NOT NULL CHECK (status IN ('pending','approved','denied')),
    created_at INTEGER NOT NULL, decided_at INTEGER
  ) STRICT;
  CREATE INDEX requests_pending ON requests (status, team_id);

  CREATE TABLE audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL, team_id TEXT NOT NULL, agent_id TEXT,
    actor TEXT NOT NULL CHECK (actor IN ('agent','owner','broker')),
    action TEXT NOT NULL,
    host TEXT, method TEXT, path TEXT,
    status INTEGER, grant_id TEXT, detail TEXT
  ) STRICT;
  CREATE INDEX audit_team ON audit (team_id, id DESC);
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

type AuditFields = {
  teamId: string;
  actor: AuditActor;
  action: AuditAction;
  agentId?: string;
  host?: string;
  method?: string;
  path?: string;
  status?: number;
  grantId?: string;
  detail?: string;
};

export function audit(db: DatabaseSync, at: number, row: AuditFields): void {
  db.prepare(
    `INSERT INTO audit (at, team_id, agent_id, actor, action, host, method, path, status, grant_id, detail)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    at,
    row.teamId,
    row.agentId ?? null,
    row.actor,
    row.action,
    row.host ?? null,
    row.method ?? null,
    row.path ?? null,
    row.status ?? null,
    row.grantId ?? null,
    row.detail ?? null,
  );
}

export type GrantRow = {
  id: GrantId;
  team_id: string;
  host: string;
  methods: string;
  paths: string;
  expires_at: number | null;
  request_id: RequestId | null;
  created_at: number;
  warned_at: number | null;
  revoked_at: number | null;
  expired_at: number | null;
};

export function toGrant(row: GrantRow): Grant {
  return {
    id: row.id,
    host: row.host,
    methods: JSON.parse(row.methods),
    paths: JSON.parse(row.paths),
    expiresAt: row.expires_at,
    requestId: row.request_id,
    createdAt: row.created_at,
    warnedAt: row.warned_at,
    revokedAt: row.revoked_at,
    expiredAt: row.expired_at,
  };
}
