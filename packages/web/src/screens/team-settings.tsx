import type { TeamView } from "@a12s-studio/contract/state";
import { type CSSProperties, useState } from "react";
import { api, useAccess, useAction } from "../api.ts";
import { parseUsd, usd } from "../logic/money.ts";
import { href } from "../logic/route.ts";
import { Access } from "../parts/access/access.tsx";
import { AuditLog } from "../parts/access/audit.tsx";
import { Icon } from "../parts/icons.tsx";
import { Problem } from "../parts/problem.tsx";
import { Sheet } from "../parts/sheet.tsx";
import { Switch } from "../parts/switch.tsx";
import { LimitField } from "./settings.tsx";

export function TeamSettings({ team }: { team: TeamView }) {
  const [deleting, setDeleting] = useState(false);
  const access = useAccess(team.id);
  return (
    <div className="page settings" style={{ "--accent": team.accent } as CSSProperties}>
      <header className="page-head">
        <a className="back always" href={href(team.id)}>
          <Icon name="back" /> {team.name}
        </a>
        <h1>Team settings</h1>
      </header>

      <section className="settings-section">
        <h2>Brief</h2>
        <Brief key={team.purpose} team={team} />
      </section>

      <section className="settings-section">
        <h2>Access</h2>
        <Access team={team.id} access={access} />
      </section>

      <section className="settings-section">
        <h2>Budget</h2>
        <Budget team={team} />
      </section>

      <section className="settings-section">
        <h2>Audit log</h2>
        <AuditLog team={team.id} />
      </section>

      <section className="settings-section">
        <div className="group">
          <Switch label="Pause team" on={team.paused} set={(paused) => api.patchTeam(team.id, { paused })} />
        </div>
        <button type="button" className="button quiet danger add" onClick={() => setDeleting(true)}>
          Delete team…
        </button>
      </section>

      {deleting && <DeleteTeam team={team} onClose={() => setDeleting(false)} />}
    </div>
  );
}

function Brief({ team }: { team: TeamView }) {
  const [purpose, setPurpose] = useState(team.purpose);
  const action = useAction();
  const changed = purpose.trim() !== team.purpose && purpose.trim() !== "";
  return (
    <form
      className={action.pending ? "brief pending" : "brief"}
      onSubmit={(event) => {
        event.preventDefault();
        if (changed) action.run(() => api.patchTeam(team.id, { purpose: purpose.trim() }));
      }}
    >
      <label className="field">
        <span>What the team works on. Every agent reads it.</span>
        <textarea rows={3} value={purpose} onChange={(event) => setPurpose(event.target.value)} />
      </label>
      <Problem problem={action.problem} />
      {changed && (
        <div className="form-actions">
          <button type="button" className="button quiet" onClick={() => setPurpose(team.purpose)}>
            Revert
          </button>
          <button type="submit" className="button primary">
            Save brief
          </button>
        </div>
      )}
    </form>
  );
}

function Budget({ team }: { team: TeamView }) {
  const { dailyUsd, spentTodayUsd, held } = team.budget;
  const spent = `${usd(spentTodayUsd)} spent today, at list price since local midnight.`;
  return (
    <LimitField
      key={dailyUsd}
      label="Daily budget, in dollars"
      hint={held ? `${spent} Work waits until midnight or a higher budget.` : spent}
      value={dailyUsd}
      parse={parseUsd}
      save={(dailyBudgetUsd) => api.patchTeam(team.id, { dailyBudgetUsd })}
    />
  );
}

function DeleteTeam({ team, onClose }: { team: TeamView; onClose: () => void }) {
  const action = useAction();
  return (
    <Sheet title={`Delete ${team.name}?`} onClose={onClose}>
      <p className="sheet-text">
        Its agents, threads, credentials and grants are removed. The audit log stays. This cannot be undone.
      </p>
      <Problem problem={action.problem} />
      <div className="sheet-actions">
        <button type="button" className="button quiet" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className={action.pending ? "button danger-fill pending" : "button danger-fill"}
          onClick={() => action.run(() => api.deleteTeam(team.id))}
        >
          Delete team
        </button>
      </div>
    </Sheet>
  );
}
