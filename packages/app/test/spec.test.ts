import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { BROKER_URL } from "@a12s-studio/contract/names";
import { agentSpec } from "../src/a12s/spec.ts";
import type { Agent } from "../src/repo.ts";

const agent: Agent = {
  id: "web-dev",
  teamId: "web",
  slug: "dev",
  role: "Writes the code.\nTests it too.",
  model: "haiku",
  sleepAfterIdle: "15m",
  compactMinTokens: 100000,
  cpu: null,
  memory: null,
  createdAt: 0,
};
const team = { name: "Website", purpose: "Build the site." };

test("the instructions are the spec's core text, then the brief, then the role", () => {
  const doc = readFileSync(new URL("../../../docs/build-spec.md", import.meta.url), "utf8");
  const block = doc.split("**Core instructions**")[1]?.split("```")[1];
  assert.ok(block, "the core instructions block is in the build spec");
  const core = block
    .replace(/^\n/, "")
    .replace(/\n$/, "")
    .replace("{agent}", "dev")
    .replace("{team}", "Website")
    .replaceAll("{BROKER_URL}", BROKER_URL);
  assert.equal(
    agentSpec(team, agent).instructions,
    `${core}\n\n# Team: Website\nBuild the site.\n\n# Your role\nWrites the code.\nTests it too.`,
  );
});

test("the spec pins the harness, keeps the agent's own settings and adds nothing else", () => {
  const { instructions: _, files, ...spec } = agentSpec(team, agent);
  assert.deepEqual(spec, {
    harness: {
      kind: "claude-code",
      version: "2.1.280",
      model: "haiku",
      settings: {
        hooks: {
          SessionStart: [
            { matcher: "startup|clear|compact", hooks: [{ type: "command", command: "/home/agent/bin/load-notes" }] },
          ],
        },
      },
    },
    image: "slim",
    credentials: ["anthropic"],
    power: { sleepAfterIdle: "15m", compactBeforeSleep: { minTokens: 100000 } },
    grants: { send: [] },
    uses: ["studio", { name: "broker", mcp: false }],
    egress: { allow: ["*"] },
  });
  assert.deepEqual(Object.keys(files), ["bin/load-notes", ".gitconfig"]);
  assert.match(files["bin/load-notes"] ?? "", /^#!\/bin\/sh\n/);
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
