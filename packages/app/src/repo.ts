import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { type MessageId, newId, type ThreadId } from "@a12s-studio/contract/names";
import type { MessageKind, Settings, ThreadStatus } from "@a12s-studio/contract/state";
import { tx } from "./db.ts";

export type Team = {
  id: string;
  name: string;
  purpose: string;
  accent: string;
  leadAgentId: string | null;
  dailyBudgetUsd: number;
  paused: boolean;
  a12sToken: string;
  createdAt: number;
};

export type Agent = {
  id: string;
  teamId: string;
  slug: string;
  role: string;
  model: string;
  sleepAfterIdle: string;
  compactMinTokens: number;
  cpu: number | null;
  memory: string | null;
  createdAt: number;
};

export type Thread = {
  id: ThreadId;
  teamId: string;
  title: string;
  ownerAgentId: string;
  status: ThreadStatus;
  createdAt: number;
  updatedAt: number;
};

type Delivery = "none" | "queued" | "sent" | "delivered";

export type Message = {
  id: MessageId;
  teamId: string;
  threadId: ThreadId | null;
  kind: MessageKind;
  fromId: string;
  toId: string | null;
  askId: MessageId | null;
  body: string;
  fileName: string | null;
  implicit: boolean;
  delivery: Delivery;
  a12sMessageId: string | null;
  createdAt: number;
  deliveredAt: number | null;
};

export type NewMessage = Pick<Message, "threadId" | "kind" | "fromId" | "toId" | "askId" | "body"> & {
  implicit?: boolean;
};

export type BoardRow = Thread & {
  asksForOwner: number;
  asksForViewer: number;
  last: { fromId: string; body: string } | null;
};

const SETTING_KEYS = {
  awakeCap: "awake_cap",
  defaultDailyBudgetUsd: "default_daily_budget_usd",
  minFreeDiskGb: "min_free_disk_gb",
  paused: "paused",
  defaultModel: "default_model",
  defaultSleepAfterIdle: "default_sleep_after_idle",
  defaultCompactMinTokens: "default_compact_min_tokens",
} as const satisfies Record<keyof Settings, string>;

const TEAM = `id, name, purpose, accent, lead_agent_id AS leadAgentId, daily_budget_usd AS dailyBudgetUsd,
  paused, a12s_token AS a12sToken, created_at AS createdAt`;
const AGENT = `id, team_id AS teamId, slug, role, model, sleep_after_idle AS sleepAfterIdle,
  compact_min_tokens AS compactMinTokens, cpu, memory, created_at AS createdAt`;
const THREAD = `id, team_id AS teamId, title, owner_agent_id AS ownerAgentId, status, created_at AS createdAt,
  updated_at AS updatedAt`;
const MESSAGE = `id, team_id AS teamId, thread_id AS threadId, kind, from_id AS fromId, to_id AS toId,
  ask_id AS askId, body, file_name AS fileName, implicit, delivery, a12s_message_id AS a12sMessageId,
  created_at AS createdAt, delivered_at AS deliveredAt`;
// An ask with no reply yet; `a` is the ask's alias.
const UNANSWERED =
  "a.kind = 'ask' AND NOT EXISTS (SELECT 1 FROM messages r WHERE r.ask_id = a.id AND r.kind = 'reply')";

type Row = Record<string, unknown>;

const toTeam = (row: Row): Team => ({ ...(row as Team), paused: row.paused === 1 });
const toMessage = (row: Row): Message => ({ ...(row as Message), implicit: row.implicit === 1 });

export type Repo = ReturnType<typeof createRepo>;
export type TeamRepo = ReturnType<Repo["forTeam"]>;

