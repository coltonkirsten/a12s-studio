import assert from "node:assert/strict";
import { test } from "node:test";
import { href, parseRoute, type Route, settingsHref } from "./route.ts";

test("parseRoute reads team, thread and settings from the hash", () => {
  const rows: [string, Route][] = [
    ["", { team: null, thread: null, settings: false }],
    ["#/", { team: null, thread: null, settings: false }],
    ["#/website", { team: "website", thread: null, settings: false }],
    ["#/website/", { team: "website", thread: null, settings: false }],
    ["#/website/th_abc", { team: "website", thread: "th_abc", settings: false }],
    ["#/notes/new", { team: "notes", thread: "new", settings: false }],
    ["#/notes/settings", { team: "notes", thread: null, settings: true }],
  ];
  for (const [hash, route] of rows) assert.deepEqual(parseRoute(hash), route, hash);
});

test("href and settingsHref round-trip through parseRoute", () => {
  for (const [team, thread] of [
    [null, null],
    ["website", null],
    ["website", "th_abc"],
  ] as const) {
    assert.deepEqual(parseRoute(href(team, thread)), { team, thread, settings: false });
  }
  assert.deepEqual(parseRoute(settingsHref("website")), { team: "website", thread: null, settings: true });
});
