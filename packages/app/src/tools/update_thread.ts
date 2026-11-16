import { z } from "zod";
import { StudioError } from "../errors.ts";
import { nameOf, TITLE_MAX } from "../router.ts";
import type { Tool } from "./mcp.ts";

const input = {
  thread: z.string(),
  status: z.enum(["open", "done"]).optional(),
  owner: z.string().optional().describe("A teammate's name from roster."),
  title: z.string().min(1).max(TITLE_MAX).optional(),
};

export const updateThread: Tool<typeof input> = {
  name: "update_thread",
  description: "Change a thread's status, owner or title. Set it to done when its work is finished.",
  input,
  run({ team }, { thread: id, status, owner, title }) {
    if (status === undefined && owner === undefined && title === undefined) {
      throw new StudioError(
        400,
        "nothing_to_change",
        "update_thread needs status, owner or title.",
        "Give at least one.",
      );
    }
    return team.tx(() => {
      const existing = team.thread(id);
      if (!existing) {
        throw new StudioError(404, "not_found", `No thread ${id}.`, "Use read to see the team's threads.");
      }
      const ownerAgent = owner === undefined ? undefined : team.agentBySlug(owner);
      if (owner !== undefined && !ownerAgent) {
        throw new StudioError(
          404,
          "not_found",
          `No agent named "${owner}" on your team.`,
          "Use roster to see who is on your team.",
        );
      }
      team.updateThread(id, { status, title, ownerAgentId: ownerAgent?.id }, Date.now());
      return {
        id,
        title: title ?? existing.title,
        owner: nameOf(ownerAgent?.id ?? existing.ownerAgentId),
        status: status ?? existing.status,
      };
    });
  },
};
