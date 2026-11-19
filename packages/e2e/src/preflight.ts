import { BROKER_PORT, OWNER_PORT, STUDIO_PORT } from "@a12s-studio/contract/names";

export const PORTS = [OWNER_PORT, STUDIO_PORT, BROKER_PORT];
const MIN_A12S = [0, 12, 0];

// What run.ts measured on this machine before it creates anything. `a12s` is the installed release ("0.12.0"),
// or null when the command is missing; `agentImage` is whether Docker has the image agentSpec names.
export type Probes = { docker: boolean; a12s: string | null; agentImage: boolean; busyPorts: number[] };
export type Problem = { what: string; fix: string };

// The variables a run reads, with the scripts that need them; `scripts: null` means every run.
const VARIABLES: { name: string; scripts: string[] | null; fix: string }[] = [
  {
    name: "CLAUDE_CODE_OAUTH_TOKEN",
    scripts: null,
    fix: "Run claude setup-token, then export CLAUDE_CODE_OAUTH_TOKEN with the token it prints.",
  },
  {
    name: "E2E_GITHUB_REPO",
    scripts: ["p2", "p4"],
    fix: "Export E2E_GITHUB_REPO as <owner>/<repo> of a throwaway private repository.",
  },
  {
    name: "E2E_GITHUB_TOKEN",
    scripts: ["p2", "p4"],
    fix: "Export E2E_GITHUB_TOKEN with a fine-grained token for that repository only, contents read and write.",
  },
];

function atLeast(version: string, minimum: number[]): boolean {
  const parts = version.split(".").map(Number);
  for (const [i, want] of minimum.entries()) {
    const have = parts[i] ?? 0;
    if (have !== want) return have > want;
  }
  return true;
}

// Every reason a run of the chosen scripts cannot start, so one attempt names them all.
export function missing(env: Record<string, string | undefined>, probes: Probes, chosen: string[]): Problem[] {
  const problems: Problem[] = [];
  if (!probes.docker) problems.push({ what: "Docker is not running.", fix: "Start Docker Desktop." });
  if (probes.a12s === null) {
    problems.push({ what: "a12s is not installed.", fix: "brew install coltonkirsten/tap/a12s" });
  } else if (!atLeast(probes.a12s, MIN_A12S)) {
    problems.push({
      what: `a12s ${probes.a12s} is too old; ${MIN_A12S.join(".")} or later is needed.`,
      fix: "brew upgrade a12s",
    });
  }
  if (probes.docker && !probes.agentImage) {
    problems.push({ what: "The agent image is not built.", fix: "Run scripts/setup.sh, which builds it." });
  }
  for (const port of probes.busyPorts) {
    problems.push({
      what: `Port ${port} is in use.`,
      fix: "Stop the Studio on this Mac: launchctl bootout gui/$(id -u)/com.a12s-studio.app, then …broker.",
    });
  }
  for (const { name, scripts, fix } of VARIABLES) {
    const needed = scripts === null || scripts.some((script) => chosen.includes(script));
    if (needed && !env[name]) problems.push({ what: `${name} is not set.`, fix });
  }
  return problems;
}
