// The steering run (build-spec section 12): two agents on tasks that depend on each other, three times over, with
// what their exchange took; then a message delivered into a running Turn. The numbers are the report; only an
// unfinished task or a runaway exchange fails.
import assert from "node:assert/strict";
import type { MessagesPage, RulesPage, ToolCall, WriteResult } from "@a12s-studio/contract/api";
import { TOOL_PREFIX } from "@a12s-studio/contract/names";
import type { Delivered, MessageView, StudioState } from "@a12s-studio/contract/state";
import {
  ANSWER_MS,
  agentOf,
  answerFrom,
  createTeam,
  messages,
  ownerMessage,
  type Studio,
  step,
  toolCalls,
} from "./studio.ts";

const RUNS = 3;
const DONE_MS = 20 * 60_000;
const MAX_EXCHANGED = 40;
const BUDGET_USD = 5;
// p3 leaves the cap at 1; each run needs both of its agents awake together.
const AWAKE_CAP = 4;
// How long after the long command has started the owner writes.
const STEER_AFTER_MS = 10_000;
const POLL_MS = 3000;
// A minute in the foreground. Not a bare sleep: Claude Code refuses a long foreground sleep and ends the call at once.
const LONG_COMMAND = "timeout 60 tail -f /dev/null; echo finished";
// The second agent of each team, by the name the owner addresses it with.
const DEV = "dev";

const TASK = [
  "Build a small record codec together with dev. A record has a name (text), an id (integer) and tags (a list of",
  "text). You write encode.py in your home: it reads one record as JSON on stdin and prints one encoded line. Dev",
  "writes decode.py in theirs: it reads one encoded line and prints the record as JSON. Neither of you can see the",
  "other's files. Agree the wire format with dev in this thread. Then exchange three test records each, as pairs",
  "of record and encoded line, and each of you runs the other's three against your own program. When all six",
  "pass, send me the format in one message and set this thread to done.",
].join(" ");

type Row = {
  exchanged: number;
  steered: number;
  woke: number;
  depth: number;
  turns: number;
  costUsd: number;
  // The longest run of messages between the two with no tool call but post before each; null when unmeasured.
  idleRun: number | null;
  minutes: number;
  failure: string | null;
};

const threadStatus = (state: StudioState, team: string, thread: string) =>
  state.teams.find((t) => t.id === team)?.threads.find((t) => t.id === thread)?.status;
const pause = (studio: Studio, team: string) => studio.api("PATCH", `/teams/${team}`, { paused: true });

async function pairTeam(studio: Studio, name: string): Promise<{ team: string; lead: string; dev: string }> {
  const team = await createTeam(studio, name, "blank", "Build small programs in two halves.");
  await studio.api("POST", `/teams/${team}/agents`, {
    slug: DEV,
    role: "Writes the half of a program the lead hands over, and checks it against the lead's half.",
    model: studio.state().settings.defaultModel,
  });
  await studio.api("PATCH", `/teams/${team}`, { dailyBudgetUsd: BUDGET_USD });
  return { team, lead: `${team}-lead`, dev: `${team}-${DEV}` };
}

// Counts a message as idle when its sender made no tool call but post since the message between the two before it.
export function idleRun(exchanged: MessageView[], start: number, calls: Map<string, ToolCall[]>): number {
  let longest = 0;
  let run = 0;
  let since = start;
  for (const m of exchanged) {
    const between = (calls.get(m.from) ?? []).filter((c) => c.startedAt > since && c.startedAt <= m.at);
    run = between.every((c) => c.name === `${TOOL_PREFIX}post`) ? run + 1 : 0;
    longest = Math.max(longest, run);
    since = m.at;
  }
  return longest;
}

