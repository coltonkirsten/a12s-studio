import { createServer, type Server, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { A12s } from "./a12s/port.ts";
import type { BrokerClient } from "./broker-client.ts";
import { resolveCaller } from "./caller.ts";
import type { Dispatcher } from "./dispatcher.ts";
import { StudioError } from "./errors.ts";
import { sendAttachment } from "./files.ts";
import type { Repo } from "./repo.ts";
import type { Scheduler } from "./scheduler.ts";
import { mcpServer } from "./tools/mcp.ts";

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

const FILE = /^\/files\/([^/]+)\/([^/]+)$/;

// The listener agents reach as the external Service `studio`. It serves no owner route.
export function createAgentServer(deps: {
  repo: Repo;
  a12s: A12s;
  broker: BrokerClient;
  dispatcher: Dispatcher;
  scheduler: Scheduler;
  filesDir: string;
}): Server {
  return createServer(async (req, res) => {
    try {
      const path = new URL(req.url ?? "/", "http://studio").pathname;
      if (req.method === "GET" && path === "/healthz") return json(res, 200, { ok: true });
      const caller = resolveCaller(deps.repo, req.headersDistinct);
      const file = req.method === "GET" ? FILE.exec(path) : null;
      if (file) {
        const [id, name] = file.slice(1).map((p) => decodeURIComponent(p));
        const message = deps.repo.forTeam(caller.teamId).message(id ?? "");
        return await sendAttachment(res, deps.filesDir, message, name ?? "");
      }
      if (path !== "/mcp") throw new StudioError(404, "not_found", `No route ${path}.`);
      if (req.method !== "POST") throw new StudioError(405, "method", "Use POST for /mcp.");
      const team = deps.repo.forTeam(caller.teamId);
      const token = team.team()?.a12sToken;
      if (token === undefined) throw new StudioError(403, "no_caller", "Your team no longer exists.");
      const server = mcpServer({
        caller,
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
