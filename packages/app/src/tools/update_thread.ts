import { z } from "zod";
import { changeThread, nameOf, TITLE_MAX } from "../router.ts";
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
  run({ team }, { thread, ...patch }) {
    const changed = changeThread(team, thread, patch);
    return { id: changed.id, title: changed.title, owner: nameOf(changed.ownerAgentId), status: changed.status };
  },
};
