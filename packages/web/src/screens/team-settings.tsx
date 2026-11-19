import type { AddonManifest, TeamAddon, TeamView } from "@a12s-studio/contract/state";
import { type CSSProperties, useState } from "react";
import { type AccessState, type Action, api, Rev, useAccess, useAction } from "../api.ts";
import { missingHosts } from "../logic/addons.ts";
import { parseUsd, usd } from "../logic/money.ts";
import { href } from "../logic/route.ts";
import { Access } from "../parts/access/access.tsx";
import { AuditLog } from "../parts/access/audit.tsx";
import { CredentialForm } from "../parts/access/credentials.tsx";
import { GrantLines } from "../parts/access/grants.tsx";
import { Icon } from "../parts/icons.tsx";
import { Problem } from "../parts/problem.tsx";
import { Sheet } from "../parts/sheet.tsx";
import { Switch, SwitchButton } from "../parts/switch.tsx";
import { Versions } from "../parts/versions.tsx";
import { LimitField } from "./settings.tsx";

export function TeamSettings({ team, library }: { team: TeamView; library: AddonManifest[] }) {
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
        <h2>Purpose</h2>
        <Purpose key={team.purpose} team={team} />
      </section>

      <section className="settings-section">
        <h2>Rules</h2>
        <Versions
          id={team.id}
          label="How this team works. You and the team's lead write them; each agent gets a change with its next message."
          load={(before) => api.teamRules(team.id, before)}
          save={(body) => api.putTeamRules(team.id, body)}
        />
      </section>

      <section className="settings-section">
        <h2>Access</h2>
        <Access team={team.id} access={access} />
      </section>

      <section className="settings-section">
        <h2>Add-ons</h2>
        <Addons team={team} library={library} access={access} />
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

function Purpose({ team }: { team: TeamView }) {
  const [purpose, setPurpose] = useState(team.purpose);
  const action = useAction();
  const changed = purpose.trim() !== team.purpose && purpose.trim() !== "";
  return (
    <form
      className={action.pending ? "purpose pending" : "purpose"}
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
            Save purpose
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

function Addons({ team, library, access }: { team: TeamView; library: AddonManifest[]; access: AccessState }) {
  if (library.length === 0) {
    return <p className="part-hint">The library has no add-ons yet. They are added in Settings.</p>;
  }
  return (
    <>
      <p className="part-hint">
        An add-on that is on runs as this team’s own container, and the team’s agents get its tools.
      </p>
      <ul className="group">
        {library.map((manifest) => (
          <AddonRow
            key={manifest.id}
            team={team}
            manifest={manifest}
            on={team.addons.find((a) => a.id === manifest.id)}
            access={access}
          />
        ))}
      </ul>
    </>
  );
}

const STATUS: Record<TeamAddon["status"], string> = { starting: "Starting", ready: "Running", error: "Cannot run" };

/** The switch asks first: turning on shows what it adds, turning off what goes. */
function AddonRow({
  team,
  manifest,
  on,
  access,
}: {
  team: TeamView;
  manifest: AddonManifest;
  on: TeamAddon | undefined;
  access: AccessState;
}) {
  const [asking, setAsking] = useState(false);
  const action = useAction();
  const close = () => setAsking(false);
  return (
    <li className="row">
      <div className="row-main">
        <SwitchButton
          label={manifest.name}
          on={on !== undefined}
          pending={action.pending}
          flip={() => setAsking(true)}
        />
        <span className="row-sub">{manifest.description}</span>
        {on && (
          <span className="row-sub">
            {on.status === "error" ? <span className="tag refused">{STATUS.error}</span> : STATUS[on.status]}
            {on.error && ` ${on.error}`} · {usd(on.spentTodayUsd)} spent today
          </span>
        )}
        {!asking && <Problem problem={action.problem} />}
      </div>
      {asking &&
        (on ? (
          <TurnOff team={team} manifest={manifest} action={action} onClose={close} />
        ) : (
          <TurnOn team={team} manifest={manifest} access={access} action={action} onClose={close} />
        ))}
    </li>
  );
}

type AskProps = { team: TeamView; manifest: AddonManifest; action: Action; onClose: () => void };

function TurnOn({ team, manifest, access, action, onClose }: AskProps & { access: AccessState }) {
  const missing = access.view && missingHosts(manifest.access, access.view.credentials);
  return (
    <Sheet title={`Turn on ${manifest.name}?`} onClose={onClose}>
      <p className="sheet-text">
        {manifest.description} It runs as its own container for {team.name}, and the team’s agents get its tools.
      </p>
      {manifest.access.length === 0 ? (
        <p className="sheet-text">It makes no outside calls.</p>
      ) : (
        <div className="access-part">
          <h3>Grants it adds</h3>
          <p className="part-hint">
            The calls it makes through the broker with the team’s credentials. They do not expire and go when it is
            turned off.
          </p>
          <ul className="group">
            {manifest.access.map((call) => (
              <li key={`${call.host} ${call.methods} ${call.paths}`} className="row">
                <GrantLines grant={call} />
              </li>
            ))}
          </ul>
        </div>
      )}
      {/* A credential stored here counts once the access read again includes it, as under Access. */}
      <Rev.Provider value={access.rev}>
        {missing?.map((host) => (
          <div key={host} className="group form">
            <p className="part-hint">
              {host} has no credential for this team yet. Add one first; turning on waits for it.
            </p>
            <CredentialForm team={team.id} host={host} />
          </div>
        ))}
      </Rev.Provider>
      <Problem problem={action.problem ?? access.problem} />
      <div className="sheet-actions">
        <button type="button" className="button quiet" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className={action.pending ? "button primary pending" : "button primary"}
          disabled={!missing || missing.length > 0}
          onClick={() => action.run(() => api.addonOn(team.id, manifest.id), onClose)}
        >
          Turn on
        </button>
      </div>
    </Sheet>
  );
}

function TurnOff({ team, manifest, action, onClose }: AskProps) {
  return (
    <Sheet title={`Turn off ${manifest.name}?`} onClose={onClose}>
      <p className="sheet-text">
        Its container is removed, the team’s agents lose its tools and the grants it added are revoked. Its working
        files are kept for when it is turned on again.
      </p>
      <Problem problem={action.problem} />
      <div className="sheet-actions">
        <button type="button" className="button quiet" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className={action.pending ? "button danger-fill pending" : "button danger-fill"}
          onClick={() => action.run(() => api.addonOff(team.id, manifest.id), onClose)}
        >
          Turn off
        </button>
      </div>
    </Sheet>
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
