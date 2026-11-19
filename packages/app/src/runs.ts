import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, truncateSync } from "node:fs";
import { join } from "node:path";
import type { Caller } from "./caller.ts";
import { freeDiskGb } from "./dispatcher.ts";
import { StudioError } from "./errors.ts";
import type { Live } from "./live.ts";
import type { Repo, StoredRun } from "./repo.ts";
import { assign, CHUNK_MAX, index, wholeLines } from "./transcript.ts";

const KEEP_MS = 30 * 24 * 3600 * 1000;

// A session transcript under the harness's projects folder, or one of its sub-agents': the only files the hook sends.
const SOURCE =
  /^([A-Za-z0-9_-][A-Za-z0-9._-]*)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(\/subagents\/agent-[A-Za-z0-9_-]+)?\.jsonl$/;

// Run capture: the agent's Stop hook sends what its session transcripts gained, each line is kept in the file of the
// Turn it was written in, app/runs/<turn>.jsonl, and the Turn's index is rebuilt. Kept 30 days after a run's last
// line, whatever happens to the team.
export function createRuns(deps: { repo: Repo; live: Pick<Live, "agent">; dir: string }) {
  const { repo, live, dir } = deps;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = (turn: string) => join(dir, `${turn}.jsonl`);

  return {
    // What the caller has sent of each file, one "<bytes> <path>" line each, for the hook to send the rest.
    sources(caller: Caller): string {
      const sent = repo.forTeam(caller.teamId).runSources(caller.agentId);
      return sent.map((s) => `${s.bytes} ${s.path}\n`).join("");
    },

    // Takes the whole lines of `chunk`, which starts `offset` bytes into the file at `path`, and answers how far into
    // the file Studio now holds.
    receive(caller: Caller, path: string, offset: number, chunk: Buffer, now = Date.now()): number {
      const session = SOURCE.exec(path)?.[2];
      if (!session) {
        throw new StudioError(400, "bad_path", `${path} is not a session transcript.`, "Send a file the hook names.");
      }
      if (freeDiskGb() < repo.settings().minFreeDiskGb) {
        throw new StudioError(507, "disk_full", "The Mac is below its free disk floor.", "Free some disk space.");
      }
      const scoped = repo.forTeam(caller.teamId);
      const held = scoped.runSources(caller.agentId).find((s) => s.path === path)?.bytes ?? 0;
      if (offset !== held) {
        throw new StudioError(409, "offset", `Studio holds ${held} bytes of ${path}.`, "Send from there.");
      }
      const { lines, used } = wholeLines(chunk, CHUNK_MAX);
      const floor = now - KEEP_MS;
      const starts = scoped.turnStarts(caller.agentId, floor);
      const current = live.agent(caller.agentId)?.turn;
      if (current && !starts.some((s) => s.id === current.id)) starts.push({ id: current.id, at: current.startedAt });
      if (starts.length === 0 && lines.length > 0) {
        throw new StudioError(409, "no_turn", "Studio knows no Turn of yours to file these lines under.", "Retry.");
      }
      starts.sort((a, b) => a.at - b.at);
      const runs: StoredRun[] = [];
      for (const [turnId, added] of assign(lines, starts, floor)) {
        const f = file(turnId);
        // A crash between the append and the commit leaves bytes the database does not count; they are cut first.
        const kept = scoped.runBytes(turnId);
        if (existsSync(f)) truncateSync(f, kept);
        appendFileSync(f, `${added.join("\n")}\n`, { mode: 0o600 });
        const content = readFileSync(f);
        const all = wholeLines(content, CHUNK_MAX).lines;
        const summary = index(all, content.length);
        runs.push({ turnId, session, lastAt: summary.lastAt ?? now, index: summary });
      }
      scoped.saveRuns(caller.agentId, path, offset + used, runs);
      for (const turn of repo.pruneRuns(floor)) rmSync(file(turn), { force: true });
      return offset + used;
    },

    // The run's transcript lines, as the agent's harness wrote them.
    lines(turnId: string): string[] {
      const f = file(turnId);
      return existsSync(f) ? wholeLines(readFileSync(f), CHUNK_MAX).lines : [];
    },
    file,
  };
}

export type Runs = ReturnType<typeof createRuns>;
