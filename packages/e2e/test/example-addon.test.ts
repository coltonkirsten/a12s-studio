import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const SERVER = fileURLToPath(new URL("../../../addons/example/server.ts", import.meta.url));

// The example add-on against a stand-in for the a12s proxy: every call it makes must reach the proxy as a plain HTTP
// request naming its full address, since a12s refuses a tunnel to an http port (build-spec M9).
test("the example add-on's tool calls the broker and reports its cost, as plain HTTP through the proxy", async (t) => {
  const seen: { method: string; url: string; body: string }[] = [];
  const proxy = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    seen.push({ method: req.method ?? "", url: req.url ?? "", body });
    const answer = req.url?.startsWith("http://broker.a12s:7420/")
      ? { full_name: "octo/hello", description: "A greeting.", default_branch: "main", stargazers_count: 3 }
      : { ok: true };
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(answer));
  });
  proxy.on("connect", (_req, socket) => {
    seen.push({ method: "CONNECT", url: "", body: "" });
    socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  t.after(() => proxy.close());
  const port = await new Promise<number>((resolve) => {
    const probe = createServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
  const addon = spawn(process.execPath, [SERVER], {
    env: {
      PATH: process.env.PATH,
      PORT: String(port),
      HTTP_PROXY: `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`,
      NO_PROXY: "127.0.0.1",
      NODE_USE_ENV_PROXY: "1",
    },
    stdio: "inherit",
  });
  t.after(() => addon.kill());

  const rpc = async (method: string, params: unknown = {}) => {
    for (let i = 0; ; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        });
        return ((await res.json()) as { result: Record<string, unknown> }).result;
      } catch (error) {
        if (i > 100) throw error;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
  };

  const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {} });
  assert.equal(init.protocolVersion, "2025-06-18");
  const { tools } = (await rpc("tools/list")) as { tools: { name: string }[] };
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ["repo_facts"],
  );

  const refused = await rpc("tools/call", { name: "repo_facts", arguments: { repo: "../../user" } });
  assert.equal(refused.isError, true);
  assert.deepEqual(seen, [], "a bad repo makes no call");

  const done = (await rpc("tools/call", { name: "repo_facts", arguments: { repo: "octo/hello" } })) as {
    content: { text: string }[];
    isError: boolean;
  };
  assert.equal(done.isError, false);
  assert.deepEqual(JSON.parse(done.content[0]?.text ?? ""), {
    repo: "octo/hello",
    description: "A greeting.",
    defaultBranch: "main",
    stars: 3,
  });
  assert.deepEqual(seen, [
    { method: "GET", url: "http://broker.a12s:7420/api.github.com/repos/octo/hello", body: "" },
    {
      method: "POST",
      url: "http://studio.a12s:7410/usage",
      body: JSON.stringify({ usd: 0.01, note: "lookup of octo/hello" }),
    },
  ]);
  addon.kill();
  await once(addon, "exit");
});
