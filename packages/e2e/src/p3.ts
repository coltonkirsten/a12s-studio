// The Phase 3 exit (build-spec section 12): the awake cap, a budget hold, an agent error, background work, a team
// that works unattended inside its budget, and a backup restored onto an emptied data folder.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { MessagesPage, WriteResult } from "@a12s-studio/contract/api";
import type { AccessView } from "@a12s-studio/contract/broker-admin";
import type { AgentView, NeedsYouItem, StudioState } from "@a12s-studio/contract/state";
import { ANSWER_MS, answerFrom, createTeam, messages, ownerMessage, type Studio, step } from "./studio.ts";

const repo = fileURLToPath(new URL("../../..", import.meta.url));
// What the data folder holds of Studio's own; the Fleet file and the run's logs stay.
const STUDIO_DATA = ["config.json", "app", "broker"];
const BACKGROUND_RUNS = 3;

const agents = (state: StudioState): AgentView[] => state.teams.flatMap((t) => t.agents);
const agent = (state: StudioState, id: string): AgentView | undefined => agents(state).find((a) => a.id === id);
const awake = (state: StudioState) =>
  agents(state)
    .filter((a) => a.presence === "awake" || a.presence === "working")
    .map((a) => a.id);
const budget = (state: StudioState, team: string) => {
  const found = state.teams.find((t) => t.id === team);
  if (!found) throw new Error(`team ${team} is gone`);
  return found.budget;
};
const hasCard = <K extends NeedsYouItem["kind"]>(
  state: StudioState,
  kind: K,
  match: (card: Extract<NeedsYouItem, { kind: K }>) => boolean,
) => state.needsYou.some((card) => card.kind === kind && match(card as Extract<NeedsYouItem, { kind: K }>));

// Pauses everything and waits until no agent is awake, so what follows starts from a known state.
async function pauseAll(studio: Studio): Promise<void> {
  await studio.api("PATCH", "/settings", { paused: true });
  await studio.until("every agent asleep", (s) => awake(s).length === 0, ANSWER_MS);
}

