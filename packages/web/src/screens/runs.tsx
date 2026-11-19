import type { RunResponse, RunStep, RunSummary } from "@a12s-studio/contract/api";
import type { MessageView, StudioState } from "@a12s-studio/contract/state";
import { type CSSProperties, type ReactNode, type RefObject, useEffect, useRef, useState } from "react";
import { api, useRead } from "../api.ts";
import { usd } from "../logic/money.ts";
import { displayName } from "../logic/names.ts";
import { runsHref } from "../logic/route.ts";
import {
  callLabel,
  endOf,
  type Flag,
  flagsOf,
  type Group,
  groupRuns,
  type Row,
  squashedScale,
  startOf,
  toolName,
  waterfall,
} from "../logic/runs.ts";
import { shortTime } from "../logic/time.ts";
import { Icon } from "../parts/icons.tsx";
import { Problem } from "../parts/problem.tsx";

type Props = { state: StudioState; group: string | null; turn: string | null };

/** The run explorer: every thread's runs, one thread as lanes of Turns, one Turn as a waterfall of its calls. */
export function RunsScreen({ state, group, turn }: Props) {
  const runs = useRead(() => api.runs(), "runs");
  const groups = runs.data ? groupRuns(runs.data.runs) : [];
  const open = groups.find((g) => g.key === group) ?? null;
  const run = open?.runs.find((r) => r.turn === turn) ?? null;
  return (
    <div className="page runs-page">
      <header className="page-head runs-head">
        <nav className="runs-trail">
          <a href={runsHref()}>Runs</a>
          {open && (
            <>
              <Icon name="chevron" size={12} />
              <a href={runsHref(open.key)}>{groupTitle(state, open)}</a>
            </>
          )}
          {open && run && (
            <>
              <Icon name="chevron" size={12} />
              <span>{displayName(run.agent)}</span>
            </>
          )}
        </nav>
      </header>
      <Problem problem={runs.problem} />
      {runs.data && !group && <RunsList state={state} groups={groups} />}
      {runs.data && group && !open && <p className="empty">These runs are no longer kept.</p>}
      {open && !turn && <Lanes state={state} group={open} />}
      {open && turn && (run ? <Waterfall run={run} /> : <p className="empty">This run is no longer kept.</p>)}
    </div>
  );
}

function groupTitle(state: StudioState, group: Group): string {
  const team = state.teams.find((t) => t.id === group.team);
  if (!group.thread) return `${team?.name ?? group.team}: outside threads`;
  return team?.threads.find((t) => t.id === group.thread)?.title ?? "Thread";
}

function Flags({ flags }: { flags: Flag[] }) {
  if (flags.length === 0) return null;
  return (
    <span className="run-flags">
      {flags.map((f) => (
        <span key={f.kind} className="run-flag">
          {f.label}
        </span>
      ))}
    </span>
  );
}

function RunsList({ state, groups }: { state: StudioState; groups: Group[] }) {
  const now = Date.now();
  if (groups.length === 0) return <p className="empty">No runs yet. A run is kept for each Turn an agent finishes.</p>;
  return (
    <ul className="runs-list">
      {groups.map((group) => {
        const team = state.teams.find((t) => t.id === group.team);
        return (
          <li key={group.key} style={team ? ({ "--accent": team.accent } as CSSProperties) : undefined}>
            <a className={group.flags.length ? "runs-row flagged" : "runs-row"} href={runsHref(group.key)}>
              <span className="runs-row-top">
                <span className="runs-title">{groupTitle(state, group)}</span>
                <time>{shortTime(group.lastAt, now)}</time>
              </span>
              <span className="runs-row-meta">
                <span>{team?.name ?? group.team}</span>
                <span>
                  {group.runs.length} Turn{group.runs.length === 1 ? "" : "s"} by{" "}
                  {group.agents.map(displayName).join(", ")}
                </span>
                <span className="runs-cost">{usd(group.costUsd)}</span>
              </span>
              <Flags flags={group.flags} />
            </a>
          </li>
        );
      })}
    </ul>
  );
}

function useWidth<T extends HTMLElement>(): [RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setWidth(el.clientWidth));
    observer.observe(el);
    setWidth(el.clientWidth);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

type Tip = { x: number; y: number; title: string; lines: string[] } | null;

