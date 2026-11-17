import { useEffect, useState } from "react";
import { Rev } from "./api.ts";
import { parseRoute } from "./logic/route.ts";
import { HireSheet } from "./screens/hire.tsx";
import { NeedsYou } from "./screens/needs-you.tsx";
import { NewTeamSheet } from "./screens/new-team.tsx";
import { Sidebar } from "./screens/sidebar.tsx";
import { TeamScreen } from "./screens/team.tsx";
import { TeamSettings } from "./screens/team-settings.tsx";
import { useStudio } from "./stream.ts";

export function App() {
  const [hash, setHash] = useState(location.hash);
  const [sheet, setSheet] = useState<"team" | "hire" | null>(null);
  useEffect(() => {
    const onHash = () => setHash(location.hash);
    addEventListener("hashchange", onHash);
    return () => removeEventListener("hashchange", onHash);
  }, []);

  const route = parseRoute(hash);
  const { state, connected } = useStudio(route.thread === "new" ? null : route.thread);
  if (!state) return <div className="app" />;

  const team = state.teams.find((t) => t.id === route.team) ?? null;
  const shown = { team: team?.id ?? null, thread: team ? route.thread : null, settings: route.settings };
  const close = () => setSheet(null);
  return (
    <Rev.Provider value={state.rev}>
      <div className="app" data-depth={!team ? 0 : route.thread ? 2 : 1}>
        <Sidebar state={state} route={shown} connected={connected} onNewTeam={() => setSheet("team")} />
        <main className="main">
          {!team ? (
            <NeedsYou state={state} />
          ) : route.settings ? (
            <TeamSettings key={team.id} team={team} />
          ) : (
            <TeamScreen key={team.id} state={state} team={team} route={shown} onHire={() => setSheet("hire")} />
          )}
        </main>
      </div>
      {sheet === "team" && <NewTeamSheet state={state} onClose={close} />}
      {sheet === "hire" && team && <HireSheet team={team} settings={state.settings} onClose={close} />}
    </Rev.Provider>
  );
}
