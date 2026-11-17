import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse, STATUS_CODES } from "node:http";
import { extname, join, normalize } from "node:path";
import type { Duplex } from "node:stream";
import { text } from "node:stream/consumers";
import { A12sError, type A12sErrorCode } from "../a12s/port.ts";
import { StudioError } from "../errors.ts";
import { ownerGate } from "./gate.ts";
import { type OwnerDeps, ownerRoutes, type Route } from "./routes.ts";

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

// a12s refusals the owner can act on keep their meaning; anything else is a failure of a12s.
const A12S_STATUS: Partial<Record<A12sErrorCode, number>> = { not_found: 404, asleep: 409, busy: 409 };

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(body));
}

// What any failure of a request answers, logged when it is not a refusal.
function failure(error: unknown, what: string): { status: number; body: unknown } {
  if (error instanceof StudioError) return { status: error.status, body: error };
  if (error instanceof A12sError) {
    const body = { code: error.code, message: `a12s: ${error.message}`, ...(error.fix ? { fix: error.fix } : {}) };
    return { status: A12S_STATUS[error.code] ?? 502, body };
  }
  console.error(`owner API ${what}:`, error);
  return { status: 500, body: { code: "internal", message: "Studio failed to answer.", fix: "See the app's log." } };
}

// A WebSocket request that is refused gets a plain HTTP answer on its connection, which is then closed.
function refuseUpgrade(socket: Duplex, status: number, body: unknown): void {
  const content = JSON.stringify(body);
  socket.end(
    `HTTP/1.1 ${status} ${STATUS_CODES[status]}\r\ncontent-type: application/json\r\n` +
      `content-length: ${Buffer.byteLength(content)}\r\nconnection: close\r\n\r\n${content}`,
  );
}

// The route for a method and a path under /api, with its decoded parameters.
function match(routes: Route[], method: string, path: string): { route: Route; params: string[] } {
  const matches = routes.filter((r) => r.path.test(path));
  const route = matches.find((r) => r.method === method);
  if (!route) {
    throw matches.length > 0
      ? new StudioError(405, "method", `${method} is not allowed on ${path}.`)
      : new StudioError(404, "not_found", `No route ${path}.`);
  }
  return { route, params: (route.path.exec(path) ?? []).slice(1).map((p) => decodeURIComponent(p)) };
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

// The owner listener (OWNER_PORT): the UI's files and /api. Every request, a WebSocket's included, passes ownerGate
// first. It never reads the caller header; agents are served only by the agent listener.
export function createOwnerServer(deps: OwnerDeps & { ownerLogin: string; webDir: string }): Server {
  const routes = ownerRoutes(deps);
  const server = createServer(async (req, res) => {
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
      const { route, params } = match(routes, method, path);
      if (!("run" in route)) {
        throw new StudioError(426, "upgrade", `${path} is a WebSocket.`, "Open it as a WebSocket.");
      }
      const body = method === "GET" ? undefined : await readBody(req);
      const answer = await route.run({ params, query: url.searchParams, body, res });
      if (!res.headersSent) json(res, 200, answer);
    } catch (error) {
      if (res.headersSent) return void res.end();
      const { status, body } = failure(error, `${method} ${req.url}`);
      json(res, status, body);
    }
  });
  server.on("upgrade", async (req, socket, head) => {
    socket.on("error", () => socket.destroy());
    try {
      const refused = ownerGate("GET", req.headers, deps.ownerLogin);
      if (refused) throw refused;
      const url = new URL(req.url ?? "/", "http://owner");
      const path = url.pathname.startsWith("/api/") ? url.pathname.slice(4) : url.pathname;
      const { route, params } = match(routes, req.method ?? "GET", path);
      if (!("socket" in route)) throw new StudioError(404, "not_found", `No WebSocket at ${path}.`);
      await route.socket({ params, query: url.searchParams, req, socket, head });
    } catch (error) {
      const { status, body } = failure(error, `upgrade ${req.url}`);
      if (socket.writable) refuseUpgrade(socket, status, body);
    }
  });
  return server;
}
