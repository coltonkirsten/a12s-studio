import assert from "node:assert/strict";
import { test } from "node:test";
import { fakeA12s } from "../src/a12s/fake.ts";
import type { A12sEvent, AgentSpec } from "../src/a12s/port.ts";

const spec = {} as AgentSpec;

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
  a12s.finishTurn("web-lead", { costTotalUsd: 0.5 });
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
  assert.equal(record?.costTotalUsd, 0.5);
});
