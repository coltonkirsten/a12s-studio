import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentSettings } from "@a12s-studio/contract/api";
import { type SettingsDraft, settingsDraft, settingsPatch } from "./agent-settings.ts";

const current: AgentSettings = {
  role: "Writes the code.",
  model: "sonnet",
  sleepAfterIdle: "15m",
  compactMinTokens: 100000,
  cpu: null,
  memory: null,
};

test("settingsDraft shows a12s's default as an empty field", () => {
  assert.deepEqual(settingsDraft(current), {
    model: "sonnet",
    sleepAfterIdle: "15m",
    compactMinTokens: "100000",
    cpu: "",
    memory: "",
  });
  assert.equal(settingsDraft({ ...current, cpu: 1.5, memory: "2Gi" }).cpu, "1.5");
});

test("settingsPatch sends only what changed, or says what is wrong", () => {
  const draft = settingsDraft(current);
  const sized = { ...current, cpu: 2, memory: "4Gi" };
  const rows: [AgentSettings, Partial<SettingsDraft>, object, string | null][] = [
    [current, {}, {}, null],
    [current, { model: "opus" }, { model: "opus" }, null],
    [current, { sleepAfterIdle: " 1h " }, { sleepAfterIdle: "1h" }, null],
    [current, { compactMinTokens: "50000" }, { compactMinTokens: 50000 }, null],
    [current, { cpu: "2", memory: "4Gi" }, { cpu: 2, memory: "4Gi" }, null],
    [sized, { ...settingsDraft(sized), cpu: "", memory: " " }, { cpu: null, memory: null }, null],
    [current, { sleepAfterIdle: "" }, {}, "Say how long it waits before it sleeps, such as 15m."],
    [current, { compactMinTokens: "" }, {}, "Compaction takes a whole number of tokens."],
    [current, { compactMinTokens: "1.5" }, {}, "Compaction takes a whole number of tokens."],
    [current, { compactMinTokens: "-1" }, {}, "Compaction takes a whole number of tokens."],
    [current, { cpu: "0" }, {}, "CPUs is a number above 0, or empty for the default."],
    [current, { cpu: "two" }, {}, "CPUs is a number above 0, or empty for the default."],
  ];
  for (const [from, change, patch, problem] of rows) {
    const base = from === current ? draft : settingsDraft(from);
    assert.deepEqual(settingsPatch(from, { ...base, ...change }), { patch, problem }, JSON.stringify(change));
  }
});