// One run: a fresh team, the owner's one message, and the thread's numbers once it is done or has failed.
async function pairRun(studio: Studio, n: number): Promise<Row> {
  const { team, lead, dev } = await pairTeam(studio, `Pair ${n}`);
  const pair = new Set([lead, dev]);
  const between = (all: MessageView[]) => all.filter((m) => pair.has(m.from) && pair.has(m.to));
  const started = Date.now();
  const { thread, message } = await ownerMessage(studio, team, "Record codec", TASK);
  await studio.open(thread);
  let failure: string | null = null;
  try {
    await studio.until(
      `thread ${thread} done`,
      (s) => {
        const count = between(messages(s)).length;
        if (count > MAX_EXCHANGED) throw new Error(`the two exchanged ${count} messages, over ${MAX_EXCHANGED}`);
        return threadStatus(s, team, thread) === "done";
      },
      DONE_MS,
    );
    // The Turn that set the thread to done finishes before the numbers are read.
    await studio
      .until("neither agent working", (s) => [...pair].every((a) => agentOf(s, a)?.presence !== "working"), ANSWER_MS)
      .catch(() => {});
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  }
  const minutes = (Date.now() - started) / 60_000;

  // Read while the agents are awake: a12s answers a Turn's events only then. A run that failed may still have a
  // Turn running, which the numbers leave out.
  const page = await studio.api<MessagesPage>("GET", `/threads/${thread}/messages`);
  if (page.hasMore) throw new Error(`thread ${thread} has more messages than one page`);
  const exchanged = between(page.messages);
  const chain = (await studio.open(thread)).open?.chain;
  const owner = page.messages.find((m) => m.id === message);
  if (!chain || !owner) throw new Error(`thread ${thread} lost its chain or the owner's message`);
  const firstTurn = (agent: string) =>
    page.messages.find((m) => m.to === agent && m.delivered)?.delivered?.turn ?? null;
  let idle: number | null = null;
  try {
    const calls = new Map<string, ToolCall[]>();
    for (const agent of pair) calls.set(agent, await toolCalls(studio, agent, firstTurn(agent), owner.at, Date.now()));
    idle = idleRun(exchanged, owner.at, calls);
  } catch (error) {
    console.log(`      idle run not measured: ${error instanceof Error ? error.message : String(error)}`);
  }
  // Paused, the team's agents sleep, a Turn still running ends, and the next run has the awake cap to itself.
  await pause(studio, team);
  return {
    exchanged: exchanged.length,
    steered: exchanged.filter((m) => m.delivered?.steered === true).length,
    woke: exchanged.filter((m) => m.delivered?.steered === false).length,
    depth: chain.depth,
    turns: chain.turns,
    costUsd: chain.costUsd,
    idleRun: idle,
    minutes,
    failure,
  };
}

function printRows(rows: Row[]): void {
  const head = [
    "run",
    "exchanged",
    "joined a Turn",
    "started a Turn",
    "deepest chain",
    "Turns",
    "cost",
    "idle run",
    "min",
  ];
  const lines = rows.map((r, i) => [
    String(i + 1),
    String(r.exchanged),
    String(r.steered),
    String(r.woke),
    String(r.depth),
    String(r.turns),
    `$${r.costUsd.toFixed(2)}`,
    r.idleRun === null ? "?" : String(r.idleRun),
    r.minutes.toFixed(1),
  ]);
  const widths = head.map((h, i) => Math.max(h.length, ...lines.map((l) => (l[i] ?? "").length)));
  for (const line of [head, ...lines])
    console.log(`      ${line.map((c, i) => c.padStart(widths[i] ?? 0)).join("  ")}`);
}

// A unique word, so a check finds the text this run wrote and no earlier one.
const marker = () => `w${Date.now().toString(36)}`;

// Polls `check` every few seconds until it answers true.
async function eventually(what: string, check: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > end) throw new Error(`${what} did not show within ${timeoutMs / 1000}s`);
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

// The owner asks `agent`, the team's dev, in a new thread to run a long command in the foreground; answers the
// thread and the Turn running the command, once it runs.
async function longCommand(studio: Studio, team: string, agent: string, title: string) {
  const { thread } = await ownerMessage(
    studio,
    team,
    title,
    `Run this shell command in the foreground, not in the background: ${LONG_COMMAND}. Then tell me it has finished.`,
    DEV,
  );
  await studio.open(thread);
  const running = await studio.until(
    `${agent} running the command`,
    (s) => agentOf(s, agent)?.line?.startsWith("Running") === true,
    ANSWER_MS,
  );
  return { thread, turn: agentOf(running, agent)?.turn?.id };
}

// The owner writes to `agent`, the team's dev, in the open thread `thread`; answers how the message reached it.
async function writeTo(studio: Studio, thread: string, agent: string, body: string): Promise<Delivered> {
  const { id } = await studio.api<WriteResult>("POST", `/threads/${thread}/messages`, { body, to: DEV });
  const delivered = (s: StudioState) => messages(s).find((m) => m.id === id)?.delivered;
  return delivered(
    await studio.until(`the message to ${agent} delivered`, (s) => !!delivered(s), ANSWER_MS),
  ) as Delivered;
}

