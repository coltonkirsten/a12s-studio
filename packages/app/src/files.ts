import { mkdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { join } from "node:path";
import { STUDIO_URL } from "@a12s-studio/contract/names";
import { A12sError, type TeamA12s } from "./a12s/port.ts";
import { StudioError } from "./errors.ts";
import type { Message } from "./repo.ts";

const HOME = "/home/agent";

export type Attachment = { name: string; content: Uint8Array };

// A path an agent's home may be read or written at: absolute, inside /home/agent, and plain, so no segment can
// step outside it or name it twice. Every path from the owner or an agent passes here before a12s sees it.
export function homePath(path: string): string {
  const segments = path.slice(HOME.length).split("/").slice(1);
  const inside = path === HOME || path.startsWith(`${HOME}/`);
  if (!inside || path.includes("\0") || segments.some((s) => s === "" || s === "." || s === "..")) {
    throw new StudioError(
      400,
      "outside_home",
      `${JSON.stringify(path)} is not a path inside ${HOME}.`,
      `Give an absolute path that starts with ${HOME}/, with no "..".`,
    );
  }
  return path;
}

// Where the agent that receives a message fetches its file.
export function attachmentUrl(message: Pick<Message, "id" | "fileName">): string | null {
  return message.fileName === null ? null : `${STUDIO_URL}/files/${message.id}/${encodeURIComponent(message.fileName)}`;
}

// The file as it is now in the agent's home, copied whole: a later change there does not change what was posted.
export async function readAttachment(a12s: TeamA12s, agent: string, path: string): Promise<Attachment> {
  const file = await a12s.readFile(agent, homePath(path)).catch((error: unknown) => {
    if (!(error instanceof A12sError && error.code === "not_found")) throw error;
    throw new StudioError(404, "not_found", `There is no file at ${path}.`, "Check the path, then post again.");
  });
  if (file.kind !== "file") {
    throw new StudioError(400, "not_a_file", `${path} is a folder.`, "Attach one file; put a folder in an archive.");
  }
  if (file.truncated) {
    throw new StudioError(400, "too_large", `${path} is too large to attach.`, "Attach a smaller file.");
  }
  return {
    name: path.slice(path.lastIndexOf("/") + 1),
    content: file.encoding === "base64" ? Buffer.from(file.content, "base64") : new TextEncoder().encode(file.content),
  };
}

export function storeAttachment(dir: string, message: string, file: Attachment): void {
  mkdirSync(join(dir, message), { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, message, file.name), file.content, { mode: 0o600 });
}

// `message` was found through the caller's team, so another team's message is missing here like an unknown one.
// The file is always a download of opaque bytes: an agent chose its content and name, and on the owner's listener
// a page of Studio's own origin could drive the owner API.
export async function sendAttachment(
  res: ServerResponse,
  dir: string,
  message: Message | undefined,
  name: string,
): Promise<void> {
  if (!message || message.fileName !== name) throw new StudioError(404, "not_found", `No file ${name} there.`);
  const content = await readFile(join(dir, message.id, name));
  res.writeHead(200, {
    "content-type": "application/octet-stream",
    "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
    "x-content-type-options": "nosniff",
    "content-security-policy": "sandbox",
    "cache-control": "no-store",
  });
  res.end(content);
}
