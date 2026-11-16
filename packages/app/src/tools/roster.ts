import { StudioError } from "../errors.ts";
import { presenceOf } from "../live.ts";
import { nameOf } from "../router.ts";
import type { Tool } from "./mcp.ts";

export const roster: Tool<Record<string, never>> = {
  name: "roster",
  description: "Who is on your team, what each one does, and who leads it.",
  input: {},
  async run({ team, caller, a12s }) {
    const row = team.team();
    if (!row) throw new StudioError(404, "not_found", "Your team no longer exists.");
    const phases = new Map((await a12s.status()).map((s) => [s.name, s.phase]));
    return {
      team: { name: row.name, purpose: row.purpose },
      you: nameOf(caller.agentId),
      lead: row.leadAgentId && nameOf(row.leadAgentId),
      agents: team.agents().map((a) => ({
        name: a.slug,
        role: a.role.split("\n")[0] ?? "",
        presence: presenceOf(phases.get(a.id)),
      })),
      owner: "owner",
    };
  },
};
