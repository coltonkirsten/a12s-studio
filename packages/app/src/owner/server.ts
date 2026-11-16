import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import { text } from "node:stream/consumers";
import { A12sError } from "../a12s/port.ts";
import { StudioError } from "../errors.ts";
import { ownerGate } from "./gate.ts";
import { type OwnerDeps, ownerRoutes } from "./routes.ts";

const BODY_LIMIT = 256 * 1024;
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".woff2": "font/woff2",
};

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  if (Number(req.headers["content-length"] ?? 0) > BODY_LIMIT) {
    throw new StudioError(413, "too_large", "The request body is too large.", "Send less than 256 KB.");
  }
  const raw = await text(req);
  if (raw === "") return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new StudioError(400, "bad_json", "The request body is not JSON.", "Send a JSON object.");
  }
}

// The built web app; any path that is not a file is the app's own route, so it gets index.html.
async function serveStatic(res: ServerResponse, webDir: string, path: string): Promise<void> {
  const file = normalize(join(webDir, decodeURIComponent(path)));
  const inside = file.startsWith(join(webDir, "/")) && extname(file) !== "";
  const content = inside ? await readFile(file).catch(() => null) : null;
  if (content) {
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" }).end(content);
    return;
  }
  const index = await readFile(join(webDir, "index.html")).catch(() => null);
  if (!index) {
    throw new StudioError(503, "no_web", `The web app is not built (${webDir}).`, "Run npm run build.");
  }
  res.writeHead(200, { "content-type": TYPES[".html"], "cache-control": "no-cache" }).end(index);
}

// The owner listener (OWNER_PORT): the UI's files and /api. Every request passes ownerGate first. It never reads the
// caller header; agents are served only by the agent listener.
export function createOwnerServer(deps: OwnerDeps & { ownerLogin: string; webDir: string }): Server {
  const routes = ownerRoutes(deps);
  return createServer(async (req, res) => {
    const method = req.method ?? "GET";
    try {
      const refused = ownerGate(method, req.headers, deps.ownerLogin);
      if (refused) throw refused;
      const url = new URL(req.url ?? "/", "http://owner");
      if (!url.pathname.startsWith("/api/")) {
        if (method !== "GET" && method !== "HEAD") throw new StudioError(405, "method", `Use GET for ${url.pathname}.`);
        return await serveStatic(res, deps.webDir, url.pathname);
      }
      const path = url.pathname.slice(4);
      const matches = routes.filter((r) => r.path.test(path));
      const route = matches.find((r) => r.method === method);
      if (!route) {
        throw matches.length > 0
          ? new StudioError(405, "method", `${method} is not allowed on ${path}.`)
          : new StudioError(404, "not_found", `No route ${path}.`);
      }
      const params = (route.path.exec(path) ?? []).slice(1).map((p) => decodeURIComponent(p));
      const body = method === "GET" ? undefined : await readBody(req);
      const answer = await route.run({ params, query: url.searchParams, body, res });
      if (!res.headersSent) json(res, 200, answer);
    } catch (error) {
      if (res.headersSent) return void res.end();
      if (error instanceof StudioError) return json(res, error.status, error);
      if (error instanceof A12sError) {
        return json(res, 502, {
          code: error.code,
          message: `a12s: ${error.message}`,
          ...(error.fix ? { fix: error.fix } : {}),
        });
      }
      console.error(`owner API ${method} ${req.url}:`, error);
      json(res, 500, { code: "internal", message: "Studio failed to answer.", fix: "See the app's log." });
    }
  });
}
