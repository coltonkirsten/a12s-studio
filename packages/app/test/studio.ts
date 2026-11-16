import { mkdtempSync } from "node:fs";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CALLER_HEADER } from "@a12s-studio/contract/names";
import { type FakeA12s, fakeA12s } from "../src/a12s/fake.ts";
import type { A12s } from "../src/a12s/port.ts";
import { createApp } from "../src/app.ts";
import { openDb } from "../src/db.ts";

const TEMPLATES = fileURLToPath(new URL("../../../teams", import.meta.url));

type Raw = { status: number; body: unknown };
export type ToolAnswer = Record<string, unknown> & { error?: { code: string; message: string; fix?: string } };

// The real app on the fake a12s and a temp database, with its agent listener on a free port. Requests carry the
// caller header the way the a12s proxy sends it.
// `wrap` puts a layer between the app and the fake, to make a12s calls fail the way a crash or an outage would.
export async function studio(opts: { dbFile?: string; a12s?: FakeA12s; wrap?: (fake: FakeA12s) => A12s } = {}) {
  const dbFile = opts.dbFile ?? join(mkdtempSync(join(tmpdir(), "studio-")), "studio.db");
  const db = openDb(dbFile);
  const a12s = opts.a12s ?? fakeA12s();
  const app = createApp({ db, a12s: opts.wrap ? opts.wrap(a12s) : a12s, templatesDir: TEMPLATES });
  await new Promise<void>((resolve) => app.agentServer.listen(0, "127.0.0.1", resolve));
  const { port } = app.agentServer.address() as AddressInfo;
  let rpcId = 0;

  function raw(callers: string[], method: string, path: string, payload?: unknown): Promise<Raw> {
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
      await app.teams.createTeam({ slug, name: slug, purpose: `The ${slug} team.`, accent: "#888888", template });
    }
  }

  function close(): Promise<void> {
    db.close();
    return new Promise((resolve) => app.agentServer.close(() => resolve()));
  }

  return { app, a12s, db, dbFile, raw, rpc, tool, twoTeams, close };
}

export type Studio = Awaited<ReturnType<typeof studio>>;

export function pending(a12s: FakeA12s, agent: string) {
  return (a12s.agents.get(agent)?.inbox ?? []).filter((m) => m.state === "pending");
}
