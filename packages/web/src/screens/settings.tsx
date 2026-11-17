import type { WriteResult } from "@a12s-studio/contract/api";
import type { Settings } from "@a12s-studio/contract/state";
import { useState } from "react";
import { api, useAction } from "../api.ts";
import { MODELS } from "../logic/agent-settings.ts";
import { parseUsd } from "../logic/money.ts";
import { title } from "../logic/names.ts";
import { Problem } from "../parts/problem.tsx";
import { Sheet } from "../parts/sheet.tsx";
import { Versions } from "../parts/versions.tsx";

const SLEEPS = ["5m", "15m", "30m", "1h", "2h"];

const whole = (min: number, max: number) => (text: string) => {
  const value = Number(text.trim());
  return text.trim() !== "" && Number.isInteger(value) && value >= min && value <= max ? value : null;
};
const amount = (text: string) => {
  const value = Number(text.trim());
  return text.trim() !== "" && Number.isFinite(value) && value >= 0 ? value : null;
};

type LimitProps = {
  label: string;
  hint: string;
  value: number;
  parse: (text: string) => number | null;
  save: (value: number) => Promise<WriteResult>;
};

/** A number the server keeps. It is saved on Enter or when the field is left, and shows as saving until the state
 * that holds it arrives. Keyed by the server's value by its parent, so a change from elsewhere replaces the draft. */
export function LimitField({ label, hint, value, parse, save }: LimitProps) {
  const [text, setText] = useState(String(value));
  const action = useAction();
  const parsed = parse(text);

  function commit(): void {
    if (parsed !== null && parsed !== value && !action.pending) action.run(() => save(parsed));
  }

  return (
    <form
      className={action.pending ? "pending" : undefined}
      onSubmit={(event) => {
        event.preventDefault();
        commit();
      }}
    >
      <label className="field">
        <span>{label}</span>
        <input inputMode="decimal" value={text} onChange={(e) => setText(e.target.value)} onBlur={commit} />
        <small className={parsed === null ? "field-problem" : "field-hint"}>{hint}</small>
      </label>
      <Problem problem={action.problem} />
    </form>
  );
}

function Choice({
  label,
  options,
  value,
  save,
}: {
  label: string;
  options: readonly string[];
  value: string;
  save: (value: string) => Promise<WriteResult>;
}) {
  const action = useAction();
  const shown = options.includes(value) ? options : [...options, value];
  return (
    <div className={action.pending ? "field pending" : "field"}>
      <span>{label}</span>
      <fieldset className="segmented" aria-label={label}>
        {shown.map((option) => (
          <button
            key={option}
            type="button"
            aria-pressed={option === value}
            onClick={() => option !== value && action.run(() => save(option))}
          >
            {title(option)}
          </button>
        ))}
      </fieldset>
      <Problem problem={action.problem} />
    </div>
  );
}

/** The global limits and the defaults new teams and agents start with. Each applies as soon as it is saved. */
export function SettingsSheet({ settings, onClose }: { settings: Settings; onClose: () => void }) {
  const patch = api.patchSettings;
  return (
    <Sheet title="Settings" onClose={onClose}>
      <LimitField
        key={`cap${settings.awakeCap}`}
        label="Agents awake at once"
        hint="From 1 to 64. More wait their turn; your own messages go first."
        value={settings.awakeCap}
        parse={whole(1, 64)}
        save={(awakeCap) => patch({ awakeCap })}
      />
      <LimitField
        key={`disk${settings.minFreeDiskGb}`}
        label="Free disk to keep, in GB"
        hint="No agent is woken while less is free on the home folder's disk."
        value={settings.minFreeDiskGb}
        parse={amount}
        save={(minFreeDiskGb) => patch({ minFreeDiskGb })}
      />
      <LimitField
        key={`budget${settings.defaultDailyBudgetUsd}`}
        label="Daily budget for a new team, in dollars"
        hint="Each team's own budget is in its settings."
        value={settings.defaultDailyBudgetUsd}
        parse={parseUsd}
        save={(defaultDailyBudgetUsd) => patch({ defaultDailyBudgetUsd })}
      />
      <Choice
        label="Model for a new agent"
        options={MODELS}
        value={settings.defaultModel}
        save={(defaultModel) => patch({ defaultModel })}
      />
      <Choice
        label="A new agent sleeps after idling for"
        options={SLEEPS}
        value={settings.defaultSleepAfterIdle}
        save={(defaultSleepAfterIdle) => patch({ defaultSleepAfterIdle })}
      />
      <LimitField
        key={`compact${settings.defaultCompactMinTokens}`}
        label="A new agent compacts before sleep from this many tokens"
        hint="Its conversation is summarised first, so it wakes with less to read."
        value={settings.defaultCompactMinTokens}
        parse={whole(0, 10_000_000)}
        save={(defaultCompactMinTokens) => patch({ defaultCompactMinTokens })}
      />
      <section className="sheet-section">
        <h3>Rules for every agent</h3>
        <Versions
          id="owner"
          label="Every agent of every team follows these. Each gets a change with its next message."
          load={api.rules}
          save={api.putRules}
        />
      </section>
      <div className="sheet-actions">
        <button type="button" className="button primary" onClick={onClose}>
          Done
        </button>
      </div>
    </Sheet>
  );
}
