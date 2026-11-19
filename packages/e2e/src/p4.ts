// The Phase 4 exit (build-spec section 11): an add-on turned on for one team gives that team's agent a tool whose
// work calls GitHub through the broker under the team's credential; its container holds no secret; another team's
// agent cannot reach it; its reported cost counts in the team's spend and holds the team at its budget; turned off,
// its tools, its container and its grants are gone.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { TurnsResponse } from "@a12s-studio/contract/api";
import type { AccessView, AuditPage } from "@a12s-studio/contract/broker-admin";
import { addonName } from "@a12s-studio/contract/names";
import type { AddonManifest, StudioState } from "@a12s-studio/contract/state";
import {
  ANSWER_MS,
  agentOf,
  answerFrom,
  createTeam,
  FLEET,
  messages,
  ownerMessage,
  type Studio,
  step,
  toolCalls,
} from "./studio.ts";

const EXAMPLE = fileURLToPath(new URL("../../../addons/example", import.meta.url));
const manifest = JSON.parse(readFileSync(`${EXAMPLE}/addon.json`, "utf8")) as AddonManifest;

// A command on the host; answers its output, and fails with it.
function run(command: string, args: string[], input?: string): Promise<string> {
  const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (d) => (output += d));
  child.stderr.on("data", (d) => (output += d));
  child.stdin.end(input);
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve(output) : reject(new Error(`${command} ${args.join(" ")}: ${output.slice(-600)}`)),
    );
  });
}

const teamOf = (state: StudioState, team: string) => {
  const found = state.teams.find((t) => t.id === team);
  if (!found) throw new Error(`team ${team} is gone`);
  return found;
};

// What a call from `agent`'s container to the instance's MCP port answers: the status, through the a12s proxy.
const reach = (studio: Studio, agent: string, instance: string) =>
  studio.shell(
    agent,
    `curl -s -o /dev/null -w '%{http_code}' -x "$A12S_PROXY" -X POST -H 'content-type: application/json' ` +
      `-d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' http://${instance}.a12s:8080/mcp`,
  );