// Runs one of the repo's scripts on the run's data folder; its output is shown only when it fails.
function script(file: string, args: string[], home: string): Promise<void> {
  const child = spawn(process.execPath, [join(repo, "scripts", file), ...args], {
    env: { ...process.env, STUDIO_HOME: home },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (d) => (output += d));
  child.stderr.on("data", (d) => (output += d));
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${file} exited ${code}: ${output.trim().slice(-600)}`)),
    );
  });
}

// What a restore must give back: teams with their agents, threads with their message counts, and grants.
async function snapshot(studio: Studio) {
  const state = studio.state();
  const teams = [];
  for (const team of state.teams) {
    const threads = [];
    for (const thread of team.threads) {
      const page = await studio.api<MessagesPage>("GET", `/threads/${thread.id}/messages`);
      threads.push({ id: thread.id, title: thread.title, status: thread.status, messages: page.messages.length });
    }
    const { grants } = await studio.api<AccessView>("GET", `/teams/${team.id}/access`);
    teams.push({
      id: team.id,
      name: team.name,
      agents: team.agents.map((a) => a.id),
      threads,
      grants: grants.map(({ id, host, methods, paths, expiresAt }) => ({ id, host, methods, paths, expiresAt })),
    });
  }
  return teams;
}

export async function p3(studio: Studio): Promise<void> {
  const team = await step("A team is made whose agents sleep after a minute idle; no agent is awake", async () => {
    // A minute, so that with a cap of one the second agent does not wait a quarter of an hour.
    await studio.api("PATCH", "/settings", { defaultSleepAfterIdle: "1m" });
    const team = await createTeam(studio, "Ops", "website", "Look after a small example website.");
    await studio.until("no agent working", (s) => agents(s).every((a) => a.presence !== "working"), ANSWER_MS);
    await pauseAll(studio);
    return team;
  });
  const lead = `${team}-lead`;
  const dev = `${team}-dev`;

  await step("With the awake cap at 1 and messages for two agents, two are never awake together", async () => {
    const { awakeCap } = studio.state().settings;
    await studio.api("PATCH", "/settings", { awakeCap: 1, paused: false });
    const first = await ownerMessage(
      studio,
      team,
      "Two answers",
      "Answer me with a post to owner holding the single word: one",
    );
    const second = await studio.api<WriteResult>("POST", `/threads/${first.thread}/messages`, {
      body: "Answer me with a post to owner holding the single word: two",
      to: "dev",
    });
    await studio.open(first.thread);
    let held = false;
    await studio.until(
      "both answers",
      (s) => {
        const up = awake(s);
        if (up.length > 1) throw new Error(`${up.join(" and ")} were awake together`);
        held ||= agents(s).some((a) => a.waitingFor === "cap");
        return answerFrom(s, lead, first.message) !== undefined && answerFrom(s, dev, second.id ?? "") !== undefined;
      },
      2 * ANSWER_MS,
    );
    assert.ok(held, "no agent was ever shown waiting for the cap");
    await studio.api("PATCH", "/settings", { awakeCap });
  });

  await step("A budget below today's spend holds the team and shows its card; raising it delivers", async () => {
    const { spentTodayUsd, dailyUsd } = budget(studio.state(), team);
    assert.ok(spentTodayUsd > 0, "the team has spent nothing today");
    await studio.api("PATCH", `/teams/${team}`, { dailyBudgetUsd: spentTodayUsd / 2 });
    const held = await ownerMessage(
      studio,
      team,
      "Held",
      "Answer me with a post to owner holding the single word: three",
    );
    await studio.until(
      `${lead} waiting for the budget, and the budget card`,
      (s) => agent(s, lead)?.waitingFor === "budget" && hasCard(s, "budget", (card) => card.teamId === team),
      60_000,
    );
    await studio.api("PATCH", `/teams/${team}`, { dailyBudgetUsd: dailyUsd });
    await studio.open(held.thread);
    await studio.until(`an answer from ${lead}`, (s) => answerFrom(s, lead, held.message) !== undefined, ANSWER_MS);
  });

  await step("A forced agent error shows its card; set back and woken, the card is gone", async () => {
    const errorCard = (s: StudioState) => hasCard(s, "agent_error", (card) => card.agentId === dev);
    await studio.api("POST", `/agents/${dev}/power`, { state: "asleep" });
    await studio.until(`${dev} asleep`, (s) => agent(s, dev)?.presence === "asleep", ANSWER_MS);
    // Too little memory for the agent computer to start.
    await studio.api("PATCH", `/agents/${dev}`, { memory: "8Mi" });
    // a12s answers the wake with the failure (the computer is killed while a12s sets it up); the phase it then
    // reports is what Studio shows.
    const refused = await studio.api("POST", `/agents/${dev}/power`, { state: "awake" }).then(
      () => "",
      (error: unknown) => ` (the wake answered: ${error instanceof Error ? error.message : String(error)})`,
    );
    await studio.until(`the agent error card${refused}`, errorCard, ANSWER_MS);
    await studio.api("PATCH", `/agents/${dev}`, { memory: null });
    await studio.api("POST", `/agents/${dev}/power`, { state: "awake" });
    await studio.until(
      `${dev} awake and no error card`,
      (s) => !errorCard(s) && agent(s, dev)?.presence !== "error",
      ANSWER_MS,
    );
  });

  for (let run = 1; run <= BACKGROUND_RUNS; run++) {
    await step(`A command in the background keeps the agent working until it reports (${run} of 3)`, async () => {
      const notBackground = `${lead} did not run the command in the background`;
      const asked = await ownerMessage(
        studio,
        team,
        `Background ${run}`,
        "Run `sleep 45` as a background command, end your turn, and when it finishes post the word done.",
      );
      await studio.open(asked.thread);
      // The report itself, not a message that mentions it ("I will post done when it finishes").
      const report = (s: StudioState) => messages(s).find((m) => m.from === lead && /^\W*done\W*$/i.test(m.body));
      const done = (s: StudioState) => report(s) !== undefined;
      await studio
        .until(
          `${lead} working in the background with one work item and no Turn`,
          (s) => {
            if (done(s)) throw new Error(`${notBackground}: it reported before any background work showed`);
            const a = agent(s, lead);
            return a?.presence === "working" && a.turn === null && a.work.length === 1;
          },
          ANSWER_MS,
        )
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(message.startsWith(notBackground) ? message : `${notBackground} (${message})`);
        });
      await studio.until(`the word done from ${lead}`, done, ANSWER_MS);
      await studio.until(
        `${lead} with no work and not working`,
        (s) => agent(s, lead)?.work.length === 0 && agent(s, lead)?.presence !== "working",
        ANSWER_MS,
      );
    });
  }

  await step("Unattended: a wake the lead set fires and the team finishes a task inside its budget", async () => {
    const asked = await ownerMessage(
      studio,
      team,
      "Later",
      "Use schedule to wake yourself in this thread one minute from now, then end your turn. " +
        "When that wake arrives, ask dev, with a post to dev, to write the word hello into ~/hello.txt and to " +
        "answer you with a post to you. When dev has answered, send me a post to owner holding the single word: " +
        "finished",
    );
    await studio.open(asked.thread);
    // The word itself: the lead's first Turn may also leave a message for the owner (build-spec 5.5).
    const finished = (s: StudioState) =>
      messages(s).find((m) => m.from === lead && m.to === "owner" && /^\W*finished\W*$/i.test(m.body));
    const state = await studio.until(`the word finished from ${lead}`, (s) => finished(s) !== undefined, 3 * ANSWER_MS);
    const thread = messages(state);
    const wake = thread.find((m) => m.from === "system" && m.body.startsWith("scheduled wake"));
    const answer = finished(state);
    assert.ok(wake, "the thread has no scheduled wake");
    assert.ok(answer && answer.at > wake.at, "the lead answered before its wake");
    assert.ok(
      thread.some((m) => m.from === lead && m.to === dev && m.at > wake.at),
      `${lead} did not write to ${dev} after the wake`,
    );
    assert.match(await studio.shell(dev, "cat ~/hello.txt"), /hello/i);
    const { spentTodayUsd, dailyUsd } = budget(studio.state(), team);
    assert.ok(spentTodayUsd < dailyUsd, `spent ${spentTodayUsd} of a ${dailyUsd} budget`);
  });

  await step(
    "After a backup the data folder is emptied and restored; teams, threads, grants and notes are kept",
    async () => {
      await studio.api("POST", `/teams/${team}/grants`, {
        host: "api.example.com",
        methods: ["GET"],
        paths: ["/e2e/**"],
      });
      await studio.shell(lead, `mkdir -p ~/memory && echo 'restore check ${Date.now()}' >> ~/memory/notes.md`);
      const notes = await studio.shell(lead, "cat ~/memory/notes.md");
      await pauseAll(studio);
      const before = await snapshot(studio);
      const backups = mkdtempSync(join(tmpdir(), "a12s-studio-e2e-backups-"));
      studio.atEnd("The backups folder is removed", async () => rmSync(backups, { recursive: true, force: true }));
      await script("backup.ts", [backups], studio.home);
      const [dated] = readdirSync(backups);
      if (!dated) throw new Error("the backup made no folder");
      await studio.offline(async () => {
        for (const entry of STUDIO_DATA) rmSync(join(studio.home, entry), { recursive: true });
        // Forced, because the Fleet still has the agents' home drives, which the restore loads again.
        await script("restore.ts", [join(backups, dated), "--force"], studio.home);
      });
      assert.deepEqual(await snapshot(studio), before);
      await studio.api("PATCH", "/settings", { paused: false });
      assert.equal(await studio.shell(lead, "cat ~/memory/notes.md"), notes);
    },
  );
}
