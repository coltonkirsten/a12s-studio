import type { RunIndex, RunStep } from "@a12s-studio/contract/api";

// Reading the harness's session transcript: Claude Code writes one JSON object per line. Every line is the agent's
// own data, read for what it records and never acted on. Pure, so the shapes are tested with tables.

// The largest part of one transcript file the Stop hook sends at once (its `head -c`), so a body is bounded.
export const CHUNK_MAX = 32 * 1024 * 1024;

type Line = Record<string, unknown>;
export type TurnStart = { id: string; at: number };

const record = (value: unknown): Line | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Line) : null;
const str = (value: unknown): string => (typeof value === "string" ? value : "");

function parse(line: string): Line | null {
  try {
    return record(JSON.parse(line));
  } catch {
    return null;
  }
}

function timeOf(line: Line | null): number | null {
  const at = Date.parse(str(line?.timestamp));
  return Number.isNaN(at) ? null : at;
}

// The whole lines at the start of a chunk and the bytes they take. A chunk with no line break that fills the
// largest chunk the hook sends is one line too long to send whole; it is taken as it is, so the transcript moves on.
export function wholeLines(chunk: Buffer, cap: number): { lines: string[]; used: number } {
  const end = chunk.lastIndexOf(0x0a);
  const used = end >= 0 ? end + 1 : chunk.length >= cap ? chunk.length : 0;
  const lines = chunk.subarray(0, used).toString("utf8").split("\n");
  if (lines.at(-1) === "") lines.pop();
  return { lines, used };
}

// Each line goes to the Turn that started last at or before the time it was written; a line with no time of its own
// goes with the one before it. Lines older than `floor` are past keeping; lines older than every Turn go to the first.
// `starts` is in time order.
export function assign(lines: string[], starts: TurnStart[], floor: number): Map<string, string[]> {
  const turns = new Map<string, string[]>();
  let at: number | null = null;
  for (const line of lines) {
    at = timeOf(parse(line)) ?? at;
    if (at !== null && at < floor) continue;
    let turn = starts[0];
    for (const start of starts) if (at !== null && start.at <= at) turn = start;
    if (!turn) continue;
    const list = turns.get(turn.id) ?? [];
    list.push(line);
    turns.set(turn.id, list);
  }
  return turns;
}

