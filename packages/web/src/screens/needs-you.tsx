import type { WriteResult } from "@a12s-studio/contract/api";
import type { AccessRequest as Request } from "@a12s-studio/contract/broker-admin";
import type { MessageId } from "@a12s-studio/contract/names";
import type { NeedsYouItem, StudioState, TeamView } from "@a12s-studio/contract/state";
import { type CSSProperties, type ReactNode, useState } from "react";
import { api, inOrder, useAccess, useAction } from "../api.ts";
import { expiresAt, expiryText, type Lifetime, lifetimeLabel } from "../logic/grants.ts";
import { displayName } from "../logic/names.ts";
import { href, inspectHref, settingsHref } from "../logic/route.ts";
import { shortTime } from "../logic/time.ts";
import { CredentialForm } from "../parts/access/credentials.tsx";
import { GrantLines } from "../parts/access/grants.tsx";
import { LifetimePicker } from "../parts/access/lifetime.tsx";
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
        `Asks for ${r.methods.join(", ")} on ${r.host}${r.days ? ` for ${lifetimeLabel(r.days)}` : ""}`,
        r.createdAt,
        <AccessRequest teamId={item.teamId} request={r} hostHasCredential={item.hostHasCredential} />,
      );
    }
    case "agent_error":
      return frame(
        displayName(item.agentId),
        `Stopped with an error: ${item.error}`,
        null,
        <Actions>
          <ActionButton label="Wake" write={() => api.power(item.agentId, "awake")} />
          <InspectLink agent={item.agentId} />
        </Actions>,
      );
    case "failed_turn":
      return frame(
        displayName(item.agentId),
        `A Turn failed${item.error ? `: ${item.error}` : "."}`,
        item.at,
        <Actions>
          <InspectLink agent={item.agentId} />
        </Actions>,
      );
    case "budget":
      return frame(
        "Budget",
        `$${item.spentTodayUsd.toFixed(2)} of $${item.dailyUsd.toFixed(2)} spent today. Work waits until midnight.`,
        null,
        <BudgetBox team={item.teamId} current={item.dailyUsd} />,
      );
    case "credential_rejected":
      return frame(
        item.host,
        `${item.host} refused the stored credential. Calls to it fail until it is replaced.`,
        item.at,
        <ReplaceCredential teamId={item.teamId} host={item.host} />,
      );
    case "grant_expiring":
      return frame(
        item.host,
        `Access to ${item.host} ${expiryText(item.expiresAt, now).toLowerCase()}.`,
        null,
        <ExtendGrant item={item} />,
      );
  }
}

function InspectLink({ agent }: { agent: string }) {
  return (
    <a className="button quiet" href={inspectHref(agent)}>
      Open inspector
    </a>
  );
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

// An agent that names no lifetime gets a month unless the owner picks another.
const UNASKED: Lifetime = 30;

function AccessRequest({
  teamId,
  request: r,
  hostHasCredential,
}: {
  teamId: string;
  request: Request;
  hostHasCredential: boolean;
}) {
  const [lifetime, setLifetime] = useState<Lifetime>(r.days ?? UNASKED);
  const approve = useAction();
  const deny = useAction();
  const busy = approve.pending || deny.pending;
  return (
    <>
      <div className="card-change">
        <GrantLines grant={r} />
      </div>
      <p className="card-why">“{r.reason}”</p>
      {!hostHasCredential && (
        <div className="card-step">
          <p>{r.host} has no credential yet. Add one first; approving waits for it.</p>
          <CredentialForm team={teamId} host={r.host} />
        </div>
      )}
      <div className="card-actions spread">
        <LifetimePicker value={lifetime} wanted={r.days} set={setLifetime} />
        <span className="card-buttons">
          <button
            type="button"
            className={deny.pending ? "button pending" : "button"}
            disabled={busy}
            onClick={() => deny.run(() => api.deny(teamId, r.id))}
          >
            Deny
          </button>
          <button
            type="button"
            className={approve.pending ? "button primary pending" : "button primary"}
            disabled={busy || !hostHasCredential}
            onClick={() => approve.run(() => api.approve(teamId, r.id, { expiresAt: expiresAt(lifetime, Date.now()) }))}
          >
            Approve
          </button>
        </span>
      </div>
      <Problem problem={approve.problem ?? deny.problem} />
    </>
  );
}

function ReplaceCredential({ teamId, host }: { teamId: string; host: string }) {
  const [open, setOpen] = useState(false);
  const access = useAccess(teamId);
  const replacing = access.view?.credentials.find((c) => c.host === host);
  if (open) {
    return (
      <div className="card-step">
        <CredentialForm team={teamId} host={host} replacing={replacing} onClose={() => setOpen(false)} />
      </div>
    );
  }
  return (
    <Actions>
      <a className="button quiet" href={settingsHref(teamId)}>
        Team settings
      </a>
      <button type="button" className="button primary" onClick={() => setOpen(true)}>
        Replace credential
      </button>
    </Actions>
  );
}

/** A new grant with the same host, methods and paths, then the old one revoked, so access never lapses. */
function ExtendGrant({ item }: { item: Extract<NeedsYouItem, { kind: "grant_expiring" }> }) {
  const [lifetime, setLifetime] = useState<Lifetime>(UNASKED);
  const access = useAccess(item.teamId);
  const action = useAction();
  const grant = access.view?.grants.find((g) => g.id === item.grantId);
  return (
    <>
      <div className="card-change">
        <GrantLines grant={grant ?? { host: item.host, methods: [], paths: item.paths }} />
      </div>
      <div className="card-actions spread">
        <LifetimePicker value={lifetime} wanted={null} set={setLifetime} />
        <button
          type="button"
          className={action.pending ? "button primary pending" : "button primary"}
          disabled={!grant}
          onClick={() =>
            grant &&
            action.run(() =>
              inOrder([
                () =>
                  api.grant(item.teamId, {
                    host: grant.host,
                    methods: grant.methods,
                    paths: grant.paths,
                    expiresAt: expiresAt(lifetime, Date.now()),
                  }),
                () => api.revoke(item.teamId, grant.id),
              ]),
            )
          }
        >
          Extend
        </button>
      </div>
      <Problem problem={action.problem ?? access.problem} />
    </>
  );
}
