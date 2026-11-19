import { ADDON_ID, addonName } from "@a12s-studio/contract/names";
import type { AddonManifest } from "@a12s-studio/contract/state";
import { z } from "zod";
import { type A12s, A12sError } from "./a12s/port.ts";
import { addonSpec, agentSpec } from "./a12s/spec.ts";
import type { BrokerClient } from "./broker-client.ts";
import { StudioError } from "./errors.ts";
import type { Repo, Team } from "./repo.ts";

// A tag or a digest: a12s pins what a tag names when it is first used, so an image is never "latest" by default.
const IMAGE = /^[^\s:@]+(?::[0-9]+)?(?:\/[^\s:@]+)*(?::[\w][\w.-]{0,127}|@sha256:[0-9a-f]{64})$/;

// Section 10.1. The broker checks each host, method and path pattern when a team turns the add-on on.
export const manifestSchema = z.strictObject({
  id: z.string().regex(ADDON_ID),
  name: z.string().trim().min(1).max(40),
  description: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .regex(/^[^\n\r]*$/, "one line"),
  image: z.string().regex(IMAGE, "an image with a tag or a digest"),
  access: z
    .array(
      z.strictObject({
        host: z.string().min(1),
        methods: z.array(z.string().min(1)).min(1),
        paths: z.array(z.string().min(1)).min(1),
      }),
    )
    .max(8),
});

const sameAccess = (a: AddonManifest, b: AddonManifest) => JSON.stringify(a.access) === JSON.stringify(b.access);

// Each step of a switch is a no-op once done, so one that failed half-way is flipped again.
async function done(step: Promise<unknown>): Promise<void> {
  try {
    await step;
  } catch (error) {
    const gone =
      (error instanceof A12sError && error.code === "not_found") ||
      (error instanceof StudioError && error.status === 404);
    if (!gone) throw error;
  }
}

// The add-on library and the two switches. Studio has no code for any particular add-on (section 10).
export function createAddons(deps: { repo: Repo; a12s: A12s; broker: BrokerClient }) {
  const { repo, a12s, broker } = deps;

  function live(teamId: string): Team {
    const team = repo.forTeam(teamId).team();
    if (!team) throw new StudioError(404, "not_found", `No team ${teamId}.`);
    return team;
  }

  function manifest(id: string): AddonManifest {
    const found = repo.addon(id);
    if (!found) throw new StudioError(404, "not_found", `No add-on ${id} in the library.`, "Add its manifest first.");
    return found;
  }

  // Every agent of the team gets a spec that uses the instances of exactly `on`.
  async function putAgents(team: Team, on: AddonManifest[]): Promise<void> {
    for (const agent of repo.forTeam(team.id).agents()) {
      await a12s.putAgent(agent.id, agentSpec(team, agent, on), "replace");
    }
  }

  async function turnOff(teamId: string, id: string): Promise<void> {
    const team = live(teamId);
    const scoped = repo.forTeam(team.id);
    const rows = scoped.addons();
    const row = rows.find((r) => r.manifest.id === id);
    await putAgents(
      team,
      rows.filter((r) => r !== row).map((r) => r.manifest),
    );
    await done(a12s.forTeam(team.a12sToken).removeService(addonName(team.id, id)));
    for (const grant of row?.grantIds ?? []) await done(broker.forTeam(team.id).revokeGrant(grant));
    scoped.deleteAddon(id);
  }

  return {
    // Replacing an add-on some team has on: a change of its outside calls is refused, so the owner sees them again at
    // the next turn-on; a new image is written to each instance before the row.
    async put(id: string, next: AddonManifest): Promise<void> {
      if (next.id !== id) {
        throw new StudioError(400, "bad_request", `The manifest's id is ${next.id}, not ${id}.`, "Make them equal.");
      }
      const before = repo.addon(id);
      const teams = repo.addonTeams(id);
      if (before && teams.length > 0 && !sameAccess(before, next)) {
        throw new StudioError(
          409,
          "in_use",
          `${teams.map((t) => t.name).join(", ")} ${teams.length === 1 ? "has" : "have"} ${id} on, and its calls changed.`,
          "Turn it off for those teams, replace it, then turn it on again.",
        );
      }
      if (before && before.image !== next.image) {
        for (const team of teams) await a12s.putService(addonName(team.id, id), addonSpec(next));
      }
      repo.putAddon(next, Date.now());
    },

    remove(id: string): void {
      manifest(id);
      const teams = repo.addonTeams(id);
      if (teams.length > 0) {
        throw new StudioError(
          409,
          "in_use",
          `${teams.map((t) => t.name).join(", ")} ${teams.length === 1 ? "has" : "have"} ${id} on.`,
          "Turn it off for those teams first.",
        );
      }
      repo.deleteAddon(id);
    },

    // Section 10.3. The row is written once the instance exists, so it is the proof the add-on is on.
    async turnOn(teamId: string, id: string): Promise<void> {
      const team = live(teamId);
      const scoped = repo.forTeam(team.id);
      const addon = manifest(id);
      const teamBroker = broker.forTeam(team.id);
      const held = new Set((await teamBroker.access()).credentials.map((c) => c.host));
      const missing = [...new Set(addon.access.map((a) => a.host))].filter((host) => !held.has(host));
      if (missing.length > 0) {
        throw new StudioError(
          409,
          "no_credential",
          `${team.name} has no credential for ${missing.join(", ")}.`,
          `Add a credential for ${missing.join(", ")} under Access, then turn ${addon.name} on.`,
        );
      }
      const rows = scoped.addons();
      const isNew = !rows.some((r) => r.manifest.id === id);
      const grantIds: string[] = [];
      try {
        if (isNew) {
          for (const { host, methods, paths } of addon.access) {
            grantIds.push((await teamBroker.createGrant({ host, methods, paths })).id);
          }
        }
        await a12s.putService(addonName(team.id, id), addonSpec(addon));
      } catch (error) {
        for (const grant of grantIds) await teamBroker.revokeGrant(grant).catch((e) => console.error(e));
        throw error;
      }
      if (isNew) scoped.insertAddon(id, grantIds, Date.now());
      await putAgents(
        team,
        scoped.addons().map((r) => r.manifest),
      );
    },

    turnOff,

    // Deleting a team turns its add-ons off first, so no instance or grant outlives it.
    async turnOffAll(teamId: string): Promise<void> {
      for (const row of repo.forTeam(teamId).addons()) await turnOff(teamId, row.manifest.id);
    },
  };
}

export type Addons = ReturnType<typeof createAddons>;
