// node scripts/restore.ts <backup folder> [--force]: puts a backup that backup.ts made back into the data folder and
// the agents' home drives. Stop Studio first; pause everything before that, so no agent is awake.
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DATABASES, DRIVES, TAR } from "./backup.ts";
import { type Drives, fleetDrives, fleetOf } from "./drives.ts";

// Without `force` it refuses, before it changes anything, when the data folder or the Fleet already holds something
// the backup would replace. The Fleet is the one the backup names, whatever the data folder: a restore into a spare
// folder still loads the drives of that Fleet's agents.
export async function restore(folder: string, home: string, drives: Drives, force: boolean): Promise<void> {
  const lacking = ["config.json", ...DATABASES, DRIVES].filter((file) => !existsSync(join(folder, file)));
  if (lacking.length > 0) throw new Error(`${folder} is not a whole backup: it has no ${lacking.join(", ")}`);
  const data = readdirSync(folder).filter((entry) => entry !== DRIVES);
  const present = data.filter((entry) => existsSync(join(home, entry)));
  const known = new Set(await drives.list());
  const saved = readdirSync(join(folder, DRIVES))
    .filter((file) => file.endsWith(TAR))
    .map((file) => file.slice(0, -TAR.length));
  const loaded = saved.filter((drive) => known.has(drive));
  if (!force && present.length + loaded.length > 0) {
    const held = [
      ...(present.length > 0 ? [`${home} already holds ${present.join(", ")}`] : []),
      ...(loaded.length > 0 ? [`the Fleet already has the home drives ${loaded.join(", ")}`] : []),
    ];
    throw new Error(`${held.join(", and ")}. To replace them, run this again with --force.`);
  }
  mkdirSync(home, { recursive: true, mode: 0o700 });
  for (const entry of data) {
    // Removed first, so no file of the old data (a database's write-ahead log above all) stays beside the copy.
    rmSync(join(home, entry), { recursive: true, force: true });
    cpSync(join(folder, entry), join(home, entry), { recursive: true });
    console.log(`restored ${entry}`);
  }
  for (const drive of saved) {
    if (!known.has(drive)) {
      console.log(`skipped drive ${drive}: the Fleet has no such drive`);
      continue;
    }
    await drives.load(drive, join(folder, DRIVES, `${drive}${TAR}`));
    console.log(`restored drive ${drive}`);
  }
}

if (import.meta.main) {
  process.umask(0o077);
  const args = process.argv.slice(2);
  const folders = args.filter((arg) => arg !== "--force");
  if (folders.length !== 1) {
    console.error("usage: node scripts/restore.ts <backup folder> [--force]");
    process.exit(2);
  }
  const [folder = ""] = folders;
  const home = process.env.STUDIO_HOME ?? join(homedir(), ".a12s-studio");
  try {
    await restore(folder, home, fleetDrives(fleetOf(folder)), args.includes("--force"));
  } catch (error) {
    console.error(`The restore failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
  console.log(`Restored ${folder} into ${home}.`);
  console.log("The credentials in broker/vault.db open only with the vault key of the Mac that made the backup.");
  console.log('On another Mac, import that key first (README, "Backups"). Then start Studio: scripts/setup.sh');
}
