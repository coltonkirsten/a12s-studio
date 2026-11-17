import assert from "node:assert/strict";
import { test } from "node:test";
import { budgetUsed, parseUsd, usd } from "./money.ts";

test("usd shows dollars and cents", () => {
  const rows: [number, string][] = [
    [0, "$0.00"],
    [25, "$25.00"],
    [12.5, "$12.50"],
    [0.004, "$0.00"],
    [0.005, "$0.01"],
    [1234.5, "$1,234.50"],
  ];
  for (const [amount, shown] of rows) assert.equal(usd(amount), shown, String(amount));
});

test("parseUsd reads what the owner types in a dollar field", () => {
  const rows: [string, number | null][] = [
    ["25", 25],
    [" 12.5 ", 12.5],
    ["$40", 40],
    ["$ 40.00", 40],
    ["1,200", 1200],
    ["0", 0],
    [".5", 0.5],
    ["0.25", 0.25],
    ["", null],
    ["$", null],
    ["-5", null],
    ["1.234", null],
    ["12a", null],
    ["1e3", null],
    ["Infinity", null],
    ["1,2,3.4.5", null],
  ];
  for (const [text, amount] of rows) assert.equal(parseUsd(text), amount, JSON.stringify(text));
});

test("budgetUsed is the share of today's budget spent, full at or over it", () => {
  const rows: [number, number, number][] = [
    [0, 25, 0],
    [5, 25, 0.2],
    [25, 25, 1],
    [40, 25, 1],
    [0, 0, 1],
  ];
  for (const [spent, daily, share] of rows) assert.equal(budgetUsed(spent, daily), share, `${spent} of ${daily}`);
});
