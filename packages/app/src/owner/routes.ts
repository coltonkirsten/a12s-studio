import type { ServerResponse } from "node:http";
import type { WriteResult } from "@a12s-studio/contract/api";
import type { AccessRequest } from "@a12s-studio/contract/broker-admin";
import { teamOf } from "@a12s-studio/contract/names";
import { z } from "zod";
import type { A12s } from "../a12s/port.ts";
import type { BrokerClient } from "../broker-client.ts";
import type { Dispatcher } from "../dispatcher.ts";
import { StudioError } from "../errors.ts";
import type { Live } from "../live.ts";
import type { Repo, Team, TeamRepo } from "../repo.ts";
import { BODY_MAX, changeThread, ownerPost, ownerThread, systemNote, TITLE_MAX } from "../router.ts";
import type { Scheduler } from "../scheduler.ts";
import { deriveState, messagesPage, type Stream } from "../state.ts";
import type { createTeams } from "../teams.ts";

export type OwnerDeps = {
  repo: Repo;
  a12s: A12s;
  broker: BrokerClient;
  dispatcher: Dispatcher;
  scheduler: Scheduler;
  teams: ReturnType<typeof createTeams>;
  live: Live;
  stream: Stream;
};

// What a route sees: the URL's decoded parameters and query, the parsed JSON body, and the response for the stream.
type Request = { params: string[]; query: URLSearchParams; body: unknown; res: ServerResponse };
export type Route = { method: string; path: RegExp; run(req: Request): Promise<unknown> | unknown };

const SLUG = z.string().min(1).max(40);
const TEXT = z.string().trim().min(1);
const MODEL = z.string().min(1).max(100);

const schemas = {
  createTeam: z.strictObject({
    name: TEXT.max(80),
    purpose: TEXT.max(4000),
    accent: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    template: SLUG,
  }),
  patchTeam: z.strictObject({
    name: TEXT.max(80).optional(),
    purpose: TEXT.max(4000).optional(),
    accent: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .optional(),
    dailyBudgetUsd: z.number().min(0).optional(),
    paused: z.boolean().optional(),
  }),
  hire: z.strictObject({ slug: SLUG, role: TEXT.max(8000), model: MODEL }),
  patchAgent: z.strictObject({ role: TEXT.max(8000).optional(), model: MODEL.optional() }),
  power: z.strictObject({ state: z.enum(["awake", "asleep"]) }),
  newThread: z.strictObject({
    title: TEXT.max(TITLE_MAX).optional(),
    body: TEXT.max(BODY_MAX),
    to: SLUG.optional(),
  }),
  post: z.strictObject({ body: TEXT.max(BODY_MAX), to: SLUG.optional(), ask: z.string().optional() }),
  patchThread: z.strictObject({
    status: z.enum(["open", "done"]).optional(),
    title: TEXT.max(TITLE_MAX).optional(),
    owner: SLUG.optional(),
  }),
  settings: z.strictObject({
    awakeCap: z.int().min(1).max(64).optional(),
    defaultDailyBudgetUsd: z.number().min(0).optional(),
    minFreeDiskGb: z.number().min(0).optional(),
    paused: z.boolean().optional(),
    defaultModel: MODEL.optional(),
    defaultSleepAfterIdle: z.string().min(1).max(20).optional(),
    defaultCompactMinTokens: z.int().min(0).optional(),
  }),
  // The broker checks hosts, methods, patterns and the secret's form; these only give the bodies their shape.
  credential: z.strictObject({
    scheme: z.enum(["bearer", "basic", "header"]),
    username: z.string().optional(),
    headerName: z.string().optional(),
    secret: z.string().min(1),
  }),
  grant: z.strictObject({
    host: z.string(),
    methods: z.array(z.string()).min(1),
    paths: z.array(z.string()).min(1),
    expiresAt: z.int().optional(),
  }),
  approve: z.strictObject({ expiresAt: z.int().optional() }),
};

// Section 9.4: the requesting agent hears the decision with its next message.
function decisionNote(request: AccessRequest, expiresAt: number | undefined): string {
  const reach = `${request.methods.join(", ")} ${request.host} ${request.paths.join(", ")}`;
  if (request.status === "denied") return `Access denied: ${reach}.`;
  return `Access approved: ${reach}${expiresAt === undefined ? "" : `, until ${new Date(expiresAt).toISOString()}`}.`;
}

