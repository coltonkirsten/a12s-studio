/** `#/<team>/<thread>`; the thread part is a thread id or "new" for a thread being written. */
export type Route = { team: string | null; thread: string | null };

export function parseRoute(hash: string): Route {
  const [team, thread] = hash
    .replace(/^#?\/?/, "")
    .split("/")
    .map(decodeURIComponent);
  return { team: team || null, thread: thread || null };
}

export function href(team?: string | null, thread?: string | null): string {
  if (!team) return "#/";
  return thread ? `#/${encodeURIComponent(team)}/${encodeURIComponent(thread)}` : `#/${encodeURIComponent(team)}`;
}
