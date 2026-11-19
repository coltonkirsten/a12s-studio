import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import type { AccessView } from "@a12s-studio/contract/broker-admin";
import { addonName } from "@a12s-studio/contract/names";
import type { AddonManifest } from "@a12s-studio/contract/state";
import type { FakeA12s } from "../src/a12s/fake.ts";
import { type A12s, A12sError } from "../src/a12s/port.ts";
import { deriveState } from "../src/state.ts";
import { pending, studio, until } from "./studio.ts";

const SPEECH = "api.speech.example";
const narrate: AddonManifest = {
  id: "narrate",
  name: "Narrate",
  description: "Turns a script into an audio file.",
  image: "registry.example/narrate:1.2.0",
  access: [
    { host: SPEECH, methods: ["POST"], paths: ["/v1/speech"] },
    { host: SPEECH, methods: ["GET"], paths: ["/v1/voices"] },
  ],
};
const render: AddonManifest = {
  id: "render",
  name: "Render",
  description: "Renders slides into a video.",
  image: `registry.example/render@sha256:${"a".repeat(64)}`,
  access: [],
};

async function setup(t: TestContext, opts: { wrap?: (fake: FakeA12s) => A12s; live?: boolean } = {}) {
  const s = await studio(opts);
  t.after(() => s.close());
  await s.twoTeams();
  for (const manifest of [narrate, render]) {
    assert.equal((await s.owner("PUT", `/api/addons/${manifest.id}`, manifest)).status, 200);
  }
  return s;
}
type S = Awaited<ReturnType<typeof setup>>;

const credential = (s: S, team: string, host = SPEECH) =>
  s.owner("PUT", `/api/teams/${team}/credentials/${host}`, { scheme: "bearer", secret: "s3cret-value" });
const turnOn = (s: S, team: string, addon: string) => s.owner("PUT", `/api/teams/${team}/addons/${addon}`, {});
const turnOff = (s: S, team: string, addon: string) => s.owner("DELETE", `/api/teams/${team}/addons/${addon}`);
const access = async (s: S, team: string) => (await s.owner("GET", `/api/teams/${team}/access`)).body as AccessView;
const liveGrants = async (s: S, team: string) => (await access(s, team)).grants.filter((g) => g.revokedAt === null);
const usesOf = (s: S, agent: string) =>
  (s.a12s.agents.get(agent)?.spec.uses ?? []).map((u) => (typeof u === "string" ? u : u.name));

// A request to POST /usage the way the a12s proxy sends one from `callers`.
const report = (s: S, callers: string[], body: unknown, host?: string) => s.raw(callers, "POST", "/usage", body, host);

test("Reach: under random switches every agent uses only studio, broker and its own team's instances", async (t) => {
  const s = await setup(t);
  for (const team of ["web", "notes"]) assert.equal((await credential(s, team)).status, 200);
  let seed = 7;
  const random = (n: number) => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return seed % n;
  };
  const on = new Set<string>();
  for (let i = 0; i < 40; i++) {
    const team = ["web", "notes"][random(2)] ?? "web";
    const addon = [narrate.id, render.id][random(2)] ?? "narrate";
    const key = `${team}/${addon}`;
    const answer = await (on.has(key) ? turnOff(s, team, addon) : turnOn(s, team, addon));
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    if (on.has(key)) on.delete(key);
    else on.add(key);
    for (const [agent, { spec }] of s.a12s.agents) {
      const team = agent.slice(0, agent.indexOf("-"));
      const instances = [...on]
        .filter((k) => k.startsWith(`${team}/`))
        .map((k) => addonName(team, k.split("/")[1] ?? ""));
      assert.deepEqual(new Set(usesOf(s, agent)), new Set(["studio", "broker", ...instances]), agent);
      for (const name of spec.uses) {
        const used = typeof name === "string" ? name : name.name;
        assert.ok(["studio", "broker"].includes(used) || used.startsWith(`${team}-`), `${agent} uses ${used}`);
      }
    }
  }
  for (const key of on) {
    const [team = "", addon = ""] = key.split("/");
    await turnOff(s, team, addon);
  }

  assert.equal((await turnOn(s, "web", "render")).status, 200);
  assert.equal(
    (await s.owner("POST", "/api/teams/web/agents", { slug: "writer", role: "Writes.", model: "haiku" })).status,
    200,
  );
  assert.ok(usesOf(s, "web-writer").includes("web-addon-render"), "an agent hired after a turn-on gets the instance");
  assert.match(
    s.a12s.agents.get("web-writer")?.spec.instructions ?? "",
    /- Render: Renders slides into a video\. Its tools start with mcp__a12s-web-addon-render__\./,
  );
  assert.equal((await turnOff(s, "web", "render")).status, 200);
  for (const agent of s.a12s.agents.keys()) assert.ok(!usesOf(s, agent).includes("web-addon-render"));
  assert.equal(s.a12s.services.has("web-addon-render"), false, "the instance is removed");
  assert.doesNotMatch(s.a12s.agents.get("web-writer")?.spec.instructions ?? "", /Add-ons/);
});

