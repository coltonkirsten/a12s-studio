import assert from "node:assert/strict";
import { test } from "node:test";
import { AGENT_SLUG, TEAM_SLUG } from "@a12s-studio/contract/names";
import { agentSlug, displayName, teamSlug } from "./names.ts";

test("teamSlug runs words together and fits TEAM_SLUG", () => {
  const rows: [string, string][] = [
    ["Website", "website"],
    ["Research notes", "researchnotes"],
    ["  Café Menu! ", "cafemenu"],
    ["3D Prints", "dprints"],
    ["A very long team name that keeps going", "averylongteamnametha"],
  ];
  for (const [name, slug] of rows) {
    assert.equal(teamSlug(name), slug, name);
    assert.match(slug, TEAM_SLUG);
  }
  assert.equal(teamSlug("!!"), "");
});

test("agentSlug joins words with hyphens and fits AGENT_SLUG", () => {
  const rows: [string, string][] = [
    ["Dev", "dev"],
    ["UX writer", "ux-writer"],
    ["  2nd  Reviewer ", "nd-reviewer"],
    ["Ünïcode Name", "unicode-name"],
    ["writer-", "writer"],
  ];
  for (const [name, slug] of rows) {
    assert.equal(agentSlug(name), slug, name);
    assert.match(slug, AGENT_SLUG);
  }
});

test("displayName drops the team and capitalises", () => {
  const rows: [string, string][] = [
    ["owner", "You"],
    ["system", "Studio"],
    ["website-lead", "Lead"],
    ["notes-ux-writer", "Ux writer"],
  ];
  for (const [id, name] of rows) assert.equal(displayName(id), name);
});
