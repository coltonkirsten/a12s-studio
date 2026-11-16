import type { WaitingFor } from "@a12s-studio/contract/state";
import type { A12s, Phase, TeamA12s } from "./a12s/port.ts";
import type { Message, Repo, Team, TeamRepo, Thread } from "./repo.ts";
import { nameOf } from "./router.ts";

export type Dispatcher = { run(): Promise<void> };

type Candidate = {
  team: Team;
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

// Why a candidate gets nothing this run. The one place a hold is decided, so presence can show the same reason.
function blockedReason(team: Team): WaitingFor | null {
  return team.paused ? "paused" : null;
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

  async function candidates(): Promise<Candidate[]> {
    const found: Candidate[] = [];
    for (const team of repo.teams()) {
      const scoped = repo.forTeam(team.id);
      const queued = scoped.dispatchable();
      const client = a12s.forTeam(team.a12sToken);
      let status: Awaited<ReturnType<TeamA12s["status"]>>;
      try {
        status = await client.status();
      } catch (error) {
        console.error(`dispatcher: status of team ${team.id} failed:`, error);
        continue;
      }
      for (const { name, phase, pending } of status) {
        const order = queued.get(name);
        // An asleep agent with pending a12s Messages was put to sleep before it took them (pause): wake it.
        if (!order && !(phase === "Asleep" && pending > 0)) continue;
        found.push({
          team,
          scoped,
          client,
          agentId: name,
          phase,
          pending,
          ...(order ?? { fromOwner: false, oldest: Infinity }),
        });
      }
    }
    return found.sort((a, b) => Number(b.fromOwner) - Number(a.fromOwner) || a.oldest - b.oldest);
  }

  async function deliver({ scoped, client, agentId, phase, pending }: Candidate): Promise<void> {
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
    if (phase === "Asleep" && waiting > 0) await client.wake(agentId);
  }

  async function once(): Promise<void> {
    if (repo.settings().paused) return;
    for (const candidate of await candidates()) {
      if (blockedReason(candidate.team) || candidate.phase === "Error") continue;
      try {
        await deliver(candidate);
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
