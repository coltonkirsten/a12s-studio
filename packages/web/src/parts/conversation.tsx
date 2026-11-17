import type { BoardStatus, MessageView, TeamView, ThreadView } from "@a12s-studio/contract/state";
import { useLayoutEffect, useRef, useState } from "react";
import { api, useAction } from "../api.ts";
import { deliveryLine } from "../logic/chain.ts";
import { type Entry, fold } from "../logic/fold.ts";
import { displayName } from "../logic/names.ts";
import { href, inspectHref, type Route } from "../logic/route.ts";
import { shortTime } from "../logic/time.ts";
import { ChainView } from "./chain.tsx";
import { Composer } from "./composer.tsx";
import { Icon } from "./icons.tsx";
import { Markdown } from "./markdown.tsx";
import { Dot, doing, WorkList } from "./presence.tsx";
import { Problem } from "./problem.tsx";

const STATUS: Record<BoardStatus, string> = { open: "Open", needs_you: "Needs you", done: "Done" };

export function StatusChip({ status }: { status: BoardStatus }) {
  return <span className={`chip chip-${status}`}>{STATUS[status]}</span>;
}

type Props = { team: TeamView; thread: ThreadView; route: Route };

export function Conversation({ team, thread, route }: Props) {
  const action = useAction();
  const [chain, setChain] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const working = team.agents.filter(
    (a) => a.turn?.threadId === thread.id || a.work.some((w) => w.threadId === thread.id),
  );
  const now = Date.now();
  const done = thread.status === "done";

  // Follow new words only while the reader is at the bottom; reading further up is never interrupted.
  const liveText = working.map((a) => a.turn?.text.length).join();
  // biome-ignore lint/correctness/useExhaustiveDependencies: the effect runs because the content grew, not to read it.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [thread.messages.length, liveText]);

  return (
    <div className="conversation">
      <header className="conversation-head">
        <a className="back" href={href(team.id)}>
          <Icon name="back" /> {team.name}
        </a>
        <div className="conversation-title">
          <h2>{thread.title}</h2>
          <span className="conversation-sub">
            <StatusChip status={thread.status} /> {displayName(thread.ownerId)} owns this thread
          </span>
        </div>
        <button type="button" className="button quiet" aria-pressed={chain} onClick={() => setChain(!chain)}>
          Chain
        </button>
        <button
          type="button"
          className={action.pending ? "button quiet pending" : "button quiet"}
          onClick={() => action.run(() => api.patchThread(thread.id, { status: done ? "open" : "done" }))}
        >
          {done ? "Reopen" : "Mark as done"}
        </button>
        <Problem problem={action.problem} />
      </header>
      {chain ? (
        <ChainView thread={thread} />
      ) : (
        <div
          className="messages"
          ref={scroller}
          onScroll={(event) => {
            const el = event.currentTarget;
            pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
          }}
        >
          {fold(thread.messages).map((entry) => (
            <EntryView
              key={entry.kind === "talk" ? entry.id : entry.message.id}
              entry={entry}
              now={now}
              route={route}
            />
          ))}
          {working.map((agent) => {
            // The agent's line and words are about its Turn; when that runs in another thread, only its work here shows.
            const turn = agent.turn?.threadId === thread.id ? agent.turn : null;
            return (
              <div key={agent.id} className="msg theirs live">
                <header>
                  <Dot presence={agent.presence} />
                  <b>{displayName(agent.id)}</b>
                  {(turn || !agent.turn) && <span className="doing">{doing(agent)}</span>}
                </header>
                <WorkList items={agent.work.filter((w) => w.threadId === thread.id)} />
                {turn?.text && (
                  <div className="body streaming">
                    <Markdown text={turn.text} streaming />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      <Composer
        key={thread.id}
        team={team}
        placeholder="Reply in this thread"
        send={(body, to) => api.post(thread.id, { body, to })}
      />
    </div>
  );
}

// Under a message to an agent: how it reached that agent. It opens the agent's inspector.
function Delivery({ message, route }: { message: MessageView; route: Route }) {
  const line = deliveryLine(message);
  if (line === null || message.to === null) return null;
  return (
    <a className="delivery" href={inspectHref(message.to, route)}>
      {line}
    </a>
  );
}

function EntryView({ entry, now, route }: { entry: Entry; now: number; route: Route }) {
  const [open, setOpen] = useState(false);
  if (entry.kind === "message") return <Message message={entry.message} now={now} route={route} />;
  return (
    <div className={open ? "talk open" : "talk"}>
      <button type="button" className="talk-line" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name="chevron" size={12} />
        {entry.summary}
      </button>
      {open && (
        <div className="talk-messages">
          {entry.messages.map((m) => (
            <div key={m.id} className="talk-message">
              <header>
                <b>{displayName(m.from)}</b>
                <span>to {displayName(m.to ?? "")}</span>
                <time>{shortTime(m.at, now)}</time>
              </header>
              <div className="body">
                <Markdown text={m.body} />
              </div>
              <Delivery message={m} route={route} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Message({ message, now, route }: { message: MessageView; now: number; route: Route }) {
  if (message.from === "system") return <p className="msg system">{message.body}</p>;
  const file = message.file && (
    <a className="file" href={api.attachment(message.id, message.file)} download>
      <Icon name="clip" size={13} />
      {message.file}
    </a>
  );
  if (message.from === "owner") {
    return (
      <div className="msg mine">
        <div className="bubble">
          {message.body}
          {file}
        </div>
        <time>{shortTime(message.at, now)}</time>
        <Delivery message={message} route={route} />
      </div>
    );
  }
  return (
    <div className="msg theirs">
      <header>
        <b>{displayName(message.from)}</b>
        {message.to !== null && <span>to {displayName(message.to)}</span>}
        <time>{shortTime(message.at, now)}</time>
      </header>
      <div className="body">
        <Markdown text={message.body} />
        {file}
      </div>
      <Delivery message={message} route={route} />
    </div>
  );
}
