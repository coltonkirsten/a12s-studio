import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { CALLER_HEADER } from "@a12s-studio/contract/names";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { type Studio, studio } from "./studio.ts";

let s: Studio;
before(async () => {
  s = await studio();
  await s.twoTeams();
  await s.app.teams.hire("web", { slug: "gone", role: "Leaves soon.", model: "haiku" });
  await s.app.teams.fire("web", "web-gone");
  await s.app.teams.createTeam({ slug: "old", name: "Old", purpose: "Gone.", accent: "#000000", template: "website" });
  await s.app.teams.deleteTeam("old");
});
after(() => s.close());

const list = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };

for (const [why, callers] of [
  ["no header", []],
  ["two headers", ["web-lead", "web-lead"]],
  ["two different headers", ["web-lead", "web-dev"]],
  ["an unknown agent", ["web-nobody"]],
  ["a removed agent", ["web-gone"]],
  ["an agent of a deleted team", ["old-lead"]],
  ["a team name instead of an agent", ["web"]],
  ["two names in one header", ["web-lead, notes-lead"]],
] as const) {
  test(`the agent API refuses ${why}`, async () => {
    const { status, body } = await s.raw([...callers], "POST", "/mcp", list);
    assert.equal(status, 403);
    assert.equal((body as { code: string }).code, "no_caller");
  });
}

test("the caller check runs before routing, and health needs no caller", async () => {
  assert.equal((await s.raw([], "GET", "/files/m_x/a.txt")).status, 403);
  assert.equal((await s.raw(["web-lead"], "GET", "/files/m_x/a.txt")).status, 404);
  assert.equal((await s.raw(["web-lead"], "GET", "/mcp")).status, 405);
  assert.equal((await s.raw([], "GET", "/healthz")).status, 200);
});

test("a real MCP client sees the four tools, and no tool takes a team or a sender", async () => {
  const { port } = s.app.agentServer.address() as { port: number };
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: { headers: { [CALLER_HEADER]: "web-lead" } },
    }),
  );
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ["post", "read", "roster", "update_thread"]);
  for (const t of tools) {
    const fields = Object.keys(t.inputSchema.properties ?? {});
    for (const forbidden of ["team", "teamId", "team_id", "from", "fromId", "caller", "agent"]) {
      assert.ok(!fields.includes(forbidden), `${t.name} takes ${forbidden}`);
    }
  }
  const roster = await client.callTool({ name: "roster", arguments: {} });
  assert.match(JSON.stringify(roster.content), /\\"you\\":\\"lead\\"/);
  await client.close();
});

test("a team or sender slipped into the arguments changes nothing", async () => {
  const posted = await s.tool("web-dev", "post", {
    kind: "ask",
    to: "lead",
    title: "Spoof",
    body: "hello",
    team: "notes",
    from: "notes-lead",
  });
  const row = s.db.prepare("SELECT team_id, from_id, to_id FROM messages WHERE id = ?").get(String(posted.message));
  assert.deepEqual({ ...row }, { team_id: "web", from_id: "web-dev", to_id: "web-lead" });
});
