import assert from "node:assert/strict";
import { test } from "node:test";
import { shortTime } from "./time.ts";

test("shortTime reads like a mail list", () => {
  const now = new Date(2026, 10, 16, 15, 0).getTime();
  const rows: [Date, string][] = [
    [new Date(2026, 10, 16, 14, 32), "14:32"],
    [new Date(2026, 10, 16, 0, 1), "0:01"],
    [new Date(2026, 10, 15, 23, 59), "Yesterday"],
    [new Date(2026, 10, 13, 9, 0), "Friday"],
    [new Date(2026, 10, 9, 9, 0), "9 Nov"],
    [new Date(2025, 11, 31, 9, 0), "31 Dec 2025"],
  ];
  for (const [at, text] of rows) assert.equal(shortTime(at.getTime(), now, "en-GB"), text, at.toString());
});
