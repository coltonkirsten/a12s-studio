import { basename } from "node:path";
import { type ThreadId, TOOL_PREFIX, teamOf } from "@a12s-studio/contract/names";
import type { LiveText, Presence } from "@a12s-studio/contract/state";
import { type A12s, A12sError, type A12sEvent, type EventFeed, type Phase, type TurnRecord } from "./a12s/port.ts";
import type { Dispatcher } from "./dispatcher.ts";
import type { Repo, TeamRepo } from "./repo.ts";
import { onTurnFinished, systemAsk } from "./router.ts";

// What an agent is doing, known only from a12s events; never stored.
export type AgentLive = {
  phase?: Phase;
  error?: string;
  line: string | null;
  // whole: every event of the Turn so far was seen, so its text and Messages are complete.
  turn: {
    id: string;
    threadId: ThreadId | null;
    startedAt: number;
    text: string;
    messageIds: string[];
    whole: boolean;
  } | null;
  tools: Set<string>;
};

export type Live = ReturnType<typeof createLive>;

const RETRY_MS = 1000;
const RESYNC_TURNS = 20;
const FETCH_TRIES = 5;
const FETCH_WAIT_MS = 200;
const POST_AGAIN =
  "a12s Studio could not be reached during part of your last Turn, and a Studio tool call in it failed. " +
  "What you posted then was not received. Use read to see what did arrive, and post again what is missing.";
const STUDIO_LINES: Record<string, string> = {
  read: "Checking the board",
  update_thread: "Checking the board",
  roster: "Checking the roster",
  access: "Checking access",
  schedule: "Checking its schedule",
};

// No phase: a12s has not reported one, as before the first resync or while a12s is down at start.
export function presenceOf(phase: Phase | undefined): Presence {
  if (phase === undefined) return "unknown";
  if (phase === "Asleep") return "asleep";
  if (phase === "Busy") return "working";
  if (phase === "Error") return "error";
  return "awake";
}

// Section 5.6: a Studio tool call fails for an agent only when the app refuses it or cannot be reached.
function lostCalls(turn: TurnRecord): boolean {
  return turn.tools.some((call) => call.isError && call.name.startsWith(TOOL_PREFIX));
}

// The "doing now" line for a tool call that is not a sub-agent's.
export function doingNow(tool: string, input: unknown): string {
  const args = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
  const str = (key: string) => (typeof args[key] === "string" ? (args[key] as string) : "");
  const file = (key: string) => basename(str(key)) || "a file";
  switch (tool) {
    case "Read":
      return `Reading ${file("file_path")}`;
    case "Edit":
    case "Write":
      return `Editing ${file("file_path")}`;
    case "NotebookEdit":
      return `Editing ${file("notebook_path")}`;
    case "Bash":
      return `Running ${str("description") || str("command").slice(0, 60)}`;
    case "Grep":
    case "Glob":
      return "Searching";
    case "WebFetch": {
      const host = URL.parse(str("url"))?.host;
      return host ? `Browsing ${host}` : "Browsing";
    }
    case "WebSearch":
      return `Browsing ${str("query")}`;
    case "Agent":
    case "Task":
      return "Working with a sub-agent";
  }
  if (tool.startsWith(TOOL_PREFIX)) {
    const name = tool.slice(TOOL_PREFIX.length);
    if (name === "post") return str("kind") === "reply" ? "Writing a reply" : `Writing to ${str("to") || "the thread"}`;
    if (STUDIO_LINES[name]) return STUDIO_LINES[name];
  }
  return `Using ${tool}`;
}

