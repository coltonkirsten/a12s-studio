import assert from "node:assert/strict";
import { test } from "node:test";
import { changes, type DiffRow, diff } from "./diff.ts";

const same = (text: string): DiffRow => ({ kind: "same", text });
const added = (text: string): DiffRow => ({ kind: "added", text });
const removed = (text: string): DiffRow => ({ kind: "removed", text });
const skip = (count: number): DiffRow => ({ kind: "skip", count });
const numbered = (n: number, change?: [number, string]) =>
  Array.from({ length: n }, (_, i) => (change && i + 1 === change[0] ? change[1] : `line ${i + 1}`)).join("\n");

test("diff shows each line as kept, added or removed, a removal before the line that replaces it", () => {
  const rows: [string, string, string, DiffRow[]][] = [
    ["a first version", "", "One.\nTwo.", [added("One."), added("Two.")]],
    ["emptied", "One.\nTwo.", "", [removed("One."), removed("Two.")]],
    ["one line changed", "a\nb\nc", "a\nx\nc", [same("a"), removed("b"), added("x"), same("c")]],
    ["a line added at the end", "a\nb", "a\nb\nc", [same("a"), same("b"), added("c")]],
    ["a line removed at the start", "a\nb\nc", "b\nc", [removed("a"), same("b"), same("c")]],
    ["a line moved", "a\nb\nc", "b\nc\na", [removed("a"), same("b"), same("c"), added("a")]],
    ["a repeated line kept once", "x\nx", "x", [same("x"), removed("x")]],
    ["an empty line is a line", "a\nb", "a\n\nb", [same("a"), added(""), same("b")]],
    ["no change", "a", "a", [same("a")]],
  ];
  for (const [name, before, after, expected] of rows) assert.deepEqual(diff(before, after), expected, name);
});

test("diff folds unchanged stretches, keeping two lines next to each change", () => {
  const rows: [string, string, string, DiffRow[]][] = [
    [
      "one change in the middle of ten lines",
      numbered(10),
      numbered(10, [5, "five"]),
      [
        skip(2),
        same("line 3"),
        same("line 4"),
        removed("line 5"),
        added("five"),
        same("line 6"),
        same("line 7"),
        skip(3),
      ],
    ],
    [
      "a fold never hides a single line",
      numbered(5),
      numbered(5, [4, "four"]),
      [same("line 1"), same("line 2"), same("line 3"), removed("line 4"), added("four"), same("line 5")],
    ],
    [
      "between two changes, five unchanged lines stay",
      numbered(7),
      numbered(7, [1, "one"]).replace("line 7", "seven"),
      [
        removed("line 1"),
        added("one"),
        same("line 2"),
        same("line 3"),
        same("line 4"),
        same("line 5"),
        same("line 6"),
        removed("line 7"),
        added("seven"),
      ],
    ],
    [
      "between two changes, six unchanged lines fold two",
      numbered(8),
      numbered(8, [1, "one"]).replace("line 8", "eight"),
      [
        removed("line 1"),
        added("one"),
        same("line 2"),
        same("line 3"),
        skip(2),
        same("line 6"),
        same("line 7"),
        removed("line 8"),
        added("eight"),
      ],
    ],
    ["an unchanged text folds whole", numbered(4), numbered(4), [skip(4)]],
  ];
  for (const [name, before, after, expected] of rows) assert.deepEqual(diff(before, after), expected, name);
});

test("changes counts the added and removed lines", () => {
  assert.deepEqual(changes(diff("a\nb\nc", "a\nx\ny\nc")), { added: 2, removed: 1 });
  assert.deepEqual(changes(diff("", "a")), { added: 1, removed: 0 });
  assert.deepEqual(changes(diff(numbered(20), numbered(20))), { added: 0, removed: 0 });
});

test("a text too large to compare line by line shows its changed middle as replaced", () => {
  const before = Array.from({ length: 2500 }, (_, i) => `a${i}`).join("\n");
  const after = Array.from({ length: 2500 }, (_, i) => `b${i}`).join("\n");
  assert.deepEqual(changes(diff(before, after)), { added: 2500, removed: 2500 });
});
