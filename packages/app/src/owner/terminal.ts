import type { TerminalResize } from "@a12s-studio/contract/api";
import { type WebSocket, WebSocketServer } from "ws";
import { A12sError, type TeamA12s, type Terminal } from "../a12s/port.ts";
import type { Upgrade } from "./routes.ts";

const DEFAULT_SIZE = { rows: 24, cols: 80 };
// What a terminal sends one keystroke or paste at a time; a larger frame is refused by the WebSocket.
const FRAME_MAX = 64 * 1024;

const sockets = new WebSocketServer({ noServer: true, clientTracking: false, maxPayload: FRAME_MAX });

function size(rows: unknown, cols: unknown): TerminalResize | null {
  const ok = (n: unknown) => Number.isInteger(n) && (n as number) >= 1 && (n as number) <= 500;
  return ok(rows) && ok(cols) ? { rows: rows as number, cols: cols as number } : null;
}

function resize(text: string): TerminalResize | null {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null
      ? size(Reflect.get(value, "rows"), Reflect.get(value, "cols"))
      : null;
  } catch {
    return null;
  }
}

// The browser's WebSocket joined to a12s's terminal for the agent. The caller has passed ownerGate and found the
// agent in its team. Closing either side closes the other.
export async function bridgeTerminal(client: TeamA12s, agent: string, upgrade: Upgrade): Promise<void> {
  const { req, socket, head, query } = upgrade;
  const browser = await new Promise<WebSocket>((resolve) => sockets.handleUpgrade(req, socket, head, resolve));
  const start = size(Number(query.get("rows")), Number(query.get("cols"))) ?? DEFAULT_SIZE;
  let terminal: Terminal;
  try {
    terminal = await client.openTerminal(agent, start);
  } catch (error) {
    browser.close(1011, error instanceof A12sError ? error.code : "other");
    if (!(error instanceof A12sError)) console.error(`terminal for ${agent}:`, error);
    return;
  }
  const { stream } = terminal;
  if (browser.readyState !== browser.OPEN) return void stream.destroy();
  stream.on("data", (chunk: Buffer) => browser.send(chunk));
  stream.on("close", () => browser.close());
  stream.on("error", () => browser.close(1011, "unreachable"));
  browser.on("close", () => stream.destroy());
  browser.on("message", (data, binary) => {
    if (binary) return void stream.write(data as Buffer);
    const next = resize(data.toString());
    if (next) terminal.resize(next.rows, next.cols).catch((error) => console.error(`resize for ${agent}:`, error));
  });
}
