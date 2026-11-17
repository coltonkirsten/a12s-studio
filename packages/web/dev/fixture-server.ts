// Development only: stands in for the app on 127.0.0.1:7400 with a recorded state, so the UI can be built and
// looked at before the real owner API exists. Vite never bundles this folder.
import { createServer, type ServerResponse } from "node:http";
import type { Template } from "@a12s-studio/contract/api";
import { type MessageId, type ThreadId, teamSlug } from "@a12s-studio/contract/names";
import type {
  AgentView,
  MessageView,
  NeedsYouItem,
  StudioState,
  TeamView,
  ThreadView,
} from "@a12s-studio/contract/state";

const MIN = 60_000;
const now = Date.now();
let rev = 1;
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
    msg(
      "reply",
      "notes-lead",
      "owner",
      "Summary: all three are fine for a small site. The fastest builds came from the one with the fewest plugins; the best docs belong to the oldest. Details are in compare.md.",
      60 * 2 - 5,
    ),
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
      agent("website-lead", "Plans the work, talks to you, reviews", "awake"),
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

const needsYou: NeedsYouItem[] = [
  { kind: "question", teamId: "website", threadId: "th_fixturecopy", message: question },
  {
    kind: "access_request",
    teamId: "notes",
    hostHasCredential: true,
    request: {
      id: "rq_fixture1",
      agentId: "notes-researcher",
      host: "api.github.com",
      methods: ["GET"],
      paths: ["/repos/example/*/releases"],
      reason: "To compare how often each generator ships a release.",
      days: 7,
      status: "pending",
      createdAt: now - 40 * MIN,
      decidedAt: null,
    },
  },
];

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
    needsYou,
    open: threads.find((t) => t.id === open) ?? null,
    teams: teams.map((team) => ({
      ...team,
      threads: threads
        .filter((t) => t.teamId === team.id)
        .map((t) => {
          const last = t.messages.at(-1);
          const asks = needsYou.filter((i) => i.kind === "question" && i.threadId === t.id).length;
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
  "The header now wraps below 600px and the logo keeps its size. I added a test that renders the header at 390px and checks nothing overlaps. Running the full suite once more before I post the result.".split(
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

async function body(req: AsyncIterable<Buffer>): Promise<Record<string, unknown>> {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

function write(b: Record<string, unknown>, path: string, method: string): string | undefined {
  const [, kind, id, sub] = path.split("/").slice(1);
  if (method === "PATCH" && kind === "settings") Object.assign(settings, b);
  if (method === "PATCH" && kind === "teams") Object.assign(teams.find((t) => t.id === id) ?? {}, b);
  if (method === "PATCH" && kind === "threads") Object.assign(threads.find((t) => t.id === id) ?? {}, b);
  if (method === "POST" && kind === "threads" && sub === "messages") {
    const t = threads.find((x) => x.id === id);
    const to = b.to === undefined ? t?.ownerId : `${t?.teamId}-${b.to}`;
    const m = msg(b.ask ? "reply" : "ask", "owner", String(to), String(b.body), 0);
    t?.messages.push({ ...m, at: Date.now(), ask: (b.ask as MessageId | undefined) ?? null });
    const answered = needsYou.findIndex((i) => i.kind === "question" && i.message.id === b.ask);
    if (answered >= 0) needsYou.splice(answered, 1);
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
  const id = write(await body(req), url.pathname, req.method ?? "GET");
  // A short delay so the in-progress look of a control can be seen.
  setTimeout(() => {
    changed();
    res.end(JSON.stringify({ rev, id }));
  }, 400);
}).listen(7400, "127.0.0.1", () => console.log("fixture on http://127.0.0.1:7400"));
