import type { MessageId } from "./names.ts";
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

export type PowerBody = { state: "awake" | "asleep" };

export type NewThreadBody = { title?: string; body: string; to?: string };

export type PostMessageBody = { body: string; to?: string; ask?: MessageId };

export type PatchThreadBody = { status?: ThreadStatus; title?: string; owner?: string };

export type MessagesPage = { messages: MessageView[]; hasMore: boolean };

export type PatchSettingsBody = Partial<Settings>;
