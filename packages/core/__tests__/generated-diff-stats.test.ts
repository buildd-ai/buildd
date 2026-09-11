/**
 * Unit test: splitDiffStats / formatDiffStats (packages/shared/src/generated-paths.ts)
 *
 * Fixture is PR #2297's real file list: a heartbeat fix plus a one-column
 * migration. Its GitHub-reported diff was 16 files / +11019/-13 — a number
 * that, read without context, looks like an enormous change. All but 355
 * additions come from the Drizzle snapshot + journal every migration emits.
 * A prior PR in this repo (#2259) was closed and fully re-implemented because
 * this bulk was never separated from the real diff. This test pins the split
 * so that regression can't happen silently.
 */

import { describe, test, expect } from 'bun:test';
import { splitDiffStats, formatDiffStats, isGeneratedPath, type DiffFileStat } from '@buildd/shared';

const PR_2297_FILES: DiffFileStat[] = [
  { filename: 'apps/runner/__tests__/unit/buildd-heartbeat-runner-version.test.ts', additions: 86, deletions: 0 },
  { filename: 'apps/runner/__tests__/unit/worker-manager-state.test.ts', additions: 11, deletions: 0 },
  { filename: 'apps/runner/src/buildd.ts', additions: 10, deletions: 0 },
  { filename: 'apps/runner/src/index.ts', additions: 1, deletions: 9 },
  { filename: 'apps/runner/src/updater.ts', additions: 11, deletions: 0 },
  { filename: 'apps/runner/src/workers.ts', additions: 2, deletions: 1 },
  { filename: 'apps/web/src/app/api/workers/active/route.test.ts', additions: 72, deletions: 0 },
  { filename: 'apps/web/src/app/api/workers/active/route.ts', additions: 2, deletions: 0 },
  { filename: 'apps/web/src/app/api/workers/heartbeat/route.test.ts', additions: 120, deletions: 0 },
  { filename: 'apps/web/src/app/api/workers/heartbeat/route.ts', additions: 6, deletions: 0 },
  { filename: 'docs/specs/INDEX.md', additions: 1, deletions: 1 },
  { filename: 'docs/specs/runner-liveness.md', additions: 26, deletions: 2 },
  { filename: 'packages/core/db/schema.ts', additions: 5, deletions: 0 },
  { filename: 'packages/core/drizzle/0157_noisy_marauders.sql', additions: 2, deletions: 0 },
  { filename: 'packages/core/drizzle/meta/0157_snapshot.json', additions: 10657, deletions: 0 },
  { filename: 'packages/core/drizzle/meta/_journal.json', additions: 7, deletions: 0 },
];

describe('splitDiffStats — PR #2297 fixture', () => {
  test('before: raw GitHub totals are 16 files / +11019/-13', () => {
    const totalFiles = PR_2297_FILES.length;
    const totalAdded = PR_2297_FILES.reduce((s, f) => s + f.additions, 0);
    const totalRemoved = PR_2297_FILES.reduce((s, f) => s + f.deletions, 0);
    expect(totalFiles).toBe(16);
    expect(totalAdded).toBe(11019);
    expect(totalRemoved).toBe(13);
  });

  test('after: splits into 14 reviewable files (+355/-13) and 2 generated files (+10664/-0)', () => {
    const split = splitDiffStats(PR_2297_FILES);
    expect(split.reviewable).toEqual({ files: 14, additions: 355, deletions: 13 });
    expect(split.generated).toEqual({ files: 2, additions: 10664, deletions: 0 });
  });

  test('the migration snapshot and journal are the only generated files', () => {
    const generatedNames = PR_2297_FILES.filter((f) => isGeneratedPath(f.filename)).map((f) => f.filename);
    expect(generatedNames).toEqual([
      'packages/core/drizzle/meta/0157_snapshot.json',
      'packages/core/drizzle/meta/_journal.json',
    ]);
  });

  test('the migration .sql itself is never classified as generated', () => {
    expect(isGeneratedPath('packages/core/drizzle/0157_noisy_marauders.sql')).toBe(false);
  });

  test('formatDiffStats keeps the generated bulk visible instead of hiding it', () => {
    const summary = formatDiffStats(splitDiffStats(PR_2297_FILES));
    expect(summary).toBe('+355/-13 reviewable (+10664 generated)');
  });

  test('formatDiffStats omits the generated clause when nothing was excluded', () => {
    const summary = formatDiffStats(splitDiffStats([{ filename: 'apps/web/src/lib/foo.ts', additions: 2, deletions: 1 }]));
    expect(summary).toBe('+2/-1 reviewable');
  });
});
