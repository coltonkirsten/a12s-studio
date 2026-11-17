import type { MessageId, ThreadId } from "@a12s-studio/contract/names";
import type { BoardStatus, MessageKind, ThreadStatus } from "@a12s-studio/contract/state";
import type { TurnStatus } from "./a12s/port.ts";
import type { Caller } from "./caller.ts";
import { StudioError } from "./errors.ts";
import type { Agent, BoardRow, NewMessage, TeamRepo, Thread } from "./repo.ts";

type PostInput = { kind: MessageKind; body: string; to?: string; thread?: string; title?: string; ask?: string };
type Posted = { message: MessageId; thread: ThreadId };
type FinishedTurn = {
  agentId: string;
  status: TurnStatus;
  text: string;
  startedAt: number;
  messageIds: string[];
};

export const BODY_MAX = 32000;
export const TITLE_MAX = 120;

const FIELDS: Record<MessageKind, { allowed: (keyof PostInput)[]; fix: string }> = {
  ask: { allowed: ["to", "thread", "title"], fix: "An ask takes to, and thread or title." },
  reply: { allowed: ["ask"], fix: "A reply takes only ask: the id of the ask you answer." },
  note: { allowed: ["to", "thread"], fix: "A note takes thread, and optionally to." },
};

// How an id is shown to agents: an agent by its slug, "owner" and "system" as they are.
export function nameOf(id: string): string {
  return id.slice(id.indexOf("-") + 1);
}

// A thread needs the owner while it is open and holds an ask to the owner with no reply.
export function boardStatus(thread: BoardRow): BoardStatus {
  if (thread.status === "done") return "done";
  return thread.asksForOwner > 0 ? "needs_you" : "open";
}

function refuse(code: string, message: string, fix: string): never {
  throw new StudioError(400, code, message, fix);
}

function notFound(message: string, fix: string): never {
  throw new StudioError(404, "not_found", message, fix);
}

// Only a current agent has an inbox to deliver to: the owner, a note to the thread and a reply to an asker who has
// left the team are just recorded.
function insert(team: TeamRepo, m: NewMessage): MessageId {
  const delivery = m.toId !== null && team.agent(m.toId) ? "queued" : "none";
  return team.insertMessage(m, delivery, Date.now());
}

function mustThread(team: TeamRepo, id: string): Thread {
  return team.thread(id) ?? notFound(`No thread ${id}.`, "Use read to see the team's threads.");
}

function agentReceiver(team: TeamRepo, caller: Caller, to: string): string {
  if (to === "owner") return "owner";
  const agent =
    team.agentBySlug(to) ??
    notFound(`No agent named "${to}" on your team.`, 'Use roster to see who is on your team, or write to "owner".');
  if (agent.id === caller.agentId) {
    refuse("self", "You cannot post to yourself.", "Keep it in your notes, or post a note to the thread without to.");
  }
  return agent.id;
}

function ownerReceiver(team: TeamRepo, slug: string): Agent {
  return (
    team.agentBySlug(slug) ?? notFound(`No agent named "${slug}" on this team.`, "Address a current agent with @.")
  );
}

function reply(team: TeamRepo, fromId: string, askId: string, body: string, threadId?: string): Posted {
  const ask = team.message(askId);
  if (!ask || (threadId !== undefined && ask.threadId !== threadId)) {
    notFound(`No message ${askId}.`, "Use read on the thread to find the ask's id.");
  }
  if (ask.kind !== "ask") {
    refuse("not_an_ask", `${askId} is a ${ask.kind}; only an ask takes a reply.`, "Post a note to the thread instead.");
  }
  if (ask.toId !== fromId) {
    refuse("not_yours", `The ask ${askId} is not addressed to you.`, "Only its receiver replies; post a note instead.");
  }
  if (ask.fromId === "system" || ask.threadId === null) {
    refuse("system_ask", `${askId} is from Studio and takes no reply.`, "Carry on with the work it describes.");
  }
  if (team.hasReply(askId)) {
    refuse("replied", `The ask ${askId} already has its reply.`, "Post a note to the thread to add more.");
  }
  const threadOf = ask.threadId;
  const message = insert(team, { threadId: threadOf, kind: "reply", fromId, toId: ask.fromId, askId: ask.id, body });
  return { message, thread: threadOf };
}

