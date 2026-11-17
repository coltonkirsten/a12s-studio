import { McpServer, type ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { type ZodRawShape, z } from "zod";
import type { TeamA12s } from "../a12s/port.ts";
import type { TeamBroker } from "../broker-client.ts";
import type { Caller } from "../caller.ts";
import type { Dispatcher } from "../dispatcher.ts";
import { StudioError } from "../errors.ts";
import type { TeamRepo } from "../repo.ts";
import type { Scheduler } from "../scheduler.ts";
import { access } from "./access.ts";
import { post } from "./post.ts";
import { read } from "./read.ts";
import { roster } from "./roster.ts";
import { schedule } from "./schedule.ts";
import { updateThread } from "./update_thread.ts";

// What a tool may touch: everything is already scoped to the caller's team, so no tool can name another one.
export type ToolContext = {
  caller: Caller;
  team: TeamRepo;
  a12s: TeamA12s;
  broker: TeamBroker;
  dispatcher: Dispatcher;
  scheduler: Pick<Scheduler, "refresh">;
};

export type Tool<S extends ZodRawShape> = {
  name: string;
  description: string;
  input: S;
  run(ctx: ToolContext, args: Parameters<ToolCallback<S>>[0]): unknown;
};

function text(value: unknown, isError = false): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }], ...(isError ? { isError } : {}) };
}

function register<S extends ZodRawShape>(server: McpServer, ctx: ToolContext, tool: Tool<S>): void {
  const callback = async (args: Parameters<ToolCallback<S>>[0]) => {
    try {
      return text(await tool.run(ctx, args));
    } catch (error) {
      if (error instanceof StudioError) return text(error, true);
      console.error(`tool ${tool.name} for ${ctx.caller.agentId} failed:`, error);
      return text(
        { code: "internal", message: "Studio failed to run this tool.", fix: "Try again in a minute." },
        true,
      );
    }
  };
  // Strict: a field the tool does not name (a team, an agent, a "from") is refused, never silently dropped.
  const inputSchema = z.strictObject(tool.input);
  // TypeScript cannot resolve the SDK's conditional callback type for a generic shape; for each concrete tool it is
  // exactly this function's type.
  const typed = callback as unknown as ToolCallback<typeof inputSchema>;
  server.registerTool<ZodRawShape, typeof inputSchema>(
    tool.name,
    { description: tool.description, inputSchema },
    typed,
  );
}

// A new server per request, bound to one caller: stateless, so nothing about a caller outlives its request.
export function mcpServer(ctx: ToolContext): McpServer {
  const server = new McpServer({ name: "a12s-studio", version: "1.0.0" });
  register(server, ctx, post);
  register(server, ctx, read);
  register(server, ctx, updateThread);
  register(server, ctx, roster);
  register(server, ctx, schedule);
  register(server, ctx, access);
  return server;
}
