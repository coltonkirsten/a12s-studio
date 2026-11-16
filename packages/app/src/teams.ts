import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CreateTeamBody, HireBody, Template } from "@a12s-studio/contract/api";
import { AGENT_SLUG, agentId, RESERVED_TEAM_SLUGS, TEAM_SLUG } from "@a12s-studio/contract/names";
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

  function newAgent(team: Team, slug: string, role: string, model: string, scoped: TeamRepo): Agent {
    if (!AGENT_SLUG.test(slug) || RESERVED_AGENT_SLUGS.includes(slug)) {
      throw new StudioError(
        400,
        "bad_slug",
        `"${slug}" is not a usable agent name.`,
        'Use a lower-case letter, then up to 29 letters, digits or hyphens; not "owner" or "system".',
      );
    }
    if (scoped.slugUsed(slug)) {
      throw new StudioError(409, "slug_used", `${team.id} has had an agent named "${slug}".`, "Pick another name.");
    }
    const settings = repo.settings();
    return {
      id: agentId(team.id, slug),
      teamId: team.id,
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
    if (!paused) {
      await dispatcher.run();
      return;
    }
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
      return readdirSync(templatesDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => {
          const { roles: _, ...template } = readTemplate(e.name);
          return template;
        });
    },

    // All a12s work first and then one transaction, so a failure leaves no half-made team behind.
    async createTeam(input: CreateTeamBody): Promise<Team> {
      if (!TEAM_SLUG.test(input.slug) || RESERVED_TEAM_SLUGS.includes(input.slug)) {
        throw new StudioError(
          400,
          "bad_slug",
          `"${input.slug}" is not a usable team name.`,
          `Use a lower-case letter, then 1 to 19 letters or digits; not ${RESERVED_TEAM_SLUGS.join(", ")}.`,
        );
      }
      if (repo.teamSlugUsed(input.slug)) {
        throw new StudioError(409, "slug_used", `There has been a team named "${input.slug}".`, "Pick another name.");
      }
      const known = readdirSync(templatesDir);
      if (!known.includes(input.template)) {
        throw new StudioError(404, "not_found", `No template "${input.template}".`, `Use one of: ${known.join(", ")}.`);
      }
      const { roles } = readTemplate(input.template);
      const settings = repo.settings();
      const token = await a12s.createToken(input.slug);
      const team: Team = {
        id: input.slug,
        name: input.name,
        purpose: input.purpose,
        accent: input.accent,
        leadAgentId: agentId(input.slug, "lead"),
        dailyBudgetUsd: settings.defaultDailyBudgetUsd,
        paused: false,
        a12sToken: token,
        createdAt: Date.now(),
      };
      const scoped = repo.forTeam(team.id);
      const agents = roles.map(({ slug, role }) => newAgent(team, slug, role, settings.defaultModel, scoped));
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
    },

    async hire(teamId: string, input: HireBody): Promise<Agent> {
      const { team, scoped } = live(teamId);
      const agent = newAgent(team, input.slug, input.role, input.model, scoped);
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

    pause: (teamId: string | null) => setPaused(teamId, true),
    resume: (teamId: string | null) => setPaused(teamId, false),
  };
}
