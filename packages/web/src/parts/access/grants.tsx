import type { CreateGrantBody, Grant } from "@a12s-studio/contract/broker-admin";
import { useState } from "react";
import { api, useAction } from "../../api.ts";
import { activeGrants, expiresAt, expiryText, type Lifetime, METHODS } from "../../logic/grants.ts";
import { parseRepo, presetGrant } from "../../logic/presets.ts";
import { Problem } from "../problem.tsx";
import { LifetimePicker } from "./lifetime.tsx";

export function Grants({ team, grants }: { team: string; grants: Grant[] }) {
  const [adding, setAdding] = useState(false);
  const now = Date.now();
  const active = activeGrants(grants, now);
  return (
    <div className="access-part">
      <h3>Grants</h3>
      <p className="part-hint">What the team’s agents may call. Anything else is refused.</p>
      {active.length > 0 && (
        <ul className="group">
          {active.map((g) => (
            <GrantRow key={g.id} team={team} grant={g} now={now} />
          ))}
        </ul>
      )}
      {adding ? (
        <div className="group form">
          <GrantForm team={team} onClose={() => setAdding(false)} />
        </div>
      ) : (
        <button type="button" className="button quiet add" onClick={() => setAdding(true)}>
          Add a grant…
        </button>
      )}
    </div>
  );
}

/** The exact change a grant makes: host, methods, paths. */
export function GrantLines({ grant }: { grant: Pick<CreateGrantBody, "host" | "methods" | "paths"> }) {
  return (
    <span className="grant-lines">
      <span className="row-title">
        {grant.host} <span className="methods">{grant.methods.join(" ")}</span>
      </span>
      {grant.paths.map((path) => (
        <code key={path}>{path}</code>
      ))}
    </span>
  );
}

function GrantRow({ team, grant, now }: { team: string; grant: Grant; now: number }) {
  const action = useAction();
  return (
    <li className={action.pending ? "row pending" : "row"}>
      <div className="row-main">
        <GrantLines grant={grant} />
        <span className="row-sub">{expiryText(grant.expiresAt, now)}</span>
        <Problem problem={action.problem} />
      </div>
      <button type="button" className="button quiet" onClick={() => action.run(() => api.revoke(team, grant.id))}>
        Revoke
      </button>
    </li>
  );
}

type Kind = "read" | "write" | "api" | "host";

const KINDS: { kind: Kind; label: string; hint: string }[] = [
  { kind: "read", label: "Repository, read", hint: "Clone and fetch" },
  { kind: "write", label: "Repository, read and write", hint: "Clone, fetch and push" },
  { kind: "api", label: "Repository API", hint: "api.github.com for one repository" },
  { kind: "host", label: "Any host", hint: "Your own methods and paths" },
];

function GrantForm({ team, onClose }: { team: string; onClose: () => void }) {
  const [kind, setKind] = useState<Kind>("write");
  const [repoText, setRepoText] = useState("");
  const [host, setHost] = useState("");
  const [pathsText, setPathsText] = useState("");
  const [methods, setMethods] = useState<string[]>(["GET"]);
  const [lifetime, setLifetime] = useState<Lifetime>(90);
  const action = useAction();

  const repo = parseRepo(repoText);
  const paths = pathsText
    .split("\n")
    .map((p) => p.trim())
    .filter(Boolean);
  const grant: CreateGrantBody | null =
    kind === "host"
      ? host.trim() && paths.length > 0 && methods.length > 0
        ? { host: host.trim().toLowerCase(), methods, paths }
        : null
      : repo && (kind !== "api" || methods.length > 0)
        ? presetGrant(repo, kind === "api" ? { kind, methods } : { kind })
        : null;

  function add(): void {
    if (!grant || action.pending) return;
    action.run(() => api.grant(team, { ...grant, expiresAt: expiresAt(lifetime, Date.now()) }), onClose);
  }

  return (
    <form
      className={action.pending ? "grant-form pending" : "grant-form"}
      onSubmit={(event) => {
        event.preventDefault();
        add();
      }}
    >
      <fieldset className="choices" aria-label="Kind">
        {KINDS.map((k) => (
          <button
            key={k.kind}
            type="button"
            className="choice"
            aria-pressed={k.kind === kind}
            onClick={() => setKind(k.kind)}
          >
            <b>{k.label}</b>
            <span>{k.hint}</span>
          </button>
        ))}
      </fieldset>
      {kind === "host" ? (
        <>
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
          <label className="field">
            <span>Paths, one per line</span>
            <textarea
              className="mono"
              rows={2}
              value={pathsText}
              placeholder={"/v1/items/*\n/v1/reports/**"}
              spellCheck={false}
              onChange={(event) => setPathsText(event.target.value)}
            />
            <small className="field-hint">
              * is one path segment; a final /** is the path and everything under it.
            </small>
          </label>
        </>
      ) : (
        <label className="field">
          <span>Repository</span>
          <input
            className="mono"
            value={repoText}
            placeholder="owner/repository"
            spellCheck={false}
            autoCapitalize="off"
            onChange={(event) => setRepoText(event.target.value)}
          />
        </label>
      )}
      {(kind === "api" || kind === "host") && (
        <div className="field">
          <span>Methods</span>
          <fieldset className="segmented" aria-label="Methods">
            {METHODS.map((m) => (
              <button
                key={m}
                type="button"
                aria-pressed={methods.includes(m)}
                onClick={() =>
                  setMethods(METHODS.filter((x) => (x === m ? !methods.includes(m) : methods.includes(x))))
                }
              >
                {m}
              </button>
            ))}
          </fieldset>
        </div>
      )}
      <div className="field">
        <span>Lasts</span>
        <LifetimePicker value={lifetime} wanted={null} set={setLifetime} />
      </div>
      {grant && (
        <div className="preview">
          <small>Adds</small>
          <GrantLines grant={grant} />
        </div>
      )}
      <Problem problem={action.problem} />
      <div className="form-actions">
        <button type="button" className="button quiet" onClick={onClose}>
          Cancel
        </button>
        <button type="submit" className="button primary" disabled={!grant}>
          Add grant
        </button>
      </div>
    </form>
  );
}
