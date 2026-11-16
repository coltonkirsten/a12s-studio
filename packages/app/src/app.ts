import type { DatabaseSync } from "node:sqlite";
import type { A12s } from "./a12s/port.ts";
import { createAgentServer } from "./agent-server.ts";
import { createDispatcher } from "./dispatcher.ts";
import { createRepo } from "./repo.ts";
import { createTeams } from "./teams.ts";

// main.ts and the tests build the app the same way; only the a12s behind the port differs.
export function createApp(deps: { db: DatabaseSync; a12s: A12s; templatesDir: string }) {
  const repo = createRepo(deps.db);
  const dispatcher = createDispatcher(repo, deps.a12s);
  const teams = createTeams({ repo, a12s: deps.a12s, dispatcher, templatesDir: deps.templatesDir });
  const agentServer = createAgentServer({ repo, a12s: deps.a12s, dispatcher });
  return { repo, dispatcher, teams, agentServer };
}
