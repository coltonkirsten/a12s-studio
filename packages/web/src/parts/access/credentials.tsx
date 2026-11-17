import type { CredentialScheme, CredentialView, PutCredentialBody } from "@a12s-studio/contract/broker-admin";
import { useState } from "react";
import { api, inOrder, useAction } from "../../api.ts";
import { GITHUB_HOSTS, githubCredentials } from "../../logic/presets.ts";
import { shortTime } from "../../logic/time.ts";
import { Problem } from "../problem.tsx";

const SCHEMES: Record<CredentialScheme, string> = { bearer: "Bearer token", basic: "Basic login", header: "Header" };

function describe(c: CredentialView): string {
  if (c.scheme === "basic") return `Basic login as ${c.username}`;
  if (c.scheme === "header") return `${c.headerName} header`;
  return SCHEMES.bearer;
}

export function Credentials({ team, credentials }: { team: string; credentials: CredentialView[] }) {
  const [adding, setAdding] = useState(false);
  const now = Date.now();
  return (
    <div className="access-part">
      <h3>Credentials</h3>
      <p className="part-hint">Kept in the broker’s vault. Agents never see them, and neither does this page again.</p>
      {credentials.length > 0 && (
        <ul className="group">
          {credentials.map((c) => (
            <CredentialRow key={c.host} team={team} credential={c} now={now} />
          ))}
        </ul>
      )}
      {adding ? (
        <div className="group form">
          <CredentialForm team={team} onClose={() => setAdding(false)} />
        </div>
      ) : (
        <button type="button" className="button quiet add" onClick={() => setAdding(true)}>
          Add a credential…
        </button>
      )}
    </div>
  );
}

function CredentialRow({ team, credential: c, now }: { team: string; credential: CredentialView; now: number }) {
  const [removing, setRemoving] = useState(false);
  const action = useAction();
  return (
    <li className={action.pending ? "row pending" : "row"}>
      <div className="row-main">
        <span className="row-title">{c.host}</span>
        <span className="row-sub">
          {describe(c)} · stored {shortTime(c.updatedAt, now)}
          {c.rejectedAt !== null && <span className="tag refused">Refused by the host</span>}
        </span>
        <Problem problem={action.problem} />
      </div>
      {removing ? (
        <button
          type="button"
          className="button danger"
          onClick={() => action.run(() => api.deleteCredential(team, c.host))}
        >
          Remove with its grants
        </button>
      ) : (
        <button type="button" className="button quiet" onClick={() => setRemoving(true)}>
          Remove…
        </button>
      )}
    </li>
  );
}

type FormProps = {
  team: string;
  /** A host the form is for; without one the owner types it. */
  host?: string;
  /** The credential being replaced, to start from its scheme and names. */
  replacing?: CredentialView;
  /** Called once the credential is stored; with it the form also offers Cancel. */
  onClose?: () => void;
};

/** Write-only: the secret goes to the broker once and the field is cleared when it has arrived. */
export function CredentialForm({ team, host: fixed, replacing, onClose }: FormProps) {
  const [github, setGithub] = useState(fixed === undefined || GITHUB_HOSTS.includes(fixed));
  const [host, setHost] = useState("");
  const [scheme, setScheme] = useState<CredentialScheme>(replacing?.scheme ?? "bearer");
  const [username, setUsername] = useState(replacing?.username ?? "");
  const [headerName, setHeaderName] = useState(replacing?.headerName ?? "");
  const [secret, setSecret] = useState("");
  const action = useAction();
  const target = (fixed ?? host).trim().toLowerCase();

  const name = scheme === "basic" ? username.trim() : headerName.trim();
  const body: PutCredentialBody | null =
    !secret || (scheme !== "bearer" && !name)
      ? null
      : scheme === "basic"
        ? { scheme, username: name, secret }
        : scheme === "header"
          ? { scheme, headerName: name, secret }
          : { scheme, secret };
  const writes = github
    ? secret &&
      githubCredentials(secret).map(
        ([h, b]) =>
          () =>
            api.putCredential(team, h, b),
      )
    : target && body && [() => api.putCredential(team, target, body)];

  function store(): void {
    if (!writes || action.pending) return;
    action.run(
      () => inOrder(writes),
      () => {
        setSecret("");
        setHost("");
        onClose?.();
      },
    );
  }

  return (
    <form
      className={action.pending ? "credential-form pending" : "credential-form"}
      onSubmit={(event) => {
        event.preventDefault();
        store();
      }}
    >
      {fixed === undefined && (
        <fieldset className="segmented" aria-label="Kind">
          <button type="button" aria-pressed={github} onClick={() => setGithub(true)}>
            GitHub
          </button>
          <button type="button" aria-pressed={!github} onClick={() => setGithub(false)}>
            Other host
          </button>
        </fieldset>
      )}
      {!github && fixed === undefined && (
        <label className="field">
          <span>Host</span>
          <input
            className="mono"
            value={host}
            placeholder="api.example.com"
            spellCheck={false}
            autoCapitalize="off"
            onChange={(event) => setHost(event.target.value)}
          />
        </label>
      )}
      {!github && (
        <div className="field">
          <span>Sent as</span>
          <fieldset className="segmented" aria-label="Scheme">
            {Object.entries(SCHEMES).map(([s, label]) => (
              <button
                key={s}
                type="button"
                aria-pressed={s === scheme}
                onClick={() => setScheme(s as CredentialScheme)}
              >
                {label}
              </button>
            ))}
          </fieldset>
        </div>
      )}
      {!github && scheme === "basic" && (
        <label className="field">
          <span>Username</span>
          <input value={username} spellCheck={false} onChange={(event) => setUsername(event.target.value)} />
        </label>
      )}
      {!github && scheme === "header" && (
        <label className="field">
          <span>Header name</span>
          <input
            className="mono"
            value={headerName}
            placeholder="X-Api-Key"
            spellCheck={false}
            onChange={(event) => setHeaderName(event.target.value)}
          />
        </label>
      )}
      <label className="field">
        <span>{github ? "Fine-grained personal access token" : scheme === "basic" ? "Password" : "Secret"}</span>
        <input
          type="password"
          className="mono"
          value={secret}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => setSecret(event.target.value)}
        />
        {github && (
          <small className="field-hint">
            Stored twice: for git on github.com and for the API on api.github.com. Its repositories and permissions are
            the most the team can ever have.
          </small>
        )}
      </label>
      <Problem problem={action.problem} />
      <div className="form-actions">
        {onClose && (
          <button type="button" className="button quiet" onClick={onClose}>
            Cancel
          </button>
        )}
        <button type="submit" className="button primary" disabled={!writes}>
          {github ? "Store token" : "Store credential"}
        </button>
      </div>
    </form>
  );
}
