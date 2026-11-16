import type { ErrorBody } from "@a12s-studio/contract/api";

export function Problem({ problem }: { problem: ErrorBody | null }) {
  if (!problem) return null;
  return (
    <p className="problem" role="alert">
      {problem.message} {problem.fix}
    </p>
  );
}
