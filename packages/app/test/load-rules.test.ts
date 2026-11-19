import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { STUDIO_URL } from "@a12s-studio/contract/names";
import { agentSpec } from "../src/a12s/spec.ts";

const run = promisify(execFile);
const CHANGED = "This has changed. It replaces what you were given before:\n";

const spec = agentSpec(
  { name: "Web" },
  {
    id: "web-dev",
    teamId: "web",
    slug: "dev",
    model: "haiku",
    sleepAfterIdle: "15m",
    compactMinTokens: 0,
    cpu: null,
    memory: null,
    createdAt: 0,
  },
);

const listen = (server: Server) =>
  new Promise<string>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)),
  );

// The script exactly as the spec writes it to the agent's home, run with /bin/sh against a local stand-in for
// GET /rules/<layer>, in a temp HOME. `down()` points it at a port nobody serves.
async function harness(t: { after(fn: () => unknown): void }) {
  const texts: Record<string, string> = {
    owner: "# Owner rules, for every agent\nBe brief.",
    team: "# Team: Web\n\n## Purpose\nThe site.\n\n## Team rules\nNone.",
    role: "# Your role\nWrites the code.",
  };
  const server = createServer((req, res) => {
    const text = texts[(req.url ?? "").replace("/rules/", "")];
    if (text === undefined) res.writeHead(404).end();
    else res.writeHead(200, { "content-type": "text/plain; charset=utf-8" }).end(text);
  });
  const up = await listen(server);
  t.after(() => server.close());
  const closed = createServer();
  const down = await listen(closed);
  await new Promise((resolve) => closed.close(resolve));

  const home = mkdtempSync(join(tmpdir(), "load-rules-"));
  const script = spec.files["bin/load-rules"] ?? "";
  assert.ok(script.includes(STUDIO_URL));
  const write = (url: string) => {
    const file = join(home, `load-rules-${url === up ? "up" : "down"}`);
    writeFileSync(file, script.replace(STUDIO_URL, url));
    return file;
  };
  const files = { up: write(up), down: write(down) };
  let serving: "up" | "down" = "up";

  async function hook(...args: string[]): Promise<string> {
    const { stdout } = await run("/bin/sh", [files[serving], ...args], { env: { HOME: home, PATH: process.env.PATH } });
    return stdout;
  }
  return {
    texts,
    home,
    start: async () => (await Promise.all(["owner", "team", "role"].map((layer) => hook(layer)))).join(""),
    prompt: async () => (await Promise.all(["owner", "team", "role"].map((layer) => hook(layer, "changed")))).join(""),
    down: () => {
      serving = "down";
    },
    up: () => {
      serving = "up";
    },
  };
}

test("at a session's start every layer is printed and kept", async (t) => {
  const h = await harness(t);
  assert.equal(await h.start(), `${h.texts.owner}\n${h.texts.team}\n${h.texts.role}\n`);
  assert.equal(readFileSync(join(h.home, ".studio/rules-team"), "utf8"), h.texts.team);
  // A new session holds none of it, so a start prints everything again.
  assert.equal(await h.start(), `${h.texts.owner}\n${h.texts.team}\n${h.texts.role}\n`);
});

test("on a prompt only a changed layer is printed, marked as replacing the old one", async (t) => {
  const h = await harness(t);
  await h.start();
  assert.equal(await h.prompt(), "");
  h.texts.role = "# Your role\nReviews the code.";
  assert.equal(await h.prompt(), `${CHANGED}${h.texts.role}\n`);
  assert.equal(await h.prompt(), "");
  // A layer emptied by the owner is a change like any other.
  h.texts.owner = "# Owner rules, for every agent\nNone.";
  assert.equal(await h.prompt(), `${CHANGED}${h.texts.owner}\n`);
});

test("while Studio is down nothing is printed, and the first prompt after a failed start loads every layer", async (t) => {
  const h = await harness(t);
  await h.start();
  h.down();
  assert.equal(await h.prompt(), "");
  assert.equal(await h.start(), "");
  assert.equal(await h.prompt(), "");
  h.up();
  assert.equal(await h.prompt(), `${h.texts.owner}\n${h.texts.team}\n${h.texts.role}\n`);
  assert.equal(await h.prompt(), "");
});

test("a failed prompt keeps what the session was given, so an unchanged layer is not printed again", async (t) => {
  const h = await harness(t);
  await h.start();
  h.down();
  await h.prompt();
  h.up();
  assert.equal(await h.prompt(), "");
});
