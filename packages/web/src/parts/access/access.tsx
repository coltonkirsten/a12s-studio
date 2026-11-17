import { type AccessState, Rev } from "../../api.ts";
import { Problem } from "../problem.tsx";
import { Credentials } from "./credentials.tsx";
import { Grants } from "./grants.tsx";

/** A team's credentials and grants. A change here is finished once the re-read access includes it. */
export function Access({ team, access }: { team: string; access: AccessState }) {
  if (!access.view) return <Problem problem={access.problem} />;
  return (
    <Rev.Provider value={access.rev}>
      <Credentials team={team} credentials={access.view.credentials} />
      <Grants team={team} grants={access.view.grants} />
      <Problem problem={access.problem} />
    </Rev.Provider>
  );
}
