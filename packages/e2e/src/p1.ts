// The Phase 1 exit (build-spec section 12): two teams answer the owner, a lead hands work to a second agent and
// ends its Turn after its message, and a restart of the app mid-conversation loses nothing.
import assert from "node:assert/strict";
import type { StudioState } from "@a12s-studio/contract/state";
import { ANSWER_MS, answerFrom, createTeam, messages, ownerMessage, type Studio, step } from "./studio.ts";

const presence = (state: StudioState, agent: string) =>
  state.teams.flatMap((t) => t.agents).find((a) => a.id === agent)?.presence;

// What a restart must keep: every team with its agents, every thread, and each message of the open thread.
function snapshot(state: StudioState) {
  return {
    teams: state.teams.map((t) => ({ id: t.id, name: t.name, agents: t.agents.map((a) => a.id) })),
    threads: state.teams.flatMap((t) => t.threads.map((th) => `${th.id} ${th.title}`)),
    messages: messages(state).map(({ id, from, to, body }) => ({ id, from, to, body })),
  };
}

export async function p1(studio: Studio): Promise<void> {
  const [web, notes] = await step("Two teams are created", () =>
    Promise.all([
      createTeam(studio, "Website", "website", "Build and look after a small example website."),
      createTeam(studio, "Notes", "blank", "Keep short notes for the owner."),
    ]),
  );

  await step("Both leads answer the owner", async () => {
    const asked = await Promise.all(
      [web, notes].map(async (team) => ({
        team,
        ...(await ownerMessage(studio, team, "Say hello", "Answer me with the single word: hello")),
      })),
    );
    for (const { team, thread, message } of asked) {
      await studio.open(thread);
      const lead = `${team}-lead`;
      await studio.until(`an answer from ${lead}`, (s) => answerFrom(s, lead, message) !== undefined, ANSWER_MS);
    }
  });

  const lead = `${web}-lead`;
  const dev = `${web}-dev`;
  const { work, devAsk } = await step("The lead asks dev in the thread", async () => {
    const work = await ownerMessage(
      studio,
      web,
      "Heading element",
      "Ask dev, with a message in this thread, which HTML element marks the main heading of a page. " +
        "Do not answer it yourself. When dev has answered, send me dev's answer.",
    );
    await studio.open(work.thread);
    const fromLead = (s: StudioState) => answerFrom(s, lead, work.message, dev);
    const state = await studio.until(`a message from ${lead} to ${dev}`, (s) => fromLead(s) !== undefined, ANSWER_MS);
    return { work, devAsk: fromLead(state)?.id ?? "" };
  });

  await step("The lead ends its Turn before dev's answer exists", () =>
    studio.until(
      `${lead} no longer working`,
      (s) => {
        if (answerFrom(s, dev, devAsk, lead)) throw new Error(`${lead} was still working when dev's answer arrived`);
        return presence(s, lead) !== "working";
      },
      ANSWER_MS,
    ),
  );

  await step("The app is stopped and started mid-conversation; the state is the same", async () => {
    const before = snapshot(studio.state());
    await studio.restartApp();
    const after = snapshot(await studio.open(work.thread));
    assert.deepEqual(after.teams, before.teams, "the teams and agents changed");
    assert.deepEqual(
      before.threads.filter((t) => !after.threads.includes(t)),
      [],
      "threads were lost",
    );
    assert.deepEqual(after.messages.slice(0, before.messages.length), before.messages, "messages changed");
  });

  await step("Still live: dev's answer comes back and the lead answers the owner", async () => {
    await studio.until(`an answer from ${dev}`, (s) => answerFrom(s, dev, devAsk, lead) !== undefined, ANSWER_MS);
    await studio.until(`an answer from ${lead}`, (s) => answerFrom(s, lead, devAsk) !== undefined, ANSWER_MS);
  });
}
