import type { WriteResult } from "@a12s-studio/contract/api";
import { useAction } from "../api.ts";
import { Problem } from "./problem.tsx";

export function Switch({ label, on, set }: { label: string; on: boolean; set: (on: boolean) => Promise<WriteResult> }) {
  const action = useAction();
  return (
    <div className="switch-row">
      <button
        type="button"
        role="switch"
        aria-checked={on}
        className={action.pending ? "switch pending" : "switch"}
        onClick={() => action.run(() => set(!on))}
      >
        <span className="switch-label">{label}</span>
        <span className="switch-track">
          <span className="switch-knob" />
        </span>
      </button>
      <Problem problem={action.problem} />
    </div>
  );
}
