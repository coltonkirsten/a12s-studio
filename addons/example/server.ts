// A reference add-on: one MCP tool, on the port service.json declares. Its work is a call through the broker, which
// adds the team's credential, and a report of what the call cost. It holds no secret and knows nothing of teams:
// a12s lets only its own team's agents reach it.
import { createServer, type IncomingMessage, request } from "node:http";

const BROKER = "http://broker.a12s:7420";
const STUDIO = "http://studio.a12s:7410";
// What one lookup is reported to cost. GitHub charges nothing; an add-on that pays for its work reports its price.
const PRICE_USD = 0.01;
// The port service.json declares; a test runs the server on a port of its own.
const PORT = Number(process.env.PORT ?? 8080);
const REPO = /^[\w.-]+\/[\w.-]+$/;

const tools = [
  {
    name: "repo_facts",
    description: "The description, default branch and star count of a GitHub repository.",
    inputSchema: {
      type: "object",
      properties: { repo: { type: "string", description: "owner/name, for example nodejs/node" } },
      required: ["repo"],
      additionalProperties: false,
    },
  },
];

// fetch would tunnel through the proxy, and a12s refuses a tunnel to an http port: it cannot carry the caller header.
// http.request sends plain HTTP to the proxy in HTTP_PROXY.
function call(method: string, url: string, body?: unknown): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method, headers: { accept: "application/json", "content-type": "application/json" } });
    req.on("error", reject);
    req.on("response", async (res) => {
      let text = "";
      for await (const chunk of res) text += chunk;
      let json: unknown = null;
      try {
        json = JSON.parse(text);
      } catch {}
      resolve({ status: res.statusCode ?? 0, json });
    });
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

async function repoFacts(args: unknown): Promise<{ text: string; isError: boolean }> {
  const repo = (args as { repo?: unknown } | null)?.repo;
  if (typeof repo !== "string" || !REPO.test(repo)) return { text: "repo must be owner/name.", isError: true };
  const { status, json } = await call("GET", `${BROKER}/api.github.com/repos/${repo}`);
  if (status !== 200) return { text: `The broker answered ${status}: ${JSON.stringify(json)}`, isError: true };
  const r = json as { full_name: string; description: string | null; default_branch: string; stargazers_count: number };
  const reported = await call("POST", `${STUDIO}/usage`, { usd: PRICE_USD, note: `lookup of ${repo}` });
  if (reported.status !== 200) console.error(`usage report answered ${reported.status}`, reported.json);
  const facts = {
    repo: r.full_name,
    description: r.description,
    defaultBranch: r.default_branch,
    stars: r.stargazers_count,
  };
  return { text: JSON.stringify(facts), isError: false };
}

async function answer(message: { id?: unknown; method?: unknown; params?: unknown }): Promise<unknown> {
  const params = (message.params ?? {}) as { protocolVersion?: string; name?: string; arguments?: unknown };
  switch (message.method) {
    case "initialize":
      return {
        protocolVersion: params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "repo-facts", version: "1.0.0" },
      };
    case "ping":
      return {};
    case "tools/list":
      return { tools };
    case "tools/call": {
      if (params.name !== "repo_facts") return { content: [{ type: "text", text: "No such tool." }], isError: true };
      const { text, isError } = await repoFacts(params.arguments);
      return { content: [{ type: "text", text }], isError };
    }
    default:
      return undefined;
  }
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  let text = "";
  for await (const chunk of req) text += chunk;
  return JSON.parse(text);
}

// MCP over streamable HTTP, stateless, answered as JSON. A notification has no id and gets no answer.
createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/healthz") return res.end("ok");
  if (req.url !== "/mcp" || req.method !== "POST") return res.writeHead(405).end();
  let message: { id?: unknown; method?: unknown; params?: unknown };
  try {
    message = (await readJson(req)) as typeof message;
  } catch {
    return res.writeHead(400).end();
  }
  if (message.id === undefined) return res.writeHead(202).end();
  const result = await answer(message);
  const reply =
    result === undefined
      ? { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `No method ${String(message.method)}.` } }
      : { jsonrpc: "2.0", id: message.id, result };
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(reply));
}).listen(PORT);
