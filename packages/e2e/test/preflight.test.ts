import assert from "node:assert/strict";
import { test } from "node:test";
import { missing, type Probes } from "../src/preflight.ts";

const ready: Probes = { docker: true, a12s: "0.11.1", busyPorts: [] };
const env = { CLAUDE_CODE_OAUTH_TOKEN: "set" };

test("each missing thing is named, all of them at once", () => {
  const cases: [string, Record<string, string | undefined>, Probes, string[]][] = [
    ["all there", env, ready, []],
    ["the same minor release", env, { ...ready, a12s: "0.11.0" }, []],
    ["a later major release", env, { ...ready, a12s: "1.0.0" }, []],
    ["Docker stopped", env, { ...ready, docker: false }, ["Docker is not running."]],
    ["no a12s", env, { ...ready, a12s: null }, ["a12s is not installed."]],
    ["an old a12s", env, { ...ready, a12s: "0.10.9" }, ["a12s 0.10.9 is too old; 0.11.0 or later is needed."]],
    ["a Studio running", env, { ...ready, busyPorts: [7400, 7420] }, ["Port 7400 is in use.", "Port 7420 is in use."]],
    ["no token", {}, ready, ["CLAUDE_CODE_OAUTH_TOKEN is not set."]],
    ["an empty token", { CLAUDE_CODE_OAUTH_TOKEN: "" }, ready, ["CLAUDE_CODE_OAUTH_TOKEN is not set."]],
    [
      "everything",
      {},
      { docker: false, a12s: null, busyPorts: [7410] },
      [
        "Docker is not running.",
        "a12s is not installed.",
        "Port 7410 is in use.",
        "CLAUDE_CODE_OAUTH_TOKEN is not set.",
      ],
    ],
  ];
  for (const [name, given, probes, want] of cases) {
    assert.deepEqual(
      missing(given, probes).map((p) => p.what),
      want,
      name,
    );
  }
});

test("every problem comes with its fix", () => {
  for (const problem of missing({}, { docker: false, a12s: "0.1.0", busyPorts: [7400] })) {
    assert.ok(problem.fix.length > 0, problem.what);
  }
});
