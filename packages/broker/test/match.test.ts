import assert from "node:assert/strict";
import { test } from "node:test";
import type { Grant } from "@a12s-studio/contract/broker-admin";
import { grantFor, isHost, isPattern, matches, parseTarget } from "../src/match.ts";

test("matches: a pattern covers exactly the paths it names", () => {
  const table: [pattern: string, path: string, covered: boolean][] = [
    ["/", "/", true],
    ["/", "/a", false],
    ["/a/b", "/a/b", true],
    ["/a/b", "/a/bc", false],
    ["/a/b", "/a/b/", false],
    ["/a/b", "/a/b/c", false],
    ["/a/b", "/a", false],
    ["/a/b", "/A/b", false],
    ["/a/b/", "/a/b/", true],
    ["/a/b/", "/a/b", false],
    ["/a/*", "/a/b", true],
    ["/a/*", "/a/", false],
    ["/a/*", "/a", false],
    ["/a/*", "/a/b/c", false],
    ["/a/*/c", "/a/b/c", true],
    ["/a/*/c", "/a/b/d", false],
    ["/a/*/c", "/a/c", false],
    ["/a/*/c", "/a/b/b/c", false],
    ["/*", "/a", true],
    ["/*", "/", false],
    ["/a/**", "/a", true],
    ["/a/**", "/a/", true],
    ["/a/**", "/a/b", true],
    ["/a/**", "/a/b/c/d", true],
    ["/a/**", "/ab", false],
    ["/a/**", "/b/a", false],
    ["/a/**", "/", false],
    ["/a/*/**", "/a/b", true],
    ["/a/*/**", "/a/b/c", true],
    ["/a/*/**", "/a", false],
    ["/a/*/**", "/a/", false],
    ["/**", "/", true],
    ["/**", "/a/b", true],
    ["/a.git/info/refs", "/a.git/info/refs", true],
    ["/a.git/info/refs", "/aXgit/info/refs", false],
  ];
  for (const [pattern, path, covered] of table) {
    assert.equal(matches(pattern, path), covered, `${pattern} on ${path}`);
  }
});

test("isPattern: only literal segments, whole-segment * and a final /**", () => {
  const table: [pattern: string, valid: boolean][] = [
    ["/", true],
    ["/a/b", true],
    ["/a/b/", true],
    ["/a/*", true],
    ["/*/b", true],
    ["/a/**", true],
    ["/**", true],
    ["/a.git/info/refs", true],
    ["", false],
    ["a/b", false],
    ["/a/**/b", false],
    ["/**/b", false],
    ["/a/b*", false],
    ["/a/*b", false],
    ["/a/***", false],
    ["/a//b", false],
    ["/a/../b", false],
    ["/a/./b", false],
    ["/a/b?x=1", false],
    ["/a/b#x", false],
    ["/a/%2e%2e/b", false],
    ["/a b", false],
    ["/a\\b", false],
  ];
  for (const [pattern, valid] of table) assert.equal(isPattern(pattern), valid, pattern);
});

test("isHost: a lower-case public name, never an address or a local name", () => {
  const table: [host: string, valid: boolean][] = [
    ["api.example.com", true],
    ["example.com", true],
    ["a-b.example.co", true],
    ["1.example.com", true],
    ["xn--bcher-kva.example", true],
    ["example", false],
    ["", false],
    ["API.example.com", false],
    ["api.example.com.", false],
    [".example.com", false],
    ["api..example.com", false],
    ["-api.example.com", false],
    ["api-.example.com", false],
    ["api.example.com:443", false],
    ["user@example.com", false],
    ["127.0.0.1", false],
    ["127.1", false],
    ["0x7f.0.0.1", false],
    ["1.2.3.4.5", false],
    ["example.123", false],
    ["::1", false],
    ["localhost", false],
    ["app.localhost", false],
    ["studio.a12s", false],
    ["api.example.com/x", false],
    ["api example.com", false],
    [`${"a".repeat(250)}.com`, false],
  ];
  for (const [host, valid] of table) assert.equal(isHost(host), valid, host);
});

