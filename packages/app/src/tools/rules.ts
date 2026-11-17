import { z } from "zod";
import { StudioError } from "../errors.ts";
import { nameOf } from "../router.ts";
import { current, mayWrite, write } from "../rules.ts";
import type { Tool } from "./mcp.ts";

const input = {
  action: z.enum(["read", "set"]).describe("read: see the rules. set: the lead changes the team rules or a role."),
  layer: z
    .enum(["team", "role"])
    .optional()
    .describe("set: required. read: leave out for your own owner rules, team rules and role."),
  agent: z.string().optional().describe("layer role: whose role, a teammate's name from roster. Default: yours."),
  body: z.string().optional().describe("set: the whole new text. Team rules up to 4000 characters, a role 8000."),
};

function refuse(message: string, fix: string): never {
  throw new StudioError(400, "bad_field", message, fix);
}

export const rules: Tool<typeof input> = {
  name: "rules",
  description:
    "Read your rules: the owner's rules for every agent, your team's rules and your role, or a teammate's role. The team's lead also sets the team rules and roles.",
  input,
  run({ team, caller }, { action, layer, agent, body }) {
    if (agent !== undefined && layer !== "role") refuse("agent names whose role.", 'Give layer "role" with it.');
    const target = agent === undefined ? caller.agentId : team.agentBySlug(agent)?.id;
    if (target === undefined) throw new StudioError(404, "not_found", `No teammate "${agent}".`, "Use roster.");

    if (action === "read") {
      if (body !== undefined) refuse("read takes no body.", "Leave body out.");
      const texts = {
        owner: () => current(team.ownerRules()),
        team: () => current(team.teamRules()),
        role: () => current(team.roleRules(target)),
      };
      const shown = layer === undefined ? (["owner", "team", "role"] as const) : [layer];
      return Object.fromEntries(shown.map((name) => [name, texts[name]() ?? ""]));
    }

    if (layer === undefined || body === undefined) refuse("set needs layer and body.", "Give both.");
    if (!mayWrite(caller, team)) {
      const lead = team.team()?.leadAgentId;
      throw new StudioError(
        403,
        "not_lead",
        `Only your team's lead${lead ? `, ${nameOf(lead)},` : ""} changes the team rules and roles.`,
        "send the lead a message with the change you want",
      );
    }
    return write(layer === "team" ? team.teamRules() : team.roleRules(target), body, caller.agentId);
  },
};
