import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import type { RunResponse, RunsResponse } from "@a12s-studio/contract/api";
import { CALLER_HEADER, STUDIO_HOST, STUDIO_URL } from "@a12s-studio/contract/names";
import { agentSpec } from "../src/a12s/spec.ts";
import type { TeamRepo } from "../src/repo.ts";
import { type Studio, studio } from "./studio.ts";

const run = promisify(execFile);
const SESSION = "0b9e7a52-1c3d-4e5f-8a9b-0c1d2e3f4a5b";
const DAY = 24 * 3600 * 1000;

const line = (at: number, o: Record<string, unknown>) =>
  JSON.stringify({ timestamp: new Date(at).toISOString(), sessionId: SESSION, ...o });
const prompt = (at: number, text: string) => line(at, { type: "user", message: { role: "user", content: text } });
const call = (at: number, id: string, name: string, extra = {}) =>
  line(at, { type: "assistant", message: { content: [{ type: "tool_use", id, name, input: {} }] }, ...extra });
const result = (at: number, id: string, out: string, extra = {}) =>
  line(at, { type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: out }] }, ...extra });

function turn(scoped: TeamRepo, id: string, agentId: string, startedAt: number): void {
  scoped.insertTurn({
    id,
    agentId,
    threadId: null,
    session: SESSION,
    status: "completed",
    error: null,
    startedAt,
    finishedAt: startedAt + 10_000,
    tokens: undefined,
    modelCostsUsd: {},
    costUsd: 0.01,
  });
}

// A request to the agent listener as a12s passes it on: the Studio Host, and the caller stamped.
function agentCall(s: Studio, agent: string, method: string, path: string, body?: Buffer) {
  const { port } = s.app.agentServer.address() as AddressInfo;
  return new Promise<{ status: number; text: string }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (text += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, text }));
    });
    req.on("error", reject);
    req.setHeader("host", STUDIO_HOST);
    if (agent) req.setHeader(CALLER_HEADER, agent);
    req.end(body);
  });
}

