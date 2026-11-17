import type { MessageView } from "@a12s-studio/contract/state";
import { displayName } from "./names.ts";

export type Entry =
  | { kind: "message"; message: MessageView }
  | { kind: "talk"; id: string; summary: string; messages: MessageView[] };

// A chain this deep is worth naming on the folded line; a question and its answer are not.
const SHOWN_DEPTH = 3;

function betweenAgents(m: MessageView): boolean {
  return m.from !== "owner" && m.from !== "system" && m.to !== "owner";
}

/** "Lead", "Lead and Dev", "Lead, Dev and Writer". */
function names(ids: string[]): string {
  const shown = ids.map(displayName);
  const last = shown.pop() ?? "";
  return shown.length === 0 ? last : `${shown.join(", ")} and ${last}`;
}

function summary(run: MessageView[]): string {
  const agents = [...new Set(run.flatMap((m) => [m.from, m.to]))];
  const count = `${run.length} ${run.length === 1 ? "message" : "messages"}`;
  const depth = Math.max(...run.map((m) => m.depth));
  return [names(agents), count, ...(depth >= SHOWN_DEPTH ? [`${depth} deep`] : [])].join(" · ");
}

/**
 * Runs of agent-to-agent messages become one line (build-spec 7.7); the owner sees their own words, what is written
 * to them and Studio's messages as they are.
 */
export function fold(messages: MessageView[]): Entry[] {
  const entries: Entry[] = [];
  for (const message of messages) {
    const last = entries.at(-1);
    if (!betweenAgents(message)) entries.push({ kind: "message", message });
    else if (last?.kind === "talk") last.messages.push(message);
    else entries.push({ kind: "talk", id: message.id, summary: "", messages: [message] });
  }
  for (const entry of entries) if (entry.kind === "talk") entry.summary = summary(entry.messages);
  return entries;
}
