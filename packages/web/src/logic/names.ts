function plain(name: string): string {
  return name.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/** A team slug has no hyphen (see TEAM_SLUG), so words are run together. */
export function teamSlug(name: string): string {
  return plain(name)
    .replace(/[^a-z0-9]/g, "")
    .replace(/^[0-9]+/, "")
    .slice(0, 20);
}

export function agentSlug(name: string): string {
  return plain(name)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^[^a-z]+/, "")
    .slice(0, 30)
    .replace(/-+$/, "");
}

/** "web-ux-writer" -> "Ux writer"; the team part of an agent id is never shown. */
export function displayName(id: string): string {
  if (id === "owner") return "You";
  if (id === "system") return "Studio";
  const slug = id.slice(id.indexOf("-") + 1).replaceAll("-", " ");
  return slug.charAt(0).toUpperCase() + slug.slice(1);
}
