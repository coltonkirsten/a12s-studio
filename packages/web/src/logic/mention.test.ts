import assert from "node:assert/strict";
import { test } from "node:test";
import { addressee, insertMention, mentionAt } from "./mention.ts";

test("mentionAt finds the @word before the caret", () => {
  const rows: [string, number, { start: number; query: string } | null][] = [
    ["@", 1, { start: 0, query: "" }],
    ["hi @De", 6, { start: 3, query: "de" }],
    ["hi @dev and", 7, { start: 3, query: "dev" }],
    ["hi @dev and", 11, null],
    ["mail@example", 12, null],
    ["line\n@le", 8, { start: 5, query: "le" }],
    ["", 0, null],
  ];
  for (const [text, caret, expected] of rows) assert.deepEqual(mentionAt(text, caret), expected, text);
});

test("insertMention replaces the partial word and leaves one space", () => {
  assert.deepEqual(insertMention("ask @d", 4, 6, "dev"), { text: "ask @dev ", caret: 9 });
  assert.deepEqual(insertMention("@l please", 0, 2, "lead"), { text: "@lead please", caret: 6 });
});

test("addressee is the first mention of a known agent", () => {
  const slugs = ["lead", "dev", "ux-writer"];
  const rows: [string, string | null][] = [
    ["no mention", null],
    ["@dev fix it", "dev"],
    ["@nobody then @Lead", "lead"],
    ["cc @ux-writer and @dev", "ux-writer"],
    ["mail@dev.example", null],
  ];
  for (const [text, slug] of rows) assert.equal(addressee(text, slugs), slug, text);
});
