import { mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { STUDIO_PORT } from "@a12s-studio/contract/names";
import { fakeA12s } from "./a12s/fake.ts";
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
mkdirSync(join(home, "app"), { recursive: true, mode: 0o700 });
const dbFile = join(home, "app", "studio.db");
const app = createApp({
  db: openDb(dbFile),
  a12s: fakeA12s(),
  templatesDir: fileURLToPath(new URL("../../../teams", import.meta.url)),
});
app.agentServer.listen(STUDIO_PORT, "127.0.0.1", () => {
  console.log(`a12s Studio: Fleet ${config.fleet}, database ${dbFile}, agent API on 127.0.0.1:${STUDIO_PORT}`);
  // Delivers whatever was committed but not yet sent when the app last stopped.
  void app.dispatcher.run();
});