export function createRepo(db: DatabaseSync) {
  const one = (sql: string, ...params: SQLInputValue[]): Row | undefined => db.prepare(sql).get(...params);
  const all = (sql: string, ...params: SQLInputValue[]): Row[] => db.prepare(sql).all(...params);
  const run = (sql: string, ...params: SQLInputValue[]): number => Number(db.prepare(sql).run(...params).changes);

  // Every read and write here binds team_id, so an id from another team finds nothing, exactly like an id that
  // does not exist.
  function forTeam(teamId: string) {
    const agent = (id: string): Agent | undefined =>
      one(`SELECT ${AGENT} FROM agents WHERE team_id = ? AND id = ? AND removed_at IS NULL`, teamId, id) as
        | Agent
        | undefined;

    return {
      tx: <T>(fn: () => T extends Promise<unknown> ? never : T): T => tx(db, fn),

      team(): Team | undefined {
        const row = one(`SELECT ${TEAM} FROM teams WHERE id = ? AND deleted_at IS NULL`, teamId);
        return row && toTeam(row);
      },
      setPaused(paused: boolean): void {
        run("UPDATE teams SET paused = ? WHERE id = ?", paused ? 1 : 0, teamId);
      },
      markDeleted(at: number): void {
        run("UPDATE teams SET deleted_at = ? WHERE id = ?", at, teamId);
      },

      agents(): Agent[] {
        return all(
          `SELECT ${AGENT} FROM agents WHERE team_id = ? AND removed_at IS NULL ORDER BY created_at, rowid`,
          teamId,
        ) as Agent[];
      },
      agent,
      agentBySlug(slug: string): Agent | undefined {
        return agent(`${teamId}-${slug}`);
      },
      // Removed agents count: a12s keeps a removed agent computer's drive and inbox under its name.
      slugUsed(slug: string): boolean {
        return one("SELECT 1 FROM agents WHERE team_id = ? AND slug = ?", teamId, slug) !== undefined;
      },
      insertAgent(a: Agent): void {
        run(
          `INSERT INTO agents (id, team_id, slug, role, model, sleep_after_idle, compact_min_tokens, cpu, memory,
             created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          a.id,
          teamId,
          a.slug,
          a.role,
          a.model,
          a.sleepAfterIdle,
          a.compactMinTokens,
          a.cpu,
          a.memory,
          a.createdAt,
        );
      },
      removeAgent(id: string, at: number): void {
        run("UPDATE agents SET removed_at = ? WHERE team_id = ? AND id = ?", at, teamId, id);
        run("DELETE FROM wakes WHERE team_id = ? AND agent_id = ?", teamId, id);
        run(
          "UPDATE messages SET delivery = 'none' WHERE team_id = ? AND to_id = ? AND delivery = 'queued'",
          teamId,
          id,
        );
      },

      thread(id: string): Thread | undefined {
        return one(`SELECT ${THREAD} FROM threads WHERE team_id = ? AND id = ?`, teamId, id) as Thread | undefined;
      },
      insertThread(title: string, ownerAgentId: string, at: number): ThreadId {
        const id = newId("th_");
        run(
          `INSERT INTO threads (id, team_id, title, owner_agent_id, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'open', ?, ?)`,
          id,
          teamId,
          title,
          ownerAgentId,
          at,
          at,
        );
        return id;
      },
      updateThread(
        id: string,
        patch: { status?: ThreadStatus; title?: string; ownerAgentId?: string },
        at: number,
      ): void {
        run(
          `UPDATE threads SET status = coalesce(?, status), title = coalesce(?, title),
             owner_agent_id = coalesce(?, owner_agent_id), updated_at = ? WHERE team_id = ? AND id = ?`,
          patch.status ?? null,
          patch.title ?? null,
          patch.ownerAgentId ?? null,
          at,
          teamId,
          id,
        );
      },
      // `before` is a thread id: the page continues after it in board order.
      board(q: { status: ThreadStatus | "all"; limit: number; before?: string; viewer: string }): BoardRow[] {
        const asks = (to: string) =>
          `(SELECT count(*) FROM messages a WHERE a.thread_id = t.id AND a.to_id = ${to} AND ${UNANSWERED})`;
        const last = (column: string) =>
          `(SELECT ${column} FROM messages m WHERE m.thread_id = t.id ORDER BY m.created_at DESC, m.rowid DESC LIMIT 1)`;
        const rows = all(
          `SELECT ${THREAD}, ${asks("'owner'")} AS asksForOwner, ${asks("?")} AS asksForViewer,
             ${last("from_id")} AS lastFrom, ${last("body")} AS lastBody
           FROM threads t WHERE team_id = ? AND (? = 'all' OR status = ?)
             AND (? IS NULL OR (updated_at, id) < (SELECT updated_at, id FROM threads WHERE team_id = ? AND id = ?))
           ORDER BY updated_at DESC, id DESC LIMIT ?`,
          q.viewer,
          teamId,
          q.status,
          q.status,
          q.before ?? null,
          teamId,
          q.before ?? null,
          q.limit,
        );
        return rows.map(({ lastFrom, lastBody, ...row }) => ({
          ...(row as Omit<BoardRow, "last">),
          last: typeof lastFrom === "string" ? { fromId: lastFrom, body: String(lastBody) } : null,
        }));
      },

      message(id: string): Message | undefined {
        const row = one(`SELECT ${MESSAGE} FROM messages WHERE team_id = ? AND id = ?`, teamId, id);
        return row && toMessage(row);
      },
      // `before` is a message id; the newest `limit` messages before it, oldest first.
      threadMessages(threadId: string, limit: number, before?: string): Message[] {
        return all(
          `SELECT * FROM (SELECT ${MESSAGE}, rowid AS seq FROM messages WHERE team_id = ? AND thread_id = ?
             AND (? IS NULL OR (created_at, rowid) < (SELECT created_at, rowid FROM messages WHERE team_id = ? AND id = ?))
             ORDER BY created_at DESC, rowid DESC LIMIT ?) ORDER BY createdAt, seq`,
          teamId,
          threadId,
          before ?? null,
          teamId,
          before ?? null,
          limit,
        ).map(({ seq: _, ...row }) => toMessage(row));
      },
      hasReply(askId: string): boolean {
        return (
          one("SELECT 1 FROM messages WHERE team_id = ? AND ask_id = ? AND kind = 'reply'", teamId, askId) !== undefined
        );
      },
      insertMessage(m: NewMessage, delivery: Delivery, at: number): MessageId {
        const id = newId("m_");
        run(
          `INSERT INTO messages (id, team_id, thread_id, kind, from_id, to_id, ask_id, body, implicit, delivery,
             created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          id,
          teamId,
          m.threadId,
          m.kind,
          m.fromId,
          m.toId,
          m.askId,
          m.body,
          m.implicit ? 1 : 0,
          delivery,
          at,
        );
        if (m.threadId) run("UPDATE threads SET updated_at = ? WHERE team_id = ? AND id = ?", at, teamId, m.threadId);
        return id;
      },
      postedSince(agentId: string, threadId: string, since: number): boolean {
        return (
          one(
            "SELECT 1 FROM messages WHERE team_id = ? AND thread_id = ? AND from_id = ? AND created_at >= ?",
            teamId,
            threadId,
            agentId,
            since,
          ) !== undefined
        );
      },
      messagesByA12sIds(ids: string[]): Message[] {
        return all(
          `SELECT ${MESSAGE} FROM messages WHERE team_id = ? AND a12s_message_id IN (SELECT value FROM json_each(?))
           ORDER BY created_at, rowid`,
          teamId,
          JSON.stringify(ids),
        ).map(toMessage);
      },

      // Agents with a queued ask or reply, with what orders them: an owner message first, then the oldest.
      dispatchable(): Map<string, { fromOwner: boolean; oldest: number }> {
        const rows = all(
          `SELECT to_id AS agentId, max(from_id = 'owner') AS fromOwner, min(created_at) AS oldest FROM messages
           WHERE team_id = ? AND delivery = 'queued' AND kind IN ('ask', 'reply') GROUP BY to_id`,
          teamId,
        );
        return new Map(
          rows.map((r) => [String(r.agentId), { fromOwner: r.fromOwner === 1, oldest: Number(r.oldest) }]),
        );
      },
      queuedFor(agentId: string): Message[] {
        return all(
          `SELECT ${MESSAGE} FROM messages WHERE team_id = ? AND to_id = ? AND delivery = 'queued'
           ORDER BY created_at, rowid`,
          teamId,
          agentId,
        ).map(toMessage);
      },
      markSent(ids: MessageId[], a12sMessageId: string): void {
        for (const id of ids) {
          run(
            "UPDATE messages SET delivery = 'sent', a12s_message_id = ? WHERE team_id = ? AND id = ?",
            a12sMessageId,
            teamId,
            id,
          );
        }
      },
    };
  }

  return {
    forTeam,
    tx: <T>(fn: () => T extends Promise<unknown> ? never : T): T => tx(db, fn),

    settings(): Settings {
      const values = new Map(all("SELECT key, value FROM settings").map((r) => [r.key, JSON.parse(String(r.value))]));
      return Object.fromEntries(
        Object.entries(SETTING_KEYS).map(([field, key]) => [field, values.get(key)]),
      ) as Settings;
    },
    updateSettings(patch: Partial<Settings>): void {
      for (const [field, key] of Object.entries(SETTING_KEYS)) {
        const value = patch[field as keyof Settings];
        if (value !== undefined) run("UPDATE settings SET value = ? WHERE key = ?", JSON.stringify(value), key);
      }
    },

    teams(): Team[] {
      return all(`SELECT ${TEAM} FROM teams WHERE deleted_at IS NULL ORDER BY created_at, rowid`).map(toTeam);
    },
    // Deleted teams count: their slugs are never reused.
    teamSlugUsed(id: string): boolean {
      return one("SELECT 1 FROM teams WHERE id = ?", id) !== undefined;
    },
    insertTeam(t: Team): void {
      run(
        `INSERT INTO teams (id, name, purpose, accent, lead_agent_id, daily_budget_usd, paused, a12s_token, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        t.id,
        t.name,
        t.purpose,
        t.accent,
        t.leadAgentId,
        t.dailyBudgetUsd,
        t.paused ? 1 : 0,
        t.a12sToken,
        t.createdAt,
      );
    },
    // The caller's identity: a current agent of a current team. Only caller.ts uses this.
    callerAgent(id: string): { id: string; teamId: string } | undefined {
      return one(
        `SELECT a.id, a.team_id AS teamId FROM agents a JOIN teams t ON t.id = a.team_id
         WHERE a.id = ? AND a.removed_at IS NULL AND t.deleted_at IS NULL`,
        id,
      ) as { id: string; teamId: string } | undefined;
    },
  };
}
