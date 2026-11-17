import type { InboxItem } from "@a12s-studio/contract/api";
import type { AgentView, TeamView } from "@a12s-studio/contract/state";
import { useContext, useState } from "react";
import { api, Rev, useAction, useRead } from "../../api.ts";
import { inboxGroups } from "../../logic/inbox.ts";
import { displayName } from "../../logic/names.ts";
import { shortTime } from "../../logic/time.ts";
import { Problem } from "../../parts/problem.tsx";

/** What the agent has not received yet. Removed messages stay in their threads; they are only never delivered. */
export function Inbox({ team, agent }: { team: TeamView; agent: AgentView }) {
  const rev = useContext(Rev);
  const inbox = useRead(() => api.inbox(agent.id), `${agent.id}:${rev}`);
  const [clearing, setClearing] = useState(false);
  const clear = useAction();
  const items = inbox.data?.messages ?? [];

  return (
    <section className="inspector-section">
      <div className="inspector-bar">
        <p className="inspector-quiet">
          {items.length === 0 ? `Nothing is waiting for ${displayName(agent.id)}.` : `${items.length} waiting`}
        </p>
        {items.length > 0 &&
          (clearing ? (
            <button
              type="button"
              className={clear.pending ? "button danger pending" : "button danger"}
              onClick={() =>
                clear.run(
                  () => api.clearInbox(agent.id),
                  () => setClearing(false),
                )
              }
            >
              Remove all {items.length}
            </button>
          ) : (
            <button type="button" className="button quiet" onClick={() => setClearing(true)}>
              Clear…
            </button>
          ))}
      </div>
      <Problem problem={inbox.problem ?? clear.problem} />
      <ul className="inbox">
        {inboxGroups(items).map((group) => (
          <Group key={group[0]?.id} team={team} agent={agent} group={group} />
        ))}
      </ul>
    </section>
  );
}

function Group({ team, agent, group }: { team: TeamView; agent: AgentView; group: InboxItem[] }) {
  const remove = useAction();
  const now = Date.now();
  const first = group[0];
  if (!first) return null;
  const where = first.sentAs === null ? "Waiting in Studio" : "In its a12s inbox";
  return (
    <li className="inbox-group">
      {group.map((m) => (
        <div key={m.id} className="inbox-message">
          <header>
            <b>{displayName(m.from)}</b>
            <span>
              {m.kind}
              {m.thread && ` in ${team.threads.find((t) => t.id === m.thread)?.title ?? "a thread"}`}
            </span>
            <time>{shortTime(m.at, now)}</time>
          </header>
          <p className="inbox-body">{m.body}</p>
        </div>
      ))}
      <footer>
        <span>{group.length > 1 ? `${where}, sent together` : where}</span>
        <button
          type="button"
          className={remove.pending ? "button quiet pending" : "button quiet"}
          onClick={() => remove.run(() => api.removeInbox(agent.id, first.id))}
        >
          Remove
        </button>
      </footer>
      <Problem problem={remove.problem} />
    </li>
  );
}
