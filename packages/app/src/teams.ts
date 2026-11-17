import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CreateTeamBody, HireBody, PatchTeamBody, Template } from "@a12s-studio/contract/api";
import { AGENT_SLUG, agentId, teamSlug } from "@a12s-studio/contract/names";
import { type A12s, A12sError } from "./a12s/port.ts";
import { agentSpec } from "./a12s/spec.ts";
import type { Dispatcher } from "./dispatcher.ts";
import { StudioError } from "./errors.ts";
import type { Agent, Repo, Team, TeamRepo } from "./repo.ts";
import { systemAsk } from "./router.ts";

// Names that mean something else wherever an agent can be addressed.
const RESERVED_AGENT_SLUGS = ["owner", "system"];
const PAUSED_MID_TURN = "You were paused mid-turn. Continue where you stopped.";

type TemplateFiles = Template & { roles: { slug: string; role: string }[] };

export function createTeams(deps: { repo: Repo; a12s: A12s; dispatcher: Dispatcher; templatesDir: string }) {
  const { repo, a12s, dispatcher, templatesDir } = deps;
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

  function newAgent(scoped: TeamRepo, teamId: string, slug: string, role: string, model: string): Agent {
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
    return {
      id: agentId(teamId, slug),
      teamId,
      slug,
      role,
      model,
      sleepAfterIdle: settings.defaultSleepAfterIdle,
      compactMinTokens: settings.defaultCompactMinTokens,
      cpu: null,
      memory: null,
      createdAt: Date.now(),
    };
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
        for (const { name, phase } of await client.status()) {
          if (phase === "Asleep") continue;
          // Queued now, held by the pause, delivered first thing on resume.
          if (phase === "Busy") systemAsk(repo.forTeam(team.id), name, PAUSED_MID_TURN);
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
      const agents = roles.map(({ slug, role }) => newAgent(scoped, id, slug, role, settings.defaultModel));
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
          for (const agent of agents) {
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
          for (const agent of agents) scoped.insertAgent(agent);
        });
        return team;
      } finally {
        creating.delete(id);
      }
    },

    async hire(teamId: string, input: HireBody): Promise<Agent> {
      const { team, scoped } = live(teamId);
      const agent = newAgent(scoped, team.id, input.slug, input.role, input.model);
      await a12s.putAgent(agent.id, agentSpec(team, agent), "create");
      scoped.insertAgent(agent);
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

    async deleteTeam(teamId: string): Promise<void> {
      const { team, scoped } = live(teamId);
      for (const agent of scoped.agents()) await removeComputer(team, agent.id);
      await a12s.removeToken(team.id);
      scoped.markDeleted(Date.now());
    },

    // A new brief or role reaches the agent computer as a fresh spec, which a12s applies at its next idle moment.
    async patchTeam(teamId: string, patch: Pick<PatchTeamBody, "name" | "purpose" | "accent" | "dailyBudgetUsd">) {
      const { team, scoped } = live(teamId);
      const next = { ...team, ...patch };
      if (next.name !== team.name || next.purpose !== team.purpose) {
        for (const agent of scoped.agents()) await a12s.putAgent(agent.id, agentSpec(next, agent), "replace");
      }
      scoped.updateTeam(patch);
      await dispatcher.run();
    },

    async patchAgent(teamId: string, id: string, patch: { role?: string; model?: string }): Promise<void> {
      const { team, scoped } = live(teamId);
      const agent = scoped.agent(id);
      if (!agent) throw new StudioError(404, "not_found", `No agent ${id} on ${teamId}.`);
      await a12s.putAgent(id, agentSpec(team, { ...agent, ...patch }), "replace");
      scoped.updateAgent(id, patch);
    },

    pause: (teamId: string | null) => setPaused(teamId, true),
    resume: (teamId: string | null) => setPaused(teamId, false),
  };
}
