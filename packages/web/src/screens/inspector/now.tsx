import type { SteeredMessage, ToolCall, TurnSummary } from "@a12s-studio/contract/api";
import type { AgentView } from "@a12s-studio/contract/state";
import { useState } from "react";
import { api, useRead } from "../../api.ts";
import { displayName } from "../../logic/names.ts";
import { shortTime } from "../../logic/time.ts";
import { doing } from "../../parts/presence.tsx";
import { Problem } from "../../parts/problem.tsx";
import { Refusal } from "./refusal.tsx";

const STATUS: Record<TurnSummary["status"], string> = {
  completed: "Done",
  failed: "Failed",
  interrupted: "Stopped",
};

/** The running Turn with its tool log, then the Turns before it. */
export function Now({ agent }: { agent: AgentView }) {
  const now = Date.now();
  const turn = agent.turn;
  const [open, setOpen] = useState<string | null>(null);
  const turns = useRead(() => api.turns(agent.id), `${agent.id}:${turn?.id}:${agent.presence}`);
  const earlier = turns.data?.turns.filter((t) => t.id !== turn?.id) ?? [];

  return (
    <>
      <section className="inspector-section">
        {turn ? (
          <>
            <p className="now-line">
              {doing(agent)} <time>since {shortTime(agent.since ?? turn.startedAt, now)}</time>
            </p>
            {/* A new line means a new tool call, so the log is read again when it changes. */}
            <ToolLog agent={agent} turn={turn.id} again={agent.line ?? ""} />
            {turn.text && <p className="turn-text">{turn.text}</p>}
          </>
        ) : (
          <p className="inspector-quiet">{doing(agent)}. No Turn is running.</p>
        )}
      </section>
      <section className="inspector-section">
        <h3>Earlier</h3>
        <Problem problem={turns.problem} />
        {turns.data && earlier.length === 0 && <p className="inspector-quiet">No Turns yet.</p>}
        <ul className="turns">
          {earlier.map((t) => (
            <li key={t.id} className={open === t.id ? "turn open" : "turn"}>
              <button type="button" className="turn-row" onClick={() => setOpen(open === t.id ? null : t.id)}>
                <span className={`turn-status turn-${t.status}`}>{STATUS[t.status]}</span>
                <span className="turn-first">{t.error ?? (t.text.trim().split("\n")[0] || "No text")}</span>
                <time>{shortTime(t.finishedAt, now)}</time>
              </button>
              {open === t.id && (
                <div className="turn-more">
                  {t.text && <p className="turn-text">{t.text}</p>}
                  <ToolLog agent={agent} turn={t.id} again="" />
                </div>
              )}
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}

function ToolLog({ agent, turn, again }: { agent: AgentView; turn: string; again: string }) {
  const log = useRead(() => api.turnEvents(agent.id, turn), `${turn}:${again}:${agent.presence}`);
  if (log.problem) return <Refusal agent={agent} problem={log.problem} what="Wake it to see the tool calls." />;
  if (!log.data) return null;
  const { calls, steered } = log.data;
  if (calls.length === 0 && steered.length === 0) return <p className="inspector-quiet">No tool calls.</p>;
  // One log in time order: a steered message sits between the calls it arrived between.
  const rows = [
    ...calls.map((call) => ({ at: call.startedAt, row: <Call key={call.id} call={call} /> })),
    ...steered.map((message) => ({ at: message.at, row: <Steered key={message.id} message={message} /> })),
  ].sort((a, b) => a.at - b.at);
  return <ol className="tool-log">{rows.map((r) => r.row)}</ol>;
}

function Steered({ message }: { message: SteeredMessage }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="call steered">
      <button type="button" className="call-row" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="call-line">Message from {displayName(message.from)}</span>
        <span className="call-state">joined the turn</span>
      </button>
      {open && (
        <div className="call-io">
          <pre>{message.body}</pre>
        </div>
      )}
    </li>
  );
}

function Call({ call }: { call: ToolCall }) {
  const [open, setOpen] = useState(false);
  const classes = ["call", call.parent ? "sub" : "", call.isError ? "failed" : ""].filter(Boolean).join(" ");
  return (
    <li className={classes}>
      <button type="button" className="call-row" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="call-line">{call.line}</span>
        <span className="call-state">{call.finishedAt === null ? "running" : call.isError ? "failed" : call.name}</span>
      </button>
      {open && (
        <div className="call-io">
          <pre>{call.input}</pre>
          {call.output !== null && <pre>{call.output}</pre>}
        </div>
      )}
    </li>
  );
}
