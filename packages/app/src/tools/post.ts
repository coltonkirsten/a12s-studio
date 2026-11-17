import { z } from "zod";
import { readAttachment, storeAttachment } from "../files.ts";
import { agentPost, BODY_MAX, TITLE_MAX } from "../router.ts";
import type { Tool } from "./mcp.ts";

const input = {
  body: z.string().min(1).max(BODY_MAX),
  to: z
    .string()
    .optional()
    .describe('A teammate\'s name from roster, or "owner". Left out, it is only recorded in the thread.'),
  thread: z.string().optional().describe("The thread id. Give thread or title."),
  title: z.string().min(1).max(TITLE_MAX).optional().describe("Starts a new thread you own, instead of thread."),
  file: z
    .string()
    .optional()
    .describe("Attach a file: its absolute path under /home/agent. It is copied as it is now."),
};

export const post: Tool<typeof input> = {
  name: "post",
  description:
    "Write one message in a thread, to a teammate, to the owner, or to nobody. The only way the owner and your " +
    "teammates see what you write.",
  input,
  async run(ctx, { file, ...args }) {
    const attachment = file === undefined ? undefined : await readAttachment(ctx.a12s, ctx.caller.agentId, file);
    const posted = agentPost(
      ctx.team,
      ctx.caller,
      ctx.turn,
      args,
      attachment && { name: attachment.name, store: (message) => storeAttachment(ctx.files, message, attachment) },
    );
    // The post answers once its write is committed; delivery to a12s happens after, on its own.
    void ctx.dispatcher.run();
    return posted;
  },
};
