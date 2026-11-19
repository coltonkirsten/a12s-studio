import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import type { A12s } from "./a12s/port.ts";
import type { BrokerClient } from "./broker-client.ts";
import { resolveAddon, resolveCaller } from "./caller.ts";
import type { Dispatcher } from "./dispatcher.ts";
import { StudioError } from "./errors.ts";
import { sendAttachment } from "./files.ts";
import type { Live } from "./live.ts";
import type { Repo } from "./repo.ts";
import { text } from "./rules.ts";
import type { Runs } from "./runs.ts";
import type { Scheduler } from "./scheduler.ts";
import { mcpServer } from "./tools/mcp.ts";
import { CHUNK_MAX } from "./transcript.ts";

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

const usage = z.strictObject({ usd: z.number().gt(0).max(1000), note: z.string().trim().min(1).max(200) });
const USAGE_MAX = 4096;
const USAGE_FIX = "Send usd greater than 0 and at most 1000, and a note of 1 to 200 characters.";

const FILE = /^\/files\/([^/]+)\/([^/]+)$/;
const RULES = /^\/rules\/([^/]+)$/;
const TRANSCRIPT = /^\/transcripts\/(.+)$/;

// A request body up to `max` bytes; a longer one is refused before it is all read.
async function body(req: IncomingMessage, max: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > max) throw new StudioError(413, "too_large", `A body is at most ${max} bytes here.`, "Send less.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// The listener agents reach as the external Service `studio`. It serves no owner route.
export function createAgentServer(deps: {
  repo: Repo;
  a12s: A12s;
  broker: BrokerClient;
  dispatcher: Dispatcher;
  scheduler: Scheduler;
  live: Pick<Live, "agent">;
  runs: Runs;
  filesDir: string;
}): Server {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://studio");
      const path = url.pathname;
      if (req.method === "GET" && path === "/healthz") return json(res, 200, { ok: true });
      // Section 10.4: the one route an agent may not call. The team and add-on come from the caller's name.
      if (req.method === "POST" && path === "/usage") {
        const { teamId, addonId } = resolveAddon(deps.repo, req.headersDistinct);
        const raw = (await body(req, USAGE_MAX)).toString("utf8");
        const report = usage.safeParse(
          (() => {
            try {
              return JSON.parse(raw);
            } catch {
              return null;
            }
          })(),
        );
        if (!report.success) {
          throw new StudioError(400, "bad_request", "A report is { usd, note } only.", USAGE_FIX);
        }
        deps.repo.forTeam(teamId).insertUsage(addonId, report.data.usd, report.data.note, Date.now());
        await deps.dispatcher.run();
        return json(res, 200, { ok: true });
      }
      const caller = resolveCaller(deps.repo, req.headersDistinct);
      const file = req.method === "GET" ? FILE.exec(path) : null;
      if (file) {
        const [id, name] = file.slice(1).map((p) => decodeURIComponent(p));
        const message = deps.repo.forTeam(caller.teamId).message(id ?? "");
        return await sendAttachment(res, deps.filesDir, message, name ?? "");
      }
      const layer = req.method === "GET" ? RULES.exec(path)?.[1] : undefined;
      if (layer === "owner" || layer === "team" || layer === "role") {
        const body = text(layer, deps.repo.forTeam(caller.teamId), caller);
        return res.writeHead(200, { "content-type": "text/plain; charset=utf-8" }).end(body);
      }
      // The Stop hook's two calls (build-spec section 7.8).
      if (req.method === "GET" && path === "/transcripts") {
        return res.writeHead(200, { "content-type": "text/plain; charset=utf-8" }).end(deps.runs.sources(caller));
      }
      const transcript = req.method === "POST" ? TRANSCRIPT.exec(path)?.[1] : undefined;
      if (transcript !== undefined) {
        const offset = Number(url.searchParams.get("offset") || Number.NaN);
        if (!Number.isSafeInteger(offset) || offset < 0) {
          throw new StudioError(400, "bad_offset", "offset: not a byte count.", "Send ?offset=<bytes Studio holds>.");
        }
        const chunk = await body(req, CHUNK_MAX);
        return json(res, 200, { bytes: deps.runs.receive(caller, decodeURIComponent(transcript), offset, chunk) });
      }
      if (path !== "/mcp") throw new StudioError(404, "not_found", `No route ${path}.`);
      if (req.method !== "POST") throw new StudioError(405, "method", "Use POST for /mcp.");
      const team = deps.repo.forTeam(caller.teamId);
      const token = team.team()?.a12sToken;
      if (token === undefined) throw new StudioError(403, "no_caller", "Your team no longer exists.");
      const server = mcpServer({
        caller,
        turn: deps.live.agent(caller.agentId)?.turn?.id ?? null,
        team,
        a12s: deps.a12s.forTeam(token),
        broker: deps.broker.forTeam(caller.teamId),
        dispatcher: deps.dispatcher,
        scheduler: deps.scheduler,
        files: deps.filesDir,
      });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (error) {
      if (error instanceof StudioError) return json(res, error.status, error);
      console.error("agent API:", error);
      if (!res.headersSent) json(res, 500, { code: "internal", message: "Studio failed to answer." });
    }
  });
}
