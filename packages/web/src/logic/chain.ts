import type { MessageId } from "@a12s-studio/contract/names";
import type { MessageView, ThreadView } from "@a12s-studio/contract/state";
import { displayName } from "./names.ts";

const START = 80;

/** One line of the Chain view (build-spec 7.7). `turnCostUsd` is set on the first message of each finished Turn. */
export type ChainRow = {
  id: MessageId;
  depth: number;
  from: string;
  to: string | null;
  start: string;
  delivery: string | null;
  cause: MessageId | null;
  turnCostUsd: number | null;
};

export type ChainTotals = { messages: number; depth: number; turns: number; costUsd: number };

/** How a message reached its agent: "joined Dev's turn", "woke Dev", or "waiting for Dev"; null with no agent. */
export function deliveryLine(m: MessageView): string | null {
  if (m.to === null || m.to === "owner") return null;
  const name = displayName(m.to);
  if (!m.delivered) return `waiting for ${name}`;
  return m.delivered.steered ? `joined ${name}'s turn` : `woke ${name}`;
}

/** The start of a body on one line. */
function start(body: string): string {
  const line = body.replace(/\s+/g, " ").trim();
  return line.length > START ? `${line.slice(0, START - 1)}…` : line;
}

export function chainRows(messages: MessageView[]): ChainRow[] {
  const costed = new Set<string>();
  return messages.map((m) => {
    const turn = m.delivered?.turn ?? null;
    const first = turn !== null && !costed.has(turn);
    if (turn !== null) costed.add(turn);
    return {
      id: m.id,
      depth: m.depth,
      from: m.from,
      to: m.to,
      start: start(m.body),
      delivery: deliveryLine(m),
      cause: m.cause,
      turnCostUsd: first ? (m.delivered?.costUsd ?? null) : null,
    };
  });
}

export function chainTotals(thread: ThreadView): ChainTotals {
  return { messages: thread.messages.length, ...thread.chain };
}
