import type { Duplex } from "node:stream";
import { type WebSocket, WebSocketServer } from "ws";
import { A12sError, type TeamA12s } from "../a12s/port.ts";
import type { Upgrade } from "./routes.ts";

const DEFAULT_SIZE = { rows: 24, cols: 80 };
// What a terminal sends one keystroke or paste at a time; a larger frame is refused by the WebSocket.
const FRAME_MAX = 64 * 1024;

const sockets = new WebSocketServer({ noServer: true, clientTracking: false, maxPayload: FRAME_MAX });

// The size the terminal opens at, from the URL; 24 rows of 80 when it names none that fits.
function size(query: URLSearchParams): { rows: number; cols: number } {
  const rows = Number(query.get("rows"));
  const cols = Number(query.get("cols"));
  const ok = (n: number) => Number.isInteger(n) && n >= 1 && n <= 500;
  return ok(rows) && ok(cols) ? { rows, cols } : DEFAULT_SIZE;
}

// The browser's WebSocket joined to a12s's terminal for the agent. The caller has passed ownerGate and found the
// agent in its team. Closing either side closes the other.
export async function bridgeTerminal(client: TeamA12s, agent: string, upgrade: Upgrade): Promise<void> {
  const { req, socket, head, query } = upgrade;
  const browser = await new Promise<WebSocket>((resolve) => sockets.handleUpgrade(req, socket, head, resolve));
  // A frame the WebSocket refuses (too large, malformed) closes it; with no listener it would stop the app.
  browser.on("error", () => browser.terminate());
  // What is typed before a12s has opened the terminal waits for it.
  browser.pause();
  let stream: Duplex;
  try {
    ({ stream } = await client.openTerminal(agent, size(query)));
  } catch (error) {
    browser.resume();
    browser.close(1011, error instanceof A12sError ? error.code : "other");
    if (!(error instanceof A12sError)) console.error(`terminal for ${agent}:`, error);
    return;
  }
  if (browser.readyState !== browser.OPEN) return void stream.destroy();
  stream.on("data", (chunk: Buffer) => browser.send(chunk));
  stream.on("close", () => browser.close());
  stream.on("error", () => browser.close(1011, "unreachable"));
  browser.on("close", () => stream.destroy());
  browser.on("message", (data) => stream.write(data as Buffer));
  browser.resume();
}
