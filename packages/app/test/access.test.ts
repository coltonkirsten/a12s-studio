import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { HOST, SECRET, startBroker } from "@a12s-studio/broker/test/harness.ts";
import type { AccessView, AuditPage } from "@a12s-studio/contract/broker-admin";
import type { NeedsYouItem } from "@a12s-studio/contract/state";
import { deriveState } from "../src/state.ts";
import { pending, type Studio, studio, until } from "./studio.ts";

const DAY = 24 * 60 * 60 * 1000;
const wish = { action: "request", host: HOST, methods: ["GET"], paths: ["/v1/items"], reason: "To list the items." };

// The app on the real broker: its admin socket, its forwarder and an HTTPS stub as the outside host.
async function withBroker(t: TestContext) {
  const broker = await startBroker(t);
  const s = await studio({ broker: broker.socketPath });
  t.after(() => s.close());
  await s.twoTeams();
  return { broker, s };
}

function cards<K extends NeedsYouItem["kind"]>(s: Studio, kind: K): Extract<NeedsYouItem, { kind: K }>[] {
  return deriveState(s.app, null).needsYou.filter((c): c is Extract<NeedsYouItem, { kind: K }> => c.kind === kind);
}

test("exit path: request, credential, approve, deny, expiry and another team, against the real broker", async (t) => {
  const { broker, s } = await withBroker(t);
  const items = `/${HOST}/v1/items`;
  assert.equal((await broker.call(items, { caller: "web-dev" })).status, 403);

  const asked = await s.tool("web-dev", "access", { ...wish, days: 7 });
  assert.equal(asked.status, "pending");
  const [card] = cards(s, "access_request");
  assert.deepEqual(card && [card.teamId, card.request.id, card.request.agentId, card.request.days], [
    "web",
    asked.request,
    "web-dev",
    7,
  ]);
  assert.equal(card?.hostHasCredential, false);

  const approve = (id: unknown, body = {}) => s.owner("POST", `/api/teams/web/requests/${id}/approve`, body);
  const refused = await approve(asked.request);
  assert.deepEqual([refused.status, (refused.body as { code: string }).code], [409, "no_credential"]);

  const stored = await s.owner("PUT", `/api/teams/web/credentials/${HOST}`, { scheme: "bearer", secret: SECRET });
  assert.equal(stored.status, 200);
  assert.equal(cards(s, "access_request")[0]?.hostHasCredential, true);

  const approved = await approve(asked.request, { expiresAt: broker.clock.now + 7 * DAY });
  assert.equal(approved.status, 200);
  // Server truth: the state at the rev the route answered no longer holds the card.
  assert.ok((approved.body as { rev: number }).rev <= s.app.stream.rev());
  assert.deepEqual(cards(s, "access_request"), []);
  assert.equal((await broker.call(items, { caller: "web-dev" })).status, 200);

  const other = await s.tool("web-dev", "access", { ...wish, paths: ["/v1/orders"] });
  assert.equal((await s.owner("POST", `/api/teams/web/requests/${other.request}/deny`)).status, 200);
  assert.equal((await broker.call(`/${HOST}/v1/orders`, { caller: "web-dev" })).status, 403);

  const stock = { host: HOST, methods: ["GET"], paths: ["/v1/stock"], expiresAt: broker.clock.now + 1000 };
  const granted = await s.owner("POST", "/api/teams/web/grants", stock);
  assert.match(String((granted.body as { id: string }).id), /^g_/);
  assert.equal((await broker.call(`/${HOST}/v1/stock`, { caller: "web-dev" })).status, 200);
  broker.clock.now += 1001;
  assert.equal((await broker.call(`/${HOST}/v1/stock`, { caller: "web-dev" })).status, 403);

  assert.equal((await broker.call(items, { caller: "notes-lead" })).status, 403);

  // Both decisions ride along with the next message the agent receives.
  await s.owner("POST", "/api/teams/web/threads", { body: "Carry on.", to: "dev" });
  await until(() => pending(s.a12s, "web-dev").length > 0);
  const delivered = pending(s.a12s, "web-dev")[0]?.body ?? "";
  assert.match(delivered, /- system: Access approved: GET api\.example\.com \/v1\/items, until 2030-01-08T/);
  assert.match(delivered, /- system: Access denied: GET api\.example\.com \/v1\/orders\./);
});

