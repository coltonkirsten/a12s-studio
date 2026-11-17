import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CreateTeamBody, HireBody, PatchAgentBody, PatchTeamBody, Template } from "@a12s-studio/contract/api";
import { AGENT_SLUG, agentId, teamSlug } from "@a12s-studio/contract/names";
import { type A12s, A12sError } from "./a12s/port.ts";
import { agentSpec } from "./a12s/spec.ts";
import type { BrokerClient } from "./broker-client.ts";
import type { Dispatcher } from "./dispatcher.ts";
import { StudioError } from "./errors.ts";
import type { Agent, Repo, Team, TeamRepo } from "./repo.ts";
import { systemMessage } from "./router.ts";
import { checkBody, write } from "./rules.ts";

// Names that mean something else wherever an agent can be addressed.
const RESERVED_AGENT_SLUGS = ["owner", "system"];
const PAUSED_WHILE_WORKING =
  "You were paused while working, and any background work was stopped. Continue where you stopped.";

type TemplateFiles = Template & { roles: { slug: string; role: string }[] };

export function createTeams(deps: {
  repo: Repo;
  a12s: A12s;
  broker: BrokerClient;
  dispatcher: Dispatcher;
  templatesDir: string;
}) {
  const { repo, a12s, broker, dispatcher, templatesDir } = deps;
  // Slugs of creates under way; their rows are written only after the a12s work.
  const creating = new Set<string>();

  function readTemplate(id: string): TemplateFiles {
    const dir = join(templatesDir, id);
    const read = (file: string) => readFileSync(join(dir, file), "utf8").trim();
    const slugs = readdirSync(join(dir, "roles"))
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.slice(0, -3))
      .sort((a, b) => Number(b === "lead") - Number(a === "lead") || a.localeCompare(b));
    const roles = slugs.map((slug) => ({ slug, role: read(`roles/${slug}.md`) }));
    return { id, purpose: read("brief.md"), agents: slugs, roles };
  }

  function live(teamId: string): { team: Team; scoped: TeamRepo } {
    const scoped = repo.forTeam(teamId);
    const team = scoped.team();
    if (!team) throw new StudioError(404, "not_found", `No team ${teamId}.`);
    return { team, scoped };
  }

  function templateIds(): string[] {
    return readdirSync(templatesDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort((a, b) => Number(b === "blank") - Number(a === "blank") || a.localeCompare(b));
  }

  // The agent's row and its role, checked before any a12s work so a refusal leaves nothing behind.
  function newAgent(scoped: TeamRepo, teamId: string, slug: string, role: string, model: string) {
    if (!AGENT_SLUG.test(slug) || RESERVED_AGENT_SLUGS.includes(slug)) {
      throw new StudioError(
        400,
        "bad_slug",
        `"${slug}" is not a usable agent name.`,
        'Use a lower-case letter, then up to 29 letters, digits or hyphens; not "owner" or "system".',
      );
    }
    if (scoped.slugUsed(slug)) {
      throw new StudioError(409, "slug_used", `${teamId} has had an agent named "${slug}".`, "Pick another name.");
    }
    const settings = repo.settings();
    const agent: Agent = {
      id: agentId(teamId, slug),
      teamId,
      slug,
      model,
      sleepAfterIdle: settings.defaultSleepAfterIdle,
      compactMinTokens: settings.defaultCompactMinTokens,
      cpu: null,
      memory: null,
      createdAt: Date.now(),
    };
    return { agent, role: checkBody("role", role) };
  }

  // An agent's row and its first role version, written together.
  function insertAgent(scoped: TeamRepo, agent: Agent, role: string): void {
    scoped.insertAgent(agent);
    write(scoped.roleRules(agent.id), role, "owner");
  }

  // Removing an agent computer that is already gone counts as done, so a failed delete can be run again.
  async function removeComputer(team: Team, id: string): Promise<void> {
    try {
      await a12s.forTeam(team.a12sToken).removeAgent(id);
    } catch (error) {
      if (!(error instanceof A12sError && error.code === "not_found")) throw error;
    }
  }

  async function setPaused(teamId: string | null, paused: boolean): Promise<void> {
    const teams = teamId === null ? repo.teams() : [live(teamId).team];
    if (teamId === null) repo.updateSettings({ paused });
    else repo.forTeam(teamId).setPaused(paused);
    // On resume this delivers what was held. On pause it lets a run that read the old flag finish first, so
    // nothing is woken after the sleeps below.
    await dispatcher.run();
    if (!paused) return;
    const failures: string[] = [];
    for (const team of teams) {
      const client = a12s.forTeam(team.a12sToken);
      try {
        for (const { name, phase, background } of await client.status()) {
          if (phase === "Asleep") continue;
          // Queued now, held by the pause, delivered first thing on resume.
          if (phase === "Busy" || background.length > 0)
            systemMessage(repo.forTeam(team.id), name, PAUSED_WHILE_WORKING);
          await client.sleep(name);
        }
      } catch (error) {
        failures.push(`${team.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (failures.length > 0) {
      throw new StudioError(
        502,
        "a12s_failed",
        `Paused, but some agents may still be awake (${failures.join("; ")}).`,
        "Pause again once a12s answers.",
      );
    }
  }

  return {
    templates(): Template[] {
      return templateIds().map((id) => {
        const { roles: _, ...template } = readTemplate(id);
        return template;
      });
    },

    // All a12s work first and then one transaction, so a failure leaves no half-made team behind. The slug is
    // claimed before the first await, so a create running alongside picks another and can never remove this
    // one's token or agent computers when it fails.
    async createTeam(input: CreateTeamBody): Promise<Team> {
      const known = templateIds();
      if (!known.includes(input.template)) {
        throw new StudioError(404, "not_found", `No template "${input.template}".`, `Use one of: ${known.join(", ")}.`);
      }
      const id = teamSlug(input.name, (slug) => creating.has(slug) || repo.teamSlugUsed(slug));
      const { roles } = readTemplate(input.template);
      const settings = repo.settings();
      const scoped = repo.forTeam(id);
      const hired = roles.map(({ slug, role }) => newAgent(scoped, id, slug, role, settings.defaultModel));
      creating.add(id);
      try {
        const token = await a12s.createToken(id);
        const team: Team = {
          id,
          name: input.name,
          purpose: input.purpose,
          accent: input.accent,
          leadAgentId: agentId(id, "lead"),
          dailyBudgetUsd: settings.defaultDailyBudgetUsd,
          paused: false,
          a12sToken: token,
          createdAt: Date.now(),
        };
        const created: Agent[] = [];
        try {
          for (const { agent } of hired) {
            await a12s.putAgent(agent.id, agentSpec(team, agent), "create");
            created.push(agent);
          }
        } catch (error) {
          for (const agent of created) await removeComputer(team, agent.id).catch((e) => console.error(e));
          await a12s.removeToken(team.id).catch((e) => console.error(e));
          throw error;
        }
        repo.tx(() => {
          repo.insertTeam(team);
          for (const { agent, role } of hired) insertAgent(scoped, agent, role);
        });
        return team;
      } finally {
        creating.delete(id);
      }
    },

    async hire(teamId: string, input: HireBody): Promise<Agent> {
      const { team, scoped } = live(teamId);
      const { agent, role } = newAgent(scoped, team.id, input.slug, input.role, input.model);
      await a12s.putAgent(agent.id, agentSpec(team, agent), "create");
      scoped.tx(() => insertAgent(scoped, agent, role));
      return agent;
    },

    async fire(teamId: string, id: string): Promise<void> {
      const { team, scoped } = live(teamId);
      if (!scoped.agent(id)) throw new StudioError(404, "not_found", `No agent ${id} on ${teamId}.`);
      if (team.leadAgentId === id) {
        throw new StudioError(
          409,
          "is_lead",
          `${id} leads ${teamId}.`,
          "A team keeps its lead; delete the team instead.",
        );
      }
      await removeComputer(team, id);
      scoped.tx(() => scoped.removeAgent(id, Date.now()));
    },

    // The broker first: if the purge fails the team stays, so its credentials are never left with no team to remove
    // them from.
    async deleteTeam(teamId: string): Promise<void> {
      const { team, scoped } = live(teamId);
      await broker.forTeam(team.id).purge();
      for (const agent of scoped.agents()) await removeComputer(team, agent.id);
      await a12s.removeToken(team.id);
      scoped.markDeleted(Date.now());
    },

    // A new name is in every agent's instructions, so it reaches them as a fresh spec, which a12s applies at their
    // next idle moment. The brief is loaded by the team layer's hook and needs none.
    async patchTeam(teamId: string, patch: Pick<PatchTeamBody, "name" | "purpose" | "accent" | "dailyBudgetUsd">) {
      const { team, scoped } = live(teamId);
      const next = { ...team, ...patch };
      if (next.name !== team.name) {
        for (const agent of scoped.agents()) await a12s.putAgent(agent.id, agentSpec(next, agent), "replace");
      }
      scoped.updateTeam(patch);
      await dispatcher.run();
    },

    // A setting changes the row only once a12s has taken the spec, so the two never disagree. A role is a new
    // version and no spec: the hook loads it with the agent's next message.
    async patchAgent(teamId: string, id: string, { role, ...settings }: PatchAgentBody): Promise<void> {
      const { team, scoped } = live(teamId);
      const agent = scoped.agent(id);
      if (!agent) throw new StudioError(404, "not_found", `No agent ${id} on ${teamId}.`);
      if (role !== undefined) checkBody("role", role);
      if (Object.keys(settings).length > 0) {
        const next = { ...agent, ...settings };
        await a12s.putAgent(id, agentSpec(team, next), "replace");
        scoped.updateAgent(next);
      }
      if (role !== undefined) write(scoped.roleRules(id), role, "owner");
    },

    // Section 6: every agent's spec, put again at each start so that a spec a release of Studio has changed reaches
    // every agent. a12s compares a spec's hash with what runs and leaves an unchanged agent computer alone.
    async putSpecs(): Promise<void> {
      for (const team of repo.teams()) {
        for (const agent of repo.forTeam(team.id).agents()) {
          try {
            await a12s.putAgent(agent.id, agentSpec(team, agent), "replace");
          } catch (error) {
            console.error(`teams: putting the spec of ${agent.id} again failed:`, error);
          }
        }
      }
    },

    pause: (teamId: string | null) => setPaused(teamId, true),
    resume: (teamId: string | null) => setPaused(teamId, false),
  };
}
