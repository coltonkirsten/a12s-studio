import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openDb, tx } from "../src/db.ts";

test("migrations apply to a new file and re-apply as a no-op", () => {
  const file = join(mkdtempSync(join(tmpdir(), "studio-db-")), "studio.db");
  const first = openDb(file);
  assert.equal(first.prepare("PRAGMA journal_mode").get()?.journal_mode, "wal");
  assert.equal(first.prepare("PRAGMA foreign_keys").get()?.foreign_keys, 1);
  first.close();

  const again = openDb(file);
  assert.equal(again.prepare("PRAGMA user_version").get()?.user_version, 1);
  const settings = again.prepare("SELECT key, value FROM settings ORDER BY key").all();
  assert.equal(settings.length, 7);
  assert.deepEqual({ ...settings[0] }, { key: "awake_cap", value: "4" });
  again.close();
});

test("a transaction that throws leaves nothing behind", () => {
  const db = openDb(":memory:");
  const write = () => db.exec("UPDATE settings SET value = '9' WHERE key = 'awake_cap'");
  assert.throws(() =>
    tx(db, () => {
      write();
      throw new Error("stop");
    }),
  );
  assert.equal(db.prepare("SELECT value FROM settings WHERE key = 'awake_cap'").get()?.value, "4");
  tx(db, write);
  assert.equal(db.prepare("SELECT value FROM settings WHERE key = 'awake_cap'").get()?.value, "9");
  // @ts-expect-error an async function would commit before its awaited work ran
  tx(db, async () => {});
});
