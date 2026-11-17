import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { CALLER_HEADER, STUDIO_HOST, STUDIO_URL } from "@a12s-studio/contract/names";
import { homePath } from "../src/files.ts";
import { pending, type Studio, studio, until } from "./studio.ts";

let s: Studio;
// A note from web-dev in a web thread, with web-dev's report attached.
let thread: string;
let attached: string;
const REPORT = "# Report\n\nThree findings.\n";

before(async () => {
  s = await studio();
  await s.twoTeams();
  s.a12s.agents.get("web-dev")?.files.set("/home/agent/out/report.md", new TextEncoder().encode(REPORT));
  s.a12s.agents.get("web-dev")?.files.set("/home/agent/out/data/rows.csv", new TextEncoder().encode("a,b\n"));
  thread = String((await s.tool("web-lead", "post", { to: "dev", title: "Report", body: "Go." })).thread);
  const posted = await s.tool("web-dev", "post", {
    thread,
    body: "The report.",
    file: "/home/agent/out/report.md",
  });
  assert.equal(posted.error, undefined, JSON.stringify(posted.error));
  attached = String(posted.message);
});
after(() => s.close());

// A GET on the agent listener as the a12s proxy sends it, with the body as text.
function agentGet(caller: string | null, path: string): Promise<{ status: number; text: string; headers: object }> {
  const { port } = s.app.agentServer.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { host: STUDIO_HOST };
    if (caller) headers[CALLER_HEADER] = caller;
    const req = request({ host: "127.0.0.1", port, path, headers }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (text += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, text, headers: res.headers }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("homePath: only a plain absolute path inside /home/agent", () => {
  const cases: [string, boolean][] = [
    ["/home/agent", true],
    ["/home/agent/memory/notes.md", true],
    ["/home/agent/out/a..b.txt", true],
    ["/home/agent/..hidden", true],
    ["/home/agent/../etc/passwd", false],
    ["/home/agent/out/../../../etc/passwd", false],
    ["/home/agent/..", false],
    ["/home/agent/out/..", false],
    ["/home/agent/./notes.md", false],
    ["/home/agent//notes.md", false],
    ["/home/agent/", false],
    ["/home/agentx/notes.md", false],
    ["/home/other/notes.md", false],
    ["/etc/passwd", false],
    ["home/agent/notes.md", false],
    ["notes.md", false],
    ["", false],
    ["/home/agent/a\0b", false],
  ];
  for (const [path, ok] of cases) {
    if (ok) assert.equal(homePath(path), path, path);
    else assert.throws(() => homePath(path), { code: "outside_home" }, JSON.stringify(path));
  }
});

test("post with a file: copied from the agent's home into the message's folder", async () => {
  assert.equal(readFileSync(join(s.filesDir, attached, "report.md"), "utf8"), REPORT);
  const read = await s.tool("web-lead", "read", { thread });
  const messages = read.messages as { id: string; file: string | null }[];
  assert.equal(messages.find((m) => m.id === attached)?.file, `${STUDIO_URL}/files/${attached}/report.md`);
  const view = await s.owner("GET", `/api/threads/${thread}/messages`);
  const shown = (view.body as { messages: { id: string; file: string | null }[] }).messages;
  assert.equal(shown.find((m) => m.id === attached)?.file, "report.md");
});

test("post with a file: the receiver's a12s Message names its address", async () => {
  const posted = await s.tool("web-dev", "post", {
    to: "lead",
    thread,
    body: "Please check the rows.",
    file: "/home/agent/out/data/rows.csv",
  });
  await until(() => pending(s.a12s, "web-lead").some((m) => m.metadata.message === posted.message));
  const sent = pending(s.a12s, "web-lead").find((m) => m.metadata.message === posted.message);
  assert.match(sent?.body ?? "", new RegExp(`^file: ${STUDIO_URL}/files/${posted.message}/rows\\.csv$`, "m"));
});

test("post with a file outside the home, a folder or a missing file is refused and writes nothing", async () => {
  const before = (await s.tool("web-lead", "read", { thread })).messages as unknown[];
  const cases: [string, string][] = [
    ["/etc/passwd", "outside_home"],
    ["/home/agent/../../etc/passwd", "outside_home"],
    ["relative/report.md", "outside_home"],
    ["/home/agent/out", "not_a_file"],
    ["/home/agent/out/missing.md", "not_found"],
  ];
  for (const [file, code] of cases) {
    const answer = await s.tool("web-dev", "post", { thread, body: "x", file });
    assert.equal(answer.error?.code, code, file);
  }
  const after = (await s.tool("web-lead", "read", { thread })).messages as unknown[];
  assert.equal(after.length, before.length);
});

test("an attachment is served only to a caller on the message's team", async () => {
  const path = `/files/${attached}/report.md`;
  const own = await agentGet("web-lead", path);
  assert.equal(own.status, 200);
  assert.equal(own.text, REPORT);

  const theirs = await agentGet("notes-lead", path);
  const missing = await agentGet("notes-lead", "/files/m_000000000000/report.md");
  assert.equal(theirs.status, 404);
  assert.deepEqual(JSON.parse(theirs.text), JSON.parse(missing.text.replace("m_000000000000", attached)));

  assert.equal((await agentGet("web-lead", `/files/${attached}/other.md`)).status, 404);
  assert.equal((await agentGet("web-lead", `/files/${attached}/..%2F..%2Fstudio.db`)).status, 404);
  assert.equal((await agentGet(null, path)).status, 403);
});

test("the owner downloads an attachment; it is never shown as a page of Studio's origin", async () => {
  const res = await s.owner("GET", `/api/files/${attached}/report.md`);
  assert.equal(res.status, 200);
  assert.equal(res.body, REPORT);
  assert.equal(res.headers["content-type"], "application/octet-stream");
  assert.equal(res.headers["content-disposition"], "attachment; filename*=UTF-8''report.md");
  assert.equal(res.headers["x-content-type-options"], "nosniff");
  assert.equal((await s.owner("GET", `/api/files/${attached}/other.md`)).status, 404);
  assert.equal((await s.owner("GET", "/api/files/m_000000000000/report.md")).status, 404);
  assert.equal(existsSync(join(s.filesDir, "m_000000000000")), false);
});
