import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync } from "node:fs";
import {
  type ClientRequestArgs,
  type IncomingHttpHeaders,
  type IncomingMessage,
  request,
  type ServerResponse,
} from "node:http";
import { Agent, createServer } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { text } from "node:stream/consumers";
import type { TestContext } from "node:test";
import type { AuditEntry, CreateGrantBody, Grant, PutCredentialBody } from "@a12s-studio/contract/broker-admin";
import { BROKER_URL, CALLER_HEADER } from "@a12s-studio/contract/names";
import { listenAdmin } from "../src/admin.ts";
import { openDb } from "../src/db.ts";
import { forwardServer } from "../src/forward.ts";
import { createVault } from "../src/vault.ts";

export const HOST = "api.example.com";
// The value every test stores as a credential, and then looks for where it must not be.
export const SECRET = "stored-credential-marker";
// What a12s leaves on a request it passes on from the agent "web-dev".
export const VIA_A12S = { host: new URL(BROKER_URL).host };
export const FROM_AGENT = { ...VIA_A12S, [CALLER_HEADER]: "web-dev" };

type Seen = { method: string; url: string; headers: IncomingHttpHeaders; body: string };
type Handle = (req: IncomingMessage, res: ServerResponse, seen: Seen) => void;
type AuditRow = AuditEntry & { teamId: string };
export type Reply = { status: number; headers: IncomingHttpHeaders; body: string; audit: AuditRow[] };
type CallOptions = {
  method?: string;
  caller?: string | string[] | null;
  headers?: Record<string, string>;
  body?: string;
};
export type Broker = Awaited<ReturnType<typeof startBroker>>;

// The upstream answers this way unless a test sets another handler.
export function reply(status: number, headers: Record<string, string | string[]> = {}, body = ""): Handle {
  return async (req, res, seen) => {
    seen.body = await text(req);
    res.writeHead(status, headers).end(body);
  };
}

function selfSigned(): { key: string; cert: string } {
  const dir = mkdtempSync(join(tmpdir(), "broker-cert-"));
  const [key, cert] = [join(dir, "key.pem"), join(dir, "cert.pem")];
  const curve = ["-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1"];
  const subject = ["-subj", "/CN=stub", "-addext", "subjectAltName=DNS:*.example.com"];
  execFileSync(
    "openssl",
    ["req", "-x509", "-nodes", "-days", "2", ...curve, ...subject, "-keyout", key, "-out", cert],
    {
      stdio: "ignore",
    },
  );
  return { key: readFileSync(key, "utf8"), cert: readFileSync(cert, "utf8") };
}

// The broker dials <host>:443 over TLS as in production; only the socket is pointed at the local stub, which
// proves its name with a certificate this agent trusts.
class StubAgent extends Agent {
  dialed: string[] = [];
  stub: { port: number; ca: string };

  constructor(stub: { port: number; ca: string }) {
    super({ keepAlive: true });
    this.stub = stub;
  }

  override createConnection(options: ClientRequestArgs, callback?: (error: Error | null, stream: Duplex) => void) {
    this.dialed.push(`${options.host}:${options.port}`);
    return super.createConnection({ ...options, host: "127.0.0.1", ...this.stub }, callback);
  }
}

export async function startBroker(t: TestContext) {
  const { key, cert } = selfSigned();
  const upstream = { seen: [] as Seen[], handle: reply(200, { "content-type": "application/json" }, '{"ok":true}') };
  const stub = createServer({ key, cert }, (req, res) => {
    const seen = { method: req.method ?? "", url: req.url ?? "", headers: req.headers, body: "" };
    upstream.seen.push(seen);
    upstream.handle(req, res, seen);
  }).listen(0, "127.0.0.1");
  await once(stub, "listening");
  const agent = new StubAgent({ port: (stub.address() as AddressInfo).port, ca: cert });

  const clock = { now: Date.UTC(2030, 0, 1) };
  const db = openDb(":memory:");
  const deps = { db, vault: createVault(Buffer.alloc(32, 7)), now: () => clock.now };
  const forward = forwardServer({ ...deps, upstream: agent }).listen(0, "127.0.0.1");
  await once(forward, "listening");
  const { port } = forward.address() as AddressInfo;
  const socketPath = join(mkdtempSync(join(tmpdir(), "broker-")), "admin.sock");
  const adminServer = await listenAdmin(deps, socketPath);

  t.after(() => {
    agent.destroy();
    for (const server of [stub, forward, adminServer]) {
      server.close();
      server.closeAllConnections();
    }
  });

  const auditAfter = (id: number) =>
    db
      .prepare(
        `SELECT id, at, team_id AS teamId, agent_id AS agentId, actor, action, host, method, path, status,
                grant_id AS grantId, detail FROM audit WHERE id > ? ORDER BY id`,
      )
      .all(id) as AuditRow[];

  // Every response the admin API has given, as sent, for the test that searches all output for the secret.
  const adminOutput: string[] = [];

  async function admin<Body = unknown>(method: string, path: string, body?: unknown) {
    const req = request({ socketPath, method, path, headers: { "content-type": "application/json" } });
    req.end(typeof body === "string" ? body : JSON.stringify(body));
    const [res] = (await once(req, "response")) as [IncomingMessage];
    const raw = await text(res);
    adminOutput.push(raw);
    return { status: res.statusCode ?? 0, body: (raw === "" ? undefined : JSON.parse(raw)) as Body };
  }

  async function call(path: string, { method = "GET", caller = "web-dev", headers = {}, body }: CallOptions = {}) {
    const last = auditAfter(0).at(-1)?.id ?? 0;
    const identity = caller === null ? {} : { [CALLER_HEADER]: caller };
    const req = request({ host: "127.0.0.1", port, method, path, headers: { ...VIA_A12S, ...headers, ...identity } });
    req.end(body);
    const [res] = (await once(req, "response")) as [IncomingMessage];
    const result: Reply = { status: res.statusCode ?? 0, headers: res.headers, body: await text(res), audit: [] };
    result.audit = auditAfter(last);
    return result;
  }

  async function credential(team: string, host = HOST, body: Partial<PutCredentialBody> = {}) {
    const stored = await admin("PUT", `/teams/${team}/credentials/${host}`, {
      scheme: "bearer",
      secret: SECRET,
      ...body,
    });
    if (stored.status !== 200) throw new Error(`credential not stored: ${JSON.stringify(stored.body)}`);
  }

  async function grant(team: string, body: Partial<CreateGrantBody> = {}): Promise<Grant> {
    const created = await admin<Grant>("POST", `/teams/${team}/grants`, {
      host: HOST,
      methods: ["GET"],
      paths: ["/v1/items"],
      ...body,
    });
    if (created.status !== 200) throw new Error(`grant not created: ${JSON.stringify(created.body)}`);
    return created.body;
  }

  return { admin, adminOutput, agent, auditAfter, call, clock, credential, db, grant, port, socketPath, upstream };
}
