import type { CreateGrantBody, PutCredentialBody } from "@a12s-studio/contract/broker-admin";

export type Repo = { owner: string; name: string };

export type Preset = { kind: "read" } | { kind: "write" } | { kind: "api"; methods: string[] };

const GIT = "github.com";
const API = "api.github.com";

const OWNER = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
const NAME = /^[A-Za-z0-9._-]{1,100}$/;

/** "owner/repo", also pasted as a github.com address with or without ".git". */
export function parseRepo(text: string): Repo | null {
  const [owner = "", name = "", ...rest] = text
    .trim()
    .replace(/^(https:\/\/)?(www\.)?github\.com\//, "")
    .replace(/\/$/, "")
    .replace(/\.git$/, "")
    .split("/");
  if (rest.length > 0 || !OWNER.test(owner) || !NAME.test(name) || name === "." || name === "..") return null;
  return { owner, name };
}

/** The plain grant a preset stands for (build-spec 9.3). */
export function presetGrant(repo: Repo, preset: Preset): CreateGrantBody {
  const base = `/${repo.owner}/${repo.name}`;
  switch (preset.kind) {
    case "read":
      return {
        host: GIT,
        methods: ["GET", "POST"],
        paths: [`${base}.git/info/refs`, `${base}.git/git-upload-pack`, `${base}/info/refs`, `${base}/git-upload-pack`],
      };
    case "write":
      return { host: GIT, methods: ["GET", "POST"], paths: [`${base}.git/**`, `${base}/**`] };
    case "api":
      return { host: API, methods: preset.methods, paths: [`/repos${base}/**`] };
  }
}

/** One GitHub token is stored as two credentials: git over HTTPS takes a basic login, the API a bearer token. */
export const GITHUB_HOSTS: readonly string[] = [GIT, API];

export function githubCredentials(token: string): [string, PutCredentialBody][] {
  return [
    [GIT, { scheme: "basic", username: "x-access-token", secret: token }],
    [API, { scheme: "bearer", secret: token }],
  ];
}
