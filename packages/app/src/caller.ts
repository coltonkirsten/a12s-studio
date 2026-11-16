import { CALLER_HEADER } from "@a12s-studio/contract/names";
import { StudioError } from "./errors.ts";
import type { Repo } from "./repo.ts";

export type Caller = { agentId: string; teamId: string };

// a12s stamps the header and strips any copy the agent sent, so exactly one value is the only legitimate shape.
// `headers` is Node's headersDistinct, which keeps repeated headers apart instead of joining them.
export function resolveCaller(repo: Repo, headers: NodeJS.Dict<string[]>): Caller {
  const values = headers[CALLER_HEADER] ?? [];
  const agent = values.length === 1 && values[0] !== undefined ? repo.callerAgent(values[0]) : undefined;
  if (!agent) throw new StudioError(403, "no_caller", "This request does not come from a current Studio agent.");
  return { agentId: agent.id, teamId: agent.teamId };
}
