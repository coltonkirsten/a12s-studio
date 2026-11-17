import { type IncomingMessage, request } from "node:http";
import { text } from "node:stream/consumers";
import type { ErrorBody } from "@a12s-studio/contract/api";
import type {
  AccessRequest,
  AccessView,
  ApproveBody,
  Attention,
  AuditPage,
  CreateGrantBody,
  CreateRequestBody,
  CredentialView,
  Grant,
  PutCredentialBody,
} from "@a12s-studio/contract/broker-admin";
import { StudioError } from "./errors.ts";

// The broker answers from a local SQLite file; one that takes longer than this is not answering.
const TIMEOUT_MS = 5000;

// The broker's admin API on its unix socket. A refusal comes back as a StudioError with the broker's own code,
// message and fix; a socket that does not answer marks the broker down. No body is ever logged: one carries a secret.
export function createBrokerClient(socketPath: string, onChange: () => void) {
  let up = false;

  function mark(answered: boolean): void {
    if (answered === up) return;
    up = answered;
    console.log(`a12s Studio: the broker is ${up ? "up" : "down"}.`);
    onChange();
  }

  async function answer(res: IncomingMessage): Promise<unknown> {
    const raw = await text(res);
    const body: unknown = raw === "" ? undefined : JSON.parse(raw);
    if ((res.statusCode ?? 500) < 400) return body;
    const { code, message, fix } = body as ErrorBody;
    throw new StudioError(res.statusCode ?? 500, code, message, fix);
  }

  function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const req = request({ socketPath, method, path, timeout: TIMEOUT_MS });
      req.setHeader("content-type", "application/json");
      req.on("timeout", () => req.destroy(new Error("timed out")));
      req.on("error", (error: NodeJS.ErrnoException) => {
        mark(false);
        reject(
          new StudioError(
            503,
            "broker_down",
            `The broker does not answer (${error.code ?? error.message}).`,
            "Start the broker, then try again.",
          ),
        );
      });
      req.on("response", (res) => {
        mark(true);
        answer(res).then((value) => resolve(value as T), reject);
      });
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }

  const at = encodeURIComponent;

  return {
    up: () => up,
    attention: () => call<Attention>("GET", "/attention"),
    warned: (grantId: string) => call<void>("POST", `/grants/${at(grantId)}/warned`),

    // Every call names this one team: whoever holds the result cannot reach another team's access.
    forTeam(teamId: string) {
      const team = `/teams/${at(teamId)}`;
      return {
        access: () => call<AccessView>("GET", `${team}/access`),
        putCredential: (host: string, body: PutCredentialBody) =>
          call<CredentialView>("PUT", `${team}/credentials/${at(host)}`, body),
        deleteCredential: (host: string) => call<void>("DELETE", `${team}/credentials/${at(host)}`),
        createGrant: (body: CreateGrantBody) => call<Grant>("POST", `${team}/grants`, body),
        revokeGrant: (id: string) => call<void>("DELETE", `${team}/grants/${at(id)}`),
        request: (body: CreateRequestBody) => call<AccessRequest>("POST", `${team}/requests`, body),
        approve: (id: string, body: ApproveBody) =>
          call<AccessRequest>("POST", `${team}/requests/${at(id)}/approve`, body),
        deny: (id: string) => call<AccessRequest>("POST", `${team}/requests/${at(id)}/deny`),
        audit: (before: string | null) =>
          call<AuditPage>("GET", `${team}/audit${before === null ? "" : `?${new URLSearchParams({ before })}`}`),
        purge: () => call<void>("DELETE", team),
      };
    },
  };
}

export type BrokerClient = ReturnType<typeof createBrokerClient>;
export type TeamBroker = ReturnType<BrokerClient["forTeam"]>;
