import { once } from "node:events";
import { chmodSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type {
  AccessRequest,
  AccessView,
  Attention,
  AuditEntry,
  AuditPage,
  CredentialView,
  Grant,
} from "@a12s-studio/contract/broker-admin";
import { AGENT_ID, newId, type RequestId, TEAM_SLUG, teamOf } from "@a12s-studio/contract/names";
import { audit, type GrantRow, toGrant, tx } from "./db.ts";
import { isHost, isPattern, METHODS } from "./match.ts";
import type { Vault } from "./vault.ts";

type AdminDeps = { db: DatabaseSync; vault: Vault; now: () => number };

type Params = Record<string, string>;
type Handler = (params: Params, body: unknown, query: URLSearchParams) => unknown;
type Route = { method: string; path: RegExp; run: Handler };

type CredentialRow = {
  team_id: string;
  host: string;
  scheme: CredentialView["scheme"];
  username: string | null;
  header_name: string | null;
  created_at: number;
  updated_at: number;
  rejected_at: number | null;
};

type RequestRow = {
  id: RequestId;
  team_id: string;
  agent_id: string;
  host: string;
  methods: string;
  paths: string;
  reason: string;
  days: number | null;
  status: AccessRequest["status"];
  created_at: number;
  decided_at: number | null;
};

type AuditRow = Omit<AuditEntry, "agentId" | "grantId"> & { agent_id: string | null; grant_id: Grant["id"] | null };

const MAX_BODY_BYTES = 64 * 1024;
const MAX_TEXT = 1000;
const MAX_ITEMS = 50;
const WARN_AHEAD_MS = 3 * 24 * 60 * 60 * 1000;
const AUDIT_PAGE = 50;
const AUDIT_PAGE_MAX = 200;
// Never the nonce or the ciphertext: a view is built from these columns only.
const CREDENTIAL_COLUMNS = "team_id, host, scheme, username, header_name, created_at, updated_at, rejected_at";
// Printable and on one line, so a stored value is always a legal header value.
const HEADER_VALUE = /^[ -~]+$/;
const HEADER_NAME = /^[A-Za-z0-9-]+$/;

class Refusal extends Error {
  status: number;
  code: string;
  fix: string | undefined;
  constructor(status: number, code: string, message: string, fix?: string) {
    super(message);
    this.status = status;
    this.code = code;
    this.fix = fix;
  }
}

function invalid(message: string): never {
  throw new Refusal(400, "invalid", message);
}

function missing(what: string): never {
  throw new Refusal(404, "not_found", `There is no such ${what}.`);
}

function fields(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) invalid("The body must be a JSON object.");
  return { ...body };
}

function text(value: unknown, name: string, shape: RegExp = /./s): string {
  if (typeof value !== "string" || value.length > MAX_TEXT || !shape.test(value)) invalid(`"${name}" is not valid.`);
  return value;
}

function count(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    invalid(`"${name}" must be a positive whole number.`);
  }
  return value;
}

function list(value: unknown, name: string, each: (item: string) => boolean): string[] {
  const ok = Array.isArray(value) && value.length > 0 && value.length <= MAX_ITEMS;
  if (!ok || !value.every((item) => typeof item === "string" && item.length <= MAX_TEXT && each(item))) {
    invalid(`"${name}" is not valid.`);
  }
  return value;
}

function hostName(value: unknown): string {
  if (typeof value !== "string" || !isHost(value)) {
    invalid("The host must be a plain lower-case name such as api.example.com: no scheme, port or address.");
  }
  return value;
}

function reach(body: Record<string, unknown>): { host: string; methods: string; paths: string } {
  return {
    host: hostName(body.host),
    methods: JSON.stringify(list(body.methods, "methods", (method) => METHODS.includes(method))),
    paths: JSON.stringify(list(body.paths, "paths", isPattern)),
  };
}

function toCredentialView(row: CredentialRow): CredentialView {
  return {
    host: row.host,
    scheme: row.scheme,
    username: row.username,
    headerName: row.header_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    rejectedAt: row.rejected_at,
  };
}

