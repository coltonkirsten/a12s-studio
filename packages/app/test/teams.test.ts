import assert from "node:assert/strict";
import { test } from "node:test";
import type { FakeA12s } from "../src/a12s/fake.ts";
import { type A12s, A12sError } from "../src/a12s/port.ts";
import { pending, studio } from "./studio.ts";

type S = Awaited<ReturnType<typeof studio>>;

async function setup(t: { after(fn: () => unknown): void }, opts: Parameters<typeof studio>[0] = {}): Promise<S> {
  const s = await studio(opts);
  t.after(() => s.close());
  return s;
}

const body = { name: "Web", purpose: "The site.", accent: "#336699", template: "website" };

test("the templates list their brief and agents, blank first and lead first", async (t) => {
  const s = await setup(t);
  const templates = s.app.teams.templates();
  assert.deepEqual(
    templates.map(({ id, agents }) => ({ id, agents })),
    [
      { id: "blank", agents: ["lead"] },
      { id: "research-notes", agents: ["lead", "researcher"] },
      { id: "website", agents: ["lead", "dev"] },
    ],
  );
});

test("creating a team makes its token, its agents and its rows", async (t) => {
  const s = await setup(t);
  const team = await s.app.teams.createTeam(body);
  assert.equal(team.leadAgentId, "web-lead");
  assert.equal(team.dailyBudgetUsd, 25);
  const scoped = s.app.repo.forTeam("web");
  assert.deepEqual(
    scoped.agents().map((a) => [a.id, a.model, a.sleepAfterIdle, a.compactMinTokens]),
    [
      ["web-lead", "sonnet", "15m", 100000],
      ["web-dev", "sonnet", "15m", 100000],
    ],
  );
  assert.deepEqual([...s.a12s.agents.keys()], ["web-lead", "web-dev"]);
  assert.match(
    s.a12s.agents.get("web-dev")?.spec.instructions ?? "",
    /# Team: Web\nThe site\.\n\n# Your role\nWrites and tests/,
  );
  await assert.rejects(s.a12s.forTeam(team.a12sToken).wake("other-lead"), { code: "out_of_prefix" });
});

test("a team's slug comes from its name, is never reused, and a template must exist", async (t) => {
  const s = await setup(t);
  await assert.rejects(s.app.teams.createTeam({ ...body, template: "../teams" }), { code: "not_found" });
  assert.equal((await s.app.teams.createTeam(body)).id, "web");
  assert.equal((await s.app.teams.createTeam(body)).id, "web2");
  await s.app.teams.deleteTeam("web");
  assert.equal((await s.app.teams.createTeam(body)).id, "web3");
  assert.equal((await s.app.teams.createTeam({ ...body, name: "Owner" })).id, "owner2");
});

test("the blank template makes a team of one lead", async (t) => {
  const s = await setup(t);
  assert.equal(s.app.teams.templates()[0]?.purpose, "");
  const team = await s.app.teams.createTeam({ ...body, template: "blank" });
  assert.deepEqual(
    s.app.repo
      .forTeam(team.id)
      .agents()
      .map((a) => a.id),
    ["web-lead"],
  );
});

test("a team whose agents cannot all be created leaves nothing behind", async (t) => {
  let puts = 0;
  const wrap = (fake: FakeA12s): A12s => ({
    ...fake,
    async putAgent(name, spec, mode) {
      if (++puts === 2) throw new A12sError("unreachable", "a12s is down.");
      return fake.putAgent(name, spec, mode);
    },
  });
  const s = await setup(t, { wrap });
  await assert.rejects(s.app.teams.createTeam(body), { code: "unreachable" });
  assert.deepEqual(s.app.repo.teams(), []);
  assert.equal(s.app.repo.teamSlugUsed("web"), false);
  assert.equal(s.a12s.agents.size, 0);
  await s.app.teams.createTeam(body);
  assert.equal(s.app.repo.forTeam("web").agents().length, 2);
});

