import type { Grant } from "@a12s-studio/contract/broker-admin";

export const METHODS: readonly string[] = ["GET", "POST", "PUT", "PATCH", "DELETE"];

const MAX_HOST = 253;
// The last label starts with a letter, so no spelling of an IP address (dotted, short or hex) is a host.
const HOST = /^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]([a-z0-9-]*[a-z0-9])?$/;
// Names that resolve to this machine or to a12s Services.
const LOCAL = /\.(localhost|a12s)$/;
const PRINTABLE = /^[!-~]*$/;
// Spellings that the matcher and the host could read as different paths: dot segments (some hosts drop a ";…"
// suffix before reading one), empty segments, and escapes for "/", "\", ".", "%" and NUL, overlong or malformed.
const AMBIGUOUS = /\/\.{1,2}([/;]|$)|\/\/|[\\?#]|%(2f|5c|2e|25|00|c[01])|%(?![0-9a-f]{2})/i;

export function isHost(host: string): boolean {
  return host.length <= MAX_HOST && HOST.test(host) && !LOCAL.test(host);
}

function isPath(path: string): boolean {
  return path.startsWith("/") && PRINTABLE.test(path) && !AMBIGUOUS.test(path);
}

export function isPattern(pattern: string): boolean {
  const segments = pattern.split("/");
  const wildcard = (s: string, i: number) => !s.includes("*") || s === "*" || (s === "**" && i === segments.length - 1);
  return isPath(pattern) && segments.every(wildcard);
}

type Target = { host: string; path: string; query: string };

// Splits "/<host>/<path>?<query>". The path is kept exactly as sent: it is matched and forwarded without decoding.
export function parseTarget(url: string): Target | undefined {
  const [, host = "", path = "", query = ""] = /^\/([^/?]+)(\/[^?]*)(\?.*)?$/.exec(url) ?? [];
  return isHost(host) && isPath(path) && PRINTABLE.test(query) ? { host, path, query } : undefined;
}

export function matches(pattern: string, path: string): boolean {
  const want = pattern.split("/");
  const have = path.split("/");
  const open = want.at(-1) === "**";
  if (open) want.pop();
  if (open ? have.length < want.length : have.length !== want.length) return false;
  return want.every((segment, i) => (segment === "*" ? have[i] !== "" : segment === have[i]));
}

export function grantFor(grants: Grant[], method: string, path: string, now: number): Grant | undefined {
  const wanted = method === "HEAD" ? "GET" : method;
  return grants.find(
    (grant) =>
      grant.revokedAt === null &&
      (grant.expiresAt === null || grant.expiresAt > now) &&
      grant.methods.includes(wanted) &&
      grant.paths.some((pattern) => matches(pattern, path)),
  );
}