test("parseTarget: splits host, path and query, and keeps the path exactly as sent", () => {
  const table: [url: string, target: ReturnType<typeof parseTarget>][] = [
    ["/api.example.com/v1/items", { host: "api.example.com", path: "/v1/items", query: "" }],
    ["/api.example.com/", { host: "api.example.com", path: "/", query: "" }],
    ["/api.example.com/v1/items?a=1&b=../x", { host: "api.example.com", path: "/v1/items", query: "?a=1&b=../x" }],
    ["/api.example.com/v1/a%20b/", { host: "api.example.com", path: "/v1/a%20b/", query: "" }],
    ["/api.example.com/v1?", { host: "api.example.com", path: "/v1", query: "?" }],
    ["/api.example.com", undefined],
    ["/api.example.com?x=1", undefined],
    ["", undefined],
    ["/", undefined],
    ["//api.example.com/v1", undefined],
    ["api.example.com/v1", undefined],
    ["/api.example.com/v1/../x", undefined],
    ["/api.example.com/v1/%2E%2e/x", undefined],
    ["/api.example.com//v1", undefined],
    ["/api.example.com/v1%2Fx", undefined],
    ["/api.example.com/v1%5Cx", undefined],
    ["/api.example.com/v1\\x", undefined],
    ["/api.example.com/v1/..;/x", undefined],
    ["/api.example.com/v1/.;a=b/x", undefined],
    ["/api.example.com/v1/%252e%252e/x", undefined],
    ["/api.example.com/v1/x%00", undefined],
    ["/api.example.com/v1/%C0%AE/x", undefined],
    ["/api.example.com/v1/%u002e/x", undefined],
    ["/api.example.com/v1/x%2", undefined],
    ["/api.example.com/v1/a;b=c/x", { host: "api.example.com", path: "/v1/a;b=c/x", query: "" }],
    ["/api.example.com/v1/..a/.b/x", { host: "api.example.com", path: "/v1/..a/.b/x", query: "" }],
    ["/api.example.com/v1 x", undefined],
    ["/api.example.com/v1?a=é", undefined],
    ["/localhost/v1", undefined],
    ["/127.0.0.1/v1", undefined],
  ];
  for (const [url, target] of table) assert.deepEqual(parseTarget(url), target, url);
});

test("grantFor: picks a live grant that lists the method and covers the path", () => {
  const now = 1000;
  const grant = (id: string, change: Partial<Grant> = {}): Grant => ({
    id: `g_${id}`,
    host: "api.example.com",
    methods: ["GET"],
    paths: ["/v1/items"],
    expiresAt: null,
    requestId: null,
    createdAt: 0,
    warnedAt: null,
    revokedAt: null,
    expiredAt: null,
    ...change,
  });
  const table: [name: string, grants: Grant[], method: string, path: string, chosen: string | undefined][] = [
    ["no grants", [], "GET", "/v1/items", undefined],
    ["a match", [grant("a")], "GET", "/v1/items", "g_a"],
    ["HEAD rides on GET", [grant("a")], "HEAD", "/v1/items", "g_a"],
    ["GET does not ride on POST", [grant("a", { methods: ["POST"] })], "GET", "/v1/items", undefined],
    ["HEAD does not ride on POST", [grant("a", { methods: ["POST"] })], "HEAD", "/v1/items", undefined],
    ["method case matters", [grant("a")], "get", "/v1/items", undefined],
    ["path not covered", [grant("a")], "GET", "/v1/items2", undefined],
    ["revoked", [grant("a", { revokedAt: 1 })], "GET", "/v1/items", undefined],
    ["expires later", [grant("a", { expiresAt: now + 1 })], "GET", "/v1/items", "g_a"],
    ["expires now", [grant("a", { expiresAt: now })], "GET", "/v1/items", undefined],
    ["expired", [grant("a", { expiresAt: now - 1 })], "GET", "/v1/items", undefined],
    ["skips a dead grant for a live one", [grant("a", { revokedAt: 1 }), grant("b")], "GET", "/v1/items", "g_b"],
    ["any listed path", [grant("a", { paths: ["/x", "/v1/**"] })], "GET", "/v1/items", "g_a"],
    [
      "method and path from one grant",
      [grant("a", { methods: ["POST"] }), grant("b", { paths: ["/x"] })],
      "GET",
      "/v1/items",
      undefined,
    ],
  ];
  for (const [name, grants, method, path, chosen] of table) {
    assert.equal(grantFor(grants, method, path, now)?.id, chosen, name);
  }
});
