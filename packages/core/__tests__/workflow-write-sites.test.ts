/**
 * Write-site guard for the workflow state kernel
 * (docs/specs/workflow-state-kernel.md §7.6, S14, AC-7): only
 * apps/web/src/lib/workflow/ touches the workflow_* tables and
 * trunk_incidents. Everything else reaches them through `ingestFact` /
 * `applyCommand`, so no sweep, route or reaper can assign delivery state.
 *
 * While the kernel is dark this also proves nothing outside it reads them.
 */
import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const repo = join(import.meta.dir, '../../..');
const files = Bun.spawnSync(['git', 'ls-files', '--cached', '--others', '--exclude-standard', 'apps', 'packages', 'scripts'], { cwd: repo })
  .stdout.toString()
  .split('\n')
  .filter((f) => /\.(ts|tsx)$/.test(f) && !/\.d\.ts$/.test(f));

const KERNEL_DIR = 'apps/web/src/lib/workflow/';
/** Declarations and tests that exercise the kernel itself. */
const ALLOWED = new Set([
  'packages/core/db/schema.ts',
  'packages/core/__tests__/workflow-write-sites.test.ts',
  'apps/web/tests/db/workflow-kernel.test.ts',
  'apps/web/tests/db/workflow-seam.test.ts',
]);

const TABLE_NAMES = /\b(workflow_deliveries|workflow_review_rounds|workflow_facts|workflow_transitions|workflow_effects|workflow_attempts|trunk_incidents)\b/;
const TABLE_SYMBOLS = /\b(workflowDeliveries|workflowReviewRounds|workflowFacts|workflowTransitions|workflowEffects|workflowAttempts|trunkIncidents)\b/;

function code(file: string): string {
  return readFileSync(join(repo, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

describe('workflow kernel tables have one writer', () => {
  it('scans a real tree that contains the kernel', () => {
    expect(files.length).toBeGreaterThan(500);
    expect(files).toContain(`${KERNEL_DIR}kernel.ts`);
    expect(files).toContain('packages/core/db/schema.ts');
  });

  it('no module outside apps/web/src/lib/workflow/ names a kernel table in SQL', () => {
    const offenders = files.filter((f) => !f.startsWith(KERNEL_DIR) && !ALLOWED.has(f) && TABLE_NAMES.test(code(f)));
    expect(offenders).toEqual([]);
  });

  it('no module outside apps/web/src/lib/workflow/ uses the Drizzle table objects', () => {
    const offenders = files.filter((f) => !f.startsWith(KERNEL_DIR) && !ALLOWED.has(f) && TABLE_SYMBOLS.test(code(f)));
    expect(offenders).toEqual([]);
  });

  it('the guard can fail: it sees the kernel itself', () => {
    expect(TABLE_NAMES.test(code(`${KERNEL_DIR}kernel.ts`))).toBe(true);
    expect(TABLE_SYMBOLS.test('db.update(workflowDeliveries)')).toBe(true);
  });
});
