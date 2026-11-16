import { z } from "zod";
import { StudioError } from "../errors.ts";
import { boardStatus, nameOf } from "../router.ts";
import type { Tool } from "./mcp.ts";

const PREVIEW_MAX = 200;

const input = {
  thread: z.string().optional().describe("A thread id. Leave out to read the board: the team's threads."),
  status: z.enum(["open", "done", "all"]).optional().describe('Board only. Default "open".'),
  limit: z.number().int().min(1).max(100).optional().describe("Default 30."),
  before: z.string().optional().describe("A message id (thread) or thread id (board): the page before it."),
};

const iso = (ms: number) => new Date(ms).toISOString();

export const read: Tool<typeof input> = {
  name: "read",
  description: "Read the board (the team's threads, newest first) or one thread's messages.",
  input,
  run({ team, caller }, { thread: id, status, limit = 30, before }) {
    if (id === undefined) {
      const rows = team.board({ status: status ?? "open", limit, before, viewer: caller.agentId });
      return {
        threads: rows.map((t) => ({
          id: t.id,
          title: t.title,
          owner: nameOf(t.ownerAgentId),
          status: boardStatus(t),
          updated: iso(t.updatedAt),
          last: t.last && `${nameOf(t.last.fromId)}: ${t.last.body.slice(0, PREVIEW_MAX)}`,
          asksForYou: t.asksForViewer,
        })),
      };
    }
    if (status !== undefined) {
      throw new StudioError(
        400,
        "bad_field",
        "status is for the board only.",
        "Leave out status when reading a thread.",
      );
    }
    const thread = team.thread(id);
    if (!thread)
      throw new StudioError(404, "not_found", `No thread ${id}.`, "Use read without thread to see the board.");
    return {
      thread: {
        id: thread.id,
        title: thread.title,
        owner: nameOf(thread.ownerAgentId),
        status: thread.status,
      },
      messages: team.threadMessages(thread.id, limit, before).map((m) => ({
        id: m.id,
        kind: m.kind,
        from: nameOf(m.fromId),
        to: m.toId && nameOf(m.toId),
        ask: m.askId,
        body: m.body,
        file: m.fileName,
        at: iso(m.createdAt),
      })),
    };
  },
};
