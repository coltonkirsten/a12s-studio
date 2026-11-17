import type { AgentSettings } from "@a12s-studio/contract/api";
import type { AgentView } from "@a12s-studio/contract/state";
import { type ChangeEvent, useContext, useState } from "react";
import { api, Rev, useAction, useRead } from "../../api.ts";
import { MODELS, type SettingsDraft, settingsDraft, settingsPatch } from "../../logic/agent-settings.ts";
import { title } from "../../logic/names.ts";
import { Problem } from "../../parts/problem.tsx";

/** Every limit of one agent. A change reaches its computer at its next idle moment. */
export function Settings({ agent }: { agent: AgentView }) {
  const rev = useContext(Rev);
  const loaded = useRead(() => api.agent(agent.id), `${agent.id}:${rev}`);
  if (!loaded.data) return <Problem problem={loaded.problem} />;
  return <Form key={JSON.stringify(loaded.data)} agent={agent} current={loaded.data} />;
}

function Form({ agent, current }: { agent: AgentView; current: AgentSettings }) {
  const [draft, setDraft] = useState(() => settingsDraft(current));
  const action = useAction();
  const { patch, problem } = settingsPatch(current, draft);
  const changed = Object.keys(patch).length > 0;
  const models: string[] = MODELS.some((m) => m === current.model) ? [...MODELS] : [...MODELS, current.model];
  const field = (key: keyof SettingsDraft) => ({
    value: draft[key],
    onChange: (event: ChangeEvent<HTMLInputElement>) => setDraft({ ...draft, [key]: event.target.value }),
  });

  return (
    <section className="inspector-section">
      <div className="field">
        <span>Model</span>
        <fieldset className="segmented" aria-label="Model">
          {models.map((m) => (
            <button
              key={m}
              type="button"
              aria-pressed={m === draft.model}
              onClick={() => setDraft({ ...draft, model: m })}
            >
              {title(m)}
            </button>
          ))}
        </fieldset>
      </div>
      <label className="field">
        <span>Sleeps after being idle for</span>
        <input {...field("sleepAfterIdle")} />
        <small className="field-hint">Such as 15m or 1h.</small>
      </label>
      <label className="field">
        <span>Compacts before sleep from</span>
        <input inputMode="numeric" {...field("compactMinTokens")} />
        <small className="field-hint">Tokens in its session.</small>
      </label>
      <div className="field-pair">
        <label className="field">
          <span>CPUs</span>
          <input inputMode="decimal" placeholder="Default" {...field("cpu")} />
        </label>
        <label className="field">
          <span>Memory</span>
          <input placeholder="Default" {...field("memory")} />
          <small className="field-hint">Such as 4Gi.</small>
        </label>
      </div>
      {problem && <p className="field-problem">{problem}</p>}
      <Problem problem={action.problem} />
      <div className="inspector-actions">
        <button
          type="button"
          className={action.pending ? "button primary pending" : "button primary"}
          disabled={!changed || problem !== null}
          onClick={() => action.run(() => api.patchAgent(agent.id, patch))}
        >
          Save
        </button>
      </div>
      <p className="inspector-quiet">Saved settings reach {title(agent.slug)} at its next idle moment.</p>
    </section>
  );
}