test("Usage: only an instance that is on reports, for its own team, and its cost holds the team at its budget", async (t) => {
  const s = await setup(t);
  assert.equal((await turnOn(s, "web", "render")).status, 200);
  const web = s.app.repo.forTeam("web");
  const ok = { usd: 0.42, note: "a render, 30 seconds" };
  const refused: [string, string[], unknown, string?][] = [
    ["an agent", ["web-lead"], ok],
    ["an unknown name", ["web-addon-nothing"], ok],
    ["an instance that is off", ["web-addon-narrate"], ok],
    ["another team's name for it", ["notes-addon-render"], ok],
    ["two caller headers", ["web-addon-render", "web-addon-render"], ok],
    ["no caller header", [], ok],
    ["another Host", ["web-addon-render"], ok, "127.0.0.1:7410"],
  ];
  for (const [what, callers, body, host] of refused) {
    const answer = await report(s, callers, body, host);
    assert.equal(answer.status, 403, what);
  }
  for (const body of [
    { ...ok, team: "notes" },
    { usd: 0, note: "free" },
    { usd: 1001, note: "too much" },
    { usd: 1, note: "" },
    { usd: "1", note: "a string" },
    "not json",
  ]) {
    assert.equal((await report(s, ["web-addon-render"], body)).status, 400, JSON.stringify(body));
  }
  assert.equal(web.spentToday(Date.now()), 0, "a refused report writes nothing");

  assert.deepEqual((await report(s, ["web-addon-render"], ok)).body, { ok: true });
  assert.equal(web.spentToday(Date.now()), 0.42);
  assert.equal(s.app.repo.forTeam("notes").spentToday(Date.now()), 0);
  const team = deriveState(s.app, null).teams.find((x) => x.id === "web");
  // Without the event feed a12s has not reported the instance yet.
  assert.deepEqual(team?.addons, [{ id: "render", status: "starting", spentTodayUsd: 0.42 }]);

  // At the budget the team's next delivery is held, by what the add-on reported.
  await s.owner("PATCH", "/api/teams/web", { dailyBudgetUsd: 1 });
  assert.equal((await report(s, ["web-addon-render"], { usd: 0.6, note: "another render" })).status, 200);
  await s.owner("POST", "/api/teams/web/threads", { body: "Make the video." });
  await s.app.dispatcher.run();
  assert.equal(pending(s.a12s, "web-lead").length, 0, "a team at its budget gets no delivery");
  const cards = deriveState(s.app, null).needsYou.filter((c) => c.kind === "budget");
  assert.deepEqual(
    cards.map((c) => c.teamId),
    ["web"],
  );

  // An instance of a deleted team is no caller.
  assert.equal((await s.owner("DELETE", "/api/teams/web")).status, 200);
  assert.equal((await report(s, ["web-addon-render"], ok)).status, 403);
});

