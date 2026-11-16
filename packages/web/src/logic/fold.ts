import type { MessageView } from "@a12s-studio/contract/state";
import { displayName } from "./names.ts";

export type Entry =
  | { kind: "message"; message: MessageView }
  | { kind: "talk"; id: string; summary: string; messages: MessageView[] };

const VERB = { ask: "asked", reply: "answered", note: "told" } as const;

function betweenAgents(m: MessageView): boolean {
  return m.from !== "owner" && m.from !== "system" && m.to !== null && m.to !== "owner";
}

/** Runs of agent-to-agent messages become one line; the owner sees their own words, answers and thread notes. */
export function fold(messages: MessageView[]): Entry[] {
  const entries: Entry[] = [];
  for (const message of messages) {
    const last = entries.at(-1);
    if (!betweenAgents(message)) entries.push({ kind: "message", message });
    else if (last?.kind === "talk") last.messages.push(message);
    else entries.push({ kind: "talk", id: message.id, summary: "", messages: [message] });
  }
  for (const entry of entries) {
    if (entry.kind !== "talk") continue;
    const [first] = entry.messages;
    if (!first) continue;
    const count = entry.messages.length;
    entry.summary = `${displayName(first.from)} ${VERB[first.kind]} ${displayName(first.to ?? "")} · ${count} ${count === 1 ? "message" : "messages"}`;
  }
  return entries;
}
