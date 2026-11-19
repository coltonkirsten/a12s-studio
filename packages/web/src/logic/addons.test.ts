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

const without = (field: string) => Object.fromEntries(Object.entries(NARRATE).filter(([k]) => k !== field));

test("readManifest takes a manifest with every field and no other", () => {
  assert.deepEqual(readManifest(JSON.stringify(NARRATE)), NARRATE);
  assert.deepEqual(readManifest(JSON.stringify({ ...NARRATE, access: [] })), { ...NARRATE, access: [] });
});

test("readManifest says what is wrong with anything else", () => {
  const access = (entry: unknown) => JSON.stringify({ ...NARRATE, access: [entry] });
  const rows: [string, string][] = [
    ["", "This is not JSON."],
    ["{", "This is not JSON."],
    ["[]", "A manifest is one JSON object."],
    ["null", "A manifest is one JSON object."],
    ['"narrate"', "A manifest is one JSON object."],
    [JSON.stringify({ ...NARRATE, settings: {} }), "“settings” is not a manifest field."],
    [JSON.stringify(without("id")), "A manifest needs an id, a name and a description."],
    [JSON.stringify({ ...NARRATE, name: 7 }), "A manifest needs an id, a name and a description."],
    [JSON.stringify(without("image")), "A manifest needs an image."],
    [JSON.stringify(without("access")), "A manifest needs access: the list of outside calls it makes, empty for none."],
    [
      JSON.stringify({ ...NARRATE, access: {} }),
      "A manifest needs access: the list of outside calls it makes, empty for none.",
    ],
    [access("api.speech.example"), "The access entry 1 is not an object."],
    [
      access({ ...NARRATE.access[0], port: 443 }),
      "The access entry 1 has a field “port”, which a manifest does not take.",
    ],
    [access({ methods: ["POST"], paths: ["/"] }), "The access entry 1 needs a host."],
    [
      access({ host: "api.speech.example", methods: "POST", paths: ["/"] }),
      "The access entry 1 needs methods and paths, each a list of text.",
    ],
    [
      access({ host: "api.speech.example", methods: ["POST"], paths: [1] }),
      "The access entry 1 needs methods and paths, each a list of text.",
    ],
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