test("Turn-on: a missing credential refuses it and makes nothing", async (t) => {
  const s = await setup(t);
  const answer = await turnOn(s, "web", "narrate");
  assert.equal(answer.status, 409);
  assert.equal((answer.body as { code: string }).code, "no_credential");
  assert.match((answer.body as { fix: string }).fix, new RegExp(SPEECH.replaceAll(".", "\\.")));
  assert.deepEqual(await liveGrants(s, "web"), []);
  assert.equal(s.a12s.services.has("web-addon-narrate"), false);
  assert.ok(!usesOf(s, "web-lead").includes("web-addon-narrate"));
  assert.deepEqual(s.app.repo.forTeam("web").addons(), []);
});

test("Turn-on: a failed Service write revokes the grants it made and writes no row", async (t) => {
  let failService = true;
  const s = await setup(t, {
    wrap: (fake) => ({
      ...fake,
      async putService(name, spec) {
        if (failService) throw new A12sError("other", "image registry.example/narrate:1.2.0 cannot be pulled");
        return fake.putService(name, spec);
      },
    }),
  });
  await credential(s, "web");
  const answer = await turnOn(s, "web", "narrate");
  assert.equal(answer.status, 502, JSON.stringify(answer.body));
  assert.deepEqual(await liveGrants(s, "web"), []);
  assert.equal((await access(s, "web")).grants.length, 2, "both grants were made, then revoked");
  assert.deepEqual(s.app.repo.forTeam("web").addons(), []);
  failService = false;
  assert.equal((await turnOn(s, "web", "narrate")).status, 200);
  assert.equal((await liveGrants(s, "web")).length, 2);
});

test("Turn-on: a second PUT after a failed agent write completes it with no second set of grants", async (t) => {
  let failAgents = true;
  const s = await setup(t, {
    wrap: (fake) => ({
      ...fake,
      async putAgent(name, spec, mode) {
        if (failAgents && mode === "replace") throw new A12sError("unreachable", "a12s is down.");
        return fake.putAgent(name, spec, mode);
      },
    }),
  });
  await credential(s, "web");
  assert.equal((await turnOn(s, "web", "narrate")).status, 502);
  assert.equal(s.a12s.services.has("web-addon-narrate"), true);
  assert.equal(s.app.repo.forTeam("web").addons().length, 1, "the row says it is on once the instance exists");
  assert.ok(!usesOf(s, "web-lead").includes("web-addon-narrate"));
  failAgents = false;
  assert.equal((await turnOn(s, "web", "narrate")).status, 200);
  assert.ok(usesOf(s, "web-lead").includes("web-addon-narrate"));
  assert.equal((await liveGrants(s, "web")).length, 2, "no second set of grants");
  assert.equal((await access(s, "web")).grants.length, 2);
});

test("Turn-off: exactly the stored grants are revoked; deleting a team turns its add-ons off first", async (t) => {
  const s = await setup(t);
  await credential(s, "web");
  const own = await s.owner("POST", "/api/teams/web/grants", { host: SPEECH, methods: ["GET"], paths: ["/v1/**"] });
  assert.equal((await turnOn(s, "web", "narrate")).status, 200);
  assert.equal((await liveGrants(s, "web")).length, 3);
  assert.equal((await turnOff(s, "web", "narrate")).status, 200);
  assert.deepEqual(
    (await liveGrants(s, "web")).map((g) => g.id),
    [(own.body as { id: string }).id],
    "the owner's own grant for the same host is not touched",
  );
  assert.equal(s.a12s.services.has("web-addon-narrate"), false);
  assert.equal((await turnOff(s, "web", "narrate")).status, 200, "turning off what is off is a no-op");

  assert.equal((await turnOn(s, "web", "render")).status, 200);
  assert.ok(s.a12s.services.has("web-addon-render"));
  assert.equal((await s.owner("DELETE", "/api/teams/web")).status, 200);
  assert.equal(s.a12s.services.has("web-addon-render"), false, "no instance outlives its team");
  assert.equal((await s.owner("DELETE", "/api/addons/render")).status, 200, "no team has it on any more");
});

