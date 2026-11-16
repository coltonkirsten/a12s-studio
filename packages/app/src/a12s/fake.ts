import { randomUUID } from "node:crypto";
import { PassThrough } from "node:stream";
import { teamPrefix } from "@a12s-studio/contract/names";
import {
  type A12s,
  A12sError,
  type A12sEvent,
  type AgentSpec,
  type EventFeed,
  type ExternalService,
  type FileEntry,
  type InboxMessage,
  type ModelCosts,
  type Phase,
  type TeamA12s,
  type TurnRecord,
  type TurnStatus,
} from "./port.ts";

export type FakeAgent = {
  spec: AgentSpec;
  phase: Phase;
  error?: string;
  session: string;
  inbox: InboxMessage[];
  turns: TurnRecord[];
  journal: A12sEvent[];
  files: Map<string, Uint8Array>;
  current: { turn: string; startedAt: number; messageIds: string[]; text: string } | null;
};

export type TurnResult = { status?: TurnStatus; error?: string; modelCostsUsd?: ModelCosts };

export type FakeA12s = A12s & {
  services: ExternalService[];
  agents: Map<string, FakeAgent>;
  emit(event: A12sEvent): void;
  setPhase(name: string, phase: Phase, error?: string): void;
  startTurn(name: string): string;
  finishTurn(name: string, result?: TurnResult): void;
  // false: every open feed throws unreachable and new feeds do not become ready, as when the Controller stops.
  setReachable(up: boolean): void;
};

