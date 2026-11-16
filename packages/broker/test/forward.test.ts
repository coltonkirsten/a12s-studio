import assert from "node:assert/strict";
import { once } from "node:events";
import { type IncomingMessage, request } from "node:http";
import { text } from "node:stream/consumers";
import { test } from "node:test";
import { FROM_AGENT, HOST, reply, startBroker } from "./harness.ts";

const ITEMS = `/${HOST}/v1/items`;

test("the query string, the body and ordinary headers pass through in both directions", async (t) => {
  const broker = await startBroker(t);
  await broker.credential("web");
  await broker.grant("web", { methods: ["POST"] });
  broker.upstream.handle = reply(201, { "content-type": "text/plain", "x-request-id": "r1", etag: '"e1"' }, "created");

  const result = await broker.call(`${ITEMS}?page=2&q=a%2Fb`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/plain", "user-agent": "agent/1" },
    body: '{"name":"item"}',
  });

  assert.deepEqual([result.status, result.body], [201, "created"]);
  assert.deepEqual(
    [result.headers["content-type"], result.headers["x-request-id"], result.headers.etag],
    ["text/plain", "r1", '"e1"'],
  );
  const [seen] = broker.upstream.seen;
  assert.deepEqual([seen?.method, seen?.url, seen?.body], ["POST", "/v1/items?page=2&q=a%2Fb", '{"name":"item"}']);
  assert.deepEqual(
    [seen?.headers["content-type"], seen?.headers.accept, seen?.headers["user-agent"], seen?.headers["content-length"]],
    ["application/json", "text/plain", "agent/1", "15"],
  );
  assert.deepEqual(
    result.audit.map((row) => [row.action, row.path, row.grantId !== null]),
    [["call", "/v1/items", true]],
  );
});

test("headers that belong to one connection are not passed on, in either direction", async (t) => {
  const broker = await startBroker(t);
  await broker.credential("web");
  await broker.grant("web");
  broker.upstream.handle = reply(200, {
    connection: "x-hop, close",
    "x-hop": "1",
    "keep-alive": "timeout=77",
    "x-kept": "1",
  });

  const result = await broker.call(ITEMS, {
    headers: { te: "trailers", upgrade: "websocket", "proxy-connection": "keep-alive", expect: "100-continue" },
  });

  assert.equal(result.status, 200);
  assert.deepEqual([result.headers["x-hop"], result.headers["x-kept"]], [undefined, "1"]);
  // The broker's own connection to the agent has its own keep-alive; upstream's is not copied onto it.
  assert.notEqual(result.headers["keep-alive"], "timeout=77");
  const sent = broker.upstream.seen[0]?.headers ?? {};
  for (const name of ["te", "upgrade", "proxy-connection", "expect", "transfer-encoding"]) {
    assert.equal(sent[name], undefined, name);
  }
});

test("calls to one host share a connection", async (t) => {
  const broker = await startBroker(t);
  await broker.credential("web");
  await broker.grant("web");

  for (let i = 0; i < 3; i++) assert.equal((await broker.call(ITEMS)).status, 200);
  assert.equal(broker.upstream.seen.length, 3);
  assert.deepEqual(broker.agent.dialed, [`${HOST}:443`]);
});

test("an upstream that cannot be reached is a 502 with one audit row", async (t) => {
  const broker = await startBroker(t);
  await broker.credential("web");
  await broker.grant("web");
  broker.upstream.handle = (req) => req.socket.destroy();

  const result = await broker.call(ITEMS);
  assert.equal(result.status, 502);
  assert.equal(JSON.parse(result.body).code, "upstream_failed");
  assert.deepEqual(
    result.audit.map((row) => [row.action, row.status, row.detail]),
    [["call", 502, "ECONNRESET"]],
  );
});

test("an upstream that fails mid-body cuts the agent off instead of ending the response cleanly", async (t) => {
  const broker = await startBroker(t);
  await broker.credential("web");
  await broker.grant("web");
  broker.upstream.handle = (_req, res) => {
    res.writeHead(200, { "content-length": "1000" });
    res.write("partial", () => res.destroy());
  };

  const req = request({ port: broker.port, path: ITEMS, headers: FROM_AGENT }).end();
  const [res] = (await once(req, "response")) as [IncomingMessage];
  await assert.rejects(text(res), { code: "ECONNRESET" });
});

test("an agent that goes away stops the upstream call", { timeout: 10_000 }, async (t) => {
  const broker = await startBroker(t);
  await broker.credential("web");
  await broker.grant("web", { methods: ["POST"] });
  const arrived = Promise.withResolvers<void>();
  const closed = Promise.withResolvers<void>();
  broker.upstream.handle = (req) => {
    req.on("close", closed.resolve);
    req.once("data", arrived.resolve);
  };

  const req = request({ port: broker.port, method: "POST", path: ITEMS, headers: FROM_AGENT });
  req.on("error", () => {});
  req.write("the first part of an upload");
  await arrived.promise;
  req.destroy();
  await closed.promise;
});
