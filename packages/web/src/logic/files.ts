export const HOME = "/home/agent";

/** The folder a path is in; null for the home itself, which is as far up as the inspector goes. */
export function parentPath(path: string): string | null {
  return path === HOME ? null : path.slice(0, path.lastIndexOf("/"));
}

/** Each step from the home down to `path`, for the breadcrumb. */
export function crumbs(path: string): { name: string; path: string }[] {
  const steps = [{ name: "Home", path: HOME }];
  for (const name of path.slice(HOME.length).split("/").slice(1)) {
    steps.push({ name, path: `${steps.at(-1)?.path}/${name}` });
  }
  return steps;
}

export function fileSize(bytes: number): string {
  if (bytes < 1000) return `${bytes} bytes`;
  if (bytes < 1_000_000) return `${(bytes / 1000).toFixed(1)} KB`;
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}
