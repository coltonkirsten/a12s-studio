import { BROKER_PORT, OWNER_PORT, STUDIO_PORT } from "@a12s-studio/contract/names";

export const PORTS = [OWNER_PORT, STUDIO_PORT, BROKER_PORT];
const MIN_A12S = [0, 11, 2];

// What run.ts measured on this machine before it creates anything. `a12s` is the installed release ("0.11.2"),
// or null when the command is missing.
export type Probes = { docker: boolean; a12s: string | null; busyPorts: number[] };
export type Problem = { what: string; fix: string };

function atLeast(version: string, minimum: number[]): boolean {
  const parts = version.split(".").map(Number);
  for (const [i, want] of minimum.entries()) {
    const have = parts[i] ?? 0;
    if (have !== want) return have > want;
  }
  return true;
}

// Every reason the run cannot start, so one attempt names them all.
export function missing(env: Record<string, string | undefined>, probes: Probes): Problem[] {
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
  for (const port of probes.busyPorts) {
    problems.push({
      what: `Port ${port} is in use.`,
      fix: "Stop the Studio on this Mac: launchctl bootout gui/$(id -u)/com.a12s-studio.app, then …broker.",
    });
  }
  if (!env.CLAUDE_CODE_OAUTH_TOKEN) {
    problems.push({
      what: "CLAUDE_CODE_OAUTH_TOKEN is not set.",
      fix: "Run claude setup-token, then export CLAUDE_CODE_OAUTH_TOKEN with the token it prints.",
    });
  }
  return problems;
}
