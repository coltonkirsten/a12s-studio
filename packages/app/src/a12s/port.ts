import type { Duplex } from "node:stream";

export type Phase = "Provisioning" | "Starting" | "Ready" | "Busy" | "Stopping" | "Asleep" | "Error";
export type TurnStatus = "completed" | "failed" | "interrupted";
export type InboxState = "pending" | "claimed" | "delivered" | "withdrawn" | "discarded" | "expired" | "replaced";

export type A12sErrorCode =
  | "not_found"
  | "exists"
  | "in_use"
  | "busy"
  | "no_grant"
  | "forbidden"
  | "out_of_prefix"
  | "version_mismatch"
  | "inbox_full"
  | "asleep"
  | "unreachable"
  | "other";

export class A12sError extends Error {
  readonly code: A12sErrorCode;
  readonly fix: string | undefined;
  constructor(code: A12sErrorCode, message: string, fix?: string) {
    super(message);
    this.code = code;
    this.fix = fix;
  }
}

// A Service a12s does not run: the Controller dials host:port, and agents call the same port on <name>.a12s.
// With healthPath a12s checks it and refuses agent calls while it fails; without it the Service is Ready at once.
export type ExternalService = {
  name: string;
  host: string;
  port: number;
  mcpPath?: string;
  healthPath?: string;
};

// A Service a12s runs from an image. What the image needs to run is in its own /a12s/service.json.
export type ServiceSpec = {
  image: string;
  uses: { name: string; mcp: boolean }[];
  egress: { allow: string[] };
};

// Claude Code's hook settings: a group runs its commands for the events its matcher names (all, without one).
type HookGroup = { matcher?: string; hooks: { type: "command"; command: string; timeout?: number }[] };

export type AgentSpec = {
  harness: {
    kind: "claude-code";
    version: string;
    model: string;
    settings: {
      env?: Record<string, string>;
      hooks: {
        SessionStart: HookGroup[];
        UserPromptSubmit: HookGroup[];
        Stop: HookGroup[];
      };
    };
  };
  image: string;
  // A seccomp profile in Docker's JSON format; only an owner-token write may set it.
  security?: { seccomp: object };
  credentials: string[];
  instructions: string;
  files: Record<string, string>;
  power: { sleepAfterIdle: string; compactBeforeSleep: { minTokens: number } };
  // steer: a Message for an agent computer whose Turn runs joins that Turn, reported by turn.steered.
  inbox?: { duringTurn: "steer" };
  grants: { send: string[] };
  uses: (string | { name: string; mcp: boolean })[];
  egress: { allow: string[] };
  resources?: { cpu?: number; memory?: string };
};

// Work the harness runs on past the Turn that started it: a sub-agent, a command run in the background, a detached
// process. `kind` is the harness's own (local_agent, local_bash, …); `toolUseId` is the call that started it, absent
// for a detached process.
export type BackgroundItem = { id: string; kind: string; description: string; startedAt: number; toolUseId?: string };

export type Tokens = { input: number; output: number; cacheRead: number; cacheWrite: number };

// What each model has cost so far in the Turn's session, sub-agents included: running totals, not one Turn's share.
export type ModelCosts = Record<string, number>;

export type A12sEvent =
  | { type: "agent_computer.phase"; agent: string; at: number; phase: Phase; error?: string }
  | { type: "turn.started"; agent: string; at: number; turn: string; messageIds: string[] }
  // Messages the harness took into the running Turn.
  | { type: "turn.steered"; agent: string; at: number; turn: string; messageIds: string[] }
  | { type: "text.delta"; agent: string; at: number; turn: string; text: string }
  // The model started a thinking block, or started writing a tool call whose tool.started follows.
  | { type: "thinking"; agent: string; at: number; turn: string }
  | { type: "tool.composing"; agent: string; at: number; turn: string; id: string; name: string }
  // A background sub-agent's calls carry its launching call as `parent`, and no Turn between the agent's Turns.
  | {
      type: "tool.started";
      agent: string;
      at: number;
      turn?: string;
      id: string;
      name: string;
      input: unknown;
      parent?: string;
    }
  | {
      type: "tool.finished";
      agent: string;
      at: number;
      turn?: string;
      id: string;
      name: string;
      isError: boolean;
      output: unknown;
      parent?: string;
    }
  | {
      type: "turn.finished";
      agent: string;
      at: number;
      turn: string;
      session: string | null;
      status: TurnStatus;
      error?: string;
      modelCostsUsd: ModelCosts;
      tokens?: Tokens;
    }
  | {
      type: "task.started";
      agent: string;
      at: number;
      turn?: string;
      id: string;
      kind: string;
      description: string;
      toolUseId?: string;
    }
  | { type: "task.finished"; agent: string; at: number; id: string }
  // A Service's phase, health or restarts changed; Unhealthy is reported as Error, with the failed check as error.
  | { type: "service.phase"; service: string; at: number; phase: Phase; error?: string }
  | { type: "gap" };

