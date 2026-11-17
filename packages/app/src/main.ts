import { mkdirSync, readFileSync } from "node:fs";
import type { Server } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BROKER_PORT, OWNER_PORT, STUDIO_PORT } from "@a12s-studio/contract/names";
import type { ExternalService } from "./a12s/port.ts";
import { type Controller, readController, realA12s } from "./a12s/real.ts";
import { createApp } from "./app.ts";
import { openDb } from "./db.ts";

type Config = { ownerLogin: string; fleet: string };

function fail(message: string, fix: string): never {
  console.error(`a12s Studio cannot start: ${message}\nFix: ${fix}`);
  process.exit(1);
}

function loadConfig(file: string): Config {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    fail(`cannot read ${file}: ${String(error)}.`, "Run scripts/setup.sh, or set STUDIO_HOME.");
  }
  if (typeof raw !== "object" || raw === null) fail(`${file} is not a JSON object.`, "Run scripts/setup.sh.");
  const { ownerLogin, fleet } = raw as Record<string, unknown>;
  if (typeof ownerLogin !== "string" || ownerLogin === "") {
    fail(`${file} has no "ownerLogin".`, 'Add "ownerLogin": your Tailscale login.');
  }
  if (typeof fleet !== "string" || fleet === "") fail(`${file} has no "fleet".`, 'Add "fleet": "studio".');
  return { ownerLogin, fleet };
}

const home = process.env.STUDIO_HOME ?? join(homedir(), ".a12s-studio");
const config = loadConfig(join(home, "config.json"));
let controller: Controller;
try {
  controller = readController(config.fleet);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error), "Run scripts/setup.sh, which starts the Fleet once.");
}
mkdirSync(join(home, "app"), { recursive: true, mode: 0o700 });
const dbFile = join(home, "app", "studio.db");
const db = openDb(dbFile);
const a12s = realA12s(controller);
const app = createApp({
  db,
  a12s,
  brokerSocket: join(home, "broker", "admin.sock"),
  templatesDir: fileURLToPath(new URL("../../../teams", import.meta.url)),
  webDir: fileURLToPath(new URL("../../web/dist", import.meta.url)),
  filesDir: join(home, "app", "files"),
  ownerLogin: config.ownerLogin,
});

const listen = (server: Server, port: number) =>
  new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
try {
  await listen(app.agentServer, STUDIO_PORT);
  await listen(app.ownerServer, OWNER_PORT);
} catch (error) {
  fail(String(error), "Another copy of Studio may be running; stop it first.");
}
console.log(`a12s Studio: Fleet ${config.fleet}, database ${dbFile}`);
console.log(`a12s Studio: owner UI on http://127.0.0.1:${OWNER_PORT}, agent API on 127.0.0.1:${STUDIO_PORT}`);

// Agents reach both listeners through these Services. a12s may still be starting (Docker after a reboot), so this
// retries until it answers; the UI is up meanwhile and shows a12s as down. Once a12s answers, every agent's spec is
// put again.
const services: ExternalService[] = [
  { name: "studio", host: "host.docker.internal", port: STUDIO_PORT, mcpPath: "/mcp", healthPath: "/healthz" },
  { name: "broker", host: "host.docker.internal", port: BROKER_PORT },
];
void (async () => {
  for (;;) {
    try {
      await a12s.ensureServices(services);
      break;
    } catch (error) {
      console.error("a12s Studio: cannot set the studio and broker Services yet:", String(error));
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
  await app.teams.putSpecs();
})();

// Its first resync stores what happened while the app was stopped and runs the dispatcher, which delivers whatever
// was committed but not yet sent.
app.live.start();
app.scheduler.start();

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  console.log(`a12s Studio: ${signal}, stopping.`);
  app.stream.close();
  await app.scheduler.stop();
  await app.live.stop();
  for (const server of [app.ownerServer, app.agentServer]) server.closeAllConnections();
  await Promise.all([app.ownerServer, app.agentServer].map((s) => new Promise((r) => s.close(r))));
  db.close();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