test("access list: live grants and pending requests of the caller's team only", async (t) => {
  const { broker, s } = await withBroker(t);
  await broker.credential("web");
  await broker.grant("web", { paths: ["/v1/items/**"] });
  const revoked = await broker.grant("web", { paths: ["/v1/old"] });
  await broker.admin("DELETE", `/teams/web/grants/${revoked.id}`);
  const asked = await s.tool("web-dev", "access", wish);

  assert.deepEqual(await s.tool("web-lead", "access", { action: "list" }), {
    grants: [{ host: HOST, methods: ["GET"], paths: ["/v1/items/**"], expires: null }],
    pending: [{ id: asked.request, host: HOST, methods: ["GET"], paths: ["/v1/items"] }],
  });
  assert.deepEqual(await s.tool("notes-lead", "access", { action: "list" }), { grants: [], pending: [] });
});

test("access accepts no team, agent or unknown field, and a request needs its four fields", async (t) => {
  const { broker, s } = await withBroker(t);
  for (const args of [
    { action: "list", team: "notes" },
    { ...wish, team: "notes" },
    { ...wish, agentId: "notes-lead" },
    { ...wish, agent: "lead" },
    { ...wish, from: "lead" },
    { action: "request", host: HOST, methods: ["GET"], paths: ["/v1/items"] },
    { action: "list", host: HOST },
    { ...wish, methods: ["HEAD"] },
    { ...wish, days: 366 },
  ]) {
    const answer = await s.tool("web-dev", "access", args);
    assert.ok(answer.error, `accepted ${JSON.stringify(args)}`);
  }
  const bad = await s.tool("web-dev", "access", { ...wish, paths: ["/v1/**/items"] });
  assert.deepEqual([bad.error?.code, typeof bad.error?.fix], ["invalid", "string"]);
  const { body } = await broker.admin<AccessView>("GET", "/teams/web/access");
  const notes = await broker.admin<AccessView>("GET", "/teams/notes/access");
  assert.deepEqual([body.requests, notes.body.requests], [[], []]);
});

test("a team's request cannot be decided through another team's URL", async (t) => {
  const { broker, s } = await withBroker(t);
  await broker.credential("web");
  await broker.credential("notes");
  const asked = await s.tool("web-dev", "access", wish);
  for (const decision of ["approve", "deny"]) {
    const answer = await s.owner("POST", `/api/teams/notes/requests/${asked.request}/${decision}`, {});
    assert.deepEqual([answer.status, (answer.body as { code: string }).code], [404, "not_found"]);
  }
  const missing = await s.owner("POST", `/api/teams/nobody/requests/${asked.request}/approve`, {});
  assert.equal(missing.status, 404);
  const { body } = await broker.admin<AccessView>("GET", "/teams/web/access");
  assert.deepEqual([body.requests[0]?.status, body.grants], ["pending", []]);
  assert.equal(cards(s, "access_request").length, 1);
});

test("the agent listener serves no owner or broker route", async (t) => {
  const { broker, s } = await withBroker(t);
  const asked = await s.tool("web-dev", "access", wish);
  for (const [method, path, body] of [
    ["POST", `/api/teams/web/requests/${asked.request}/approve`, {}],
    ["POST", `/teams/web/requests/${asked.request}/approve`, {}],
    ["PUT", `/api/teams/web/credentials/${HOST}`, { scheme: "bearer", secret: SECRET }],
    ["PUT", `/teams/web/credentials/${HOST}`, { scheme: "bearer", secret: SECRET }],
    ["POST", "/api/teams/web/grants", { host: HOST, methods: ["GET"], paths: ["/**"] }],
    ["GET", "/api/teams/web/access", undefined],
  ] as const) {
    assert.equal((await s.raw(["web-dev"], method, path, body)).status, 404, `${method} ${path}`);
  }
  const { body } = await broker.admin<AccessView>("GET", "/teams/web/access");
  assert.deepEqual([body.credentials, body.grants, body.requests[0]?.status], [[], [], "pending"]);
});

