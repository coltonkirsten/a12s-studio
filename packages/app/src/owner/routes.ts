import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import type {
  AgentSettings,
  InboxResponse,
  RulesPage,
  SteeredMessage,
  ToolCall,
  TurnEventsResponse,
  TurnsResponse,
  WriteResult,
} from "@a12s-studio/contract/api";
import type { AccessRequest } from "@a12s-studio/contract/broker-admin";
import { teamOf } from "@a12s-studio/contract/names";
import { z } from "zod";
import type { A12s, A12sEvent } from "../a12s/port.ts";
import type { BrokerClient } from "../broker-client.ts";
import type { Dispatcher } from "../dispatcher.ts";
import { StudioError } from "../errors.ts";
import { homePath, sendAttachment } from "../files.ts";
import { doingNow, type Live } from "../live.ts";
import type { Repo, Team, TeamRepo } from "../repo.ts";
import { BODY_MAX, changeThread, markSeen, ownerPost, ownerThread, systemMessage, TITLE_MAX } from "../router.ts";
import { current, versions, write } from "../rules.ts";
import type { Scheduler } from "../scheduler.ts";
import { deriveState, messagesPage, messageView, type Stream } from "../state.ts";
import type { createTeams } from "../teams.ts";
import { bridgeTerminal } from "./terminal.ts";

export type OwnerDeps = {
  repo: Repo;
  a12s: A12s;
  broker: BrokerClient;
  dispatcher: Dispatcher;
  scheduler: Scheduler;
  teams: ReturnType<typeof createTeams>;
  live: Live;
  stream: Stream;
  filesDir: string;
};

// What a route sees: the URL's decoded parameters and query, the parsed JSON body, and the response for the stream
// and downloads. A WebSocket route sees the connection instead, which has no response.
type Request = { params: string[]; query: URLSearchParams; body: unknown; res: ServerResponse };
export type Upgrade = { params: string[]; query: URLSearchParams; req: IncomingMessage; socket: Duplex; head: Buffer };
export type Route =
  | { method: string; path: RegExp; run(req: Request): Promise<unknown> | unknown }
  | { method: "GET"; path: RegExp; socket(upgrade: Upgrade): Promise<void> | void };

const SLUG = z.string().min(1).max(40);
const TEXT = z.string().trim().min(1);
const MODEL = z.string().min(1).max(100);
const DURATION = z.string().min(1).max(20);
// How many past Turns the inspector lists, and how much of a tool call's input or output it shows.
const TURN_LIST = 20;
const CALL_TEXT_MAX = 4000;

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
  // rules.ts holds the limits of a rule or a role.
  hire: z.strictObject({ slug: SLUG, role: z.string(), model: MODEL }),
  patchAgent: z.strictObject({
    role: z.string().optional(),
    model: MODEL.optional(),
    sleepAfterIdle: DURATION.optional(),
    compactMinTokens: z.int().min(0).optional(),
    cpu: z.number().positive().max(64).nullable().optional(),
    memory: z.string().min(1).max(20).nullable().optional(),
  }),
  putFile: z.discriminatedUnion("encoding", [
    z.strictObject({ encoding: z.literal("utf-8"), content: z.string() }),
    z.strictObject({ encoding: z.literal("base64"), content: z.base64() }),
  ]),
  rules: z.strictObject({ body: z.string() }),
  power: z.strictObject({ state: z.enum(["awake", "asleep"]) }),
  newThread: z.strictObject({
    title: TEXT.max(TITLE_MAX).optional(),
    body: TEXT.max(BODY_MAX),
    to: SLUG.optional(),
  }),
  post: z.strictObject({ body: TEXT.max(BODY_MAX), to: SLUG.optional() }),
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
    defaultSleepAfterIdle: DURATION.optional(),
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

// Section 9.4: the decision is a message to the agent that asked, which wakes it.
function decision(request: AccessRequest, expiresAt: number | undefined): string {
  const reach = `${request.methods.join(", ")} ${request.host} ${request.paths.join(", ")}`;
  if (request.status === "denied") return `Access denied: ${reach}.`;
  return `Access approved: ${reach}${expiresAt === undefined ? "" : `, until ${new Date(expiresAt).toISOString()}`}.`;
}

function callText(value: unknown): string {
  const text = typeof value === "string" ? value : (JSON.stringify(value, null, 2) ?? "");
  return text.length > CALL_TEXT_MAX ? `${text.slice(0, CALL_TEXT_MAX)}…` : text;
}

// A Turn's tool calls in the order they started, each with its result once it has finished.
function toolLog(events: A12sEvent[]): ToolCall[] {
  const calls = new Map<string, ToolCall>();
  for (const event of events) {
    if (event.type === "tool.started") {
      calls.set(event.id, {
        id: event.id,
        name: event.name,
        line: doingNow(event.name, event.input),
        input: callText(event.input),
        output: null,
        isError: false,
        parent: event.parent ?? null,
        startedAt: event.at,
        finishedAt: null,
      });
    }
    const call = event.type === "tool.finished" ? calls.get(event.id) : undefined;
    if (call && event.type === "tool.finished") {
      Object.assign(call, { output: callText(event.output), isError: event.isError, finishedAt: event.at });
    }
  }
  return [...calls.values()];
}

