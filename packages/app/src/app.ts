import type { DatabaseSync } from "node:sqlite";
import type { A12s } from "./a12s/port.ts";
import { createAddons } from "./addons.ts";
import { createAgentServer } from "./agent-server.ts";
import { createBrokerClient } from "./broker-client.ts";
import { createDispatcher } from "./dispatcher.ts";
import { createLive } from "./live.ts";
import { createOwnerServer } from "./owner/server.ts";
import { createRepo } from "./repo.ts";
import { createRuns } from "./runs.ts";
import { createScheduler } from "./scheduler.ts";
import { createStream } from "./state.ts";
import { createTeams } from "./teams.ts";

// main.ts and the tests build the app the same way; only the a12s behind the port differs.
export function createApp(deps: {
  db: DatabaseSync;
  a12s: A12s;
  brokerSocket: string;
  templatesDir: string;
  webDir: string;
  // Attachments, app/files/<message>/<name>.
  filesDir: string;
  // Run capture, app/runs/<turn>.jsonl.
  runsDir: string;
  ownerLogin: string;
}) {
  const { a12s } = deps;
  const stream = createStream();
  const repo = createRepo(deps.db, stream.changed);
  const broker = createBrokerClient(deps.brokerSocket, stream.changed);
  const dispatcher = createDispatcher(repo, a12s);
  const scheduler = createScheduler({ repo, broker, dispatcher, changed: stream.changed });
  const addons = createAddons({ repo, a12s, broker });
  const teams = createTeams({ repo, a12s, broker, dispatcher, addons, templatesDir: deps.templatesDir });
  const live = createLive({ repo, a12s, dispatcher, changed: stream.changed, text: stream.live });
  const runs = createRuns({ repo, live, dir: deps.runsDir });
  const { filesDir } = deps;
  const agentServer = createAgentServer({ repo, a12s, broker, dispatcher, scheduler, live, runs, filesDir });
  const ownerServer = createOwnerServer({
    repo,
    a12s,
    broker,
    dispatcher,
    scheduler,
    teams,
    addons,
    live,
    stream,
    runs,
    filesDir,
    ownerLogin: deps.ownerLogin,
    webDir: deps.webDir,
  });
  return { repo, broker, dispatcher, scheduler, teams, addons, live, stream, runs, agentServer, ownerServer };
}
