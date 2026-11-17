import assert from "node:assert/strict";
import { test } from "node:test";
import type { Grant } from "@a12s-studio/contract/broker-admin";
import { activeGrants, expiresAt, expiryText, type Lifetime, lifetimeLabel, lifetimes } from "./grants.ts";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const now = new Date(2026, 10, 16, 15, 0).getTime();

test("lifetimes offer the usual days, the agent's wish in order, and no expiry last", () => {
  const rows: [Lifetime, Lifetime[]][] = [
    [null, [1, 7, 30, 90, null]],
    [7, [1, 7, 30, 90, null]],
    [3, [1, 3, 7, 30, 90, null]],
    [365, [1, 7, 30, 90, 365, null]],
  ];
  for (const [wanted, offered] of rows) assert.deepEqual(lifetimes(wanted), offered, String(wanted));
});

test("lifetimeLabel names a lifetime", () => {
  const rows: [Lifetime, string][] = [
    [1, "1 day"],
    [7, "7 days"],
    [null, "No expiry"],
  ];
  for (const [days, label] of rows) assert.equal(lifetimeLabel(days), label);
});

test("expiresAt counts whole days from now, and no expiry sends none", () => {
  assert.equal(expiresAt(7, now), now + 7 * DAY);
  assert.equal(expiresAt(null, now), undefined);
});

test("expiryText says how long a grant has left", () => {
  const rows: [number | null, string][] = [
    [null, "No expiry"],
    [now - 1, "Expired"],
    [now, "Expired"],
    [now + 2 * HOUR, "Expires in under a day"],
    [now + DAY, "Expires in 1 day"],
    [now + DAY + 11 * HOUR, "Expires in 1 day"],
    [now + 2 * DAY + 13 * HOUR, "Expires in 3 days"],
    [now + 7 * DAY - 1000, "Expires in 7 days"],
    [now + 90 * DAY, "Expires in 90 days"],
  ];
  for (const [at, text] of rows) assert.equal(expiryText(at, now), text, String(at && at - now));
});

test("activeGrants keeps only grants the broker still honours", () => {
  const grant = (id: string, change: Partial<Grant>): Grant => ({
    id: `g_${id}`,
    host: "api.example.com",
    methods: ["GET"],
    paths: ["/v1/**"],
    expiresAt: null,
    requestId: null,
    createdAt: now - DAY,
    warnedAt: null,
    revokedAt: null,
    expiredAt: null,
    ...change,
  });
  const grants = [
    grant("open", {}),
    grant("later", { expiresAt: now + DAY }),
    grant("revoked", { revokedAt: now - HOUR }),
    grant("swept", { expiresAt: now - HOUR, expiredAt: now - 1 }),
    grant("unswept", { expiresAt: now - 1 }),
    grant("now", { expiresAt: now }),
  ];
  assert.deepEqual(
    activeGrants(grants, now).map((g) => g.id),
    ["g_open", "g_later"],
  );
});
