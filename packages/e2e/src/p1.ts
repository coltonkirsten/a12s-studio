// The Phase 1 exit (build-spec section 12): two teams answer the owner, a lead hands work to a second agent and
// ends its Turn after the ask, and a restart of the app mid-conversation loses nothing.
import assert from "node:assert/strict";
import type { StudioState } from "@a12s-studio/contract/state";
import { ANSWER_MS, createTeam, messages, ownerAsk, replyTo, type Studio, step } from "./studio.ts";

const presence = (state: StudioState, agent: string) =>
  state.teams.flatMap((t) => t.agents).find((a) => a.id === agent)?.presence;

// What a restart must keep: every team with its agents, every thread, and each message of the open thread.
function snapshot(state: StudioState) {
  return {
    teams: state.teams.map((t) => ({ id: t.id, name: t.name, agents: t.agents.map((a) => a.id) })),
    threads: state.teams.flatMap((t) => t.threads.map((th) => `${th.id} ${th.title}`)),
    messages: messages(state).map(({ id, kind, from, to, ask, body }) => ({ id, kind, from, to, ask, body })),
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
        ...(await ownerAsk(studio, team, "Say hello", "Reply to this ask with the single word: hello")),
      })),
    );
    for (const { team, thread, ask } of asked) {
      await studio.open(thread);
      await studio.until(`a reply from ${team}-lead`, (s) => replyTo(s, ask, `${team}-lead`) !== undefined, ANSWER_MS);
    }
  });

  const lead = `${web}-lead`;
  const dev = `${web}-dev`;
  const { work, devAsk } = await step("The lead asks dev in the thread", async () => {
    const work = await ownerAsk(
      studio,
      web,
      "Heading element",
      "Ask dev, with an ask in this thread, which HTML element marks the main heading of a page. " +
        "Do not answer it yourself. When dev has replied, reply to this ask with dev's answer.",
    );
    await studio.open(work.thread);
    const fromLead = (s: StudioState) => messages(s).find((m) => m.kind === "ask" && m.from === lead && m.to === dev);
    const state = await studio.until(`an ask from ${lead} to ${dev}`, (s) => fromLead(s) !== undefined, ANSWER_MS);
    return { work, devAsk: fromLead(state)?.id ?? "" };
  });

  await step("The lead ends its Turn before dev's answer exists", () =>
    studio.until(
      `${lead} no longer working`,
      (s) => {
        if (replyTo(s, devAsk, dev)) throw new Error(`${lead} was still working when dev's reply arrived`);
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

  await step("Still live: dev's answer comes back and the lead replies to the owner", async () => {
    await studio.until(`a reply from ${dev}`, (s) => replyTo(s, devAsk, dev) !== undefined, ANSWER_MS);
    await studio.until(`a reply from ${lead} to the owner`, (s) => replyTo(s, work.ask, lead) !== undefined, ANSWER_MS);
  });
}
