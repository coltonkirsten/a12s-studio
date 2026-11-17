import type { ErrorBody, Template } from "@a12s-studio/contract/api";
import type { StudioState } from "@a12s-studio/contract/state";
import { useEffect, useState } from "react";
import { api, useAction } from "../api.ts";
import { title } from "../logic/names.ts";
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

// A template fills the form with its name and brief; the blank one has no brief and leaves the form empty.
function filled(t: Template): { name: string; purpose: string } {
  return t.purpose ? { name: title(t.id), purpose: t.purpose } : { name: "", purpose: "" };
}

export function NewTeamSheet({ state, onClose }: { state: StudioState; onClose: () => void }) {
  const [name, setName] = useState("");
  const [purpose, setPurpose] = useState("");
  const [accent, setAccent] = useState<string>(
    ACCENTS.find((a) => !state.teams.some((t) => t.accent === a)) ?? ACCENTS[0],
  );
  const [templates, setTemplates] = useState<Template[]>([]);
  const [template, setTemplate] = useState<Template | null>(null);
  const [loadProblem, setLoadProblem] = useState<ErrorBody | null>(null);
  const action = useAction();

  // A field the owner has typed in keeps their text; one still holding the old template's value takes the new one.
  function pick(next: Template): void {
    const before = template ? filled(template) : { name: "", purpose: "" };
    const after = filled(next);
    if (name === before.name) setName(after.name);
    if (purpose === before.purpose) setPurpose(after.purpose);
    setTemplate(next);
  }

  useEffect(() => {
    api.templates().then(
      (list) => {
        setTemplates(list);
        const first = list[0];
        if (!first) return;
        setTemplate(first);
        setName(filled(first).name);
        setPurpose(filled(first).purpose);
      },
      (problem: ErrorBody) => setLoadProblem(problem),
    );
  }, []);

  const ready = name.trim() && purpose.trim() && template;

  function create(): void {
    if (!ready || !template || action.pending) return;
    action.run(
      () => api.createTeam({ name: name.trim(), purpose: purpose.trim(), accent, template: template.id }),
      ({ id }) => {
        onClose();
        if (id) location.hash = href(id);
      },
    );
  }

  return (
    <Sheet title="New team" onClose={onClose}>
      <div className="field">
        <span>Start from</span>
        <fieldset className="templates" aria-label="Template">
          {templates.map((t) => (
            <button
              key={t.id}
              type="button"
              aria-pressed={t.id === template?.id}
              className="template"
              onClick={() => pick(t)}
            >
              <b>{title(t.id)}</b>
              <span>{t.agents.join(", ")}</span>
            </button>
          ))}
        </fieldset>
        <Problem problem={loadProblem} />
      </div>
      <label className="field">
        <span>Name</span>
        <input value={name} placeholder="Name the team" onChange={(event) => setName(event.target.value)} />
      </label>
      <label className="field">
        <span>Purpose</span>
        <textarea
          rows={3}
          value={purpose}
          placeholder="Describe what the team works on, in a paragraph."
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
