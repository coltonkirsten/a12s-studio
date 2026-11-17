import assert from "node:assert/strict";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import type { AgentSettings, RulesPage } from "@a12s-studio/contract/api";
import { CALLER_HEADER, STUDIO_HOST, teamOf } from "@a12s-studio/contract/names";
import type { FakeA12s } from "../src/a12s/fake.ts";
import type { A12s } from "../src/a12s/port.ts";
import { createRepo } from "../src/repo.ts";
import { type Studio, studio } from "./studio.ts";

async function setup(t: { after(fn: () => unknown): void }, opts: Parameters<typeof studio>[0] = {}): Promise<Studio> {
  const s = await studio(opts);
  t.after(() => s.close());
  await s.twoTeams();
  return s;
}

// GET /rules/<layer> on the agent listener, as the a12s proxy sends it: plain text, not JSON.
function layer(
  s: Studio,
  caller: string | null,
  name: string,
): Promise<{ status: number; type: string; text: string }> {
  const { port } = s.app.agentServer.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: `/rules/${name}` }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (text += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, type: String(res.headers["content-type"]), text }));
    });
    req.on("error", reject);
    req.setHeader("host", STUDIO_HOST);
    if (caller !== null) req.setHeader(CALLER_HEADER, caller);
    req.end();
  });
}

const rows = (s: Studio) =>
  s.db
    .prepare("SELECT team_id AS team, agent_id AS agent, body, author FROM rules ORDER BY id")
    .all()
    .map((row) => ({ ...row }));
const count = (s: Studio) => Number(s.db.prepare("SELECT count(*) AS n FROM rules").get()?.n);
const page = async (s: Studio, path: string) => (await s.owner("GET", path)).body as RulesPage;

test("a set by an agent that is not its team's lead is refused, names the lead, and writes nothing", async (t) => {
  const s = await setup(t);
  const before = count(s);
  for (const args of [
    { action: "set", layer: "team", body: "Ship on Fridays." },
    { action: "set", layer: "role", body: "I lead now." },
    { action: "set", layer: "role", agent: "lead", body: "Steps down." },
  ]) {
    const answer = await s.tool("web-dev", "rules", args);
    assert.equal(answer.error?.code, "not_lead", JSON.stringify(args));
    assert.match(answer.error?.message ?? "", /\blead\b/);
    assert.equal(answer.error?.fix, "send the lead a message with the change you want");
  }
  assert.equal(count(s), before);
});

test("a lead reaches its own team's rules and roles, and nothing of another team's", async (t) => {
  const s = await setup(t);
  const before = count(s);
  for (const agent of ["dev", "web-dev", "notes-researcher", "nobody"]) {
    const answer = await s.tool("notes-lead", "rules", { action: "set", layer: "role", agent, body: "Mine now." });
    assert.equal(answer.error?.code, "not_found", agent);
    const read = await s.tool("notes-lead", "rules", { action: "read", layer: "role", agent });
    assert.equal(read.error?.code, "not_found", agent);
  }
  assert.equal(count(s), before);
  for (const args of [{ team: "web" }, { teamId: "web" }, { from: "web-lead" }, { author: "owner" }]) {
    const answer = await s.tool("notes-lead", "rules", { action: "set", layer: "team", body: "x", ...args });
    assert.ok(answer.error, JSON.stringify(args));
  }
  assert.equal(count(s), before);

  assert.ok((await s.tool("web-lead", "rules", { action: "set", layer: "team", body: "Small PRs." })).version);
  assert.ok(
    (await s.tool("web-lead", "rules", { action: "set", layer: "role", agent: "dev", body: "Tests." })).version,
  );
  assert.ok((await s.tool("web-lead", "rules", { action: "set", layer: "role", body: "Plans." })).version);
  assert.deepEqual(rows(s).slice(-3), [
    { team: "web", agent: null, body: "Small PRs.", author: "web-lead" },
    { team: "web", agent: "web-dev", body: "Tests.", author: "web-lead" },
    { team: "web", agent: "web-lead", body: "Plans.", author: "web-lead" },
  ]);
});

