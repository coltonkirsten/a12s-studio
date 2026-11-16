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

export type Presence = "asleep" | "awake" | "working" | "waiting" | "error";
export type WaitingFor = "cap" | "budget" | "paused" | "disk";
export type ThreadStatus = "open" | "done";
export type BoardStatus = "open" | "needs_you" | "done";
export type MessageKind = "ask" | "reply" | "note";

export type AgentView = {
  id: string;
  slug: string;
  roleLine: string;
  model: string;
  presence: Presence;
  waitingFor?: WaitingFor;
  line: string | null;
  turn: { id: string; threadId: ThreadId | null; startedAt: number; text: string } | null;
  queued: number;
  error?: string;
};

export type ThreadSummary = {
  id: ThreadId;
  title: string;
  ownerId: string;
  status: BoardStatus;
  updatedAt: number;
  preview: string;
  asksForYou: number;
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

export type MessageView = {
  id: MessageId;
  kind: MessageKind;
  from: string;
  to: string | null;
  ask: MessageId | null;
  body: string;
  file: string | null;
  implicit: boolean;
  at: number;
};

export type ThreadView = {
  id: ThreadId;
  teamId: string;
  title: string;
  ownerId: string;
  status: BoardStatus;
  messages: MessageView[];
  hasMore: boolean;
};

export type NeedsYouItem =
  | { kind: "question"; teamId: string; threadId: ThreadId; message: MessageView }
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
