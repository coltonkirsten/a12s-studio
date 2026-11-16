// No hyphen in a team slug, so one team's prefix ("web-") can never cover another team's agent names.
export const TEAM_SLUG = /^[a-z][a-z0-9]{1,19}$/;
export const AGENT_SLUG = /^[a-z][a-z0-9-]{0,29}$/;
export const AGENT_ID = /^[a-z][a-z0-9]{1,19}-[a-z][a-z0-9-]{0,29}$/;
export const RESERVED_TEAM_SLUGS: readonly string[] = ["studio", "broker", "owner", "system", "a12s"];

// The four values below depend on how a12s exposes external Services (build spec, measurement M2).
export const CALLER_HEADER = "a12s-caller";
export const STUDIO_URL = "http://studio.a12s:7410";
export const BROKER_URL = "http://broker.a12s:7420";
export const TOOL_PREFIX = "mcp__a12s-studio__";

export type IdPrefix = "th_" | "m_" | "w_" | "g_" | "rq_";
export type ThreadId = `th_${string}`;
export type MessageId = `m_${string}`;
export type WakeId = `w_${string}`;
export type GrantId = `g_${string}`;
export type RequestId = `rq_${string}`;

const BASE32 = "0123456789abcdefghjkmnpqrstvwxyz";

export function newId<P extends IdPrefix>(prefix: P): `${P}${string}` {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  let id = "";
  for (const byte of bytes) id += BASE32[byte & 31];
  return `${prefix}${id}`;
}

export function teamPrefix(team: string): string {
  return `${team}-`;
}

export function agentId(team: string, slug: string): string {
  return teamPrefix(team) + slug;
}

export function teamOf(agent: string): string {
  return agent.slice(0, agent.indexOf("-"));
}