function toRequest(row: RequestRow): AccessRequest {
  return {
    id: row.id,
    agentId: row.agent_id,
    host: row.host,
    methods: JSON.parse(row.methods),
    paths: JSON.parse(row.paths),
    reason: row.reason,
    days: row.days,
    status: row.status,
    createdAt: row.created_at,
    decidedAt: row.decided_at,
  };
}

function toAuditEntry({ agent_id, grant_id, ...rest }: AuditRow): AuditEntry {
  return { ...rest, agentId: agent_id, grantId: grant_id };
}

function routes({ db, vault, now }: AdminDeps): Route[] {
  const all = <Row>(sql: string, ...values: SQLInputValue[]) => db.prepare(sql).all(...values) as Row[];
  const run = (sql: string, ...values: SQLInputValue[]) => Number(db.prepare(sql).run(...values).changes);
  const grant = (id: string) => all<GrantRow>("SELECT * FROM grants WHERE id = ?", id).map(toGrant)[0];
  const request = (id: string) => all<RequestRow>("SELECT * FROM requests WHERE id = ?", id).map(toRequest)[0];
  const futureOrNever = (value: unknown): number | null => {
    if (value === undefined) return null;
    const at = count(value, "expiresAt");
    if (at <= now()) invalid('"expiresAt" must be in the future.');
    return at;
  };
  const insertGrant = (teamId: string, to: ReturnType<typeof reach>, expiresAt: number | null, requestId?: string) => {
    const id = newId("g_");
    run(
      "INSERT INTO grants (id, team_id, host, methods, paths, expires_at, request_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ...[id, teamId, to.host, to.methods, to.paths, expiresAt, requestId ?? null, now()],
    );
    return id;
  };
  const pending = (teamId: string, id: string): RequestRow => {
    const [row] = all<RequestRow>("SELECT * FROM requests WHERE team_id = ? AND id = ?", teamId, id);
    if (!row) missing("request");
    if (row.status !== "pending") throw new Refusal(409, "already_decided", `This request is already ${row.status}.`);
    return row;
  };
  const decide = (row: RequestRow, status: "approved" | "denied", grantId?: string): AccessRequest => {
    run("UPDATE requests SET status = ?, decided_at = ? WHERE id = ?", status, now(), row.id);
    const action = status === "approved" ? "request.approve" : "request.deny";
    audit(db, now(), { teamId: row.team_id, agentId: row.agent_id, actor: "owner", action, host: row.host, grantId });
    return request(row.id) ?? missing("request");
  };

  const route = (method: string, pattern: string, handler: Handler): Route => ({
    method,
    path: new RegExp(`^${pattern.replace(/:(\w+)/g, "(?<$1>[^/]+)")}$`),
    // A change and its audit row commit together or not at all.
    run: (...args) => tx(db, () => handler(...args)),
  });

  return [
    route("GET", "/health", () => ({ ok: true })),

    route("GET", "/teams/:team/access", ({ team = "" }): AccessView => {
      const credentials = `SELECT ${CREDENTIAL_COLUMNS} FROM credentials WHERE team_id = ? ORDER BY host`;
      return {
        credentials: all<CredentialRow>(credentials, team).map(toCredentialView),
        grants: all<GrantRow>("SELECT * FROM grants WHERE team_id = ? ORDER BY created_at DESC, id", team).map(toGrant),
        requests: all<RequestRow>("SELECT * FROM requests WHERE team_id = ? ORDER BY created_at DESC, id", team).map(
          toRequest,
        ),
      };
    }),

    route("PUT", "/teams/:team/credentials/:host", ({ team = "", host = "" }, body): CredentialView => {
      const input = fields(body);
      hostName(host);
      const scheme = text(input.scheme, "scheme", /^(bearer|basic|header)$/);
      const username = scheme === "basic" ? text(input.username, "username", /^[!-9;-~]+$/) : null;
      const headerName = scheme === "header" ? text(input.headerName, "headerName", HEADER_NAME) : null;
      if (typeof input.secret !== "string" || !HEADER_VALUE.test(input.secret)) {
        invalid('"secret" must be one line of printable characters.');
      }
      const { nonce, secretEnc } = vault.seal(team, host, input.secret);
      run(
        `INSERT INTO credentials (team_id, host, scheme, username, header_name, nonce, secret_enc, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)
         ON CONFLICT (team_id, host) DO UPDATE SET scheme = ?3, username = ?4, header_name = ?5, nonce = ?6,
           secret_enc = ?7, updated_at = ?8, rejected_at = NULL`,
        ...[team, host, scheme, username, headerName, nonce, secretEnc, now()],
      );
      audit(db, now(), { teamId: team, actor: "owner", action: "credential.set", host, detail: scheme });
      const [row] = all<CredentialRow>(
        `SELECT ${CREDENTIAL_COLUMNS} FROM credentials WHERE team_id = ? AND host = ?`,
        team,
        host,
      );
      return row ? toCredentialView(row) : missing("credential");
    }),

    route("DELETE", "/teams/:team/credentials/:host", ({ team = "", host = "" }) => {
      if (run("DELETE FROM credentials WHERE team_id = ? AND host = ?", team, host) === 0) missing("credential");
      const revoked = run(
        "UPDATE grants SET revoked_at = ? WHERE team_id = ? AND host = ? AND revoked_at IS NULL",
        ...[now(), team, host],
      );
      const detail = `grants revoked: ${revoked}`;
      audit(db, now(), { teamId: team, actor: "owner", action: "credential.delete", host, detail });
    }),

    route("POST", "/teams/:team/grants", ({ team = "" }, body): Grant => {
      const input = fields(body);
      const to = reach(input);
      const id = insertGrant(team, to, futureOrNever(input.expiresAt));
      audit(db, now(), { teamId: team, actor: "owner", action: "grant.create", host: to.host, grantId: id });
      return grant(id) ?? missing("grant");
    }),

    route("DELETE", "/teams/:team/grants/:id", ({ team = "", id = "" }) => {
      const [row] = all<GrantRow>(
        "UPDATE grants SET revoked_at = ? WHERE team_id = ? AND id = ? AND revoked_at IS NULL RETURNING *",
        ...[now(), team, id],
      );
      if (!row) missing("grant");
      audit(db, now(), { teamId: team, actor: "owner", action: "grant.revoke", host: row.host, grantId: row.id });
    }),

    route("POST", "/teams/:team/requests", ({ team = "" }, body): AccessRequest => {
      const input = fields(body);
      const agentId = text(input.agentId, "agentId", AGENT_ID);
      // The app names the agent from the caller header; an agent of another team here means a bug in the app.
      if (teamOf(agentId) !== team) invalid('"agentId" is not an agent of this team.');
      const to = reach(input);
      const reason = text(input.reason, "reason");
      const days = input.days === undefined ? null : count(input.days, "days");
      const id = newId("rq_");
      run(
        `INSERT INTO requests (id, team_id, agent_id, host, methods, paths, reason, days, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
        ...[id, team, agentId, to.host, to.methods, to.paths, reason, days, now()],
      );
      audit(db, now(), { teamId: team, agentId, actor: "agent", action: "request.create", host: to.host, detail: id });
      return request(id) ?? missing("request");
    }),

    route("POST", "/teams/:team/requests/:id/approve", ({ team = "", id = "" }, body): AccessRequest => {
      const row = pending(team, id);
      const expiresAt = futureOrNever(fields(body ?? {}).expiresAt);
      if (all("SELECT 1 FROM credentials WHERE team_id = ? AND host = ?", team, row.host).length === 0) {
        throw new Refusal(
          409,
          "no_credential",
          `Team ${team} has no credential for ${row.host}, so a grant would give nothing.`,
          `Add a credential for ${row.host}, then approve again.`,
        );
      }
      return decide(row, "approved", insertGrant(team, row, expiresAt, row.id));
    }),

    route("POST", "/teams/:team/requests/:id/deny", ({ team = "", id = "" }): AccessRequest => {
      return decide(pending(team, id), "denied");
    }),

    route("GET", "/teams/:team/audit", ({ team = "" }, _body, query): AuditPage => {
      const before = query.has("before") ? count(Number(query.get("before")), "before") : Number.MAX_SAFE_INTEGER;
      const limit = query.has("limit") ? count(Number(query.get("limit")), "limit") : AUDIT_PAGE;
      if (limit > AUDIT_PAGE_MAX) invalid(`"limit" is at most ${AUDIT_PAGE_MAX}.`);
      const rows = all<AuditRow>(
        `SELECT id, at, agent_id, actor, action, host, method, path, status, grant_id, detail
         FROM audit WHERE team_id = ? AND id < ? ORDER BY id DESC LIMIT ?`,
        ...[team, before, limit + 1],
      );
      return { entries: rows.slice(0, limit).map(toAuditEntry), hasMore: rows.length > limit };
    }),

    route("GET", "/attention", (): Attention => {
      const withTeam = <Row extends { team_id: string }, View>(rows: Row[], view: (row: Row) => View) =>
        rows.map((row) => ({ ...view(row), teamId: row.team_id }));
      const expiring = `SELECT * FROM grants WHERE revoked_at IS NULL AND warned_at IS NULL
                        AND expires_at > ? AND expires_at <= ? ORDER BY expires_at`;
      const rejected = `SELECT ${CREDENTIAL_COLUMNS} FROM credentials WHERE rejected_at IS NOT NULL ORDER BY rejected_at`;
      return {
        requests: withTeam(
          all<RequestRow>("SELECT * FROM requests WHERE status = 'pending' ORDER BY created_at, id"),
          toRequest,
        ),
        expiring: withTeam(all<GrantRow>(expiring, now(), now() + WARN_AHEAD_MS), toGrant),
        rejected: withTeam(all<CredentialRow>(rejected), toCredentialView),
      };
    }),

    // Not audited: it records that the app passed a warning on, which changes no one's access.
    route("POST", "/grants/:id/warned", ({ id = "" }) => {
      if (run("UPDATE grants SET warned_at = ? WHERE id = ?", now(), id) === 0) missing("grant");
    }),

    route("DELETE", "/teams/:team", ({ team = "" }) => {
      const removed = ["credentials", "grants", "requests"].map(
        (table) => `${table}: ${run(`DELETE FROM ${table} WHERE team_id = ?`, team)}`,
      );
      audit(db, now(), { teamId: team, actor: "owner", action: "team.purge", detail: removed.join(", ") });
    }),
  ];
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  let raw = "";
  for await (const chunk of req.setEncoding("utf8")) {
    raw += chunk;
    if (raw.length > MAX_BODY_BYTES) invalid("The body is too large.");
  }
  if (raw === "") return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    invalid("The body is not JSON.");
  }
}

// File permissions are the authentication: the socket is the owner's alone, inside the owner-only data folder.
export async function listenAdmin(deps: AdminDeps, socketPath: string): Promise<Server> {
  const table = routes(deps);
  const respond = async (req: IncomingMessage): Promise<unknown> => {
    const url = new URL(req.url ?? "", "http://admin");
    for (const { method, path, run } of table) {
      const found = method === req.method ? path.exec(url.pathname) : null;
      if (!found) continue;
      const params = found.groups ?? {};
      if (params.team !== undefined && !TEAM_SLUG.test(params.team)) invalid("The team is not a team slug.");
      return run(params, await readJson(req), url.searchParams);
    }
    throw new Refusal(404, "not_found", `There is no ${req.method} ${url.pathname}.`);
  };
  const server = createServer((req, res) => {
    const send = (status: number, body: unknown) =>
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    respond(req).then(
      (body) => (body === undefined ? res.writeHead(204).end() : send(200, body)),
      (error) => {
        if (error instanceof Refusal)
          return send(error.status, { code: error.code, message: error.message, fix: error.fix });
        console.error(error);
        send(500, { code: "internal", message: "The broker hit an unexpected error." });
      },
    );
  });
  // A socket file left by a previous run would make listen fail.
  rmSync(socketPath, { force: true });
  server.listen(socketPath);
  await once(server, "listening");
  chmodSync(socketPath, 0o600);
  return server;
}
