import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { execFileSync } from 'child_process';

/**
 * The dependency gate has a shared contract module whose stated purpose is that
 * the claim route and the display layer "cannot drift" — and it drifted anyway,
 * inside a file that already imported the correct predicate.
 *
 * The task detail page decided "All dependencies resolved" with a local
 * `depTasks.every(d => d.status === 'completed')`, three lines of a re-derived
 * gate sitting a few hundred lines below a correct call to `isGateSatisfied`.
 * It was wrong in both directions: a satisfying `cancelled` dep lost the
 * checkmark, and a `completed` dep with an open PR — which the gate blocks on —
 * got one. A green checkmark on a task that cannot be claimed is the phantom
 * blocker inverted, and it is harder to notice because nothing looks broken.
 *
 * A shared module prevents drift between files. It does nothing about a second
 * copy in the same file, so that is what this asserts: any narrowing decision
 * over a dependency list goes through the predicate.
 */

const ROOT = resolve(import.meta.dir, '../../../..');

/** Tracked .ts/.tsx sources that mention a dependency task list at all. */
function candidateFiles(): string[] {
  const out = execFileSync(
    'git',
    ['grep', '-l', '-w', 'depTasks', '--', '*.ts', '*.tsx'],
    { cwd: ROOT, encoding: 'utf8' },
  );
  return out.split('\n').filter(Boolean);
}

/**
 * `every` / `filter` / `some` over a dependency list is a resolution decision.
 * `map` is rendering and is deliberately not matched.
 */
const NARROWING_CALL = /depTasks\s*\.\s*(every|filter|some)\s*\(/g;

/** The call plus enough of what follows to see the callback body. */
function callbackWindow(src: string, at: number): string {
  return src.slice(at, at + 400);
}

describe('dependency gate has one source of truth', () => {
  it('finds the files it is meant to guard', () => {
    // Without this, a rename of `depTasks` turns the whole check into a
    // green no-op over an empty file list.
    expect(candidateFiles().length).toBeGreaterThan(0);
  });

  it('routes every narrowing decision over a dependency list through isGateSatisfied', () => {
    const offenders: string[] = [];
    let calls = 0;

    for (const file of candidateFiles()) {
      const src = readFileSync(resolve(ROOT, file), 'utf8');
      for (const m of src.matchAll(NARROWING_CALL)) {
        calls++;
        if (!callbackWindow(src, m.index!).includes('isGateSatisfied')) {
          const line = src.slice(0, m.index!).split('\n').length;
          offenders.push(`${file}:${line} — depTasks.${m[1]}(...)`);
        }
      }
    }

    expect(calls, 'no narrowing call found — the pattern no longer matches anything').toBeGreaterThan(0);
    expect(
      offenders,
      'these decide dependency resolution without the shared gate predicate. ' +
        'Import isGateSatisfied from @/lib/task-presentation, or reuse a list ' +
        'already filtered by it — do not re-derive the rule.',
    ).toEqual([]);
  });
});
