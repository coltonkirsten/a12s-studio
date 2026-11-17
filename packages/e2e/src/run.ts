// npm run e2e [-- p1 …]: the exit scripts against real Docker, a12s and Claude, in a Fleet and a data folder of their
// own. Both are removed at the end, whether the scripts pass, fail or are interrupted.
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { p1 } from "./p1.ts";
import { missing, PORTS } from "./preflight.ts";
import { connectStudio, type Studio, step } from "./studio.ts";

const FLEET = "studio-e2e";
const SCRIPTS: Record<string, (studio: Studio) => Promise<void>> = { p1 };
const repo = fileURLToPath(new URL("../../..", import.meta.url));

const chosen = process.argv.length > 2 ? process.argv.slice(2) : Object.keys(SCRIPTS);
const unknown = chosen.filter((name) => !(name in SCRIPTS));
if (unknown.length > 0) {
  console.error(`No script ${unknown.join(", ")}. The scripts are ${Object.keys(SCRIPTS).join(", ")}.`);
  process.exit(2);
}

function portBusy(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(true));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(false)));
  });
}

const version = spawnSync("a12s", ["version"], { encoding: "utf8" });
const problems = missing(process.env, {
  docker: spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0,
  a12s: version.status === 0 ? (/^a12s v([0-9.]+)/.exec(version.stdout)?.[1] ?? null) : null,
  busyPorts: (await Promise.all(PORTS.map(async (port) => ((await portBusy(port)) ? [port] : [])))).flat(),
});
if (problems.length > 0) {
  for (const { what, fix } of problems) console.error(`missing  ${what}\n         Fix: ${fix}`);
  console.error("Nothing was created.");
  process.exit(1);
}

// Children run in process groups of their own, so a Ctrl-C reaches only this process, which then stops them in
// order: an a12s command that was cut off by the terminal could leave its Fleet half made or half removed.
let current: ChildProcess | null = null;
let cleaning = false;
let interrupt: (signal: string) => void = () => {};
const interrupted = new Promise<never>((_, reject) => {
  interrupt = (signal) => reject(new Error(`${signal}: stopping the run`));
});
interrupted.catch(() => {});
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (cleaning) return console.log("      cleaning up; it ends by itself");
    current?.kill("SIGINT");
    interrupt(signal);
  });
}

// Runs an a12s command on the e2e Fleet. Its output stays out of the log unless it fails.
function a12s(args: string[], input?: string): Promise<void> {
  const child = spawn("a12s", ["-F", fleetFile, ...args], { detached: true, stdio: ["pipe", "pipe", "pipe"] });
  current = child;
  let output = "";
  child.stdout.on("data", (d) => (output += d));
  child.stderr.on("data", (d) => (output += d));
  child.stdin.end(input);
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => {
      current = null;
      if (code === 0) resolve();
      else reject(new Error(`a12s ${args.join(" ")} exited ${code}: ${output.trim().slice(-600)}`));
    });
  });
}

// One of Studio's two host processes, with its output in a log file in the data folder.
function hostProcess(entry: string, log: string) {
  let child: ChildProcess | null = null;
  return {
    log,
    start(): void {
      const fd = openSync(log, "a");
      child = spawn(process.execPath, [join(repo, entry)], {
        cwd: repo,
        env,
        detached: true,
        stdio: ["ignore", fd, fd],
      });
    },
    async stop(): Promise<void> {
      const running = child;
      child = null;
      if (!running || running.exitCode !== null || running.signalCode !== null) return;
      running.kill("SIGTERM");
      await once(running, "exit");
    },
  };
}

const tail = (file: string) => {
  try {
    return readFileSync(file, "utf8").trimEnd().split("\n").slice(-20).join("\n");
  } catch {
    return "(no output)";
  }
};

const home = mkdtempSync(join(tmpdir(), "a12s-studio-e2e-"));
const fleetFile = join(home, "fleet", "fleet.yaml");
mkdirSync(join(home, "fleet"));
writeFileSync(fleetFile, `apiVersion: a12s.ai/v1alpha1\nkind: Fleet\nmetadata: { name: ${FLEET} }\n`);
writeFileSync(join(home, "config.json"), JSON.stringify({ ownerLogin: "owner@example.com", fleet: FLEET }));
// The host processes need no Claude token; it goes to the Controller only.
const { CLAUDE_CODE_OAUTH_TOKEN: token, ...inherited } = process.env;
const env = { ...inherited, STUDIO_HOME: home };
const broker = hostProcess("packages/broker/src/main.ts", join(home, "broker.log"));
const app = hostProcess("packages/app/src/main.ts", join(home, "app.log"));

let failed = false;
try {
  await Promise.race([
    interrupted,
    (async () => {
      await step(`Fleet ${FLEET} is up`, () => a12s(["up"]));
      await step("Its Claude credential is set", () =>
        // a12s's refusal is not shown: it could quote the value.
        a12s(["creds", "set", "anthropic"], token).catch(() => {
          throw new Error("a12s refused CLAUDE_CODE_OAUTH_TOKEN. Fix: set it to a token from claude setup-token.");
        }),
      );
      const studio = await step("The broker and the app run and the app sees a12s", async () => {
        broker.start();
        app.start();
        const studio = connectStudio(app);
        await studio.until("a12s up", (s) => s.a12s === "up", 60_000);
        return studio;
      });
      await step("The default model is haiku", () => studio.api("PATCH", "/settings", { defaultModel: "haiku" }));
      for (const name of chosen) {
        console.log(`--    ${name}`);
        await SCRIPTS[name]?.(studio);
      }
    })(),
  ]);
} catch (error) {
  failed = true;
  console.log(`stop  ${error instanceof Error ? error.message : String(error)}`);
  for (const { log } of [app, broker]) console.log(`      ${log}:\n${tail(log).replace(/^/gm, "      | ")}`);
} finally {
  cleaning = true;
  console.log("--    cleanup");
  const cleanup: [string, () => Promise<void>][] = [
    ["The app and the broker are stopped", () => Promise.all([app.stop(), broker.stop()]).then(() => {})],
    [`Fleet ${FLEET} is removed with its drives`, () => a12s(["down", "--purge", "--yes"])],
    ["The data folder is removed", async () => rmSync(home, { recursive: true, force: true })],
  ];
  for (const [title, run] of cleanup) {
    await step(title, run).catch(() => {
      failed = true;
    });
  }
}
process.exit(failed ? 1 : 0);
