import assert from "node:assert/strict";
import { test } from "node:test";
import { format } from "node:util";
import type { AccessRequest, AccessView, Attention } from "@a12s-studio/contract/broker-admin";
import { type Broker, HOST, type Reply, reply, SECRET, startBroker } from "./harness.ts";

const ITEMS = `/${HOST}/v1/items`;

function refused(result: Reply, status: number, code: string): void {
  assert.equal(result.status, status);
  assert.equal(JSON.parse(result.body).code, code);
  assert.deepEqual(
    result.audit.map((row) => [row.action, row.status, row.detail]),
    [["deny", status, code]],
  );
}

function forwarded(result: Reply, status = 200): void {
  assert.equal(result.status, status);
  assert.deepEqual(
    result.audit.map((row) => [row.action, row.status]),
    [["call", status]],
  );
}

function untouched(broker: Broker): void {
  assert.deepEqual(broker.agent.dialed, []);
  assert.deepEqual(broker.upstream.seen, []);
}

test("invariant 1: no caller header is refused and no upstream connection is made", async (t) => {
  const broker = await startBroker(t);
  await broker.credential("web");
  await broker.grant("web");

  refused(await broker.call(ITEMS, { caller: null }), 403, "no_caller");
  untouched(broker);
});

test("invariant 2: two caller headers, or one that is not <team>-<agent> shaped, are refused", async (t) => {
  const broker = await startBroker(t);
  await broker.credential("web");
  await broker.grant("web");

  const callers = [
    ["web-dev", "web-dev"],
    "web",
    "web-",
    "-dev",
    "w-dev",
    "Web-dev",
    "web_dev",
    "web-dev, web-dev",
    "",
  ];
  for (const caller of callers) {
    refused(await broker.call(ITEMS, { caller }), 403, "no_caller");
  }
  untouched(broker);
});

test("invariant 3: a host with no credential for the caller's team is refused, even if another team has one", async (t) => {
  const broker = await startBroker(t);
  await broker.credential("ops");
  await broker.grant("ops");
  await broker.grant("web");

  refused(await broker.call(ITEMS, { caller: "web-dev" }), 403, "no_access");
  untouched(broker);
});

test("invariant 4: a credential without a grant is refused", async (t) => {
  const broker = await startBroker(t);
  await broker.credential("web");

  refused(await broker.call(ITEMS), 403, "no_access");
  untouched(broker);
});

test("invariant 5: another team's grant for the same host, method and path gives nothing", async (t) => {
  const broker = await startBroker(t);
  await broker.credential("web");
  await broker.credential("ops");
  await broker.grant("ops");

  refused(await broker.call(ITEMS, { caller: "web-dev" }), 403, "no_access");
  untouched(broker);
  forwarded(await broker.call(ITEMS, { caller: "ops-bot" }));
});

test("invariant 6: a grant for another method is refused, and HEAD is allowed by a GET grant", async (t) => {
  const broker = await startBroker(t);
  await broker.credential("web");
  await broker.grant("web", { methods: ["GET"] });

  for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
    refused(await broker.call(ITEMS, { method }), 403, "no_access");
  }
  untouched(broker);
  forwarded(await broker.call(ITEMS, { method: "HEAD" }));
  assert.equal(broker.upstream.seen[0]?.method, "HEAD");
});

test("invariant 7: a grant whose pattern does not cover the path is refused, look-alike prefixes included", async (t) => {
  const broker = await startBroker(t);
  await broker.credential("web");
  await broker.grant("web", { paths: ["/repos/a/b", "/orgs/*/members", "/teams/a/**"] });

  const outside = [
    ...["/repos/a/bc", "/repos/a/b/c", "/repos/a/b/", "/repos/a", "/repos/A/b", "/repos/a/b%20"],
    ...["/orgs/members", "/orgs/a/b/members", "/orgs//members", "/orgs/a/members/x"],
    ...["/teams/ab", "/teams", "/"],
  ];
  for (const path of outside) {
    const result = await broker.call(`/${HOST}${path}`);
    assert.equal(result.status === 403 || result.status === 400, true, path);
  }
  untouched(broker);
  for (const path of ["/repos/a/b", "/orgs/a/members", "/teams/a", "/teams/a/b/c"]) {
    forwarded(await broker.call(`/${HOST}${path}`));
  }
});

