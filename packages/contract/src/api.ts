import type { MessageId, ThreadId } from "./names.ts";
import type { MessageView, Settings, ThreadStatus } from "./state.ts";

export type ErrorBody = { code: string; message: string; fix?: string };

export type WriteResult = { rev: number; id?: string };

export type Template = { id: string; purpose: string; agents: string[] };
export type TemplatesResponse = { templates: Template[] };

// lead: the slug of the agent the template's lead role is hired as.
export type CreateTeamBody = { name: string; purpose: string; accent: string; template: string; lead: string };

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

// One version of the owner rules, a team's rules or a role; author is "owner" or the id of the lead that wrote it.
export type RuleVersion = { id: number; body: string; author: string; at: number };
// Newest first; the first version of the first page is the text now.
export type RulesPage = { versions: RuleVersion[]; hasMore: boolean };
export type PutRulesBody = { body: string };

export type PowerBody = { state: "awake" | "asleep" };

export type NewThreadBody = { title?: string; body: string; to?: string };

export type PostMessageBody = { body: string; to?: string };

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
// A message that joined the Turn while it ran, at the moment the harness took it in.
export type SteeredMessage = { id: MessageId; from: string; body: string; at: number };
export type TurnEventsResponse = { calls: ToolCall[]; steered: SteeredMessage[] };

// A message the agent has not received yet: queued in Studio (sentAs null), or in its a12s inbox as the a12s Message
// sentAs and not yet taken by a Turn.
export type InboxItem = MessageView & { thread: ThreadId | null; sentAs: string | null };
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

// What a Turn's transcript shows at a glance, built when its lines arrive. A tool retry is a call to the tool whose
// previous call, by the same agent or sub-agent, failed; an API retry is the harness asking the model again after
// an API error.
export type RunIndex = {
  lines: number;
  bytes: number;
  // Lines that are not JSON, as a line cut at the end of a transcript is.
  unparsed: number;
  firstAt: number | null;
  lastAt: number | null;
  // Each tool in the order it was first called; ms is the time from the calls to their results, maxMs the longest
  // one call took and maxInput the most characters one call's input had.
  tools: { name: string; calls: number; errors: number; ms: number; maxMs: number; maxInput: number }[];
  // The longest time no line was written while no tool call was running: the model or the API was slow.
  stallMs: number;
  errors: number;
  retries: { tool: number; api: number };
  hooks: { runs: number; errors: number };
  subAgents: number;
};

// A Turn whose transcript Studio holds. status and the times are a12s's, null until the Turn is stored.
export type RunSummary = {
  turn: string;
  team: string;
  agent: string;
  thread: ThreadId | null;
  session: string;
  status: "completed" | "failed" | "interrupted" | null;
  error: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  costUsd: number | null;
  index: RunIndex;
};
export type RunsResponse = { runs: RunSummary[] };

// One step of a Turn as its transcript records it, in the order written. agent is the sub-agent's id, null for the
// agent itself. A tool step's text is its input and output its result (null until there is one); a hook step's text
// is what the hook printed. Texts are cut at a few thousand characters unless the full run is asked for.
// A tool step's id is its call's; child is the sub-agent that call started, whose steps have it as their agent.
export type RunStep = {
  id: string | null;
  child: string | null;
  at: number | null;
  kind: "prompt" | "text" | "tool" | "hook" | "context" | "error";
  agent: string | null;
  name: string;
  text: string;
  output: string | null;
  isError: boolean;
  ms: number | null;
};
// costUsd: each agent's share of the run's cost (null for the agent itself), by the tokens its model calls used, priced
// alike; null while the run's cost is not known.
export type RunResponse = {
  run: RunSummary;
  steps: RunStep[];
  agents: { agent: string | null; costUsd: number | null }[];
};
