import type { Attention, Grant } from "@a12s-studio/contract/broker-admin";
import type { BrokerClient } from "./broker-client.ts";
import type { Dispatcher } from "./dispatcher.ts";
import { StudioError } from "./errors.ts";
import type { Repo, Wake } from "./repo.ts";
import { systemNote } from "./router.ts";

const TICK_MS = 30_000;

// The broker's last attention answer, and for each team with a pending request the hosts it has a credential for.
type BrokerAttention = Attention & { credentialHosts: Record<string, string[]> };

const NOTHING: BrokerAttention = { requests: [], expiring: [], rejected: [], credentialHosts: {} };

// A repeat's next time: the first one after now on the wake's own cycle, so a long stop fires it once, not once
// per missed hour.
function nextDue(wake: Wake, now: number): number | null {
  if (wake.repeatSeconds === null) return null;
  const every = wake.repeatSeconds * 1000;
  return wake.dueAt + every * (Math.floor((now - wake.dueAt) / every) + 1);
}

// The one 30 s tick: due wakes, the broker's attention items, the expiry warnings they call for, then a dispatcher
// run, which delivers the wakes' asks under every limit.
export function createScheduler(deps: {
  repo: Repo;
  broker: BrokerClient;
  dispatcher: Dispatcher;
  changed: () => void;
}) {
  const { repo, broker, dispatcher, changed } = deps;
  let known = NOTHING;
  let loading: Promise<unknown> = Promise.resolve();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let ticking: Promise<void> = Promise.resolve();
  let running = false;

  // The fresh answer, or null when the broker did not give one; the last answer then stays in the state.
  async function load(): Promise<BrokerAttention | null> {
    try {
      const attention = await broker.attention();
      const credentialHosts: Record<string, string[]> = {};
      for (const teamId of new Set(attention.requests.map((r) => r.teamId))) {
        credentialHosts[teamId] = (await broker.forTeam(teamId).access()).credentials.map((c) => c.host);
      }
      const fresh = { ...attention, credentialHosts };
      if (JSON.stringify(fresh) !== JSON.stringify(known)) {
        known = fresh;
        changed();
      }
      return fresh;
    } catch (error) {
      // A broker that is down shows in the state; anything else is a fault worth a log line.
      if (!(error instanceof StudioError && error.code === "broker_down"))
        console.error("scheduler: attention:", error);
      return null;
    }
  }

  // Serialized, so an older answer never replaces a newer one.
  function refresh(): Promise<BrokerAttention | null> {
    const next = loading.then(load);
    loading = next;
    return next;
  }

  // The note goes first: if the app stops before `warned`, the lead is told twice rather than never.
  async function warn(grant: Grant & { teamId: string }): Promise<void> {
    const team = repo.forTeam(grant.teamId);
    const lead = team.team()?.leadAgentId;
    if (lead && grant.expiresAt !== null) {
      const when = new Date(grant.expiresAt).toISOString();
      systemNote(
        team,
        lead,
        `Access to ${grant.host} ${grant.paths.join(", ")} expires on ${when}. Use access to request an extension if the team still needs it.`,
      );
    }
    await broker.warned(grant.id);
  }

  // Each wake becomes its ask in the same transaction that removes or moves it, so a crash can neither lose nor
  // repeat one. A wake belongs to a current agent (removing an agent removes its wakes), so its ask is queued.
  function fireWakes(now: number): void {
    for (const wake of repo.dueWakes(now)) {
      const team = repo.forTeam(wake.teamId);
      const body = `scheduled wake ${wake.id}: ${wake.note}`;
      team.tx(() => {
        team.insertMessage(
          { threadId: wake.threadId, kind: "ask", fromId: "system", toId: wake.agentId, askId: null, body },
          "queued",
          now,
        );
        team.wakeFired(wake.id, nextDue(wake, now));
      });
    }
  }

  async function tick(): Promise<void> {
    try {
      fireWakes(Date.now());
    } catch (error) {
      console.error("scheduler: wakes:", error);
    }
    try {
      const fresh = await refresh();
      for (const grant of fresh?.expiring ?? []) {
        if (grant.warnedAt === null) await warn(grant);
      }
    } catch (error) {
      console.error("scheduler: expiry warnings:", error);
    }
    await dispatcher.run();
  }

  return {
    attention: (): BrokerAttention => known,
    refresh,
    tick,
    start(): void {
      running = true;
      const loop = () => {
        ticking = tick()
          .catch((error) => console.error("scheduler: tick:", error))
          .finally(() => {
            if (running) timer = setTimeout(loop, TICK_MS);
          });
      };
      loop();
    },
    async stop(): Promise<void> {
      running = false;
      clearTimeout(timer);
      await ticking;
    },
  };
}

export type Scheduler = ReturnType<typeof createScheduler>;