export function fakeA12s(): FakeA12s {
  const agents = new Map<string, FakeAgent>();
  const tokens = new Map<string, string>();
  const subscribers = new Set<(event: A12sEvent) => void>();
  const feeds = new Set<() => void>();
  let reachable = true;
  let counter = 0;
  const nextId = (prefix: string) => `${prefix}${++counter}`;

  function mustGet(name: string): FakeAgent {
    const agent = agents.get(name);
    if (!agent) throw new A12sError("not_found", `No agent computer named ${name}.`);
    return agent;
  }

  function emit(event: A12sEvent): void {
    if (event.type !== "gap") {
      const agent = mustGet(event.agent);
      agent.journal.push(event);
      if (event.type === "text.delta" && agent.current?.turn === event.turn) agent.current.text += event.text;
    }
    for (const push of subscribers) push(event);
  }

  function setPhase(name: string, phase: Phase, error?: string): void {
    const agent = mustGet(name);
    agent.phase = phase;
    agent.error = error;
    emit({ type: "agent_computer.phase", agent: name, at: Date.now(), phase, ...(error ? { error } : {}) });
  }

  function startTurn(name: string): string {
    const agent = mustGet(name);
    if (agent.phase === "Asleep") throw new Error(`fake a12s: ${name} is asleep and cannot start a Turn`);
    const turn = nextId("t_");
    const messageIds: string[] = [];
    for (const message of agent.inbox) {
      if (message.state !== "pending") continue;
      message.state = "delivered";
      messageIds.push(message.id);
    }
    const at = Date.now();
    agent.current = { turn, startedAt: at, messageIds, text: "" };
    setPhase(name, "Busy");
    emit({ type: "turn.started", agent: name, at, turn, messageIds });
    return turn;
  }

  function endTurn(name: string, result: TurnResult): void {
    const agent = mustGet(name);
    const current = agent.current;
    if (!current) throw new Error(`fake a12s: ${name} has no Turn running`);
    const at = Date.now();
    const status = result.status ?? "completed";
    const modelCostsUsd = result.modelCostsUsd ?? {};
    const error = result.error === undefined ? {} : { error: result.error };
    agent.current = null;
    agent.turns.unshift({
      id: current.turn,
      agent: name,
      session: agent.session,
      status,
      ...error,
      text: current.text,
      messageIds: current.messageIds,
      startedAt: current.startedAt,
      finishedAt: at,
      modelCostsUsd,
    });
    emit({
      type: "turn.finished",
      agent: name,
      at,
      turn: current.turn,
      session: agent.session,
      status,
      ...error,
      modelCostsUsd,
    });
  }

  function finishTurn(name: string, result: TurnResult = {}): void {
    endTurn(name, result);
    setPhase(name, "Ready");
  }

  function endActivity(name: string, phase: Phase): void {
    if (mustGet(name).current) endTurn(name, { status: "interrupted" });
    setPhase(name, phase);
  }

  function awake(name: string): FakeAgent {
    const agent = mustGet(name);
    if (agent.phase === "Asleep") throw new A12sError("asleep", `${name} is asleep.`, "Wake it first.");
    return agent;
  }

  function forTeam(token: string): TeamA12s {
    function team(): string {
      const name = tokens.get(token);
      if (name === undefined) throw new A12sError("forbidden", "Unknown token.");
      return name;
    }

    function own(name: string): string {
      const prefix = teamPrefix(team());
      if (!name.startsWith(prefix)) throw new A12sError("out_of_prefix", `${name} is outside the prefix ${prefix}.`);
      return name;
    }

    return {
      async removeAgent(name) {
        mustGet(own(name));
        agents.delete(name);
      },
      async send(name, message) {
        const agent = mustGet(own(name));
        for (const old of agent.inbox) {
          if (old.state === "pending" && old.replaceKey === message.replaceKey) old.state = "replaced";
        }
        const sent: InboxMessage = {
          id: nextId("m_"),
          state: "pending",
          sender: "studio",
          via: `token:${team()}`,
          body: message.body,
          metadata: message.metadata,
          replaceKey: message.replaceKey,
          createdAt: Date.now(),
        };
        agent.inbox.push(sent);
        return { id: sent.id, state: sent.state };
      },
      async wake(name) {
        if (mustGet(own(name)).phase === "Asleep") setPhase(name, "Ready");
      },
      async sleep(name) {
        if (mustGet(own(name)).phase !== "Asleep") endActivity(name, "Asleep");
      },
      async stop(name) {
        if (mustGet(own(name)).current) endActivity(name, "Ready");
      },
      async status() {
        const prefix = teamPrefix(team());
        return [...agents]
          .filter(([name]) => name.startsWith(prefix))
          .map(([name, agent]) => ({
            name,
            phase: agent.phase,
            ...(agent.error ? { error: agent.error } : {}),
            pending: agent.inbox.filter((m) => m.state === "pending").length,
          }));
      },
      async inbox(name) {
        return mustGet(own(name)).inbox.map((m) => ({ ...m }));
      },
      async withdraw(name, messageId) {
        const message = mustGet(own(name)).inbox.find((m) => m.id === messageId);
        if (!message) throw new A12sError("not_found", `No Message ${messageId}.`);
        if (message.state !== "pending") throw new A12sError("busy", `Message ${messageId} is ${message.state}.`);
        message.state = "withdrawn";
      },
      async clearInbox(name) {
        for (const message of mustGet(own(name)).inbox) {
          if (message.state === "pending") message.state = "withdrawn";
        }
      },
      async turns(name, limit) {
        return mustGet(own(name)).turns.slice(0, limit);
      },
      async *turnEvents(name, turn) {
        for (const event of awake(own(name)).journal) {
          if ("turn" in event && event.turn === turn) yield event;
        }
      },
      async readFile(name, path) {
        const files = awake(own(name)).files;
        const content = files.get(path);
        if (content) {
          return {
            kind: "file",
            path,
            size: content.byteLength,
            modTime: 0,
            encoding: "utf-8",
            content: new TextDecoder().decode(content),
            truncated: false,
          };
        }
        const entries = new Map<string, FileEntry>();
        for (const [file, bytes] of files) {
          if (!file.startsWith(`${path}/`)) continue;
          const [child = "", ...rest] = file.slice(path.length + 1).split("/");
          const kind = rest.length > 0 ? "dir" : "file";
          entries.set(child, { name: child, kind, size: kind === "file" ? bytes.byteLength : 0, modTime: 0 });
        }
        if (entries.size === 0) throw new A12sError("not_found", `No file or folder at ${path}.`);
        return { kind: "dir", path, entries: [...entries.values()] };
      },
      async writeFile(name, path, content) {
        awake(own(name)).files.set(path, content);
      },
      async openTerminal(name) {
        awake(own(name));
        return { stream: new PassThrough(), resize: async () => {} };
      },
    };
  }

  const fake: FakeA12s = {
    services: [],
    agents,
    emit,
    setPhase,
    startTurn,
    finishTurn,
    setReachable(up) {
      reachable = up;
      if (!up) for (const drop of feeds) drop();
    },
    async ensureServices(services) {
      fake.services = services;
    },
    async createToken(team) {
      if ([...tokens.values()].includes(team)) throw new A12sError("exists", `A token for ${team} exists.`);
      const secret = `a12st_${randomUUID()}`;
      tokens.set(secret, team);
      return secret;
    },
    async removeToken(team) {
      for (const [secret, owner] of tokens) if (owner === team) tokens.delete(secret);
    },
    async putAgent(name, spec, mode) {
      const existing = agents.get(name);
      if (existing && mode === "create") throw new A12sError("exists", `${name} exists.`);
      if (existing) {
        existing.spec = spec;
        return;
      }
      agents.set(name, {
        spec,
        phase: "Ready",
        session: nextId("s_"),
        inbox: [],
        turns: [],
        journal: [],
        files: new Map(),
        current: null,
      });
      setPhase(name, "Ready");
    },
    events(): EventFeed {
      const queue: A12sEvent[] = [];
      let wakeUp: (() => void) | null = null;
      let closed = false;
      let lost = false;
      const push = (event: A12sEvent) => {
        queue.push(event);
        wakeUp?.();
      };
      const drop = () => {
        lost = true;
        wakeUp?.();
      };
      subscribers.add(push);
      feeds.add(drop);
      const end = () => {
        subscribers.delete(push);
        feeds.delete(drop);
      };
      return {
        ready: async () => {
          if (!reachable) {
            end();
            throw new A12sError("unreachable", "a12s is not answering.");
          }
        },
        close() {
          closed = true;
          end();
          wakeUp?.();
        },
        async *[Symbol.asyncIterator]() {
          try {
            while (true) {
              if (lost) throw new A12sError("unreachable", "a12s is not answering.");
              const event = queue.shift();
              if (event) yield event;
              else if (closed) return;
              else await new Promise<void>((resolve) => (wakeUp = resolve));
            }
          } finally {
            end();
          }
        },
      };
    },
    forTeam,
  };
  return fake;
}
