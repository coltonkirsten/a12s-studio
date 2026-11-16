import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

const root = new URL("../", import.meta.url);
const CONTRACT = "@a12s-studio/contract/";

test("invariant 21: the broker has no runtime dependencies", () => {
  const manifest = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
  assert.equal(manifest.dependencies, undefined);
});

test("invariant 21: broker code imports only node built-ins, its own files and contract", () => {
  const src = new URL("src/", root);
  const files = readdirSync(src, { recursive: true, encoding: "utf8" }).filter((file) => file.endsWith(".ts"));
  assert.notEqual(files.length, 0);
  for (const file of files) {
    const code = readFileSync(new URL(file, src), "utf8");
    // Every import is a static "import … from": the two forms the scan below would not see are refused outright.
    assert.doesNotMatch(code, /\bimport\s*\(|\brequire\s*\(|^import\s*"/m, file);
    for (const [statement, from = ""] of code.matchAll(/^import\s[^;]*?\sfrom\s+"([^"]+)";/gms)) {
      if (from.startsWith("./") || from.startsWith("node:")) continue;
      // contract is types, plus the behaviour-free constants and name rules in names.ts.
      const allowed = statement.startsWith("import type ") ? from.startsWith(CONTRACT) : from === `${CONTRACT}names`;
      assert.ok(allowed, `${file}: ${statement}`);
    }
  }
});
