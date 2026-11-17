import { z } from "zod";
import { readAttachment, storeAttachment } from "../files.ts";
import { agentPost, BODY_MAX, TITLE_MAX } from "../router.ts";
import type { Tool } from "./mcp.ts";

const input = {
  kind: z
    .enum(["ask", "reply", "note"])
    .describe("ask: wakes the receiver. reply: answers an ask. note: wakes nobody."),
  body: z.string().min(1).max(BODY_MAX),
  to: z.string().optional().describe('ask and note: a teammate\'s name from roster, or "owner".'),
  thread: z.string().optional().describe("ask and note: the thread id."),
  title: z.string().min(1).max(TITLE_MAX).optional().describe("ask: starts a new thread you own, instead of thread."),
  ask: z.string().optional().describe("reply: the id of the ask you answer."),
  file: z
    .string()
    .optional()
    .describe("Attach a file: its absolute path under /home/agent. It is copied as it is now."),
};

export const post: Tool<typeof input> = {
  name: "post",
  description:
    "Send an ask, a reply or a note in a thread. The only way the owner and your teammates see what you write.",
  input,
  async run(ctx, { file, ...args }) {
    const attachment = file === undefined ? undefined : await readAttachment(ctx.a12s, ctx.caller.agentId, file);
    const posted = agentPost(
      ctx.team,
      ctx.caller,
      args,
      attachment && { name: attachment.name, store: (message) => storeAttachment(ctx.files, message, attachment) },
    );
    // The post answers once its write is committed; delivery to a12s happens after, on its own.
    void ctx.dispatcher.run();
    return posted;
  },
};