function Tooltip({ tip }: { tip: Tip }) {
  if (!tip) return null;
  return (
    <div className="run-tip" style={{ left: tip.x, top: tip.y }}>
      <strong>{tip.title}</strong>
      {tip.lines.map((line) => (
        <span key={line}>{line}</span>
      ))}
    </div>
  );
}

const LABEL_W = 112;
const LANE_H = 40;
const BLOCK_H = 22;
const AXIS_H = 24;
// Idle time longer than this is squashed, so a thread that pauses for a night still reads as one picture.
const GAP_MS = 90_000;
const GAP_PX = 22;
const LABEL_GAP = 60;

const duration = (ms: number) =>
  ms >= 3_600_000
    ? `${Math.round(ms / 360_000) / 10} h`
    : ms >= 60_000
      ? `${Math.round(ms / 60_000)} min`
      : ms >= 1000
        ? `${Math.round(ms / 100) / 10} s`
        : `${Math.max(0, Math.round(ms))} ms`;

function Lanes({ state, group }: { state: StudioState; group: Group }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [tip, setTip] = useState<Tip>(null);
  const thread = group.thread;
  const messages = useRead(() => (thread ? api.messages(thread) : Promise.resolve(null)), thread ?? group.key);
  const said = messages.data?.messages ?? [];
  const lanes = ["owner", ...group.agents];
  for (const m of said) for (const who of [m.from, m.to]) if (!lanes.includes(who)) lanes.push(who);
  const laneY = (who: string) => AXIS_H + lanes.indexOf(who) * LANE_H + LANE_H / 2;

  const sentAt = (m: MessageView) => m.at;
  const takenAt = (m: MessageView) => m.delivered?.at ?? m.at;
  const spans: [number, number][] = [
    ...group.runs.map((r): [number, number] => [startOf(r), endOf(r)]),
    // A message is busy only where it is sent and where it is taken: the wait between is idle time.
    ...said.flatMap((m): [number, number][] => [
      [sentAt(m), sentAt(m)],
      [takenAt(m), takenAt(m)],
    ]),
  ];
  const chartW = Math.max(0, width - LABEL_W - 8);
  const { x, breaks } = squashedScale(spans, chartW, GAP_MS, GAP_PX);
  const at = (t: number) => LABEL_W + x(t);
  const height = AXIS_H + lanes.length * LANE_H + 8;
  const team = state.teams.find((t) => t.id === group.team);
  const show = (e: { clientX: number; clientY: number }, title: string, lines: string[]) => {
    const box = ref.current?.getBoundingClientRect();
    if (box) setTip({ x: e.clientX - box.left + 12, y: e.clientY - box.top + 12, title, lines });
  };
  const showAt = (target: Element, title: string, lines: string[]) => {
    const r = target.getBoundingClientRect();
    show({ clientX: r.left, clientY: r.bottom }, title, lines);
  };

  return (
    <section
      className="lanes"
      ref={ref}
      style={team ? ({ "--accent": team.accent } as CSSProperties) : undefined}
      onPointerLeave={() => setTip(null)}
    >
      <p className="lanes-summary">
        {group.runs.length} Turns · {usd(group.costUsd)} · {group.agents.length} agent
        {group.agents.length === 1 ? "" : "s"}
        {breaks.length > 0 && ` · idle stretches over ${duration(GAP_MS)} are squashed`}
      </p>
      <Problem problem={messages.problem} />
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label="Turns of each agent in this thread over time">
          <defs>
            <marker id="arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
              <path d="M0 0 8 4 0 8z" className="arrow-head" />
            </marker>
          </defs>
          {lanes.map((who, i) => (
            <g key={who}>
              <line
                className="lane-rule"
                x1={LABEL_W}
                x2={width}
                y1={AXIS_H + (i + 1) * LANE_H}
                y2={AXIS_H + (i + 1) * LANE_H}
              />
              <text className="lane-label" x={0} y={laneY(who) + 4}>
                {displayName(who)}
              </text>
            </g>
          ))}
          {group.runs.length > 0 && (
            <text className="axis-label" x={LABEL_W} y={14}>
              {clock(startOf(group.runs[0] as RunSummary))}
            </text>
          )}
          {breaks.map((b, i) => (
            <g key={b.x} className="lane-break">
              <title>{`${duration(b.ms)} idle`}</title>
              <rect x={LABEL_W + b.x} y={AXIS_H} width={GAP_PX} height={lanes.length * LANE_H} />
              {/* A label that would run into the one before it is left to the break's own title. */}
              {b.x - (breaks[i - 1]?.x ?? -LABEL_GAP) >= LABEL_GAP && b.x >= LABEL_GAP * 2 && (
                <text className="axis-label" x={LABEL_W + b.x + GAP_PX / 2} y={14} textAnchor="middle">
                  {duration(b.ms)}
                </text>
              )}
            </g>
          ))}
          {group.runs.map((run) => {
            const flags = flagsOf(run.index);
            const bad = flags.some((f) => f.kind === "error" || f.kind === "stall") || run.status === "failed";
            const x0 = at(startOf(run));
            const w = Math.max(4, at(endOf(run)) - x0);
            const y = laneY(run.agent) - BLOCK_H / 2;
            const cost = run.costUsd === null ? "" : usd(run.costUsd);
            const lines = [
              `${clock(startOf(run))}, ${duration(endOf(run) - startOf(run))}`,
              cost ? `${cost}` : "Cost not known yet",
              ...(run.status === "failed" ? [`Failed${run.error ? `: ${run.error}` : ""}`] : []),
              ...flags.map((f) => f.label),
            ];
            const open = () => {
              location.hash = runsHref(group.key, run.turn);
            };
            return (
              // biome-ignore lint/a11y/useSemanticElements: an SVG mark cannot be a button element
              <g
                key={run.turn}
                className={bad ? "run-block bad" : "run-block"}
                role="button"
                tabIndex={0}
                aria-label={`${displayName(run.agent)}: ${lines.join(", ")}`}
                onClick={open}
                onKeyDown={(e) => e.key === "Enter" && open()}
                onPointerMove={(e) => show(e, displayName(run.agent), lines)}
                onFocus={(e) => showAt(e.currentTarget, displayName(run.agent), lines)}
                onBlur={() => setTip(null)}
              >
                <rect className="hit" x={x0 - 3} y={y - 6} width={w + 6} height={BLOCK_H + 12} />
                <rect x={x0} y={y} width={w} height={BLOCK_H} rx={4} />
                {cost && w > cost.length * 7 + 24 && (
                  <text x={x0 + 6} y={y + BLOCK_H / 2 + 4}>
                    {cost}
                  </text>
                )}
              </g>
            );
          })}
          {said.map((m) => {
            const x1 = at(sentAt(m));
            const x2 = at(takenAt(m));
            const y1 = laneY(m.from);
            const y2 = laneY(m.to);
            const bend = Math.abs(x2 - x1) / 2;
            const d = `M${x1} ${y1} C${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`;
            const title = `${displayName(m.from)} to ${displayName(m.to)}`;
            const lines = [m.body.length > 600 ? `${m.body.slice(0, 600)}…` : m.body];
            return (
              <g
                key={m.id}
                className="message-arrow"
                onPointerMove={(e) => show(e, title, lines)}
                onPointerLeave={() => setTip(null)}
              >
                <path d={d} className="hit" />
                <path d={d} className="arrow" markerEnd="url(#arrow)" />
                <circle cx={x1} cy={y1} r={4} className="sender-dot" />
              </g>
            );
          })}
        </svg>
      )}
      <Tooltip tip={tip} />
      <table className="sr-only">
        <caption>Turns</caption>
        <tbody>
          {group.runs.map((run) => (
            <tr key={run.turn}>
              <td>{displayName(run.agent)}</td>
              <td>{clock(startOf(run))}</td>
              <td>{duration(endOf(run) - startOf(run))}</td>
              <td>{run.costUsd === null ? "" : usd(run.costUsd)}</td>
              <td>
                {flagsOf(run.index)
                  .map((f) => f.label)
                  .join(", ")}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

const STATUS = { completed: "Done", failed: "Failed", interrupted: "Stopped", running: "Running" } as const;

const clock = (t: number) =>
  new Date(t).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

function Waterfall({ run }: { run: RunSummary }) {
  const loaded = useRead(() => api.run(run.turn, false), run.turn);
  const [full, setFull] = useState<RunResponse | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const flags = flagsOf(run.index);
  const t0 = startOf(run);
  const span = Math.max(1, endOf(run) - t0);
  const rows = loaded.data ? waterfall(loaded.data.steps) : [];
  const costs = new Map(loaded.data?.agents.map((a) => [a.agent, a.costUsd]) ?? []);
  const exact = (id: string | null) => full?.steps.find((s) => s.id === id) ?? null;
  const toggle = (key: string) => {
    setOpen(open === key ? null : key);
    if (!full) api.run(run.turn, true).then(setFull, () => undefined);
  };

  return (
    <section className="waterfall">
      <div className="waterfall-head">
        <span className={`turn-status turn-${run.status ?? "completed"}`}>{STATUS[run.status ?? "running"]}</span>
        <span>
          {clock(t0)} · {duration(span)} · {run.costUsd === null ? "cost not known yet" : usd(run.costUsd)} ·{" "}
          {run.index.tools.reduce((n, t) => n + t.calls, 0)} calls
        </span>
        <a className="waterfall-download" href={api.transcript(run.turn)}>
          Transcript
        </a>
      </div>
      <Flags flags={flags} />
      <Problem problem={loaded.problem} />
      {loaded.data && rows.length === 0 && <p className="inspector-quiet">No tool calls in this Turn.</p>}
      <ol className="waterfall-rows">
        {rows.map((row, i) => (
          <WaterfallRow
            key={row.kind === "agent" ? `agent:${row.id}` : `${row.step.id ?? "error"}:${i}`}
            row={row}
            t0={t0}
            span={span}
            cost={row.kind === "agent" ? (costs.get(row.id) ?? null) : null}
            open={open}
            toggle={toggle}
            exact={row.kind === "agent" ? null : exact(row.step.id)}
          />
        ))}
      </ol>
      {loaded.data && costs.size > 1 && (
        <p className="inspector-quiet">
          A sub-agent's cost is its share of the Turn's cost by the tokens it used, priced alike for every model.
        </p>
      )}
    </section>
  );
}

function WaterfallRow(props: {
  row: Row;
  t0: number;
  span: number;
  cost: number | null;
  open: string | null;
  toggle: (key: string) => void;
  exact: RunStep | null;
}) {
  const { row, t0, span, cost, open, toggle, exact } = props;
  const indent = { "--depth": row.depth } as CSSProperties;
  if (row.kind === "agent") {
    return (
      <li className="waterfall-agent" style={indent}>
        <span className="waterfall-agent-name">
          <span className="waterfall-agent-task">Sub-agent: {row.label}</span>
          {cost !== null && <span className="runs-cost">{usd(cost)}</span>}
        </span>
        {row.text && <p className="waterfall-agent-text">{row.text}</p>}
      </li>
    );
  }
  const step = row.step;
  const key = `${step.id ?? "error"}:${step.at}`;
  const left = step.at === null ? 0 : ((step.at - t0) / span) * 100;
  const width = Math.max(0.6, ((step.ms ?? 0) / span) * 100);
  const name = row.kind === "error" ? "API error" : toolName(step.name);
  const shown = exact ?? step;
  let bar: ReactNode = (
    <span
      className={step.isError ? "waterfall-bar failed" : "waterfall-bar"}
      style={{ left: `${Math.min(left, 99.4)}%`, width: `${Math.min(width, 100 - left)}%` }}
    />
  );
  if (row.kind === "error") bar = <span className="waterfall-mark" style={{ left: `${Math.min(left, 99)}%` }} />;
  return (
    <li className={open === key ? "waterfall-row open" : "waterfall-row"} style={indent}>
      <button type="button" className="waterfall-line" onClick={() => toggle(key)} aria-expanded={open === key}>
        <span className="waterfall-name">
          <strong>{name}</strong> {row.kind === "call" ? callLabel(step) : step.text}
        </span>
        <span className="waterfall-track">{bar}</span>
        <span className="waterfall-ms">
          {step.isError && <span className="run-flag">failed</span>}
          {step.ms === null ? "" : duration(step.ms)}
        </span>
      </button>
      {open === key && (
        <div className="waterfall-detail">
          <h4>Input</h4>
          <pre>{pretty(shown.text)}</pre>
          <h4>Output</h4>
          <pre>{shown.output ?? "No result recorded."}</pre>
          {!exact && <p className="inspector-quiet">Loading the uncut text…</p>}
        </div>
      )}
    </li>
  );
}

function pretty(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}
