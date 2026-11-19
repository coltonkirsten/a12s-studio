import type { CredentialView } from "@a12s-studio/contract/broker-admin";
import type { AddonAccess } from "@a12s-studio/contract/state";

/**
 * A pasted manifest: JSON with the id its URL names. Every rule on its fields is the server's, and its refusal is
 * shown as it comes.
 */
export function readManifest(text: string): { id: string; manifest: unknown } | string {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return "This is not JSON.";
  }
  const id = typeof value === "object" && value !== null && "id" in value ? value.id : undefined;
  return typeof id === "string" && id !== "" ? { id, manifest: value } : "A manifest is a JSON object with an id.";
}

/** The hosts an add-on calls that the team has no credential for, each once, in the manifest's order. */
export function missingHosts(access: AddonAccess[], credentials: CredentialView[]): string[] {
  const stored = new Set(credentials.map((c) => c.host));
  return [...new Set(access.map((a) => a.host))].filter((host) => !stored.has(host));
}
