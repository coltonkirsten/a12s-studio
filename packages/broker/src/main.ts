import { once } from "node:events";
import { chmodSync, mkdirSync } from "node:fs";
import { globalAgent } from "node:https";
import { homedir } from "node:os";
import { join } from "node:path";
import { BROKER_PORT } from "@a12s-studio/contract/names";
import { listenAdmin } from "./admin.ts";
import { openDb } from "./db.ts";
import { forwardServer } from "./forward.ts";
import { sweep } from "./sweep.ts";
import { createVault, keychainKey } from "./vault.ts";

const SWEEP_EVERY_MS = 60_000;

function vaultKey(): Buffer {
  try {
    return keychainKey();
  } catch (error) {
    console.error(
      `The a12s Studio broker cannot start: ${String(error)}\nFix: unlock the login Keychain and start again.`,
    );
    process.exit(1);
  }
}

// Everything the broker creates (database, socket) is for the owner alone.
process.umask(0o077);
const folder = join(process.env.STUDIO_HOME ?? join(homedir(), ".a12s-studio"), "broker");
mkdirSync(folder, { recursive: true });
chmodSync(folder, 0o700);

const deps = { db: openDb(join(folder, "vault.db")), vault: createVault(vaultKey()), now: Date.now };
// The port goes first: if another broker holds it, this one stops before it touches that broker's socket.
await once(forwardServer({ ...deps, upstream: globalAgent }).listen(BROKER_PORT, "127.0.0.1"), "listening");
await listenAdmin(deps, join(folder, "admin.sock"));
setInterval(() => sweep(deps.db, deps.now()), SWEEP_EVERY_MS);
console.log(`a12s Studio broker: forwarding on 127.0.0.1:${BROKER_PORT}, admin on ${join(folder, "admin.sock")}`);
