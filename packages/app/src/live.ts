import { basename } from "node:path";
import { addonOf, type ThreadId, TOOL_PREFIX, teamOf } from "@a12s-studio/contract/names";
import type { LiveText, Presence, WorkItem } from "@a12s-studio/contract/state";
import {
  type A12s,
  A12sError,
  type A12sEvent,
  type BackgroundItem,
  type EventFeed,
  type Phase,
  type ServiceStatus,
  type TurnRecord,
} from "./a12s/port.ts";
import { turnCost } from "./cost.ts";
import type { Dispatcher } from "./dispatcher.ts";
import type { Message, Repo, TeamRepo } from "./repo.ts";
import { onTurnFinished, systemMessage } from "./router.ts";

// A sub-agent or background work of an agent. `call` is the tool call that started it, which a sub-agent's own calls
// name as their parent; `background` once a12s has reported it as work that outlives the Turn.
// `tool`: the sub-agent's call its line names, so the line ends with that call.
type Work = Omit<WorkItem, "id"> & { call: string | null; background: boolean; tool: string | null };

// What the model of a running Turn is doing between tool calls, and since when.
type Step = { line: string; at: number };

// What an agent is doing, known only from a12s events; never stored.
export type AgentLive = {
  phase?: Phase;
  error?: string;
  // whole: every event of the Turn so far was seen, so its text and Messages are complete.
  turn: {
    id: string;
    threadId: ThreadId | null;
    startedAt: number;
    text: string;
    messages: TurnRecord["messages"];
    whole: boolean;
  } | null;
  // The agent's own calls running now, each with its line and start.
  tools: Map<string, Step>;
  // Null until the model streams something in the Turn, or after its last running call ended: the Turn's own start
  // or that end then stands.
  step: Step | null;
  // By item id: the launching call's id until a12s names it as a background task, then the task's.
  work: Map<string, Work>;
  // The thread of the work item that ended last, for the Turn with no Messages that the harness starts after it.
  lastThread: ThreadId | null;
};

export type Live = ReturnType<typeof createLive>;

const RETRY_MS = 1000;
const RESYNC_TURNS = 20;
const POST_AGAIN =
  "a12s Studio could not be reached during part of your last Turn, and a Studio tool call in it failed. " +
  "What you posted then was not received. Use read to see what did arrive, and post again what is missing.";
const IN_BACKGROUND = "Working in the background";
const THINKING = "Thinking";
const WRITING = "Writing";
const STUDIO_LINES: Record<string, string> = {
  read: "Checking the board",
  update_thread: "Checking the board",
  roster: "Checking the roster",
  access: "Checking access",
  schedule: "Checking its schedule",
};

// No phase: a12s has not reported one, as before the first resync or while a12s is down at start. Between Turns
// a12s reports an agent with background work as Ready; it is not idle.
export function presenceOf(phase: Phase | undefined, hasWork: boolean): Presence {
  if (phase === undefined) return "unknown";
  if (phase === "Asleep") return "asleep";
  if (phase === "Busy" || (phase === "Ready" && hasWork)) return "working";
  if (phase === "Error") return "error";
  return "awake";
}

// What an agent is doing now and since when, from its state alone: the latest running call, else what the model
// streams, else thinking since the Turn started; with no Turn, its background work.
export function doingOf(rec: AgentLive): Step | null {
  if (!rec.turn) {
    const started = [...rec.work.values()].map((w) => w.startedAt);
    return started.length > 0 ? { line: IN_BACKGROUND, at: Math.min(...started) } : null;
  }
  const calls = [...rec.tools.values()];
  return calls.at(-1) ?? rec.step ?? { line: THINKING, at: rec.turn.startedAt };
}

function workOf(rec: AgentLive, call: string): [string, Work] | undefined {
  for (const entry of rec.work) if (entry[1].call === call) return entry;
  return undefined;
}

// a12s passes the harness's own kind: Claude Code names a sub-agent local_agent.
const kindOf = (kind: string): Work["kind"] => (kind === "local_agent" || kind === "agent" ? "agent" : "task");

// a12s's list of an agent's background work is the truth after a gap or a restart. A known item keeps its thread
// and line; one a12s no longer lists has ended; foreground work's calls ended unseen or are not known to be running.
function syncWork(rec: AgentLive, background: BackgroundItem[]): void {
  const listed = new Set(background.map((item) => item.id));
  for (const [id, work] of rec.work) if (!work.background || !listed.has(id)) rec.work.delete(id);
  for (const item of background) {
    if (rec.work.has(item.id)) continue;
    rec.work.set(item.id, {
      kind: kindOf(item.kind),
      description: item.description,
      threadId: null,
      startedAt: item.startedAt,
      line: null,
      call: item.toolUseId ?? null,
      background: true,
      tool: null,
    });
  }
}

