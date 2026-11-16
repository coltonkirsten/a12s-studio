import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type Server,
  type ServerResponse,
} from "node:http";
import { type Agent, request } from "node:https";
import type { DatabaseSync } from "node:sqlite";
import { BROKER_URL, CALLER_HEADER } from "@a12s-studio/contract/names";
import { resolveCaller } from "./caller.ts";
import { audit, type GrantRow, toGrant, tx } from "./db.ts";
import { grantFor, parseTarget } from "./match.ts";
import type { Vault } from "./vault.ts";

type ForwardDeps = { db: DatabaseSync; vault: Vault; upstream: Agent; now: () => number };

// The table's CHECK constraints are what make username and header_name present for their scheme.
type CredentialRow = { nonce: Uint8Array; secret_enc: Uint8Array } & (
  | { scheme: "bearer" }
  | { scheme: "basic"; username: string }
  | { scheme: "header"; header_name: string }
);

type Refusal = { code: string; message: string; fix: string };

const CONNECT_TIMEOUT_MS = 10_000;
// Headers that belong to one connection, not to the message. Expect is here because Node has already answered it.
const HOP_BY_HOP = ["connection", "keep-alive", "te", "trailer", "transfer-encoding", "upgrade", "expect"];
// Some hosts let these replace the method or path of the request, which are what the grant was matched on.
const OVERRIDES = ["x-http-method-override", "x-http-method", "x-method-override", "x-original-url", "x-rewrite-url"];
const NEVER_UPSTREAM = ["authorization", "cookie", "host", CALLER_HEADER, ...OVERRIDES];
const NEVER_DOWNSTREAM = ["set-cookie"];

const NO_CALLER: Refusal = {
  code: "no_caller",
  message: "The request does not say which agent sent it.",
  fix: `Call ${BROKER_URL} from an agent computer; a12s adds the caller.`,
};
const BAD_TARGET: Refusal = {
  code: "bad_target",
  message: "The address is not /<host>/<path> with a plain lower-case host name and a plain path.",
  fix: `Call ${BROKER_URL}/<host>/<path>, for example ${BROKER_URL}/api.example.com/v1/items.`,
};

function passable(headers: IncomingHttpHeaders, never: string[]): OutgoingHttpHeaders {
  const named = (headers.connection ?? "").split(",").map((name) => name.trim().toLowerCase());
  // CGI-style hosts read "_" in a header name as "-".
  const dropped = (name: string) =>
    name.startsWith("proxy-") ||
    HOP_BY_HOP.includes(name) ||
    named.includes(name) ||
    never.includes(name.replaceAll("_", "-"));
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !dropped(name)));
}

function credentialHeader(credential: CredentialRow, secret: string): [name: string, value: string] {
  if (credential.scheme === "bearer") return ["authorization", `Bearer ${secret}`];
  if (credential.scheme === "basic") {
    return ["authorization", `Basic ${Buffer.from(`${credential.username}:${secret}`).toString("base64")}`];
  }
  // Lower case, as the agent's header names arrive, so it replaces the agent's header of that name.
  return [credential.header_name.toLowerCase(), secret];
}

function answer(res: ServerResponse, status: number, body: Refusal): void {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

function forward({ db, vault, upstream, now }: ForwardDeps, req: IncomingMessage, res: ServerResponse): void {
  const method = req.method ?? "";
  const caller = resolveCaller(req);
  const target = parseTarget(req.url ?? "");
  const deny = (status: number, refusal: Refusal) => {
    audit(db, now(), {
      teamId: caller?.teamId ?? "",
      agentId: caller?.agentId,
      actor: "agent",
      action: "deny",
      host: target?.host,
      method,
      path: target?.path,
      status,
      detail: refusal.code,
    });
    answer(res, status, refusal);
  };

  if (!caller) {
    deny(403, NO_CALLER);
    return;
  }
  if (!target) {
    deny(400, BAD_TARGET);
    return;
  }
  const { teamId, agentId } = caller;
  const { host, path } = target;
  const credential = db.prepare("SELECT * FROM credentials WHERE team_id = ? AND host = ?").get(teamId, host) as
    | CredentialRow
    | undefined;
  const grants = db.prepare("SELECT * FROM grants WHERE team_id = ? AND host = ?").all(teamId, host) as GrantRow[];
  const grant = grantFor(grants.map(toGrant), method, path, now());
  // One answer for a missing credential and a missing grant, so an agent cannot learn which hosts have credentials.
  if (!credential || !grant) {
    deny(403, {
      code: "no_access",
      message: `Your team has no grant for ${method} ${host}${path}.`,
      fix: 'Use the access tool: action "list" shows what the team can reach, action "request" asks the owner for more.',
    });
    return;
  }

  const headers = passable(req.headers, NEVER_UPSTREAM);
  const secret = vault.open(teamId, host, { nonce: credential.nonce, secretEnc: credential.secret_enc });
  const [name, value] = credentialHeader(credential, secret);
  headers[name] = value;
  const call = { teamId, agentId, actor: "agent", host, method, path, grantId: grant.id } as const;
  const out = request({ agent: upstream, host, port: 443, method, path: path + target.query, headers });

  out.once("socket", (socket) => {
    // A socket reused from the pool is already connected; a timer on it would cut a slow upload instead.
    if (!socket.connecting) return;
    socket.setTimeout(CONNECT_TIMEOUT_MS, () => out.destroy(new Error("connect timed out")));
    socket.once("secureConnect", () => socket.setTimeout(0));
  });

  out.on("response", (up) => {
    const status = up.statusCode ?? 502;
    // Passing a 401 through would make git prompt for a password, and it tells the owner nothing.
    if (status === 401) {
      tx(db, () => {
        db.prepare("UPDATE credentials SET rejected_at = ? WHERE team_id = ? AND host = ?").run(now(), teamId, host);
        audit(db, now(), { ...call, action: "credential.rejected", status });
      });
      out.destroy();
      answer(res, 502, {
        code: "credential_rejected",
        message: `${host} refused the credential stored for your team.`,
        fix: "Tell the owner; the credential needs replacing in the team's access settings.",
      });
      return;
    }
    audit(db, now(), { ...call, action: "call", status });
    res.writeHead(status, passable(up.headers, NEVER_DOWNSTREAM));
    // Without this a connection lost mid-body would leave the agent waiting on a response that never ends.
    up.on("error", () => res.destroy());
    up.pipe(res);
  });

  out.on("error", (error) => {
    // Once the response is under way, its own stream reports a failure.
    if (res.headersSent) return;
    audit(db, now(), {
      ...call,
      action: "call",
      status: 502,
      detail: "code" in error ? String(error.code) : error.message,
    });
    answer(res, 502, {
      code: "upstream_failed",
      message: `The broker could not reach ${host}.`,
      fix: "Try again. If it keeps failing, tell the owner.",
    });
  });

  // The agent went away: stop the upstream call. After a finished exchange this does nothing.
  res.on("close", () => out.destroy());
  req.pipe(out);
}

export function forwardServer(deps: ForwardDeps): Server {
  // No limit on receiving a request: a git pack can take longer to upload than Node's default five minutes.
  return createServer({ requestTimeout: 0 }, (req, res) => {
    try {
      forward(deps, req, res);
    } catch (error) {
      console.error(error);
      answer(res, 500, {
        code: "internal",
        message: "The broker hit an unexpected error.",
        fix: "Tell the owner; the broker's log has the detail.",
      });
    }
  });
}
