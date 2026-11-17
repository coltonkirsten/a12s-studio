import { z } from "zod";
import { StudioError } from "../errors.ts";
import type { Tool } from "./mcp.ts";

const MAX_WAKES = 20;
const MINUTE = 60 * 1000;
const YEAR_MINUTES = 365 * 24 * 60;

const input = {
  action: z
    .enum(["set", "list", "cancel"])
    .describe("set: wake yourself later. list: your wakes. cancel: remove one of yours."),
  in_minutes: z.number().min(1).max(YEAR_MINUTES).optional().describe("set: minutes from now. Or give at."),
  at: z.iso.datetime({ offset: true }).optional().describe("set: a future time, ISO 8601 with its offset."),
  repeat_hours: z
    .int()
    .min(1)
    .max(YEAR_MINUTES / 60)
    .optional()
    .describe("set: wake again every this many hours."),
  note: z.string().min(1).max(500).optional().describe("set: what to do then. It is handed back at the wake."),
  thread: z.string().optional().describe("set: the thread the wake is about."),
  id: z.string().optional().describe("cancel: the wake's id."),
};

const FIELDS: Record<z.infer<typeof input.action>, string[]> = {
  set: ["in_minutes", "at", "repeat_hours", "note", "thread"],
  list: [],
  cancel: ["id"],
};

function refuse(code: string, message: string, fix: string): never {
  throw new StudioError(400, code, message, fix);
}

function notFound(message: string, fix: string): never {
  throw new StudioError(404, "not_found", message, fix);
}

const iso = (ms: number) => new Date(ms).toISOString();

export const schedule: Tool<typeof input> = {
  name: "schedule",
  description:
    "Wake yourself later, once or on a repeat no faster than hourly, instead of waiting in a loop. At the wake you get a message with your note.",
  input,
  run({ team, caller }, args) {
    const { action } = args;
    const extra = Object.entries(args)
      .filter(([field, value]) => field !== "action" && value !== undefined && !FIELDS[action].includes(field))
      .map(([field]) => field);
    if (extra.length > 0) {
      refuse("bad_field", `A ${action} takes no ${extra.join(", ")}.`, "Send only the fields it takes.");
    }

    if (action === "list") {
      return {
        wakes: team.wakes(caller.agentId).map((w) => ({
          id: w.id,
          due: iso(w.dueAt),
          repeat_hours: w.repeatSeconds === null ? null : w.repeatSeconds / 3600,
          note: w.note,
          thread: w.threadId,
        })),
      };
    }

    if (action === "cancel") {
      const id = args.id ?? refuse("missing_field", "A cancel needs id.", "Use list to see your wakes' ids.");
      if (!team.cancelWake(caller.agentId, id)) notFound(`No wake ${id}.`, "Use list to see your wakes.");
      return { cancelled: id };
    }

    const now = Date.now();
    const { in_minutes, at, repeat_hours, note, thread } = args;
    if ((in_minutes === undefined) === (at === undefined)) {
      refuse("missing_field", "A set needs exactly one of in_minutes or at.", "Give in_minutes, or at with an offset.");
    }
    const dueAt = at === undefined ? now + (in_minutes ?? 0) * MINUTE : Date.parse(at);
    if (dueAt <= now || dueAt > now + YEAR_MINUTES * MINUTE) {
      refuse("bad_time", `${at} is not in the coming year.`, "Give a future time, at most a year from now.");
    }
    if (note === undefined) refuse("missing_field", "A set needs note.", "Say what to do at the wake.");
    const about =
      thread === undefined
        ? null
        : (team.thread(thread) ?? notFound(`No thread ${thread}.`, "Use read to see the team's threads."));
    if (team.wakes(caller.agentId).length >= MAX_WAKES) {
      refuse("too_many_wakes", `You have ${MAX_WAKES} wakes set.`, "Cancel one you no longer need first.");
    }
    const id = team.insertWake(
      {
        agentId: caller.agentId,
        threadId: about?.id ?? null,
        note,
        dueAt,
        repeatSeconds: repeat_hours === undefined ? null : repeat_hours * 3600,
      },
      now,
    );
    return { wake: id, due: iso(dueAt) };
  },
};
