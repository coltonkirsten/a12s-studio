import assert from "node:assert/strict";
import { statSync } from "node:fs";
import { test } from "node:test";
import type {
  AccessRequest,
  AccessView,
  Attention,
  AuditPage,
  CredentialView,
  Grant,
} from "@a12s-studio/contract/broker-admin";
import { HOST, SECRET, startBroker } from "./harness.ts";

const DAY = 24 * 60 * 60 * 1000;
const wish = { agentId: "web-dev", host: HOST, methods: ["GET"], paths: ["/v1/items"], reason: "To list the items." };

test("the admin socket is readable and writable by the owner only", async (t) => {
  const broker = await startBroker(t);
  assert.equal(statSync(broker.socketPath).mode & 0o777, 0o600);
  assert.deepEqual((await broker.admin("GET", "/health")).body, { ok: true });
});

test("a credential is listed by what it is, never by its value", async (t) => {
  const broker = await startBroker(t);
  const body = { scheme: "basic", username: "x-access-token", secret: SECRET };
  const stored = await broker.admin<CredentialView>("PUT", "/teams/web/credentials/git.example.com", body);
  const view = {
    host: "git.example.com",
    scheme: "basic",
    username: "x-access-token",
    headerName: null,
    createdAt: broker.clock.now,
    updatedAt: broker.clock.now,
    rejectedAt: null,
  };
  assert.deepEqual(stored.body, view);

  broker.clock.now += 5;
  await broker.credential("web", "git.example.com", { scheme: "header", headerName: "X-Api-Key" });
  const { body: access } = await broker.admin<AccessView>("GET", "/teams/web/access");
  const replaced = { ...view, scheme: "header", username: null, headerName: "X-Api-Key", updatedAt: broker.clock.now };
  assert.deepEqual(access, { credentials: [replaced], grants: [], requests: [] });
});

test("bad input is refused with a 400 and changes nothing", async (t) => {
  const broker = await startBroker(t);
  const grant = { host: HOST, methods: ["GET"], paths: ["/v1/items"] };
  const refused: [method: string, path: string, body?: unknown][] = [
    ["PUT", `/teams/web/credentials/${HOST}`, { scheme: "token", secret: SECRET }],
    ["PUT", `/teams/web/credentials/${HOST}`, { scheme: "bearer" }],
    ["PUT", `/teams/web/credentials/${HOST}`, { scheme: "bearer", secret: "" }],
    ["PUT", `/teams/web/credentials/${HOST}`, { scheme: "bearer", secret: "two\r\nlines" }],
    ["PUT", `/teams/web/credentials/${HOST}`, { scheme: "basic", secret: SECRET }],
    ["PUT", `/teams/web/credentials/${HOST}`, { scheme: "basic", username: "a:b", secret: SECRET }],
    ["PUT", `/teams/web/credentials/${HOST}`, { scheme: "header", secret: SECRET }],
    ["PUT", `/teams/web/credentials/${HOST}`, { scheme: "header", headerName: "X Key:", secret: SECRET }],
    ["PUT", `/teams/web/credentials/${HOST}`, "not json"],
    ["PUT", `/teams/web/credentials/${HOST}`, [1]],
    ["PUT", `/teams/web/credentials/${HOST}`],
    ["PUT", "/teams/web/credentials/localhost", { scheme: "bearer", secret: SECRET }],
    ["PUT", `/teams/Web/credentials/${HOST}`, { scheme: "bearer", secret: SECRET }],
    ["PUT", `/teams/web-dev/credentials/${HOST}`, { scheme: "bearer", secret: SECRET }],
    ["POST", "/teams/web/grants", { ...grant, host: "127.0.0.1" }],
    ["POST", "/teams/web/grants", { ...grant, host: `https://${HOST}` }],
    ["POST", "/teams/web/grants", { ...grant, methods: [] }],
    ["POST", "/teams/web/grants", { ...grant, methods: ["get"] }],
    ["POST", "/teams/web/grants", { ...grant, methods: ["HEAD"] }],
    ["POST", "/teams/web/grants", { ...grant, methods: "GET" }],
    ["POST", "/teams/web/grants", { ...grant, paths: [] }],
    ["POST", "/teams/web/grants", { ...grant, paths: ["v1/items"] }],
    ["POST", "/teams/web/grants", { ...grant, paths: ["/v1/**/items"] }],
    ["POST", "/teams/web/grants", { ...grant, paths: ["/v1/item*"] }],
    ["POST", "/teams/web/grants", { ...grant, paths: ["/v1/../items"] }],
    ["POST", "/teams/web/grants", { ...grant, paths: ["/v1/items", 7] }],
    ["POST", "/teams/web/grants", { ...grant, expiresAt: broker.clock.now }],
    ["POST", "/teams/web/grants", { ...grant, expiresAt: "tomorrow" }],
    ["POST", "/teams/web/requests", { ...wish, agentId: "ops-bot" }],
    ["POST", "/teams/web/requests", { ...wish, agentId: "web" }],
    ["POST", "/teams/web/requests", { ...wish, reason: "" }],
    ["POST", "/teams/web/requests", { ...wish, reason: "x".repeat(1001) }],
    ["POST", "/teams/web/requests", { ...wish, days: 0 }],
    ["POST", "/teams/web/requests", { ...wish, days: 1.5 }],
    ["POST", "/teams/web/requests", { ...wish, paths: ["/**/x"] }],
    ["GET", "/teams/web/audit?limit=0"],
    ["GET", "/teams/web/audit?limit=201"],
    ["GET", "/teams/web/audit?before=x"],
  ];
  for (const [method, path, body] of refused) {
    const result = await broker.admin<{ code: string }>(method, path, body);
    assert.deepEqual([result.status, result.body.code], [400, "invalid"], `${method} ${path} ${JSON.stringify(body)}`);
  }
  assert.deepEqual((await broker.admin("GET", "/teams/web/access")).body, {
    credentials: [],
    grants: [],
    requests: [],
  });
  assert.deepEqual(broker.auditAfter(0), []);
});

