import type { StudioState, TeamView } from "@a12s-studio/contract/state";
import { type CSSProperties, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../api.ts";
import { budgetUsed, usd } from "../logic/money.ts";
import { href, type Route } from "../logic/route.ts";
import { Icon } from "../parts/icons.tsx";
import { Dot } from "../parts/presence.tsx";
import { Switch } from "../parts/switch.tsx";
import { SettingsSheet } from "./settings.tsx";

type Props = { state: StudioState; route: Route; connected: boolean; onNewTeam: () => void };

export function Sidebar({ state, route, connected, onNewTeam }: Props) {
  const needs = state.needsYou.length;
  const [settings, setSettings] = useState(false);
  return (
    <nav className="sidebar">
      <div className="sidebar-scroll">
        <a className={route.team ? "side-row" : "side-row selected"} href={href()}>
          <Icon name="tray" />
          <span className="side-name">Needs You</span>
          {needs > 0 && <span className="count">{needs}</span>}
        </a>
        <div className="section-head">
          <span>Teams</span>
          <button type="button" className="icon-button" title="New team" onClick={onNewTeam}>
            <Icon name="plus" size={14} />
          </button>
        </div>
        {state.teams.map((team) => (
          <TeamRow
            key={team.id}
            team={team}
            selected={team.id === route.team}
            needs={state.needsYou.filter((item) => item.teamId === team.id).length}
          />
        ))}
        {state.teams.length === 0 && (
          <button type="button" className="side-row quiet" onClick={onNewTeam}>
            New team…
          </button>
        )}
      </div>
      <footer className="sidebar-foot">
        {!connected && <p className="status-line">Reconnecting…</p>}
        {connected && state.a12s === "down" && <p className="status-line">a12s is not reachable</p>}
        <Switch label="Pause everything" on={state.settings.paused} set={(paused) => api.patchSettings({ paused })} />
        <button type="button" className="side-row quiet" onClick={() => setSettings(true)}>
          Settings…
        </button>
      </footer>
      {/* The sidebar's backdrop filter would hold a fixed sheet inside it, so the sheet is drawn on the page. */}
      {settings &&
        createPortal(<SettingsSheet settings={state.settings} onClose={() => setSettings(false)} />, document.body)}
    </nav>
  );
}

function TeamRow({ team, selected, needs }: { team: TeamView; selected: boolean; needs: number }) {
  const { dailyUsd, spentTodayUsd } = team.budget;
  const used = budgetUsed(spentTodayUsd, dailyUsd);
  const unread = team.threads.filter((t) => t.unread > 0).length;
  return (
    <a
      className={selected ? "side-row team-row selected" : "side-row team-row"}
      href={href(team.id)}
      style={{ "--accent": team.accent } as CSSProperties}
    >
      <span className="team-top">
        <span className="side-name">{team.name}</span>
        {team.paused && <span className="paused-tag">Paused</span>}
        {unread > 0 && (
          <span className="count quiet" title={`${unread} unread ${unread === 1 ? "thread" : "threads"}`}>
            {unread}
          </span>
        )}
        {needs > 0 && <span className="count">{needs}</span>}
      </span>
      <span className="team-dots">
        {team.agents.map((agent) => (
          <Dot key={agent.id} presence={agent.presence} />
        ))}
      </span>
      <span className="usage" title={`${usd(spentTodayUsd)} of ${usd(dailyUsd)} today`}>
        <span style={{ width: `${used * 100}%` }} />
      </span>
    </a>
  );
}
