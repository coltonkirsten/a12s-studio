import assert from "node:assert/strict";
import { test } from "node:test";
import { href, parseRoute } from "./route.ts";

test("parseRoute reads team and thread from the hash", () => {
  const rows: [string, { team: string | null; thread: string | null }][] = [
    ["", { team: null, thread: null }],
    ["#/", { team: null, thread: null }],
    ["#/website", { team: "website", thread: null }],
    ["#/website/", { team: "website", thread: null }],
    ["#/website/th_abc", { team: "website", thread: "th_abc" }],
    ["#/notes/new", { team: "notes", thread: "new" }],
  ];
  for (const [hash, route] of rows) assert.deepEqual(parseRoute(hash), route, hash);
});

test("href round-trips through parseRoute", () => {
  for (const [team, thread] of [
    [null, null],
    ["website", null],
    ["website", "th_abc"],
  ] as const) {
    assert.deepEqual(parseRoute(href(team, thread)), { team, thread });
  }
});
