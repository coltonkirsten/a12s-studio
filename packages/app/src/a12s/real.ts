import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { text } from "node:stream/consumers";
import { teamPrefix } from "@a12s-studio/contract/names";
import type {
  EnqueueResponse,
  InboxListResponse,
  A12sEvent as SdkEvent,
  Phase as SdkPhase,
  StatusResponse,
  Token,
  TurnsResponse,
} from "@coltonkirsten/a12s";
import {
  type A12s,
  A12sError,
  type A12sErrorCode,
  type A12sEvent,
  type FileResponse,
  type ModelCosts,
  type Phase,
  type TeamA12s,
  type Terminal,
  type TurnRecord,
} from "./port.ts";

export type Controller = { url: string; token: string };

// `a12s up` writes the owner's connection here; the port survives Controller restarts.
export function readController(fleet: string): Controller {
  const file = join(homedir(), ".a12s", fleet, "controller.json");
  let content: string;
  try {
    content = readFileSync(file, "utf8");
  } catch (error) {
    throw new Error(`cannot read ${file}: ${String(error)}. Start the Fleet ${fleet} with a12s up.`);
  }
  let port: unknown;
  let token: unknown;
  try {
    ({ port, token } = JSON.parse(content));
  } catch {
    // The parser's own message quotes the file, which holds the owner token.
    throw new Error(`${file} is not a JSON object.`);
  }
  if (typeof port !== "number" || typeof token !== "string") throw new Error(`${file} has no port or token.`);
  return { url: `http://127.0.0.1:${port}`, token };
}

const CODES = new Map<string, A12sErrorCode>(
  Object.entries({
    not_found: "not_found",
    unknown_request: "not_found",
    exists: "exists",
    in_use: "in_use",
    busy: "busy",
    conflict: "busy",
    not_idle: "busy",
    // Withdrawing a Message that already ended or was taken: it is no longer pending.
    withdrawn: "busy",
    discarded: "busy",
    expired: "busy",
    replaced: "busy",
    already_claimed: "busy",
    already_delivered: "busy",
    no_grant: "no_grant",
    forbidden: "forbidden",
    unauthorized: "forbidden",
    out_of_prefix: "out_of_prefix",
    version_mismatch: "version_mismatch",
    inbox_full: "inbox_full",
    asleep: "asleep",
  }),
);

// a12s refuses with `{ code, message, fix? }`; anything else is not a12s talking.
export function refusal(status: number, body: string): A12sError {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    parsed = null;
  }
  const { code, message, fix } = (typeof parsed === "object" && parsed !== null ? parsed : {}) as Record<
    string,
    unknown
  >;
  if (typeof code !== "string" || typeof message !== "string") {
    return new A12sError("other", `a12s answered ${status}: ${body.slice(0, 200)}`);
  }
  return new A12sError(CODES.get(code) ?? "other", message, typeof fix === "string" ? fix : undefined);
}

function unreachable(): A12sError {
  return new A12sError("unreachable", "a12s is not answering.", "Start Docker; the Fleet's Controller starts with it.");
}

const ms = (iso: string): number => Date.parse(iso);

// Only Services are Unhealthy; the SDK shares one Phase type between them and agent computers.
function phaseOf(phase: SdkPhase): Phase {
  return phase === "Unhealthy" ? "Error" : phase;
}

// modelUsage is the only cost figure that counts sub-agents. A Turn that never reached the harness has no usage.
export function modelCostsUsd(usage: unknown): ModelCosts {
  const costs: ModelCosts = {};
  const { modelUsage } = (typeof usage === "object" && usage !== null ? usage : {}) as { modelUsage?: unknown };
  if (typeof modelUsage !== "object" || modelUsage === null) return costs;
  for (const [model, used] of Object.entries(modelUsage)) {
    const cost = (used as { costUSD?: unknown } | null)?.costUSD;
    if (typeof cost === "number") costs[model] = cost;
  }
  return costs;
}

// The SDK types a session as a string, but a12s sends null for a Turn that ended before the harness started one.
const sessionOf = (session: string | null): string | null => session || null;

