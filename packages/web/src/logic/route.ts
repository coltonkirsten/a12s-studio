import { teamOf } from "@a12s-studio/contract/names";

/**
 * `#/<team>/<thread>?inspect=<agent>`; the thread part is a thread id, "new" for a thread being written, or
 * "settings". `inspect` names the agent whose inspector is open.
 */
export type Route = { team: string | null; thread: string | null; settings: boolean; inspect: string | null };

const SETTINGS = "settings";

export function parseRoute(hash: string): Route {
  const [path = "", query = ""] = hash.replace(/^#?\/?/, "").split("?");
  const [team, part] = path.split("/").map(decodeURIComponent);
  const settings = part === SETTINGS;
  const inspect = new URLSearchParams(query).get("inspect") || null;
  return { team: team || null, thread: (!settings && part) || null, settings, inspect };
}

export function href(team?: string | null, thread?: string | null): string {
  if (!team) return "#/";
  return thread ? `#/${encodeURIComponent(team)}/${encodeURIComponent(thread)}` : `#/${encodeURIComponent(team)}`;
}

export function settingsHref(team: string): string {
  return href(team, SETTINGS);
}

/**
 * The inspector of `agent` over the page on screen (`from`), or over the agent's team page when opened from
 * elsewhere; with a null agent, the page on screen with no inspector.
 */
export function inspectHref(agent: string | null, from?: Route): string {
  const team = agent === null ? (from?.team ?? null) : teamOf(agent);
  const here = from !== undefined && team === from.team;
  const page = here && from.settings ? settingsHref(team ?? "") : href(team, here ? from.thread : null);
  return agent === null ? page : `${page}?inspect=${encodeURIComponent(agent)}`;
}
