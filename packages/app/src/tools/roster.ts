import type { Presence } from "@a12s-studio/contract/state";
import type { Phase } from "../a12s/port.ts";
import { StudioError } from "../errors.ts";
import { nameOf } from "../router.ts";
import type { Tool } from "./mcp.ts";

function presence(phase: Phase | undefined): Presence {
  if (phase === "Asleep") return "asleep";
  if (phase === "Busy") return "working";
  if (phase === "Error" || phase === undefined) return "error";
  return "awake";
}

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
        presence: presence(phases.get(a.id)),
      })),
      owner: "owner",
    };
  },
};
