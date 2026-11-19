import type {
  AgentSettings,
  CreateTeamBody,
  ErrorBody,
  FileView,
  HireBody,
  InboxResponse,
  MessagesPage,
  NewThreadBody,
  PatchAgentBody,
  PatchSettingsBody,
  PatchTeamBody,
  PatchThreadBody,
  PostMessageBody,
  PowerBody,
  PutFileBody,
  RulesPage,
  RunResponse,
  RunsResponse,
  Template,
  TurnEventsResponse,
  TurnsResponse,
  WriteResult,
} from "@a12s-studio/contract/api";
import type {
  AccessView,
  ApproveBody,
  AuditPage,
  CreateGrantBody,
  PutCredentialBody,
} from "@a12s-studio/contract/broker-admin";
import type { AddonManifest } from "@a12s-studio/contract/state";
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";

const UNREACHABLE: ErrorBody = {
  code: "unreachable",
  message: "Studio is not answering.",
  fix: "Check that the app is running.",
};

function isErrorBody(value: unknown): value is ErrorBody {
  return typeof value === "object" && value !== null && "message" in value && typeof value.message === "string";
}

function toProblem(error: unknown): ErrorBody {
  return isErrorBody(error) ? error : { code: "error", message: String(error) };
}

async function call(method: string, path: string, body?: unknown): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      // The owner API takes a change only as JSON, which a page on another site cannot send without asking.
      headers: method === "GET" ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw UNREACHABLE;
  }
  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) throw isErrorBody(data) ? data : { code: `http_${res.status}`, message: res.statusText };
  return data;
}

async function write(method: string, path: string, body?: unknown): Promise<WriteResult> {
  const data = await call(method, path, body);
  if (typeof data !== "object" || data === null || !("rev" in data) || typeof data.rev !== "number") {
    throw { code: "bad_response", message: "Studio answered without a revision." } satisfies ErrorBody;
  }
  return { rev: data.rev, id: "id" in data && typeof data.id === "string" ? data.id : undefined };
}

/** A read's answer, once each named field is the list it should be. */
async function read<T>(path: string, lists: string[], what: string): Promise<T> {
  const data = await call("GET", path);
  if (typeof data !== "object" || data === null || !lists.every((key) => Array.isArray(Reflect.get(data, key)))) {
    throw { code: "bad_response", message: `Studio sent no ${what}.` } satisfies ErrorBody;
  }
  return data as T;
}

const at = encodeURIComponent;
const page = (before?: number) => (before === undefined ? "" : `?before=${before}`);

export const api = {
  templates: async () => (await read<{ templates: Template[] }>("/templates", ["templates"], "templates")).templates,
  createTeam: (body: CreateTeamBody) => write("POST", "/teams", body),
  patchTeam: (team: string, body: PatchTeamBody) => write("PATCH", `/teams/${at(team)}`, body),
  deleteTeam: (team: string) => write("DELETE", `/teams/${at(team)}`),
  hire: (team: string, body: HireBody) => write("POST", `/teams/${at(team)}/agents`, body),
  fire: (agent: string) => write("DELETE", `/agents/${at(agent)}`),
  power: (agent: string, state: PowerBody["state"]) => write("POST", `/agents/${at(agent)}/power`, { state }),
  stop: (agent: string) => write("POST", `/agents/${at(agent)}/stop`),
  newThread: (team: string, body: NewThreadBody) => write("POST", `/teams/${at(team)}/threads`, body),
  post: (thread: string, body: PostMessageBody) => write("POST", `/threads/${at(thread)}/messages`, body),
  seen: (thread: string) => write("POST", `/threads/${at(thread)}/seen`, {}),
  patchThread: (thread: string, body: PatchThreadBody) => write("PATCH", `/threads/${at(thread)}`, body),
  patchSettings: (body: PatchSettingsBody) => write("PATCH", "/settings", body),
  access: (team: string) =>
    read<AccessView>(`/teams/${at(team)}/access`, ["credentials", "grants", "requests"], "access"),
  audit: (team: string, before?: number) =>
    read<AuditPage>(`/teams/${at(team)}/audit${before === undefined ? "" : `?before=${before}`}`, ["entries"], "audit"),
  putCredential: (team: string, host: string, body: PutCredentialBody) =>
    write("PUT", `/teams/${at(team)}/credentials/${at(host)}`, body),
  deleteCredential: (team: string, host: string) => write("DELETE", `/teams/${at(team)}/credentials/${at(host)}`),
  grant: (team: string, body: CreateGrantBody) => write("POST", `/teams/${at(team)}/grants`, body),
  revoke: (team: string, grant: string) => write("DELETE", `/teams/${at(team)}/grants/${at(grant)}`),
  approve: (team: string, request: string, body: ApproveBody) =>
    write("POST", `/teams/${at(team)}/requests/${at(request)}/approve`, body),
  deny: (team: string, request: string) => write("POST", `/teams/${at(team)}/requests/${at(request)}/deny`),
  putAddon: (manifest: AddonManifest) => write("PUT", `/addons/${at(manifest.id)}`, manifest),
  removeAddon: (addon: string) => write("DELETE", `/addons/${at(addon)}`),
  addonOn: (team: string, addon: string) => write("PUT", `/teams/${at(team)}/addons/${at(addon)}`, {}),
  addonOff: (team: string, addon: string) => write("DELETE", `/teams/${at(team)}/addons/${at(addon)}`),
  rules: (before?: number) => read<RulesPage>(`/rules${page(before)}`, ["versions"], "rules"),
  putRules: (body: string) => write("PUT", "/rules", { body }),
  teamRules: (team: string, before?: number) =>
    read<RulesPage>(`/teams/${at(team)}/rules${page(before)}`, ["versions"], "rules"),
  putTeamRules: (team: string, body: string) => write("PUT", `/teams/${at(team)}/rules`, { body }),
  role: (agent: string, before?: number) =>
    read<RulesPage>(`/agents/${at(agent)}/role${page(before)}`, ["versions"], "role"),
  agent: (agent: string) => read<AgentSettings>(`/agents/${at(agent)}`, [], "agent settings"),
  patchAgent: (agent: string, body: PatchAgentBody) => write("PATCH", `/agents/${at(agent)}`, body),
  turns: (agent: string) => read<TurnsResponse>(`/agents/${at(agent)}/turns`, ["turns"], "Turns"),
  turnEvents: (agent: string, turn: string) =>
    read<TurnEventsResponse>(`/agents/${at(agent)}/turns/${at(turn)}/events`, ["calls"], "tool calls"),
  runs: () => read<RunsResponse>("/runs", ["runs"], "runs"),
  run: (turn: string, full: boolean) =>
    read<RunResponse>(`/runs/${at(turn)}${full ? "?full=1" : ""}`, ["steps", "agents"], "run"),
  transcript: (turn: string) => `/api/runs/${at(turn)}/transcript`,
  messages: (thread: string) => read<MessagesPage>(`/threads/${at(thread)}/messages`, ["messages"], "messages"),
  inbox: (agent: string) => read<InboxResponse>(`/agents/${at(agent)}/inbox`, ["messages"], "inbox"),
  removeInbox: (agent: string, message: string) => write("DELETE", `/agents/${at(agent)}/inbox/${at(message)}`),
  clearInbox: (agent: string) => write("POST", `/agents/${at(agent)}/inbox/clear`),
  file: (agent: string, path: string) => read<FileView>(`/agents/${at(agent)}/files?path=${at(path)}`, [], "file"),
  putFile: (agent: string, path: string, body: PutFileBody) =>
    write("PUT", `/agents/${at(agent)}/files?path=${at(path)}`, body),
  attachment: (message: string, name: string) => `/api/files/${at(message)}/${at(name)}`,
  terminal: (agent: string, rows: number, cols: number) =>
    `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/agents/${at(agent)}/terminal?rows=${rows}&cols=${cols}`,
};