test("hiring checks the name and uses the hire defaults", async (t) => {
  const s = await setup(t);
  await s.app.teams.createTeam(body);
  const qa = await s.app.teams.hire("web", { slug: "qa", role: "Tests releases.", model: "haiku" });
  assert.deepEqual([qa.id, qa.model, qa.sleepAfterIdle], ["web-qa", "haiku", "15m"]);
  assert.equal(s.a12s.agents.get("web-qa")?.spec.harness.model, "haiku");
  for (const slug of ["owner", "system", "QA", "-qa"]) {
    await assert.rejects(s.app.teams.hire("web", { slug, role: "r", model: "haiku" }), { code: "bad_slug" }, slug);
  }
  await assert.rejects(s.app.teams.hire("web", { slug: "qa", role: "r", model: "haiku" }), { code: "slug_used" });
  await s.app.teams.fire("web", "web-qa");
  await assert.rejects(s.app.teams.hire("web", { slug: "qa", role: "r", model: "haiku" }), { code: "slug_used" });
  await assert.rejects(s.app.teams.hire("nope", { slug: "qa", role: "r", model: "haiku" }), { code: "not_found" });
});

test("firing removes the agent computer, its wakes and its undelivered messages; the lead stays", async (t) => {
  const s = await setup(t);
  await s.app.teams.createTeam(body);
  await s.app.teams.pause("web");
  const asked = await s.tool("web-lead", "post", { kind: "ask", to: "dev", title: "T", body: "b" });
  s.db
    .prepare(
      "INSERT INTO wakes (id, team_id, agent_id, note, due_at, created_at) VALUES ('w_1', 'web', 'web-dev', 'n', 0, 0)",
    )
    .run();

  await assert.rejects(s.app.teams.fire("web", "web-lead"), { code: "is_lead" });
  await assert.rejects(s.app.teams.fire("web", "other-dev"), { code: "not_found" });
  await s.app.teams.fire("web", "web-dev");
  assert.equal(s.a12s.agents.has("web-dev"), false);
  assert.equal(s.app.repo.forTeam("web").agent("web-dev"), undefined);
  assert.equal(s.app.repo.forTeam("web").message(String(asked.message))?.delivery, "none");
  assert.equal(s.db.prepare("SELECT count(*) AS n FROM wakes").get()?.n, 0);
  assert.equal((await s.raw(["web-dev"], "POST", "/mcp", {})).status, 403);
});

test("deleting a team removes its agents and token and can be run again after a failure", async (t) => {
  let failOnce = true;
  const wrap = (fake: FakeA12s): A12s => ({
    ...fake,
    async removeToken(team) {
      if (failOnce) {
        failOnce = false;
        throw new A12sError("unreachable", "a12s is down.");
      }
      return fake.removeToken(team);
    },
  });
  const s = await setup(t, { wrap });
  const team = await s.app.teams.createTeam(body);
  await assert.rejects(s.app.teams.deleteTeam("web"), { code: "unreachable" });
  assert.ok(s.app.repo.forTeam("web").team(), "the team stays when a step fails");
  await s.app.teams.deleteTeam("web");
  assert.equal(s.app.repo.forTeam("web").team(), undefined);
  assert.equal(s.a12s.agents.size, 0);
  await assert.rejects(s.a12s.forTeam(team.a12sToken).status(), { code: "forbidden" });
  assert.equal((await s.raw(["web-lead"], "POST", "/mcp", {})).status, 403);
});

test("a global pause holds every team until resumed", async (t) => {
  const s = await setup(t);
  await s.twoTeams();
  await s.app.teams.pause(null);
  assert.equal(s.app.repo.settings().paused, true);
  for (const agent of s.a12s.agents.values()) assert.equal(agent.phase, "Asleep");
  await s.tool("notes-lead", "post", { kind: "ask", to: "researcher", title: "T", body: "b" });
  await s.app.dispatcher.run();
  assert.equal(pending(s.a12s, "notes-researcher").length, 0);
  await s.app.teams.resume(null);
  assert.equal(pending(s.a12s, "notes-researcher").length, 1);
  assert.notEqual(s.a12s.agents.get("notes-researcher")?.phase, "Asleep");
});
