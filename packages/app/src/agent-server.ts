import { createServer, type Server, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { A12s } from "./a12s/port.ts";
import { resolveCaller } from "./caller.ts";
import type { Dispatcher } from "./dispatcher.ts";
import { StudioError } from "./errors.ts";
import type { Repo } from "./repo.ts";
import { mcpServer } from "./tools/mcp.ts";

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

// The listener agents reach as the external Service `studio`. It serves no owner route.
export function createAgentServer(deps: { repo: Repo; a12s: A12s; dispatcher: Dispatcher }): Server {
  return createServer(async (req, res) => {
    try {
      const path = new URL(req.url ?? "/", "http://studio").pathname;
      if (req.method === "GET" && path === "/healthz") return json(res, 200, { ok: true });
      const caller = resolveCaller(deps.repo, req.headersDistinct);
      if (path !== "/mcp") throw new StudioError(404, "not_found", `No route ${path}.`);
      if (req.method !== "POST") throw new StudioError(405, "method", "Use POST for /mcp.");
      const team = deps.repo.forTeam(caller.teamId);
      const token = team.team()?.a12sToken;
      if (token === undefined) throw new StudioError(403, "no_caller", "Your team no longer exists.");
      const server = mcpServer({ caller, team, a12s: deps.a12s.forTeam(token), dispatcher: deps.dispatcher });
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