test("the owner's access routes relay the broker's answers and refusals", async (t) => {
  const { broker, s } = await withBroker(t);
  const github = { scheme: "basic", username: "x-access-token", secret: SECRET };
  assert.equal((await s.owner("PUT", "/api/teams/web/credentials/git.example.com", github)).status, 200);
  const grant = await s.owner("POST", "/api/teams/web/grants", { host: HOST, methods: ["GET"], paths: ["/v1/**"] });
  const grantId = (grant.body as { id: string }).id;

  const access = (await s.owner("GET", "/api/teams/web/access")).body as AccessView;
  assert.deepEqual(
    access.credentials.map((c) => [c.host, c.scheme, c.username]),
    [["git.example.com", "basic", "x-access-token"]],
  );
  assert.deepEqual(
    access.grants.map((g) => [g.id, g.paths]),
    [[grantId, ["/v1/**"]]],
  );

  assert.equal((await s.owner("DELETE", `/api/teams/web/grants/${grantId}`)).status, 200);
  assert.equal((await s.owner("DELETE", "/api/teams/web/credentials/git.example.com")).status, 200);
  const after = (await s.owner("GET", "/api/teams/web/access")).body as AccessView;
  assert.deepEqual([after.credentials, after.grants[0]?.revokedAt], [[], broker.clock.now]);

  const refusals: [string, string, unknown, number, string][] = [
    ["DELETE", `/api/teams/web/grants/${grantId}`, undefined, 404, "not_found"],
    ["DELETE", "/api/teams/notes/credentials/git.example.com", undefined, 404, "not_found"],
    ["POST", "/api/teams/web/grants", { host: "127.0.0.1", methods: ["GET"], paths: ["/x"] }, 400, "invalid"],
    [
      "POST",
      "/api/teams/web/grants",
      { host: HOST, methods: ["GET"], paths: ["/x"], team: "notes" },
      400,
      "bad_request",
    ],
    ["PUT", `/api/teams/web/credentials/${HOST}`, { scheme: "token", secret: SECRET }, 400, "bad_request"],
    ["GET", "/api/teams/nobody/access", undefined, 404, "not_found"],
  ];
  for (const [method, path, body, status, code] of refusals) {
    const answer = await s.owner(method, path, body);
    assert.deepEqual([answer.status, (answer.body as { code: string }).code], [status, code], `${method} ${path}`);
  }

  const audit = (await s.owner("GET", "/api/teams/web/audit")).body as AuditPage;
  assert.deepEqual(
    audit.entries.map((e) => e.action),
    ["credential.delete", "grant.revoke", "grant.create", "credential.set"],
  );
  const older = (await s.owner("GET", `/api/teams/web/audit?before=${audit.entries[1]?.id}`)).body as AuditPage;
  assert.deepEqual(
    older.entries.map((e) => e.action),
    ["grant.create", "credential.set"],
  );
});

test("a stored secret appears in no app log line, response or state", async (t) => {
  const { broker, s } = await withBroker(t);
  const logged: string[] = [];
  for (const method of ["log", "error", "warn", "info", "debug"] as const) {
    t.mock.method(console, method, (...args: unknown[]) => logged.push(args.map(String).join(" ")));
  }
  const answers: unknown[] = [];
  const owner = async (method: string, path: string, body?: unknown) => {
    const answer = await s.owner(method, path, body);
    answers.push(answer.status, answer.body);
    return answer;
  };
  await owner("PUT", `/api/teams/web/credentials/${HOST}`, { scheme: "bearer", secret: SECRET });
  await owner("PUT", "/api/teams/web/credentials/localhost", { scheme: "bearer", secret: SECRET });
  await owner("PUT", `/api/teams/web/credentials/${HOST}`, { scheme: "bearer", secret: `${SECRET}\nsecond line` });
  await owner("PUT", `/api/teams/web/credentials/${HOST}`, { scheme: "basic", secret: SECRET });
  await owner("PUT", `/api/teams/web/credentials/${HOST}`, { scheme: "bearer", secret: SECRET, extra: SECRET });
  await owner("PUT", `/api/teams/nobody/credentials/${HOST}`, { scheme: "bearer", secret: SECRET });
  await owner("GET", "/api/teams/web/access");
  await owner("GET", "/api/teams/web/audit");
  await broker.grant("web");
  await broker.call(`/${HOST}/v1/items`, { caller: "web-dev" });
  answers.push(await s.tool("web-dev", "access", { action: "list" }));
  answers.push(deriveState(s.app, null));

  const output = JSON.stringify([answers, logged]);
  assert.ok(output.includes("api.example.com"), "the test should have seen the host");
  assert.equal(output.includes(SECRET), false);
});

test("deleting a team purges it in the broker first; a purge that fails leaves the team in place", async (t) => {
  const down = await studio({ broker: join(mkdtempSync(join(tmpdir(), "no-broker-")), "admin.sock") });
  t.after(() => down.close());
  t.mock.method(console, "error", () => {});
  await down.twoTeams();
  await assert.rejects(down.app.teams.deleteTeam("web"), { code: "broker_down" });
  assert.ok(down.app.repo.forTeam("web").team());
  assert.deepEqual(
    [...down.a12s.agents.keys()].filter((name) => name.startsWith("web-")),
    ["web-lead", "web-dev"],
  );

  const { broker, s } = await withBroker(t);
  await broker.credential("web");
  await broker.grant("web");
  await s.tool("web-dev", "access", wish);
  await s.app.teams.deleteTeam("web");
  assert.equal(s.app.repo.forTeam("web").team(), undefined);
  assert.deepEqual((await broker.admin("GET", "/teams/web/access")).body, {
    credentials: [],
    grants: [],
    requests: [],
  });
  assert.equal((await broker.call(`/${HOST}/v1/items`, { caller: "web-dev" })).status, 403);
});
