import type { AgentView, Presence, WorkItem } from "@a12s-studio/contract/state";
import { shortTime } from "../logic/time.ts";

const WAITING = {
  cap: "Waiting for a free slot",
  budget: "Waiting: budget reached",
  paused: "Paused",
  disk: "Waiting for disk space",
} as const;

const LABEL: Record<Presence, string> = {
  unknown: "Not known yet",
  asleep: "Asleep",
  awake: "Awake",
  working: "Working",
  waiting: "Waiting",
  error: "Error",
};

const KIND: Record<WorkItem["kind"], string> = { agent: "Sub-agent", task: "Task" };

export function Dot({ presence }: { presence: Presence }) {
  return <span className={`dot dot-${presence}`} title={LABEL[presence]} />;
}

/** One plain line: what a working agent is doing now, else its presence. */
export function doing(agent: AgentView): string {
  if (agent.presence === "working") return agent.line ?? "Working";
  if (agent.presence === "waiting") return agent.waitingFor ? WAITING[agent.waitingFor] : "Waiting";
  if (agent.presence === "error") return agent.error ?? "Error";
  return LABEL[agent.presence];
}

/** The sub-agents and background work running under an agent, one quiet line each, as a12s reports them. */
export function WorkList({ items }: { items: WorkItem[] }) {
  if (items.length === 0) return null;
  const now = Date.now();
  return (
    <ul className="work">
      {items.map((item) => {
        const since = `since ${shortTime(item.startedAt, now)}`;
        return (
          <li
            key={item.id}
            className="work-item"
            title={[KIND[item.kind], item.description, since, item.line].filter(Boolean).join(" · ")}
          >
            <span className="work-kind">{KIND[item.kind]}</span>
            <span className="work-what">{item.description}</span>
            <span className="work-meta">
              {since}
              {item.line && <span className="work-line">{item.line}</span>}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
