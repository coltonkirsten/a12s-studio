/** `#/<team>/<thread>`; the thread part is a thread id, "new" for a thread being written, or "settings". */
export type Route = { team: string | null; thread: string | null; settings: boolean };

const SETTINGS = "settings";

export function parseRoute(hash: string): Route {
  const [team, part] = hash
    .replace(/^#?\/?/, "")
    .split("/")
    .map(decodeURIComponent);
  const settings = part === SETTINGS;
  return { team: team || null, thread: (!settings && part) || null, settings };
}

export function href(team?: string | null, thread?: string | null): string {
  if (!team) return "#/";
  return thread ? `#/${encodeURIComponent(team)}/${encodeURIComponent(thread)}` : `#/${encodeURIComponent(team)}`;
}

export function settingsHref(team: string): string {
  return href(team, SETTINGS);
}
