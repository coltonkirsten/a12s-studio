// Development only: stands in for the app's owner API with a recorded state, so every state of the UI can be
// looked at without Docker, a12s or a login. Vite never bundles this folder.
import { createServer, type ServerResponse } from "node:http";
import type { ErrorBody, Template } from "@a12s-studio/contract/api";
import type {
  AccessRequest,
  AccessView,
  ApproveBody,
  AuditEntry,
  CreateGrantBody,
  Grant,
  PutCredentialBody,
} from "@a12s-studio/contract/broker-admin";
import { type MessageId, OWNER_PORT, type RequestId, type ThreadId, teamSlug } from "@a12s-studio/contract/names";
import type {
  AgentView,
  MessageView,
  NeedsYouItem,
  StudioState,
  TeamView,
  ThreadView,
} from "@a12s-studio/contract/state";

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const now = Date.now();
let rev = 1;
const AUDIT_PAGE = 50;
// Beside a running Studio, which holds the owner port, FIXTURE_PORT moves the fixture and Vite's proxy to another.
const port = Number(process.env.FIXTURE_PORT ?? OWNER_PORT);
let seq = 0;

function agent(
  id: string,
  roleLine: string,
  presence: AgentView["presence"],
  extra: Partial<AgentView> = {},
): AgentView {
  return {
    id,
    slug: id.slice(id.indexOf("-") + 1),
    roleLine,
    model: "sonnet",
    presence,
    line: null,
    turn: null,
    work: [],
    queued: 0,
    ...extra,
  };
}

function msg(kind: MessageView["kind"], from: string, to: string | null, body: string, ago: number): MessageView {
  seq += 1;
  return { id: `m_fixture${seq}`, kind, from, to, ask: null, body, file: null, implicit: false, at: now - ago * MIN };
}

function thread(
  id: ThreadId,
  teamId: string,
  title: string,
  status: "open" | "done",
  messages: MessageView[],
): ThreadView {
  return { id, teamId, title, ownerId: `${teamId}-lead`, status, messages, hasMore: false };
}

// An answer as agents write them: markdown, with an image and a tag the page must not honour.
const SUMMARY = `## Summary

All three are fine for a small docs site. **The fastest builds** came from the one with the fewest plugins; the best docs belong to the oldest.

| Tool | Build | Plugins | Docs |
|---|--:|--:|---|
| Alpha | 1.2 s | 40 | Good |
| Beta | 3.8 s | 300 | Very good |
| Gamma | 2.1 s | 120 | Excellent |

- [x] Build times on the same 200 pages
- [x] Plugin counts from each registry
- [ ] Theme support, next week

To try the fastest one:

\`\`\`sh
npx alpha build --out site && npx alpha serve site --port 8080 --open --watch --verbose
\`\`\`

> Raw numbers are in \`compare.md\`.

Sources: [Alpha docs](https://example.com/alpha), ![build time chart](https://example.com/chart.png). <script>alert("hi")</script>`;

const question = msg(
  "ask",
  "website-lead",
  "owner",
  "Two headlines are ready. Do you prefer “Build it once, keep it simple” or “A calm site for busy people”?",
  12,
);

const threads: ThreadView[] = [
  thread("th_fixturemenu", "website", "Fix the menu on small screens", "open", [
    msg("ask", "owner", "website-lead", "The menu overlaps the logo on phones. Can you fix it this afternoon?", 48),
    msg(
      "ask",
      "website-lead",
      "website-dev",
      "Please fix the header menu below 600px wide; keep the desktop layout.",
      46,
    ),
    msg("note", "website-dev", "website-lead", "Found it: the logo has a fixed width.", 30),
    msg("reply", "website-dev", "website-lead", "Fixed in header.css; adding a test now.", 6),
    msg("note", "website-lead", null, "Dev has a fix in review. Only the header changes.", 5),
  ]),
  thread("th_fixturecopy", "website", "Landing page copy", "open", [
    msg("ask", "owner", "website-lead", "Draft the landing page copy. Short, friendly, no jargon.", 180),
    msg("ask", "website-lead", "website-writer", "Two headline options and a three-line intro, please.", 175),
    msg("reply", "website-writer", "website-lead", "Done; both options are in copy.md.", 20),
    question,
  ]),
  thread("th_fixturedeploy", "website", "Set up preview deploys", "done", [
    msg("ask", "owner", "website-lead", "Every pull request should get a preview link.", 60 * 26),
    msg(
      "reply",
      "website-lead",
      "owner",
      "Done. Each pull request now gets a preview link in its first comment.",
      60 * 25,
    ),
  ]),
  thread("th_fixturessg", "notes", "Compare static site generators", "open", [
    msg(
      "ask",
      "owner",
      "notes-lead",
      "Compare three open-source static site generators for a small docs site.",
      60 * 5,
    ),
    msg(
      "ask",
      "notes-lead",
      "notes-researcher",
      "Build times, plugin story and docs quality for three tools.",
      60 * 5 - 2,
    ),
    msg("reply", "notes-researcher", "notes-lead", "Notes are in compare.md.", 60 * 2),
    msg("reply", "notes-lead", "owner", SUMMARY, 60 * 2 - 5),
  ]),
  thread("th_fixturereading", "notes", "Reading list for next week", "done", [
    msg("ask", "owner", "notes-lead", "Five short articles on writing clear documentation.", 60 * 24 * 3),
    msg("reply", "notes-lead", "owner", "Here are five, each under ten minutes.", 60 * 24 * 3 - 30),
  ]),
];

