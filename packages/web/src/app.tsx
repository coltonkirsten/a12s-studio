import { useEffect, useState } from "react";
import { Rev } from "./api.ts";
import { parseRoute, parseRuns } from "./logic/route.ts";
import { Icon } from "./parts/icons.tsx";
import { HireSheet } from "./screens/hire.tsx";
import { Inspector } from "./screens/inspector/inspector.tsx";
import { NeedsYou } from "./screens/needs-you.tsx";
import { NewTeamSheet } from "./screens/new-team.tsx";
import { RunsScreen } from "./screens/runs.tsx";
import { Sidebar } from "./screens/sidebar.tsx";
import { TeamScreen } from "./screens/team.tsx";
import { TeamSettings } from "./screens/team-settings.tsx";
import { useStudio } from "./stream.ts";

export function App() {
  const [hash, setHash] = useState(location.hash);
  const [sheet, setSheet] = useState<"team" | "hire" | null>(null);
  // Hidden, the sidebar gives its column to the page, so one team fills the window.
  const [sidebar, setSidebar] = useState(true);
  useEffect(() => {
    const onHash = () => setHash(location.hash);
    addEventListener("hashchange", onHash);
    return () => removeEventListener("hashchange", onHash);
  }, []);

  const runs = parseRuns(hash);
  const route = parseRoute(runs ? "" : hash);
  const { state, connected } = useStudio(route.thread === "new" ? null : route.thread);
  if (!state) return <div className="app" />;

  const team = state.teams.find((t) => t.id === route.team) ?? null;
  const shown = { ...route, team: team?.id ?? null, thread: team ? route.thread : null };
  const inspected = team?.agents.find((a) => a.id === route.inspect) ?? null;
  const close = () => setSheet(null);
  return (
    <Rev.Provider value={state.rev}>
      <div className="app" data-depth={runs ? 1 : !team ? 0 : route.thread ? 2 : 1} data-sidebar={sidebar ? "shown" : "hidden"}>
        <button
          type="button"
          className="icon-button sidebar-toggle"
          title={sidebar ? "Hide the sidebar" : "Show the sidebar"}
          aria-expanded={sidebar}
          onClick={() => setSidebar(!sidebar)}
        >
          <Icon name="sidebar" />
        </button>
        <Sidebar
          state={state}
          route={shown}
          runs={runs !== null}
          connected={connected}
          onNewTeam={() => setSheet("team")}
        />
        <main className="main">
          {runs ? (
            <RunsScreen state={state} group={runs.group} turn={runs.turn} />
          ) : !team ? (
            <NeedsYou state={state} />
          ) : route.settings ? (
            <TeamSettings key={team.id} team={team} />
          ) : (
            <TeamScreen key={team.id} state={state} team={team} route={shown} onHire={() => setSheet("hire")} />
          )}
        </main>
      </div>
      {team && inspected && <Inspector key={inspected.id} team={team} agent={inspected} route={shown} />}
      {sheet === "team" && <NewTeamSheet state={state} onClose={close} />}
      {sheet === "hire" && team && <HireSheet team={team} settings={state.settings} onClose={close} />}
    </Rev.Provider>
  );
}
