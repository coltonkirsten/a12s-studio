import type { MessageId, ThreadId } from "./names.ts";
import type { MessageView, Settings, ThreadStatus } from "./state.ts";

export type ErrorBody = { code: string; message: string; fix?: string };

export type WriteResult = { rev: number; id?: string };

export type Template = { id: string; purpose: string; agents: string[] };
export type TemplatesResponse = { templates: Template[] };

export type CreateTeamBody = { name: string; purpose: string; accent: string; template: string };

export type PatchTeamBody = {
  name?: string;
  purpose?: string;
  accent?: string;
  dailyBudgetUsd?: number;
  paused?: boolean;
};

export type HireBody = { slug: string; role: string; model: string };

export type PatchAgentBody = {
  role?: string;
  model?: string;
  sleepAfterIdle?: string;
  compactMinTokens?: number;
  cpu?: number | null;
  memory?: string | null;
};

// The six fields PATCH /agents/:agent takes, as they are now; cpu and memory are null for a12s's default.
export type AgentSettings = Required<PatchAgentBody>;

export type PowerBody = { state: "awake" | "asleep" };

export type NewThreadBody = { title?: string; body: string; to?: string };

export type PostMessageBody = { body: string; to?: string; ask?: MessageId };

export type PatchThreadBody = { status?: ThreadStatus; title?: string; owner?: string };

export type MessagesPage = { messages: MessageView[]; hasMore: boolean };

export type PatchSettingsBody = Partial<Settings>;

export type TurnSummary = {
  id: string;
  status: "completed" | "failed" | "interrupted";
  error: string | null;
  startedAt: number | null;
  finishedAt: number;
  text: string;
};
export type TurnsResponse = { turns: TurnSummary[] };

// One tool call of a Turn. input and output are shown as text, cut at a few thousand characters; parent is the id of
// the sub-agent call it was made under. finishedAt is null while the call runs.
export type ToolCall = {
  id: string;
  name: string;
  line: string;
  input: string;
  output: string | null;
  isError: boolean;
  parent: string | null;
  startedAt: number;
  finishedAt: number | null;
};
export type TurnEventsResponse = { calls: ToolCall[] };

// A message the agent has not received yet: queued in Studio, or sent to its a12s inbox and not yet taken by a Turn.
export type InboxItem = MessageView & { thread: ThreadId | null; delivery: "queued" | "sent" };
export type InboxResponse = { messages: InboxItem[] };

export type FileEntry = { name: string; kind: "file" | "dir" | "link" | "other"; size: number; modTime: number };
export type FileView =
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

export type PutFileBody = { content: string; encoding: "utf-8" | "base64" };

// The terminal WebSocket: binary frames carry the terminal's bytes both ways; a text frame from the browser is a
// resize. A terminal a12s would not open closes with 1011 and a12s's error code (such as "asleep") as the reason.
export type TerminalResize = { rows: number; cols: number };