const teams: Omit<TeamView, "threads">[] = [
  {
    id: "website",
    name: "Website",
    purpose: "Build and look after the project website: pages, copy and the deploy pipeline.",
    accent: "#007aff",
    paused: false,
    leadId: "website-lead",
    budget: { dailyUsd: 25, spentTodayUsd: 6.4, held: false },
    agents: [
      // Its Turn has ended and its work runs on: working, with the work listed.
      agent("website-lead", "Plans the work, talks to you, reviews", "working", {
        line: "Working in the background",
        work: [
          {
            id: "task-fixture-1",
            kind: "agent",
            description: "Check every page for the same overlap",
            threadId: "th_fixturemenu",
            startedAt: now - 7 * MIN,
            line: "Reading header.css",
          },
          {
            id: "task-fixture-2",
            kind: "task",
            description: "npm run preview",
            threadId: "th_fixturemenu",
            startedAt: now - 4 * MIN,
            line: null,
          },
        ],
      }),
      agent("website-dev", "Writes and tests the code", "working", {
        line: "Running tests",
        turn: { id: "turn-fixture", threadId: "th_fixturemenu", startedAt: now - 2 * MIN, text: "" },
      }),
      agent("website-writer", "Writes page copy", "asleep", { model: "haiku" }),
    ],
  },
  {
    id: "notes",
    name: "Research notes",
    purpose: "Write short, neutral comparisons of tools the owner is considering.",
    accent: "#ff9500",
    paused: false,
    leadId: "notes-lead",
    budget: { dailyUsd: 25, spentTodayUsd: 21.8, held: false },
    agents: [
      agent("notes-lead", "Plans the comparison and writes the summary", "asleep"),
      agent("notes-researcher", "Reads sources and takes notes", "waiting", { waitingFor: "cap", queued: 1 }),
    ],
  },
];

const questions: NeedsYouItem[] = [
  { kind: "question", teamId: "website", threadId: "th_fixturecopy", message: question },
];

type TeamAccess = AccessView & { audit: AuditEntry[] };

function grant(id: string, host: string, methods: string[], paths: string[], expiresAt: number | null): Grant {
  return {
    id: `g_${id}`,
    host,
    methods,
    paths,
    expiresAt,
    requestId: null,
    createdAt: now - DAY * 20,
    warnedAt: null,
    revokedAt: null,
    expiredAt: null,
  };
}

function request(
  id: string,
  agentId: string,
  host: string,
  methods: string[],
  paths: string[],
  reason: string,
): AccessRequest {
  return {
    id: `rq_${id}`,
    agentId,
    host,
    methods,
    paths,
    reason,
    days: 7,
    status: "pending",
    createdAt: now - 40 * MIN,
    decidedAt: null,
  };
}

// Agents' calls, so the audit log has older pages to read.
function calls(agentId: string, count: number): AuditEntry[] {
  return Array.from({ length: count }, (_, i) => ({
    id: 1000 - i * 2,
    at: now - (i + 1) * 37 * MIN,
    agentId,
    actor: "agent",
    action: i % 9 === 4 ? "deny" : "call",
    host: "github.com",
    method: i % 3 ? "GET" : "POST",
    path: i % 3 ? "/example/site.git/info/refs" : "/example/site.git/git-upload-pack",
    status: i % 9 === 4 ? 403 : 200,
    grantId: null,
    detail: null,
  }));
}

