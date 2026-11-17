import assert from "node:assert/strict";
import { test } from "node:test";
import type { Settings } from "@a12s-studio/contract/state";
import type { FakeA12s } from "../src/a12s/fake.ts";
import type { A12s } from "../src/a12s/port.ts";
import { blockedReason } from "../src/dispatcher.ts";
import { ownerPost, ownerThread } from "../src/router.ts";
import { deriveState } from "../src/state.ts";
import { pending, studio, until } from "./studio.ts";

type S = Awaited<ReturnType<typeof studio>>;

const AGENTS = ["web-lead", "web-dev", "notes-lead", "notes-researcher"] as const;
const ASKS = [
  ["web-lead", "dev"],
  ["web-dev", "lead"],
  ["notes-lead", "researcher"],
  ["notes-researcher", "lead"],
] as const;

async function setup(t: { after(fn: () => unknown): void }, opts: Parameters<typeof studio>[0] = {}): Promise<S> {
  const s = await studio(opts);
  t.after(() => s.close());
  await s.twoTeams();
  return s;
}

const phase = (s: S, agent: string) => s.a12s.agents.get(agent)?.phase;
const sleepAll = (s: S) => {
  for (const agent of AGENTS) s.a12s.setPhase(agent, "Asleep");
};
const agentView = (s: S, agent: string) =>
  deriveState(s.app, null)
    .teams.flatMap((team) => team.agents)
    .find((a) => a.id === agent);
const bodies = (s: S, agent: string) => pending(s.a12s, agent).map((m) => m.body.split("\n---\n")[1]);
// Apart in time, so the order is decided by who wrote first, not by a tie.
const later = () => new Promise((resolve) => setTimeout(resolve, 5));

async function patch(s: S, path: string, body: unknown): Promise<void> {
  const answer = await s.owner("PATCH", `/api${path}`, body);
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
}

const SETTINGS: Settings = {
  awakeCap: 2,
  defaultDailyBudgetUsd: 25,
  minFreeDiskGb: 15,
  paused: false,
  defaultModel: "sonnet",
  defaultSleepAfterIdle: "15m",
  defaultCompactMinTokens: 100000,
};
const TEAM = { paused: false, dailyBudgetUsd: 10 };
const roomy = () => 100;

const reasons: {
  name: string;
  settings?: Partial<Settings>;
  team?: Partial<typeof TEAM>;
  spent?: number;
  wake?: { awake: number; freeDiskGb: () => number } | null;
  want: ReturnType<typeof blockedReason>;
}[] = [
  { name: "nothing holds an awake agent under its budget", want: null },
  { name: "nothing holds a wake under every limit", wake: { awake: 1, freeDiskGb: roomy }, want: null },
  { name: "pause everything", settings: { paused: true }, want: "paused" },
  { name: "a paused team", team: { paused: true }, want: "paused" },
  { name: "spend at the budget", spent: 10, want: "budget" },
  { name: "spend over the budget", spent: 12.5, want: "budget" },
  { name: "a budget of zero holds everything", team: { dailyBudgetUsd: 0 }, want: "budget" },
  { name: "pause outranks the budget", team: { paused: true }, spent: 50, want: "paused" },
  { name: "the cap holds a wake", wake: { awake: 2, freeDiskGb: roomy }, want: "cap" },
  { name: "the budget outranks the cap", spent: 10, wake: { awake: 2, freeDiskGb: roomy }, want: "budget" },
  { name: "a full disk holds a wake", wake: { awake: 0, freeDiskGb: () => 14.9 }, want: "disk" },
  { name: "the cap outranks the disk", wake: { awake: 3, freeDiskGb: () => 0 }, want: "cap" },
  { name: "the cap and the disk never hold an awake agent", settings: { awakeCap: 1, minFreeDiskGb: 1e9 }, want: null },
];

