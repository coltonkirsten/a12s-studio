import type { Attention, Grant } from "@a12s-studio/contract/broker-admin";
import type { BrokerClient } from "./broker-client.ts";
import type { Dispatcher } from "./dispatcher.ts";
import { StudioError } from "./errors.ts";
import type { Repo } from "./repo.ts";
import { systemNote } from "./router.ts";

const TICK_MS = 30_000;

// The broker's last attention answer, and for each team with a pending request the hosts it has a credential for.
export type BrokerAttention = Attention & { credentialHosts: Record<string, string[]> };

const NOTHING: BrokerAttention = { requests: [], expiring: [], rejected: [], credentialHosts: {} };

// The one 30 s tick: the broker's attention items, the expiry warnings they call for, then a dispatcher run.
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

  async function tick(): Promise<void> {
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
