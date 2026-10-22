import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

/**
 * No raw status enum rendered as JSX text.
 *
 * A task or worker status reaches the page through `statusPill` /
 * `StatusPill` (apps/web/src/components/ui/states.ts), which turns
 * `in_progress` into "Running" and `waiting_input` into "Waiting for your
 * answer". Rendering `{task.status}` shows the enum itself
 * (docs/design/design-system.md §5 rule 17: members never read a raw status
 * enum). This parses every tracked web .tsx file and fails on a JSX child
 * whose value is a `.status` property or a `taskStatus`/`workerStatus` variable, directly or as
 * a branch of `?:`, `??` or `||`. Attributes (`status={task.status}`) and calls
 * (`{statusPill(t.status).label}`) are fine.
 *
 * ALLOWED lists the few renders of a different enum that has no projection
 * yet, each with why. Do not add a task or worker status here.
 */
const ALLOWED: Record<string, string> = {
  // Operator page (Health › Operator): an experiment's own lifecycle word.
  'apps/web/src/app/app/(protected)/health/ExperimentsSection.tsx': 'experiment status, operator-only page',
  // A memory backfill job's state (queued/running/done/error), not a task.
  'apps/web/src/app/app/(protected)/workspaces/[id]/memory/KnowledgeHealthSection.tsx': 'knowledge job status',
  // An outcome spec's conformance word, already a display word.
  'apps/web/src/app/app/(protected)/missions/[id]/MissionChecks.tsx': 'spec conformance word',
};

/** A property with one of these names, or a variable named for a task or worker status. */
const STATUS_PROPS = new Set(['status', 'taskStatus', 'workerStatus']);
const STATUS_VARS = new Set(['taskStatus', 'workerStatus']);

function isRawStatus(e: ts.Expression): boolean {
  if (ts.isParenthesizedExpression(e)) return isRawStatus(e.expression);
  if (ts.isNonNullExpression(e)) return isRawStatus(e.expression);
  if (ts.isPropertyAccessExpression(e)) return STATUS_PROPS.has(e.name.text);
  // A bare `status` is usually a local already holding display text, so only
  // task/worker-named variables count.
  if (ts.isIdentifier(e)) return STATUS_VARS.has(e.text);
  if (ts.isConditionalExpression(e)) return isRawStatus(e.whenTrue) || isRawStatus(e.whenFalse);
  if (ts.isBinaryExpression(e)) {
    const op = e.operatorToken.kind;
    if (op === ts.SyntaxKind.QuestionQuestionToken || op === ts.SyntaxKind.BarBarToken) {
      return isRawStatus(e.left) || isRawStatus(e.right);
    }
    if (op === ts.SyntaxKind.AmpersandAmpersandToken) return isRawStatus(e.right);
  }
  return false;
}

/** Lines (1-based) where a JSX child renders a raw status. */
export function rawStatusRenders(source: string, fileName = 'file.tsx'): number[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const hits: number[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isJsxExpression(node)
      && node.expression
      && !ts.isJsxAttribute(node.parent)
      && isRawStatus(node.expression)
    ) {
      hits.push(sf.getLineAndCharacterOfPosition(node.getStart()).line + 1);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}

function trackedWebTsx(): string[] {
  const out = spawnSync('git', ['ls-files', '--', 'apps/web/src/*.tsx'], { encoding: 'utf8' });
  if (out.status !== 0) throw new Error(`git ls-files failed: ${out.stderr}`);
  return out.stdout.split('\n').filter(f => f && !/\.test\.tsx$|fixture/i.test(f));
}

describe('raw status in JSX', () => {
  test('the matcher flags a rendered status and ignores attributes and projections', () => {
    expect(rawStatusRenders(`const a = <span>{task.status}</span>;`)).toEqual([1]);
    expect(rawStatusRenders(`const a = <span>{t.status === 'waiting_input' ? 'waiting' : t.status}</span>;`)).toEqual([1]);
    expect(rawStatusRenders(`const a = <span>{w?.status ?? '-'}</span>;`)).toEqual([1]);
    expect(rawStatusRenders(`const a = <span>· {taskStatus}</span>;`)).toEqual([1]);
    expect(rawStatusRenders(`const a = <span>{status}</span>;`)).toEqual([]);
    expect(rawStatusRenders(`const a = <StatusPill status={task.status} />;`)).toEqual([]);
    expect(rawStatusRenders(`const a = <span>{statusPill(task.status).label}</span>;`)).toEqual([]);
    expect(rawStatusRenders(`const a = <span className={cls(task.status)}>{label}</span>;`)).toEqual([]);
  });

  test('no web component renders a raw status', () => {
    const files = trackedWebTsx();
    expect(files.length).toBeGreaterThan(100); // the scan saw the repo, not an empty set
    const offenders: string[] = [];
    for (const f of files) {
      if (ALLOWED[f]) continue;
      for (const line of rawStatusRenders(readFileSync(f, 'utf8'), f)) offenders.push(`${f}:${line}`);
    }
    if (offenders.length > 0) {
      throw new Error(
        `Raw status rendered in JSX. Render it through statusPill(status).label or <StatusPill status=…/> (components/ui/states.ts):\n  ${offenders.join('\n  ')}`,
      );
    }
  });

  test('every allowed file still exists and still needs its exception', () => {
    for (const f of Object.keys(ALLOWED)) {
      expect(rawStatusRenders(readFileSync(f, 'utf8'), f).length).toBeGreaterThan(0);
    }
  });
});
