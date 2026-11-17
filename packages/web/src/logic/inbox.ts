import type { InboxItem } from "@a12s-studio/contract/api";

/**
 * The inbox as the owner removes it: messages sent as one a12s Message (an ask and the notes riding on it) are one
 * group, in the place of the first of them; each message still queued in Studio is a group of its own.
 */
export function inboxGroups(items: InboxItem[]): InboxItem[][] {
  const groups: InboxItem[][] = [];
  const sent = new Map<string, InboxItem[]>();
  for (const item of items) {
    const group = item.sentAs === null ? undefined : sent.get(item.sentAs);
    if (group) {
      group.push(item);
      continue;
    }
    const own = [item];
    groups.push(own);
    if (item.sentAs !== null) sent.set(item.sentAs, own);
  }
  return groups;
}
