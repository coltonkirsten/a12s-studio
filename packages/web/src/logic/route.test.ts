import assert from "node:assert/strict";
import { test } from "node:test";
import { href, inspectHref, parseRoute, type Route, settingsHref } from "./route.ts";

const at = (team: string | null, thread: string | null, settings = false, inspect: string | null = null): Route => ({
  team,
  thread,
  settings,
  inspect,
});

test("parseRoute reads team, thread, settings and the inspected agent from the hash", () => {
  const rows: [string, Route][] = [
    ["", at(null, null)],
    ["#/", at(null, null)],
    ["#/website", at("website", null)],
    ["#/website/", at("website", null)],
    ["#/website/th_abc", at("website", "th_abc")],
    ["#/notes/new", at("notes", "new")],
    ["#/notes/settings", at("notes", null, true)],
    ["#/website?inspect=website-dev", at("website", null, false, "website-dev")],
    ["#/website/th_abc?inspect=website-dev", at("website", "th_abc", false, "website-dev")],
    ["#/notes/settings?inspect=notes-lead", at("notes", null, true, "notes-lead")],
    ["#/website/th_abc?inspect=", at("website", "th_abc")],
  ];
  for (const [hash, route] of rows) assert.deepEqual(parseRoute(hash), route, hash);
});

test("href and settingsHref round-trip through parseRoute", () => {
  for (const [team, thread] of [
    [null, null],
    ["website", null],
    ["website", "th_abc"],
  ] as const) {
    assert.deepEqual(parseRoute(href(team, thread)), at(team, thread));
  }
  assert.deepEqual(parseRoute(settingsHref("website")), at("website", null, true));
});

test("inspectHref opens over the page on screen, or over the agent's team from another page", () => {
  const rows: [Route | undefined, string | null, Route][] = [
    [at("website", "th_abc"), "website-dev", at("website", "th_abc", false, "website-dev")],
    [at("website", "th_abc", false, "website-dev"), "website-lead", at("website", "th_abc", false, "website-lead")],
    [at("website", null, true), "website-dev", at("website", null, true, "website-dev")],
    [at(null, null), "notes-lead", at("notes", null, false, "notes-lead")],
    [undefined, "notes-lead", at("notes", null, false, "notes-lead")],
    [at("website", "th_abc"), "notes-lead", at("notes", null, false, "notes-lead")],
    [at("website", "th_abc", false, "website-dev"), null, at("website", "th_abc")],
    [at("notes", null, true, "notes-lead"), null, at("notes", null, true)],
  ];
  for (const [from, agent, to] of rows) {
    assert.deepEqual(parseRoute(inspectHref(agent, from)), to, JSON.stringify(from));
  }
});
