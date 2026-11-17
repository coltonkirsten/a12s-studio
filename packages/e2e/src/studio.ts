import type {
  ErrorBody,
  MessagesPage,
  ToolCall,
  TurnEventsResponse,
  TurnsResponse,
  WriteResult,
} from "@a12s-studio/contract/api";
import { OWNER_PORT } from "@a12s-studio/contract/names";
import type { MessageView, StudioState } from "@a12s-studio/contract/state";

const BASE = `http://127.0.0.1:${OWNER_PORT}/api`;
const RECONNECT_MS = 250;
// The app writes each state as one frame: this prefix, then the JSON on the same line.
const STATE_FRAME = "event: state\ndata: ";

// A model's Turn includes waking its agent computer, so each wait for an agent allows a few minutes.
export const ANSWER_MS = 5 * 60_000;

// The app or the broker process, as run.ts started it.
type HostProcess = { stop(): Promise<void>; start(): void };
// Runs an a12s command on the e2e Fleet, `input` on its stdin, and answers its output.
type A12s = (args: string[], input?: string) => Promise<string>;
// Names one thing a script makes outside the Fleet and the data folder. run.ts removes it with `remove` in its
// cleanup, as a printed step, also when the run fails or is interrupted.
type AtEnd = (title: string, remove: () => Promise<void>) => void;

// What a script drives Studio with: the owner API and the state stream, as the UI uses them, and a shell in an
// agent's container.
export type Studio = {
  api<T>(method: string, path: string, body?: unknown): Promise<T>;
  // The newest state the stream has sent.
  state(): StudioState;
  // Resolves with the first state, the current one included, for which `check` is true. `check` may throw to fail
  // the wait at once, when a state shows the awaited thing can no longer happen.
  until(what: string, check: (state: StudioState) => boolean, timeoutMs: number): Promise<StudioState>;
  // Names the thread the stream's `open` carries, and waits for a state that has it.
  open(thread: string): Promise<StudioState>;
  // Stops the app process and starts it again, then waits until it sees a12s.
  restartApp(): Promise<void>;
  // Wakes the agent as the owner can, then runs `command` with sh in its container and answers the output. A secret
  // goes in `input`, on the command's stdin: a12s journals the command itself.
  shell(agent: string, command: string, input?: string): Promise<string>;
  // The agent computer's harness session, as a12s status reports it; null before its first Turn.
  session(agent: string): Promise<string | null>;
  atEnd: AtEnd;
  // The data folder, STUDIO_HOME of both processes.
  home: string;
  // Stops the app and the broker, runs `work` while neither runs, then starts both and waits until the app sees a12s.
  offline(work: () => Promise<void>): Promise<void>;
};

const elapsed = (since: number) => `${Math.round((Date.now() - since) / 1000)}s`;