// The Stop hook exactly as the spec writes it, run with /bin/sh in a temp HOME, through a stand-in for a12s's proxy
// that stamps the caller.
async function hook(t: { after(fn: () => unknown): void }, s: Studio, agent: string) {
  const { port } = s.app.agentServer.address() as AddressInfo;
  const proxy = createServer((req, res) => {
    const out = request(
      { host: "127.0.0.1", port, method: req.method, path: req.url, headers: { ...req.headers, host: STUDIO_HOST } },
      (answer) => {
        res.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(res);
      },
    );
    out.setHeader(CALLER_HEADER, agent);
    req.pipe(out);
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  t.after(() => proxy.close());
  const home = mkdtempSync(join(tmpdir(), "send-transcript-"));
  const script = join(home, "send-transcript");
  const dev = s.app.repo.forTeam("web").agent("web-dev");
  assert.ok(dev);
  const text = agentSpec({ name: "Web" }, dev, []).files["bin/send-transcript"] ?? "";
  writeFileSync(script, text.replaceAll(STUDIO_URL, `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`));
  const projects = join(home, ".claude", "projects", "-home-agent");
  mkdirSync(join(projects, SESSION, "subagents"), { recursive: true });
  return {
    main: join(projects, `${SESSION}.jsonl`),
    sub: join(projects, SESSION, "subagents", "agent-a1.jsonl"),
    run: () => run("/bin/sh", [script], { env: { HOME: home, PATH: process.env.PATH } }),
  };
}

async function setup(t: { after(fn: () => unknown): void }) {
  const s = await studio();
  t.after(() => s.close());
  await s.twoTeams();
  return s;
}

test("the Stop hook sends each transcript's new lines, and each Turn's run holds its own lines and index", async (t) => {
  const s = await setup(t);
  const now = Date.now();
  const web = s.app.repo.forTeam("web");
  turn(web, "t_first", "web-dev", now - 60_000);
  turn(web, "t_second", "web-dev", now - 30_000);
  const h = await hook(t, s, "web-dev");
  const first = [
    prompt(now - 59_000, "Run the tests."),
    call(now - 58_000, "c1", "Bash"),
    result(now - 55_000, "c1", "ok"),
  ];
  const second = [prompt(now - 29_000, "Fix the footer."), call(now - 28_000, "c2", "Agent")];
  const sub = [
    call(now - 27_000, "c3", "Read", { isSidechain: true, agentId: "a1" }),
    result(now - 26_000, "c3", "text", { isSidechain: true, agentId: "a1" }),
  ];
  const cut = prompt(now - 25_000, "Steered in.");
  writeFileSync(h.main, `${[...first, ...second].join("\n")}\n${cut.slice(0, 20)}`);
  writeFileSync(h.sub, `${sub.join("\n")}\n`);
  await h.run();

  const list = (await s.owner("GET", "/api/runs?agent=web-dev")).body as RunsResponse;
  assert.deepEqual(
    list.runs.map((r) => [r.turn, r.status, r.session, r.index.lines, r.index.tools.map((x) => x.name)]),
    [
      ["t_second", "completed", SESSION, 4, ["Agent", "Read"]],
      ["t_first", "completed", SESSION, 3, ["Bash"]],
    ],
  );
  assert.equal(list.runs[0]?.index.subAgents, 1);
  // With no agent or thread named, the runs of every team, newest first.
  const all = (await s.owner("GET", "/api/runs")).body as RunsResponse;
  assert.deepEqual(
    all.runs.map((r) => r.turn),
    ["t_second", "t_first"],
  );
  const one = (await s.owner("GET", "/api/runs/t_first")).body as RunResponse;
  assert.deepEqual(
    one.steps.map((step) => [step.kind, step.name, step.output, step.ms]),
    [
      ["prompt", "", null, null],
      ["tool", "Bash", "ok", 3000],
    ],
  );
  const raw = await s.owner("GET", "/api/runs/t_first/transcript");
  assert.equal(raw.body, `${first.join("\n")}\n`);
  assert.equal(raw.headers["content-disposition"], 'attachment; filename="t_first.jsonl"');

  // The cut line waits until it is whole; then it joins the Turn it was written in.
  const held = () => agentCall(s, "web-dev", "GET", "/transcripts");
  const mainBytes = Buffer.byteLength(`${[...first, ...second].join("\n")}\n`);
  const subBytes = Buffer.byteLength(`${sub.join("\n")}\n`);
  assert.equal(
    (await held()).text,
    `${mainBytes} -home-agent/${SESSION}.jsonl\n${subBytes} -home-agent/${SESSION}/subagents/agent-a1.jsonl\n`,
  );
  appendFileSync(h.main, `${cut.slice(20)}\n`);
  await h.run();
  await h.run();
  const steered = (await s.owner("GET", "/api/runs/t_second")).body as RunResponse;
  assert.equal(steered.steps.filter((step) => step.text === "Steered in.").length, 1);
  assert.equal(steered.run.index.lines, 5);

  // Another agent sees only what it sent itself.
  assert.equal((await agentCall(s, "notes-lead", "GET", "/transcripts")).text, "");
});

test("a send is refused for a path that is no transcript, a wrong offset, a full disk and no caller", async (t) => {
  const s = await setup(t);
  turn(s.app.repo.forTeam("web"), "t_one", "web-dev", Date.now() - 1000);
  const body = Buffer.from(`${prompt(Date.now(), "x")}\n`);
  const path = `/transcripts/-home-agent/${SESSION}.jsonl`;
  const code = async (agent: string, p: string) => {
    const answer = await agentCall(s, agent, "POST", p, body);
    return [answer.status, JSON.parse(answer.text).code];
  };
  assert.deepEqual(await code("web-dev", "/transcripts/-home-agent/..%2F..%2Fetc%2Fpasswd?offset=0"), [
    400,
    "bad_path",
  ]);
  assert.deepEqual(await code("web-dev", `${path}?offset=5`), [409, "offset"]);
  assert.deepEqual(await code("web-dev", `${path}?offset=x`), [400, "bad_offset"]);
  assert.deepEqual(await code("", `${path}?offset=0`), [403, "no_caller"]);
  s.app.repo.updateSettings({ minFreeDiskGb: 1e9 });
  assert.deepEqual(await code("web-dev", `${path}?offset=0`), [507, "disk_full"]);
  s.app.repo.updateSettings({ minFreeDiskGb: 0 });
  assert.deepEqual(await code("web-dev", `${path}?offset=0`), [200, undefined]);
});

test("a run outlives its team, and runs are pruned 30 days after their last line", async (t) => {
  const s = await setup(t);
  const now = Date.now();
  turn(s.app.repo.forTeam("web"), "t_old", "web-dev", now - 1000);
  const caller = { agentId: "web-dev", teamId: "web" };
  s.app.runs.receive(caller, `-home-agent/${SESSION}.jsonl`, 0, Buffer.from(`${prompt(now, "Hello.")}\n`));
  assert.ok(existsSync(s.app.runs.file("t_old")));

  await s.app.teams.deleteTeam("web");
  assert.equal((await s.owner("GET", "/api/runs/t_old")).status, 200);
  assert.deepEqual(
    ((await s.owner("GET", "/api/runs?agent=web-dev")).body as RunsResponse).runs.map((r) => r.turn),
    ["t_old"],
  );

  // A send 31 days on, by an agent of another team, prunes the old run and its file.
  const later = now + 31 * DAY;
  turn(s.app.repo.forTeam("notes"), "t_new", "notes-lead", later - 1000);
  const notes = { agentId: "notes-lead", teamId: "notes" };
  s.app.runs.receive(notes, `-home-agent/${SESSION}.jsonl`, 0, Buffer.from(`${prompt(later, "Hi.")}\n`), later);
  assert.equal((await s.owner("GET", "/api/runs/t_old")).status, 404);
  assert.equal(existsSync(s.app.runs.file("t_old")), false);
  assert.equal(readFileSync(s.app.runs.file("t_new"), "utf8"), `${prompt(later, "Hi.")}\n`);
});
