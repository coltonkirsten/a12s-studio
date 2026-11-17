import type { AgentSettings, PatchAgentBody } from "@a12s-studio/contract/api";

export const MODELS = ["haiku", "sonnet", "opus"] as const;

/** The Settings form as typed: every field is text, and an empty CPU or memory means a12s's default. */
export type SettingsDraft = {
  model: string;
  sleepAfterIdle: string;
  compactMinTokens: string;
  cpu: string;
  memory: string;
};

export function settingsDraft(current: AgentSettings): SettingsDraft {
  return {
    model: current.model,
    sleepAfterIdle: current.sleepAfterIdle,
    compactMinTokens: String(current.compactMinTokens),
    cpu: current.cpu === null ? "" : String(current.cpu),
    memory: current.memory ?? "",
  };
}

/** Only the fields the draft changes, or what is wrong with it. a12s judges the durations and sizes themselves. */
export function settingsPatch(
  current: AgentSettings,
  draft: SettingsDraft,
): { patch: PatchAgentBody; problem: string | null } {
  const tokens = Number(draft.compactMinTokens.trim());
  const cpu = draft.cpu.trim() === "" ? null : Number(draft.cpu.trim());
  const memory = draft.memory.trim() === "" ? null : draft.memory.trim();
  const sleepAfterIdle = draft.sleepAfterIdle.trim();
  if (sleepAfterIdle === "") return { patch: {}, problem: "Say how long it waits before it sleeps, such as 15m." };
  if (draft.compactMinTokens.trim() === "" || !Number.isInteger(tokens) || tokens < 0) {
    return { patch: {}, problem: "Compaction takes a whole number of tokens." };
  }
  if (cpu !== null && !(cpu > 0)) return { patch: {}, problem: "CPUs is a number above 0, or empty for the default." };
  const next: AgentSettings = { ...current, model: draft.model, sleepAfterIdle, compactMinTokens: tokens, cpu, memory };
  const patch: PatchAgentBody = {};
  for (const key of ["model", "sleepAfterIdle", "compactMinTokens", "cpu", "memory"] as const) {
    if (next[key] !== current[key]) Object.assign(patch, { [key]: next[key] });
  }
  return { patch, problem: null };
}
