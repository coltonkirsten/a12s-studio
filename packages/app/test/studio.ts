import { mkdtempSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { listenAdmin } from "@a12s-studio/broker/src/admin.ts";
import { openDb as openBrokerDb } from "@a12s-studio/broker/src/db.ts";
import { createVault } from "@a12s-studio/broker/src/vault.ts";
import { CALLER_HEADER, OWNER_PORT, STUDIO_HOST } from "@a12s-studio/contract/names";
import type { StudioState } from "@a12s-studio/contract/state";
import { type FakeA12s, fakeA12s } from "../src/a12s/fake.ts";
import type { A12s } from "../src/a12s/port.ts";
import { createApp } from "../src/app.ts";
import { openDb } from "../src/db.ts";

export const OWNER_LOGIN = "owner@example.com";
const TEMPLATES = fileURLToPath(new URL("../../../teams", import.meta.url));

type Raw = { status: number; body: unknown };
export type ToolAnswer = Record<string, unknown> & { error?: { code: string; message: string; fix?: string } };

// The real app on the fake a12s and a temp database, with its agent listener on a free port. Requests carry the
// caller header the way the a12s proxy sends it.
// `wrap` puts a layer between the app and the fake, to make a12s calls fail the way a crash or an outage would.
// With `live`, the a12s event feed is followed the way main.ts does it.
// `broker` is the admin socket of a broker the test runs itself, or one nobody serves; without it the app talks to
// the real broker's admin API on a temp socket.
export async function studio(
  opts: { dbFile?: string; a12s?: FakeA12s; wrap?: (fake: FakeA12s) => A12s; live?: boolean; broker?: string } = {},
) {
  const dbFile = opts.dbFile ?? join(mkdtempSync(join(tmpdir(), "studio-")), "studio.db");
  const db = openDb(dbFile);
  const a12s = opts.a12s ?? fakeA12s();
  const webDir = mkdtempSync(join(tmpdir(), "studio-web-"));
  const filesDir = mkdtempSync(join(tmpdir(), "studio-files-"));
  writeFileSync(join(webDir, "index.html"), "<!doctype html><title>Studio</title>");
  const brokerSocket = opts.broker ?? join(mkdtempSync(join(tmpdir(), "studio-broker-")), "admin.sock");
  const admin =
    opts.broker === undefined
      ? await listenAdmin(
          { db: openBrokerDb(":memory:"), vault: createVault(Buffer.alloc(32, 7)), now: Date.now },
          brokerSocket,
        )
      : undefined;
  const app = createApp({
    db,
    a12s: opts.wrap ? opts.wrap(a12s) : a12s,
    brokerSocket,
    templatesDir: TEMPLATES,
    webDir,
    filesDir,
    ownerLogin: OWNER_LOGIN,
  });
  await new Promise<void>((resolve) => app.agentServer.listen(0, "127.0.0.1", resolve));
  await new Promise<void>((resolve) => app.ownerServer.listen(0, "127.0.0.1", resolve));
  const { port } = app.agentServer.address() as AddressInfo;
  const ownerPort = (app.ownerServer.address() as AddressInfo).port;
  if (opts.live) app.live.start();
  let rpcId = 0;

  function raw(
    callers: string[],
    method: string,
    path: string,
    payload?: unknown,
    host: string = STUDIO_HOST,
  ): Promise<Raw> {
    return new Promise((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, method, path }, (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (text += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : null }));
      });
      req.on("error", reject);
      // An array value sends one header line per element, which is how a duplicated header reaches the app.
      if (callers.length > 0) req.setHeader(CALLER_HEADER, callers);
      req.setHeader("host", host);
      req.setHeader("content-type", "application/json");
      req.setHeader("accept", "application/json, text/event-stream");
      req.end(payload === undefined ? undefined : JSON.stringify(payload));
    });
  }

  function rpc(callers: string[], method: string, params: unknown): Promise<Raw> {
    return raw(callers, "POST", "/mcp", { jsonrpc: "2.0", id: ++rpcId, method, params });
  }

  async function tool(agent: string, name: string, args: Record<string, unknown> = {}): Promise<ToolAnswer> {
    const { status, body } = await rpc([agent], "tools/call", { name, arguments: args });
    if (status !== 200) throw new Error(`tools/call ${name} answered ${status}: ${JSON.stringify(body)}`);
    const result = (body as { result?: { content: { text: string }[]; isError?: boolean } }).result;
    if (!result) throw new Error(`tools/call ${name}: ${JSON.stringify(body)}`);
    const parsed = (() => {
      try {
        return JSON.parse(result.content[0]?.text ?? "null");
      } catch {
        return { code: "invalid_input", message: result.content[0]?.text };
      }
    })();
    return result.isError ? { error: parsed } : parsed;
  }

  // Two teams from the templates: web (web-lead, web-dev) and notes (notes-lead, notes-researcher).
  async function twoTeams(): Promise<void> {
    for (const [slug, template] of [
      ["web", "website"],
      ["notes", "research-notes"],
    ] as const) {
      await app.teams.createTeam({
        name: slug,
        purpose: `The ${slug} team.`,
        accent: "#888888",
        template,
        lead: "lead",
      });
    }
  }

  // A request to the owner listener as a local browser sends it, unless `headers` says otherwise.
  function owner(
    method: string,
    path: string,
    payload?: unknown,
    headers: Record<string, string> = {},
  ): Promise<Raw & { headers: Record<string, unknown> }> {
    return new Promise((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port: ownerPort, method, path }, (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (text += chunk));
        res.on("end", () => {
          const json = (res.headers["content-type"] ?? "").startsWith("application/json");
          resolve({ status: res.statusCode ?? 0, body: json && text ? JSON.parse(text) : text, headers: res.headers });
        });
      });
      req.on("error", reject);
      req.setHeader("host", `127.0.0.1:${OWNER_PORT}`);
      if (method !== "GET") req.setHeader("content-type", "application/json");
      for (const [name, value] of Object.entries(headers)) req.setHeader(name, value);
      req.end(payload === undefined ? undefined : JSON.stringify(payload));
    });
  }

  // The stream as the browser reads it: each event in order, parsed.
  function stream(path = "/api/stream") {
    const events: { event: string; data: unknown }[] = [];
    const waiters: (() => void)[] = [];
    const req = request({ host: "127.0.0.1", port: ownerPort, path, headers: { host: `127.0.0.1:${OWNER_PORT}` } });
    req.on("response", (res) => {
      let buffer = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        const frames = (buffer + chunk).split("\n\n");
        buffer = frames.pop() ?? "";
        for (const frame of frames) {
          const event = /^event: (.*)$/m.exec(frame)?.[1] ?? "";
          const data = /^data: (.*)$/m.exec(frame)?.[1] ?? "null";
          events.push({ event, data: JSON.parse(data) });
        }
        for (const wake of waiters.splice(0)) wake();
      });
    });
    req.on("error", () => {});
    req.end();
    const states = () => events.filter((e) => e.event === "state").map((e) => e.data as StudioState);
    return {
      events,
      states,
      // The newest state; the stream sends one on connect, so after next(1) there is one.
      last(): StudioState {
        const state = states().at(-1);
        if (!state) throw new Error("no state yet");
        return state;
      },
      close: () => req.destroy(),
      // Resolves once at least n events have arrived.
      async next(n: number) {
        while (events.length < n) await new Promise<void>((resolve) => waiters.push(resolve));
      },
    };
  }

  async function close(): Promise<void> {
    await app.scheduler.stop();
    await app.live.stop();
    app.stream.close();
    app.ownerServer.closeAllConnections();
    await new Promise((resolve) => app.ownerServer.close(resolve));
    await new Promise((resolve) => app.agentServer.close(resolve));
    admin?.closeAllConnections();
    if (admin) await new Promise((resolve) => admin.close(resolve));
    db.close();
  }

  return { app, a12s, db, dbFile, filesDir, ownerPort, raw, rpc, tool, owner, stream, twoTeams, close };
}

export type Studio = Awaited<ReturnType<typeof studio>>;

export function pending(a12s: FakeA12s, agent: string) {
  return (a12s.agents.get(agent)?.inbox ?? []).filter((m) => m.state === "pending");
}

// A Studio message's own text, as the agent receives it between two rules (build-spec 5.3).
export function bodyOf(received: string): string | undefined {
  return received.split("\n---")[1]?.slice(1);
}

export async function until(check: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
