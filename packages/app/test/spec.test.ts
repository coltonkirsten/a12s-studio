import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { BROKER_URL, STUDIO_URL } from "@a12s-studio/contract/names";
import { agentSpec } from "../src/a12s/spec.ts";
import type { Agent } from "../src/repo.ts";

const agent: Agent = {
  id: "web-dev",
  teamId: "web",
  slug: "dev",
  model: "haiku",
  sleepAfterIdle: "15m",
  compactMinTokens: 100000,
  cpu: null,
  memory: null,
  createdAt: 0,
};
const team = { name: "Website" };

test("the instructions are the basics alone, as the spec writes them", () => {
  const doc = readFileSync(new URL("../../../docs/build-spec.md", import.meta.url), "utf8");
  const block = doc.split("**Core instructions**")[1]?.split("```")[1];
  assert.ok(block, "the core instructions block is in the build spec");
  const core = block
    .replace(/^\n/, "")
    .replace(/\n$/, "")
    .replace("{agent}", "dev")
    .replace("{team}", "Website")
    .replaceAll("{BROKER_URL}", BROKER_URL);
  assert.equal(agentSpec(team, agent).instructions, core);
});

test("the hooks load the three rule layers and the notes at a session's start, and a changed layer per Message", () => {
  const doc = readFileSync(new URL("../../../docs/build-spec.md", import.meta.url), "utf8");
  const { harness, files } = agentSpec(team, agent);
  const command = (line: string) => ({ type: "command", command: `/home/agent/bin/${line}` });
  assert.deepEqual(harness.settings.hooks, {
    SessionStart: [
      {
        matcher: "startup|clear|compact",
        hooks: [
          command("load-rules owner"),
          command("load-rules team"),
          command("load-rules role"),
          command("load-notes"),
        ],
      },
    ],
    UserPromptSubmit: [
      {
        hooks: ["owner", "team", "role"].map((layer) => ({ ...command(`load-rules ${layer} changed`), timeout: 10 })),
      },
    ],
  });
  // The two scripts are the spec's, with its URL filled in.
  for (const name of ["bin/load-rules", "bin/load-notes"]) {
    const script = new RegExp(`  ${name}: \\|\n((?:    .*\n)+)`).exec(doc)?.[1];
    assert.ok(script, `${name} is in the build spec`);
    assert.equal(files[name], script.replaceAll(/^ {4}/gm, "").replace("<STUDIO_URL>", STUDIO_URL), name);
  }
});

test("the spec pins the harness, keeps the agent's own settings and adds nothing else", () => {
  const { instructions: _, files, ...spec } = agentSpec(team, agent);
  assert.deepEqual(spec, {
    harness: {
      kind: "claude-code",
      version: "2.1.280",
      model: "haiku",
      settings: spec.harness.settings,
    },
    image: "slim",
    credentials: ["anthropic"],
    power: { sleepAfterIdle: "15m", compactBeforeSleep: { minTokens: 100000 } },
    inbox: { duringTurn: "steer" },
    grants: { send: [] },
    uses: ["studio", { name: "broker", mcp: false }],
    egress: { allow: ["*"] },
  });
  assert.deepEqual(Object.keys(files), ["bin/load-rules", "bin/load-notes", ".gitconfig"]);
  assert.equal(
    files[".gitconfig"],
    `[url "${BROKER_URL}/github.com/"]\n    insteadOf = https://github.com/\n    insteadOf = git@github.com:\n` +
      "[user]\n    name = dev\n    email = web-dev@studio.invalid\n",
  );
});

test("resources appear only for the values that are set", () => {
  assert.deepEqual(agentSpec(team, { ...agent, cpu: 2 }).resources, { cpu: 2 });
  assert.deepEqual(agentSpec(team, { ...agent, cpu: 1.5, memory: "4Gi" }).resources, { cpu: 1.5, memory: "4Gi" });
});