// a12s marks an event outside any Turn with an empty one.
const turnOf = (turn: string): { turn?: string } => (turn ? { turn } : {});

export function toEvent(ev: SdkEvent): A12sEvent | null {
  const agent = ev.agentComputer ?? "";
  const at = ms(ev.ts);
  switch (ev.type) {
    case "agent_computer.phase": {
      const error = ev.data.error?.reason;
      return { type: ev.type, agent, at, phase: phaseOf(ev.data.phase), ...(error ? { error } : {}) };
    }
    case "turn.started":
    case "turn.steered":
      return { type: ev.type, agent, at, turn: ev.turn, messageIds: (ev.data.inbox?.messages ?? []).map((m) => m.id) };
    case "text.delta":
      return { type: ev.type, agent, at, turn: ev.turn, text: ev.data.text };
    case "thinking":
      return { type: ev.type, agent, at, turn: ev.turn };
    case "tool.composing":
      return { type: ev.type, agent, at, turn: ev.turn, id: ev.data.id, name: ev.data.name };
    case "tool.started": {
      const { id, name, input, parent } = ev.data;
      return { type: ev.type, agent, at, ...turnOf(ev.turn), id, name, input, ...(parent ? { parent } : {}) };
    }
    case "tool.finished": {
      const { id, name, isError, output, parent } = ev.data;
      return { type: ev.type, agent, at, ...turnOf(ev.turn), id, name, isError, output, ...(parent ? { parent } : {}) };
    }
    case "task.started": {
      const { id, kind, description, toolUseId } = ev.data;
      return {
        type: ev.type,
        agent,
        at,
        ...turnOf(ev.turn),
        id,
        kind,
        description,
        ...(toolUseId ? { toolUseId } : {}),
      };
    }
    case "task.finished":
      return { type: ev.type, agent, at, id: ev.data.id };
    case "turn.finished": {
      const { status, error, usage, tokens } = ev.data;
      return {
        type: ev.type,
        agent,
        at,
        turn: ev.turn,
        session: sessionOf(ev.session),
        status,
        ...(error ? { error } : {}),
        modelCostsUsd: modelCostsUsd(usage),
        ...(tokens ? { tokens } : {}),
      };
    }
    default:
      return null;
  }
}

function toTurn(t: TurnsResponse["turns"][number]): TurnRecord {
  return {
    id: t.id,
    agent: t.agentComputer,
    session: sessionOf(t.session),
    status: t.status,
    ...(t.error ? { error: t.error } : {}),
    text: t.text,
    messages: t.messages.map((m) => ({ id: m.id, steered: m.steered === true })),
    tools: t.tools.map((call) => ({ name: call.name, isError: call.isError === true })),
    ...(t.startedAt ? { startedAt: ms(t.startedAt) } : {}),
    finishedAt: ms(t.finishedAt),
    modelCostsUsd: modelCostsUsd(t.usage),
    ...(t.tokens ? { tokens: t.tokens } : {}),
  };
}

type RawFile = {
  path: string;
  kind: "dir" | "file";
  entries?: { name: string; kind: "file" | "dir" | "link" | "other"; size: number; modTime: string }[];
  size?: number;
  modTime?: string;
  encoding?: "utf-8" | "base64";
  content?: string;
  truncated?: boolean;
};

function toFile(f: RawFile): FileResponse {
  if (f.kind === "dir") {
    return { kind: "dir", path: f.path, entries: (f.entries ?? []).map((e) => ({ ...e, modTime: ms(e.modTime) })) };
  }
  return {
    kind: "file",
    path: f.path,
    size: f.size ?? 0,
    modTime: f.modTime ? ms(f.modTime) : 0,
    encoding: f.encoding ?? "utf-8",
    content: f.content ?? "",
    truncated: f.truncated ?? false,
  };
}