export function agentPost(team: TeamRepo, caller: Caller, input: PostInput): Posted {
  const { allowed, fix } = FIELDS[input.kind];
  for (const field of ["to", "thread", "title", "ask"] as const) {
    if (input[field] !== undefined && !allowed.includes(field)) {
      refuse("bad_field", `A ${input.kind} takes no ${field}.`, fix);
    }
  }
  return team.tx(() => {
    const fromId = caller.agentId;
    if (input.kind === "reply") {
      if (input.ask === undefined) refuse("missing_ask", "A reply needs ask.", fix);
      return reply(team, fromId, input.ask, input.body);
    }
    if (input.kind === "note") {
      if (input.thread === undefined) refuse("missing_thread", "A note needs thread.", fix);
      const thread = mustThread(team, input.thread).id;
      const toId = input.to === undefined ? null : agentReceiver(team, caller, input.to);
      return {
        message: insert(team, { threadId: thread, kind: "note", fromId, toId, askId: null, body: input.body }),
        thread,
      };
    }
    if (input.to === undefined) refuse("missing_to", "An ask needs to.", 'Set to to a name from roster, or "owner".');
    const toId = agentReceiver(team, caller, input.to);
    let thread: ThreadId;
    if (input.thread !== undefined && input.title !== undefined) {
      refuse(
        "thread_or_title",
        "An ask takes thread or title, not both.",
        "Give thread to continue one, or title to start one.",
      );
    } else if (input.thread !== undefined) {
      thread = mustThread(team, input.thread).id;
    } else if (input.title !== undefined) {
      thread = team.insertThread(input.title, fromId, Date.now());
    } else {
      refuse("missing_thread", "An ask needs thread or title.", "Give thread to continue one, or title to start one.");
    }
    return {
      message: insert(team, { threadId: thread, kind: "ask", fromId, toId, askId: null, body: input.body }),
      thread,
    };
  });
}

// The owner writing in a thread: with `ask`, the reply to that ask; otherwise an ask to the agent named in `to`,
// else to the thread's owner.
export function ownerPost(
  team: TeamRepo,
  threadId: string,
  input: { body: string; to?: string; ask?: string },
): Posted {
  return team.tx(() => {
    if (input.ask !== undefined) {
      if (input.to !== undefined)
        refuse("bad_field", "A reply takes no to.", "Leave out to; the reply goes to the asker.");
      return reply(team, "owner", input.ask, input.body, threadId);
    }
    const thread = mustThread(team, threadId);
    const to =
      input.to === undefined
        ? (team.agent(thread.ownerAgentId) ??
          notFound("This thread's owner has left the team.", "Address a current agent with @."))
        : ownerReceiver(team, input.to);
    const message = insert(team, {
      threadId: thread.id,
      kind: "ask",
      fromId: "owner",
      toId: to.id,
      askId: null,
      body: input.body,
    });
    return { message, thread: thread.id };
  });
}

// A new thread from the owner: an ask to the agent named in `to`, else to the lead, who owns the thread.
export function ownerThread(team: TeamRepo, input: { title?: string; body: string; to?: string }): Posted {
  return team.tx(() => {
    const leadId = team.team()?.leadAgentId;
    const to =
      input.to === undefined
        ? (leadId && team.agent(leadId)) || notFound("This team has no lead.", "Address a current agent with @.")
        : ownerReceiver(team, input.to);
    const title = input.title ?? (input.body.trim().split("\n")[0] ?? "").slice(0, TITLE_MAX);
    const thread = team.insertThread(title, to.id, Date.now());
    const message = insert(team, {
      threadId: thread,
      kind: "ask",
      fromId: "owner",
      toId: to.id,
      askId: null,
      body: input.body,
    });
    return { message, thread };
  });
}

// Any agent on the team, or the owner, may change a thread's status, owner (an agent slug) or title.
export function changeThread(
  team: TeamRepo,
  id: string,
  patch: { status?: ThreadStatus; owner?: string; title?: string },
): Thread {
  if (patch.status === undefined && patch.owner === undefined && patch.title === undefined) {
    refuse("nothing_to_change", "A thread change needs status, owner or title.", "Give at least one.");
  }
  return team.tx(() => {
    const existing = mustThread(team, id);
    const owner =
      patch.owner === undefined
        ? undefined
        : (team.agentBySlug(patch.owner) ??
          notFound(`No agent named "${patch.owner}" on this team.`, "Use roster to see who is on the team."));
    team.updateThread(id, { status: patch.status, title: patch.title, ownerAgentId: owner?.id }, Date.now());
    return {
      ...existing,
      ...(patch.status ? { status: patch.status } : {}),
      ...(patch.title ? { title: patch.title } : {}),
      ...(owner ? { ownerAgentId: owner.id } : {}),
    };
  });
}

export function systemAsk(team: TeamRepo, agentId: string, body: string): MessageId {
  return insert(team, { threadId: null, kind: "ask", fromId: "system", toId: agentId, askId: null, body });
}

// It wakes nobody: it rides along with the agent's next ask or reply.
export function systemNote(team: TeamRepo, agentId: string, body: string): MessageId {
  return insert(team, { threadId: null, kind: "note", fromId: "system", toId: agentId, askId: null, body });
}

// Section 5.5: an agent that answered the owner in plain output, without posting, still leaves its answer in the
// thread. The ask stays open for a real reply.
export function onTurnFinished(team: TeamRepo, turn: FinishedTurn): void {
  const text = turn.text.trim();
  if (turn.status !== "completed" || text === "") return;
  team.tx(() => {
    const threads = new Set<ThreadId>();
    for (const m of team.messagesByA12sIds(turn.messageIds)) {
      if (m.kind === "ask" && m.fromId === "owner" && m.toId === turn.agentId && m.threadId) threads.add(m.threadId);
    }
    for (const threadId of threads) {
      if (team.postedSince(turn.agentId, threadId, turn.startedAt)) continue;
      insert(team, {
        threadId,
        kind: "note",
        fromId: turn.agentId,
        toId: "owner",
        askId: null,
        body: text.slice(0, BODY_MAX),
        implicit: true,
      });
    }
  });
}
