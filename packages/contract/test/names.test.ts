import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ADDON_ID,
  AGENT_ID,
  AGENT_SLUG,
  addonName,
  addonOf,
  agentId,
  agentSlug,
  newId,
  TEAM_SLUG,
  teamOf,
  teamSlug,
} from "../src/names.ts";

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
    ["Runs", "runs2"],
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

test("an add-on instance's name has an agent id's shape, also with the longest team and add-on ids", () => {
  const rows: [string, string][] = [
    ["web", "narrate"],
    ["a".repeat(20), "b".repeat(20)],
    ["t2", "x1"],
  ];
  for (const [team, addon] of rows) {
    assert.match(addon, ADDON_ID);
    const name = addonName(team, addon);
    assert.match(name, AGENT_ID);
    assert.equal(teamOf(name), team);
    assert.deepEqual(addonOf(name), { team, addon });
  }
});

test("addonOf answers null for every name that is not an add-on instance's", () => {
  for (const name of [
    "web-lead",
    "web-addon",
    "web-addon-",
    "web-addon-x",
    "web-addon-9x",
    "web-addon-a-b",
    "addon-x",
  ]) {
    assert.equal(addonOf(name), null, name);
  }
  for (const bad of ["x", "Narrate", "na-rrate", "1x", "a".repeat(21)]) assert.doesNotMatch(bad, ADDON_ID);
});