test("invariant 8: an expired grant is refused from the first call after expires_at, before any sweep", async (t) => {
  const broker = await startBroker(t);
  await broker.credential("web");
  const grant = await broker.grant("web", { expiresAt: broker.clock.now + 1000 });

  broker.clock.now += 999;
  forwarded(await broker.call(ITEMS));
  broker.clock.now += 1;
  refused(await broker.call(ITEMS), 403, "no_access");
  const { body } = await broker.admin<AccessView>("GET", "/teams/web/access");
  assert.deepEqual(
    body.grants.map((g) => [g.id, g.expiredAt]),
    [[grant.id, null]],
  );
});

test("invariant 9: a revoked grant is refused on the next call", async (t) => {
  const broker = await startBroker(t);
  await broker.credential("web");
  const grant = await broker.grant("web");

  forwarded(await broker.call(ITEMS));
  assert.equal((await broker.admin("DELETE", `/teams/web/grants/${grant.id}`)).status, 204);
  refused(await broker.call(ITEMS), 403, "no_access");
});

test("invariant 10: approve lets the next call through with no restart; deny leaves it refused", async (t) => {
  const broker = await startBroker(t);
  await broker.credential("web");
  const ask = (path: string) =>
    broker.admin<AccessRequest>("POST", "/teams/web/requests", {
      agentId: "web-dev",
      host: HOST,
      methods: ["GET"],
      paths: [path],
      reason: "To list the items.",
    });
  const wanted = await ask("/v1/items");
  const unwanted = await ask("/v1/admin");
  refused(await broker.call(ITEMS), 403, "no_access");

  const approved = await broker.admin<AccessRequest>("POST", `/teams/web/requests/${wanted.body.id}/approve`);
  assert.equal(approved.body.status, "approved");
  forwarded(await broker.call(ITEMS));

  const denied = await broker.admin<AccessRequest>("POST", `/teams/web/requests/${unwanted.body.id}/deny`);
  assert.equal(denied.body.status, "denied");
  refused(await broker.call(`/${HOST}/v1/admin`), 403, "no_access");
});

test("invariant 11: deleting a credential refuses the next call and revokes the host's grants", async (t) => {
  const broker = await startBroker(t);
  await broker.credential("web");
  await broker.grant("web");
  forwarded(await broker.call(ITEMS));

  assert.equal((await broker.admin("DELETE", `/teams/web/credentials/${HOST}`)).status, 204);
  refused(await broker.call(ITEMS), 403, "no_access");
  const { body } = await broker.admin<AccessView>("GET", "/teams/web/access");
  assert.deepEqual(
    body.grants.map((g) => g.revokedAt),
    [broker.clock.now],
  );
  // A new credential does not bring the old grants back.
  await broker.credential("web");
  refused(await broker.call(ITEMS), 403, "no_access");
});

test("invariant 12: path tricks are refused as bad targets and never forwarded", async (t) => {
  const broker = await startBroker(t);
  await broker.credential("web");
  await broker.grant("web", { paths: ["/**"] });

  const tricks = [
    ...["/v1/../admin", "/v1/..", "/..", "/v1/./items", "/v1/.", "//v1/items", "/v1//items"],
    ...["/v1/%2e%2e/admin", "/v1/%2E%2E/admin", "/v1/.%2e/admin", "/v1%2fitems", "/v1%2Fitems", "/v1%5citems"],
    ...["/v1\\items", "/v1\\..\\admin", "/v1/items#x"],
    ...["/v1/..;/admin", "/v1/..;x=1/admin", "/v1/.;/items", "/v1/..;"],
    ...["/v1/%252e%252e/admin", "/v1%252fitems", "/v1/items%00.png", "/v1/%c0%ae%c0%ae/admin", "/v1%C0%AFitems"],
    ...["/v1/%u002e%u002e/admin", "/v1/items%", "/v1/items%2", "/v1/%zz"],
  ];
  for (const path of tricks) {
    refused(await broker.call(`/${HOST}${path}`), 400, "bad_target");
  }
  refused(await broker.call(`/${HOST}`), 400, "bad_target");
  untouched(broker);
});

test("invariant 13: host tricks are refused as bad targets", async (t) => {
  const broker = await startBroker(t);

  const hosts = [
    ...[`${HOST}:443`, `${HOST}:8443`, `user@${HOST}`, `user:pass@${HOST}`, "API.example.com", `${HOST}.`],
    ...["127.0.0.1", "127.1", "2130706433", "0x7f.0.0.1", "0177.0.0.1", "[::1]", "::1", "10.0.0.1.5"],
    ...["localhost", "app.localhost", "studio.a12s", "broker.a12s", "example", "-api.example.com", "api..example.com"],
    ...["api_internal.example.com", "%61pi.example.com", `${"a".repeat(250)}.com`],
  ];
  for (const host of hosts) {
    refused(await broker.call(`/${host}/v1/items`), 400, "bad_target");
    assert.equal(
      (await broker.admin("PUT", `/teams/web/credentials/${host}`, { scheme: "bearer", secret: SECRET })).status >= 400,
      true,
      host,
    );
  }
  untouched(broker);
});

