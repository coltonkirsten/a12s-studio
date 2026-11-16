import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

const root = new URL("../", import.meta.url);

test("the broker has no runtime dependencies", () => {
  const manifest = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
  assert.equal(manifest.dependencies, undefined);
});

test("broker code imports no other package except contract types", () => {
  const src = new URL("src/", root);
  const files = existsSync(src) ? readdirSync(src, { recursive: true, encoding: "utf8" }) : [];
  for (const file of files.filter((f) => f.endsWith(".ts"))) {
    const code = readFileSync(new URL(file, src), "utf8");
    for (const [statement, , from = ""] of code.matchAll(/^import\s+(.*?)\s+from\s+"([^"]+)";/gms)) {
      if (from.startsWith(".") || from.startsWith("node:")) continue;
      assert.ok(
        statement.startsWith("import type") && from.startsWith("@a12s-studio/contract/"),
        `${file}: ${statement}`,
      );
    }
  }
});