const access: Record<string, TeamAccess> = {
  website: {
    credentials: [
      {
        host: "github.com",
        scheme: "basic",
        username: "x-access-token",
        headerName: null,
        createdAt: now - DAY * 20,
        updatedAt: now - DAY * 20,
        rejectedAt: null,
      },
      {
        host: "api.github.com",
        scheme: "bearer",
        username: null,
        headerName: null,
        createdAt: now - DAY * 20,
        updatedAt: now - DAY * 20,
        rejectedAt: now - 25 * MIN,
      },
    ],
    grants: [
      grant("fixturewrite", "github.com", ["GET", "POST"], ["/example/site.git/**", "/example/site/**"], null),
      grant("fixtureapi", "api.github.com", ["GET"], ["/repos/example/site/**"], now + DAY * 2),
    ],
    requests: [
      request(
        "fixture1",
        "website-dev",
        "api.github.com",
        ["POST"],
        ["/repos/example/site/pulls"],
        "To open a pull request for the menu fix.",
      ),
    ],
    audit: calls("website-dev", 60),
  },
  notes: {
    credentials: [],
    grants: [],
    requests: [
      request(
        "fixture2",
        "notes-researcher",
        "api.example.com",
        ["GET"],
        ["/v1/releases/*"],
        "To compare how often each generator ships a release.",
      ),
    ],
    audit: [],
  },
};

function teamAccess(team: string): TeamAccess {
  access[team] ??= { credentials: [], grants: [], requests: [], audit: [] };
  return access[team];
}

/** The broker's three cards, derived the way the app derives them from its attention answer. */
function needsYou(): NeedsYouItem[] {
  const items = [...questions];
  for (const [teamId, a] of Object.entries(access)) {
    const stored = (host: string) => a.credentials.some((c) => c.host === host);
    for (const r of a.requests.filter((x) => x.status === "pending")) {
      items.push({ kind: "access_request", teamId, request: r, hostHasCredential: stored(r.host) });
    }
    for (const c of a.credentials.filter((x) => x.rejectedAt !== null)) {
      items.push({ kind: "credential_rejected", teamId, host: c.host, at: c.rejectedAt ?? now });
    }
    for (const g of a.grants) {
      if (g.revokedAt !== null || g.expiresAt === null) continue;
      const left = g.expiresAt - Date.now();
      if (left <= 0 || left > 3 * DAY) continue;
      items.push({
        kind: "grant_expiring",
        teamId,
        grantId: g.id,
        host: g.host,
        paths: g.paths,
        expiresAt: g.expiresAt,
      });
    }
  }
  return items;
}

const settings: StudioState["settings"] = {
  awakeCap: 4,
  defaultDailyBudgetUsd: 25,
  minFreeDiskGb: 15,
  paused: false,
  defaultModel: "sonnet",
  defaultSleepAfterIdle: "15m",
  defaultCompactMinTokens: 100000,
};

const templates: Template[] = [
  { id: "blank", purpose: "", agents: ["lead"] },
  { id: "website", purpose: "Build and look after a small website.", agents: ["lead", "dev"] },
  { id: "research-notes", purpose: "Write short, neutral comparisons of tools.", agents: ["lead", "researcher"] },
];

function stateFor(open: string | null): StudioState {
  return {
    rev,
    a12s: "up",
    broker: "up",
    settings,
    needsYou: needsYou(),
    open: threads.find((t) => t.id === open) ?? null,
    teams: teams.map((team) => ({
      ...team,
      threads: threads
        .filter((t) => t.teamId === team.id)
        .map((t) => {
          const last = t.messages.at(-1);
          const asks = questions.filter((i) => i.kind === "question" && i.threadId === t.id).length;
          return {
            id: t.id,
            title: t.title,
            ownerId: t.ownerId,
            status: asks ? "needs_you" : t.status,
            updatedAt: last?.at ?? now,
            preview: last?.body ?? "",
            asksForYou: asks,
          } as const;
        })
        .sort((a, b) => b.updatedAt - a.updatedAt),
    })),
  };
}

const clients = new Set<{ res: ServerResponse; thread: string | null }>();

function changed(): void {
  rev += 1;
  for (const c of clients) c.res.write(`event: state\ndata: ${JSON.stringify(stateFor(c.thread))}\n\n`);
}

