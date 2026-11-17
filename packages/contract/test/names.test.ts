import assert from "node:assert/strict";
import { test } from "node:test";
import { AGENT_ID, AGENT_SLUG, agentId, agentSlug, newId, TEAM_SLUG, teamOf, teamSlug } from "../src/names.ts";

test("team slugs have no hyphen and 2 to 20 characters", () => {
  for (const ok of ["web", "notes2", "a1"]) assert.match(ok, TEAM_SLUG);
  for (const bad of ["w", "web-app", "Web", "1web", "a".repeat(21)]) assert.doesNotMatch(bad, TEAM_SLUG);
});

test("agent slugs may contain hyphens", () => {
  for (const ok of ["lead", "dev-2", "a"]) assert.match(ok, AGENT_SLUG);
  for (const bad of ["-dev", "Dev", "2dev", "a".repeat(31)]) assert.doesNotMatch(bad, AGENT_SLUG);
});

test("an agent id splits back into its team at the first hyphen", () => {
  const id = agentId("web", "dev-2");
  assert.match(id, AGENT_ID);
  assert.equal(teamOf(id), "web");
});

test("ids are a prefix and 12 base32 characters", () => {
  assert.match(newId("th_"), /^th_[0-9a-hjkmnp-tv-z]{12}$/);
});

test("teamSlug runs words together, fits TEAM_SLUG and numbers a reserved or taken slug", () => {
  const taken = new Set(["website", "website2", "averylongteamnamethat"]);
  const rows: [string, string][] = [
    ["Website", "website3"],
    ["Research notes", "researchnotes"],
    ["  Café Menu! ", "cafemenu"],
    ["3D Prints", "dprints"],
    ["A very long team name that keeps going", "averylongteamnametha"],
    ["Studio", "studio2"],
    ["!!", "team"],
    ["X", "team"],
  ];
  for (const [name, slug] of rows) {
    assert.equal(
      teamSlug(name, (s) => taken.has(s)),
      slug,
      name,
    );
    assert.match(slug, TEAM_SLUG);
  }
  const full = new Set(["averylongteamnametha"]);
  assert.equal(
    teamSlug("A very long team name that keeps going", (s) => full.has(s)),
    "averylongteamnameth2",
  );
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
