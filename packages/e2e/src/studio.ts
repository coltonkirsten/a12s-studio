import type { ErrorBody } from "@a12s-studio/contract/api";
import { OWNER_PORT } from "@a12s-studio/contract/names";
import type { StudioState } from "@a12s-studio/contract/state";

const BASE = `http://127.0.0.1:${OWNER_PORT}/api`;
const RECONNECT_MS = 250;
// The app writes each state as one frame: this prefix, then the JSON on the same line.
const STATE_FRAME = "event: state\ndata: ";

// The app process, as run.ts started it.
type AppProcess = { stop(): Promise<void>; start(): void };

// What a script drives Studio with: the owner API and the state stream, as the UI uses them.
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

export function connectStudio(app: AppProcess): Studio {
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

  return {
    async api<T>(method: string, path: string, body?: unknown): Promise<T> {
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
    },
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
      await until("a12s up after the restart", (state) => state.a12s === "up", 60_000);
    },
  };
}