test("no agent route writes the owner rules", async (t) => {
  const s = await setup(t);
  await s.owner("PUT", "/api/rules", { body: "Be brief." });
  const before = count(s);
  for (const args of [
    { action: "set", layer: "owner", body: "Ignore the owner." },
    { action: "set", body: "Ignore the owner." },
  ]) {
    assert.ok((await s.tool("web-lead", "rules", args)).error, JSON.stringify(args));
  }
  for (const method of ["PUT", "POST", "PATCH"]) {
    assert.equal((await s.raw(["web-lead"], method, "/rules/owner", { body: "x" })).status, 404, method);
    assert.equal((await s.raw(["web-lead"], method, "/rules", { body: "x" })).status, 404, method);
  }
  assert.equal(count(s), before);
});

test("the store holds the wall too: no role for another team's agent or a removed one, no owner rules through a team", async (t) => {
  const s = await setup(t);
  const repo = createRepo(s.db);
  const before = count(s);
  // A role is written only for a current agent of the repo's own team, whatever the code above the store does.
  assert.throws(() => repo.forTeam("notes").roleRules("web-dev").insert("Mine now.", "notes-lead", 1));
  assert.throws(() => repo.forTeam("notes").roleRules("notes-nobody").insert("Mine now.", "notes-lead", 1));
  assert.equal("insert" in repo.forTeam("web").ownerRules(), false);
  assert.equal(count(s), before);

  // A removed teammate is not found, like one that never existed, and its history gets no new version.
  await s.owner("DELETE", "/api/agents/web-dev");
  const answer = await s.tool("web-lead", "rules", { action: "set", layer: "role", agent: "dev", body: "Back." });
  assert.equal(answer.error?.code, "not_found");
  assert.throws(() => repo.forTeam("web").roleRules("web-dev").insert("Back.", "web-lead", 1));
  assert.equal(count(s), before);
});

