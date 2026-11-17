import type { IncomingMessage } from "node:http";
import { AGENT_ID, BROKER_HOST, CALLER_HEADER, teamOf } from "@a12s-studio/contract/names";

type Caller = { agentId: string; teamId: string };

// a12s stamps the header once. Two values mean something between a12s and here added one, so neither is trusted.
export function resolveCaller(req: IncomingMessage): Caller | undefined {
  const values = req.headersDistinct[CALLER_HEADER] ?? [];
  const [agentId] = values;
  if (req.headers.host !== BROKER_HOST) return undefined;
  if (values.length !== 1 || agentId === undefined || !AGENT_ID.test(agentId)) return undefined;
  return { agentId, teamId: teamOf(agentId) };
}
