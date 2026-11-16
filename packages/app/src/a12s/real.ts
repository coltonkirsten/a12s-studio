import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { teamPrefix } from "@a12s-studio/contract/names";
import {
  type EnqueueResponse,
  Fleet,
  type InboxListResponse,
  A12sError as SdkError,
  type A12sEvent as SdkEvent,
  type Phase as SdkPhase,
  type StatusResponse,
  type Token,
  type TurnsResponse,
} from "@coltonkirsten/a12s";
import {
  type A12s,
  A12sError,
  type A12sErrorCode,
  type A12sEvent,
  type FileResponse,
  type Phase,
  type TeamA12s,
  type TurnRecord,
} from "./port.ts";

export type Controller = { url: string; token: string };

// `a12s up` writes the owner's connection here; the port survives Controller restarts.
export function readController(fleet: string): Controller {
  const file = join(homedir(), ".a12s", fleet, "controller.json");
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`cannot read ${file}: ${String(error)}. Start the Fleet ${fleet} with a12s up.`);
  }
  const { port, token } = (raw ?? {}) as Record<string, unknown>;
  if (typeof port !== "number" || typeof token !== "string") throw new Error(`${file} has no port or token.`);
  return { url: `http://127.0.0.1:${port}`, token };
}

const CODES: Record<string, A12sErrorCode> = {
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
};

const UNREACHABLE = new Set(["ECONNREFUSED", "ECONNRESET", "UND_ERR_SOCKET"]);

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
}

// a12s refusals and a Controller that is not there become the port's error; anything else is a bug and stays as is.
export function portError(error: unknown): unknown {
  if (error instanceof A12sError) return error;
  if (error instanceof SdkError) {
    const message = error.message.replace(`${error.code}: `, "").replace(`  fix: ${error.fix}`, "");
    return new A12sError(CODES[error.code] ?? "other", message, error.fix);
  }
  const cause = error instanceof Error ? error.cause : undefined;
  if (UNREACHABLE.has(String(errorCode(error))) || UNREACHABLE.has(String(errorCode(cause)))) {
    return new A12sError(
      "unreachable",
      "a12s is not answering.",
      "Start Docker; the Fleet's Controller starts with it.",
    );
  }
  return error;
}

async function failure(res: Response): Promise<A12sError> {
  const text = await res.text();
  try {
    const body = JSON.parse(text) as { code: string; message: string; fix?: string };
    return new A12sError(CODES[body.code] ?? "other", body.message, body.fix);
  } catch {
    return new A12sError("other", `a12s answered ${res.status}: ${text.slice(0, 200)}`);
  }
}

const ms = (iso: string): number => Date.parse(iso);

// Only Services are Unhealthy; an agent computer reported so is treated as broken.
function phaseOf(phase: SdkPhase): Phase {
  return phase === "Unhealthy" ? "Error" : phase;
}

// modelUsage is the only figure that counts sub-agents; like costUsd it is the session's running total.
export function costTotalUsd(usage: unknown): number {
  if (typeof usage !== "object" || usage === null) return 0;
  const { modelUsage, costUsd } = usage as { modelUsage?: unknown; costUsd?: unknown };
  if (typeof modelUsage !== "object" || modelUsage === null) return typeof costUsd === "number" ? costUsd : 0;
  let total = 0;
  for (const model of Object.values(modelUsage)) {
    const cost = (model as { costUSD?: unknown } | null)?.costUSD;
    if (typeof cost === "number") total += cost;
  }
  return total;
}

export function toEvent(ev: SdkEvent): A12sEvent | null {
  const agent = ev.agentComputer ?? "";
  const at = ms(ev.ts);
  switch (ev.type) {
    case "agent_computer.phase": {
      const error = ev.data.error?.reason ?? (ev.data.phase === "Unhealthy" ? "Unhealthy" : undefined);
      return { type: ev.type, agent, at, phase: phaseOf(ev.data.phase), ...(error ? { error } : {}) };
    }
    case "turn.started":
      return {
        type: ev.type,
        agent,
        at,
        turn: ev.turn,
        // A new session has no id until its first Turn ends: a12s sends null here.
        session: ev.session ?? "",
        messageIds: (ev.data.inbox?.messages ?? []).map((m) => m.id),
      };
    case "text.delta":
      return { type: ev.type, agent, at, turn: ev.turn, text: ev.data.text };
    case "tool.started": {
      const { id, name, input, parent } = ev.data;
      return { type: ev.type, agent, at, turn: ev.turn, id, name, input, ...(parent ? { parent } : {}) };
    }
    case "tool.finished": {
      const { id, name, isError, output, parent } = ev.data;
      return { type: ev.type, agent, at, turn: ev.turn, id, name, isError, output, ...(parent ? { parent } : {}) };
    }
    case "turn.finished": {
      const { status, error, usage, tokens } = ev.data;
      return {
        type: ev.type,
        agent,
        at,
        turn: ev.turn,
        session: ev.session,
        status,
        ...(error ? { error } : {}),
        costTotalUsd: costTotalUsd(usage),
        ...(tokens ? { tokens } : {}),
      };
    }
    case "gap":
      return { type: "gap" };
    default:
      return null;
  }
}

