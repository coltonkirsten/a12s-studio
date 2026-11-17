import type { AgentView, Presence } from "@a12s-studio/contract/state";

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
