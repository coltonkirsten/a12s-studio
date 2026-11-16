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

export type AgentSpec = {
  harness: {
    kind: "claude-code";
    version: string;
    model: string;
    settings: {
      hooks: {
        SessionStart: { matcher: string; hooks: { type: "command"; command: string }[] }[];
      };
    };
  };
  image: string;
  credentials: string[];
  instructions: string;
  files: Record<string, string>;
  power: { sleepAfterIdle: string; compactBeforeSleep: { minTokens: number } };
  grants: { send: string[] };
  uses: (string | { name: string; mcp: boolean })[];
  egress: { allow: string[] };
  resources?: { cpu?: number; memory?: string };
};

export type Tokens = { input: number; output: number; cacheRead: number; cacheWrite: number };

export type A12sEvent =
  | { type: "agent_computer.phase"; agent: string; at: number; phase: Phase; error?: string }
  | { type: "turn.started"; agent: string; at: number; turn: string; session: string; messageIds: string[] }
  | { type: "text.delta"; agent: string; at: number; turn: string; text: string }
  | {
      type: "tool.started";
      agent: string;
      at: number;
      turn: string;
      id: string;
      name: string;
      input: unknown;
      parent?: string;
    }
  | {
      type: "tool.finished";
      agent: string;
      at: number;
      turn: string;
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
      session: string;
      status: TurnStatus;
      error?: string;
      costTotalUsd: number;
      tokens?: Tokens;
    }
  | { type: "gap" };

export type EventFeed = AsyncIterable<A12sEvent> & {
  ready(): Promise<void>;
  close(): void;
};

export type AgentStatus = { name: string; phase: Phase; error?: string; pending: number };

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
};

export type TurnRecord = {
  id: string;
  agent: string;
  session: string;
  status: TurnStatus;
  error?: string;
  text: string;
  messageIds: string[];
  startedAt?: number;
  finishedAt: number;
  costTotalUsd: number;
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

// Every call names one agent computer inside the token's prefix; a12s refuses anything else with out_of_prefix,
// which is how one team's calls can never touch another team's agents.
export type TeamA12s = {
  removeAgent(name: string): Promise<void>;
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

// Owner-token calls. putAgent is here, not on TeamA12s, because a prefix token may not write a spec whose `uses`
// names a Service outside its prefix, and every agent uses the studio and broker Services.
export type A12s = {
  ensureServices(services: ExternalService[]): Promise<void>;
  createToken(team: string): Promise<string>;
  removeToken(team: string): Promise<void>;
  putAgent(name: string, spec: AgentSpec, mode: "create" | "replace"): Promise<void>;
  events(): EventFeed;
  forTeam(token: string): TeamA12s;
};
