import type { ServerResponse } from "node:http";
import type {
  LiveText,
  MessageView,
  NeedsYouItem,
  StudioState,
  TeamView,
  ThreadView,
} from "@a12s-studio/contract/state";
import type { BrokerClient } from "./broker-client.ts";
import { blockedReason, freeDiskGb, overBudget } from "./dispatcher.ts";
import { type Live, presenceOf } from "./live.ts";
import type { Message, Repo, TeamRepo } from "./repo.ts";
import { boardStatus } from "./router.ts";
import type { Scheduler } from "./scheduler.ts";

const COALESCE_MS = 50;
const THREADS = 200;
const MESSAGES = 200;
const TURN_TEXT = 4000;
const PREVIEW = 140;

export function messageView(m: Message): MessageView {
  return {
    id: m.id,
    kind: m.kind,
    from: m.fromId,
    to: m.toId,
    ask: m.askId,
    body: m.body,
    file: m.fileName,
    implicit: m.implicit,
    at: m.createdAt,
  };
}

// The newest `MESSAGES` before `before`, and whether older ones exist.
export function messagesPage(team: TeamRepo, threadId: string, before?: string) {
  const rows = team.threadMessages(threadId, MESSAGES + 1, before);
  return { messages: rows.slice(-MESSAGES).map(messageView), hasMore: rows.length > MESSAGES };
}

type Sources = { repo: Repo; live: Live; broker: Pick<BrokerClient, "up">; scheduler: Pick<Scheduler, "attention"> };

