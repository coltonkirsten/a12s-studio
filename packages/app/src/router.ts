import type { MessageId, ThreadId } from "@a12s-studio/contract/names";
import type { BoardStatus, ThreadStatus } from "@a12s-studio/contract/state";
import type { TurnStatus } from "./a12s/port.ts";
import type { Caller } from "./caller.ts";
import { StudioError } from "./errors.ts";
import type { Agent, BoardRow, NewMessage, TeamRepo, Thread } from "./repo.ts";

type PostInput = { body: string; to: string; thread?: string; title?: string };
type Posted = { message: MessageId; thread: ThreadId };
// A file to post with the message, stored by `store` inside the message's transaction, so a message never names a
// file that is not there.
type PostedFile = { name: string; store(message: MessageId): void };
type FinishedTurn = {
  agentId: string;
  status: TurnStatus;
  text: string;
  startedAt: number;
  // Every Message the Turn received: those it started with and those steered into it.
  messageIds: string[];
};

export const BODY_MAX = 32000;
export const TITLE_MAX = 120;
const BOTH_FIX = "Give thread to continue one, or title to start one.";

// How an id is shown to agents: an agent by its slug, "owner" and "system" as they are.
export function nameOf(id: string): string {
  return id.slice(id.indexOf("-") + 1);
}

// Section 5.4: an open thread needs the owner while it holds a message to them they have not seen.
export function boardStatus(thread: BoardRow): BoardStatus {
  if (thread.status === "done") return "done";
  return thread.forOwner > 0 ? "needs_you" : "open";
}

function refuse(code: string, message: string, fix: string): never {
  throw new StudioError(400, code, message, fix);
}

function notFound(message: string, fix: string): never {
  throw new StudioError(404, "not_found", message, fix);
}

// Only a current agent has an inbox to deliver to: a message to the owner and a message to an agent who has left the
// team are just recorded.
function insert(team: TeamRepo, m: NewMessage): MessageId {
  const delivery = team.agent(m.toId) ? "queued" : "none";
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
    refuse("self", "You cannot post to yourself.", 'Write to a teammate or to "owner", or keep it in your notes.');
  }
  return agent.id;
}

function ownerReceiver(team: TeamRepo, slug: string): Agent {
  return (
    team.agentBySlug(slug) ?? notFound(`No agent named "${slug}" on this team.`, "Address a current agent with @.")
  );
}

// `turn` is the caller's running Turn, null when none runs (a background sub-agent posting between Turns). It
// gives the post its cause (section 5.9).
export function agentPost(
  team: TeamRepo,
  caller: Caller,
  turn: string | null,
  input: PostInput,
  file?: PostedFile,
): Posted {
  const { thread: threadId, title } = input;
  if (threadId !== undefined && title !== undefined) {
    refuse("thread_or_title", "A post takes thread or title, not both.", BOTH_FIX);
  }
  return team.tx(() => {
    const toId = agentReceiver(team, caller, input.to);
    const thread =
      threadId !== undefined
        ? mustThread(team, threadId).id
        : title !== undefined
          ? team.insertThread(title, caller.agentId, Date.now())
          : refuse("missing_thread", "A post needs thread or title.", BOTH_FIX);
    const causeId = turn === null ? null : (team.lastDelivered(caller.agentId, turn) ?? null);
    const message = insert(team, {
      threadId: thread,
      fromId: caller.agentId,
      toId,
      causeId,
      body: input.body,
      fileName: file?.name,
    });
    file?.store(message);
    return { message, thread };
  });
}

// The owner writing in a thread: to the agent named in `to`, else to the thread's owner. Writing there is also
// reading it.
export function ownerPost(team: TeamRepo, threadId: string, input: { body: string; to?: string }): Posted {
  return team.tx(() => {
    const thread = mustThread(team, threadId);
    const to =
      input.to === undefined
        ? (team.agent(thread.ownerAgentId) ??
          notFound("This thread's owner has left the team.", "Address a current agent with @."))
        : ownerReceiver(team, input.to);
    const message = insert(team, { threadId: thread.id, fromId: "owner", toId: to.id, body: input.body });
    team.markSeen(thread.id, Date.now());
    return { message, thread: thread.id };
  });
}

// A new thread from the owner: a message to the agent named in `to`, else to the lead, who owns the thread.
export function ownerThread(team: TeamRepo, input: { title?: string; body: string; to?: string }): Posted {
  return team.tx(() => {
    const leadId = team.team()?.leadAgentId;
    const to =
      input.to === undefined
        ? (leadId && team.agent(leadId)) || notFound("This team has no lead.", "Address a current agent with @.")
        : ownerReceiver(team, input.to);
    const title = input.title ?? (input.body.trim().split("\n")[0] ?? "").slice(0, TITLE_MAX);
    const thread = team.insertThread(title, to.id, Date.now());
    const message = insert(team, { threadId: thread, fromId: "owner", toId: to.id, body: input.body });
    team.markSeen(thread, Date.now());
    return { message, thread };
  });
}

// Mark read: the thread's messages to the owner so far need them no more.
export function markSeen(team: TeamRepo, threadId: string): void {
  team.tx(() => team.markSeen(mustThread(team, threadId).id, Date.now()));
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

// A message from Studio itself, delivered like any other; `threadId` places it in the thread it concerns.
export function systemMessage(
  team: TeamRepo,
  agentId: string,
  body: string,
  threadId: ThreadId | null = null,
): MessageId {
  return insert(team, { threadId, fromId: "system", toId: agentId, body });
}

// Section 5.5: an agent that answered the owner in plain output, without posting in the thread, still leaves its
// answer there, as a message to the owner set off by the owner's newest message in that thread.
export function onTurnFinished(team: TeamRepo, turn: FinishedTurn): void {
  const text = turn.text.trim();
  if (turn.status !== "completed" || text === "") return;
  team.tx(() => {
    const causes = new Map<ThreadId, MessageId>();
    for (const m of team.messagesByA12sIds(turn.messageIds)) {
      if (m.fromId === "owner" && m.toId === turn.agentId && m.threadId) causes.set(m.threadId, m.id);
    }
    for (const [threadId, causeId] of causes) {
      if (team.postedSince(turn.agentId, threadId, turn.startedAt)) continue;
      insert(team, { threadId, fromId: turn.agentId, toId: "owner", causeId, body: text.slice(0, BODY_MAX) });
    }
  });
}