test("an unknown route, id or another team's id is a 404", async (t) => {
  const broker = await startBroker(t);
  await broker.credential("ops");
  const grant = await broker.grant("ops");
  const request = await broker.admin<AccessRequest>("POST", "/teams/ops/requests", { ...wish, agentId: "ops-bot" });
  const before = broker.auditAfter(0).length;

  const missing: [method: string, path: string][] = [
    ["GET", "/"],
    ["GET", "/teams/web"],
    ["POST", "/health"],
    ["DELETE", `/teams/web/credentials/${HOST}`],
    ["DELETE", `/teams/web/grants/${grant.id}`],
    ["DELETE", "/teams/ops/grants/g_000000000000"],
    ["POST", `/teams/web/requests/${request.body.id}/approve`],
    ["POST", `/teams/web/requests/${request.body.id}/deny`],
    ["POST", "/grants/g_000000000000/warned"],
  ];
  for (const [method, path] of missing) {
    const result = await broker.admin<{ code: string }>(method, path);
    assert.deepEqual([result.status, result.body.code], [404, "not_found"], `${method} ${path}`);
  }
  const { body } = await broker.admin<AccessView>("GET", "/teams/ops/access");
  assert.deepEqual([body.grants[0]?.revokedAt, body.requests[0]?.status], [null, "pending"]);
  assert.equal(broker.auditAfter(0).length, before);
});

test("every change writes one audit row, by the owner except for an agent's request", async (t) => {
  const broker = await startBroker(t);
  const rows = () => broker.auditAfter(0).map((row) => [row.teamId, row.actor, row.action, row.agentId, row.detail]);

  await broker.credential("web");
  const grant = await broker.grant("web");
  const first = await broker.admin<AccessRequest>("POST", "/teams/web/requests", wish);
  const second = await broker.admin<AccessRequest>("POST", "/teams/web/requests", { ...wish, days: 7 });
  await broker.admin("POST", `/teams/web/requests/${first.body.id}/approve`, { expiresAt: broker.clock.now + DAY });
  await broker.admin("POST", `/teams/web/requests/${second.body.id}/deny`);
  await broker.admin("POST", `/grants/${grant.id}/warned`);
  await broker.admin("DELETE", `/teams/web/grants/${grant.id}`);
  await broker.admin("DELETE", `/teams/web/credentials/${HOST}`);
  await broker.admin("DELETE", "/teams/web");

  assert.deepEqual(rows(), [
    ["web", "owner", "credential.set", null, "bearer"],
    ["web", "owner", "grant.create", null, null],
    ["web", "agent", "request.create", "web-dev", first.body.id],
    ["web", "agent", "request.create", "web-dev", second.body.id],
    ["web", "owner", "request.approve", "web-dev", null],
    ["web", "owner", "request.deny", "web-dev", null],
    ["web", "owner", "grant.revoke", null, null],
    ["web", "owner", "credential.delete", null, "grants revoked: 1"],
    ["web", "owner", "team.purge", null, "credentials: 0, grants: 2, requests: 2"],
  ]);
});