// One connection to a12s. ready() resolves once no later event can be missed and rejects when a12s does not answer.
// Iterating throws unreachable when the connection is lost, and ends quietly after close(). The feed never
// reconnects: its holder opens a new one and resyncs, which is also how it knows whether a12s is up.
export type EventFeed = AsyncIterable<A12sEvent> & {
  ready(): Promise<void>;
  close(): void;
};

export type AgentStatus = {
  name: string;
  phase: Phase;
  error?: string;
  pending: number;
  background: BackgroundItem[];
};

export type ServiceStatus = { name: string; phase: Phase; error?: string };

export type Outgoing = { body: string; metadata: Record<string, string>; replaceKey: string };

export type InboxMessage = {
  id: string;
  state: InboxState;
  sender: string;
  via: string;
  body: string;
  metadata: Record<string, string>;
  replaceKey?: string;
  createdAt: number;
  // The Turn that received it, once delivered.
  turn?: string;
};

export type TurnRecord = {
  id: string;
  agent: string;
  // null when the Turn ended before the harness started a session.
  session: string | null;
  status: TurnStatus;
  error?: string;
  text: string;
  // Every Message it received in order: those it started with, then those steered into it.
  messages: { id: string; steered: boolean }[];
  // Every tool call of the Turn, a sub-agent's included.
  tools: { name: string; isError: boolean }[];
  startedAt?: number;
  finishedAt: number;
  modelCostsUsd: ModelCosts;
  tokens?: Tokens;
};

export type FileEntry = { name: string; kind: "file" | "dir" | "link" | "other"; size: number; modTime: number };

export type FileResponse =
  | { kind: "dir"; path: string; entries: FileEntry[] }
  | {
      kind: "file";
      path: string;
      size: number;
      modTime: number;
      encoding: "utf-8" | "base64";
      content: string;
      truncated: boolean;
    };

export type Terminal = { stream: Duplex; resize(rows: number, cols: number): Promise<void> };

// Every call names one agent computer or Service inside the token's prefix; a12s refuses anything else with
// out_of_prefix, which is how one team's calls can never touch another team's agents or add-ons. turnEvents, readFile, writeFile and
// openTerminal need the agent awake and are refused with asleep otherwise; the rest work on a sleeping agent.
// turnEvents yields what the Turn has journaled so far, then ends, whether or not the Turn has finished.
export type TeamA12s = {
  removeAgent(name: string): Promise<void>;
  removeService(name: string): Promise<void>;
  services(): Promise<ServiceStatus[]>;
  send(name: string, message: Outgoing): Promise<{ id: string; state: InboxState }>;
  wake(name: string): Promise<void>;
  sleep(name: string): Promise<void>;
  stop(name: string): Promise<void>;
  status(): Promise<AgentStatus[]>;
  inbox(name: string): Promise<InboxMessage[]>;
  withdraw(name: string, messageId: string): Promise<void>;
  clearInbox(name: string): Promise<void>;
  turns(name: string, limit: number): Promise<TurnRecord[]>;
  turnEvents(name: string, turn: string): AsyncIterable<A12sEvent>;
  readFile(name: string, path: string): Promise<FileResponse>;
  writeFile(name: string, path: string, content: Uint8Array): Promise<void>;
  openTerminal(name: string, size: { rows: number; cols: number }): Promise<Terminal>;
};

// Owner-token calls. putAgent and putService are here, not on TeamA12s, because a prefix token may not write a spec
// whose `uses` names a Service outside its prefix, and every agent and add-on uses the studio and broker Services.
export type A12s = {
  ensureServices(services: ExternalService[]): Promise<void>;
  createToken(team: string): Promise<string>;
  removeToken(team: string): Promise<void>;
  putAgent(name: string, spec: AgentSpec, mode: "create" | "replace"): Promise<void>;
  putService(name: string, spec: ServiceSpec): Promise<void>;
  events(): EventFeed;
  forTeam(token: string): TeamA12s;
};