// StudioState without its rev, from the database, the live agent records and the broker's last attention answer.
// `thread` is the open thread, if any.
export function deriveState(
  { repo, live, broker, scheduler }: Sources,
  thread: string | null,
): Omit<StudioState, "rev"> {
  const settings = repo.settings();
  const attention = scheduler.attention();
  const now = Date.now();
  const needsYou: NeedsYouItem[] = [];
  // The dispatcher's count, as far as the live records know it: a phase other than Asleep.
  const awake = repo
    .teams()
    .flatMap((team) => repo.forTeam(team.id).agents())
    .filter((agent) => {
      const phase = live.agent(agent.id)?.phase;
      return phase !== undefined && phase !== "Asleep";
    }).length;
  const teams: TeamView[] = repo.teams().map((team) => {
    const scoped = repo.forTeam(team.id);
    const waiting = scoped.undelivered();
    for (const m of scoped.ownerQuestions()) {
      if (m.threadId)
        needsYou.push({ kind: "question", teamId: team.id, threadId: m.threadId, message: messageView(m) });
    }
    for (const t of scoped.failedTurns()) {
      needsYou.push({
        kind: "failed_turn",
        teamId: team.id,
        agentId: t.agentId,
        turnId: t.id,
        error: t.error,
        at: t.finishedAt,
      });
    }
    for (const { teamId, ...request } of attention.requests) {
      if (teamId !== team.id) continue;
      const hostHasCredential = attention.credentialHosts[teamId]?.includes(request.host) ?? false;
      needsYou.push({ kind: "access_request", teamId, request, hostHasCredential });
    }
    for (const { teamId, host, rejectedAt } of attention.rejected) {
      if (teamId === team.id && rejectedAt !== null) {
        needsYou.push({ kind: "credential_rejected", teamId, host, at: rejectedAt });
      }
    }
    for (const { teamId, id, host, paths, expiresAt } of attention.expiring) {
      if (teamId === team.id && expiresAt !== null) {
        needsYou.push({ kind: "grant_expiring", teamId, grantId: id, host, paths, expiresAt });
      }
    }
    const spent = scoped.spentToday(now);
    const held = overBudget(team, spent);
    if (held) needsYou.push({ kind: "budget", teamId: team.id, dailyUsd: team.dailyBudgetUsd, spentTodayUsd: spent });
    const blocked = (asleep: boolean) => blockedReason(settings, team, spent, asleep ? { awake, freeDiskGb } : null);
    return {
      id: team.id,
      name: team.name,
      purpose: team.purpose,
      accent: team.accent,
      paused: team.paused,
      leadId: team.leadAgentId,
      budget: { dailyUsd: team.dailyBudgetUsd, spentTodayUsd: spent, held },
      agents: scoped.agents().map((agent) => {
        const rec = live.agent(agent.id);
        const queue = waiting.get(agent.id);
        let presence = presenceOf(rec?.phase, (rec?.work.size ?? 0) > 0);
        if (rec?.phase === "Error") {
          needsYou.push({ kind: "agent_error", teamId: team.id, agentId: agent.id, error: rec.error ?? "" });
        }
        const waitingFor =
          queue?.dispatchable === true && (presence === "asleep" || presence === "awake")
            ? blocked(presence === "asleep")
            : null;
        if (waitingFor) presence = "waiting";
        return {
          id: agent.id,
          slug: agent.slug,
          roleLine: agent.role.split("\n")[0] ?? "",
          model: agent.model,
          presence,
          ...(waitingFor ? { waitingFor } : {}),
          line: rec?.line ?? null,
          turn: rec?.turn
            ? {
                id: rec.turn.id,
                threadId: rec.turn.threadId,
                startedAt: rec.turn.startedAt,
                text: rec.turn.text.slice(-TURN_TEXT),
              }
            : null,
          work: [...(rec?.work ?? [])]
            .map(([id, { kind, description, threadId, startedAt, line }]) => ({
              id,
              kind,
              description,
              threadId,
              startedAt,
              line,
            }))
            .sort((a, b) => a.startedAt - b.startedAt),
          queued: queue?.count ?? 0,
          ...(rec?.phase === "Error" && rec.error ? { error: rec.error } : {}),
        };
      }),
      threads: scoped.board({ status: "all", limit: THREADS, viewer: "owner" }).map((t) => ({
        id: t.id,
        title: t.title,
        ownerId: t.ownerAgentId,
        status: boardStatus(t),
        updatedAt: t.updatedAt,
        preview: (t.last?.body ?? "").slice(0, PREVIEW),
        asksForYou: t.asksForOwner,
      })),
    };
  });

  let open: ThreadView | null = null;
  const teamId = thread ? repo.threadTeam(thread) : undefined;
  const summary = teams.find((t) => t.id === teamId)?.threads.find((t) => t.id === thread);
  if (teamId && thread && summary) {
    open = {
      id: summary.id,
      teamId,
      title: summary.title,
      ownerId: summary.ownerId,
      status: summary.status,
      ...messagesPage(repo.forTeam(teamId), thread),
    };
  }
  return {
    a12s: live.up() ? "up" : "down",
    broker: broker.up() ? "up" : "down",
    settings,
    teams,
    needsYou,
    open,
  };
}

type Client = { res: ServerResponse; build: () => Omit<StudioState, "rev"> };

// The rev counter and the Server-Sent Events fan-out. Every change bumps the rev; states go out at most once per
// COALESCE_MS, each built when it is sent, so it holds every change counted in its rev.
export function createStream() {
  let rev = 0;
  let lastSent = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const clients = new Set<Client>();

  function send(client: Client, event: string, data: unknown): void {
    client.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  function sendState(client: Client): void {
    try {
      send(client, "state", { rev, ...client.build() });
    } catch (error) {
      console.error("stream: state failed to build:", error);
      client.res.end();
    }
  }

  function flush(): void {
    timer = null;
    lastSent = Date.now();
    for (const client of clients) sendState(client);
  }

  return {
    rev: () => rev,
    changed(): void {
      rev++;
      timer ??= setTimeout(flush, Math.max(0, lastSent + COALESCE_MS - Date.now()));
    },
    live(text: LiveText): void {
      for (const client of clients) send(client, "live", text);
    },
    connect(res: ServerResponse, build: Client["build"]): void {
      const client = { res, build };
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
      clients.add(client);
      res.on("close", () => clients.delete(client));
      sendState(client);
    },
    close(): void {
      if (timer) clearTimeout(timer);
      for (const client of clients) client.res.end();
      clients.clear();
    },
  };
}

export type Stream = ReturnType<typeof createStream>;
