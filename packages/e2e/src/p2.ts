// The Phase 2 exit (build-spec section 12): an agent's outside calls are refused until the owner grants them, an
// approval or a grant opens its reach at once, a denial and an expiry keep or close it, another team's agent is
// refused, and an agent pushes to GitHub through the broker with no token in its container.
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import type { WriteResult } from "@a12s-studio/contract/api";
import type { AuditPage } from "@a12s-studio/contract/broker-admin";
import { BROKER_URL } from "@a12s-studio/contract/names";
import type { StudioState } from "@a12s-studio/contract/state";
import { ANSWER_MS, createTeam, ownerAsk, replyTo, type Studio, step } from "./studio.ts";

const EXPIRY_MS = 20_000;

// The broker's answer to a GET of api.github.com<path> from inside the agent's container: the status, and the
// refusal's code when the body has one ("403 no_access"). The harness reaches the broker through the a12s proxy,
// which it is given in HTTP_PROXY; a shell has only A12S_PROXY.
async function brokerGet(studio: Studio, agent: string, path: string): Promise<string> {
  const url = `${BROKER_URL}/api.github.com${path}`;
  const output = await studio.shell(agent, `curl -s -x "$A12S_PROXY" -w '\\n%{http_code}' ${url}`);
  const lines = output.trimEnd().split("\n");
  const status = lines.pop() ?? "";
  try {
    const { code } = JSON.parse(lines.join("\n")) as { code?: unknown };
    return typeof code === "string" ? `${status} ${code}` : status;
  } catch {
    return status;
  }
}

const accessCard = (state: StudioState, team: string, path: string) =>
  state.needsYou.find(
    (item) =>
      item.kind === "access_request" &&
      item.teamId === team &&
      item.request.host === "api.github.com" &&
      item.request.paths.includes(path),
  );

const accessAsk = (path: string) =>
  `Use the access tool to request GET on host api.github.com for exactly the path ${path}, with the reason ` +
  `"read the repository for the owner". Then reply to this ask with the word: requested`;

// A further ask from the owner to dev in an open thread; answers the ask's id.
async function askDev(studio: Studio, thread: string, body: string): Promise<string> {
  const { id } = await studio.api<WriteResult>("POST", `/threads/${thread}/messages`, { to: "dev", body });
  if (!id) throw new Error(`the ask in ${thread} answered no id`);
  return id;
}

// Waits for the access card of the agent's request for `path` and for its reply to the ask that asked for it;
// answers the request's id.
async function requested(studio: Studio, team: string, agent: string, ask: string, path: string) {
  const state = await studio.until(
    `an access card for ${path}`,
    (s) => accessCard(s, team, path) !== undefined,
    ANSWER_MS,
  );
  const card = accessCard(state, team, path);
  if (card?.kind !== "access_request") throw new Error(`no access card for ${path}`);
  await studio.until(`a reply from ${agent}`, (s) => replyTo(s, ask, agent) !== undefined, ANSWER_MS);
  return card.request.id;
}