// One Fleet-wide a12s feed, folded into a record per agent, the turns table and delivered marks. `changed` is
// called for every in-memory change the state shows; `text` for each streamed chunk.
export function createLive(deps: {
  repo: Repo;
  a12s: A12s;
  dispatcher: Dispatcher;
  changed: () => void;
  text: (live: LiveText) => void;
}) {
  const { repo, a12s, dispatcher, changed } = deps;
  const agents = new Map<string, AgentLive>();
  let up = false;
  let stopped = false;
  let feed: EventFeed | null = null;
  let pause: (() => void) | null = null;

  function record(agent: string): AgentLive {
    let rec = agents.get(agent);
    if (!rec) {
      rec = { line: null, turn: null, tools: new Set() };
      agents.set(agent, rec);
    }
    return rec;
  }

  function setPhase(rec: AgentLive, phase: Phase, error: string | undefined): void {
    rec.phase = phase;
    rec.error = error;
    if (phase !== "Busy") {
      rec.turn = null;
      rec.line = null;
      rec.tools.clear();
    }
  }

  // Only a current agent of a current team has Turns worth recording; the Fleet may hold other agent computers.
  function scope(agent: string): TeamRepo | null {
    const scoped = repo.forTeam(teamOf(agent));
    return scoped.agent(agent) ? scoped : null;
  }

  // One path for every finished Turn, whether its events were seen or it was read from a12s. Section 5.5 first:
  // it skips a thread the agent already posted in, so running it again after a crash adds nothing. `postAgain`
  // (section 5.6) is written with the turns row, so it is asked once.
  function recordTurn(scoped: TeamRepo, t: Omit<TurnRecord, "tools">, postAgain: boolean): void {
    if (scoped.turnStored(t.id)) return;
    const startedAt = t.startedAt ?? t.finishedAt;
    onTurnFinished(scoped, { agentId: t.agent, status: t.status, text: t.text, startedAt, messageIds: t.messageIds });
    const threadId = scoped.messagesByA12sIds(t.messageIds)[0]?.threadId ?? null;
    scoped.tx(() => {
      scoped.markDelivered(t.messageIds, startedAt);
      scoped.insertTurn({
        id: t.id,
        agentId: t.agent,
        threadId,
        session: t.session,
        status: t.status,
        error: t.error ?? null,
        startedAt: t.startedAt ?? null,
        finishedAt: t.finishedAt,
        tokens: t.tokens,
        modelCostsUsd: t.modelCostsUsd,
      });
      if (postAgain) systemAsk(scoped, t.agent, POST_AGAIN);
    });
  }

  async function handle(ev: Exclude<A12sEvent, { type: "gap" }>): Promise<void> {
    // A phase counts for any name: an agent computer being hired reports its phases before its row is committed.
    if (ev.type === "agent_computer.phase") {
      setPhase(record(ev.agent), ev.phase, ev.error);
      changed();
      void dispatcher.run();
      return;
    }
    const scoped = scope(ev.agent);
    if (!scoped) return;
    const rec = record(ev.agent);
    switch (ev.type) {
      case "turn.started": {
        scoped.markDelivered(ev.messageIds, ev.at);
        const threadId = scoped.messagesByA12sIds(ev.messageIds)[0]?.threadId ?? null;
        rec.turn = { id: ev.turn, threadId, startedAt: ev.at, text: "", messageIds: ev.messageIds, whole: true };
        rec.line = "Thinking";
        rec.tools.clear();
        changed();
        return;
      }
      case "text.delta": {
        // A Turn already running when the app started: its start was missed, so it has no thread.
        if (rec.turn?.id !== ev.turn)
          rec.turn = { id: ev.turn, threadId: null, startedAt: ev.at, text: "", messageIds: [], whole: false };
        rec.turn.text += ev.text;
        deps.text({ agent: ev.agent, turn: ev.turn, text: ev.text });
        if (rec.tools.size === 0 && rec.line !== "Writing") {
          rec.line = "Writing";
          changed();
        }
        return;
      }
      case "tool.started":
        if (ev.parent) return;
        rec.tools.add(ev.id);
        rec.line = doingNow(ev.name, ev.input);
        changed();
        return;
      case "tool.finished":
        if (!ev.parent) rec.tools.delete(ev.id);
        return;
      case "turn.finished": {
        const seen = rec.turn?.id === ev.turn && rec.turn.whole ? rec.turn : null;
        if (seen) {
          const turn = {
            id: ev.turn,
            agent: ev.agent,
            session: ev.session,
            status: ev.status,
            ...(ev.error ? { error: ev.error } : {}),
            text: seen.text,
            messageIds: seen.messageIds,
            startedAt: seen.startedAt,
            finishedAt: ev.at,
            modelCostsUsd: ev.modelCostsUsd,
            ...(ev.tokens ? { tokens: ev.tokens } : {}),
          };
          // The app answered every Studio call of a Turn it followed whole, so a failed one was a refusal.
          recordTurn(scoped, turn, false);
        } else {
          const turn = await fetchTurn(scoped, ev.agent, ev.turn);
          if (turn) recordTurn(scoped, turn, lostCalls(turn));
        }
        rec.turn = null;
        rec.line = null;
        rec.tools.clear();
        changed();
        void dispatcher.run();
        return;
      }
    }
  }

  // A Turn this app did not follow whole: a12s has its text, the Messages it delivered and its tool calls. a12s
  // sends turn.finished just before it stores the Turn, so the first read can come too early.
  async function fetchTurn(scoped: TeamRepo, agent: string, turn: string): Promise<TurnRecord | undefined> {
    const token = scoped.team()?.a12sToken;
    if (!token) return undefined;
    for (let attempt = 1; ; attempt++) {
      const found = (await a12s.forTeam(token).turns(agent, RESYNC_TURNS)).find((t) => t.id === turn);
      if (found) return found;
      if (attempt === FETCH_TRIES) break;
      await new Promise((resolve) => setTimeout(resolve, FETCH_WAIT_MS));
    }
    console.error(`live: Turn ${turn} of ${agent} is not in its history; the next resync stores it.`);
    return undefined;
  }

  // Everything an event could have told us, asked for directly: after a gap, and on every new feed (app start).
  async function resync(): Promise<void> {
    for (const rec of agents.values()) if (rec.turn) rec.turn.whole = false;
    for (const team of repo.teams()) {
      const scoped = repo.forTeam(team.id);
      const client = a12s.forTeam(team.a12sToken);
      try {
        const current = new Set(scoped.agents().map((a) => a.id));
        for (const s of await client.status()) {
          if (current.has(s.name)) setPhase(record(s.name), s.phase, s.error);
        }
        for (const agent of current) {
          for (const turn of (await client.turns(agent, RESYNC_TURNS)).reverse()) {
            recordTurn(scoped, turn, lostCalls(turn));
          }
        }
        for (const agent of scoped.agentsWithSent()) {
          const inbox = await client.inbox(agent);
          const ids = (states: string[]) => inbox.filter((m) => states.includes(m.state)).map((m) => m.id);
          scoped.tx(() => {
            scoped.markDelivered(ids(["delivered"]), Date.now());
            scoped.markUndelivered(ids(["withdrawn", "discarded", "expired"]));
          });
        }
      } catch (error) {
        if (error instanceof A12sError && error.code === "unreachable") throw error;
        console.error(`live: resync of team ${team.id} failed:`, error);
      }
    }
    changed();
    void dispatcher.run();
  }

  function setUp(value: boolean): void {
    if (up === value) return;
    up = value;
    changed();
  }

  async function loop(): Promise<void> {
    while (!stopped) {
      const current = a12s.events();
      feed = current;
      try {
        await current.ready();
        setUp(true);
        await resync();
        for await (const ev of current) {
          if (ev.type === "gap") {
            await resync();
            continue;
          }
          try {
            await handle(ev);
          } catch (error) {
            if (error instanceof A12sError && error.code === "unreachable") throw error;
            console.error(`live: ${ev.type} for ${ev.agent} failed:`, error);
          }
        }
      } catch (error) {
        if (!stopped) console.error("live: a12s feed lost:", error instanceof Error ? error.message : error);
      }
      current.close();
      if (stopped) return;
      setUp(false);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, RETRY_MS);
        pause = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    }
  }

  let running: Promise<void> | null = null;
  return {
    agent: (id: string): AgentLive | undefined => agents.get(id),
    up: () => up,
    start(): void {
      running ??= loop();
    },
    async stop(): Promise<void> {
      stopped = true;
      feed?.close();
      pause?.();
      await running;
    },
  };
}
