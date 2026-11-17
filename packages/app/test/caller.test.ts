import assert from "node:assert/strict";
import { request } from "node:http";
import { after, before, test } from "node:test";
import { CALLER_HEADER, STUDIO_HOST } from "@a12s-studio/contract/names";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { type Studio, studio } from "./studio.ts";

let s: Studio;
before(async () => {
  s = await studio();
  await s.twoTeams();
  await s.app.teams.hire("web", { slug: "gone", role: "Leaves soon.", model: "haiku" });
  await s.app.teams.fire("web", "web-gone");
  await s.app.teams.createTeam({ name: "Old", purpose: "Gone.", accent: "#000000", template: "website" });
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

test("the agent API refuses a caller that did not come through a12s's Host", async () => {
  for (const host of ["127.0.0.1:7410", "evil.example:7410", "studio.a12s", "studio.a12s:7410.evil.example"]) {
    const { status } = await s.raw(["web-lead"], "POST", "/mcp", list, host);
    assert.equal(status, 403, host);
  }
  assert.equal((await s.raw(["web-lead"], "POST", "/mcp", list)).status, 200);
});

test("the caller check runs before routing, and health needs no caller", async () => {
  assert.equal((await s.raw([], "GET", "/files/m_x/a.txt")).status, 403);
  assert.equal((await s.raw(["web-lead"], "GET", "/files/m_x/a.txt")).status, 404);
  assert.equal((await s.raw(["web-lead"], "GET", "/mcp")).status, 405);
  assert.equal((await s.raw([], "GET", "/healthz")).status, 200);
});

// fetch will not send a Host of its own choosing, so this client goes over node:http the way the a12s proxy does.
async function viaA12s(url: string | URL, init?: RequestInit): Promise<Response> {
  const headers = Object.fromEntries(new Headers(init?.headers).entries());
  const body = typeof init?.body === "string" ? init.body : undefined;
  return new Promise((resolve, reject) => {
    const req = request(url, { method: init?.method ?? "GET", headers: { ...headers, host: STUDIO_HOST } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const out = new Headers();
        for (const [k, v] of Object.entries(res.headers)) if (typeof v === "string") out.set(k, v);
        const status = res.statusCode ?? 500;
        resolve(
          new Response(status === 202 || status === 204 ? null : Buffer.concat(chunks), { status, headers: out }),
        );
      });
    });
    req.on("error", reject);
    req.end(body);
  });
}

test("a real MCP client sees the six tools, and no tool takes a team or a sender", async () => {
  const { port } = s.app.agentServer.address() as { port: number };
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: { headers: { [CALLER_HEADER]: "web-lead" } },
      fetch: viaA12s,
    }),
  );
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ["access", "post", "read", "roster", "schedule", "update_thread"]);
  for (const t of tools) {
    const fields = Object.keys(t.inputSchema.properties ?? {});
    for (const forbidden of ["team", "teamId", "team_id", "from", "fromId", "caller", "agent", "agentId"]) {
      assert.ok(!fields.includes(forbidden), `${t.name} takes ${forbidden}`);
    }
    assert.equal(t.inputSchema.additionalProperties, false, `${t.name} accepts fields it does not name`);
  }
  const roster = await client.callTool({ name: "roster", arguments: {} });
  assert.match(JSON.stringify(roster.content), /\\"you\\":\\"lead\\"/);
  await client.close();
});

test("a team or sender slipped into the arguments is refused and writes nothing", async () => {
  const before = s.db.prepare("SELECT count(*) AS n FROM messages").get();
  const posted = await s.tool("web-dev", "post", {
    to: "lead",
    title: "Spoof",
    body: "hello",
    team: "notes",
    from: "notes-lead",
  });
  assert.ok(posted.error);
  assert.deepEqual(s.db.prepare("SELECT count(*) AS n FROM messages").get(), before);
});
