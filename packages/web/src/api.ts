import type {
  CreateTeamBody,
  ErrorBody,
  HireBody,
  NewThreadBody,
  PatchSettingsBody,
  PatchTeamBody,
  PatchThreadBody,
  PostMessageBody,
  PowerBody,
  Template,
  WriteResult,
} from "@a12s-studio/contract/api";
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";

const UNREACHABLE: ErrorBody = {
  code: "unreachable",
  message: "Studio is not answering.",
  fix: "Check that the app is running.",
};

function isErrorBody(value: unknown): value is ErrorBody {
  return typeof value === "object" && value !== null && "message" in value && typeof value.message === "string";
}

async function call(method: string, path: string, body?: unknown): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw UNREACHABLE;
  }
  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) throw isErrorBody(data) ? data : { code: `http_${res.status}`, message: res.statusText };
  return data;
}

async function write(method: string, path: string, body?: unknown): Promise<WriteResult> {
  const data = await call(method, path, body);
  if (typeof data !== "object" || data === null || !("rev" in data) || typeof data.rev !== "number") {
    throw { code: "bad_response", message: "Studio answered without a revision." } satisfies ErrorBody;
  }
  return { rev: data.rev, id: "id" in data && typeof data.id === "string" ? data.id : undefined };
}

const at = encodeURIComponent;

export const api = {
  async templates(): Promise<Template[]> {
    const data = await call("GET", "/templates");
    if (typeof data !== "object" || data === null || !("templates" in data) || !Array.isArray(data.templates)) {
      throw { code: "bad_response", message: "Studio sent no templates." } satisfies ErrorBody;
    }
    return data.templates as Template[];
  },
  createTeam: (body: CreateTeamBody) => write("POST", "/teams", body),
  patchTeam: (team: string, body: PatchTeamBody) => write("PATCH", `/teams/${at(team)}`, body),
  deleteTeam: (team: string) => write("DELETE", `/teams/${at(team)}`),
  hire: (team: string, body: HireBody) => write("POST", `/teams/${at(team)}/agents`, body),
  fire: (agent: string) => write("DELETE", `/agents/${at(agent)}`),
  power: (agent: string, state: PowerBody["state"]) => write("POST", `/agents/${at(agent)}/power`, { state }),
  stop: (agent: string) => write("POST", `/agents/${at(agent)}/stop`),
  newThread: (team: string, body: NewThreadBody) => write("POST", `/teams/${at(team)}/threads`, body),
  post: (thread: string, body: PostMessageBody) => write("POST", `/threads/${at(thread)}/messages`, body),
  patchThread: (thread: string, body: PatchThreadBody) => write("PATCH", `/threads/${at(thread)}`, body),
  patchSettings: (body: PatchSettingsBody) => write("PATCH", "/settings", body),
};

/** The rev of the state on screen, so an action can tell when its write has arrived. */
export const Rev = createContext(0);

export type Action = {
  pending: boolean;
  problem: ErrorBody | null;
  run: (write: () => Promise<WriteResult>, done?: (result: WriteResult) => void) => void;
};

/** A write is finished when a pushed state with at least its rev has arrived, never when the response does. */
export function useAction(): Action {
  const rev = useContext(Rev);
  const [sending, setSending] = useState(false);
  const [waiting, setWaiting] = useState<WriteResult | null>(null);
  const [problem, setProblem] = useState<ErrorBody | null>(null);
  const done = useRef<((result: WriteResult) => void) | undefined>(undefined);

  useEffect(() => {
    if (!waiting || rev < waiting.rev) return;
    setWaiting(null);
    done.current?.(waiting);
  }, [rev, waiting]);

  const run = useCallback((write: () => Promise<WriteResult>, then?: (result: WriteResult) => void) => {
    done.current = then;
    setProblem(null);
    setSending(true);
    write()
      .then(setWaiting, (error: unknown) =>
        setProblem(isErrorBody(error) ? error : { code: "error", message: String(error) }),
      )
      .finally(() => setSending(false));
  }, []);

  return { pending: sending || waiting !== null, problem, run };
}