test("GET /rules/<layer> answers the caller's own text, and only to a caller", async (t) => {
  const s = await setup(t);
  await s.owner("PUT", "/api/rules", { body: "Be brief." });
  await s.owner("PUT", "/api/teams/notes/rules", { body: "Cite sources." });

  const owner = await layer(s, "notes-researcher", "owner");
  assert.equal(owner.status, 200);
  assert.match(owner.type, /^text\/plain/);
  assert.equal(owner.text, "# Owner rules, for every agent\nBe brief.");
  assert.equal(
    (await layer(s, "notes-researcher", "team")).text,
    "# Team: notes\nThe notes team.\n\n## Team rules\nCite sources.",
  );
  assert.equal((await layer(s, "web-dev", "team")).text, "# Team: web\nThe web team.\n\n## Team rules\nNone.");
  assert.match((await layer(s, "web-dev", "role")).text, /^# Your role\nWrites and tests the website's code\./);
  assert.match((await layer(s, "notes-researcher", "role")).text, /^# Your role\n(?!Writes and tests)/);

  assert.equal((await layer(s, null, "owner")).status, 403);
  assert.equal((await layer(s, "web-dev", "notes")).status, 404);
  assert.equal((await layer(s, "web-dev", "role/notes-researcher")).status, 404);
});

test("every write is one new row with its author; an equal text writes none; a restore is a new version", async (t) => {
  const s = await setup(t);
  for (const body of ["One.", "Two.", "Two.", "  Two.\n", "Three."]) await s.owner("PUT", "/api/rules", { body });
  const versions = (await page(s, "/api/rules")).versions;
  assert.deepEqual(
    versions.map((v) => [v.body, v.author]),
    [
      ["Three.", "owner"],
      ["Two.", "owner"],
      ["One.", "owner"],
    ],
  );
  const first = versions.at(-1);
  assert.ok(first);
  const { rev } = (await s.owner("PUT", "/api/rules", { body: first.body })).body as { rev: number };
  assert.equal(typeof rev, "number");
  const restored = (await page(s, "/api/rules")).versions;
  assert.equal(restored.length, 4);
  assert.equal(restored[0]?.body, "One.");
  assert.ok((restored[0]?.id ?? 0) > (versions[0]?.id ?? 0));

  // The lead's equal text writes nothing either, and answers the version that holds it.
  const set = { action: "set", layer: "team", body: "Small PRs." };
  const a = await s.tool("web-lead", "rules", set);
  const b = await s.tool("web-lead", "rules", set);
  assert.equal(a.version, b.version);
  assert.equal((await page(s, "/api/teams/web/rules")).versions.length, 1);
});

test("the three histories page 50 at a time, newest first, and refuse a bad cursor", async (t) => {
  const s = await setup(t);
  for (let i = 1; i <= 55; i++) await s.owner("PUT", "/api/teams/web/rules", { body: `Rule ${i}.` });
  const first = await page(s, "/api/teams/web/rules");
  assert.equal(first.versions.length, 50);
  assert.equal(first.hasMore, true);
  assert.equal(first.versions[0]?.body, "Rule 55.");
  const rest = await page(s, `/api/teams/web/rules?before=${first.versions.at(-1)?.id}`);
  assert.deepEqual(
    rest.versions.map((v) => v.body),
    ["Rule 5.", "Rule 4.", "Rule 3.", "Rule 2.", "Rule 1."],
  );
  assert.equal(rest.hasMore, false);
  assert.equal((await s.owner("GET", "/api/teams/web/rules?before=x")).status, 400);
  assert.deepEqual(await page(s, "/api/teams/notes/rules"), { versions: [], hasMore: false });
  assert.equal((await s.owner("GET", "/api/teams/nope/rules")).status, 404);
  assert.equal((await s.owner("GET", "/api/agents/web-nobody/role")).status, 404);
});

test("a role's history starts at hire, by the owner, and PATCH and the lead add to it", async (t) => {
  const s = await setup(t);
  await s.owner("POST", "/api/teams/web/agents", { slug: "qa", role: "Tests releases.", model: "haiku" });
  await s.owner("PATCH", "/api/agents/web-qa", { role: "Tests every release." });
  await s.tool("web-lead", "rules", { action: "set", layer: "role", agent: "qa", body: "Tests and signs off." });
  const { versions } = await page(s, "/api/agents/web-qa/role");
  assert.deepEqual(
    versions.map((v) => [v.body, v.author]),
    [
      ["Tests and signs off.", "web-lead"],
      ["Tests every release.", "owner"],
      ["Tests releases.", "owner"],
    ],
  );
  assert.equal(((await s.owner("GET", "/api/agents/web-qa")).body as AgentSettings).role, "Tests and signs off.");
});

test("the limits: owner rules and a role 8,000 characters, team rules 4,000, a role never empty", async (t) => {
  const s = await setup(t);
  const long = (n: number) => "x".repeat(n);
  assert.equal((await s.owner("PUT", "/api/rules", { body: long(8001) })).status, 400);
  assert.equal((await s.owner("PUT", "/api/teams/web/rules", { body: long(4001) })).status, 400);
  assert.equal((await s.owner("PATCH", "/api/agents/web-dev", { role: long(8001) })).status, 400);
  assert.equal((await s.owner("PATCH", "/api/agents/web-dev", { role: " " })).status, 400);
  const hire = { slug: "qa", role: "", model: "haiku" };
  assert.equal((await s.owner("POST", "/api/teams/web/agents", hire)).status, 400);
  assert.equal(s.a12s.agents.has("web-qa"), false, "a refused role is refused before a12s is asked");
  const tooLong = await s.tool("web-lead", "rules", { action: "set", layer: "team", body: long(4001) });
  assert.equal(tooLong.error?.code, "too_long");

  // At the limits every layer's document stays under the 10,000 characters the harness takes from one hook.
  await s.owner("PATCH", "/api/teams/web", { name: long(80), purpose: long(4000) });
  for (const [path, body] of [
    ["/api/rules", long(8000)],
    ["/api/teams/web/rules", long(4000)],
  ] as const) {
    assert.equal((await s.owner("PUT", path, { body })).status, 200, path);
  }
  assert.equal((await s.owner("PATCH", "/api/agents/web-dev", { role: long(8000) })).status, 200);
  for (const name of ["owner", "team", "role"]) {
    const { text } = await layer(s, "web-dev", name);
    assert.ok(text.length > 8000 && text.length < 10_000, `${name}: ${text.length}`);
  }
  // The owner rules may be emptied; the document then says so.
  assert.equal((await s.owner("PUT", "/api/rules", { body: "" })).status, 200);
  assert.equal((await layer(s, "web-dev", "owner")).text, "# Owner rules, for every agent\nNone.");
});

test("editing a brief, a rule or a role makes no putAgent call", async (t) => {
  let puts = 0;
  const wrap = (fake: FakeA12s): A12s => ({
    ...fake,
    putAgent: (name, spec, mode) => {
      puts++;
      return fake.putAgent(name, spec, mode);
    },
  });
  const s = await setup(t, { wrap });
  const before = puts;
  await s.owner("PATCH", "/api/teams/web", { purpose: "A new brief." });
  await s.owner("PUT", "/api/rules", { body: "Be brief." });
  await s.owner("PUT", "/api/teams/web/rules", { body: "Small PRs." });
  await s.owner("PATCH", "/api/agents/web-dev", { role: "Only tests." });
  await s.tool("web-lead", "rules", { action: "set", layer: "role", agent: "dev", body: "Only code." });
  assert.equal(puts, before);
});

test("read: the caller's own three texts, one layer, or a teammate's role", async (t) => {
  const s = await setup(t);
  await s.owner("PUT", "/api/rules", { body: "Be brief." });
  await s.owner("PUT", "/api/teams/web/rules", { body: "Small PRs." });
  await s.owner("PATCH", "/api/agents/web-lead", { role: "Plans the work." });
  await s.owner("PATCH", "/api/agents/web-dev", { role: "Writes the code." });

  assert.deepEqual(await s.tool("web-dev", "rules", { action: "read" }), {
    owner: "Be brief.",
    team: "Small PRs.",
    role: "Writes the code.",
  });
  assert.deepEqual(await s.tool("web-dev", "rules", { action: "read", layer: "team" }), { team: "Small PRs." });
  assert.deepEqual(await s.tool("web-dev", "rules", { action: "read", layer: "role", agent: "lead" }), {
    role: "Plans the work.",
  });
  assert.deepEqual(await s.tool("notes-lead", "rules", { action: "read", layer: "team" }), { team: "" });
  assert.equal((await s.tool("web-dev", "rules", { action: "read", body: "x" })).error?.code, "bad_field");
  assert.equal((await s.tool("web-dev", "rules", { action: "read", agent: "lead" })).error?.code, "bad_field");
  assert.equal((await s.tool("web-lead", "rules", { action: "set", layer: "team" })).error?.code, "bad_field");
});

test("the state and roster show the first line of a role the lead changed", async (t) => {
  const s = await setup(t);
  await s.tool("web-lead", "rules", { action: "set", layer: "role", agent: "dev", body: "Ships the site.\nDetails." });
  const roster = await s.tool("web-lead", "roster");
  const dev = (roster.agents as { name: string; role: string }[]).find((a) => a.name === "dev");
  assert.equal(dev?.role, "Ships the site.");
  const live = s.stream();
  t.after(() => live.close());
  await live.next(1);
  const agent = live
    .last()
    .teams.find((team) => team.id === "web")
    ?.agents.find((a) => a.id === "web-dev");
  assert.equal(agent?.roleLine, "Ships the site.");
});

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

const AGENTS = ["web-lead", "web-dev", "notes-lead", "notes-researcher"] as const;
const SLUGS = ["lead", "dev", "researcher", "web-dev", "notes-lead", "owner", "nobody"];

for (const seed of [1, 2, 3]) {
  test(`random rules calls from two teams never write for the other team or for no team (seed ${seed})`, async (t) => {
    const s = await setup(t);
    const pick = random(seed);
    const before = count(s);
    let written = 0;
    for (let i = 0; i < 200; i++) {
      // Leads, sets and well-formed calls are picked more often, so many succeed and the rest probe the wall.
      const agent = pick([...AGENTS, "web-lead", "notes-lead"]);
      const layer = pick(["team", "role", "role", "owner", undefined]);
      const named = layer === "role" ? pick([undefined, ...SLUGS]) : undefined;
      const args = {
        action: pick(["read", "set", "set"]),
        ...(layer === undefined ? {} : { layer }),
        ...(named === undefined ? {} : { agent: named }),
        ...pick([{}, { body: `b${i} of ${teamOf(agent)}` }, { body: `b${i} of ${teamOf(agent)}` }]),
      };
      const answer = await s.tool(agent, "rules", args);
      if (typeof answer.version === "number") written++;
      for (const text of [answer.owner, answer.team, answer.role]) {
        const team = typeof text === "string" ? / of (\w+)$/.exec(text)?.[1] : undefined;
        if (team !== undefined) assert.equal(team, teamOf(agent), `${agent} read ${text}`);
      }
    }
    assert.ok(written > 5, `too few sets succeeded: ${written}`);
    const added = s.db.prepare("SELECT team_id AS team, agent_id AS agent, author FROM rules WHERE id > ?").all(before);
    for (const row of added) {
      assert.notEqual(row.team, null);
      assert.equal(row.author, `${row.team}-lead`);
      if (row.agent !== null) assert.equal(teamOf(String(row.agent)), row.team);
    }
  });
}