test("invariant 14: client-sent credentials, identity and overrides never reach upstream; the stored credential does", async (t) => {
  const broker = await startBroker(t);
  const basicHost = "git.example.com";
  const headerHost = "keys.example.com";
  await broker.credential("web");
  await broker.credential("web", basicHost, { scheme: "basic", username: "x-access-token" });
  await broker.credential("web", headerHost, { scheme: "header", headerName: "X-Api-Key" });
  for (const host of [HOST, basicHost, headerHost]) await broker.grant("web", { host });

  const overrides = ["x-http-method-override", "x-http-method", "x-method-override", "x-original-url", "x-rewrite-url"];
  const underscored = ["x_http_method_override", "a12s_caller"];
  const headers = {
    authorization: "Bearer from-the-agent",
    cookie: "session=from-the-agent",
    "proxy-authorization": "Basic from-the-agent",
    "X-Api-Key": "from-the-agent",
    connection: "x-private",
    "x-private": "from-the-agent",
    ...Object.fromEntries([...overrides, ...underscored].map((name) => [name, "from-the-agent"])),
    "x-kept": "kept",
  };
  for (const host of [HOST, basicHost, headerHost]) forwarded(await broker.call(`/${host}/v1/items`, { headers }));

  const [bearer, basic, header] = broker.upstream.seen.map((seen) => seen.headers);
  assert.equal(bearer?.authorization, `Bearer ${SECRET}`);
  assert.equal(basic?.authorization, `Basic ${Buffer.from(`x-access-token:${SECRET}`).toString("base64")}`);
  assert.equal(header?.["x-api-key"], SECRET);
  assert.equal(header?.authorization, undefined);
  assert.deepEqual(broker.agent.dialed, [`${HOST}:443`, `${basicHost}:443`, `${headerHost}:443`]);
  for (const [i, sent] of [bearer, basic, header].entries()) {
    assert.equal(sent?.host, [HOST, basicHost, headerHost][i]);
    assert.equal(sent?.["x-kept"], "kept");
    for (const name of ["cookie", "proxy-authorization", "a12s-caller", "x-private", ...overrides, ...underscored]) {
      assert.equal(sent?.[name], undefined, name);
    }
  }
});

test("invariant 15: the 403 body has code, message and the access fix, the same with and without a credential", async (t) => {
  const broker = await startBroker(t);
  await broker.credential("ops");

  const withoutCredential = await broker.call(ITEMS, { caller: "web-dev" });
  const withoutGrant = await broker.call(ITEMS, { caller: "ops-bot" });
  assert.equal(withoutCredential.status, 403);
  assert.equal(withoutGrant.body, withoutCredential.body);
  assert.deepEqual(withoutGrant.headers["content-type"], withoutCredential.headers["content-type"]);
  assert.deepEqual(JSON.parse(withoutGrant.body), {
    code: "no_access",
    message: `Your team has no grant for GET ${HOST}/v1/items.`,
    fix: 'Use the access tool: action "list" shows what the team can reach, action "request" asks the owner for more.',
  });
});

test("invariant 16: an upstream redirect is returned, not followed", async (t) => {
  const broker = await startBroker(t);
  await broker.credential("web");
  await broker.grant("web");
  const location = "https://elsewhere.example.com/v1/items";
  broker.upstream.handle = reply(302, { location, "set-cookie": ["a=1", "b=2"] });

  const result = await broker.call(ITEMS);
  forwarded(result, 302);
  assert.equal(result.headers.location, location);
  assert.equal(result.headers["set-cookie"], undefined);
  assert.equal(broker.upstream.seen.length, 1);
  assert.deepEqual(broker.agent.dialed, [`${HOST}:443`]);
});

