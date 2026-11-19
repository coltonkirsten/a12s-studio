import type { AgentView, TeamView } from "@a12s-studio/contract/state";
import { type CSSProperties, lazy, Suspense, useEffect, useState } from "react";
import { api, useAction } from "../../api.ts";
import { displayName } from "../../logic/names.ts";
import { inspectHref, type Route } from "../../logic/route.ts";
import { Icon } from "../../parts/icons.tsx";
import { Dot, doing } from "../../parts/presence.tsx";
import { Problem } from "../../parts/problem.tsx";
import { Files } from "./files.tsx";
import { Inbox } from "./inbox.tsx";
import { Now } from "./now.tsx";
import { Role } from "./role.tsx";
import { Settings } from "./settings.tsx";

// The terminal brings xterm, the largest part of the web app, so it is loaded the first time the tab opens.
const Terminal = lazy(async () => ({ default: (await import("./terminal.tsx")).Terminal }));

const TABS = ["Now", "Inbox", "Role", "Files", "Terminal", "Settings"] as const;
type Tab = (typeof TABS)[number];

/** One agent, in depth. It slides in over the page it was opened from; Escape or the close button puts it away. */
export function Inspector({ team, agent, route }: { team: TeamView; agent: AgentView; route: Route }) {
  const [tab, setTab] = useState<Tab>("Now");
  const closed = inspectHref(null, route);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) location.hash = closed;
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [closed]);

  return (
    <aside
      className="inspector"
      style={{ "--accent": team.accent } as CSSProperties}
      aria-label={displayName(agent.id)}
    >
      <header className="inspector-head">
        <Dot presence={agent.presence} />
        <div className="inspector-title">
          <h2>{displayName(agent.id)}</h2>
          <p className={`agent-doing doing-${agent.presence}`}>{doing(agent)}</p>
        </div>
        <Power agent={agent} />
        <a className="icon-button" href={closed} title="Close">
          <Icon name="close" />
        </a>
      </header>
      <div className="inspector-tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t} type="button" role="tab" aria-selected={t === tab} onClick={() => setTab(t)}>
            {t}
            {t === "Inbox" && agent.queued > 0 && <span className="tab-count">{agent.queued}</span>}
          </button>
        ))}
      </div>
      <div className="inspector-body" role="tabpanel">
        {tab === "Now" && <Now agent={agent} />}
        {tab === "Inbox" && <Inbox team={team} agent={agent} />}
        {tab === "Role" && <Role agent={agent} />}
        {tab === "Files" && <Files agent={agent} />}
        {tab === "Terminal" && (
          <Suspense>
            <Terminal agent={agent} />
          </Suspense>
        )}
        {tab === "Settings" && <Settings agent={agent} lead={agent.id === team.leadId} />}
      </div>
    </aside>
  );
}

/** Wake or Put to sleep, and Stop while the agent works: what a12s stops is its Turn and its background work. */
function Power({ agent }: { agent: AgentView }) {
  const action = useAction();
  const asleep = agent.presence === "asleep";
  return (
    <div className={action.pending ? "inspector-power pending" : "inspector-power"}>
      <button
        type="button"
        className="button"
        onClick={() => action.run(() => api.power(agent.id, asleep ? "awake" : "asleep"))}
      >
        {asleep ? "Wake" : "Put to sleep"}
      </button>
      {agent.presence === "working" && (
        <button type="button" className="button" onClick={() => action.run(() => api.stop(agent.id))}>
          Stop
        </button>
      )}
      <Problem problem={action.problem} />
    </div>
  );
}
