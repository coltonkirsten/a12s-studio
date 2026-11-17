import assert from "node:assert/strict";
import { test } from "node:test";
import type { InboxItem } from "@a12s-studio/contract/api";
import { inboxGroups } from "./inbox.ts";

const item = (id: string, sentAs: string | null): InboxItem => ({
  id: `m_${id}`,
  kind: "ask",
  from: "owner",
  to: "web-dev",
  ask: null,
  body: id,
  file: null,
  implicit: false,
  at: 0,
  thread: null,
  sentAs,
});

test("inboxGroups: one group per a12s Message, one per queued message, in order", () => {
  const rows: [InboxItem[], string[][]][] = [
    [[], []],
    [
      [item("a", null), item("b", null)],
      [["a"], ["b"]],
    ],
    [
      [item("a", "x"), item("b", "y"), item("c", "y")],
      [["a"], ["b", "c"]],
    ],
    // A note queued before the ask it later rode on is listed with that ask.
    [
      [item("n", "y"), item("a", "x"), item("b", "y"), item("q", null)],
      [["n", "b"], ["a"], ["q"]],
    ],
  ];
  for (const [items, groups] of rows) {
    assert.deepEqual(
      inboxGroups(items).map((g) => g.map((m) => m.body)),
      groups,
    );
  }
});
