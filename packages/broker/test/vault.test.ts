import assert from "node:assert/strict";
import { test } from "node:test";
import { createVault } from "../src/vault.ts";

const vault = createVault(Buffer.alloc(32, 1));
const value = "a value worth keeping";

test("a sealed value opens for the same team and host", () => {
  assert.equal(vault.open("web", "api.example.com", vault.seal("web", "api.example.com", value)), value);
});

test("a sealed value does not open for another team, another host or another key", () => {
  const sealed = vault.seal("web", "api.example.com", value);
  assert.throws(() => vault.open("ops", "api.example.com", sealed));
  assert.throws(() => vault.open("web", "git.example.com", sealed));
  assert.throws(() => createVault(Buffer.alloc(32, 2)).open("web", "api.example.com", sealed));
});

test("a changed ciphertext, tag or nonce does not open", () => {
  const sealed = vault.seal("web", "api.example.com", value);
  const flipped = (bytes: Uint8Array, at: number) => bytes.map((byte, i) => (i === at ? byte ^ 1 : byte));
  for (const at of [0, sealed.secretEnc.length - 1]) {
    assert.throws(() => vault.open("web", "api.example.com", { ...sealed, secretEnc: flipped(sealed.secretEnc, at) }));
  }
  assert.throws(() => vault.open("web", "api.example.com", { ...sealed, nonce: flipped(sealed.nonce, 0) }));
  assert.throws(() => vault.open("web", "api.example.com", { ...sealed, secretEnc: sealed.secretEnc.subarray(0, 8) }));
});

test("each seal uses a fresh nonce and stores no plain text", () => {
  const [first, second] = [vault.seal("web", "api.example.com", value), vault.seal("web", "api.example.com", value)];
  assert.notDeepEqual(first.nonce, second.nonce);
  assert.notDeepEqual(first.secretEnc, second.secretEnc);
  assert.equal(first.nonce.length, 12);
  assert.equal(first.secretEnc.length, Buffer.byteLength(value) + 16);
  assert.equal(Buffer.from(first.secretEnc).includes(value), false);
});

test("a vault refuses a key that is not 32 bytes", () => {
  assert.throws(() => createVault(Buffer.alloc(16)));
  assert.throws(() => createVault(Buffer.alloc(0)));
});