test("Names: an agent slug that starts with addon- is refused at hire", async (t) => {
  const s = await setup(t);
  const answer = await s.owner("POST", "/api/teams/web/agents", { slug: "addon-x", role: "Pretends.", model: "haiku" });
  assert.equal(answer.status, 400);
  assert.equal((answer.body as { code: string }).code, "bad_slug");
  assert.equal(s.a12s.agents.has("web-addon-x"), false);
});

test("Library: bad manifests are refused; access cannot change while on; a new image rewrites each instance", async (t) => {
  const puts: string[] = [];
  const s = await setup(t, {
    wrap: (fake) => ({
      ...fake,
      async putService(name, spec) {
        puts.push(`${name} ${spec.image}`);
        return fake.putService(name, spec);
      },
    }),
  });
  for (const bad of [
    { ...narrate, extra: 1 },
    { ...narrate, id: "Narrate" },
    { ...narrate, id: "na-rrate" },
    { ...narrate, image: "registry.example/narrate" },
    { ...narrate, description: "two\nlines" },
    { ...narrate, access: [{ host: SPEECH, methods: ["POST"], paths: ["/x"], expiresAt: 1 }] },
    { ...narrate, access: Array.from({ length: 9 }, () => narrate.access[0]) },
  ]) {
    const answer = await s.owner("PUT", "/api/addons/narrate", bad);
    assert.equal(answer.status, 400, JSON.stringify(bad));
  }
  assert.equal((await s.owner("PUT", "/api/addons/other", narrate)).status, 400, "the id must match the URL");
  assert.deepEqual(deriveState(s.app, null).addons, [narrate, render]);

  await credential(s, "web");
  await credential(s, "notes");
  for (const team of ["web", "notes"]) assert.equal((await turnOn(s, team, "narrate")).status, 200);
  const changed = { ...narrate, access: [{ host: SPEECH, methods: ["POST", "DELETE"], paths: ["/v1/**"] }] };
  const refused = await s.owner("PUT", "/api/addons/narrate", changed);
  assert.equal(refused.status, 409);
  assert.equal((refused.body as { code: string }).code, "in_use");
  assert.equal((await s.owner("DELETE", "/api/addons/narrate")).status, 409);

  puts.length = 0;
  const newer = { ...narrate, image: "registry.example/narrate:1.3.0", description: "Reads a script aloud." };
  assert.equal((await s.owner("PUT", "/api/addons/narrate", newer)).status, 200);
  assert.deepEqual(puts.sort(), [
    "notes-addon-narrate registry.example/narrate:1.3.0",
    "web-addon-narrate registry.example/narrate:1.3.0",
  ]);
  assert.deepEqual(deriveState(s.app, null).addons[0], newer);
});

test("An instance that cannot run is a card in Needs You until it runs", async (t) => {
  const s = await setup(t, { live: true });
  await until(() => s.app.live.up());
  assert.equal((await turnOn(s, "web", "render")).status, 200);
  const name = addonName("web", "render");
  s.a12s.setServicePhase(name, "Error", "image has no /a12s/service.json");
  await until(() => deriveState(s.app, null).needsYou.some((c) => c.kind === "addon_error"));
  assert.deepEqual(
    deriveState(s.app, null).needsYou.filter((c) => c.kind === "addon_error"),
    [{ kind: "addon_error", teamId: "web", addonId: "render", error: "image has no /a12s/service.json" }],
  );
  s.a12s.setServicePhase(name, "Ready");
  await until(() => !deriveState(s.app, null).needsYou.some((c) => c.kind === "addon_error"));
  assert.equal(deriveState(s.app, null).teams.find((x) => x.id === "web")?.addons[0]?.status, "ready");
});
