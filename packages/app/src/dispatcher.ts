import { statfsSync } from "node:fs";
import { homedir } from "node:os";
import type { Settings, WaitingFor } from "@a12s-studio/contract/state";
import type { A12s, AgentStatus, Phase, TeamA12s } from "./a12s/port.ts";
import type { Message, Repo, Team, TeamRepo, Thread } from "./repo.ts";
import { nameOf } from "./router.ts";

export type Dispatcher = { run(): Promise<void> };

type Candidate = {
  team: Team;
  spentTodayUsd: number;
  scoped: TeamRepo;
  client: TeamA12s;
  agentId: string;
  phase: Phase;
  pending: number;
  fromOwner: boolean;
  oldest: number;
};

const MAX_NOTES = 20;
const NOTE_MAX = 500;

// The limits that can hold a wake; null for an agent that is already awake, which none of them stop.
type WakeLimits = { awake: number; freeDiskGb: () => number } | null;

export function overBudget(team: Pick<Team, "dailyBudgetUsd">, spentTodayUsd: number): boolean {
  return spentTodayUsd >= team.dailyBudgetUsd;
}

// Why a candidate gets nothing this run. The one place a hold is decided, so presence can show the same reason.
export function blockedReason(
  settings: Settings,
  team: Pick<Team, "paused" | "dailyBudgetUsd">,
  spentTodayUsd: number,
  wake: WakeLimits,
): WaitingFor | null {
  if (settings.paused || team.paused) return "paused";
  if (overBudget(team, spentTodayUsd)) return "budget";
  if (wake && wake.awake >= settings.awakeCap) return "cap";
  if (wake && wake.freeDiskGb() < settings.minFreeDiskGb) return "disk";
  return null;
}

// Docker's data root is inside its VM on macOS, out of the host's reach. The VM's disk image lives on the home
// folder's volume, so that volume's free space is what runs out.
export function freeDiskGb(): number {
  const disk = statfsSync(homedir());
  return (disk.bavail * disk.bsize) / 1e9;
}

function render(message: Message, thread: Thread | undefined, notes: Message[]): string {
  const from = nameOf(message.fromId);
  const lines = thread ? [`thread ${thread.id} "${thread.title}"`] : [];
  lines.push(
    message.kind === "reply"
      ? `reply ${message.id} from ${from} to your ask ${message.askId}`
      : `ask ${message.id} from ${from}`,
    "---",
    message.body,
    "---",
  );
  if (message.kind === "ask" && message.fromId !== "system") {
    lines.push(`To answer: post(kind="reply", ask="${message.id}")`);
  }
  if (notes.length > 0) {
    lines.push("", "notes since your last message:");
    for (const note of notes) {
      const where = note.threadId ? `[${note.threadId}] ` : "";
      lines.push(`- ${where}${nameOf(note.fromId)}: ${note.body.slice(0, NOTE_MAX)}`);
    }
  }
  return lines.join("\n");
}

export function createDispatcher(repo: Repo, a12s: A12s): Dispatcher {
  let running: Promise<void> | null = null;
  let again = false;
  // Woken by a run, but not yet reported awake by a12s: they count against the cap, and are not woken twice.
  const justWoken = new Set<string>();

  // The candidates in queue order, and how many agents are awake. `awake` is null when a team's status could not be
  // read: its awake agents are unknown, so no wake can be known to fit under the cap.
  async function survey(now: number): Promise<{ candidates: Candidate[]; awake: number | null }> {
    const found: Candidate[] = [];
    let awake: number | null = 0;
    for (const team of repo.teams()) {
      const scoped = repo.forTeam(team.id);
      const queued = scoped.dispatchable();
      const client = a12s.forTeam(team.a12sToken);
      let status: AgentStatus[];
      try {
        status = await client.status();
      } catch (error) {
        console.error(`dispatcher: status of team ${team.id} failed:`, error);
        awake = null;
        continue;
      }
      const spentTodayUsd = scoped.spentToday(now);
      for (const { name, pending, ...reported } of status) {
        if (reported.phase !== "Asleep") justWoken.delete(name);
        // a12s has the wake but still reports the old phase: the agent is on its way up.
        const phase = justWoken.has(name) ? "Starting" : reported.phase;
        if (phase !== "Asleep" && awake !== null) awake++;
        const order = queued.get(name);
        // An asleep agent with pending a12s Messages was put to sleep before it took them (pause): wake it.
        if (!order && !(phase === "Asleep" && pending > 0)) continue;
        found.push({
          team,
          spentTodayUsd,
          scoped,
          client,
          agentId: name,
          phase,
          pending,
          ...(order ?? { fromOwner: false, oldest: Infinity }),
        });
      }
    }
    found.sort((a, b) => Number(b.fromOwner) - Number(a.fromOwner) || a.oldest - b.oldest);
    return { candidates: found, awake };
  }

  // True when it woke the agent.
  async function deliver({ scoped, client, agentId, phase, pending }: Candidate): Promise<boolean> {
    let waiting = pending;
    const queue = scoped.queuedFor(agentId);
    let notes = queue.filter((m) => m.kind === "note").slice(0, MAX_NOTES);
    for (const message of queue.filter((m) => m.kind !== "note")) {
      const thread = message.threadId ? scoped.thread(message.threadId) : undefined;
      const metadata: Record<string, string> = {
        message: message.id,
        kind: message.kind,
        from: nameOf(message.fromId),
      };
      if (message.threadId) metadata.thread = message.threadId;
      try {
        const sent = await client.send(agentId, {
          body: render(message, thread, notes),
          metadata,
          // A send repeated after a crash replaces the pending copy instead of adding a second one.
          replaceKey: message.id,
        });
        scoped.tx(() => scoped.markSent([message.id, ...notes.map((n) => n.id)], sent.id));
        waiting++;
      } catch (error) {
        console.error(`dispatcher: send ${message.id} to ${agentId} failed; it stays queued:`, error);
        break;
      }
      notes = [];
    }
    // Send, then wake: the agent wakes with its work already in its inbox.
    if (phase !== "Asleep" || waiting === 0) return false;
    await client.wake(agentId);
    justWoken.add(agentId);
    return true;
  }

  async function once(): Promise<void> {
    const settings = repo.settings();
    // Nothing can be sent while everything is paused, so the run does not ask a12s for anything.
    if (settings.paused) return;
    const { candidates, awake } = await survey(Date.now());
    let woken = 0;
    let disk: number | undefined;
    // Measured once a run, and only when a wake gets that far.
    const freeDisk = () => (disk ??= freeDiskGb());
    for (const candidate of candidates) {
      if (candidate.phase === "Error") continue;
      const limits =
        candidate.phase === "Asleep"
          ? { awake: awake === null ? Infinity : awake + woken, freeDiskGb: freeDisk }
          : null;
      if (blockedReason(settings, candidate.team, candidate.spentTodayUsd, limits)) continue;
      try {
        if (await deliver(candidate)) woken++;
      } catch (error) {
        console.error(`dispatcher: delivery to ${candidate.agentId} failed:`, error);
      }
    }
  }

  return {
    // Serialized: a run asked for during a run makes that run go once more, and the caller waits for it.
    run() {
      if (running) {
        again = true;
        return running;
      }
      running = (async () => {
        try {
          do {
            again = false;
            await once();
          } while (again);
        } finally {
          running = null;
        }
      })();
      return running;
    },
  };
}