/** Writes one after another; the last one's result says when all of them have arrived. */
export function inOrder(writes: (() => Promise<WriteResult>)[]): Promise<WriteResult> {
  return writes.reduce((done, next) => done.then(next), Promise.resolve<WriteResult>({ rev: 0 }));
}

/** The rev of the state on screen, so an action can tell when its write has arrived. */
export const Rev = createContext(0);

export type Action = {
  pending: boolean;
  problem: ErrorBody | null;
  run: (write: () => Promise<WriteResult>, done?: (result: WriteResult) => void) => void;
};

/** A write is finished when a pushed state with at least its rev has arrived, never when the response does. */
export function useAction(): Action {
  const rev = useContext(Rev);
  const [sending, setSending] = useState(false);
  const [waiting, setWaiting] = useState<WriteResult | null>(null);
  const [problem, setProblem] = useState<ErrorBody | null>(null);
  const done = useRef<((result: WriteResult) => void) | undefined>(undefined);

  useEffect(() => {
    if (!waiting || rev < waiting.rev) return;
    setWaiting(null);
    done.current?.(waiting);
  }, [rev, waiting]);

  const run = useCallback((write: () => Promise<WriteResult>, then?: (result: WriteResult) => void) => {
    done.current = then;
    setProblem(null);
    setSending(true);
    write()
      .then(setWaiting, (error: unknown) => setProblem(toProblem(error)))
      .finally(() => setSending(false));
  }, []);

  return { pending: sending || waiting !== null, problem, run };
}

export type AccessState = { view: AccessView | null; rev: number; problem: ErrorBody | null };

/**
 * A team's credentials, grants and requests, read again whenever the state moves on. `rev` is the state the read
 * started from: below a `Rev` of that value, a write counts as finished only once the access on screen includes it.
 */
export function useAccess(team: string): AccessState {
  const rev = useContext(Rev);
  const [access, setAccess] = useState<AccessState>({ view: null, rev: 0, problem: null });
  useEffect(() => {
    let current = true;
    api.access(team).then(
      (view) => current && setAccess({ view, rev, problem: null }),
      (error: unknown) => current && setAccess((a) => ({ ...a, problem: toProblem(error) })),
    );
    return () => {
      current = false;
    };
  }, [team, rev]);
  return access;
}

export type Loaded<T> = { data: T | null; problem: ErrorBody | null };

/**
 * A plain read, done again whenever `key` changes (a path, a rev, a presence, a version the caller moves after a
 * write). The last answer stays on screen while the next one is read, so a reload does not flash.
 */
export function useRead<T>(load: () => Promise<T>, key: string): Loaded<T> {
  const loader = useRef(load);
  loader.current = load;
  const [loaded, setLoaded] = useState<Loaded<T> & { key: string | null }>({ data: null, problem: null, key: null });
  useEffect(() => {
    let current = true;
    loader.current().then(
      (data) => current && setLoaded({ data, problem: null, key }),
      (error: unknown) => current && setLoaded({ data: null, problem: toProblem(error), key }),
    );
    return () => {
      current = false;
    };
  }, [key]);
  // A refusal belongs to the read it answered: once the key has moved on (the agent woke up), it is not shown.
  return { data: loaded.data, problem: loaded.key === key ? loaded.problem : null };
}