// What a restart of the agent computer would change: the harness session and the start of the container's init.
async function computer(studio: Studio, agent: string) {
  return { session: await studio.session(agent), started: await studio.shell(agent, "awk '{print $22}' /proc/1/stat") };
}

export async function steer(studio: Studio): Promise<void> {
  await step(`The awake cap is ${AWAKE_CAP}`, () => studio.api("PATCH", "/settings", { awakeCap: AWAKE_CAP }));

  const rows: Row[] = [];
  for (let n = 1; n <= RUNS; n++) {
    rows.push(await step(`Run ${n}: a pair builds a codec from one message of the owner's`, () => pairRun(studio, n)));
  }
  printRows(rows);

  const { team, lead, dev } = await step("A second team with a dev is made", () => pairTeam(studio, "Steering"));
  await step("A message to an agent in the middle of a long command joins that Turn", async () => {
    const { thread, turn } = await longCommand(studio, team, dev, "Long command");
    await new Promise((resolve) => setTimeout(resolve, STEER_AFTER_MS));
    const delivered = await writeTo(studio, thread, dev, "Also tell me the date the command finished on.");
    assert.equal(delivered.steered, true, "the message started a Turn instead of joining the running one");
    assert.equal(delivered.turn, turn, "the message joined another Turn than the one running the command");
  });

  await step("A team rule changed while dev works reaches it with its next message, without a restart", async () => {
    const before = await computer(studio, dev);
    const { thread } = await longCommand(studio, team, dev, "Another long command");
    const rule = `Begin every post with the word ${marker()}.`;
    await studio.api("PUT", `/teams/${team}/rules`, { body: rule });
    const delivered = await writeTo(studio, thread, dev, "Also tell me how long the command took.");
    console.log(`      the message ${delivered.steered ? "joined the running Turn" : "started a Turn"}`);
    await eventually(
      "the new team rule in dev's rules file",
      async () => (await studio.shell(dev, "cat ~/.studio/rules-team")).includes(rule),
      ANSWER_MS,
    );
    assert.deepEqual(await computer(studio, dev), before, "dev's session or container changed");
  });

  await step("The lead sets dev's role with the rules tool; dev's own set is refused", async () => {
    const role = `Writes the decoding half of programs. ${marker()}`;
    await ownerMessage(
      studio,
      team,
      "Dev's role",
      `Use the rules tool to set dev's role to exactly this text: ${role}`,
    );
    await eventually(
      "the new role, written by the lead",
      async () => {
        const [newest] = (await studio.api<RulesPage>("GET", `/agents/${dev}/role`)).versions;
        return newest?.body === role && newest.author === lead;
      },
      ANSWER_MS,
    );
    const asked = await ownerMessage(
      studio,
      team,
      "Team rules",
      `Use the rules tool with action set and layer team to set the team rules to: ${marker()}. ` +
        "Then tell me what the tool answered.",
      DEV,
    );
    await studio.open(asked.thread);
    const state = await studio.until(
      `${dev} done with the request`,
      (s) => answerFrom(s, dev, asked.message) !== undefined && agentOf(s, dev)?.presence !== "working",
      ANSWER_MS,
    );
    const sent = messages(state).find((m) => m.id === asked.message);
    const calls = await toolCalls(studio, dev, sent?.delivered?.turn ?? null, sent?.at ?? 0, Date.now());
    const sets = calls.filter((c) => c.name === `${TOOL_PREFIX}rules` && /"set"/.test(c.input));
    assert.ok(sets.length > 0, `${dev} made no rules set call`);
    assert.ok(
      sets.every((c) => c.isError),
      `a rules set by ${dev} was not refused: ${sets.map((c) => c.output).join("; ")}`,
    );
  });

  await step(`Each run is done within ${DONE_MS / 60_000} minutes with at most ${MAX_EXCHANGED} messages`, async () => {
    const failed = rows.flatMap((r, i) => (r.failure ? [`run ${i + 1}: ${r.failure}`] : []));
    if (failed.length > 0) throw new Error(failed.join("; "));
  });
}
