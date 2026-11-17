import assert from "node:assert/strict";
import { test } from "node:test";
import { teamOf } from "@a12s-studio/contract/names";
import { studio, until } from "./studio.ts";

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
const OWN_SLUGS: Record<string, string[]> = { web: ["lead", "dev", "owner"], notes: ["lead", "researcher", "owner"] };
const OTHER_SLUGS = ["researcher", "dev", "notes-lead", "web-dev", "nobody"];

for (const seed of [1, 2, 3]) {
  test(`random tool calls from two teams keep every row and every read inside the caller's team (seed ${seed})`, async (t) => {
    const s = await studio({ live: true });
    t.after(() => s.close());
    await s.twoTeams();
    const pick = random(seed);
    const owner = new Map<string, string>(); // thread or message id -> team
    // Turns start and end at random, and every few calls the dispatcher delivers, so posts made from a Turn get a
    // cause and messages are steered into running Turns.
    const turns = async (agent: string) => {
      await s.app.dispatcher.run();
      if (s.a12s.agents.get(agent)?.current) {
        s.a12s.finishTurn(agent);
        await until(() => s.app.live.agent(agent)?.turn === null);
      } else {
        const turn = s.a12s.startTurn(agent);
        await until(() => s.app.live.agent(agent)?.turn?.id === turn);
      }
    };
    // Own-team ids and names are picked more often, so most calls succeed and the rest probe the wall.
    const ids = (team: string) => {
      const own = [...owner].filter(([, t]) => t === team).map(([id]) => id);
      return [...own, ...own, ...owner.keys(), "th_000000000000", "m_000000000000"];
    };
    const codes = new Map<string, number>();

    for (let i = 0; i < 300; i++) {
      const agent = pick(AGENTS);
      if (i % 2 === 0) await turns(agent);
      const team = teamOf(agent);
      const id = pick(ids(team));
      const slugs = [...(OWN_SLUGS[team] ?? []), ...(OWN_SLUGS[team] ?? []), ...OTHER_SLUGS];
      const [name, args] = pick([
        ["post", { to: pick(slugs), title: `t${i}`, body: `b${i}` }],
        ["post", { to: pick(slugs), thread: id, body: `b${i}` }],
        ["post", { thread: id, body: `n${i}`, ...(i % 2 ? { to: pick(slugs) } : {}) }],
        ["read", {}],
        ["read", { status: "all", before: id }],
        ["read", { thread: id }],
        ["read", { thread: id, before: pick(ids(team)) }],
        ["update_thread", { thread: id, owner: pick(slugs) }],
        ["update_thread", { thread: id, status: pick(["open", "done"]) }],
        ["roster", {}],
      ] as const);
      const answer = await s.tool(agent, name, args);
      const code = answer.error?.code ?? "ok";
      codes.set(code, (codes.get(code) ?? 0) + 1);
      if (typeof answer.message === "string") owner.set(answer.message, team);
      if (typeof answer.thread === "string") owner.set(answer.thread, team);
      const seen = [
        ...((answer.threads as { id: string }[] | undefined) ?? []).map((t) => t.id),
        ...((answer.messages as { id: string }[] | undefined) ?? []).map((m) => m.id),
        ...(answer.thread && typeof answer.thread === "object" ? [(answer.thread as { id: string }).id] : []),
      ];
      for (const seenId of seen) assert.equal(owner.get(seenId), team, `${agent} saw ${seenId} in ${name}`);
    }
    assert.ok((codes.get("ok") ?? 0) > 100 && owner.size > 10, `too few calls succeeded: ${[...codes]}`);
    await s.app.dispatcher.run();

    const rows = (sql: string) => s.db.prepare(sql).all();
    assert.deepEqual(
      rows(`SELECT m.id FROM messages m LEFT JOIN threads t ON t.id = m.thread_id
            LEFT JOIN messages c ON c.id = m.cause_id
            WHERE (m.thread_id IS NOT NULL AND t.team_id IS NOT m.team_id)
               OR (m.cause_id IS NOT NULL AND (c.team_id IS NOT m.team_id OR m.depth <> c.depth + 1))`),
      [],
    );
    assert.ok(
      Number(rows("SELECT count(*) AS n FROM messages WHERE cause_id IS NOT NULL")[0]?.n) > 0,
      "some posts should have had a cause",
    );
    for (const m of rows("SELECT id, team_id, from_id, to_id FROM messages")) {
      for (const who of [m.from_id, m.to_id]) {
        if (typeof who === "string" && who.includes("-")) assert.equal(teamOf(who), m.team_id, `${m.id}: ${who}`);
      }
    }
    for (const t of rows("SELECT id, team_id, owner_agent_id FROM threads")) {
      assert.equal(teamOf(String(t.owner_agent_id)), t.team_id, String(t.id));
    }
    let delivered = 0;
    for (const [name, agent] of s.a12s.agents) {
      for (const sent of agent.inbox) {
        const row = s.db.prepare("SELECT team_id FROM messages WHERE id = ?").get(sent.metadata.message ?? "");
        assert.equal(row?.team_id, teamOf(name), `${name} got ${sent.metadata.message}`);
        delivered++;
      }
    }
    assert.ok(delivered > 0, "the run should have delivered something");
  });
}

for (const seed of [4, 5]) {
  test(`random access calls from two teams never make or show a request of the other team (seed ${seed})`, async (t) => {
    const s = await studio();
    t.after(() => s.close());
    await s.twoTeams();
    const pick = random(seed);
    const made = new Map<string, string>(); // request id -> the agent that made it
    const reach = { host: "api.example.com", methods: ["GET"], reason: "To read it." };

    for (let i = 0; i < 80; i++) {
      const agent = pick(AGENTS);
      const team = teamOf(agent);
      const stranger = pick(AGENTS);
      const [args] = pick([
        [{ action: "request", ...reach, paths: [`/v1/${i}`] }],
        [{ action: "request", ...reach, paths: [`/v1/${i}`], team: teamOf(stranger) }],
        [{ action: "request", ...reach, paths: [`/v1/${i}`], agentId: stranger }],
        [{ action: "request", ...reach, paths: [`/v1/${i}`], agent: stranger }],
        [{ action: "list" }],
        [{ action: "list", team: teamOf(stranger) }],
      ] as const);
      const answer = await s.tool(agent, "access", args);
      if (typeof answer.request === "string") made.set(answer.request, agent);
      for (const { id } of (answer.pending as { id: string }[] | undefined) ?? []) {
        assert.equal(teamOf(made.get(id) ?? ""), team, `${agent} saw ${id}`);
      }
    }

    assert.ok(made.size > 5, "too few requests succeeded");
    let rows = 0;
    for (const team of ["web", "notes"]) {
      for (const request of (await s.app.broker.forTeam(team).access()).requests) {
        assert.equal(made.get(request.id), request.agentId, request.id);
        assert.equal(teamOf(request.agentId), team, request.id);
        rows++;
      }
    }
    assert.equal(rows, made.size);
  });
}
