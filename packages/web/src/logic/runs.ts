import type { RunIndex, RunStep, RunSummary } from "@a12s-studio/contract/api";
import { TOOL_PREFIX } from "@a12s-studio/contract/names";

export type FlagKind = "error" | "retry" | "stall" | "slow" | "post";
export type Flag = { kind: FlagKind; label: string };

// Where a run starts to look wrong. A stall is time with no line written and no tool running; a slow tool is one
// call; a big post is a message the agent typed out whole instead of attaching a file.
const STALL_MS = 120_000;
const SLOW_MS = 120_000;
const POST_CHARS = 4000;
const POST = `${TOOL_PREFIX}post`;

const minutes = (ms: number) => (ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)} s`);

/** What is wrong in a run, from its index alone. */
export function flagsOf(index: RunIndex): Flag[] {
  const flags: Flag[] = [];
  if (index.errors > 0) flags.push({ kind: "error", label: `${index.errors} error${index.errors === 1 ? "" : "s"}` });
  const retries = index.retries.tool + index.retries.api;
  if (retries > 0) {
    const parts = [index.retries.tool && `${index.retries.tool} tool`, index.retries.api && `${index.retries.api} API`];
    flags.push({ kind: "retry", label: `${parts.filter(Boolean).join(", ")} retr${retries === 1 ? "y" : "ies"}` });
  }
  if (index.stallMs >= STALL_MS) flags.push({ kind: "stall", label: `stalled ${minutes(index.stallMs)}` });
  const slow = index.tools.filter((t) => t.maxMs >= SLOW_MS).sort((a, b) => b.maxMs - a.maxMs)[0];
  if (slow) flags.push({ kind: "slow", label: `${toolName(slow.name)} took ${minutes(slow.maxMs)}` });
  const post = index.tools.find((t) => t.name === POST && t.maxInput >= POST_CHARS);
  if (post) flags.push({ kind: "post", label: `post of ${Math.round(post.maxInput / 1000)}k characters` });
  return flags;
}

/** A tool as the owner reads it: a Studio tool without its prefix. */
export function toolName(name: string): string {
  return name.startsWith(TOOL_PREFIX) ? name.slice(TOOL_PREFIX.length) : name;
}

export const startOf = (run: RunSummary): number => run.startedAt ?? run.index.firstAt ?? 0;
export const endOf = (run: RunSummary): number =>
  Math.max(run.finishedAt ?? run.index.lastAt ?? startOf(run), startOf(run));

/** The runs of one thread, or of one team's Turns that belong to no thread. */
export type Group = {
  key: string;
  team: string;
  thread: string | null;
  runs: RunSummary[];
  agents: string[];
  lastAt: number;
  costUsd: number;
  flags: Flag[];
};

/** Runs by thread, newest activity first; a group's runs oldest first, its flags summed by kind. */
export function groupRuns(runs: RunSummary[]): Group[] {
  const groups = new Map<string, Group>();
  for (const run of runs) {
    const key = run.thread ?? `${run.team}:none`;
    let group = groups.get(key);
    if (!group) {
      group = { key, team: run.team, thread: run.thread, runs: [], agents: [], lastAt: 0, costUsd: 0, flags: [] };
      groups.set(key, group);
    }
    group.runs.push(run);
    if (!group.agents.includes(run.agent)) group.agents.push(run.agent);
    group.lastAt = Math.max(group.lastAt, endOf(run));
    group.costUsd += run.costUsd ?? 0;
  }
  for (const group of groups.values()) {
    group.runs.sort((a, b) => startOf(a) - startOf(b));
    const counts = new Map<FlagKind, number>();
    for (const run of group.runs) for (const f of flagsOf(run.index)) counts.set(f.kind, (counts.get(f.kind) ?? 0) + 1);
    group.flags = [...counts].map(([kind, n]) => ({
      kind,
      label: `${n} run${n === 1 ? "" : "s"}: ${FLAG_NAME[kind]}`,
    }));
  }
  return [...groups.values()].sort((a, b) => b.lastAt - a.lastAt);
}

const FLAG_NAME: Record<FlagKind, string> = {
  error: "errors",
  retry: "retries",
  stall: "a long stall",
  slow: "a slow tool",
  post: "a big post",
};

/**
 * A time axis that squashes idle time: each gap longer than `gapMs` in which nothing happens is drawn `gapPx` wide,
 * and the rest of `width` is shared by the time in which something does. `spans` are [start, end] in ms.
 */
export function squashedScale(spans: [number, number][], width: number, gapMs: number, gapPx: number) {
  const sorted = [...spans].sort((a, b) => a[0] - b[0]);
  const busy: [number, number][] = [];
  for (const [start, end] of sorted) {
    const last = busy.at(-1);
    if (last && start - last[1] <= gapMs) last[1] = Math.max(last[1], end);
    else busy.push([start, Math.max(start, end)]);
  }
  const busyMs = busy.reduce((sum, [start, end]) => sum + end - start, 0);
  const gaps = Math.max(0, busy.length - 1);
  const perMs = busyMs > 0 ? Math.max(0, width - gaps * gapPx) / busyMs : 0;
  // Where each busy stretch begins on screen.
  const lefts: number[] = [];
  let left = 0;
  for (const [start, end] of busy) {
    lefts.push(left);
    left += (end - start) * perMs + gapPx;
  }
  const x = (t: number): number => {
    let i = busy.length - 1;
    while (i > 0 && (busy[i]?.[0] ?? 0) > t) i--;
    const [start = 0, end = 0] = busy[i] ?? [];
    const into = Math.min(Math.max(t, start), end) - start;
    // A time inside a squashed gap sits within the gap's width, in proportion.
    if (t > end && i < busy.length - 1) {
      const next = busy[i + 1]?.[0] ?? end;
      return (lefts[i] ?? 0) + into * perMs + ((t - end) / (next - end)) * gapPx;
    }
    return (lefts[i] ?? 0) + into * perMs;
  };
  const breaks = busy.slice(1).map(([start], i) => ({
    x: (lefts[i + 1] ?? 0) - gapPx,
    ms: start - (busy[i]?.[1] ?? start),
  }));
  return { x, breaks };
}

/** One row of a Turn's waterfall: a tool call, an error, or a sub-agent's own steps under the call that started it. */
export type Row =
  | { kind: "call"; step: RunStep; depth: number }
  | { kind: "error"; step: RunStep; depth: number }
  | { kind: "agent"; id: string; label: string; text: string; depth: number };

/** A Turn's calls in order, each sub-agent's nested under its Agent call with its last text; a sub-agent no call
 *  in this run names (it was started in an earlier Turn) goes at the end. */
export function waterfall(steps: RunStep[]): Row[] {
  const rows: Row[] = [];
  const placed = new Set<string>();
  const own = (agent: string | null, depth: number): void => {
    for (const step of steps) {
      if (step.agent !== agent) continue;
      if (step.kind === "error") rows.push({ kind: "error", step, depth });
      if (step.kind !== "tool") continue;
      rows.push({ kind: "call", step, depth });
      if (step.child && !placed.has(step.child)) {
        placed.add(step.child);
        const label = callLabel(step);
        rows.push({ kind: "agent", id: step.child, label, text: lastText(steps, step.child), depth: depth + 1 });
        own(step.child, depth + 1);
      }
    }
  };
  own(null, 0);
  for (const step of steps) {
    if (step.agent === null || placed.has(step.agent)) continue;
    placed.add(step.agent);
    // Its task is the prompt it was started with, when that is in this run; the harness's own notices are no task.
    const prompt = steps.find((s) => s.agent === step.agent && s.kind === "prompt" && !s.text.startsWith("<"));
    const label = prompt?.text || "started in an earlier Turn";
    rows.push({ kind: "agent", id: step.agent, label, text: lastText(steps, step.agent), depth: 1 });
    own(step.agent, 1);
  }
  return rows;
}

function lastText(steps: RunStep[], agent: string): string {
  return steps.findLast((s) => s.agent === agent && s.kind === "text" && s.name === "")?.text ?? "";
}

/** A call's input as the owner reads it: a sub-agent's description, a command, a path, else the raw input. */
export function callLabel(step: RunStep): string {
  let input: unknown = null;
  try {
    input = JSON.parse(step.text);
  } catch {
    return step.text;
  }
  const fields = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
  for (const key of ["description", "command", "file_path", "pattern", "url", "query", "to", "path"]) {
    const value = fields[key];
    if (typeof value === "string" && value) return value;
  }
  return step.text;
}