for (const { name, settings, team, spent = 0, wake = null, want } of reasons) {
  test(`blockedReason: ${name}`, () => {
    assert.equal(blockedReason({ ...SETTINGS, ...settings }, { ...TEAM, ...team }, spent, wake), want);
  });
}

// A small seeded generator, so a failure names a seed that reproduces it.
function random(seed: number) {
  let a = seed;
  const next = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T;
}

// a12s takes a wake at once but reports the new phase only later, as the real Controller does.
function slowWakes(waking: Set<string>) {
  return (fake: FakeA12s): A12s => ({
    ...fake,
    forTeam(token) {
      const client = fake.forTeam(token);
      return {
        ...client,
        async wake(name) {
          waking.add(name);
        },
      };
    },
  });
}

for (const seed of [1, 2, 3, 4]) {
  test(`the awake cap is never exceeded under random arrivals, wakes that report late included (seed ${seed})`, async (t) => {
    const waking = new Set<string>();
    const s = await setup(t, { wrap: slowWakes(waking) });
    const pick = random(seed);
    const cap = pick([1, 2, 3]);
    s.app.repo.updateSettings({ awakeCap: cap });
    sleepAll(s);
    const awake = () => AGENTS.filter((a) => phase(s, a) !== "Asleep" || waking.has(a));
    let wakes = 0;

    for (let i = 0; i < 150; i++) {
      const agent = pick(AGENTS);
      const team = s.app.repo.forTeam(agent.split("-")[0] ?? "");
      const step = pick(["owner", "owner", "agent", "settle", "turn", "sleep"] as const);
      if (step === "owner") ownerThread(team, { body: `o${i}`, to: agent.split("-")[1] });
      if (step === "agent") {
        const [from, to] = pick(ASKS);
        await s.tool(from, "post", { kind: "ask", to, title: `a${i}`, body: `b${i}` });
      }
      if (step === "settle") {
        for (const name of waking) s.a12s.setPhase(name, "Ready");
        waking.clear();
      }
      const idle = phase(s, agent) === "Ready" && !waking.has(agent);
      if (step === "turn" && idle && pending(s.a12s, agent).length > 0) {
        s.a12s.startTurn(agent);
        s.a12s.finishTurn(agent);
      }
      if (step === "sleep" && idle) s.a12s.setPhase(agent, "Asleep");
      const before = waking.size;
      await s.app.dispatcher.run();
      wakes += waking.size - before;
      assert.ok(awake().length <= cap, `step ${i} (${step}): ${awake().join(", ")} awake with a cap of ${cap}`);
    }
    assert.ok(wakes > cap, `the run woke agents ${wakes} times`);
  });
}

test("while one team's status cannot be read, no agent of any team is woken", async (t) => {
  let down = false;
  const s = await setup(t, {
    wrap: (fake) => ({
      ...fake,
      forTeam(token) {
        const client = fake.forTeam(token);
        return {
          ...client,
          async status() {
            const status = await client.status();
            if (down && status.some((agent) => agent.name === "web-lead")) throw new Error("status is down");
            return status;
          },
        };
      },
    }),
  });
  sleepAll(s);
  t.mock.method(console, "error", () => {});
  down = true;
  ownerThread(s.app.repo.forTeam("notes"), { body: "Is there room?" });
  await s.app.dispatcher.run();
  assert.equal(phase(s, "notes-lead"), "Asleep", "the other team's awake agents are unknown");

  down = false;
  await s.app.dispatcher.run();
  assert.equal(phase(s, "notes-lead"), "Ready");
});

