import type { MessageId } from "@a12s-studio/contract/names";
import type { ThreadView } from "@a12s-studio/contract/state";
import { useState } from "react";
import { chainRows, chainTotals } from "../logic/chain.ts";
import { usd } from "../logic/money.ts";
import { displayName } from "../logic/names.ts";

const rowId = (id: MessageId) => `chain-${id}`;

/**
 * The thread as a chain (build-spec 7.7): one line per message, oldest first, with its depth, who wrote to whom, how
 * it was delivered and, on the first message of each Turn, that Turn's cost. A row's cause is marked while the row is
 * hovered and reached with a click. Nothing here judges; a loop is seen by looking.
 */
export function ChainView({ thread }: { thread: ThreadView }) {
  const [hovered, setHovered] = useState<MessageId | null>(null);
  const rows = chainRows(thread.messages);
  const cause = rows.find((r) => r.id === hovered)?.cause ?? null;
  const totals = chainTotals(thread);
  return (
    <div className="chain">
      <p className="chain-totals">
        {totals.messages} {totals.messages === 1 ? "message" : "messages"} · deepest {totals.depth} · {totals.turns}{" "}
        {totals.turns === 1 ? "Turn" : "Turns"} · {usd(totals.costUsd)}
      </p>
      <ol className="chain-rows">
        {rows.map((row) => (
          <li key={row.id} id={rowId(row.id)} className={row.id === cause ? "chain-row cause" : "chain-row"}>
            <button
              type="button"
              disabled={row.cause === null}
              title={row.cause === null ? undefined : "Go to what set it off"}
              onMouseEnter={() => setHovered(row.id)}
              onMouseLeave={() => setHovered(null)}
              onClick={() =>
                row.cause && document.getElementById(rowId(row.cause))?.scrollIntoView({ block: "center" })
              }
            >
              <span className="chain-depth">{row.depth}</span>
              <span className="chain-who">
                {displayName(row.from)}
                {row.to !== null && ` → ${displayName(row.to)}`}
              </span>
              <span className="chain-start">{row.start}</span>
              <span className="chain-delivery">{row.delivery}</span>
              <span className="chain-cost">{row.turnCostUsd === null ? "" : usd(row.turnCostUsd)}</span>
            </button>
          </li>
        ))}
      </ol>
    </div>
  );
}
