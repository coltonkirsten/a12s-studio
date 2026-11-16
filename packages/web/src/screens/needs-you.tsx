import type { WriteResult } from "@a12s-studio/contract/api";
import type { MessageId } from "@a12s-studio/contract/names";
import type { NeedsYouItem, StudioState, TeamView } from "@a12s-studio/contract/state";
import { type CSSProperties, type ReactNode, useState } from "react";
import { api, useAction } from "../api.ts";
import { displayName } from "../logic/names.ts";
import { href } from "../logic/route.ts";
import { shortTime } from "../logic/time.ts";
import { Problem } from "../parts/problem.tsx";

export function NeedsYou({ state }: { state: StudioState }) {
  return (
    <div className="page">
      <header className="page-head">
        <h1>Needs You</h1>
      </header>
      {state.needsYou.length === 0 ? (
        <p className="empty">Nothing needs you.</p>
      ) : (
        <ul className="cards">
          {state.needsYou.map((item) => {
            const team = state.teams.find((t) => t.id === item.teamId);
            return team && <Card key={keyOf(item)} item={item} team={team} />;
          })}
        </ul>
      )}
    </div>
  );
}

function keyOf(item: NeedsYouItem): string {
  switch (item.kind) {
    case "question":
      return item.message.id;
    case "access_request":
      return item.request.id;
    case "agent_error":
      return `${item.kind}:${item.agentId}`;
    case "failed_turn":
      return item.turnId;
    case "budget":
      return `${item.kind}:${item.teamId}`;
    case "credential_rejected":
      return `${item.kind}:${item.teamId}:${item.host}`;
    case "grant_expiring":
      return item.grantId;
  }
}

function Card({ item, team }: { item: NeedsYouItem; team: TeamView }) {
  const now = Date.now();
  const frame = (who: string, what: string, at: number | null, body: ReactNode) => (
    <li className="card" style={{ "--accent": team.accent } as CSSProperties}>
      <header className="card-head">
        <span className="card-team">{team.name}</span>
        <span className="card-who">{who}</span>
        {at !== null && <time>{shortTime(at, now)}</time>}
      </header>
      <p className="card-what">{what}</p>
      {body}
    </li>
  );

  switch (item.kind) {
    case "question":
      return frame(
        displayName(item.message.from),
        item.message.body,
        item.message.at,
        <ReplyBox thread={item.threadId} ask={item.message.id} team={item.teamId} />,
      );
    case "access_request": {
      const r = item.request;
      return frame(
        displayName(r.agentId),
        `Asks for ${r.methods.join(", ")} on ${r.host}${r.days ? ` for ${r.days} days` : ""}`,
        r.createdAt,
        <>
          <ul className="card-paths">
            {r.paths.map((path) => (
              <li key={path}>{path}</li>
            ))}
          </ul>
          <p className="card-why">{r.reason}</p>
        </>,
      );
    }
    case "agent_error":
      return frame(
        displayName(item.agentId),
        `Stopped with an error: ${item.error}`,
        null,
        <Actions>
          <ActionButton label="Wake" write={() => api.power(item.agentId, "awake")} />
        </Actions>,
      );
    case "failed_turn":
      return frame(displayName(item.agentId), `A Turn failed${item.error ? `: ${item.error}` : "."}`, item.at, null);
    case "budget":
      return frame(
        "Budget",
        `$${item.spentTodayUsd.toFixed(2)} of $${item.dailyUsd.toFixed(2)} spent today. Work waits until midnight.`,
        null,
        <BudgetBox team={item.teamId} current={item.dailyUsd} />,
      );
    case "credential_rejected":
      return frame(item.host, `${item.host} refused the stored credential.`, item.at, null);
    case "grant_expiring":
      return frame(
        item.host,
        `Access to ${item.host} ends ${shortTime(item.expiresAt, now)}: ${item.paths.join(", ")}`,
        null,
        null,
      );
  }
}

function Actions({ children }: { children: ReactNode }) {
  return <div className="card-actions">{children}</div>;
}

function ActionButton({ label, write }: { label: string; write: () => Promise<WriteResult> }) {
  const action = useAction();
  return (
    <>
      <button type="button" className={action.pending ? "button pending" : "button"} onClick={() => action.run(write)}>
        {label}
      </button>
      <Problem problem={action.problem} />
    </>
  );
}

function ReplyBox({ thread, ask, team }: { thread: string; ask: MessageId; team: string }) {
  const [body, setBody] = useState("");
  const action = useAction();
  const send = () => body.trim() && !action.pending && action.run(() => api.post(thread, { body: body.trim(), ask }));
  return (
    <div className="reply-box">
      <textarea
        rows={2}
        placeholder="Reply"
        value={body}
        readOnly={action.pending}
        className={action.pending ? "pending" : undefined}
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
          event.preventDefault();
          send();
        }}
      />
      <Actions>
        <a className="button quiet" href={href(team, thread)}>
          Open thread
        </a>
        <button type="button" className="button primary" disabled={!body.trim() || action.pending} onClick={send}>
          Reply
        </button>
      </Actions>
      <Problem problem={action.problem} />
    </div>
  );
}

function BudgetBox({ team, current }: { team: string; current: number }) {
  const [value, setValue] = useState(String(current * 2));
  const action = useAction();
  const amount = Number(value);
  return (
    <Actions>
      <label className="money">
        $
        <input inputMode="decimal" value={value} onChange={(event) => setValue(event.target.value)} />
      </label>
      <button
        type="button"
        className={action.pending ? "button primary pending" : "button primary"}
        disabled={!(amount > current)}
        onClick={() => action.run(() => api.patchTeam(team, { dailyBudgetUsd: amount }))}
      >
        Raise budget
      </button>
      <Problem problem={action.problem} />
    </Actions>
  );
}
