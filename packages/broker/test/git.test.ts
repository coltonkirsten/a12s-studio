import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { type IncomingMessage, request } from "node:http";
import { buffer } from "node:stream/consumers";
import { test } from "node:test";
import { promisify } from "node:util";
import { CALLER_HEADER } from "@a12s-studio/contract/names";
import { type Broker, SECRET, startBroker } from "./harness.ts";

const GIT_HOST = "git.example.com";
const REFS = "/owner/repo.git/info/refs";
const UPLOAD_PACK = "/owner/repo.git/git-upload-pack";
const BASIC = `Basic ${Buffer.from(`x-access-token:${SECRET}`).toString("base64")}`;
const HEAD = "2f".repeat(20);

// What the "Repository, read" preset of the UI expands to.
async function allowRead(broker: Broker): Promise<void> {
  await broker.credential("web", GIT_HOST, { scheme: "basic", username: "x-access-token" });
  await broker.grant("web", { host: GIT_HOST, methods: ["GET", "POST"], paths: [REFS, UPLOAD_PACK] });
}

function pkt(line: string): string {
  return (line.length + 4).toString(16).padStart(4, "0") + line;
}

function gate(): { open: () => void; opened: Promise<void> } {
  const { promise, resolve } = Promise.withResolvers<void>();
  return { open: resolve, opened: promise };
}

test("git smart HTTP: the ref advertisement streams down chunk by chunk", { timeout: 10_000 }, async (t) => {
  const broker = await startBroker(t);
  await allowRead(broker);
  const firstChunkArrived = gate();
  broker.upstream.handle = async (_req, res) => {
    res.writeHead(200, { "content-type": "application/x-git-upload-pack-advertisement", "cache-control": "no-cache" });
    res.write(`${pkt("# service=git-upload-pack\n")}0000`);
    // The stub holds the rest back until the client has the first chunk: a broker that buffered would hang here.
    await firstChunkArrived.opened;
    res.end(`${pkt(`${HEAD} refs/heads/main\n`)}0000`);
  };

  const path = `/${GIT_HOST}${REFS}?service=git-upload-pack`;
  const req = request({ port: broker.port, path, headers: { [CALLER_HEADER]: "web-dev" } }).end();
  const [res] = (await once(req, "response")) as [IncomingMessage];
  const chunks: string[] = [];
  for await (const chunk of res.setEncoding("utf8")) {
    chunks.push(chunk);
    firstChunkArrived.open();
  }

  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["content-type"], "application/x-git-upload-pack-advertisement");
  assert.deepEqual(chunks, [`${pkt("# service=git-upload-pack\n")}0000`, `${pkt(`${HEAD} refs/heads/main\n`)}0000`]);
  const [seen] = broker.upstream.seen;
  assert.deepEqual([seen?.method, seen?.url], ["GET", `${REFS}?service=git-upload-pack`]);
  assert.equal(seen?.headers.authorization, BASIC);
  assert.deepEqual(broker.agent.dialed, [`${GIT_HOST}:443`]);
});

test("git smart HTTP: a pack request streams up and the binary pack streams back unchanged", {
  timeout: 10_000,
}, async (t) => {
  const broker = await startBroker(t);
  await allowRead(broker);
  const pack = Buffer.from(Array.from({ length: 70_000 }, (_, i) => (i * 31) % 256));
  const firstPartArrived = gate();
  const received: Buffer[] = [];
  broker.upstream.handle = async (req, res) => {
    for await (const chunk of req) {
      received.push(chunk);
      firstPartArrived.open();
    }
    res.writeHead(200, { "content-type": "application/x-git-upload-pack-result" }).end(pack);
  };

  const headers = { [CALLER_HEADER]: "web-dev", "content-type": "application/x-git-upload-pack-request" };
  const req = request({ port: broker.port, method: "POST", path: `/${GIT_HOST}${UPLOAD_PACK}`, headers });
  req.write(pkt(`want ${HEAD}\n`));
  // The client holds the rest back until upstream has the first part: a broker that buffered would hang here.
  await firstPartArrived.opened;
  req.end(`0000${pkt("done\n")}`);
  const [res] = (await once(req, "response")) as [IncomingMessage];

  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["content-type"], "application/x-git-upload-pack-result");
  assert.deepEqual(await buffer(res), pack);
  assert.equal(Buffer.concat(received).toString(), `${pkt(`want ${HEAD}\n`)}0000${pkt("done\n")}`);
  const [seen] = broker.upstream.seen;
  assert.equal(seen?.headers["content-type"], "application/x-git-upload-pack-request");
  assert.equal(seen?.headers.authorization, BASIC);
});

test("git smart HTTP: a read grant does not allow a push", async (t) => {
  const broker = await startBroker(t);
  await allowRead(broker);

  const advertise = await broker.call(`/${GIT_HOST}${REFS.replace("repo", "other")}?service=git-upload-pack`);
  const push = await broker.call(`/${GIT_HOST}/owner/repo.git/git-receive-pack`, { method: "POST", body: "0000" });
  assert.deepEqual([advertise.status, push.status], [403, 403]);
  assert.deepEqual(broker.upstream.seen, []);
});

test("git smart HTTP: the git client reads refs through the broker, and is refused without a prompt", async (t) => {
  const broker = await startBroker(t);
  await allowRead(broker);
  const capabilities = "\0agent=stub";
  const advertisement = `${pkt("# service=git-upload-pack\n")}0000${pkt(`${HEAD} refs/heads/main${capabilities}\n`)}0000`;
  broker.upstream.handle = (_req, res) => {
    res.writeHead(200, { "content-type": "application/x-git-upload-pack-advertisement" }).end(advertisement);
  };
  const lsRemote = (repo: string) =>
    promisify(execFile)(
      "git",
      [
        "-c",
        `http.extraHeader=${CALLER_HEADER}: web-dev`,
        "ls-remote",
        `http://127.0.0.1:${broker.port}/${GIT_HOST}/${repo}`,
      ],
      // Nothing from this machine's git setup: no config, no credential helper, no prompt, no proxy.
      {
        env: {
          PATH: process.env.PATH,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_TERMINAL_PROMPT: "0",
        },
      },
    );

  const { stdout } = await lsRemote("owner/repo.git");
  assert.equal(stdout, `${HEAD}\trefs/heads/main\n`);
  assert.equal(broker.upstream.seen[0]?.headers.authorization, BASIC);

  await assert.rejects(lsRemote("owner/other.git"), /403/);
  broker.upstream.handle = (_req, res) => {
    res.writeHead(401, { "www-authenticate": 'Basic realm="stub"' }).end();
  };
  await assert.rejects(lsRemote("owner/repo.git"), /502/);
});