test("approving creates a grant from the request with the owner's expiry; a request is decided once", async (t) => {
  const broker = await startBroker(t);
  await broker.credential("web");
  const asked = await broker.admin<AccessRequest>("POST", "/teams/web/requests", { ...wish, days: 7 });
  const decide = (decision: string, body?: unknown) =>
    broker.admin<AccessRequest & { code?: string }>("POST", `/teams/web/requests/${asked.body.id}/${decision}`, body);
  assert.deepEqual(asked.body, {
    id: asked.body.id,
    agentId: "web-dev",
    host: HOST,
    methods: ["GET"],
    paths: ["/v1/items"],
    reason: "To list the items.",
    days: 7,
    status: "pending",
    createdAt: broker.clock.now,
    decidedAt: null,
  });

  const expiresAt = broker.clock.now + 7 * DAY;
  const approved = await decide("approve", { expiresAt });
  assert.deepEqual(approved.body, { ...asked.body, status: "approved", decidedAt: broker.clock.now });
  const { body } = await broker.admin<AccessView>("GET", "/teams/web/access");
  assert.deepEqual(
    body.grants.map((g) => [g.host, g.methods, g.paths, g.expiresAt, g.requestId]),
    [[HOST, ["GET"], ["/v1/items"], expiresAt, asked.body.id]],
  );

  for (const decision of ["approve", "deny"]) {
    const again = await decide(decision);
    assert.deepEqual([again.status, again.body.code], [409, "already_decided"]);
  }
  assert.equal((await broker.admin<AccessView>("GET", "/teams/web/access")).body.grants.length, 1);
});

test("approving for a host without a credential is refused with a fix that names the host", async (t) => {
  const broker = await startBroker(t);
  const asked = await broker.admin<AccessRequest>("POST", "/teams/web/requests", wish);

  const refused = await broker.admin<{ code: string; fix: string }>(
    "POST",
    `/teams/web/requests/${asked.body.id}/approve`,
  );
  assert.deepEqual([refused.status, refused.body.code], [409, "no_credential"]);
  assert.match(refused.body.fix, new RegExp(`Add a credential for ${HOST}`));
  const { body } = await broker.admin<AccessView>("GET", "/teams/web/access");
  assert.deepEqual([body.requests[0]?.status, body.grants], ["pending", []]);

  await broker.credential("web");
  assert.equal((await broker.admin("POST", `/teams/web/requests/${asked.body.id}/approve`)).status, 200);
});

test("attention lists pending requests and the grants that expire within three days, warned or not", async (t) => {
  const broker = await startBroker(t);
  const { now } = broker.clock;
  await broker.credential("web");
  await broker.credential("ops");
  const soon = await broker.grant("web", { expiresAt: now + 3 * DAY });
  const later = await broker.grant("web", { expiresAt: now + 3 * DAY + 1 });
  await broker.grant("web");
  const revoked = await broker.grant("ops", { expiresAt: now + DAY });
  await broker.admin("DELETE", `/teams/ops/grants/${revoked.id}`);
  const sooner = await broker.grant("ops", { expiresAt: now + DAY });
  const pending = await broker.admin<AccessRequest>("POST", "/teams/web/requests", wish);
  const decided = await broker.admin<AccessRequest>("POST", "/teams/web/requests", wish);
  await broker.admin("POST", `/teams/web/requests/${decided.body.id}/deny`);

  const attention = async () => {
    const { body } = await broker.admin<Attention>("GET", "/attention");
    return {
      requests: body.requests.map((r) => [r.teamId, r.id]),
      expiring: body.expiring.map((g) => [g.teamId, g.id]),
      rejected: body.rejected.map((c) => [c.teamId, c.host]),
    };
  };
  const expected = {
    requests: [["web", pending.body.id]],
    expiring: [
      ["ops", sooner.id],
      ["web", soon.id],
    ],
    rejected: [],
  };
  assert.deepEqual(await attention(), expected);

  assert.equal((await broker.admin("POST", `/grants/${sooner.id}/warned`)).status, 204);
  assert.deepEqual(await attention(), expected);
  const { body } = await broker.admin<Attention>("GET", "/attention");
  assert.deepEqual(
    body.expiring.map((g: Grant) => [g.id, g.warnedAt]),
    [
      [sooner.id, now],
      [soon.id, null],
    ],
  );

  // Time moves one grant out of the window (it has run out) and the next one in.
  broker.clock.now = now + 3 * DAY;
  expected.expiring = [["web", later.id]];
  assert.deepEqual(await attention(), expected);
});

