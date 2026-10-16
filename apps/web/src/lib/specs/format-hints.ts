/**
 * Format hints for a Living Spec draft (living-specs spec R-48, AC-36): a
 * numbered flow with no diagram, or parallel list lines with no table, earns a
 * one-line suggestion in the create_draft / revise reply. Pure and advisory:
 * it never refuses a write and never changes the body.
 */

export type FormatHintKind = 'diagram' | 'table';
export interface FormatHint {
  kind: FormatHintKind;
  /** 1-based line where the run that earned the hint starts. */
  line: number;
  message: string;
}

const MIN_RUN = 3;
const FENCE = /^\s{0,3}(`{3,}|~{3,})\s*([^\s`]*)/;
const NUMBERED = /^\s{0,3}(\d{1,3})[.)]\s+\S/;
/** A GFM delimiter row: `| --- | :---: |`, outer pipes optional, two or more cells. */
const TABLE_DELIMITER = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/;
const BOLD_LABEL = /^\s{0,3}[-*+]\s+\*\*[^*]+?(?::\*\*|\*\*:)\s*\S/;
const SLASH_LINE = /^\s{0,3}[-*+]\s+[^:/]+?:\s*(.+)$/;

/** The shape of a list line that could be a table row, or null for any other line. */
function rowShape(line: string): string | null {
  if (BOLD_LABEL.test(line)) return 'bold';
  const m = SLASH_LINE.exec(line);
  if (!m) return null;
  const values = m[1]!.split(/\s+\/\s+/).filter((v) => v.trim());
  return values.length >= 2 ? `slash:${values.length}` : null;
}

export function formatHints(body: string): FormatHint[] {
  const lines = String(body ?? '').split(/\r?\n/);
  let fence: string | null = null;
  let hasMermaid = false;
  let hasTable = false;

  let stepRun = { start: 0, last: 0, count: 0 };
  let bestSteps = { start: 0, count: 0 };
  let rowRun = { start: 0, shape: '', count: 0 };
  let bestRows = { start: 0, count: 0 };

  const endSteps = () => { if (stepRun.count > bestSteps.count) bestSteps = { start: stepRun.start, count: stepRun.count }; stepRun = { start: 0, last: 0, count: 0 }; };
  const endRows = () => { if (rowRun.count > bestRows.count) bestRows = { start: rowRun.start, count: rowRun.count }; rowRun = { start: 0, shape: '', count: 0 }; };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const f = FENCE.exec(line);
    if (fence) {
      if (f && f[1]!.startsWith(fence[0]!) && f[1]!.length >= fence.length && !f[2]) fence = null;
      continue;
    }
    if (f) {
      fence = f[1]!;
      if (f[2]!.toLowerCase() === 'mermaid') hasMermaid = true;
      endSteps();
      endRows();
      continue;
    }
    if (TABLE_DELIMITER.test(line)) hasTable = true;

    // Numbered steps: 1, 2, 3 ... with blank or indented continuation lines between them.
    const n = NUMBERED.exec(line);
    if (n) {
      const num = Number(n[1]);
      if (stepRun.count && num === stepRun.last + 1) {
        stepRun.last = num;
        stepRun.count++;
      } else {
        endSteps();
        if (num === 1) stepRun = { start: i + 1, last: 1, count: 1 };
      }
    } else if (stepRun.count && line.trim() && !/^\s/.test(line)) {
      endSteps();
    }

    // Parallel list lines: consecutive, same shape.
    const shape = rowShape(line);
    if (shape && shape === rowRun.shape) rowRun.count++;
    else {
      endRows();
      if (shape) rowRun = { start: i + 1, shape, count: 1 };
    }
  }
  endSteps();
  endRows();

  const hints: FormatHint[] = [];
  if (!hasMermaid && bestSteps.count >= MIN_RUN) {
    hints.push({
      kind: 'diagram',
      line: bestSteps.start,
      message: `The ${bestSteps.count} numbered steps at line ${bestSteps.start} read as a flow; a \`\`\`mermaid block (flowchart or stateDiagram-v2) usually shows one better.`,
    });
  }
  if (!hasTable && bestRows.count >= MIN_RUN) {
    hints.push({
      kind: 'table',
      line: bestRows.start,
      message: `The ${bestRows.count} parallel list lines at line ${bestRows.start} compare like a table; a Markdown table usually reads better (criteria can sit in one, the R-n/AC-n id in the first column).`,
    });
  }
  return hints;
}
