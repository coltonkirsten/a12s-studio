import type { AccessRequest } from "./broker-admin.ts";
import type { GrantId, MessageId, ThreadId } from "./names.ts";

export type Settings = {
  awakeCap: number;
  defaultDailyBudgetUsd: number;
  minFreeDiskGb: number;
  paused: boolean;
  defaultModel: string;
  defaultSleepAfterIdle: string;
  defaultCompactMinTokens: number;
};

export type Presence = "unknown" | "asleep" | "awake" | "working" | "waiting" | "error";
export type WaitingFor = "cap" | "budget" | "paused" | "disk";
export type ThreadStatus = "open" | "done";
export type BoardStatus = "open" | "needs_you" | "done";

export type AgentView = {
  id: string;
  slug: string;
  roleLine: string;
  model: string;
  presence: Presence;
  waitingFor?: WaitingFor;
  line: string | null;
  turn: { id: string; threadId: ThreadId | null; startedAt: number; text: string } | null;
  // Sub-agents and background work running now, oldest first.
  work: WorkItem[];
  queued: number;
  error?: string;
};

export type WorkItem = {
  id: string;
  kind: "agent" | "task";
  description: string;
  threadId: ThreadId | null;
  startedAt: number;
  // What a sub-agent is doing now; a background command or process has none.
  line: string | null;
};

export type ThreadSummary = {
  id: ThreadId;
  title: string;
  ownerId: string;
  status: BoardStatus;
  updatedAt: number;
  preview: string;
  // Messages to the owner since the owner last wrote in the thread or marked it read.
  forYou: number;
};

export type TeamView = {
  id: string;
  name: string;
  purpose: string;
  accent: string;
  paused: boolean;
  leadId: string | null;
  budget: { dailyUsd: number; spentTodayUsd: number; held: boolean };
  agents: AgentView[];
  threads: ThreadSummary[];
};

// How a message reached its agent: the Turn that received it (null where the record does not name one), whether it
// joined that Turn while it ran or started it, and the Turn's cost once it has finished.
export type Delivered = { turn: string | null; steered: boolean; at: number; costUsd: number | null };

export type MessageView = {
  id: MessageId;
  from: string;
  to: string;
  body: string;
  file: string | null;
  at: number;
  // The chain record: the message that set this one off, and how many messages deep that chain is.
  cause: MessageId | null;
  depth: number;
  // null: it has no agent to reach, or has not reached it yet.
  delivered: Delivered | null;
};

// A thread's totals: its deepest chain, and the finished Turns that belong to it (a Turn belongs to the thread of
// the first message it took) with their summed cost.
export type Chain = { depth: number; turns: number; costUsd: number };

export type ThreadView = {
  id: ThreadId;
  teamId: string;
  title: string;
  ownerId: string;
  status: BoardStatus;
  messages: MessageView[];
  hasMore: boolean;
  chain: Chain;
};

export type NeedsYouItem =
  // A thread that needs you: its newest message to you, and how many more wait.
  | { kind: "message"; teamId: string; threadId: ThreadId; message: MessageView; more: number }
  | { kind: "access_request"; teamId: string; request: AccessRequest; hostHasCredential: boolean }
  | { kind: "agent_error"; teamId: string; agentId: string; error: string }
  | { kind: "failed_turn"; teamId: string; agentId: string; turnId: string; error: string | null; at: number }
  | { kind: "budget"; teamId: string; dailyUsd: number; spentTodayUsd: number }
  | { kind: "credential_rejected"; teamId: string; host: string; at: number }
  | { kind: "grant_expiring"; teamId: string; grantId: GrantId; host: string; paths: string[]; expiresAt: number };

export type StudioState = {
  rev: number;
  a12s: "up" | "down";
  broker: "up" | "down";
  settings: Settings;
  teams: TeamView[];
  needsYou: NeedsYouItem[];
  open: ThreadView | null;
};

export type LiveText = { agent: string; turn: string; text: string };
