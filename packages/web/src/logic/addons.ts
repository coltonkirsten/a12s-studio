import type { CredentialView } from "@a12s-studio/contract/broker-admin";
import type { AddonAccess, AddonManifest } from "@a12s-studio/contract/state";

const FIELDS = ["id", "name", "description", "image", "access"];
const ACCESS_FIELDS = ["host", "methods", "paths"];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isStrings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");
const extra = (record: Record<string, unknown>, fields: string[]) =>
  Object.keys(record).find((k) => !fields.includes(k));

function readAccess(entry: unknown, n: number): AddonAccess | string {
  const where = `access entry ${n + 1}`;
  if (!isRecord(entry)) return `The ${where} is not an object.`;
  const unknown = extra(entry, ACCESS_FIELDS);
  if (unknown !== undefined) return `The ${where} has a field “${unknown}”, which a manifest does not take.`;
  const { host, methods, paths } = entry;
  if (typeof host !== "string") return `The ${where} needs a host.`;
  if (!isStrings(methods) || !isStrings(paths)) return `The ${where} needs methods and paths, each a list of text.`;
  return { host, methods, paths };
}

/**
 * A pasted manifest, once it has every field of the right type and no other. What the values may be (the id's
 * shape, lengths, a tagged image) is the server's rule; its refusal is shown as it comes.
 */
export function readManifest(text: string): AddonManifest | string {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return "This is not JSON.";
  }
  if (!isRecord(value)) return "A manifest is one JSON object.";
  const unknown = extra(value, FIELDS);
  if (unknown !== undefined) return `“${unknown}” is not a manifest field.`;
  const { id, name, description, image, access } = value;
  if (typeof id !== "string" || typeof name !== "string" || typeof description !== "string") {
    return "A manifest needs an id, a name and a description.";
  }
  if (typeof image !== "string") return "A manifest needs an image.";
  if (!Array.isArray(access)) return "A manifest needs access: the list of outside calls it makes, empty for none.";
  const entries = access.map(readAccess);
  const refused = entries.find((entry) => typeof entry === "string");
  if (refused !== undefined) return refused;
  return { id, name, description, image, access: entries.filter((entry) => typeof entry !== "string") };
}

/** The hosts an add-on calls that the team has no credential for, each once, in the manifest's order. */
export function missingHosts(access: AddonAccess[], credentials: CredentialView[]): string[] {
  const stored = new Set(credentials.map((c) => c.host));
  return [...new Set(access.map((a) => a.host))].filter((host) => !stored.has(host));
}
