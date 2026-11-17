import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type TestContext, test } from "node:test";
import { format } from "node:util";
import { listenAdmin } from "@a12s-studio/broker/src/admin.ts";
import { openDb as openBrokerDb } from "@a12s-studio/broker/src/db.ts";
import { createVault } from "@a12s-studio/broker/src/vault.ts";
import { studio, until } from "../../packages/app/test/studio.ts";
import { backup, expired } from "../backup.ts";
import type { Drives } from "../drives.ts";
import { restore } from "../restore.ts";

const SECRET = "stored-credential-marker";
const AT = new Date(2026, 10, 16, 3, 30);

const temp = (name: string) => mkdtempSync(join(tmpdir(), `${name}-`));

// Drives as plain folders, saved and loaded with the host's tar, so the test needs no Docker.
function folderDrives(folders: Record<string, string>): Drives {
  const folder = (drive: string) => folders[drive] ?? assert.fail(`no drive ${drive}`);
  return {
    list: async () => Object.keys(folders),
    save: async (drive, file) => void execFileSync("tar", ["-C", folder(drive), "-czf", file, "."]),
    load: async (drive, file) => {
      rmSync(folder(drive), { recursive: true, force: true });
      mkdirSync(folder(drive));
      execFileSync("tar", ["-C", folder(drive), "-xzf", file]);
    },
  };
}

function drive(files: Record<string, string>): string {
  const dir = temp("drive");
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
}

const listing = (dir: string): Record<string, string> =>
  Object.fromEntries(
    readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => {
        const path = join(entry.parentPath, entry.name);
        return [path.slice(dir.length + 1), readFileSync(path, "utf8")];
      }),
  );

// Every row of every table, as sorted JSON lines per table.
function rows(file: string): Record<string, string[]> {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all();
    return Object.fromEntries(
      tables.map(({ name }) => [
        String(name),
        db
          .prepare(`SELECT * FROM "${String(name)}"`)
          .all()
          .map((row) => JSON.stringify(row))
          .sort(),
      ]),
    );
  } finally {
    db.close();
  }
}

// Runs `run` and answers its result with what it printed.
async function printed<T>(t: TestContext, run: () => Promise<T>): Promise<[T, string]> {
  const lines: string[] = [];
  const log = t.mock.method(console, "log", (...args: unknown[]) => lines.push(format(...args)));
  const error = t.mock.method(console, "error", (...args: unknown[]) => lines.push(format(...args)));
  try {
    return [await run(), lines.join("\n")];
  } finally {
    log.mock.restore();
    error.mock.restore();
  }
}

// A data folder in use: the real app and the real broker, with teams, threads, messages, a credential, a grant, a
// request and an attachment written through their own code.
async function liveHome(t: TestContext) {
  const home = temp("studio-home");
  mkdirSync(join(home, "broker"));
  mkdirSync(join(home, "app", "files", "m_attachment"), { recursive: true });
  writeFileSync(join(home, "app", "files", "m_attachment", "report.txt"), "the report");
  writeFileSync(join(home, "config.json"), JSON.stringify({ ownerLogin: "owner@example.com", fleet: "studio" }));
  const brokerDb = openBrokerDb(join(home, "broker", "vault.db"));
  const admin = await listenAdmin(
    { db: brokerDb, vault: createVault(Buffer.alloc(32, 7)), now: Date.now },
    join(home, "broker", "admin.sock"),
  );
  const s = await studio({ dbFile: join(home, "app", "studio.db"), broker: join(home, "broker", "admin.sock") });
  t.after(async () => {
    await s.close();
    admin.closeAllConnections();
    await new Promise((resolve) => admin.close(resolve));
    brokerDb.close();
  });
  await s.twoTeams();
  await s.owner("POST", "/api/teams/web/threads", { title: "Launch", body: "Plan the launch page." });
  const asked = await s.tool("web-lead", "post", { kind: "ask", to: "dev", title: "Hero", body: "Draft the hero." });
  assert.equal(asked.error, undefined);
  await s.owner("PUT", "/api/teams/web/credentials/api.example.com", { scheme: "bearer", secret: SECRET });
  await s.owner("POST", "/api/teams/web/grants", { host: "api.example.com", methods: ["GET"], paths: ["/v1/**"] });
  await s.tool("web-dev", "access", {
    action: "request",
    host: "api.example.com",
    methods: ["POST"],
    paths: ["/v1/items"],
    reason: "To add items.",
  });
  await until(() => s.a12s.agents.get("web-dev")?.inbox.length === 1);
  const tokens = (s.db.prepare("SELECT a12s_token FROM teams").all() as { a12s_token: string }[]).map(
    (r) => r.a12s_token,
  );
  return { home, tokens };
}

