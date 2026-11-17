import type { WriteResult } from "@a12s-studio/contract/api";
import { useState } from "react";
import { useAction } from "../api.ts";
import { Problem } from "./problem.tsx";

type Props = {
  label: string;
  value: string;
  save: (text: string) => Promise<WriteResult>;
  // Called once the write has arrived, for a read that the state's rev does not move (a file).
  saved?: () => void;
  mono?: boolean;
};

/**
 * Text the owner edits in place. Mount it with `key={value}`: a new value from the server replaces the draft, and a
 * saved draft stays on screen until the read that replaces it arrives.
 */
export function Editor({ label, value, save, saved, mono = false }: Props) {
  const [draft, setDraft] = useState(value);
  const action = useAction();
  const changed = draft !== value;
  return (
    <div className="editor">
      <label className="field">
        <span>{label}</span>
        <textarea
          className={mono ? "mono" : undefined}
          value={draft}
          spellCheck={!mono}
          onChange={(event) => setDraft(event.target.value)}
        />
      </label>
      <div className="inspector-actions">
        {changed && !action.pending && (
          <button type="button" className="button quiet" onClick={() => setDraft(value)}>
            Revert
          </button>
        )}
        <button
          type="button"
          className={action.pending ? "button primary pending" : "button primary"}
          disabled={!changed}
          onClick={() => action.run(() => save(draft), saved)}
        >
          Save
        </button>
      </div>
      <Problem problem={action.problem} />
    </div>
  );
}