function parse<S extends z.ZodType>(schema: S, body: unknown): z.output<S> {
  const result = schema.safeParse(body);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const where = issue?.path.join(".") || "body";
  throw new StudioError(
    400,
    "bad_request",
    `${where}: ${issue?.message ?? "invalid"}.`,
    "Fix that field and send again.",
  );
}

export function ownerRoutes(deps: OwnerDeps): Route[] {
  const { repo, a12s, broker, dispatcher, scheduler, teams, stream } = deps;
  const written = (id?: string): WriteResult => ({ rev: stream.rev(), ...(id === undefined ? {} : { id }) });
  // A change in the broker can add or remove a Needs You card, so the attention answer is read again before the
  // route answers: the state at the returned rev already shows the change.
  const relayed = async (id?: string): Promise<WriteResult> => {
    await scheduler.refresh();
    return written(id);
  };

  function team(id: string | undefined): { team: Team; scoped: TeamRepo } {
    const scoped = repo.forTeam(id ?? "");
    const found = scoped.team();
    if (!found) throw new StudioError(404, "not_found", `No team ${id}.`, "Pick a team from the sidebar.");
    return { team: found, scoped };
  }

  // A thread id does not name its team; the team is looked up, then everything goes through its scoped repo.
  function threadTeam(id: string): TeamRepo {
    const teamId = repo.threadTeam(id);
    const scoped = teamId === undefined ? undefined : repo.forTeam(teamId);
    if (!scoped?.team() || !scoped.thread(id)) throw new StudioError(404, "not_found", `No thread ${id}.`);
    return scoped;
  }

  function agentOf(id: string | undefined) {
    const { team: found, scoped } = team(teamOf(id ?? ""));
    if (!scoped.agent(id ?? "")) throw new StudioError(404, "not_found", `No agent ${id}.`);
    return { team: found, id: id ?? "", client: a12s.forTeam(found.a12sToken) };
  }

  return [
    {
      method: "GET",
      path: /^\/stream$/,
      run: ({ query, res }) => stream.connect(res, () => deriveState(deps, query.get("thread"))),
    },
    { method: "GET", path: /^\/templates$/, run: () => ({ templates: teams.templates() }) },
    {
      method: "POST",
      path: /^\/teams$/,
      async run({ body }) {
        const created = await teams.createTeam(parse(schemas.createTeam, body));
        return written(created.id);
      },
    },
    {
      method: "PATCH",
      path: /^\/teams\/([^/]+)$/,
      async run({ params, body }) {
        const { paused, ...patch } = parse(schemas.patchTeam, body);
        const { team: found } = team(params[0]);
        if (Object.keys(patch).length > 0) await teams.patchTeam(found.id, patch);
        if (paused === true) await teams.pause(found.id);
        if (paused === false) await teams.resume(found.id);
        return written();
      },
    },
    {
      method: "DELETE",
      path: /^\/teams\/([^/]+)$/,
      async run({ params }) {
        await teams.deleteTeam(team(params[0]).team.id);
        return written();
      },
    },
    {
      method: "POST",
      path: /^\/teams\/([^/]+)\/agents$/,
      async run({ params, body }) {
        const hired = await teams.hire(team(params[0]).team.id, parse(schemas.hire, body));
        return written(hired.id);
      },
    },
    {
      method: "PATCH",
      path: /^\/agents\/([^/]+)$/,
      async run({ params, body }) {
        const patch = parse(schemas.patchAgent, body);
        const { team: found, id } = agentOf(params[0]);
        await teams.patchAgent(found.id, id, patch);
        return written();
      },
    },
    {
      method: "DELETE",
      path: /^\/agents\/([^/]+)$/,
      async run({ params }) {
        const { team: found, id } = agentOf(params[0]);
        await teams.fire(found.id, id);
        return written();
      },
    },
    {
      method: "POST",
      path: /^\/agents\/([^/]+)\/power$/,
      async run({ params, body }) {
        const { state } = parse(schemas.power, body);
        const { client, id } = agentOf(params[0]);
        await (state === "awake" ? client.wake(id) : client.sleep(id));
        return written();
      },
    },
    {
      method: "POST",
      path: /^\/agents\/([^/]+)\/stop$/,
      async run({ params }) {
        const { client, id } = agentOf(params[0]);
        await client.stop(id);
        return written();
      },
    },
    {
      method: "POST",
      path: /^\/teams\/([^/]+)\/threads$/,
      run({ params, body }) {
        const posted = ownerThread(team(params[0]).scoped, parse(schemas.newThread, body));
        void dispatcher.run();
        return written(posted.thread);
      },
    },
    {
      method: "POST",
      path: /^\/threads\/([^/]+)\/messages$/,
      run({ params, body }) {
        const id = params[0] ?? "";
        const posted = ownerPost(threadTeam(id), id, parse(schemas.post, body));
        void dispatcher.run();
        return written(posted.message);
      },
    },
    {
      method: "GET",
      path: /^\/threads\/([^/]+)\/messages$/,
      run({ params, query }) {
        const id = params[0] ?? "";
        return messagesPage(threadTeam(id), id, query.get("before") ?? undefined);
      },
    },
    {
      method: "PATCH",
      path: /^\/threads\/([^/]+)$/,
      run({ params, body }) {
        const id = params[0] ?? "";
        changeThread(threadTeam(id), id, parse(schemas.patchThread, body));
        return written();
      },
    },
    {
      method: "PATCH",
      path: /^\/settings$/,
      async run({ body }) {
        const { paused, ...patch } = parse(schemas.settings, body);
        repo.updateSettings(patch);
        if (paused === true) await teams.pause(null);
        else if (paused === false) await teams.resume(null);
        else await dispatcher.run();
        return written();
      },
    },
    {
      method: "POST",
      path: /^\/turns\/([^/]+)\/ack$/,
      run({ params }) {
        const id = params[0] ?? "";
        const teamId = repo.turnTeam(id);
        const scoped = teamId === undefined ? undefined : repo.forTeam(teamId);
        if (!scoped?.team() || !scoped.ackTurn(id, Date.now())) {
          throw new StudioError(404, "not_found", `No Turn ${id}.`);
        }
        return written();
      },
    },
    {
      method: "GET",
      path: /^\/teams\/([^/]+)\/access$/,
      run: ({ params }) => broker.forTeam(team(params[0]).team.id).access(),
    },
    {
      method: "PUT",
      path: /^\/teams\/([^/]+)\/credentials\/([^/]+)$/,
      async run({ params, body }) {
        const input = parse(schemas.credential, body);
        await broker.forTeam(team(params[0]).team.id).putCredential(params[1] ?? "", input);
        return relayed();
      },
    },
    {
      method: "DELETE",
      path: /^\/teams\/([^/]+)\/credentials\/([^/]+)$/,
      async run({ params }) {
        await broker.forTeam(team(params[0]).team.id).deleteCredential(params[1] ?? "");
        return relayed();
      },
    },
    {
      method: "POST",
      path: /^\/teams\/([^/]+)\/grants$/,
      async run({ params, body }) {
        const input = parse(schemas.grant, body);
        const grant = await broker.forTeam(team(params[0]).team.id).createGrant(input);
        return relayed(grant.id);
      },
    },
    {
      method: "DELETE",
      path: /^\/teams\/([^/]+)\/grants\/([^/]+)$/,
      async run({ params }) {
        await broker.forTeam(team(params[0]).team.id).revokeGrant(params[1] ?? "");
        return relayed();
      },
    },
    {
      method: "POST",
      path: /^\/teams\/([^/]+)\/requests\/([^/]+)\/approve$/,
      async run({ params, body }) {
        const { expiresAt } = parse(schemas.approve, body);
        const { team: found, scoped } = team(params[0]);
        const request = await broker.forTeam(found.id).approve(params[1] ?? "", { expiresAt });
        systemNote(scoped, request.agentId, decisionNote(request, expiresAt));
        return relayed();
      },
    },
    {
      method: "POST",
      path: /^\/teams\/([^/]+)\/requests\/([^/]+)\/deny$/,
      async run({ params }) {
        const { team: found, scoped } = team(params[0]);
        const request = await broker.forTeam(found.id).deny(params[1] ?? "");
        systemNote(scoped, request.agentId, decisionNote(request, undefined));
        return relayed();
      },
    },
    {
      method: "GET",
      path: /^\/teams\/([^/]+)\/audit$/,
      run: ({ params, query }) => broker.forTeam(team(params[0]).team.id).audit(query.get("before")),
    },
  ];
}