const words =
  "The header now wraps below **600px** and the logo keeps its size. I added a test that renders the header at 390px and checks nothing overlaps. Running the full suite once more before I post the result.".split(
    /(?= )/,
  );
let word = 0;
setInterval(() => {
  const dev = teams[0]?.agents[1];
  if (!dev?.turn) return;
  if (word >= words.length + 20) {
    word = 0;
    dev.turn = { ...dev.turn, id: `turn-fixture-${rev}`, text: "" };
    changed();
    return;
  }
  const text = words[word++];
  if (!text) return;
  dev.turn.text += text;
  const live = { agent: dev.id, turn: dev.turn.id, text };
  for (const c of clients) c.res.write(`event: live\ndata: ${JSON.stringify(live)}\n\n`);
}, 140);

// The lead's sub-agent moves on as its tool calls arrive.
const subAgentLines = ["Reading header.css", "Searching", "Reading footer.css", "Editing notes.md"];
let step = 0;
setInterval(() => {
  const item = teams[0]?.agents[0]?.work[0];
  if (!item) return;
  item.line = subAgentLines[++step % subAgentLines.length] ?? null;
  changed();
}, 2500);

async function body(req: AsyncIterable<Buffer>): Promise<Record<string, unknown>> {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

class Refusal extends Error {
  readonly body: ErrorBody;
  constructor(body: ErrorBody) {
    super(body.message);
    this.body = body;
  }
}

function audit(a: TeamAccess, entry: Pick<AuditEntry, "action" | "host"> & Partial<AuditEntry>): void {
  const id = (a.audit[0]?.id ?? 1000) + 1;
  a.audit.unshift({
    id,
    at: Date.now(),
    agentId: null,
    actor: "owner",
    method: null,
    path: null,
    status: null,
    grantId: null,
    detail: null,
    ...entry,
  });
}

function addGrant(a: TeamAccess, body: CreateGrantBody, requestId: RequestId | null): Grant {
  const g = {
    ...grant(`fixture${++seq}`, body.host, body.methods, body.paths, body.expiresAt ?? null),
    requestId,
    createdAt: Date.now(),
  };
  a.grants.unshift(g);
  audit(a, { action: "grant.create", host: g.host, grantId: g.id });
  return g;
}

// The owner's access routes, as the app relays them to the broker. The secret is dropped here, as the broker
// keeps it only encrypted.
function accessWrite(
  team: string,
  b: Record<string, unknown>,
  method: string,
  sub: string,
  item: string,
  verb?: string,
): string | undefined {
  const a = teamAccess(team);
  if (sub === "credentials" && method === "PUT") {
    const body = b as PutCredentialBody;
    const at = Date.now();
    a.credentials = [
      {
        host: item,
        scheme: body.scheme,
        username: body.username ?? null,
        headerName: body.headerName ?? null,
        createdAt: at,
        updatedAt: at,
        rejectedAt: null,
      },
      ...a.credentials.filter((c) => c.host !== item),
    ];
    audit(a, { action: "credential.set", host: item });
  }
  if (sub === "credentials" && method === "DELETE") {
    if (!a.credentials.some((c) => c.host === item)) {
      throw new Refusal({ code: "not_found", message: "There is no such credential." });
    }
    a.credentials = a.credentials.filter((c) => c.host !== item);
    for (const g of a.grants) if (g.host === item && g.revokedAt === null) g.revokedAt = Date.now();
    audit(a, { action: "credential.delete", host: item });
  }
  if (sub === "grants" && method === "POST") return addGrant(a, b as CreateGrantBody, null).id;
  if (sub === "grants" && method === "DELETE") {
    const g = a.grants.find((x) => x.id === item);
    if (!g) throw new Refusal({ code: "not_found", message: "There is no such grant." });
    g.revokedAt = Date.now();
    audit(a, { action: "grant.revoke", host: g.host, grantId: g.id });
  }
  if (sub === "requests") {
    const r = a.requests.find((x) => x.id === item);
    if (!r) throw new Refusal({ code: "not_found", message: "There is no such request." });
    if (r.status !== "pending")
      throw new Refusal({ code: "already_decided", message: "This request was already decided." });
    if (verb === "approve" && !a.credentials.some((c) => c.host === r.host)) {
      throw new Refusal({
        code: "no_credential",
        message: `${r.host} has no credential.`,
        fix: `Store a credential for ${r.host} first.`,
      });
    }
    r.status = verb === "approve" ? "approved" : "denied";
    r.decidedAt = Date.now();
    if (verb === "approve") addGrant(a, { ...r, expiresAt: (b as ApproveBody).expiresAt }, r.id);
    audit(a, { action: verb === "approve" ? "request.approve" : "request.deny", host: r.host });
  }
  return undefined;
}

function write(b: Record<string, unknown>, path: string, method: string): string | undefined {
  const [, kind, id, sub, item, verb] = path.split("/").slice(1).map(decodeURIComponent);
  if (kind === "teams" && id && ["credentials", "grants", "requests"].includes(String(sub))) {
    return accessWrite(id, b, method, String(sub), item ?? "", verb);
  }
  if (method === "PATCH" && kind === "settings") Object.assign(settings, b);
  if (method === "PATCH" && kind === "teams") Object.assign(teams.find((t) => t.id === id) ?? {}, b);
  if (method === "PATCH" && kind === "threads") Object.assign(threads.find((t) => t.id === id) ?? {}, b);
  if (method === "POST" && kind === "threads" && sub === "messages") {
    const t = threads.find((x) => x.id === id);
    const to = b.to === undefined ? t?.ownerId : `${t?.teamId}-${b.to}`;
    const m = msg(b.ask ? "reply" : "ask", "owner", String(to), String(b.body), 0);
    t?.messages.push({ ...m, at: Date.now(), ask: (b.ask as MessageId | undefined) ?? null });
    const answered = questions.findIndex((i) => i.kind === "question" && i.message.id === b.ask);
    if (answered >= 0) questions.splice(answered, 1);
  }
  if (method === "POST" && kind === "teams" && sub === "threads") {
    const newId: ThreadId = `th_fixture${++seq}`;
    const first = { ...msg("ask", "owner", `${id}-${b.to ?? "lead"}`, String(b.body), 0), at: Date.now() };
    threads.push(thread(newId, String(id), String(b.body).slice(0, 48), "open", [first]));
    return newId;
  }
  if (method === "POST" && kind === "teams" && !id) {
    const slug = teamSlug(String(b.name), (taken) => teams.some((t) => t.id === taken));
    teams.push({
      id: slug,
      name: String(b.name),
      purpose: String(b.purpose),
      accent: String(b.accent),
      paused: false,
      leadId: `${slug}-lead`,
      budget: { dailyUsd: settings.defaultDailyBudgetUsd, spentTodayUsd: 0, held: false },
      agents: [agent(`${slug}-lead`, "Leads the team", "asleep")],
    });
    return slug;
  }
  if (method === "POST" && kind === "teams" && sub === "agents") {
    teams
      .find((t) => t.id === id)
      ?.agents.push(agent(`${id}-${b.slug}`, String(b.role), "asleep", { model: String(b.model) }));
  }
  return undefined;
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname === "/api/stream") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const client = { res, thread: url.searchParams.get("thread") };
    clients.add(client);
    res.write(`event: state\ndata: ${JSON.stringify(stateFor(client.thread))}\n\n`);
    req.on("close", () => clients.delete(client));
    return;
  }
  res.setHeader("content-type", "application/json");
  if (url.pathname === "/api/templates") return res.end(JSON.stringify({ templates }));
  const [, , , team, part] = url.pathname.split("/");
  if (team && part === "access") {
    const { audit: _, ...view } = teamAccess(team);
    return res.end(JSON.stringify(view));
  }
  if (team && part === "audit") {
    const before = Number(url.searchParams.get("before") ?? Number.POSITIVE_INFINITY);
    const older = teamAccess(team).audit.filter((e) => e.id < before);
    return res.end(JSON.stringify({ entries: older.slice(0, AUDIT_PAGE), hasMore: older.length > AUDIT_PAGE }));
  }
  let id: string | undefined;
  try {
    id = write(await body(req), url.pathname, req.method ?? "GET");
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    res.statusCode = error.body.code === "not_found" ? 404 : 409;
    return res.end(JSON.stringify(error.body));
  }
  // A short delay so the in-progress look of a control can be seen.
  setTimeout(() => {
    changed();
    res.end(JSON.stringify({ rev, id }));
  }, 400);
}).listen(port, "127.0.0.1", () => console.log(`fixture on http://127.0.0.1:${port}`));