// What an a12s event stream says: "head" once everything journaled before the request has been sent, "gap" where
// events were lost, and the events themselves. a12s ends lines with "\n" and frames with a blank line; a frame with
// neither an event name nor data is its keepalive.
export async function* streamEvents(
  chunks: AsyncIterable<string> | Iterable<string>,
): AsyncGenerator<A12sEvent | "head"> {
  let buffer = "";
  for await (const chunk of chunks) {
    const frames = (buffer + chunk).split("\n\n");
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      const lines = frame.split("\n");
      const name = lines.find((line) => line.startsWith("event: "))?.slice(7);
      const data = lines.filter((line) => line.startsWith("data: ")).map((line) => line.slice(6));
      if (name === "head") yield "head";
      else if (name === "gap") yield { type: "gap" };
      else if (!name && data.length > 0) {
        const event = toEvent(JSON.parse(data.join("\n")) as SdkEvent);
        if (event) yield event;
      }
    }
  }
}

// a12s never ends an event stream itself, so its end, like a failed read, is a lost connection.
async function* received(body: Response["body"]): AsyncGenerator<string> {
  try {
    if (body) yield* body.pipeThrough(new TextDecoderStream());
  } catch {
    throw unreachable();
  }
  throw unreachable();
}

type Init = {
  body?: string | Uint8Array<ArrayBuffer>;
  headers?: Record<string, string>;
  signal?: AbortSignal | undefined;
};

