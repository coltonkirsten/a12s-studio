import type { IncomingMessage } from "node:http";
import { AGENT_ID, BROKER_URL, CALLER_HEADER, teamOf } from "@a12s-studio/contract/names";

type Caller = { agentId: string; teamId: string };

// a12s passes on the Host the agent called. A web page in the owner's browser that reaches this port through a
// DNS name of its own can set any header but this one.
const VIA_A12S = new URL(BROKER_URL).host;

// a12s stamps the header once. Two values mean something between a12s and here added one, so neither is trusted.
export function resolveCaller(req: IncomingMessage): Caller | undefined {
  const values = req.headersDistinct[CALLER_HEADER] ?? [];
  const [agentId] = values;
  if (req.headers.host !== VIA_A12S) return undefined;
  if (values.length !== 1 || agentId === undefined || !AGENT_ID.test(agentId)) return undefined;
  return { agentId, teamId: teamOf(agentId) };
}
