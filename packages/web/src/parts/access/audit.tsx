import type { ErrorBody } from "@a12s-studio/contract/api";
import type { AuditAction, AuditEntry, AuditPage } from "@a12s-studio/contract/broker-admin";
import { useEffect, useState } from "react";
import { api } from "../../api.ts";
import { displayName } from "../../logic/names.ts";
import { shortTime } from "../../logic/time.ts";
import { Problem } from "../problem.tsx";

const DOES: Record<AuditAction, string> = {
  call: "called",
  deny: "was refused",
  "credential.set": "stored a credential",
  "credential.delete": "removed a credential",
  "credential.rejected": "had its credential refused",
  "grant.create": "granted",
  "grant.revoke": "revoked",
  "grant.expire": "let a grant expire",
  "request.create": "asked for",
  "request.approve": "approved",
  "request.deny": "denied",
  "team.purge": "removed all access",
};

function who(entry: AuditEntry): string {
  if (entry.actor === "broker") return "Broker";
  if (entry.actor === "owner") return displayName("owner");
  return entry.agentId ? displayName(entry.agentId) : "An unknown caller";
}

/** Newest first; older pages are plain reads, appended below. */
export function AuditLog({ team }: { team: string }) {
  const [page, setPage] = useState<AuditPage | null>(null);
  const [loading, setLoading] = useState(false);
  const [problem, setProblem] = useState<ErrorBody | null>(null);

  function load(before?: number): void {
    setLoading(true);
    setProblem(null);
    api
      .audit(team, before)
      .then(
        (next) =>
          setPage((p) => (p && before !== undefined ? { ...next, entries: [...p.entries, ...next.entries] } : next)),
        (error: ErrorBody) => setProblem(error),
      )
      .finally(() => setLoading(false));
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: the newest page is read once per team.
  useEffect(() => load(), [team]);

  const now = Date.now();
  const last = page?.entries.at(-1);
  return (
    <div className="access-part">
      {page && page.entries.length === 0 && <p className="part-hint">No calls or changes yet.</p>}
      {page && page.entries.length > 0 && (
        <ol className="group audit">
          {page.entries.map((e) => (
            <li key={e.id}>
              <time>{shortTime(e.at, now)}</time>
              <span>
                <b className="who">{who(e)}</b> {DOES[e.action]}
              </span>
              <code>{[e.method, e.host && `${e.host}${e.path ?? ""}`].filter(Boolean).join(" ")}</code>
              <span className={e.status !== null && e.status >= 400 ? "status refused" : "status"}>
                {e.status ?? e.detail ?? ""}
              </span>
            </li>
          ))}
        </ol>
      )}
      <Problem problem={problem} />
      {page?.hasMore && last && (
        <button
          type="button"
          className={loading ? "button quiet add pending" : "button quiet add"}
          onClick={() => load(last.id)}
        >
          Show older
        </button>
      )}
    </div>
  );
}
