import assert from "node:assert/strict";
import { test } from "node:test";
import type { CreateGrantBody } from "@a12s-studio/contract/broker-admin";
import { githubCredentials, type Preset, parseRepo, presetGrant, type Repo } from "./presets.ts";

test("parseRepo reads owner/repo, also from a pasted address", () => {
  const rows: [string, Repo | null][] = [
    ["example/site", { owner: "example", name: "site" }],
    ["  example/site  ", { owner: "example", name: "site" }],
    ["example/site.git", { owner: "example", name: "site" }],
    ["example/my.site_v2-x", { owner: "example", name: "my.site_v2-x" }],
    ["https://github.com/example/site", { owner: "example", name: "site" }],
    ["https://github.com/example/site.git", { owner: "example", name: "site" }],
    ["github.com/example/site/", { owner: "example", name: "site" }],
    ["example", null],
    ["example/", null],
    ["/site", null],
    ["example/site/tree", null],
    ["example/..", null],
    ["example/.", null],
    ["-example/site", null],
    ["example/si te", null],
    ["example/*", null],
    ["https://gitlab.com/example/site", null],
  ];
  for (const [text, repo] of rows) assert.deepEqual(parseRepo(text), repo, text);
});

test("each preset expands to exactly the grant of build-spec 9.3", () => {
  const repo = { owner: "example", name: "site" };
  const rows: [Preset, CreateGrantBody][] = [
    [
      { kind: "read" },
      {
        host: "github.com",
        methods: ["GET", "POST"],
        paths: [
          "/example/site.git/info/refs",
          "/example/site.git/git-upload-pack",
          "/example/site/info/refs",
          "/example/site/git-upload-pack",
        ],
      },
    ],
    [
      { kind: "write" },
      { host: "github.com", methods: ["GET", "POST"], paths: ["/example/site.git/**", "/example/site/**"] },
    ],
    [
      { kind: "api", methods: ["GET"] },
      { host: "api.github.com", methods: ["GET"], paths: ["/repos/example/site/**"] },
    ],
    [
      { kind: "api", methods: ["GET", "POST", "PATCH"] },
      { host: "api.github.com", methods: ["GET", "POST", "PATCH"], paths: ["/repos/example/site/**"] },
    ],
  ];
  for (const [preset, grant] of rows) assert.deepEqual(presetGrant(repo, preset), grant, preset.kind);
});

test("a GitHub token is stored as a basic login for git and a bearer token for the API", () => {
  assert.deepEqual(githubCredentials("token-value"), [
    ["github.com", { scheme: "basic", username: "x-access-token", secret: "token-value" }],
    ["api.github.com", { scheme: "bearer", secret: "token-value" }],
  ]);
});
