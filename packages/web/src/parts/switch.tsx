import type { WriteResult } from "@a12s-studio/contract/api";
import { useAction } from "../api.ts";
import { Problem } from "./problem.tsx";

/** A switch whose flip is its write. */
export function Switch({ label, on, set }: { label: string; on: boolean; set: (on: boolean) => Promise<WriteResult> }) {
  const action = useAction();
  return (
    <div className="switch-row">
      <SwitchButton label={label} on={on} pending={action.pending} flip={() => action.run(() => set(!on))} />
      <Problem problem={action.problem} />
    </div>
  );
}

/** The switch alone, for a flip that asks first. */
export function SwitchButton({
  label,
  on,
  pending,
  flip,
}: {
  label: string;
  on: boolean;
  pending: boolean;
  flip: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      className={pending ? "switch pending" : "switch"}
      onClick={flip}
    >
      <span className="switch-label">{label}</span>
      <span className="switch-track">
        <span className="switch-knob" />
      </span>
    </button>
  );
}