// One printed line per step, so a run reads as the list of what it showed.
export async function step<T>(title: string, run: () => Promise<T>): Promise<T> {
  const started = Date.now();
  try {
    const result = await run();
    console.log(`ok    ${title} (${elapsed(started)})`);
    return result;
  } catch (error) {
    console.log(`FAIL  ${title} (${elapsed(started)}): ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}

export const messages = (state: StudioState): MessageView[] => state.open?.messages ?? [];

export const presence = (state: StudioState, agent: string) =>
  state.teams.flatMap((t) => t.agents).find((a) => a.id === agent)?.presence;

// The first message from `from` to `to` (by default the owner) after the message `after`, in the open thread.
export function answerFrom(state: StudioState, from: string, after: string, to = "owner"): MessageView | undefined {
  const all = messages(state);
  const start = all.findIndex((m) => m.id === after);
  return start < 0 ? undefined : all.slice(start + 1).find((m) => m.from === from && m.to === to);
}

export async function createTeam(studio: Studio, name: string, template: string, purpose: string): Promise<string> {
  const { id } = await studio.api<WriteResult>("POST", "/teams", { name, purpose, accent: "#4f6bed", template });
  if (!id) throw new Error(`creating ${name} answered no id`);
  return id;
}

// Starts a thread with a message to one of the team's agents, by default its lead; answers the thread's and the
// message's ids.
export async function ownerMessage(studio: Studio, team: string, title: string, body: string, to?: string) {
  const { id: thread } = await studio.api<WriteResult>("POST", `/teams/${team}/threads`, { title, body, to });
  if (!thread) throw new Error(`the new thread in ${team} answered no id`);
  const { messages: first } = await studio.api<MessagesPage>("GET", `/threads/${thread}/messages`);
  const message = first.find((m) => m.from === "owner");
  if (!message) throw new Error(`thread ${thread} has no message from the owner`);
  return { thread, message: message.id };
}

// The tool calls `agent` started between `from` and `to` (ms since the epoch), from its finished Turns. The app lists
// only an agent's newest Turns, so `first`, the Turn the window starts in, must be among them.
export async function toolCalls(
  studio: Studio,
  agent: string,
  first: string | null,
  from: number,
  to: number,
): Promise<ToolCall[]> {
  const { turns } = await studio.api<TurnsResponse>("GET", `/agents/${agent}/turns`);
  if (!turns.some((t) => t.id === first)) {
    throw new Error(`the Turns the app lists for ${agent} do not reach back to the one the window starts in`);
  }
  const calls: ToolCall[] = [];
  for (const turn of turns.filter((t) => t.finishedAt >= from && (t.startedAt ?? t.finishedAt) <= to)) {
    const { calls: all } = await studio.api<TurnEventsResponse>("GET", `/agents/${agent}/turns/${turn.id}/events`);
    calls.push(...all.filter((c) => c.startedAt >= from && c.startedAt <= to));
  }
  return calls.sort((a, b) => a.startedAt - b.startedAt);
}

export function connectStudio(app: HostProcess, broker: HostProcess, a12s: A12s, atEnd: AtEnd, home: string): Studio {
  let current: StudioState | null = null;
  let thread: string | null = null;
  let connection = new AbortController();
  const waiters = new Set<(state: StudioState) => void>();

  function receive(state: StudioState): void {
    current = state;
    for (const waiter of waiters) waiter(state);
  }

  // The stream ends when the app stops or the open thread changes; it is opened again until the app answers.
  async function follow(): Promise<void> {
    for (;;) {
      const signal = connection.signal;
      try {
        const query = thread === null ? "" : `?thread=${encodeURIComponent(thread)}`;
        const res = await fetch(`${BASE}/stream${query}`, { signal });
        if (!res.body) throw new Error("the stream has no body");
        let buffer = "";
        for await (const chunk of res.body.pipeThrough(new TextDecoderStream())) {
          buffer += chunk;
          let end = buffer.indexOf("\n\n");
          while (end >= 0) {
            const frame = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            end = buffer.indexOf("\n\n");
            if (frame.startsWith(STATE_FRAME)) receive(JSON.parse(frame.slice(STATE_FRAME.length)) as StudioState);
          }
        }
      } catch {
        // A refused connection while the app starts, or an abort: both are followed by a new connection.
      }
      await new Promise((resolve) => setTimeout(resolve, RECONNECT_MS));
    }
  }
  void follow();

  function until(what: string, check: (state: StudioState) => boolean, timeoutMs: number): Promise<StudioState> {
    return new Promise((resolve, reject) => {
      const done = (error: Error | null, state?: StudioState) => {
        waiters.delete(waiter);
        clearTimeout(timer);
        if (error) reject(error);
        else if (state) resolve(state);
      };
      const waiter = (state: StudioState) => {
        try {
          if (check(state)) done(null, state);
        } catch (error) {
          done(error instanceof Error ? error : new Error(String(error)));
        }
      };
      const timer = setTimeout(() => done(new Error(`no state showed ${what} within ${timeoutMs / 1000}s`)), timeoutMs);
      waiters.add(waiter);
      if (current) waiter(current);
    });
  }

  async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${BASE}${path}`, {
      method,
      ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    });
    const answer: unknown = await res.json();
    if (!res.ok) {
      const { code, message } = answer as ErrorBody;
      throw new Error(`${method} ${path} answered ${res.status} ${code}: ${message}`);
    }
    return answer as T;
  }

  const upAgain = () => until("a12s up after the restart", (state) => state.a12s === "up", 60_000);

  return {
    api,
    state(): StudioState {
      if (!current) throw new Error("the stream has sent no state yet");
      return current;
    },
    until,
    open(id: string): Promise<StudioState> {
      thread = id;
      current = null;
      connection.abort();
      connection = new AbortController();
      return until(`thread ${id} open`, (state) => state.open?.id === id, 10_000);
    },
    async restartApp(): Promise<void> {
      await app.stop();
      current = null;
      app.start();
      await upAgain();
    },
    async shell(agent: string, command: string, input?: string): Promise<string> {
      await api("POST", `/agents/${agent}/power`, { state: "awake" });
      return a12s(["shell", agent, "--", "sh", "-c", command], input);
    },
    async session(agent: string): Promise<string | null> {
      const status = JSON.parse(await a12s(["--json", "status", agent])) as { session?: string };
      return status.session ?? null;
    },
    atEnd,
    home,
    async offline(work: () => Promise<void>): Promise<void> {
      await Promise.all([app.stop(), broker.stop()]);
      current = null;
      await work();
      broker.start();
      app.start();
      await upAgain();
    },
  };
}
