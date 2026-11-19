// Manual check of real.ts against a running Fleet; never run by npm test or CI. It needs Docker, a12s and the
// anthropic credential set on the Fleet. Usage: node packages/app/scripts/a12s-smoke.ts <fleet>
import assert from "node:assert/strict";
import type { AgentSpec } from "../src/a12s/port.ts";
import { readController, realA12s } from "../src/a12s/real.ts";

const fleet = process.argv[2];
if (!fleet) throw new Error("Usage: node packages/app/scripts/a12s-smoke.ts <fleet>");
const team = "smoke";
const agent = `${team}-lead`;
const spec: AgentSpec = {
  harness: {
    kind: "claude-code",
    version: "2.1.280",
    model: "haiku",
    settings: { hooks: { SessionStart: [], UserPromptSubmit: [], Stop: [] } },
  },
  image: "slim",
  credentials: ["anthropic"],
  instructions: "You are a smoke test. Answer in one word.",
  files: { "notes.md": "smoke notes\n" },
  power: { sleepAfterIdle: "15m", compactBeforeSleep: { minTokens: 100000 } },
  grants: { send: [] },
  uses: [],
  egress: { allow: [] },
};
const log = (label: string, value: unknown) => console.log(label, JSON.stringify(value).slice(0, 300));

const a12s = realA12s(readController(fleet));
await a12s.ensureServices([
  { name: "studio", host: "host.docker.internal", port: 7410, mcpPath: "/mcp", healthPath: "/healthz" },
  { name: "broker", host: "host.docker.internal", port: 7420 },
]);
await a12s.ensureServices([{ name: "broker", host: "host.docker.internal", port: 7420 }]);
console.log("services ensured twice");

const feed = a12s.events();
await feed.ready();
const token = await a12s.createToken(team);
const smoke = a12s.forTeam(token);
try {
  await a12s.putAgent(agent, spec, "create");
  await assert.rejects(a12s.putAgent(agent, spec, "create"), { code: "exists" });
  await assert.rejects(smoke.wake("other-lead"), { code: "out_of_prefix" });
  log("status", await smoke.status());

  const sent = await smoke.send(agent, {
    body: "Reply with the single word pong.",
    metadata: { thread: "th_smoke" },
    replaceKey: "m_smoke",
  });
  log("sent", sent);

  let turn = "";
  for await (const event of feed) {
    if (event.type === "gap" || event.type === "service.phase" || event.agent !== agent) continue;
    log("event", event);
    if (event.type === "turn.started" && event.messageIds.includes(sent.id)) turn = event.turn;
    if (event.type === "turn.finished" && event.turn === turn) break;
  }

  log("turns", await smoke.turns(agent, 5));
  const replayed = await Array.fromAsync(smoke.turnEvents(agent, turn));
  assert.equal(replayed.at(-1)?.type, "turn.finished");
  log(
    "turnEvents",
    replayed.map((event) => event.type),
  );
  assert.deepEqual(await Array.fromAsync(smoke.turnEvents(agent, "t_none")), []);
  log("inbox", await smoke.inbox(agent));
  log("file", await smoke.readFile(agent, "/home/agent/notes.md"));
  await smoke.writeFile(agent, "/home/agent/out/hello.txt", new TextEncoder().encode("hello\n"));
  log("dir", await smoke.readFile(agent, "/home/agent/out"));
  log("written", await smoke.readFile(agent, "/home/agent/out/hello.txt"));
  await assert.rejects(smoke.readFile(agent, "/home/agent/missing"), { code: "not_found" });

  const terminal = await smoke.openTerminal(agent, { rows: 24, cols: 80 });
  await terminal.resize(30, 100);
  let output = "";
  terminal.stream.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  terminal.stream.write("stty size; echo smoke-$((40+2)); exit\n");
  await new Promise((resolve) => terminal.stream.on("close", resolve));
  assert.match(output, /smoke-42/);
  log("terminal", output.replace(/\s+/g, " ").trim());

  await smoke.sleep(agent);
  await assert.rejects(smoke.readFile(agent, "/home/agent"), { code: "asleep" });
  await assert.rejects(Array.fromAsync(smoke.turnEvents(agent, turn)), { code: "asleep" });
  log("turns while asleep", (await smoke.turns(agent, 5)).length);
  await smoke.wake(agent);
  console.log("sleep and wake ok");

  // An add-on instance: the owner writes it, the team's token sees and removes it. busybox has no service.json, so
  // a12s refuses it after pulling it; that refusal is the port's error.
  const instance = `${team}-addon-smoke`;
  await assert.rejects(a12s.putService(instance, { image: "busybox:1.37", uses: [], egress: { allow: [] } }));
  log("services", await smoke.services());
  await assert.rejects(smoke.removeService(instance), { code: "not_found" });
  console.log("services ok");
} finally {
  feed.close();
  await smoke.removeAgent(agent).catch((error: unknown) => console.error("removeAgent:", error));
  await a12s.removeToken(team);
  await a12s.removeToken(team);
  console.log("cleaned up");
}