export async function p4(studio: Studio): Promise<void> {
  const { E2E_GITHUB_REPO: repo = "", E2E_GITHUB_TOKEN: token = "" } = process.env;

  await step(`The example add-on's image ${manifest.image} is built; the library holds it`, async () => {
    await run("docker", ["build", "-q", "-t", manifest.image, EXAMPLE]);
    studio.atEnd(`Image ${manifest.image} is removed`, async () => {
      await run("docker", ["image", "rm", manifest.image]);
    });
    await studio.api("PUT", `/addons/${manifest.id}`, manifest);
    assert.deepEqual(
      studio.state().addons.map((a) => a.id),
      [manifest.id],
    );
  });

  const [web, notes] = await step("Teams Web and Notes; only Web holds a GitHub API credential", async () => {
    const teams = await Promise.all([
      createTeam(studio, "Web", "blank", "Look things up for the owner."),
      createTeam(studio, "Notes", "blank", "Keep short notes for the owner."),
    ]);
    await studio.api("PUT", `/teams/${teams[0]}/credentials/api.github.com`, { scheme: "bearer", secret: token });
    return teams;
  });
  const instance = addonName(web, manifest.id);
  const container = `a12s-${FLEET}-${instance}`;
  const lead = `${web}-lead`;

  await step(`Notes cannot turn it on without the credential; Web turns it on and ${instance} runs`, async () => {
    await assert.rejects(studio.api("PUT", `/teams/${notes}/addons/${manifest.id}`, {}), /no_credential/);
    await studio.api("PUT", `/teams/${web}/addons/${manifest.id}`, {});
    await studio.until(
      `${instance} ready`,
      (s) => teamOf(s, web).addons.some((a) => a.id === manifest.id && a.status === "ready"),
      ANSWER_MS,
    );
    const { grants } = await studio.api<AccessView>("GET", `/teams/${web}/access`);
    assert.equal(grants.filter((g) => g.revokedAt === null).length, manifest.access.length);
  });

  const started = Date.now();
  const asked = await step(
    `${lead} uses the add-on's tool; the broker served the add-on with Web's credential`,
    async () => {
      const asked = await ownerMessage(
        studio,
        web,
        "Repository facts",
        `Use your repo_facts tool on ${repo} and answer me with the repository's default branch, one word.`,
      );
      await studio.open(asked.thread);
      await studio.until(`an answer from ${lead}`, (s) => answerFrom(s, lead, asked.message) !== undefined, ANSWER_MS);
      const { turns } = await studio.api<TurnsResponse>("GET", `/agents/${lead}/turns`);
      const first = turns.filter((t) => t.finishedAt >= started).at(-1)?.id ?? null;
      const calls = await toolCalls(studio, lead, first, started, Date.now());
      assert.ok(
        calls.some((c) => c.name === `mcp__a12s-${instance}__repo_facts` && !c.isError),
        `${lead} made no good call of the add-on's tool: ${calls.map((c) => c.name).join(", ")}`,
      );
      const audit = await studio.api<AuditPage>("GET", `/teams/${web}/audit`);
      assert.ok(
        audit.entries.some(
          (e) => e.agentId === instance && e.action === "call" && e.path === `/repos/${repo}` && e.status === 200,
        ),
        `the audit of ${web} has no call by ${instance}`,
      );
      return asked;
    },
  );

  await step(`${instance}'s container holds no secret, in its environment or its files`, async () => {
    // docker exec, not a12s shell: the CLI finds a Service only in the Fleet file, and the app writes add-ons through
    // the API.
    const env = await run("docker", ["exec", container, "env"]);
    assert.ok(env.includes("A12S_SERVICE="), "the container's environment was not read");
    assert.ok(!env.includes(token), "the token is in the add-on's environment");
    // The files that hold the token, which reaches the container on grep's stdin, never in its arguments.
    const search = (text: string) =>
      run(
        "docker",
        ["exec", "-i", container, "sh", "-c", "grep -rlF -f - /srv /tmp /run /proc/[0-9]*/environ 2>/dev/null; true"],
        `${text}\n`,
      );
    assert.match(await search("A12S_SERVICE="), /\/proc\/\d+\/environ/, "the search finds no known variable");
    assert.equal((await search(token)).trim(), "", "the token is in the add-on's files");
  });

  await step(`${notes}-lead cannot reach ${instance}; ${lead} can`, async () => {
    assert.equal(await reach(studio, `${notes}-lead`, instance), "403");
    assert.equal(await reach(studio, lead, instance), "200");
  });

  await step("The add-on's reported cost is in Web's spend, and holds Web at its budget", async () => {
    const team = teamOf(studio.state(), web);
    const addon = team.addons.find((a) => a.id === manifest.id);
    assert.ok(addon && addon.spentTodayUsd > 0, "the add-on reported no cost");
    assert.ok(team.budget.spentTodayUsd >= addon.spentTodayUsd, "the team's spend leaves out the add-on's");
    // Only the add-on's own report is under the budget now: a budget between Turns' spend and the whole would not
    // be held by Turns alone.
    await studio.api("PATCH", `/teams/${web}`, { dailyBudgetUsd: team.budget.spentTodayUsd - addon.spentTodayUsd / 2 });
    await studio.until(
      "Web held at its budget",
      (s) => teamOf(s, web).budget.held && s.needsYou.some((c) => c.kind === "budget" && c.teamId === web),
      60_000,
    );
    const { id } = await studio.api<{ id?: string }>("POST", `/threads/${asked.thread}/messages`, {
      body: "Still there?",
    });
    await new Promise((resolve) => setTimeout(resolve, 15_000));
    const held = messages(studio.state()).find((m) => m.id === id);
    assert.equal(held?.delivered, null, "a message to a team at its budget was delivered");
    await studio.api("PATCH", `/teams/${web}`, { dailyBudgetUsd: 25 });
  });

  await step(`Turned off: ${instance}'s container and grants are gone, and ${lead} no longer reaches it`, async () => {
    await studio.api("DELETE", `/teams/${web}/addons/${manifest.id}`);
    assert.deepEqual(teamOf(studio.state(), web).addons, []);
    const listed = await run("docker", ["ps", "-a", "--filter", `name=^${container}$`, "--format", "{{.Names}}"]);
    assert.equal(listed.trim(), "", `${container} still exists`);
    const { grants } = await studio.api<AccessView>("GET", `/teams/${web}/access`);
    assert.deepEqual(
      grants.filter((g) => g.revokedAt === null),
      [],
    );
    // The new spec, without the instance, reaches the agent at its next idle moment.
    await studio.until(`${lead} idle`, (s) => agentOf(s, lead)?.presence !== "working", ANSWER_MS);
    assert.notEqual(await reach(studio, lead, instance), "200");
  });
}
