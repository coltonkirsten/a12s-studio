import assert from "node:assert/strict";
import { test } from "node:test";
import { crumbs, fileSize, HOME, parentPath } from "./files.ts";

test("parentPath stops at the home", () => {
  const rows: [string, string | null][] = [
    [HOME, null],
    [`${HOME}/memory`, HOME],
    [`${HOME}/memory/notes.md`, `${HOME}/memory`],
  ];
  for (const [path, parent] of rows) assert.equal(parentPath(path), parent, path);
});

test("crumbs walk from the home down to the path", () => {
  assert.deepEqual(crumbs(HOME), [{ name: "Home", path: HOME }]);
  assert.deepEqual(crumbs(`${HOME}/site/src`), [
    { name: "Home", path: HOME },
    { name: "site", path: `${HOME}/site` },
    { name: "src", path: `${HOME}/site/src` },
  ]);
});

test("fileSize", () => {
  const rows: [number, string][] = [
    [0, "0 bytes"],
    [999, "999 bytes"],
    [1000, "1.0 KB"],
    [15_400, "15.4 KB"],
    [2_500_000, "2.5 MB"],
  ];
  for (const [bytes, text] of rows) assert.equal(fileSize(bytes), text, String(bytes));
});
