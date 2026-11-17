/** "ux-writer" -> "Ux writer": how a slug reads as a name. */
export function title(slug: string): string {
  const words = slug.replaceAll("-", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** "web-ux-writer" -> "Ux writer"; the team part of an agent id is never shown. */
export function displayName(id: string): string {
  if (id === "owner") return "You";
  if (id === "system") return "Studio";
  return title(id.slice(id.indexOf("-") + 1));
}