function cut(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

const json = (value: unknown): string => (typeof value === "string" ? value : (JSON.stringify(value) ?? ""));

// A tool result's content: a string, or blocks of which the text ones are kept and the rest named.
function resultText(content: unknown): string {
  if (!Array.isArray(content)) return json(content);
  return content
    .map((block) => {
      const b = record(block);
      return b?.type === "text" ? str(b.text) : `[${str(b?.type) || "block"}]`;
    })
    .join("\n");
}

const HOOK = /^hook_/;
// Attachments that say what the agent was given; the rest (reminders, tool lists, the date) are shown only in full.
const CONTEXT = new Set(["instructions", "nested_memory", "compact_summary"]);

// The steps a transcript records. `max` cuts each text; `full` also keeps the lines that only restate the
// harness's own context.
// A run's file holds each source file's lines as they were sent, the main session's and each sub-agent's in turn, so
// the lines are put in the order they were written; a line with no time of its own stays after the one before it.
function inTimeOrder(lines: string[]): Line[] {
  let last = Number.NEGATIVE_INFINITY;
  return lines
    .map((raw, i) => {
      const line = parse(raw);
      last = timeOf(line) ?? last;
      return { line, at: last, i };
    })
    .sort((a, b) => a.at - b.at || a.i - b.i)
    .flatMap((x) => (x.line ? [x.line] : []));
}

export function steps(lines: string[], max: number, full: boolean): RunStep[] {
  const out: RunStep[] = [];
  const calls = new Map<string, { step: RunStep; at: number | null }>();
  for (const line of inTimeOrder(lines)) {
    const at = timeOf(line);
    const agent = line.isSidechain === true ? str(line.agentId) || null : null;
    const step = (kind: RunStep["kind"], name: string, text: string, isError = false, ms: number | null = null) => {
      const made: RunStep = {
        id: null,
        child: null,
        at,
        kind,
        agent,
        name,
        text: cut(text, max),
        output: null,
        isError,
        ms,
      };
      out.push(made);
      return made;
    };
    const message = record(line.message);
    const content = message?.content;
    switch (line.type) {
      case "user": {
        if (typeof content === "string") {
          step(line.isCompactSummary === true || line.isMeta === true ? "context" : "prompt", "", content);
          break;
        }
        for (const block of Array.isArray(content) ? content : []) {
          const b = record(block);
          if (b?.type === "tool_result") {
            const call = calls.get(str(b.tool_use_id));
            if (!call) continue;
            call.step.output = cut(resultText(b.content), max);
            call.step.isError = b.is_error === true;
            call.step.ms = at !== null && call.at !== null ? at - call.at : null;
            call.step.child = str(record(line.toolUseResult)?.agentId) || null;
          } else if (b?.type === "text") step("prompt", "", str(b.text));
        }
        break;
      }
      case "assistant": {
        if (line.isApiErrorMessage === true) {
          step("error", "api", resultText(content), true);
          break;
        }
        for (const block of Array.isArray(content) ? content : []) {
          const b = record(block);
          if (b?.type === "text" && str(b.text)) step("text", "", str(b.text));
          else if (b?.type === "thinking" && str(b.thinking)) step("text", "thinking", str(b.thinking));
          else if (b?.type === "tool_use") {
            const made = step("tool", str(b.name), json(b.input));
            made.id = str(b.id) || null;
            calls.set(str(b.id), { step: made, at });
          }
        }
        break;
      }
      case "system": {
        const error = record(line.error);
        if (line.subtype === "api_error") {
          const attempt = typeof line.retryAttempt === "number" ? ` (retry ${line.retryAttempt})` : "";
          step("error", "api_error", `${str(error?.formatted) || str(error?.message)}${attempt}`, true);
        } else if (full) step("context", str(line.subtype), str(line.content) || json(line));
        break;
      }
      case "attachment": {
        const a = record(line.attachment);
        const type = str(a?.type);
        if (HOOK.test(type)) {
          const failed = /error/.test(type) || (typeof a?.exitCode === "number" && a.exitCode !== 0);
          const said = str(a?.content) || str(a?.stdout) || str(a?.stderr) || str(a?.additionalContext);
          const ms = typeof a?.durationMs === "number" ? a.durationMs : null;
          step("hook", str(a?.hookName) || str(a?.command), said, failed, ms);
        } else if (type === "queued_command") step("prompt", "steered", str(a?.prompt) || json(a?.prompt));
        else if (CONTEXT.has(type) || full) step("context", type, json(a));
        break;
      }
    }
  }
  return out;
}

export function index(lines: string[], bytes: number): RunIndex {
  const parsed = lines.map(parse);
  const times = parsed.map(timeOf).filter((t) => t !== null);
  const tools = new Map<string, RunIndex["tools"][number]>();
  // agent and tool of every tool whose latest call failed
  const failing = new Set<string>();
  const result: RunIndex = {
    lines: lines.length,
    bytes,
    unparsed: parsed.filter((line) => line === null).length,
    firstAt: times.reduce<number | null>((a, t) => (a === null || t < a ? t : a), null),
    lastAt: times.reduce<number | null>((a, t) => (a === null || t > a ? t : a), null),
    tools: [],
    stallMs: 0,
    errors: 0,
    retries: { tool: 0, api: 0 },
    hooks: { runs: 0, errors: 0 },
    subAgents: 0,
  };
  const agents = new Set<string>();
  const all = steps(lines, Number.POSITIVE_INFINITY, false);
  for (const s of all) {
    if (s.agent) agents.add(s.agent);
    if (s.kind === "tool") {
      const tool = tools.get(s.name) ?? { name: s.name, calls: 0, errors: 0, ms: 0, maxMs: 0, maxInput: 0 };
      tools.set(s.name, tool);
      tool.calls++;
      tool.ms += s.ms ?? 0;
      tool.maxMs = Math.max(tool.maxMs, s.ms ?? 0);
      tool.maxInput = Math.max(tool.maxInput, s.text.length);
      const key = `${s.agent ?? ""}\0${s.name}`;
      if (failing.has(key)) result.retries.tool++;
      if (s.isError) {
        tool.errors++;
        result.errors++;
        failing.add(key);
      } else failing.delete(key);
    } else if (s.kind === "error") {
      result.errors++;
      if (s.name === "api_error") result.retries.api++;
    } else if (s.kind === "hook") {
      result.hooks.runs++;
      if (s.isError) result.hooks.errors++;
    }
  }
  result.tools = [...tools.values()];
  result.subAgents = agents.size;
  result.stallMs = stall(times, all);
  return result;
}

// The longest gap between two lines that no tool call spans: time the agent waited on its model.
function stall(times: number[], all: RunStep[]): number {
  const calls = all.flatMap((s) => (s.kind === "tool" && s.at !== null && s.ms !== null ? [[s.at, s.at + s.ms]] : []));
  const sorted = [...times].sort((a, b) => a - b);
  let longest = 0;
  for (let i = 1; i < sorted.length; i++) {
    const [from = 0, to = 0] = [sorted[i - 1], sorted[i]];
    if (calls.some(([start = 0, end = 0]) => start <= from && end >= to)) continue;
    longest = Math.max(longest, to - from);
  }
  return longest;
}

// Input, cache writes, cache reads and output priced relative to input, as every Claude model prices them.
const WEIGHT = { input_tokens: 1, cache_creation_input_tokens: 1.25, cache_read_input_tokens: 0.1, output_tokens: 5 };

// Each agent's share of a run's model spend, the agent itself as null. The harness writes a response's usage on every
// line of that response, so each message id counts once.
export function shares(lines: string[]): { agent: string | null; share: number }[] {
  const seen = new Set<string>();
  const spent = new Map<string | null, number>();
  for (const line of lines.map(parse)) {
    const message = record(line?.message);
    const usage = record(message?.usage);
    if (line?.type !== "assistant" || !usage) continue;
    const agent = line.isSidechain === true ? str(line.agentId) || null : null;
    const key = `${agent ?? ""}\0${str(message?.id) || str(line.uuid)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    let weighted = 0;
    for (const [field, weight] of Object.entries(WEIGHT)) {
      const n = usage[field];
      if (typeof n === "number") weighted += n * weight;
    }
    spent.set(agent, (spent.get(agent) ?? 0) + weighted);
  }
  const total = [...spent.values()].reduce((a, b) => a + b, 0);
  return [...spent].map(([agent, weighted]) => ({ agent, share: total > 0 ? weighted / total : 0 }));
}
