import assert from "node:assert/strict";
import { test } from "node:test";
import type { MessageView } from "@a12s-studio/contract/state";
import { fold } from "./fold.ts";

let n = 0;
function msg(from: string, to: string, depth = 0): MessageView {
  n += 1;
  return { id: `m_${n}`, from, to, body: "", file: null, at: n, cause: null, depth, delivered: null };
}

function shape(messages: MessageView[]): string[] {
  return fold(messages).map((e) => (e.kind === "talk" ? e.summary : `${e.message.from}>${e.message.to}`));
}

test("fold keeps the owner's talk and folds runs between agents, naming them in the order they appear", () => {
  const rows: [MessageView[], string[]][] = [
    [[], []],
    [[msg("owner", "web-lead")], ["owner>web-lead"]],
    [
      [
        msg("owner", "web-lead"),
        msg("web-lead", "web-dev", 1),
        msg("web-dev", "web-lead", 2),
        msg("web-lead", "web-dev", 2),
        msg("web-lead", "owner", 1),
      ],
      ["owner>web-lead", "Lead and Dev · 3 messages", "web-lead>owner"],
    ],
    [[msg("web-dev", "web-lead")], ["Dev and Lead · 1 message"]],
    [
      [msg("web-lead", "web-ux-writer"), msg("web-ux-writer", "web-dev"), msg("web-dev", "web-lead")],
      ["Lead, Ux writer and Dev · 3 messages"],
    ],
    [
      [msg("web-lead", "web-dev"), msg("web-lead", "owner"), msg("web-dev", "web-lead")],
      ["Lead and Dev · 1 message", "web-lead>owner", "Dev and Lead · 1 message"],
    ],
    [[msg("system", "web-lead")], ["system>web-lead"]],
  ];
  for (const [messages, expected] of rows) assert.deepEqual(shape(messages), expected);
});

test("a folded run names its depth from 3", () => {
  const rows: [number[], string][] = [
    [[1, 2], "Lead and Dev · 2 messages"],
    [[1, 2, 3], "Lead and Dev · 3 messages · 3 deep"],
    [[9, 4, 14], "Lead and Dev · 3 messages · 14 deep"],
  ];
  for (const [depths, expected] of rows) {
    const run = depths.map((depth, i) =>
      i % 2 ? msg("web-dev", "web-lead", depth) : msg("web-lead", "web-dev", depth),
    );
    assert.deepEqual(shape(run), [expected]);
  }
});

test("a folded run keeps every message in order", () => {
  const run = [msg("web-lead", "web-dev"), msg("web-dev", "web-lead")];
  const [entry] = fold(run);
  assert.equal(entry?.kind, "talk");
  if (entry?.kind === "talk") assert.deepEqual(entry.messages, run);
});
