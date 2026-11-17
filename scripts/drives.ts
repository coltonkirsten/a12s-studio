// The agents' home drives, which backup.ts saves and restore.ts loads: a12s names them, Docker holds them.
import { spawn } from "node:child_process";
import { closeSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readController } from "../packages/app/src/a12s/real.ts";

export type Drives = {
  // The home drive of every agent computer the Fleet has, also of one that was removed.
  list(): Promise<string[]>;
  // Writes the drive's files to `file` as a gzipped tar.
  save(drive: string, file: string): Promise<void>;
  // Makes the drive hold exactly the files of a tar that `save` wrote.
  load(drive: string, file: string): Promise<void>;
};

// Has tar, gzip and find, and is a few megabytes; Docker pulls it the first time.
const TOOLS_IMAGE = "busybox:1.37";

function docker(args: string[], stdin: number | "ignore", stdout: number | "ignore"): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, { stdio: [stdin, stdout, "pipe"] });
    let errors = "";
    child.stderr?.on("data", (d) => (errors += d));
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`docker ${args[0]} exited ${code}: ${errors.trim()}`)),
    );
  });
}

async function withFile(file: string, flags: "r" | "w", run: (fd: number) => Promise<void>): Promise<void> {
  const fd = openSync(file, flags, 0o600);
  try {
    await run(fd);
  } finally {
    closeSync(fd);
  }
}

// The Fleet named in the config.json of a data folder or of a backup.
export function fleetOf(folder: string): string {
  const { fleet } = JSON.parse(readFileSync(join(folder, "config.json"), "utf8")) as { fleet?: unknown };
  if (typeof fleet !== "string" || fleet === "") throw new Error(`${join(folder, "config.json")} names no fleet`);
  return fleet;
}

export function fleetDrives(fleet: string): Drives {
  // Measured (build-spec section 2, M8): a12s keeps the drive named `name` in the Docker volume a12s-<fleet>-<name>.
  const mount = (drive: string, mode: "ro" | "rw") => ["-v", `a12s-${fleet}-${drive}:/drive:${mode}`];
  const run = ["run", "--rm", "--network", "none"];
  return {
    async list() {
      const { url, token } = readController(fleet);
      const res = await fetch(`${url}/v1/drives`, { headers: { authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error(`a12s answered ${res.status} to the list of drives of Fleet ${fleet}`);
      const { drives } = (await res.json()) as { drives: { name: string; kind: string }[] };
      return drives.filter((d) => d.kind === "home").map((d) => d.name);
    },
    save: (drive, file) =>
      withFile(file, "w", (fd) =>
        docker([...run, ...mount(drive, "ro"), TOOLS_IMAGE, "tar", "-C", "/drive", "-czf", "-", "."], "ignore", fd),
      ),
    load: (drive, file) =>
      withFile(file, "r", (fd) =>
        docker(
          [
            ...run,
            "-i",
            ...mount(drive, "rw"),
            TOOLS_IMAGE,
            "sh",
            "-c",
            "find /drive -mindepth 1 -delete && tar -C /drive -xzf -",
          ],
          fd,
          "ignore",
        ),
      ),
  };
}