test("an agent paused back to sleep before a run saw it awake is woken again", async (t) => {
  const s = await setup(t);
  sleepAll(s);
  const start = Date.now();
  t.mock.timers.enable({ apis: ["Date"], now: start });
  ownerThread(s.app.repo.forTeam("web"), { body: "For the lead." });
  await s.app.dispatcher.run();
  assert.equal(phase(s, "web-lead"), "Ready");

  await s.app.teams.pause(null);
  assert.equal(phase(s, "web-lead"), "Asleep");
  await s.app.teams.resume(null);
  assert.equal(phase(s, "web-lead"), "Asleep", "a wake a12s may not have reported yet is not repeated");

  t.mock.timers.setTime(start + 30_000);
  await s.app.dispatcher.run();
  assert.equal(phase(s, "web-lead"), "Ready", "its pending work wakes it");
});

test("under the cap the owner's ask wakes its agent first, then the oldest waits its turn", async (t) => {
  const s = await setup(t, { live: true });
  await patch(s, "/settings", { awakeCap: 1 });
  await s.app.teams.pause(null);
  await s.tool("web-lead", "post", { kind: "ask", to: "dev", title: "Oldest", body: "From the lead." });
  await later();
  await s.tool("notes-lead", "post", { kind: "ask", to: "researcher", title: "Older", body: "From a lead." });
  await later();
  ownerThread(s.app.repo.forTeam("notes"), { body: "From the owner." });
  await s.app.teams.resume(null);

  assert.deepEqual(
    AGENTS.filter((a) => phase(s, a) !== "Asleep"),
    ["notes-lead"],
  );
  await until(() => agentView(s, "web-dev")?.waitingFor === "cap");
  assert.equal(agentView(s, "web-dev")?.presence, "waiting");

  s.a12s.setPhase("notes-lead", "Asleep");
  await s.app.dispatcher.run();
  assert.deepEqual(
    AGENTS.filter((a) => phase(s, a) !== "Asleep"),
    ["web-dev"],
  );
  assert.deepEqual(bodies(s, "web-dev"), ["From the lead."]);
});

test("lowering the cap puts nobody to sleep; it only stops new wakes", async (t) => {
  const s = await setup(t, { live: true });
  s.a12s.setPhase("notes-researcher", "Asleep");
  await patch(s, "/settings", { awakeCap: 1 });
  assert.deepEqual(
    AGENTS.filter((a) => phase(s, a) !== "Asleep"),
    ["web-lead", "web-dev", "notes-lead"],
  );

  const web = s.app.repo.forTeam("web");
  ownerThread(web, { body: "Still for you." });
  ownerThread(s.app.repo.forTeam("notes"), { body: "Wait for room.", to: "researcher" });
  await s.app.dispatcher.run();
  assert.deepEqual(bodies(s, "web-lead"), ["Still for you."], "an awake agent still gets its messages");
  assert.equal(phase(s, "notes-researcher"), "Asleep");
  await until(() => agentView(s, "notes-researcher")?.waitingFor === "cap");

  await patch(s, "/settings", { awakeCap: 4 });
  assert.equal(phase(s, "notes-researcher"), "Ready", "raising the cap applies at once");
  assert.deepEqual(bodies(s, "notes-researcher"), ["Wait for room."]);
});

test("a free-disk floor holds wakes only, and lowering it releases them", async (t) => {
  const s = await setup(t, { live: true });
  s.a12s.setPhase("web-dev", "Asleep");
  await patch(s, "/settings", { minFreeDiskGb: 1e9 });
  const web = s.app.repo.forTeam("web");
  ownerThread(web, { body: "Needs a wake.", to: "dev" });
  ownerThread(web, { body: "Already awake." });
  await s.app.dispatcher.run();

  assert.equal(phase(s, "web-dev"), "Asleep");
  assert.equal(pending(s.a12s, "web-dev").length, 0);
  await until(() => agentView(s, "web-dev")?.waitingFor === "disk");
  assert.deepEqual(bodies(s, "web-lead"), ["Already awake."]);

  await patch(s, "/settings", { minFreeDiskGb: 0 });
  assert.equal(phase(s, "web-dev"), "Ready");
  assert.deepEqual(bodies(s, "web-dev"), ["Needs a wake."]);
});