export function realA12s(owner: Controller): A12s {
  const enc = encodeURIComponent;
  const computer = (name: string, rest = "") => `/v1/agent-computers/${enc(name)}${rest}`;

  // Every fetch to a12s. fetch and a body read fail only when a12s stops answering.
  async function send(token: string, method: string, path: string, init: Init = {}): Promise<Response> {
    let res: Response;
    let refused = "";
    try {
      res = await fetch(owner.url + path, {
        ...init,
        method,
        headers: { ...init.headers, authorization: `Bearer ${token}` },
      });
      if (!res.ok) refused = await res.text();
    } catch {
      throw unreachable();
    }
    if (!res.ok) throw refusal(res.status, refused);
    return res;
  }

  async function call<T>(token: string, method: string, path: string, body?: unknown, headers = {}): Promise<T> {
    const init =
      body === undefined
        ? { headers }
        : { body: JSON.stringify(body), headers: { ...headers, "content-type": "application/json" } };
    const answer = await (await send(token, method, path, init)).text();
    return (answer ? JSON.parse(answer) : undefined) as T;
  }

  async function* stream(token: string, path: string, signal?: AbortSignal): AsyncGenerator<A12sEvent | "head"> {
    const res = await send(token, "GET", path, { signal });
    yield* streamEvents(received(res.body));
  }

  function forTeam(token: string): TeamA12s {
    const team = <T>(method: string, path: string, body?: unknown) => call<T>(token, method, path, body);

    return {
      async removeAgent(name) {
        await team("DELETE", computer(name));
      },
      async send(name, message) {
        const sent = await team<EnqueueResponse>("POST", computer(name, "/inbox"), { ...message, sender: "studio" });
        return { id: sent.id, state: sent.state };
      },
      async wake(name) {
        await team("POST", computer(name, "/power"), { state: "awake" });
      },
      async sleep(name) {
        await team("POST", computer(name, "/power"), { state: "asleep" });
      },
      async stop(name) {
        await team("POST", computer(name, "/stop"), {});
      },
      async status() {
        const status = await team<StatusResponse>("GET", "/v1/status");
        return status.agentComputers.map((c) => ({
          name: c.name,
          phase: phaseOf(c.phase),
          ...(c.error ? { error: c.error.reason } : {}),
          pending: c.inbox?.pending ?? 0,
          background: (c.background?.items ?? []).map((item) => ({
            id: item.id,
            kind: item.kind,
            description: item.description,
            startedAt: ms(item.startedAt),
            ...(item.toolUseId ? { toolUseId: item.toolUseId } : {}),
          })),
        }));
      },
      async inbox(name) {
        const box = await team<InboxListResponse>("GET", computer(name, "/inbox?state=all&bodies=true"));
        return box.messages.map((m) => ({
          id: m.id,
          state: m.state,
          sender: m.sender,
          via: m.via,
          body: m.body ?? "",
          metadata: m.metadata ?? {},
          ...(m.replaceKey ? { replaceKey: m.replaceKey } : {}),
          createdAt: ms(m.createdAt),
          ...(m.turn ? { turn: m.turn } : {}),
        }));
      },
      async withdraw(name, messageId) {
        await team("DELETE", computer(name, `/inbox/${enc(messageId)}`));
      },
      async clearInbox(name) {
        await team("POST", computer(name, "/inbox/clear"), {});
      },
      async turns(name, limit) {
        const { turns } = await team<TurnsResponse>("GET", computer(name, `/turns?limit=${limit}`));
        return turns.map(toTurn);
      },
      async *turnEvents(name, turn) {
        // a12s holds the replay open for what the Turn does next; "head" marks the end of what it has done.
        for await (const event of stream(token, computer(name, `/events?turn=${enc(turn)}`))) {
          if (event === "head") return;
          yield event;
        }
      },
      async readFile(name, path) {
        return toFile(await team<RawFile>("GET", computer(name, `/files?path=${enc(path)}`)));
      },
      async writeFile(name, path, content) {
        // fetch takes no view over a shared buffer, which the port's type allows, so the bytes are copied.
        await send(token, "PUT", computer(name, `/files?path=${enc(path)}`), { body: new Uint8Array(content) });
      },
      // fetch cannot follow an HTTP/1.1 Upgrade, so the terminal is the one call on node:http.
      openTerminal(name, size) {
        const url = new URL(owner.url);
        const { promise, resolve, reject } = Promise.withResolvers<Terminal>();
        const req = httpRequest({
          host: url.hostname,
          port: url.port,
          path: computer(name, `/terminal?rows=${size.rows}&cols=${size.cols}`),
          headers: { authorization: `Bearer ${token}`, connection: "Upgrade", upgrade: "a12s-terminal" },
        });
        req.on("upgrade", (res, socket, head) => {
          if (head.length > 0) socket.unshift(head);
          const id = String(res.headers["a12s-terminal"]);
          resolve({
            stream: socket,
            async resize(rows, cols) {
              await team("POST", computer(name, `/terminal/${enc(id)}/resize`), { rows, cols });
            },
          });
        });
        req.on("response", (res) => {
          text(res).then(
            (body) => reject(refusal(res.statusCode ?? 0, body)),
            () => reject(unreachable()),
          );
        });
        req.on("error", () => reject(unreachable()));
        req.end();
        return promise;
      },
    };
  }

  return {
    async ensureServices(services) {
      for (const s of services) {
        const port = { port: s.port, ...(s.mcpPath ? { mcp: { path: s.mcpPath } } : {}) };
        const health = s.healthPath ? { health: { http: { port: s.port, path: s.healthPath } } } : {};
        await call(owner.token, "PUT", `/v1/services/${enc(s.name)}`, {
          external: { host: s.host },
          manifest: { ports: { [s.mcpPath ? "mcp" : "http"]: port }, ...health },
        });
      }
    },
    async createToken(team) {
      const token = await call<Token>(owner.token, "POST", "/v1/tokens", { name: team, prefix: teamPrefix(team) });
      if (!token.secret) throw new A12sError("other", `a12s returned no secret for the token ${team}.`);
      return token.secret;
    },
    async removeToken(team) {
      try {
        await call(owner.token, "DELETE", `/v1/tokens/${enc(team)}`);
      } catch (error) {
        // Deleting a team retries its steps after a failure, so a token already gone is done.
        if (!(error instanceof A12sError && error.code === "not_found")) throw error;
      }
    },
    async putAgent(name, spec, mode) {
      await call(owner.token, "PUT", computer(name), spec, mode === "create" ? { "if-none-match": "*" } : {});
    },
    events() {
      const closing = new AbortController();
      const events = stream(owner.token, "/v1/events", closing.signal);
      // Asked for no earlier events, a12s answers "head" first, after it has subscribed the connection.
      let head: Promise<unknown> | undefined;
      const connect = () => {
        head ??= events.next();
        return head;
      };
      return {
        ready: async () => {
          await connect();
        },
        close: () => closing.abort(),
        async *[Symbol.asyncIterator]() {
          try {
            await connect();
            for await (const event of events) if (event !== "head") yield event;
          } catch (error) {
            if (!closing.signal.aborted) throw error;
          }
        },
      };
    },
    forTeam,
  };
}
