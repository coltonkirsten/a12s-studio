import type { RulesPage } from "@a12s-studio/contract/api";
import type { Caller } from "./caller.ts";
import { StudioError } from "./errors.ts";
import type { RuleHistory, RuleScope, TeamRepo } from "./repo.ts";

export type Layer = RuleHistory["layer"];

// With a purpose of at most 4,000 characters, these keep every layer's document under the 10,000 characters the
// harness takes from one hook.
const LIMITS: Record<Layer, { min: number; max: number }> = {
  owner: { min: 0, max: 8000 },
  team: { min: 0, max: 4000 },
  role: { min: 1, max: 8000 },
};
const PAGE = 50;
const NONE = "None.";

// The text a layer would hold, or a refusal. Called before any a12s work that a refused role would leave behind.
export function checkBody(layer: Layer, body: string): string {
  const text = body.trim();
  const { min, max } = LIMITS[layer];
  if (text.length > max) {
    throw new StudioError(400, "too_long", `The ${layer} text is ${text.length} characters.`, `Keep it to ${max}.`);
  }
  if (text.length < min) throw new StudioError(400, "empty", `A ${layer} cannot be empty.`, "Write what it is for.");
  return text;
}

export function current(scope: RuleHistory): string | null {
  return scope.versions(1)[0]?.body ?? null;
}

// A new version holding the whole text. Nothing is updated or deleted, so a restore is a write of an older text and
// the history only grows; a text equal to the current one writes nothing.
export function write(scope: RuleScope, body: string, author: string): { version: number } {
  const text = checkBody(scope.layer, body);
  const now = scope.versions(1)[0];
  if (now?.body === text) return { version: now.id };
  return { version: scope.insert(text, author, Date.now()) };
}

export function versions(scope: RuleHistory, before?: number): RulesPage {
  const rows = scope.versions(PAGE + 1, before);
  return {
    versions: rows.slice(0, PAGE).map(({ createdAt, ...v }) => ({ ...v, at: createdAt })),
    hasMore: rows.length > PAGE,
  };
}

// The one lead check. `team` is the caller's own team's repo, so a lead can never reach past its team.
export function mayWrite(caller: Caller, team: TeamRepo): boolean {
  return team.team()?.leadAgentId === caller.agentId;
}

export function roleLine(team: TeamRepo, agentId: string): string {
  return current(team.roleRules(agentId))?.split("\n")[0] ?? "";
}

// The document `load-rules` prints for one layer of the caller's own instructions (build-spec section 6).
export function text(layer: Layer, team: TeamRepo, caller: Caller): string {
  if (layer === "owner") return `# Owner rules, for every agent\n${current(team.ownerRules()) || NONE}`;
  if (layer === "role") return `# Your role\n${current(team.roleRules(caller.agentId)) ?? NONE}`;
  const row = team.team();
  if (!row) throw new StudioError(404, "not_found", "Your team no longer exists.");
  return `# Team: ${row.name}\n\n## Purpose\n${row.purpose || NONE}\n\n## Team rules\n${current(team.teamRules()) || NONE}`;
}
