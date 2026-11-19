import type { Template } from "@a12s-studio/contract/api";
import { title } from "./names.ts";

export type Draft = { template: Template | null; name: string; purpose: string };

export const EMPTY_DRAFT: Draft = { template: null, name: "", purpose: "" };

// The blank template has no purpose, and a blank team has no name until the owner gives it one.
function filled(t: Template | null): { name: string; purpose: string } {
  return { name: t?.purpose ? title(t.id) : "", purpose: t?.purpose ?? "" };
}

/** Choosing a template refills each field that still holds what the last template put there; typed text stays. */
export function choose(draft: Draft, next: Template): Draft {
  const before = filled(draft.template);
  const after = filled(next);
  return {
    template: next,
    name: draft.name === before.name ? after.name : draft.name,
    purpose: draft.purpose === before.purpose ? after.purpose : draft.purpose,
  };
}
