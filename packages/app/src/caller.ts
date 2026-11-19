import { addonOf, CALLER_HEADER, STUDIO_HOST } from "@a12s-studio/contract/names";
import { StudioError } from "./errors.ts";
import type { Repo } from "./repo.ts";

export type Caller = { agentId: string; teamId: string };

// a12s stamps the header and strips any copy the agent sent, so exactly one value is the only legitimate shape.
// `headers` is Node's headersDistinct, which keeps repeated headers apart instead of joining them.
function stamped(headers: NodeJS.Dict<string[]>): string | undefined {
  const values = headers[CALLER_HEADER] ?? [];
  const host = headers.host ?? [];
  const viaA12s = host.length === 1 && host[0] === STUDIO_HOST;
  return viaA12s && values.length === 1 ? values[0] : undefined;
}

export function resolveCaller(repo: Repo, headers: NodeJS.Dict<string[]>): Caller {
  const name = stamped(headers);
  const agent = name === undefined ? undefined : repo.callerAgent(name);
  if (!agent) throw new StudioError(403, "no_caller", "This request does not come from a current Studio agent.");
  return { agentId: agent.id, teamId: agent.teamId };
}

// An add-on instance that is on, for a current team. Its team and add-on come from its name, which a12s stamped.
export function resolveAddon(repo: Repo, headers: NodeJS.Dict<string[]>): { teamId: string; addonId: string } {
  const name = stamped(headers);
  const instance = name === undefined ? null : addonOf(name);
  if (!instance || !repo.callerAddon(instance.team, instance.addon)) {
    throw new StudioError(403, "no_caller", "This request does not come from an add-on that is on.");
  }
  return { teamId: instance.team, addonId: instance.addon };
}