export async function p2(studio: Studio): Promise<void> {
  const { E2E_GITHUB_REPO: repo = "", E2E_GITHUB_TOKEN: token = "" } = process.env;
  const github = (method: string, path: string) =>
    fetch(`https://api.github.com${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" },
    });
  const repoPath = `/repos/${repo}`;
  const branchesPath = `${repoPath}/branches`;

  const [web, notes] = await step("Teams web and notes; web holds a GitHub credential", async () => {
    const teams = await Promise.all([
      createTeam(studio, "Web", "website", "Build and look after a small example website."),
      createTeam(studio, "Notes", "blank", "Keep short notes for the owner."),
    ]);
    const [web] = teams;
    await studio.api("PUT", `/teams/${web}/credentials/github.com`, {
      scheme: "basic",
      username: "x-access-token",
      secret: token,
    });
    await studio.api("PUT", `/teams/${web}/credentials/api.github.com`, { scheme: "bearer", secret: token });
    return teams;
  });
  const dev = `${web}-dev`;
  const notesLead = `${notes}-lead`;

  await step(`From ${dev}'s container, a call with no grant is a 403`, async () => {
    assert.equal(await brokerGet(studio, dev, repoPath), "403 no_access");
  });

  const { thread } = await step(`${dev} requests access; approved, the same call is a 200 at once`, async () => {
    const asked = await ownerAsk(studio, web, "Repository access", accessAsk(repoPath), "dev");
    await studio.open(asked.thread);
    const request = await requested(studio, web, dev, asked.ask, repoPath);
    await studio.api("POST", `/teams/${web}/requests/${request}/approve`, {});
    assert.equal(await brokerGet(studio, dev, repoPath), "200");
    return asked;
  });

  await step("A second request, denied, stays a 403; the agent hears the denial", async () => {
    const request = await requested(
      studio,
      web,
      dev,
      await askDev(studio, thread, accessAsk(branchesPath)),
      branchesPath,
    );
    await studio.api("POST", `/teams/${web}/requests/${request}/deny`, {});
    assert.equal(await brokerGet(studio, dev, branchesPath), "403 no_access");
    const ask = await askDev(
      studio,
      thread,
      `Did the owner approve or deny your request for ${branchesPath}? Reply with the one word.`,
    );
    const state = await studio.until(`${dev}'s answer`, (s) => replyTo(s, ask, dev) !== undefined, ANSWER_MS);
    const answer = replyTo(state, ask, dev)?.body ?? "";
    assert.match(answer, /denied|deny/i, `${dev} answered "${answer}"`);
  });

  await step(`A grant that expires in ${EXPIRY_MS / 1000}s is a 200, then a 403`, async () => {
    const expiresAt = Date.now() + EXPIRY_MS;
    await studio.api("POST", `/teams/${web}/grants`, {
      host: "api.github.com",
      methods: ["GET"],
      paths: [branchesPath],
      expiresAt,
    });
    assert.equal(await brokerGet(studio, dev, branchesPath), "200");
    await sleep(expiresAt + 5_000 - Date.now());
    assert.equal(await brokerGet(studio, dev, branchesPath), "403 no_access");
  });

  await step(`${notesLead} is refused the call ${web} may make; only the audit of ${notes} shows it`, async () => {
    assert.equal(await brokerGet(studio, notesLead, repoPath), "403 no_access");
    const own = await studio.api<AuditPage>("GET", `/teams/${notes}/audit`);
    const other = await studio.api<AuditPage>("GET", `/teams/${web}/audit`);
    assert.ok(
      own.entries.some((e) => e.action === "deny" && e.agentId === notesLead && e.path === repoPath),
      `the audit of ${notes} has no deny row for ${notesLead}`,
    );
    assert.ok(!other.entries.some((e) => e.agentId === notesLead), `the audit of ${web} shows ${notesLead}`);
  });

  const branch = `e2e-${Date.now().toString(36)}`;
  await step(`${dev} clones, commits and pushes ${branch}; GitHub lists it`, async () => {
    await studio.api("POST", `/teams/${web}/grants`, {
      host: "github.com",
      methods: ["GET", "POST"],
      paths: [`/${repo}.git/**`, `/${repo}/**`],
    });
    const asked = await ownerAsk(
      studio,
      web,
      "Push a branch",
      `Clone https://github.com/${repo}.git, add a file named ${branch}.txt holding one line of text, commit it, ` +
        `and push the commit as a new branch named ${branch}. Then reply to this ask with the word: pushed`,
      "dev",
    );
    await studio.open(asked.thread);
    await studio.until(`a reply from ${dev}`, (s) => replyTo(s, asked.ask, dev) !== undefined, ANSWER_MS);
    const listed = await github("GET", `${repoPath}/branches/${branch}`);
    assert.equal(listed.status, 200, `GitHub does not list ${branch}`);
    const deleted = await github("DELETE", `${repoPath}/git/refs/heads/${branch}`);
    assert.equal(deleted.status, 204, `deleting ${branch} answered ${deleted.status}`);
  });

  await step(`The token is in neither ${dev}'s environment nor its files`, async () => {
    assert.ok(!(await studio.shell(dev, "env")).includes(token), `the token is in ${dev}'s environment`);
    // The token reaches the container on grep's stdin, never in a command a12s journals. The processes' environ
    // files include the harness's, which a shell's env does not show.
    const found = await studio.shell(
      dev,
      "grep -rlF -f - /home/agent /tmp /run /proc/[0-9]*/environ 2>/dev/null; true",
      `${token}\n`,
    );
    assert.equal(found.trim(), "", `the token is in ${found.trim()}`);
  });
}
