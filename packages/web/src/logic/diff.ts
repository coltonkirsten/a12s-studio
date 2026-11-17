export type DiffRow = { kind: "same" | "added" | "removed"; text: string } | { kind: "skip"; count: number };
type Line = Extract<DiffRow, { text: string }>;

// Unchanged lines shown on each side of a change; longer unchanged runs fold into one "skip" row.
const CONTEXT = 2;
// Above this many cells the comparison table would be large for a browser tab, so the middle shows as replaced.
const MAX_CELLS = 4_000_000;

const lines = (text: string) => (text === "" ? [] : text.split("\n"));
const row = (kind: Line["kind"]) => (text: string) => ({ kind, text });

// The longest common subsequence of a and b, walked from the front; a removal is shown before the addition that
// replaces it.
function middle(a: string[], b: string[]): Line[] {
  if (a.length * b.length > MAX_CELLS) return [...a.map(row("removed")), ...b.map(row("added"))];
  const width = b.length + 1;
  const common = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      common[i * width + j] =
        a[i] === b[j]
          ? (common[(i + 1) * width + j + 1] ?? 0) + 1
          : Math.max(common[(i + 1) * width + j] ?? 0, common[i * width + j + 1] ?? 0);
    }
  }
  const out: Line[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    const left = a[i];
    const right = b[j];
    if (left !== undefined && left === right) {
      out.push({ kind: "same", text: left });
      i++;
      j++;
    } else if (
      left !== undefined &&
      (right === undefined || (common[(i + 1) * width + j] ?? 0) >= (common[i * width + j + 1] ?? 0))
    ) {
      out.push({ kind: "removed", text: left });
      i++;
    } else {
      out.push({ kind: "added", text: right ?? "" });
      j++;
    }
  }
  return out;
}

// Keeps CONTEXT unchanged lines next to each change and folds the rest of an unchanged run, when that hides more
// than one line.
function fold(all: Line[]): DiffRow[] {
  const out: DiffRow[] = [];
  let start = 0;
  while (start < all.length) {
    if (all[start]?.kind !== "same") {
      out.push(all[start] as Line);
      start++;
      continue;
    }
    let end = start;
    while (all[end]?.kind === "same") end++;
    const run = all.slice(start, end);
    const head = start === 0 ? 0 : CONTEXT;
    const tail = end === all.length ? 0 : CONTEXT;
    const hidden = run.length - head - tail;
    if (hidden > 1) out.push(...run.slice(0, head), { kind: "skip", count: hidden }, ...run.slice(run.length - tail));
    else out.push(...run);
    start = end;
  }
  return out;
}

/** The line differences from one text to the next, with long unchanged stretches folded. */
export function diff(before: string, after: string): DiffRow[] {
  const a = lines(before);
  const b = lines(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  return fold([
    ...a.slice(0, start).map(row("same")),
    ...middle(a.slice(start, a.length - end), b.slice(start, b.length - end)),
    ...a.slice(a.length - end).map(row("same")),
  ]);
}

/** How many lines a difference adds and removes. */
export function changes(rows: DiffRow[]): { added: number; removed: number } {
  return {
    added: rows.filter((r) => r.kind === "added").length,
    removed: rows.filter((r) => r.kind === "removed").length,
  };
}