function toTurn(agent: string, t: TurnsResponse["turns"][number]): TurnRecord {
  return {
    id: t.id,
    agent: t.agentComputer || agent,
    session: t.session,
    status: t.status,
    ...(t.error ? { error: t.error } : {}),
    text: t.text,
    messageIds: t.messages.map((m) => m.id),
    ...(t.startedAt ? { startedAt: ms(t.startedAt) } : {}),
    finishedAt: ms(t.finishedAt),
    costTotalUsd: costTotalUsd(t.usage),
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

// A tiny SSE reader for one Turn's replay: the SDK retries a 503 asleep forever, and an owner route must answer.
async function* sseEvents(res: Response): AsyncGenerator<SdkEvent> {
  if (!res.body) return;
  let buffer = "";
  for await (const chunk of res.body.pipeThrough(new TextDecoderStream())) {
    buffer += chunk.replaceAll("\r\n", "\n");
    let end = buffer.indexOf("\n\n");
    while (end !== -1) {
      const frame = buffer.slice(0, end).split("\n");
      buffer = buffer.slice(end + 2);
      end = buffer.indexOf("\n\n");
      const event = frame
        .find((line) => line.startsWith("event:"))
        ?.slice(6)
        .trim();
      const data = frame
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (event === "gap")
        yield { v: 1, session: "", turn: "", seq: 0, ts: new Date().toISOString(), type: "gap", data: {} };
      else if (!event && data) yield JSON.parse(data) as SdkEvent;
    }
  }
}

export function realA12s(owner: Controller): A12s {
  const ownerFleet = new Fleet(owner);
  const enc = encodeURIComponent;
  const computer = (name: string, rest = "") => `/v1/agent-computers/${enc(name)}${rest}`;

  async function call<T>(fleet: Fleet, method: string, path: string, body?: unknown, headers?: Record<string, string>) {
    try {
      return await fleet.client.request<T>(method, path, body, headers ? { headers } : {});
    } catch (error) {
      throw portError(error);
    }
  }

  async function fetchRaw(token: string, method: string, path: string, body?: Uint8Array): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(owner.url + path, {
        method,
        headers: { authorization: `Bearer ${token}` },
        ...(body ? { body: new Uint8Array(body) } : {}),
      });
    } catch (error) {
      throw portError(error);
    }
    if (!res.ok) throw await failure(res);
    return res;
  }

  function forTeam(token: string): TeamA12s {
    const fleet = new Fleet({ url: owner.url, token });
    const team = <T>(method: string, path: string, body?: unknown) => call<T>(fleet, method, path, body);

    return {
      async removeAgent(name) {
        await team("DELETE", computer(name));
      },
      async send(name, message) {
        const sent = await team<EnqueueResponse>("POST", computer(name, "/inbox"), {
          ...message,
          sender: "studio",
          idempotencyKey: randomUUID(),
        });
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
        return turns.map((t) => toTurn(name, t));
      },
      async *turnEvents(name, turn) {
        const res = await fetchRaw(token, "GET", computer(name, `/events?turn=${enc(turn)}`));
        try {
          // The replay stays open after the Turn, waiting for more: stop at its end.
          for await (const ev of sseEvents(res)) {
            const event = toEvent(ev);
            if (event && (!("turn" in event) || event.turn === turn)) yield event;
            if (ev.type === "turn.finished" && ev.turn === turn) return;
          }
        } catch (error) {
          throw portError(error);
        } finally {
          await res.body?.cancel().catch(() => {});
        }
      },
      async readFile(name, path) {
        return toFile(await team<RawFile>("GET", computer(name, `/files?path=${enc(path)}`)));
      },
      async writeFile(name, path, content) {
        await fetchRaw(token, "PUT", computer(name, `/files?path=${enc(path)}`), content);
      },
      openTerminal(name, size) {
        const url = new URL(owner.url);
        const { promise, resolve, reject } = Promise.withResolvers<Awaited<ReturnType<TeamA12s["openTerminal"]>>>();
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
        req.on("response", async (res) => {
          const chunks: Buffer[] = [];
          for await (const chunk of res) chunks.push(chunk as Buffer);
          reject(await failure(new Response(Buffer.concat(chunks), { status: res.statusCode ?? 500 })));
        });
        req.on("error", (error) => reject(portError(error)));
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
        await call(ownerFleet, "PUT", `/v1/services/${enc(s.name)}`, {
          external: { host: s.host },
          manifest: { ports: { [s.mcpPath ? "mcp" : "http"]: port }, ...health },
        });
      }
    },
    async createToken(team) {
      const token = await call<Token>(ownerFleet, "POST", "/v1/tokens", { name: team, prefix: teamPrefix(team) });
      if (!token.secret) throw new A12sError("other", `a12s returned no secret for the token ${team}.`);
      return token.secret;
    },
    async removeToken(team) {
      try {
        await call(ownerFleet, "DELETE", `/v1/tokens/${enc(team)}`);
      } catch (error) {
        // Deleting a team retries its steps after a failure, so a token already gone is done.
        if (!(error instanceof A12sError && error.code === "not_found")) throw error;
      }
    },
    async putAgent(name, spec, mode) {
      await call(ownerFleet, "PUT", computer(name), spec, mode === "create" ? { "if-none-match": "*" } : undefined);
    },
    events() {
      const stream = ownerFleet.events();
      return {
        ready: async () => {
          try {
            await stream.ready();
          } catch (error) {
            throw portError(error);
          }
        },
        close: () => stream.close(),
        async *[Symbol.asyncIterator]() {
          try {
            for await (const ev of stream) {
              const event = toEvent(ev);
              if (event) yield event;
            }
          } catch (error) {
            throw portError(error);
          } finally {
            stream.close();
          }
        },
      };
    },
    forTeam,
  };
}
