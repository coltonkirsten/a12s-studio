import type { ErrorBody, Template } from "@a12s-studio/contract/api";
import { RESERVED_TEAM_SLUGS, TEAM_SLUG } from "@a12s-studio/contract/names";
import type { StudioState } from "@a12s-studio/contract/state";
import { useEffect, useState } from "react";
import { api, useAction } from "../api.ts";
import { teamSlug } from "../logic/names.ts";
import { href } from "../logic/route.ts";
import { Problem } from "../parts/problem.tsx";
import { Sheet } from "../parts/sheet.tsx";

const ACCENTS = [
  "#007aff",
  "#5856d6",
  "#af52de",
  "#ff2d55",
  "#ff3b30",
  "#ff9500",
  "#34c759",
  "#30b0c7",
  "#8e8e93",
] as const;

function templateName(id: string): string {
  const words = id.replaceAll("-", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function NewTeamSheet({ state, onClose }: { state: StudioState; onClose: () => void }) {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState<string | null>(null);
  const [purpose, setPurpose] = useState("");
  const [accent, setAccent] = useState<string>(
    ACCENTS.find((a) => !state.teams.some((t) => t.accent === a)) ?? ACCENTS[0],
  );
  const [templates, setTemplates] = useState<Template[]>([]);
  const [template, setTemplate] = useState<string | null>(null);
  const [loadProblem, setLoadProblem] = useState<ErrorBody | null>(null);
  const action = useAction();

  useEffect(() => {
    api.templates().then(
      (list) => {
        setTemplates(list);
        setTemplate((t) => t ?? list[0]?.id ?? null);
      },
      (problem: ErrorBody) => setLoadProblem(problem),
    );
  }, []);

  const finalSlug = slug ?? teamSlug(name);
  const slugProblem = !finalSlug
    ? null
    : !TEAM_SLUG.test(finalSlug)
      ? "Use 2 to 20 lowercase letters and digits, starting with a letter."
      : RESERVED_TEAM_SLUGS.includes(finalSlug) || state.teams.some((t) => t.id === finalSlug)
        ? "That address is taken."
        : null;
  const ready = name.trim() && purpose.trim() && finalSlug && !slugProblem && template;

  function create(): void {
    if (!ready || !template || action.pending) return;
    action.run(
      () => api.createTeam({ slug: finalSlug, name: name.trim(), purpose: purpose.trim(), accent, template }),
      () => {
        onClose();
        location.hash = href(finalSlug);
      },
    );
  }

  return (
    <Sheet title="New team" onClose={onClose}>
      <label className="field">
        <span>Name</span>
        <input value={name} placeholder="Website" onChange={(event) => setName(event.target.value)} />
      </label>
      <label className="field">
        <span>Address</span>
        <input
          className="mono"
          value={finalSlug}
          placeholder="website"
          onChange={(event) => setSlug(event.target.value.toLowerCase())}
        />
        {slugProblem && <small className="field-problem">{slugProblem}</small>}
      </label>
      <label className="field">
        <span>Purpose</span>
        <textarea
          rows={3}
          value={purpose}
          placeholder="What this team works on, in a paragraph."
          onChange={(event) => setPurpose(event.target.value)}
        />
      </label>
      <div className="field">
        <span>Colour</span>
        <fieldset className="swatches" aria-label="Colour">
          {ACCENTS.map((a) => (
            <button
              key={a}
              type="button"
              aria-pressed={a === accent}
              aria-label={a}
              className="swatch"
              style={{ background: a }}
              onClick={() => setAccent(a)}
            />
          ))}
        </fieldset>
      </div>
      <div className="field">
        <span>Start from</span>
        <fieldset className="templates" aria-label="Template">
          {templates.map((t) => (
            <button
              key={t.id}
              type="button"
              aria-pressed={t.id === template}
              className="template"
              onClick={() => {
                setTemplate(t.id);
                if (!purpose.trim()) setPurpose(t.purpose);
              }}
            >
              <b>{templateName(t.id)}</b>
              <span>{t.agents.join(", ")}</span>
            </button>
          ))}
        </fieldset>
        <Problem problem={loadProblem} />
      </div>
      <Problem problem={action.problem} />
      <div className="sheet-actions">
        <button type="button" className="button quiet" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className={action.pending ? "button primary pending" : "button primary"}
          disabled={!ready}
          onClick={create}
        >
          Create team
        </button>
      </div>
    </Sheet>
  );
}
