import type { BoardStatus, MessageView, TeamView, ThreadView } from "@a12s-studio/contract/state";
import { useLayoutEffect, useRef, useState } from "react";
import { api, useAction } from "../api.ts";
import { type Entry, fold } from "../logic/fold.ts";
import { displayName } from "../logic/names.ts";
import { href } from "../logic/route.ts";
import { shortTime } from "../logic/time.ts";
import { Composer } from "./composer.tsx";
import { Icon } from "./icons.tsx";
import { Dot } from "./presence.tsx";
import { Problem } from "./problem.tsx";

const STATUS: Record<BoardStatus, string> = { open: "Open", needs_you: "Needs you", done: "Done" };

export function StatusChip({ status }: { status: BoardStatus }) {
  return <span className={`chip chip-${status}`}>{STATUS[status]}</span>;
}

type Props = { team: TeamView; thread: ThreadView; questions: MessageView[] };

export function Conversation({ team, thread, questions }: Props) {
  const action = useAction();
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const working = team.agents.filter((a) => a.turn && a.turn.threadId === thread.id);
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
        <button
          type="button"
          className={action.pending ? "button quiet pending" : "button quiet"}
          onClick={() => action.run(() => api.patchThread(thread.id, { status: done ? "open" : "done" }))}
        >
          {done ? "Reopen" : "Mark as done"}
        </button>
        <Problem problem={action.problem} />
      </header>
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
            questions={questions}
          />
        ))}
        {working.map((agent) => (
          <div key={agent.id} className="msg theirs live">
            <header>
              <Dot presence={agent.presence} />
              <b>{displayName(agent.id)}</b>
              <span className="doing">{agent.line ?? "Working"}</span>
            </header>
            {agent.turn?.text && <div className="body streaming">{agent.turn.text}</div>}
          </div>
        ))}
      </div>
      <Composer
        key={thread.id}
        team={team}
        placeholder="Reply in this thread"
        question={questions[0] ?? null}
        send={(body, to, ask) => api.post(thread.id, ask ? { body, ask: ask.id } : { body, to })}
      />
    </div>
  );
}

function EntryView({ entry, now, questions }: { entry: Entry; now: number; questions: MessageView[] }) {
  const [open, setOpen] = useState(false);
  if (entry.kind === "message") return <Message message={entry.message} now={now} questions={questions} />;
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
              <div className="body">{m.body}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Message({ message, now, questions }: { message: MessageView; now: number; questions: MessageView[] }) {
  if (message.from === "system") return <p className="msg system">{message.body}</p>;
  const file = message.file && (
    <span className="file">
      <Icon name="clip" size={13} />
      {message.file}
    </span>
  );
  if (message.from === "owner") {
    return (
      <div className="msg mine">
        <div className="bubble">
          {message.body}
          {file}
        </div>
        <time>{shortTime(message.at, now)}</time>
      </div>
    );
  }
  const asksYou = questions.some((q) => q.id === message.id);
  return (
    <div className={asksYou ? "msg theirs asks-you" : "msg theirs"}>
      <header>
        <b>{displayName(message.from)}</b>
        {asksYou && <span className="asks">asks you</span>}
        <time>{shortTime(message.at, now)}</time>
      </header>
      <div className="body">
        {message.body}
        {file}
      </div>
    </div>
  );
}
