import assert from "node:assert/strict";
import { test } from "node:test";
import type { MessageKind, MessageView } from "@a12s-studio/contract/state";
import { fold } from "./fold.ts";

let n = 0;
function msg(kind: MessageKind, from: string, to: string | null): MessageView {
  n += 1;
  return { id: `m_${n}`, kind, from, to, ask: null, body: "", file: null, implicit: false, at: n };
}

function shape(messages: MessageView[]): string[] {
  return fold(messages).map((e) => (e.kind === "talk" ? e.summary : `${e.message.from}>${e.message.to}`));
}

test("fold keeps owner talk and folds runs between agents", () => {
  const rows: [MessageView[], string[]][] = [
    [[], []],
    [[msg("ask", "owner", "web-lead")], ["owner>web-lead"]],
    [
      [
        msg("ask", "owner", "web-lead"),
        msg("ask", "web-lead", "web-dev"),
        msg("note", "web-dev", "web-lead"),
        msg("reply", "web-dev", "web-lead"),
        msg("reply", "web-lead", "owner"),
      ],
      ["owner>web-lead", "Lead asked Dev · 3 messages", "web-lead>owner"],
    ],
    [[msg("reply", "web-dev", "web-lead")], ["Dev answered Lead · 1 message"]],
    [[msg("note", "web-lead", "web-ux-writer")], ["Lead told Ux writer · 1 message"]],
    [
      [msg("note", "web-lead", "web-dev"), msg("note", "web-lead", null), msg("ask", "web-dev", "web-lead")],
      ["Lead told Dev · 1 message", "web-lead>null", "Dev asked Lead · 1 message"],
    ],
    [[msg("note", "system", "web-lead")], ["system>web-lead"]],
  ];
  for (const [messages, expected] of rows) assert.deepEqual(shape(messages), expected);
});

test("a folded run keeps every message in order", () => {
  const run = [msg("ask", "web-lead", "web-dev"), msg("reply", "web-dev", "web-lead")];
  const [entry] = fold(run);
  assert.equal(entry?.kind, "talk");
  if (entry?.kind === "talk") assert.deepEqual(entry.messages, run);
});
