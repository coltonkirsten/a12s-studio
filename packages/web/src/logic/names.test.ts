import assert from "node:assert/strict";
import { test } from "node:test";
import { displayName } from "./names.ts";

test("displayName drops the team and capitalises", () => {
  const rows: [string, string][] = [
    ["owner", "You"],
    ["system", "Studio"],
    ["website-lead", "Lead"],
    ["notes-ux-writer", "Ux writer"],
  ];
  for (const [id, name] of rows) assert.equal(displayName(id), name);
});
