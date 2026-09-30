import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import { readFileSync } from 'node:fs';
import { TASK_STATUSES, WORKER_STATUSES } from '../packages/shared/src/status';

/**
 * Ratchet on inline status-literal arrays.
 *
 * The canonical task/worker status vocabularies live in
 * `packages/shared/src/status.ts` (OPEN_TASK_STATUSES, TERMINAL_TASK_STATUSES,
 * LIVE_WORKER_STATUSES, TERMINAL_WORKER_STATUSES, ...). Inline copies drifted:
 * one counted `review` as open, one forgot `cancelled` was terminal, one forgot
 * `superseded`, one dropped `idle` from "live", two counted `paused` as live.
 *
 * This counts array literals whose every element is a task or worker status
 * (e.g. `['pending', 'assigned', 'in_progress']`) in tracked, non-test source,
 * and fails if the count goes UP. Import the shared list instead. When you
 * remove copies, lower BASELINE to the new count so the ratchet tightens.
 */
const BASELINE = 99;

const STATUS_WORDS = new Set<string>([...TASK_STATUSES, ...WORKER_STATUSES]);
const ARRAY_OF_STRINGS = /\[\s*((?:'[a-z_]+'\s*,\s*)+'[a-z_]+'\s*,?)\s*\]/g;
const EXCLUDED = /\.test\.tsx?$|__tests__\/|\/tests\/|fixture|^packages\/shared\/src\/status\.ts$/;

export function countStatusLiteralArrays(source: string): number {
  let n = 0;
  for (const m of source.matchAll(ARRAY_OF_STRINGS)) {
    const elements = [...m[1].matchAll(/'([a-z_]+)'/g)].map(x => x[1]);
    if (elements.every(e => STATUS_WORDS.has(e))) n++;
  }
  return n;
}

function trackedSources(): string[] {
  const out = spawnSync('git', ['ls-files', '--', 'apps/*.ts', 'apps/*.tsx', 'packages/*.ts', 'packages/*.tsx'], { encoding: 'utf8' });
  if (out.status !== 0) throw new Error(`git ls-files failed: ${out.stderr}`);
  return out.stdout.split('\n').filter(f => f && !EXCLUDED.test(f));
}

describe('inline status-literal arrays', () => {
  test('the matcher counts status lists and ignores other string arrays', () => {
    expect(countStatusLiteralArrays(`const a = ['pending', 'assigned', 'in_progress'];`)).toBe(1);
    expect(countStatusLiteralArrays(`inArray(workers.status, ['running', 'waiting_input'])`)).toBe(1);
    expect(countStatusLiteralArrays(`const b = ['merged', 'closed'];`)).toBe(0);
    expect(countStatusLiteralArrays(`const c = ['completed', 'merged'];`)).toBe(0);
  });

  test(`no more than ${BASELINE} copies (import from @buildd/shared instead)`, () => {
    const files = trackedSources();
    expect(files.length).toBeGreaterThan(100); // the scan saw the repo, not an empty set
    const perFile: Array<[string, number]> = [];
    let total = 0;
    for (const f of files) {
      const n = countStatusLiteralArrays(readFileSync(f, 'utf8'));
      if (n) { total += n; perFile.push([f, n]); }
    }
    if (total > BASELINE) {
      const top = perFile.sort((a, b) => b[1] - a[1]).slice(0, 15).map(([f, n]) => `  ${n}  ${f}`).join('\n');
      throw new Error(
        `${total} inline status-literal arrays, baseline ${BASELINE}. Use OPEN_TASK_STATUSES / TERMINAL_TASK_STATUSES / ` +
        `LIVE_WORKER_STATUSES / TERMINAL_WORKER_STATUSES (or the is* predicates) from @buildd/shared.\n${top}`,
      );
    }
    expect(total).toBeLessThanOrEqual(BASELINE);
  });
});
