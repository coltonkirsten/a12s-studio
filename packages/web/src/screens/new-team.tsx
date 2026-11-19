import type { ErrorBody, Template } from "@a12s-studio/contract/api";
import { AGENT_SLUG, agentSlug } from "@a12s-studio/contract/names";
import type { StudioState, TeamView } from "@a12s-studio/contract/state";
import { useEffect, useState } from "react";
import { api, useAccess, useAction } from "../api.ts";
import { choose, type Draft, EMPTY_DRAFT } from "../logic/draft.ts";
import { title } from "../logic/names.ts";
import { href } from "../logic/route.ts";
import { Access } from "../parts/access/access.tsx";
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

export function NewTeamSheet({ state, onClose }: { state: StudioState; onClose: () => void }) {
  const [created, setCreated] = useState<string | null>(null);
  const team = state.teams.find((t) => t.id === created);
  return team ? (
    <Baseline team={team} onClose={onClose} />
  ) : (
    <TeamForm state={state} onClose={onClose} created={setCreated} />
  );
}

type FormProps = { state: StudioState; onClose: () => void; created: (team: string) => void };

function TeamForm({ state, onClose, created }: FormProps) {
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [accent, setAccent] = useState<string>(
    ACCENTS.find((a) => !state.teams.some((t) => t.accent === a)) ?? ACCENTS[0],
  );
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loadProblem, setLoadProblem] = useState<ErrorBody | null>(null);
  const [leadName, setLeadName] = useState("Lead");
  const action = useAction();
  const { template, name, purpose } = draft;
  const lead = agentSlug(leadName);
  // The template's other agents keep their names, so the lead cannot take one of them.
  const leadTaken = template?.agents.some((slug) => slug !== "lead" && slug === lead) ?? false;

  useEffect(() => {
    api.templates().then(
      (list) => {
        setTemplates(list);
        const first = list[0];
        if (first) setDraft((d) => choose(d, first));
      },
      (problem: ErrorBody) => setLoadProblem(problem),
    );
  }, []);

  const ready = name.trim() && purpose.trim() && template && AGENT_SLUG.test(lead) && !leadTaken;

  function create(): void {
    if (!ready || !template || action.pending) return;
    action.run(
      () => api.createTeam({ name: name.trim(), purpose: purpose.trim(), accent, template: template.id, lead }),
      ({ id }) => {
        if (!id) return onClose();
        location.hash = href(id);
        created(id);
      },
    );
  }

  return (
    <Sheet title="New team" onClose={onClose}>
      <div className="field">
        <span>Start from</span>
        <fieldset className="choices" aria-label="Template">
          {templates.map((t) => (
            <button
              key={t.id}
              type="button"
              aria-pressed={t.id === template?.id}
              className="choice"
              onClick={() => setDraft((d) => choose(d, t))}
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
        <input
          value={name}
          placeholder="Name the team"
          onChange={(event) => setDraft({ ...draft, name: event.target.value })}
        />
      </label>
      <label className="field">
        <span>Purpose</span>
        <textarea
          rows={3}
          value={purpose}
          placeholder="Describe what the team works on, in a paragraph."
          onChange={(event) => setDraft({ ...draft, purpose: event.target.value })}
        />
      </label>
      <label className="field">
        <span>Lead</span>
        <input value={leadName} placeholder="Name the lead" onChange={(event) => setLeadName(event.target.value)} />
        {leadName && (
          <small className={leadTaken ? "field-problem" : "field-hint"}>
            {leadTaken
              ? `The template already has ${lead}.`
              : `Called @${lead} in threads. Messages you do not address go to the lead.`}
          </small>
        )}
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

/** The access a team starts with. Agents ask for anything more in Needs You. */
function Baseline({ team, onClose }: { team: TeamView; onClose: () => void }) {
  const access = useAccess(team.id);
  const set = Boolean(access.view?.credentials.length || access.view?.grants.length);
  return (
    <Sheet title={`What can ${team.name} reach?`} onClose={onClose}>
      <p className="sheet-text">
        Give the team a credential and grants for the hosts it needs from day one, such as the repositories it works on.
        Anything more, its agents ask you for.
      </p>
      <Access team={team.id} access={access} />
      <div className="sheet-actions">
        <button type="button" className={set ? "button primary" : "button quiet"} onClick={onClose}>
          {set ? "Done" : "Skip for now"}
        </button>
      </div>
    </Sheet>
  );
}