test("a team at its budget: sends stop, running Turns finish, the card shows, raising it delivers in order", async (t) => {
  const s = await setup(t, { live: true });
  await until(() => s.app.live.up());
  await patch(s, "/teams/web", { dailyBudgetUsd: 1 });
  const web = s.app.repo.forTeam("web");
  const spent = () => web.spentToday(Date.now());
  const thread = ownerThread(web, { body: "First." }).thread;
  ownerThread(web, { body: "Side task.", to: "dev" });
  await s.app.dispatcher.run();

  s.a12s.startTurn("web-dev");
  s.a12s.startTurn("web-lead");
  s.a12s.finishTurn("web-lead", { modelCostsUsd: { sonnet: 0.6 } });
  await until(() => spent() > 0.59);
  ownerPost(web, thread, { body: "Second." });
  await s.app.dispatcher.run();
  assert.deepEqual(bodies(s, "web-lead"), ["Second."], "under the budget, asks go out");

  s.a12s.startTurn("web-lead");
  s.a12s.finishTurn("web-lead", { modelCostsUsd: { sonnet: 1.2 } });
  await until(() => spent() > 1.19);
  for (const body of ["Third.", "Fourth."]) {
    ownerPost(web, thread, { body });
    await later();
  }
  ownerThread(s.app.repo.forTeam("notes"), { body: "Another team." });
  await s.app.dispatcher.run();

  assert.equal(pending(s.a12s, "web-lead").length, 0, "nothing more is sent to a team at its budget");
  assert.deepEqual(bodies(s, "notes-lead"), ["Another team."], "another team is not held");
  assert.equal(phase(s, "web-dev"), "Busy", "a Turn running when the hold began is not stopped");
  const state = deriveState(s.app, null);
  assert.deepEqual(
    state.needsYou.filter((c) => c.kind === "budget"),
    [{ kind: "budget", teamId: "web", dailyUsd: 1, spentTodayUsd: spent() }],
  );
  assert.deepEqual(state.teams.find((team) => team.id === "web")?.budget, {
    dailyUsd: 1,
    spentTodayUsd: spent(),
    held: true,
  });
  assert.equal(agentView(s, "web-lead")?.presence, "waiting");
  assert.equal(agentView(s, "web-lead")?.waitingFor, "budget");

  s.a12s.finishTurn("web-dev", { modelCostsUsd: { sonnet: 0.3 } });
  await until(() => spent() > 1.49);

  await patch(s, "/teams/web", { dailyBudgetUsd: 5 });
  assert.deepEqual(bodies(s, "web-lead"), ["Third.", "Fourth."]);
  assert.equal(
    deriveState(s.app, null).needsYou.some((c) => c.kind === "budget"),
    false,
  );
});

test("a budget hold ends at local midnight", async (t) => {
  const s = await setup(t);
  const web = s.app.repo.forTeam("web");
  const now = Date.now();
  web.insertTurn({
    id: "t_spent",
    agentId: "web-lead",
    threadId: null,
    session: "s1",
    status: "completed",
    error: null,
    startedAt: now,
    finishedAt: now,
    tokens: undefined,
    modelCostsUsd: { sonnet: 30 },
    costUsd: 30,
  });
  ownerThread(web, { body: "Tomorrow." });
  await s.app.dispatcher.run();
  assert.equal(pending(s.a12s, "web-lead").length, 0, "held at the default budget");

  const midnight = new Date(now);
  midnight.setHours(24, 0, 0, 0);
  t.mock.timers.enable({ apis: ["Date"], now: midnight.getTime() - 1 });
  await s.app.dispatcher.run();
  assert.equal(pending(s.a12s, "web-lead").length, 0, "still held a moment before midnight");

  t.mock.timers.setTime(midnight.getTime());
  await s.app.dispatcher.run();
  assert.deepEqual(bodies(s, "web-lead"), ["Tomorrow."]);
});
