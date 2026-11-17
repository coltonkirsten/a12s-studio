// node scripts/backup.ts [<folder>]: copies Studio's data folder and each agent's home drive into <folder>/<date>,
// by default ~/a12s-studio-backups, and keeps the newest 14. The LaunchAgent com.a12s-studio.backup runs it nightly.
import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync, backup as sqliteBackup } from "node:sqlite";
import { type Drives, fleetDrives, fleetOf } from "./drives.ts";

const KEEP = 14;
const DATED = /^\d{4}-\d{2}-\d{2}$/;
const PARTIAL = ".partial";
// Copied with SQLite's backup, which reads a consistent copy while the app and the broker write.
export const DATABASES = ["app/studio.db", "broker/vault.db"];
// Each home drive is the file drives/<drive name>.tar.gz of a backup.
export const DRIVES = "drives";
export const TAR = ".tar.gz";

// What the run that made the backup `made` removes from the backups folder: the dated backups after the newest
// KEEP, and any backup a run that was killed left unfinished. `made` counts as the newest whatever its date, so a
// clock that was set back never costs the backup just written.
export function expired(names: string[], made: string): string[] {
  const older = names.filter((name) => DATED.test(name) && name !== made).sort();
  return [...older.slice(0, -(KEEP - 1)), ...names.filter((name) => name.endsWith(PARTIAL))];
}

const localDate = (at: Date) =>
  [at.getFullYear(), at.getMonth() + 1, at.getDate()].map((n) => String(n).padStart(2, "0")).join("-");

// Answers the new backup's folder. It is written under another name and renamed when whole, so a dated folder is
// always a complete backup; a second run on the same day replaces it. The unfinished folder is also the lock: a run
// that finds it stops, so two runs never write one backup.
export async function backup(home: string, root: string, drives: Drives, at: Date): Promise<string> {
  const date = localDate(at);
  const folder = join(root, date);
  const partial = `${folder}${PARTIAL}`;
  mkdirSync(root, { recursive: true });
  try {
    mkdirSync(partial);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    throw new Error(`${partial} exists: another backup is running, or one was killed. If none is running, remove it.`);
  }
  try {
    await write(home, partial, drives);
  } catch (error) {
    rmSync(partial, { recursive: true, force: true });
    throw error;
  }
  rmSync(folder, { recursive: true, force: true });
  renameSync(partial, folder);
  for (const name of expired(readdirSync(root), date)) {
    rmSync(join(root, name), { recursive: true, force: true });
    console.log(`removed ${name}`);
  }
  return folder;
}

async function write(home: string, partial: string, drives: Drives): Promise<void> {
  for (const db of DATABASES) {
    mkdirSync(dirname(join(partial, db)), { recursive: true });
    const source = new DatabaseSync(join(home, db), { readOnly: true });
    try {
      await sqliteBackup(source, join(partial, db));
    } finally {
      source.close();
    }
    console.log(`saved ${db}`);
  }
  cpSync(join(home, "config.json"), join(partial, "config.json"));
  console.log("saved config.json");
  // Attachments: a folder per message, made when the first one is posted.
  if (existsSync(join(home, "app", "files"))) {
    cpSync(join(home, "app", "files"), join(partial, "app", "files"), { recursive: true });
    console.log("saved app/files");
  }
  mkdirSync(join(partial, DRIVES));
  for (const drive of await drives.list()) {
    await drives.save(drive, join(partial, DRIVES, `${drive}${TAR}`));
    console.log(`saved drive ${drive}`);
  }
}

if (import.meta.main) {
  // The backup holds the databases, so it is for the owner alone, like the data folder.
  process.umask(0o077);
  const home = process.env.STUDIO_HOME ?? join(homedir(), ".a12s-studio");
  const root = process.argv[2] ?? join(homedir(), "a12s-studio-backups");
  try {
    console.log(`Backup: ${await backup(home, root, fleetDrives(fleetOf(home)), new Date())}`);
  } catch (error) {
    console.error(`The backup failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
