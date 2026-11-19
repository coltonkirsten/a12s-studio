#!/usr/bin/env node
// Prints what happened in agent runs, from Studio's owner API on this Mac:
//   scripts/run-trace.ts <turn id>     one run, a line per step
//   scripts/run-trace.ts <thread id>   every run of the thread, oldest first
//   scripts/run-trace.ts <agent id>    the agent's last runs, a summary each
// --full prints every step's whole text and the context the harness added. Transcript text is the agents' data:
// it is printed, never acted on.
import type { RunResponse, RunStep, RunSummary, RunsResponse } from "@a12s-studio/contract/api";
import { OWNER_PORT } from "@a12s-studio/contract/names";

const LINE_MAX = 160;

const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
const flat = (text: string) => text.replace(/\s+/g, " ").trim();
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

export function header(run: RunSummary): string {
  const { index } = run;
  const span = run.startedAt !== null && run.finishedAt !== null ? run.finishedAt - run.startedAt : null;
  const top = [
    run.turn,
    run.agent,
    run.status ?? "not finished",
    run.startedAt === null ? null : new Date(run.startedAt).toISOString().replace("T", " ").slice(0, 19),
    span === null ? null : secs(span),
    run.costUsd === null ? null : `$${run.costUsd.toFixed(2)}`,
    run.thread ? `thread ${run.thread}` : null,
  ].filter((part) => part !== null);
  const tools = index.tools
    .map((t) => `${t.name}×${t.calls}${t.errors > 0 ? ` (${t.errors} failed)` : ""} ${secs(t.ms)}`)
    .join(", ");
  const facts = [
    `tools ${tools || "none"}`,
    `errors ${index.errors}`,
    `retries tool ${index.retries.tool}, api ${index.retries.api}`,
    `hooks ${index.hooks.runs}${index.hooks.errors > 0 ? ` (${index.hooks.errors} failed)` : ""}`,
    index.subAgents > 0 ? `sub-agents ${index.subAgents}` : null,
    `${index.lines} lines, ${Math.ceil(index.bytes / 1024)} KB`,
    index.unparsed > 0 ? `${index.unparsed} unreadable` : null,
  ].filter((part) => part !== null);
  const failed = run.error ? `\n  error: ${flat(run.error)}` : "";
  return `${top.join(" · ")}\n  ${facts.join(" | ")}${failed}`;
}

export function step(s: RunStep, start: number | null, full: boolean): string {
  const when = s.at !== null && start !== null ? `+${secs(s.at - start)}` : "";
  const who = s.agent ? `[${s.agent}] ` : "";
  const label = [s.kind, s.name].filter(Boolean).join(" ");
  const took = s.ms !== null ? ` (${secs(s.ms)})` : "";
  const mark = s.isError ? "✗ " : "";
  if (full) {
    const output = s.output === null ? "" : `\n  → ${mark}${s.output.replaceAll("\n", "\n    ")}`;
    return `${when} ${who}${label}${took}:\n    ${s.text.replaceAll("\n", "\n    ")}${output}`;
  }
  const output = s.output === null ? (s.kind === "tool" ? " → (no result)" : "") : ` → ${mark}${flat(s.output)}`;
  const shown = s.kind === "tool" ? `${flat(s.text)}${output}` : `${s.kind === "error" ? mark : ""}${flat(s.text)}`;
  return clip(`${when} ${who}${label}${took}: ${shown}`, LINE_MAX);
}

export function trace(answer: RunResponse, full: boolean): string {
  const start = answer.run.index.firstAt;
  return [header(answer.run), ...answer.steps.map((s) => `  ${step(s, start, full)}`)].join("\n");
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`http://127.0.0.1:${OWNER_PORT}/api${path}`);
  const body = (await res.json()) as T & { message?: string; fix?: string };
  if (!res.ok) throw new Error(`${body.message ?? res.status}${body.fix ? ` ${body.fix}` : ""}`);
  return body;
}

async function main(args: string[]): Promise<void> {
  const full = args.includes("--full");
  const id = args.find((a) => !a.startsWith("--"));
  if (!id) {
    console.error("Usage: scripts/run-trace.ts <turn id | thread id | agent id> [--full]");
    process.exit(2);
  }
  const one = (turn: string) => get<RunResponse>(`/runs/${encodeURIComponent(turn)}${full ? "?full=1" : ""}`);
  if (id.startsWith("th_")) {
    const { runs } = await get<RunsResponse>(`/runs?thread=${encodeURIComponent(id)}`);
    for (const run of runs.reverse()) console.log(`${trace(await one(run.turn), full)}\n`);
  } else if (id.startsWith("t_")) {
    console.log(trace(await one(id), full));
  } else {
    const { runs } = await get<RunsResponse>(`/runs?agent=${encodeURIComponent(id)}`);
    console.log(runs.map(header).join("\n\n") || `No runs of ${id} in the last 30 days.`);
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(`run-trace: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