test("invariant 17: an upstream 401 becomes 502 credential_rejected and stamps the credential", async (t) => {
  const broker = await startBroker(t);
  await broker.credential("web");
  await broker.grant("web");
  broker.upstream.handle = reply(401, { "www-authenticate": 'Basic realm="stub"' }, "Bad credentials");

  const result = await broker.call(ITEMS);
  assert.equal(result.status, 502);
  assert.equal(JSON.parse(result.body).code, "credential_rejected");
  assert.equal(result.headers["www-authenticate"], undefined);
  assert.deepEqual(
    result.audit.map((row) => [row.action, row.status, row.host]),
    [["credential.rejected", 401, HOST]],
  );
  const attention = await broker.admin<Attention>("GET", "/attention");
  assert.deepEqual(
    attention.body.rejected.map((c) => [c.teamId, c.host, c.rejectedAt]),
    [["web", HOST, broker.clock.now]],
  );
  // Replacing the credential clears the mark.
  await broker.credential("web");
  assert.deepEqual((await broker.admin<Attention>("GET", "/attention")).body.rejected, []);
});

test("invariant 18: every case leaves exactly one audit row, with no secret, query string or body in it", async (t) => {
  const broker = await startBroker(t);
  const query = "token=query-marker";
  const sent = { method: "POST", body: "body-marker" };
  const items = `${ITEMS}?${query}`;
  await broker.credential("web");
  await broker.credential("qa");
  await broker.grant("ops");
  await broker.grant("web", { methods: ["POST"], expiresAt: broker.clock.now + 1000 });
  const upstreamSays = (status: number) => {
    broker.upstream.handle = reply(status, { location: `https://elsewhere.example.com/?${query}` }, "upstream-body");
    return broker.call(items, sent);
  };
  const afterExpiry = () => {
    broker.clock.now += 1000;
    return broker.call(items, sent);
  };

  const cases: [invariant: number, action: string, status: number, run: () => Promise<Reply>][] = [
    [1, "deny", 403, () => broker.call(items, { ...sent, caller: null })],
    [2, "deny", 403, () => broker.call(items, { ...sent, caller: ["web-dev", "web-dev"] })],
    [3, "deny", 403, () => broker.call(items, { ...sent, caller: "dev-one" })],
    [4, "deny", 403, () => broker.call(items, { ...sent, caller: "qa-bot" })],
    [5, "deny", 403, () => broker.call(items, { ...sent, caller: "qa-bot" })],
    [6, "deny", 403, () => broker.call(items, { ...sent, method: "DELETE" })],
    [7, "deny", 403, () => broker.call(`${ITEMS}-more?${query}`, sent)],
    [12, "deny", 400, () => broker.call(`/${HOST}/v1/../items?${query}`, sent)],
    [13, "deny", 400, () => broker.call(`/user:${SECRET}@${HOST}/v1/items?${query}`, sent)],
    [14, "call", 200, () => upstreamSays(200)],
    [16, "call", 302, () => upstreamSays(302)],
    [17, "credential.rejected", 401, () => upstreamSays(401)],
    [8, "deny", 403, afterExpiry],
    [
      9,
      "deny",
      403,
      async () => {
        const again = await broker.grant("web", { methods: ["POST"] });
        await broker.admin("DELETE", `/teams/web/grants/${again.id}`);
        return broker.call(items, sent);
      },
    ],
    [
      11,
      "deny",
      403,
      async () => {
        await broker.grant("web", { methods: ["POST"] });
        await broker.admin("DELETE", `/teams/web/credentials/${HOST}`);
        return broker.call(items, sent);
      },
    ],
  ];
  for (const [invariant, action, status, run] of cases) {
    const { audit } = await run();
    assert.deepEqual(
      audit.map((row) => [row.action, row.status]),
      [[action, status]],
      `invariant ${invariant}`,
    );
  }
  const everything = JSON.stringify(broker.auditAfter(0));
  for (const marker of [SECRET, "query-marker", "token=", "body-marker", "upstream-body"]) {
    assert.equal(everything.includes(marker), false, marker);
  }
});