// Section 5.9: one line for each message that reaches its agent.
function logDelivered(messages: Message[]): void {
  for (const m of messages) {
    console.log(
      `delivered ${m.id} from ${m.fromId} to ${m.toId}: cause ${m.causeId ?? "none"}, depth ${m.depth}, ` +
        `turn ${m.turnId}, ${m.steered ? "steered" : "started it"}`,
    );
  }
}

// Section 5.6: a Studio tool call fails for an agent only when the app refuses it or cannot be reached.
function lostCalls(turn: TurnRecord): boolean {
  return turn.tools.some((call) => call.isError && call.name.startsWith(TOOL_PREFIX));
}

// A tool call's input is whatever the harness sent: a field counts only when it is a string.
function inputString(input: unknown, key: string): string {
  const value = typeof input === "object" && input !== null ? (input as Record<string, unknown>)[key] : undefined;
  return typeof value === "string" ? value : "";
}

// The "doing now" line for a tool call, the agent's own or a sub-agent's.
export function doingNow(tool: string, input: unknown): string {
  const str = (key: string) => inputString(input, key);
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
    if (name === "post") return `Writing to ${str("to")}`;
    if (STUDIO_LINES[name]) return STUDIO_LINES[name];
  }
  return `Using ${tool}`;
}

// The line while the model writes out a tool call, before its input is complete.
export function composing(tool: string): string {
  if (tool === `${TOOL_PREFIX}post`) return "Writing a post";
  return `Preparing ${tool.startsWith(TOOL_PREFIX) ? tool.slice(TOOL_PREFIX.length) : tool}`;
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
  // Add-on instances by name, as a12s last reported them.
  const instances = new Map<string, ServiceStatus>();
  let up = false;
  let stopped = false;
  let feed: EventFeed | null = null;
  let pause: (() => void) | null = null;

  function record(agent: string): AgentLive {
    let rec = agents.get(agent);
    if (!rec) {
      rec = { turn: null, tools: new Map(), step: null, work: new Map(), lastThread: null };
      agents.set(agent, rec);
    }
    return rec;
  }

  function setPhase(rec: AgentLive, phase: Phase, error: string | undefined): void {
    rec.phase = phase;
    rec.error = error;
    if (phase !== "Busy") endTurn(rec);
    // No harness session lives through any other phase, so none of its work does.
    if (phase !== "Busy" && phase !== "Ready") {
      rec.work.clear();
      rec.lastThread = null;
    }
  }

  function endTurn(rec: AgentLive): void {
    rec.turn = null;
    rec.tools.clear();
    rec.step = null;
  }

  // Pushes a change of what the model is doing only when its line changes, since text streams in many small chunks.
  function setStep(rec: AgentLive, line: string, at: number): void {
    if (rec.step?.line === line) return;
    rec.step = { line, at };
    if (rec.tools.size === 0) changed();
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
    const ids = (steered: boolean) => t.messages.filter((m) => m.steered === steered).map((m) => m.id);
    const messageIds = t.messages.map((m) => m.id);
    onTurnFinished(scoped, { agentId: t.agent, status: t.status, text: t.text, startedAt, messageIds });
    const threadId = scoped.messagesByA12sIds(ids(false))[0]?.threadId ?? null;
    scoped.tx(() => {
      for (const steered of [false, true]) logDelivered(scoped.markDelivered(ids(steered), t.id, steered, startedAt));
      scoped.markSteered(ids(true), t.id);
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
        costUsd: turnCost(t, scoped.previousCosts(t.agent, t.finishedAt)),
      });
      if (postAgain) systemMessage(scoped, t.agent, POST_AGAIN);
    });
  }

  async function handle(ev: Exclude<A12sEvent, { type: "gap" | "service.phase" }>): Promise<void> {
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
        logDelivered(scoped.markDelivered(ev.messageIds, ev.turn, false, ev.at));
        // The harness starts a Turn with no Messages when background work ends, to read its result.
        const threadId =
          ev.messageIds.length === 0 ? rec.lastThread : (scoped.messagesByA12sIds(ev.messageIds)[0]?.threadId ?? null);
        rec.lastThread = null;
        const messages = ev.messageIds.map((id) => ({ id, steered: false }));
        endTurn(rec);
        rec.turn = { id: ev.turn, threadId, startedAt: ev.at, text: "", messages, whole: true };
        changed();
        return;
      }
      case "turn.steered": {
        logDelivered(scoped.markDelivered(ev.messageIds, ev.turn, true, ev.at));
        if (rec.turn?.id === ev.turn) rec.turn.messages.push(...ev.messageIds.map((id) => ({ id, steered: true })));
        return;
      }
      case "text.delta": {
        // A Turn already running when the app started: its start was missed, so it has no thread.
        if (rec.turn?.id !== ev.turn)
          rec.turn = { id: ev.turn, threadId: null, startedAt: ev.at, text: "", messages: [], whole: false };
        rec.turn.text += ev.text;
        deps.text({ agent: ev.agent, turn: ev.turn, text: ev.text });
        setStep(rec, WRITING, ev.at);
        return;
      }
      case "thinking":
        setStep(rec, THINKING, ev.at);
        return;
      case "tool.composing":
        setStep(rec, composing(ev.name), ev.at);
        return;
      case "tool.started": {
        if (ev.parent) {
          const work = workOf(rec, ev.parent)?.[1];
          if (!work) return;
          work.line = doingNow(ev.name, ev.input);
          work.tool = ev.id;
          changed();
          return;
        }
        rec.tools.set(ev.id, { line: doingNow(ev.name, ev.input), at: ev.at });
        rec.step = null;
        if (ev.name === "Agent" || ev.name === "Task") {
          rec.work.set(ev.id, {
            kind: "agent",
            description: inputString(ev.input, "description"),
            threadId: rec.turn?.threadId ?? null,
            startedAt: ev.at,
            line: null,
            call: ev.id,
            background: false,
            tool: null,
          });
        }
        changed();
        return;
      }
      case "tool.finished": {
        if (ev.parent) {
          const work = workOf(rec, ev.parent)?.[1];
          if (work?.tool !== ev.id) return;
          work.line = THINKING;
          work.tool = null;
          changed();
          return;
        }
        rec.tools.delete(ev.id);
        // The model reads the result next.
        if (rec.tools.size === 0 && rec.turn) rec.step = { line: THINKING, at: ev.at };
        const [id, work] = workOf(rec, ev.id) ?? [];
        if (id && !work?.background) rec.work.delete(id);
        changed();
        return;
      }
      case "task.started": {
        const launched = ev.toolUseId ? workOf(rec, ev.toolUseId) : undefined;
        if (launched) rec.work.delete(launched[0]);
        rec.work.set(ev.id, {
          kind: kindOf(ev.kind),
          description: ev.description,
          threadId: rec.turn?.threadId ?? null,
          startedAt: ev.at,
          line: null,
          call: ev.toolUseId ?? null,
          tool: null,
          ...launched?.[1],
          background: true,
        });
        changed();
        return;
      }
      case "task.finished": {
        const work = rec.work.get(ev.id);
        if (!work) return;
        rec.work.delete(ev.id);
        rec.lastThread = work.threadId;
        changed();
        return;
      }
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
            messages: seen.messages,
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
        endTurn(rec);
        // A foreground sub-agent's call ends with its Turn, even when the Turn was interrupted before it finished.
        for (const [id, work] of rec.work) if (!work.background) rec.work.delete(id);
        changed();
        void dispatcher.run();
        return;
      }
    }
  }

  // A Turn this app did not follow whole: a12s has its text, the Messages it delivered and its tool calls, stored
  // before it sends turn.finished.
  async function fetchTurn(scoped: TeamRepo, agent: string, turn: string): Promise<TurnRecord | undefined> {
    const token = scoped.team()?.a12sToken;
    if (!token) return undefined;
    const found = (await a12s.forTeam(token).turns(agent, RESYNC_TURNS)).find((t) => t.id === turn);
    if (!found) console.error(`live: Turn ${turn} of ${agent} finished but is not in its a12s history.`);
    return found;
  }

  // Everything an event could have told us, asked for directly: after a gap, and on every new feed (app start).
  async function resync(): Promise<void> {
    for (const rec of agents.values()) if (rec.turn) rec.turn.whole = false;
    for (const team of repo.teams()) {
      const scoped = repo.forTeam(team.id);
      const client = a12s.forTeam(team.a12sToken);
      try {
        const current = new Set(scoped.agents().map((a) => a.id));
        const listed = (await client.services()).filter((service) => addonOf(service.name));
        for (const name of instances.keys()) if (teamOf(name) === team.id) instances.delete(name);
        for (const service of listed) instances.set(service.name, service);
        for (const s of await client.status()) {
          if (!current.has(s.name)) continue;
          const rec = record(s.name);
          setPhase(rec, s.phase, s.error);
          syncWork(rec, s.background);
        }
        for (const agent of current) {
          for (const turn of (await client.turns(agent, RESYNC_TURNS)).reverse()) {
            recordTurn(scoped, turn, lostCalls(turn));
          }
        }
        // Delivered here means taken by a Turn still running, or the finished Turns above would have marked it. How
        // it arrived is set from that Turn's record when it finishes; until then it counts as having started it.
        for (const agent of scoped.agentsWithSent()) {
          const inbox = await client.inbox(agent);
          const now = Date.now();
          scoped.tx(() => {
            for (const m of inbox) {
              if (m.state === "delivered" && m.turn) logDelivered(scoped.markDelivered([m.id], m.turn, false, now));
            }
            scoped.markUndelivered(
              inbox.filter((m) => ["withdrawn", "discarded", "expired"].includes(m.state)).map((m) => m.id),
            );
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
          if (ev.type === "service.phase") {
            if (!addonOf(ev.service)) continue;
            const { service: name, phase, error } = ev;
            instances.set(name, { name, phase, ...(error ? { error } : {}) });
            changed();
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
    instance: (name: string): ServiceStatus | undefined => instances.get(name),
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
