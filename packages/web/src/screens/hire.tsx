import { AGENT_SLUG, agentSlug } from "@a12s-studio/contract/names";
import type { Settings, TeamView } from "@a12s-studio/contract/state";
import { useState } from "react";
import { api, useAction } from "../api.ts";
import { title } from "../logic/names.ts";
import { Problem } from "../parts/problem.tsx";
import { Sheet } from "../parts/sheet.tsx";

const MODELS = ["haiku", "sonnet", "opus"] as const;

export function HireSheet({ team, settings, onClose }: { team: TeamView; settings: Settings; onClose: () => void }) {
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [model, setModel] = useState<string>(MODELS.find((m) => m === settings.defaultModel) ?? "sonnet");
  const action = useAction();
  const slug = agentSlug(name);
  const taken = team.agents.some((a) => a.slug === slug);
  const ready = AGENT_SLUG.test(slug) && !taken && role.trim();

  function hire(): void {
    if (!ready || action.pending) return;
    action.run(() => api.hire(team.id, { slug, role: role.trim(), model }), onClose);
  }

  return (
    <Sheet title={`Hire for ${team.name}`} onClose={onClose}>
      <label className="field">
        <span>Name</span>
        <input value={name} placeholder="Writer" onChange={(event) => setName(event.target.value)} />
        {name && (
          <small className={taken ? "field-problem" : "field-hint"}>
            {taken ? `${team.name} already has ${slug}.` : `Called @${slug} in threads.`}
          </small>
        )}
      </label>
      <label className="field">
        <span>Role</span>
        <textarea
          rows={4}
          value={role}
          placeholder="What this agent does and how it works with the others."
          onChange={(event) => setRole(event.target.value)}
        />
      </label>
      <div className="field">
        <span>Model</span>
        <fieldset className="segmented" aria-label="Model">
          {MODELS.map((m) => (
            <button key={m} type="button" aria-pressed={m === model} onClick={() => setModel(m)}>
              {title(m)}
            </button>
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
          onClick={hire}
        >
          Hire
        </button>
      </div>
    </Sheet>
  );
}
