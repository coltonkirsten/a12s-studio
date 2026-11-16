import { spawnSync } from "node:child_process";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const SECURITY = "/usr/bin/security";
const ITEM = ["-s", "a12s-studio-broker", "-a", "vault-key"];
const NOT_FOUND = 44;
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

type Sealed = { nonce: Uint8Array; secretEnc: Uint8Array };

export type Vault = {
  seal(teamId: string, host: string, secret: string): Sealed;
  open(teamId: string, host: string, sealed: Sealed): string;
};

export function createVault(key: Uint8Array): Vault {
  if (key.length !== KEY_BYTES) throw new Error(`The vault key must be ${KEY_BYTES} bytes.`);
  // Binding the row's identity into the tag makes a ciphertext moved to another team or host fail to open.
  const row = (teamId: string, host: string) => Buffer.from(`${teamId}\n${host}`);
  return {
    seal(teamId, host, secret) {
      const nonce = randomBytes(NONCE_BYTES);
      const cipher = createCipheriv("aes-256-gcm", key, nonce).setAAD(row(teamId, host));
      const secretEnc = Buffer.concat([cipher.update(secret, "utf8"), cipher.final(), cipher.getAuthTag()]);
      return { nonce, secretEnc };
    },
    open(teamId, host, { nonce, secretEnc }) {
      const tagAt = secretEnc.length - TAG_BYTES;
      const decipher = createDecipheriv("aes-256-gcm", key, nonce, { authTagLength: TAG_BYTES })
        .setAAD(row(teamId, host))
        .setAuthTag(secretEnc.subarray(tagAt));
      return Buffer.concat([decipher.update(secretEnc.subarray(0, tagAt)), decipher.final()]).toString("utf8");
    },
  };
}

function readKey(): Buffer | undefined {
  const found = spawnSync(SECURITY, ["find-generic-password", ...ITEM, "-w"], { encoding: "utf8" });
  if (found.status === NOT_FOUND) return undefined;
  if (found.status !== 0) throw new Error(`Keychain read failed: ${found.error?.message ?? found.stderr.trim()}`);
  return Buffer.from(found.stdout.trim(), "base64");
}

// The vault key lives in the macOS login Keychain; the first start creates it.
export function keychainKey(): Buffer {
  const existing = readKey();
  if (existing) return existing;
  const key = randomBytes(KEY_BYTES).toString("base64");
  // The command goes in on stdin because an argument would show the key in the process list.
  spawnSync(SECURITY, ["-i"], { input: `add-generic-password ${ITEM.join(" ")} -w ${key}\n` });
  // Reading back, rather than trusting the write, means the key in use is always the one the Keychain kept.
  const created = readKey();
  if (!created) throw new Error("The Keychain did not keep the new vault key.");
  return created;
}
