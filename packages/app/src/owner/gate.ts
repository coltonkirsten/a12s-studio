import type { IncomingHttpHeaders } from "node:http";
import { OWNER_PORT } from "@a12s-studio/contract/names";
import { StudioError } from "../errors.ts";

const LOCAL_HOSTS = [`127.0.0.1:${OWNER_PORT}`, `localhost:${OWNER_PORT}`];
const READS = ["GET", "HEAD"];

// Every request to the owner listener. A request is the owner's when tailscale serve vouches for the owner's login,
// or when it was made on this Mac straight to the listener (no proxy headers, a local Host). A write must also be
// JSON from a page on the same origin, so another web page open in the owner's browser cannot drive the API: a
// cross-site form cannot send JSON, and a cross-site fetch carries its own Origin.
export function ownerGate(method: string, headers: IncomingHttpHeaders, ownerLogin: string): StudioError | null {
  const proxied = Object.keys(headers).some((h) => h.startsWith("tailscale-")) || "x-forwarded-for" in headers;
  const owner = proxied ? headers["tailscale-user-login"] === ownerLogin : LOCAL_HOSTS.includes(headers.host ?? "");
  if (!owner) {
    return new StudioError(
      403,
      "not_owner",
      "This request is not from the owner.",
      "Open Studio on this Mac at 127.0.0.1:7400, or through tailscale serve signed in as the owner.",
    );
  }
  if (READS.includes(method)) return null;
  if (headers["content-type"]?.split(";")[0]?.trim() !== "application/json") {
    return new StudioError(415, "not_json", "A change must be sent as application/json.", "Send a JSON body.");
  }
  const origin = headers.origin;
  if (origin !== undefined && URL.parse(origin)?.host !== headers.host) {
    return new StudioError(403, "cross_origin", "A change must come from Studio's own page.", "Use the Studio page.");
  }
  return null;
}
