import { z } from "zod";
import { StudioError } from "../errors.ts";
import type { Tool } from "./mcp.ts";

const input = {
  action: z
    .enum(["list", "request"])
    .describe("list: what your team can reach and what it has asked for. request: ask the owner for more."),
  host: z.string().optional().describe("request: the host, such as api.example.com."),
  methods: z
    .array(z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]))
    .min(1)
    .optional()
    .describe("request: the methods needed."),
  paths: z
    .array(z.string())
    .min(1)
    .optional()
    .describe(
      'request: path patterns, such as /v1/items. "*" is one whole segment; a final "/**" is everything under it.',
    ),
  reason: z.string().min(1).max(500).optional().describe("request: why the team needs it, for the owner."),
  days: z.int().min(1).max(365).optional().describe("request: how long it is needed."),
};

const REQUEST_FIELDS = ["host", "methods", "paths", "reason", "days"] as const;
const PATTERN_FIX =
  'Use a plain host such as api.example.com and paths that start with "/", with "*" for one whole segment and a final "/**" for everything under it.';

export const access: Tool<typeof input> = {
  name: "access",
  description: "See which outside services your team can call through the broker, or ask the owner for more.",
  input,
  async run({ caller, broker, scheduler }, args) {
    if (args.action === "list") {
      if (REQUEST_FIELDS.some((field) => args[field] !== undefined)) {
        throw new StudioError(400, "bad_field", "A list takes no other field.", 'Send only action: "list".');
      }
      const view = await broker.access();
      const now = Date.now();
      return {
        grants: view.grants
          .filter((g) => g.revokedAt === null && g.expiredAt === null && (g.expiresAt === null || g.expiresAt > now))
          .map((g) => ({
            host: g.host,
            methods: g.methods,
            paths: g.paths,
            expires: g.expiresAt === null ? null : new Date(g.expiresAt).toISOString(),
          })),
        pending: view.requests
          .filter((r) => r.status === "pending")
          .map((r) => ({ id: r.id, host: r.host, methods: r.methods, paths: r.paths })),
      };
    }
    const { host, methods, paths, reason, days } = args;
    if (host === undefined || methods === undefined || paths === undefined || reason === undefined) {
      throw new StudioError(
        400,
        "missing_field",
        "A request needs host, methods, paths and reason.",
        "Give all four; days is optional.",
      );
    }
    const body = { agentId: caller.agentId, host, methods, paths, reason, ...(days === undefined ? {} : { days }) };
    const created = await broker.request(body).catch((error: unknown) => {
      if (error instanceof StudioError && error.code === "invalid") {
        throw new StudioError(400, "invalid", error.message, PATTERN_FIX);
      }
      throw error;
    });
    // The card is in Needs You by the time the agent hears its request was made.
    await scheduler.refresh();
    return { request: created.id, status: "pending" };
  },
};
