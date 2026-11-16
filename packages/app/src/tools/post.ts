import { z } from "zod";
import { agentPost } from "../router.ts";
import type { Tool } from "./mcp.ts";

const input = {
  kind: z
    .enum(["ask", "reply", "note"])
    .describe("ask: wakes the receiver. reply: answers an ask. note: wakes nobody."),
  body: z.string().min(1).max(32000),
  to: z.string().optional().describe('ask and note: a teammate\'s name from roster, or "owner".'),
  thread: z.string().optional().describe("ask and note: the thread id."),
  title: z.string().min(1).max(120).optional().describe("ask: starts a new thread you own, instead of thread."),
  ask: z.string().optional().describe("reply: the id of the ask you answer."),
};

export const post: Tool<typeof input> = {
  name: "post",
  description:
    "Send an ask, a reply or a note in a thread. The only way the owner and your teammates see what you write.",
  input,
  run(ctx, args) {
    const posted = agentPost(ctx.team, ctx.caller, args);
    // The post answers once its write is committed; delivery to a12s happens after, on its own.
    void ctx.dispatcher.run();
    return posted;
  },
};
