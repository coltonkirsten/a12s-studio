import assert from "node:assert/strict";
import { test } from "node:test";
import type { CredentialView } from "@a12s-studio/contract/broker-admin";
import type { AddonAccess } from "@a12s-studio/contract/state";
import { missingHosts, readManifest } from "./addons.ts";

const NARRATE = {
  id: "narrate",
  name: "Narrate",
  description: "Turns a script into an audio file.",
  image: "registry.example/narrate:1.2.0",
  access: [{ host: "api.speech.example", methods: ["POST"], paths: ["/v1/speech"] }],
};

test("readManifest reads the JSON and its id and leaves every other rule to the server", () => {
  assert.deepEqual(readManifest(JSON.stringify(NARRATE)), { id: "narrate", manifest: NARRATE });
  const odd = { ...NARRATE, settings: {} };
  assert.deepEqual(readManifest(JSON.stringify(odd)), { id: "narrate", manifest: odd });
  const rows: [string, string][] = [
    ["", "This is not JSON."],
    ["{", "This is not JSON."],
    ["[]", "A manifest is a JSON object with an id."],
    ["null", "A manifest is a JSON object with an id."],
    ['"narrate"', "A manifest is a JSON object with an id."],
    [JSON.stringify({ ...NARRATE, id: 7 }), "A manifest is a JSON object with an id."],
    [JSON.stringify({ ...NARRATE, id: "" }), "A manifest is a JSON object with an id."],
  ];
  for (const [text, problem] of rows) assert.equal(readManifest(text), problem, text);
});

const credential = (host: string): CredentialView => ({
  host,
  scheme: "bearer",
  username: null,
  headerName: null,
  createdAt: 0,
  updatedAt: 0,
  rejectedAt: null,
});

test("missingHosts names each host the team has no credential for, once", () => {
  const call = (host: string): AddonAccess => ({ host, methods: ["GET"], paths: ["/**"] });
  const rows: [AddonAccess[], string[], string[]][] = [
    [[], [], []],
    [[call("a.example")], [], ["a.example"]],
    [[call("a.example")], ["a.example"], []],
    [[call("a.example"), call("b.example"), call("a.example")], ["c.example"], ["a.example", "b.example"]],
    [[call("a.example"), call("b.example")], ["b.example"], ["a.example"]],
  ];
  for (const [access, stored, missing] of rows) {
    assert.deepEqual(missingHosts(access, stored.map(credential)), missing, JSON.stringify([access, stored]));
  }
});
