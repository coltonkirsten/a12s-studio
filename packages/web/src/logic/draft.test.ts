import assert from "node:assert/strict";
import { test } from "node:test";
import type { Template } from "@a12s-studio/contract/api";
import { choose, type Draft, EMPTY_DRAFT } from "./draft.ts";

const blank: Template = { id: "blank", purpose: "", agents: ["lead"] };
const website: Template = { id: "website", purpose: "Build a site.", agents: ["lead", "dev"] };
const notes: Template = { id: "research-notes", purpose: "Compare tools.", agents: ["lead", "researcher"] };

test("choose fills what the last template filled and keeps what the owner typed", () => {
  const rows: [string, Draft, Template, { name: string; purpose: string }][] = [
    ["empty form takes the template", EMPTY_DRAFT, website, { name: "Website", purpose: "Build a site." }],
    ["blank leaves an empty form empty", EMPTY_DRAFT, blank, { name: "", purpose: "" }],
    [
      "switching replaces untouched values",
      { template: website, name: "Website", purpose: "Build a site." },
      notes,
      { name: "Research notes", purpose: "Compare tools." },
    ],
    [
      "switching to blank clears untouched values",
      { template: website, name: "Website", purpose: "Build a site." },
      blank,
      { name: "", purpose: "" },
    ],
    [
      "typed text stays",
      { template: website, name: "Shop", purpose: "Build a site." },
      notes,
      { name: "Shop", purpose: "Compare tools." },
    ],
    [
      "text typed before templates load stays",
      { ...EMPTY_DRAFT, name: "Shop" },
      website,
      { name: "Shop", purpose: "Build a site." },
    ],
  ];
  for (const [label, draft, next, want] of rows) {
    const { template, ...form } = choose(draft, next);
    assert.equal(template, next, label);
    assert.deepEqual(form, want, label);
  }
});
