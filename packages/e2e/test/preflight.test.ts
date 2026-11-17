import assert from "node:assert/strict";
import { test } from "node:test";
import { missing, type Probes } from "../src/preflight.ts";

const ready: Probes = { docker: true, a12s: "0.11.2", busyPorts: [] };
const env = { CLAUDE_CODE_OAUTH_TOKEN: "set" };
const github = { ...env, E2E_GITHUB_REPO: "example/scratch", E2E_GITHUB_TOKEN: "set" };
const p1 = ["p1"];
const both = ["p1", "p2"];

test("each missing thing is named, all of them at once", () => {
  const cases: [string, Record<string, string | undefined>, Probes, string[], string[]][] = [
    ["all there", env, ready, p1, []],
    ["a later patch release", env, { ...ready, a12s: "0.11.3" }, p1, []],
    ["a later major release", env, { ...ready, a12s: "1.0.0" }, p1, []],
    ["Docker stopped", env, { ...ready, docker: false }, p1, ["Docker is not running."]],
    ["no a12s", env, { ...ready, a12s: null }, p1, ["a12s is not installed."]],
    ["an old a12s", env, { ...ready, a12s: "0.10.9" }, p1, ["a12s 0.10.9 is too old; 0.11.2 or later is needed."]],
    [
      "an earlier patch release",
      env,
      { ...ready, a12s: "0.11.1" },
      p1,
      ["a12s 0.11.1 is too old; 0.11.2 or later is needed."],
    ],
    [
      "a Studio running",
      env,
      { ...ready, busyPorts: [7400, 7420] },
      p1,
      ["Port 7400 is in use.", "Port 7420 is in use."],
    ],
    ["no token", {}, ready, p1, ["CLAUDE_CODE_OAUTH_TOKEN is not set."]],
    ["an empty token", { CLAUDE_CODE_OAUTH_TOKEN: "" }, ready, p1, ["CLAUDE_CODE_OAUTH_TOKEN is not set."]],
    ["p2 with its repository and token", github, ready, both, []],
    ["p2 alone", github, ready, ["p2"], []],
    ["p2 without them", env, ready, both, ["E2E_GITHUB_REPO is not set.", "E2E_GITHUB_TOKEN is not set."]],
    ["p2 without its token", { ...github, E2E_GITHUB_TOKEN: "" }, ready, ["p2"], ["E2E_GITHUB_TOKEN is not set."]],
    [
      "everything",
      {},
      { docker: false, a12s: null, busyPorts: [7410] },
      both,
      [
        "Docker is not running.",
        "a12s is not installed.",
        "Port 7410 is in use.",
        "CLAUDE_CODE_OAUTH_TOKEN is not set.",
        "E2E_GITHUB_REPO is not set.",
        "E2E_GITHUB_TOKEN is not set.",
      ],
    ],
  ];
  for (const [name, given, probes, chosen, want] of cases) {
    assert.deepEqual(
      missing(given, probes, chosen).map((p) => p.what),
      want,
      name,
    );
  }
});

test("every problem comes with its fix", () => {
  for (const problem of missing({}, { docker: false, a12s: "0.1.0", busyPorts: [7400] }, both)) {
    assert.ok(problem.fix.length > 0, problem.what);
  }
});
