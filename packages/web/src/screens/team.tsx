import type { AgentView, MessageView, StudioState, TeamView } from "@a12s-studio/contract/state";
import { type CSSProperties, useState } from "react";
import { api, useAction } from "../api.ts";
import { displayName } from "../logic/names.ts";
import { href, type Route, settingsHref } from "../logic/route.ts";
import { shortTime } from "../logic/time.ts";
import { Composer } from "../parts/composer.tsx";
import { Conversation, StatusChip } from "../parts/conversation.tsx";
import { Icon } from "../parts/icons.tsx";
import { Dot, doing } from "../parts/presence.tsx";
import { Problem } from "../parts/problem.tsx";

type Props = { state: StudioState; team: TeamView; route: Route; onHire: () => void };

export function TeamScreen({ state, team, route, onHire }: Props) {
  const [menu, setMenu] = useState(false);
  const now = Date.now();
  const open = state.open && state.open.id === route.thread ? state.open : null;
  const questions: MessageView[] = [];
  for (const item of state.needsYou) {
    if (item.kind === "question" && item.threadId === route.thread) questions.push(item.message);
  }
  const composing = !route.thread || route.thread === "new";

  return (
    <div className="team" style={{ "--accent": team.accent } as CSSProperties}>
      <section className="list-column">
        <header className="team-head">
          <a className="back" href={href()}>
            <Icon name="back" /> Teams
          </a>
          <div className="team-title">
            <h1>{team.name}</h1>
            <button type="button" className="icon-button" title="More" onClick={() => setMenu(!menu)}>
              <Icon name="more" />
            </button>
            {menu && (
              <div className="menu">
                <button type="button" className="menu-dismiss" aria-label="Close menu" onClick={() => setMenu(false)} />
                <div className="menu-items" role="menu">
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setMenu(false);
                      onHire();
                    }}
                  >
                    Hire an agent…
                  </button>
                  <a role="menuitem" href={settingsHref(team.id)}>
                    Team settings
                  </a>
                </div>
              </div>
            )}
          </div>
          {team.purpose && <p className="team-purpose">{team.purpose}</p>}
        </header>

        <div className="section-head">
          <span>Agents</span>
          <button type="button" className="icon-button" title="Hire an agent" onClick={onHire}>
            <Icon name="plus" size={14} />
          </button>
        </div>
        {team.agents.map((agent) => (
          <AgentRow key={agent.id} agent={agent} lead={agent.id === team.leadId} />
        ))}

        <div className="section-head">
          <span>Threads</span>
          <a className="icon-button" title="New thread" href={href(team.id, "new")}>
            <Icon name="compose" size={15} />
          </a>
        </div>
        <ul className="threads">
          {team.threads.map((t) => (
            <li key={t.id}>
              <a className={t.id === route.thread ? "thread-row selected" : "thread-row"} href={href(team.id, t.id)}>
                <span className="thread-top">
                  <span className="thread-title">{t.title}</span>
                  <time>{shortTime(t.updatedAt, now)}</time>
                </span>
                <span className="thread-preview">{t.preview}</span>
                {t.status !== "open" && <StatusChip status={t.status} />}
              </a>
            </li>
          ))}
        </ul>
      </section>

      <section className="conversation-column">
        {open && <Conversation team={team} thread={open} questions={questions} />}
        {composing && (
          <div className="conversation">
            <header className="conversation-head">
              <a className="back" href={href(team.id)}>
                <Icon name="back" /> {team.name}
              </a>
            </header>
            <div className="messages blank">
              <p className="first-line">{team.threads.length === 0 ? "Tell the team what you want." : "New thread"}</p>
            </div>
            <Composer
              team={team}
              placeholder={team.leadId ? `Message ${displayName(team.leadId)}, or @ someone` : "Message the team"}
              question={null}
              send={(body, to) => api.newThread(team.id, { body, to })}
              sent={(result) => {
                if (result.id) location.hash = href(team.id, result.id);
              }}
            />
          </div>
        )}
      </section>
    </div>
  );
}

function AgentRow({ agent, lead }: { agent: AgentView; lead: boolean }) {
  const [open, setOpen] = useState(false);
  const [removing, setRemoving] = useState(false);
  const action = useAction();
  const asleep = agent.presence === "asleep";
  return (
    <div className={open ? "agent open" : "agent"}>
      <button type="button" className="agent-row" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Dot presence={agent.presence} />
        <span className="agent-text">
          <span className="agent-name">
            {displayName(agent.id)}
            {lead && agent.slug !== "lead" && <span className="lead-tag">Lead</span>}
          </span>
          <span className={`agent-doing doing-${agent.presence}`}>{doing(agent)}</span>
        </span>
      </button>
      {open && (
        <div className="agent-more">
          <p className="agent-role">{agent.roleLine}</p>
          <p className="agent-model">
            {agent.model}
            {agent.queued > 0 && ` · ${agent.queued} waiting in its inbox`}
          </p>
          <div className={action.pending ? "agent-actions pending" : "agent-actions"}>
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
            {!lead &&
              (removing ? (
                <button type="button" className="button danger" onClick={() => action.run(() => api.fire(agent.id))}>
                  Remove {displayName(agent.id)}
                </button>
              ) : (
                <button type="button" className="button quiet" onClick={() => setRemoving(true)}>
                  Remove…
                </button>
              ))}
          </div>
          <Problem problem={action.problem} />
        </div>
      )}
    </div>
  );
}
