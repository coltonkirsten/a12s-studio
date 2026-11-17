import type { ErrorBody } from "@a12s-studio/contract/api";
import type { AgentView } from "@a12s-studio/contract/state";
import { api, useAction } from "../../api.ts";
import { displayName } from "../../logic/names.ts";
import { Problem } from "../../parts/problem.tsx";

/** A read the agent refused: asleep is the one case the inspector can fix, with Wake. */
export function Refusal({ agent, problem, what }: { agent: AgentView; problem: ErrorBody | null; what: string }) {
  if (problem?.code !== "asleep") return <Problem problem={problem} />;
  return <Asleep agent={agent} what={what} />;
}

export function Asleep({ agent, what }: { agent: AgentView; what: string }) {
  const wake = useAction();
  return (
    <div className="inspector-asleep">
      <p>
        {displayName(agent.id)} is asleep. {what}
      </p>
      <button
        type="button"
        className={wake.pending ? "button primary pending" : "button primary"}
        onClick={() => wake.run(() => api.power(agent.id, "awake"))}
      >
        Wake
      </button>
      <Problem problem={wake.problem} />
    </div>
  );
}
