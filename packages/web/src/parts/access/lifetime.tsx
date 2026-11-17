import { type Lifetime, lifetimeLabel, lifetimes } from "../../logic/grants.ts";

/** How long a grant lasts; `wanted` is what an agent asked for, offered even when it is not a usual choice. */
export function LifetimePicker({
  value,
  wanted,
  set,
}: {
  value: Lifetime;
  wanted: Lifetime;
  set: (days: Lifetime) => void;
}) {
  return (
    <fieldset className="segmented lifetime" aria-label="Lifetime">
      {lifetimes(wanted).map((days) => (
        <button key={String(days)} type="button" aria-pressed={days === value} onClick={() => set(days)}>
          {lifetimeLabel(days)}
        </button>
      ))}
    </fieldset>
  );
}