test("invariant 19: no admin response, agent response or log line contains a stored secret", async (t) => {
  const broker = await startBroker(t);
  const logged: string[] = [];
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    t.mock.method(console, level, (...args: unknown[]) => logged.push(format(...args)));
  }
  const answered: Reply[] = [];
  const call = async (...args: Parameters<Broker["call"]>) => answered.push(await broker.call(...args));

  await broker.credential("web");
  await broker.credential("web", "git.example.com", { scheme: "basic", username: "x-access-token" });
  await broker.credential("web", "keys.example.com", { scheme: "header", headerName: "x-api-key" });
  await broker.credential("ops");
  const grant = await broker.grant("web", { expiresAt: broker.clock.now + 1000 });
  await broker.grant("web", { host: "git.example.com" });
  await broker.grant("ops");
  const asked = await broker.admin<AccessRequest>("POST", "/teams/web/requests", {
    agentId: "web-dev",
    host: HOST,
    methods: ["POST"],
    paths: ["/v1/items"],
    reason: "To add items.",
  });

  await call(ITEMS);
  await call(`/git.example.com/v1/items`);
  await call(`/${HOST}/v1/other`);
  await call(ITEMS, { caller: null });
  await call(`/user:${SECRET}@${HOST}/v1/items`);
  broker.upstream.handle = reply(401);
  await call(ITEMS);
  broker.upstream.handle = (req) => req.socket.destroy();
  await call(ITEMS);
  // A ciphertext the vault cannot open makes the broker log an error.
  broker.db.exec(
    "UPDATE credentials SET secret_enc = (SELECT secret_enc FROM credentials WHERE team_id = 'web' AND host = 'api.example.com') WHERE team_id = 'ops'",
  );
  await call(ITEMS, { caller: "ops-bot" });
  assert.equal(answered.at(-1)?.status, 500);
  assert.equal(logged.length, 1);

  const credentials = `/teams/web/credentials/${HOST}`;
  await broker.admin("PUT", credentials, { scheme: "bearer", secret: `${SECRET}\nsecond line` });
  await broker.admin("PUT", credentials, { scheme: "basic", secret: SECRET });
  await broker.admin("PUT", credentials, { scheme: "nonsense", secret: SECRET });
  await broker.admin("PUT", credentials, `{"scheme":"bearer","secret":"${SECRET}`);
  await broker.admin("PUT", credentials, [SECRET]);
  await broker.admin("POST", `/teams/web/requests/${asked.body.id}/approve`, { expiresAt: SECRET });
  await broker.admin("POST", `/teams/web/requests/${asked.body.id}/approve`);
  await broker.admin("POST", `/grants/${grant.id}/warned`);
  for (const path of [
    "/health",
    "/teams/web/access",
    "/teams/web/audit?limit=200",
    "/attention",
    "/teams/ops/access",
  ]) {
    assert.equal((await broker.admin("GET", path)).status, 200);
  }
  await broker.admin("DELETE", `/teams/web/grants/${grant.id}`);
  await broker.admin("DELETE", credentials);
  await broker.admin("DELETE", "/teams/web");
  await broker.admin("GET", "/teams/web/audit");

  const output = [...broker.adminOutput, ...logged, ...answered.map((result) => JSON.stringify(result))].join("\n");
  assert.deepEqual(
    answered.map((result) => result.status),
    [200, 200, 403, 403, 400, 502, 502, 500],
  );
  const encodings = [SECRET, Buffer.from(SECRET).toString("base64"), Buffer.from(SECRET).toString("hex")];
  for (const secret of [...encodings, Buffer.from(`x-access-token:${SECRET}`).toString("base64")]) {
    assert.equal(output.includes(secret), false);
  }
});

test("invariant 20: a ciphertext copied to another team's row fails to decrypt", async (t) => {
  const broker = await startBroker(t);
  const errors = t.mock.method(console, "error", () => {});
  await broker.credential("web");
  await broker.credential("ops", HOST, { secret: "the-ops-team-value" });
  await broker.grant("ops");
  forwarded(await broker.call(ITEMS, { caller: "ops-bot" }));

  broker.db.exec(`
    UPDATE credentials SET (nonce, secret_enc) =
      (SELECT nonce, secret_enc FROM credentials WHERE team_id = 'web') WHERE team_id = 'ops'`);
  const result = await broker.call(ITEMS, { caller: "ops-bot" });
  assert.equal(result.status, 500);
  assert.equal(JSON.parse(result.body).code, "internal");
  assert.equal(errors.mock.callCount(), 1);
  assert.equal(broker.upstream.seen.length, 1);
  assert.equal(broker.upstream.seen[0]?.headers.authorization, "Bearer the-ops-team-value");
});

test("invariant 22: a request that did not arrive under the broker's a12s name is refused", async (t) => {
  const broker = await startBroker(t);
  await broker.credential("web");
  await broker.grant("web");

  const hosts = [`127.0.0.1:${broker.port}`, `localhost:${broker.port}`, "rebound.example.com:7420", "broker.a12s"];
  for (const host of hosts) {
    refused(await broker.call(ITEMS, { headers: { host } }), 403, "no_caller");
  }
  untouched(broker);
});
