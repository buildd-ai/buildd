/**
 * Guard: every place that writes a worker's prUrl / prNumber is a reviewed one.
 *
 * Those two columns are a task's deliverable — they satisfy pr_required, feed
 * mission completion, and on the `branch_merge` release strategy name the PR
 * the release executor merges. An agent run may record only a PR its task
 * owns (pr-ownership.ts), and that holds only if no door writes them without
 * asking. Six agent-reachable doors did, two with no check at all.
 *
 * So the write sites are pinned per file. Adding one fails here; the fix is
 * to put it behind `verifyPrOwnership` / `verifyReportedWorkerPr` (or, for a
 * server-side writer that no agent drives, say so below) and update the pin.
 *
 *   github/pr/route.ts  adoption, sibling dedup, dedup-by-head, fresh create
 *                       (ownership checked before each; sibling dedup is the
 *                       same task by construction)
 *   workers/[id]        completion auto-detect (own branch by construction),
 *                       the pr_required fallback, and the self-report
 *                       (both through verifyReportedWorkerPr)
 *   mission-pr.ts       the mission's own integration PR (server-side)
 */
import { describe, it, expect } from 'bun:test';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';

const REPO = join(import.meta.dir, '../../../../..');

const PINNED: Record<string, number> = {
  'apps/web/src/app/api/github/pr/route.ts': 4,
  'apps/web/src/app/api/workers/[id]/route.ts': 3,
  'apps/web/src/lib/mission-pr.ts': 2,
};

/** `db.update(workers)…set({ … prUrl / prNumber … })` up to its `.where(`, plus `updates.prUrl =` assignments. */
function writeSites(src: string): number {
  let n = 0;
  for (const m of src.matchAll(/\.update\(workers\)/g)) {
    const seg = src.slice(m.index! + m[0].length, m.index! + m[0].length + 1500);
    const end = seg.indexOf('.where(');
    if (/\bpr(Url|Number)\s*[:,]/.test(end > 0 ? seg.slice(0, end) : seg)) n++;
  }
  // The self-report builds its update object field by field; count the block once.
  if (/\bupdates\.prUrl\s*=/.test(src)) n++;
  return n;
}

function sources(): string[] {
  return execFileSync('git', ['ls-files', 'apps/web/src', 'packages/core'], { cwd: REPO, encoding: 'utf8' })
    .split('\n')
    .filter(f => f.endsWith('.ts') && !f.includes('.test.') && !f.includes('__tests__'));
}

describe('worker PR write sites', () => {
  it('are exactly the reviewed set', () => {
    const found: Record<string, number> = {};
    for (const f of sources()) {
      const n = writeSites(readFileSync(join(REPO, f), 'utf8'));
      if (n > 0) found[f] = n;
    }
    expect(found).toEqual(PINNED);
  });

  it('can fail: counts an unguarded write', () => {
    expect(writeSites('await db.update(workers).set({ prUrl: u, prNumber: n }).where(eq(workers.id, id));')).toBe(1);
    expect(writeSites('await db.update(workers).set({ updatedAt: now }).where(eq(workers.id, id));')).toBe(0);
  });
});
