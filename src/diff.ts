export interface DiffLine {
  kind: "same" | "added" | "removed";
  text: string;
}

// Beyond this many comparisons, texts are shown as fully replaced to keep the work small.
const MAX_CELLS = 4_000_000;

/** Line-by-line changes from before to after, like a Git diff. */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.split(/\r?\n/);
  const b = after.split(/\r?\n/);
  if (a.length * b.length > MAX_CELLS) {
    return [
      ...a.map((text): DiffLine => ({ kind: "removed", text })),
      ...b.map((text): DiffLine => ({ kind: "added", text })),
    ];
  }
  const cols = b.length + 1;
  // common[i * cols + j] is the longest common run of lines in a[i..] and b[j..].
  const common = new Uint32Array((a.length + 1) * cols);
  const at = (i: number, j: number): number => common[i * cols + j] ?? 0;
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      common[i * cols + j] =
        a[i] === b[j]
          ? at(i + 1, j + 1) + 1
          : Math.max(at(i + 1, j), at(i, j + 1));
    }
  }
  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    const left = a[i];
    const right = b[j];
    if (left !== undefined && right !== undefined && left === right) {
      lines.push({ kind: "same", text: left });
      i += 1;
      j += 1;
    } else if (
      left !== undefined &&
      (right === undefined || at(i + 1, j) >= at(i, j + 1))
    ) {
      lines.push({ kind: "removed", text: left });
      i += 1;
    } else if (right !== undefined) {
      lines.push({ kind: "added", text: right });
      j += 1;
    }
  }
  return lines;
}