// The messages steered into a Turn, from its turn.steered events, as the team's messages they were sent for.
function steeredLog(team: TeamRepo, events: A12sEvent[]): SteeredMessage[] {
  return events.flatMap((event) =>
    event.type === "turn.steered"
      ? team.messagesByA12sIds(event.messageIds).map((m) => ({
          id: m.id,
          from: m.fromId,
          body: callText(m.body),
          at: event.at,
        }))
      : [],
  );
}

// The cursor of a rules history: the id of the oldest version on the page before.
function before(query: URLSearchParams): number | undefined {
  const value = query.get("before");
  if (value === null) return undefined;
  const id = Number(value);
  if (!Number.isInteger(id)) {
    throw new StudioError(400, "bad_request", "before: not a version id.", "Use the id of a version you were sent.");
  }
  return id;
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
  const { repo, a12s, broker, dispatcher, scheduler, teams, stream, filesDir } = deps;
  const written = (id?: string): WriteResult => ({ rev: stream.rev(), ...(id === undefined ? {} : { id }) });
  // A change in the broker can add or remove a Needs You card, so the attention answer is read again before the
  // route answers: the state at the returned rev already shows the change. The rev moves even when no card does:
  // the state does not carry a team's access, so a page showing it reads it again when the rev moves.
  const relayed = async (id?: string): Promise<WriteResult> => {
    await scheduler.refresh();
    stream.changed();
    return written(id);
  };

  function team(id: string | undefined): { team: Team; scoped: TeamRepo } {
    const scoped = repo.forTeam(id ?? "");
    const found = scoped.team();
    if (!found) throw new StudioError(404, "not_found", `No team ${id}.`, "Pick a team from the sidebar.");
    return { team: found, scoped };
  }

  // Only a team the app knows is asked of the broker, and each call names that one team.
  const teamBroker = (id: string | undefined) => broker.forTeam(team(id).team.id);

  // A thread id does not name its team; the team is looked up, then everything goes through its scoped repo.
  function threadTeam(id: string): TeamRepo {
    const teamId = repo.threadTeam(id);
    const scoped = teamId === undefined ? undefined : repo.forTeam(teamId);
    if (!scoped?.team() || !scoped.thread(id)) throw new StudioError(404, "not_found", `No thread ${id}.`);
    return scoped;
  }

  // An agent id names its team; an id that names no team, or no agent of it, is missing.
  function agentOf(id: string | undefined) {
    const scoped = repo.forTeam(teamOf(id ?? ""));
    const found = scoped.team();
    const agent = found && scoped.agent(id ?? "");
    if (!agent) throw new StudioError(404, "not_found", `No agent ${id}.`);
    return { team: found, scoped, agent, id: agent.id, client: a12s.forTeam(found.a12sToken) };
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
      method: "GET",
      path: /^\/agents\/([^/]+)$/,
      run({ params }): AgentSettings {
        const { scoped, agent } = agentOf(params[0]);
        const { model, sleepAfterIdle, compactMinTokens, cpu, memory } = agent;
        return {
          role: current(scoped.roleRules(agent.id)) ?? "",
          model,
          sleepAfterIdle,
          compactMinTokens,
          cpu,
          memory,
        };
      },
    },
    {
      method: "GET",
      path: /^\/agents\/([^/]+)\/role$/,
      run({ params, query }): RulesPage {
        const { scoped, id } = agentOf(params[0]);
        return versions(scoped.roleRules(id), before(query));
      },
    },
    {
      method: "GET",
      path: /^\/rules$/,
      run: ({ query }): RulesPage => versions(repo.ownerRules(), before(query)),
    },
    {
      method: "PUT",
      path: /^\/rules$/,
      run({ body }) {
        write(repo.ownerRules(), parse(schemas.rules, body).body, "owner");
        return written();
      },
    },
    {
      method: "GET",
      path: /^\/teams\/([^/]+)\/rules$/,
      run: ({ params, query }): RulesPage => versions(team(params[0]).scoped.teamRules(), before(query)),
    },
    {
      method: "PUT",
      path: /^\/teams\/([^/]+)\/rules$/,
      run({ params, body }) {
        write(team(params[0]).scoped.teamRules(), parse(schemas.rules, body).body, "owner");
        return written();
      },
    },
    {
      method: "GET",
      path: /^\/agents\/([^/]+)\/turns$/,
      async run({ params }): Promise<TurnsResponse> {
        const { client, id } = agentOf(params[0]);
        const turns = await client.turns(id, TURN_LIST);
        return {
          turns: turns.map((t) => ({
            id: t.id,
            status: t.status,
            error: t.error ?? null,
            startedAt: t.startedAt ?? null,
            finishedAt: t.finishedAt,
            text: t.text,
          })),
        };
      },
    },
    {
      method: "GET",
      path: /^\/agents\/([^/]+)\/turns\/([^/]+)\/events$/,
      async run({ params }): Promise<TurnEventsResponse> {
        const { scoped, client, id } = agentOf(params[0]);
        // a12s answers only for this agent computer's own Turns, so another agent's Turn id finds no events.
        const events: A12sEvent[] = [];
        for await (const event of client.turnEvents(id, params[1] ?? "")) events.push(event);
        return { calls: toolLog(events), steered: steeredLog(scoped, events) };
      },
    },
    {
      method: "GET",
      path: /^\/agents\/([^/]+)\/inbox$/,
      run({ params }): InboxResponse {
        const { scoped, id } = agentOf(params[0]);
        return {
          messages: scoped.inbox(id).map((m) => ({
            ...messageView(m),
            thread: m.threadId,
            sentAs: m.a12sMessageId,
          })),
        };
      },
    },
    {
      method: "DELETE",
      path: /^\/agents\/([^/]+)\/inbox\/([^/]+)$/,
      async run({ params }) {
        const { scoped, client, id } = agentOf(params[0]);
        const message = scoped.inbox(id).find((m) => m.id === params[1]);
        if (!message) throw new StudioError(404, "not_found", `No message ${params[1]} in this inbox.`);
        if (message.a12sMessageId === null) scoped.unqueue(id, message.id);
        else {
          await client.withdraw(id, message.a12sMessageId);
          scoped.markUndelivered([message.a12sMessageId]);
        }
        return written();
      },
    },
    {
      method: "POST",
      path: /^\/agents\/([^/]+)\/inbox\/clear$/,
      async run({ params }) {
        const { scoped, client, id } = agentOf(params[0]);
        scoped.unqueue(id);
        await client.clearInbox(id);
        // Only what a12s withdrew: a Message a Turn has just taken is still delivered.
        const withdrawn = (await client.inbox(id)).filter((m) => m.state === "withdrawn").map((m) => m.id);
        scoped.markUndelivered(withdrawn);
        return written();
      },
    },
    {
      method: "GET",
      path: /^\/agents\/([^/]+)\/files$/,
      run({ params, query }) {
        const { client, id } = agentOf(params[0]);
        return client.readFile(id, homePath(query.get("path") ?? ""));
      },
    },
    {
      method: "PUT",
      path: /^\/agents\/([^/]+)\/files$/,
      async run({ params, query, body }) {
        const { client, id } = agentOf(params[0]);
        const path = homePath(query.get("path") ?? "");
        const file = parse(schemas.putFile, body);
        const content = file.encoding === "base64" ? Buffer.from(file.content, "base64") : Buffer.from(file.content);
        await client.writeFile(id, path, content);
        return written();
      },
    },
    {
      method: "GET",
      path: /^\/agents\/([^/]+)\/terminal$/,
      async socket(upgrade) {
        const { client, id } = agentOf(upgrade.params[0]);
        await bridgeTerminal(client, id, upgrade);
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
      method: "POST",
      path: /^\/threads\/([^/]+)\/seen$/,
      run({ params }) {
        const id = params[0] ?? "";
        markSeen(threadTeam(id), id);
        return written();
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
      method: "GET",
      path: /^\/files\/([^/]+)\/([^/]+)$/,
      async run({ params, res }) {
        const id = params[0] ?? "";
        const teamId = repo.messageTeam(id);
        const scoped = teamId === undefined ? undefined : repo.forTeam(teamId);
        await sendAttachment(res, filesDir, scoped?.team() && scoped.message(id), params[1] ?? "");
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
      run: ({ params }) => teamBroker(params[0]).access(),
    },
    {
      method: "PUT",
      path: /^\/teams\/([^/]+)\/credentials\/([^/]+)$/,
      async run({ params, body }) {
        const input = parse(schemas.credential, body);
        await teamBroker(params[0]).putCredential(params[1] ?? "", input);
        return relayed();
      },
    },
    {
      method: "DELETE",
      path: /^\/teams\/([^/]+)\/credentials\/([^/]+)$/,
      async run({ params }) {
        await teamBroker(params[0]).deleteCredential(params[1] ?? "");
        return relayed();
      },
    },
    {
      method: "POST",
      path: /^\/teams\/([^/]+)\/grants$/,
      async run({ params, body }) {
        const input = parse(schemas.grant, body);
        const grant = await teamBroker(params[0]).createGrant(input);
        return relayed(grant.id);
      },
    },
    {
      method: "DELETE",
      path: /^\/teams\/([^/]+)\/grants\/([^/]+)$/,
      async run({ params }) {
        await teamBroker(params[0]).revokeGrant(params[1] ?? "");
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
        systemMessage(scoped, request.agentId, decision(request, expiresAt));
        void dispatcher.run();
        return relayed();
      },
    },
    {
      method: "POST",
      path: /^\/teams\/([^/]+)\/requests\/([^/]+)\/deny$/,
      async run({ params }) {
        const { team: found, scoped } = team(params[0]);
        const request = await broker.forTeam(found.id).deny(params[1] ?? "");
        systemMessage(scoped, request.agentId, decision(request, undefined));
        void dispatcher.run();
        return relayed();
      },
    },
    {
      method: "GET",
      path: /^\/teams\/([^/]+)\/audit$/,
      run: ({ params, query }) => teamBroker(params[0]).audit(query.get("before")),
    },
  ];
}
