import type { ErrorBody, RulesPage, RuleVersion, WriteResult } from "@a12s-studio/contract/api";
import { useContext, useState } from "react";
import { Rev, useAction, useRead } from "../api.ts";
import { changes, type DiffRow, diff } from "../logic/diff.ts";
import { displayName } from "../logic/names.ts";
import { shortTime } from "../logic/time.ts";
import { Editor } from "../screens/inspector/editor.tsx";
import { Problem } from "./problem.tsx";

type Props = {
  // What the text belongs to (a team, an agent), so older pages read for one are never shown for another.
  id: string;
  label: string;
  load: (before?: number) => Promise<RulesPage>;
  save: (body: string) => Promise<WriteResult>;
};

// Older pages, read below `cursor`. Versions are never changed or removed, so they still follow the newest page as
// long as that page reaches down to the cursor; past that, versions written since would be missing between them.
type Older = { id: string; cursor: number } & RulesPage;

/**
 * A text kept as versions: the text now in an editor, then its history, newest first. Each version shows who wrote
 * it, when, and what it changed from the one before. Restoring an earlier one saves its text as the newest.
 */
export function Versions({ id, label, load, save }: Props) {
  const rev = useContext(Rev);
  const newest = useRead(() => load(), `${id}:${rev}`);
  const [older, setOlder] = useState<Older | null>(null);
  const [reading, setReading] = useState(false);
  const [problem, setProblem] = useState<ErrorBody | null>(null);

  const page = newest.data;
  const oldest = page?.versions.at(-1)?.id;
  const follows = older !== null && older.id === id && oldest !== undefined && oldest <= older.cursor;
  const versions = [...(page?.versions ?? []), ...(follows ? older.versions.filter((v) => v.id < oldest) : [])];
  const hasMore = follows ? older.hasMore : (page?.hasMore ?? false);
  const now = versions[0];

  function readOlder(): void {
    const before = versions.at(-1)?.id;
    if (before === undefined) return;
    setReading(true);
    setProblem(null);
    load(before)
      .then(
        (next) =>
          setOlder({
            id,
            cursor: follows ? older.cursor : before,
            versions: [...(follows ? older.versions : []), ...next.versions],
            hasMore: next.hasMore,
          }),
        (error: ErrorBody) => setProblem(error),
      )
      .finally(() => setReading(false));
  }

  return (
    <div className="versions">
      {page && <Editor key={`${id}:${now?.id}`} label={label} value={now?.body ?? ""} save={save} />}
      <Problem problem={newest.problem} />
      {versions.length > 0 && (
        <>
          <h3 className="versions-head">History</h3>
          <ol className="group versions-list">
            {versions.map((version, i) => (
              <Version
                key={version.id}
                version={version}
                previous={versions[i + 1]}
                first={i === versions.length - 1 && !hasMore}
                isNow={i === 0}
                canRestore={version.body !== now?.body}
                restore={() => save(version.body)}
              />
            ))}
          </ol>
        </>
      )}
      <Problem problem={problem} />
      {hasMore && (
        <button type="button" className={reading ? "button quiet add pending" : "button quiet add"} onClick={readOlder}>
          Show older
        </button>
      )}
    </div>
  );
}

type VersionProps = {
  version: RuleVersion;
  // The version it replaced; missing for the first version, and for the oldest one read while older ones exist.
  previous: RuleVersion | undefined;
  first: boolean;
  isNow: boolean;
  canRestore: boolean;
  restore: () => Promise<WriteResult>;
};

function Version({ version, previous, first, isNow, canRestore, restore }: VersionProps) {
  const [open, setOpen] = useState(false);
  const action = useAction();
  const rows = previous || first ? diff(previous?.body ?? "", version.body) : null;
  const { added, removed } = rows ? changes(rows) : { added: 0, removed: 0 };
  return (
    <li className="version">
      <button type="button" className="version-row" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="version-who">{displayName(version.author)}</span>
        <time>{shortTime(version.at, Date.now())}</time>
        {isNow && <span className="tag now">Now</span>}
        <span className="version-count">
          {first && <span className="first">First version</span>}
          {!first && added > 0 && <span className="added">+{added}</span>}
          {!first && removed > 0 && <span className="removed">−{removed}</span>}
        </span>
      </button>
      {open && (
        <div className="version-detail">
          <Lines rows={rows ?? [{ kind: "same", text: version.body }]} />
          {canRestore && (
            <div className="form-actions">
              <button
                type="button"
                className={action.pending ? "button quiet pending" : "button quiet"}
                onClick={() => action.run(restore)}
              >
                Restore this version
              </button>
            </div>
          )}
          <Problem problem={action.problem} />
        </div>
      )}
    </li>
  );
}

function Lines({ rows }: { rows: DiffRow[] }) {
  return (
    <pre className="diff">
      {rows.map((row, i) =>
        row.kind === "skip" ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: a row has no identity beyond its place in the diff.
          <span key={i} className="diff-skip">
            {row.count} unchanged lines
          </span>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: a row has no identity beyond its place in the diff.
          <span key={i} className={`diff-${row.kind}`}>
            {row.text || " "}
          </span>
        ),
      )}
    </pre>
  );
}
