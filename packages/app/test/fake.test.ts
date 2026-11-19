import assert from "node:assert/strict";
import { test } from "node:test";
import { fakeA12s } from "../src/a12s/fake.ts";
import type { A12sEvent, AgentSpec } from "../src/a12s/port.ts";

const spec = { uses: [] as AgentSpec["uses"] } as AgentSpec;

test("a team token cannot touch another team's agents", async () => {
  const a12s = fakeA12s();
  await a12s.putAgent("web-lead", spec, "create");
  await a12s.putAgent("notes-lead", spec, "create");
  const web = a12s.forTeam(await a12s.createToken("web"));

  await web.wake("web-lead");
  await assert.rejects(web.send("notes-lead", { body: "hi", metadata: {}, replaceKey: "m_1" }), {
    code: "out_of_prefix",
  });
  await assert.rejects(web.sleep("webx-lead"), { code: "out_of_prefix" });
  assert.deepEqual(
    (await web.status()).map((s) => s.name),
    ["web-lead"],
  );
});

test("the event feed delivers scripted Turns in order", async () => {
  const a12s = fakeA12s();
  await a12s.putAgent("web-lead", spec, "create");
  const web = a12s.forTeam(await a12s.createToken("web"));
  const sent = await web.send("web-lead", { body: "draft it", metadata: {}, replaceKey: "m_a" });

  const feed = a12s.events();
  await feed.ready();
  const turn = a12s.startTurn("web-lead");
  a12s.emit({ type: "text.delta", agent: "web-lead", at: 0, turn, text: "done" });
  a12s.finishTurn("web-lead", { modelCostsUsd: { sonnet: 0.5 } });
  feed.close();

  const seen: A12sEvent[] = [];
  for await (const event of feed) seen.push(event);
  assert.deepEqual(
    seen.map((e) => e.type),
    ["agent_computer.phase", "turn.started", "text.delta", "turn.finished", "agent_computer.phase"],
  );
  assert.deepEqual(seen[1]?.type === "turn.started" && seen[1].messageIds, [sent.id]);
  const [record] = await web.turns("web-lead", 1);
  assert.equal(record?.text, "done");
  assert.deepEqual(record?.modelCostsUsd, { sonnet: 0.5 });
});

test("a sleeping agent keeps its Turn history but refuses its Turn events and files", async () => {
  const a12s = fakeA12s();
  await a12s.putAgent("web-lead", spec, "create");
  const web = a12s.forTeam(await a12s.createToken("web"));
  const turn = a12s.startTurn("web-lead");
  a12s.finishTurn("web-lead");
  await web.sleep("web-lead");

  assert.equal((await web.turns("web-lead", 5)).length, 1);
  await assert.rejects(web.readFile("web-lead", "/home/agent"), { code: "asleep" });
  await assert.rejects(Array.fromAsync(web.turnEvents("web-lead", turn)), { code: "asleep" });
});

test("a Message for a working agent computer that steers joins its Turn; without the policy it waits", async () => {
  const a12s = fakeA12s();
  await a12s.putAgent("web-lead", { ...spec, inbox: { duringTurn: "steer" } }, "create");
  await a12s.putAgent("web-dev", spec, "create");
  const web = a12s.forTeam(await a12s.createToken("web"));
  const feed = a12s.events();
  await feed.ready();
  const turns = ["web-lead", "web-dev"].map((name) => a12s.startTurn(name));
  const steered = await web.send("web-lead", { body: "also this", metadata: {}, replaceKey: "m_a" });
  const waiting = await web.send("web-dev", { body: "also this", metadata: {}, replaceKey: "m_b" });
  await new Promise((resolve) => setImmediate(resolve));
  feed.close();

  const seen: A12sEvent[] = [];
  for await (const event of feed) seen.push(event);
  const steers = seen.flatMap((e) => (e.type === "turn.steered" ? [[e.agent, e.turn, e.messageIds]] : []));
  assert.deepEqual(steers, [["web-lead", turns[0], [steered.id]]]);
  assert.equal(a12s.agents.get("web-dev")?.inbox.find((m) => m.id === waiting.id)?.state, "pending");
  a12s.finishTurn("web-lead");
  const [record] = await web.turns("web-lead", 1);
  assert.deepEqual(record?.messages, [{ id: steered.id, steered: true }]);
});

test("missTurn: the Batch misses the running Turn and starts the next one", async () => {
  const a12s = fakeA12s();
  await a12s.putAgent("web-lead", { ...spec, inbox: { duringTurn: "steer" } }, "create");
  const web = a12s.forTeam(await a12s.createToken("web"));
  const first = a12s.startTurn("web-lead");
  a12s.missTurn("web-lead");
  const sent = await web.send("web-lead", { body: "late", metadata: {}, replaceKey: "m_a" });
  await new Promise((resolve) => setImmediate(resolve));
  const lead = a12s.agents.get("web-lead");
  assert.equal(lead?.turns[0]?.id, first);
  assert.deepEqual(lead?.turns[0]?.messages, []);
  assert.deepEqual(lead?.current?.messages, [{ id: sent.id, steered: false }]);
  assert.equal(
    lead?.journal.some((e) => e.type === "turn.steered"),
    false,
  );
});
