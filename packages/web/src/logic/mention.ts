/** The "@que" being typed just before the caret, if any. */
export function mentionAt(text: string, caret: number): { start: number; query: string } | null {
  const match = /(^|\s)@([a-z0-9-]*)$/i.exec(text.slice(0, caret));
  if (!match) return null;
  const query = match[2] ?? "";
  return { start: caret - query.length - 1, query: query.toLowerCase() };
}

export function insertMention(
  text: string,
  start: number,
  caret: number,
  slug: string,
): { text: string; caret: number } {
  const before = `${text.slice(0, start)}@${slug} `;
  return { text: before + text.slice(caret).replace(/^\s+/, ""), caret: before.length };
}

/** The first @slug in the text that names one of the given agents. */
export function addressee(text: string, slugs: readonly string[]): string | null {
  for (const match of text.matchAll(/(?:^|\s)@([a-z][a-z0-9-]*)/gi)) {
    const slug = match[1]?.toLowerCase();
    if (slug && slugs.includes(slug)) return slug;
  }
  return null;
}