test("a backup of a data folder in use restores every row, the attachments and the drives", async (t) => {
  const { home, tokens } = await liveHome(t);
  const drives = {
    "home-web-lead": drive({ "memory/notes.md": "The launch is on Friday.\n", "site/index.html": "<h1>" }),
  };
  const before = Object.fromEntries(
    ["app/studio.db", "broker/vault.db"].map((db) => [db, rows(join(home, db))] as const),
  );
  for (const [db, tables] of Object.entries(before)) {
    for (const table of db === "app/studio.db"
      ? ["teams", "agents", "threads", "messages"]
      : ["credentials", "grants"]) {
      assert.ok(tables[table]?.length, `${db} has rows in ${table}`);
    }
  }

  const root = temp("backups");
  const [folder, saved] = await printed(t, () => backup(home, root, folderDrives(drives), AT));
  assert.equal(folder, join(root, "2026-11-16"));

  const restored = temp("restored");
  const target = { "home-web-lead": drive({ "memory/notes.md": "Changed since.\n", "stray.txt": "x" }) };
  const [, put] = await printed(t, () => restore(folder, restored, folderDrives(target), false));

  for (const db of ["app/studio.db", "broker/vault.db"]) assert.deepEqual(rows(join(restored, db)), before[db], db);
  assert.equal(readFileSync(join(restored, "app", "files", "m_attachment", "report.txt"), "utf8"), "the report");
  assert.equal(readFileSync(join(restored, "config.json"), "utf8"), readFileSync(join(home, "config.json"), "utf8"));
  assert.deepEqual(listing(target["home-web-lead"]), listing(drives["home-web-lead"]));
  for (const secret of [SECRET, ...tokens]) assert.ok(!`${saved}\n${put}`.includes(secret), "a secret was printed");
});

test("a run keeps the newest 14 dated backups and removes unfinished ones", async (t) => {
  const { home } = await liveHome(t);
  const root = temp("backups");
  const old = Array.from({ length: 15 }, (_, i) => `2026-10-${String(i + 1).padStart(2, "0")}`);
  for (const name of [...old, "2026-10-20.partial", "notes"]) mkdirSync(join(root, name));
  await printed(t, () => backup(home, root, folderDrives({}), AT));
  assert.deepEqual(readdirSync(root).sort(), [...old.slice(2), "2026-11-16", "notes"]);
});

test("expired: dated folders after the newest 14, and unfinished ones", () => {
  const days = (n: number) => Array.from({ length: n }, (_, i) => `2026-01-${String(i + 1).padStart(2, "0")}`);
  const table: [string[], string[]][] = [
    [[], []],
    [days(14), []],
    [days(16), ["2026-01-01", "2026-01-02"]],
    [[...days(14).reverse(), "2025-12-31"], ["2025-12-31"]],
    [["2026-01-01.partial", "2026-01-01", "readme.txt"], ["2026-01-01.partial"]],
  ];
  for (const [names, gone] of table) assert.deepEqual(expired(names), gone, names.join(" "));
});

test("restore refuses a data folder that holds Studio data, unless forced, and then leaves nothing old", async (t) => {
  const { home } = await liveHome(t);
  const [folder] = await printed(t, () => backup(home, temp("backups"), folderDrives({}), AT));
  const target = temp("target");
  mkdirSync(join(target, "app"));
  writeFileSync(join(target, "app", "studio.db-wal"), "old");
  writeFileSync(join(target, "config.json"), "{}");

  await assert.rejects(restore(folder, target, folderDrives({}), false), /already holds app, config\.json.*--force/);
  assert.equal(readFileSync(join(target, "config.json"), "utf8"), "{}");

  await printed(t, () => restore(folder, target, folderDrives({}), true));
  assert.deepEqual(readdirSync(join(target, "app")).sort(), ["files", "studio.db"]);
  assert.equal(readFileSync(join(target, "config.json"), "utf8"), readFileSync(join(home, "config.json"), "utf8"));
});

test("restore names a drive the Fleet does not have and refuses a folder that is not a whole backup", async (t) => {
  const { home } = await liveHome(t);
  const [folder] = await printed(t, () => backup(home, temp("backups"), folderDrives({ "home-gone": drive({}) }), AT));
  const [, lines] = await printed(t, () => restore(folder, temp("target"), folderDrives({}), true));
  assert.match(lines, /^skipped drive home-gone: the Fleet has no such drive$/m);

  await assert.rejects(
    restore(temp("not-a-backup"), temp("target"), folderDrives({}), true),
    /is not a whole backup: it has no config\.json, app\/studio\.db, broker\/vault\.db/,
  );
});