test("a team has at most ten pending requests; a decision makes room for another", async (t) => {
  const broker = await startBroker(t);
  const ask = (team = "web") =>
    broker.admin<AccessRequest & { code?: string; fix?: string }>("POST", `/teams/${team}/requests`, {
      ...wish,
      agentId: `${team}-dev`,
    });
  const first = await ask();
  for (let i = 1; i < 10; i++) assert.equal((await ask()).status, 200);
  const before = broker.auditAfter(0).length;

  const refused = await ask();
  assert.deepEqual([refused.status, refused.body.code], [409, "too_many_pending"]);
  assert.match(refused.body.fix ?? "", /Wait for the owner to decide/);
  assert.equal(broker.auditAfter(0).length, before);
  assert.equal((await ask("ops")).status, 200);

  await broker.admin("POST", `/teams/web/requests/${first.body.id}/deny`);
  assert.equal((await ask()).status, 200);
  assert.equal((await ask()).status, 409);
});

test("the audit log is paged newest first and shows one team only", async (t) => {
  const broker = await startBroker(t);
  await broker.credential("ops");
  for (let i = 0; i < 5; i++) await broker.call(`/${HOST}/v1/items/${i}`);
  const page = async (query: string) => {
    const { body } = await broker.admin<AuditPage>("GET", `/teams/web/audit${query}`);
    return { paths: body.entries.map((entry) => entry.path), last: body.entries.at(-1)?.id, hasMore: body.hasMore };
  };

  const first = await page("?limit=2");
  assert.deepEqual([first.paths, first.hasMore], [["/v1/items/4", "/v1/items/3"], true]);
  const second = await page(`?limit=2&before=${first.last}`);
  assert.deepEqual([second.paths, second.hasMore], [["/v1/items/2", "/v1/items/1"], true]);
  const third = await page(`?limit=2&before=${second.last}`);
  assert.deepEqual([third.paths, third.hasMore], [["/v1/items/0"], false]);
  assert.equal((await page("")).paths.length, 5);

  const { body } = await broker.admin<AuditPage>("GET", "/teams/web/audit?limit=1");
  assert.deepEqual(body.entries[0], {
    id: body.entries[0]?.id,
    at: broker.clock.now,
    agentId: "web-dev",
    actor: "agent",
    action: "deny",
    host: HOST,
    method: "GET",
    path: "/v1/items/4",
    status: 403,
    grantId: null,
    detail: "no_access",
  });
});

test("purging a team removes its credentials, grants and requests, keeps its audit rows and spares other teams", async (t) => {
  const broker = await startBroker(t);
  for (const team of ["web", "ops"]) {
    await broker.credential(team);
    await broker.grant(team);
    await broker.admin("POST", `/teams/${team}/requests`, { ...wish, agentId: `${team}-bot` });
  }
  const before = (await broker.admin<AuditPage>("GET", "/teams/web/audit")).body.entries.length;

  assert.equal((await broker.admin("DELETE", "/teams/web")).status, 204);
  assert.deepEqual((await broker.admin("GET", "/teams/web/access")).body, {
    credentials: [],
    grants: [],
    requests: [],
  });
  assert.equal((await broker.call(`/${HOST}/v1/items`, { caller: "web-bot" })).status, 403);
  assert.equal((await broker.call(`/${HOST}/v1/items`, { caller: "ops-bot" })).status, 200);
  const after = (await broker.admin<AuditPage>("GET", "/teams/web/audit")).body.entries;
  assert.equal(after.length, before + 2);
  assert.deepEqual(
    (await broker.admin<Attention>("GET", "/attention")).body.requests.map((r) => r.teamId),
    ["ops"],
  );
});

test("a change that fails part-way leaves nothing behind", async (t) => {
  const broker = await startBroker(t);
  t.mock.method(console, "error", () => {});
  await broker.credential("web");
  const asked = await broker.admin<AccessRequest>("POST", "/teams/web/requests", wish);
  const before = broker.auditAfter(0).length;
  broker.db.exec("CREATE TRIGGER audit_fails BEFORE INSERT ON audit BEGIN SELECT RAISE(ABORT, 'no audit'); END");

  const changes: [method: string, path: string, body?: unknown][] = [
    ["PUT", "/teams/web/credentials/git.example.com", { scheme: "bearer", secret: SECRET }],
    ["POST", "/teams/web/grants", { host: HOST, methods: ["GET"], paths: ["/v1/items"] }],
    ["POST", `/teams/web/requests/${asked.body.id}/approve`],
    ["DELETE", `/teams/web/credentials/${HOST}`],
    ["DELETE", "/teams/web"],
  ];
  for (const [method, path, body] of changes) {
    assert.equal((await broker.admin(method, path, body)).status, 500, `${method} ${path}`);
  }
  const { body } = await broker.admin<AccessView>("GET", "/teams/web/access");
  assert.deepEqual(
    [body.credentials.map((c) => c.host), body.grants, body.requests.map((r) => r.status)],
    [[HOST], [], ["pending"]],
  );
  assert.equal(broker.auditAfter(0).length, before);
});
