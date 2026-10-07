/**
 * `stamp_pr_rows` (docs/specs/workflow-state-kernel.md §10.2, T17/T18): the
 * kernel's projection of a merge or close onto the PR fact cache. Every worker
 * row carrying the PR gets the fact through `recordPrFact`, so the kernel and
 * the webhook writing the same fact converge (terminal wins, first instant
 * kept) instead of racing. The merge instant is the delivery's `merged_at`,
 * which T17 took from GitHub's live read.
 *
 * Ungated (§10.4): a merge stays a merge whatever the delivery did since; a
 * close is projected only while the delivery still reads closed, so a stale
 * close effect never closes a reopened PR's rows.
 */
import { recordPrFact } from '@buildd/core/pr-facts';
import type { EffectHandler, EffectHandlers } from './effects';
import { loadView, type Exec } from './kernel';

export function prUrlOf(repoFullName: string, prNumber: number): string {
  return `https://github.com/${repoFullName}/pull/${prNumber}`;
}

export function stampPrRowsHandler(deps: { exec?: Exec; record?: typeof recordPrFact } = {}): EffectHandler {
  const record = deps.record ?? recordPrFact;
  return async (e) => {
    const d = (await loadView({ deliveryId: e.deliveryId }, deps.exec)).delivery;
    if (!d?.repoFullName || d.prNumber == null) return { outcome: 'skipped:no_pr' };
    const target = { prUrl: prUrlOf(d.repoFullName, d.prNumber), prNumber: d.prNumber };
    if (d.state === 'MERGED' || d.mergedAt) {
      const rows = await record(target, { kind: 'merged', mergedAt: d.mergedAt ?? new Date() });
      return { outcome: `ok:merged_${rows.length}` };
    }
    if (d.state === 'CLOSED_UNMERGED') {
      const rows = await record(target, { kind: 'closed' });
      return { outcome: `ok:closed_${rows.length}` };
    }
    return { outcome: `skipped:state_${d.state}` };
  };
}

/** The fact-cache projection added to the composition root's handlers. */
export function withPrFactEffects(base: EffectHandlers): EffectHandlers {
  return { ...base, stamp_pr_rows: stampPrRowsHandler() };
}
