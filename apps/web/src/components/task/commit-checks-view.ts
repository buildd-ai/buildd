/**
 * "Checks by commit" on a phone: one attempt per block, a one-line summary,
 * and the check list only when there is something to read. Pure, so the
 * collapse rules are testable without a DOM. Desktop keeps its chip grid.
 *
 *   all passed        → one row, "✓ 9 checks passed", collapsed
 *   any failed        → rows, failed then running then passed
 *   several attempts  → only the latest opens, and only if it has failures
 */
import type { CiCheckRun, PrCommitChecks } from './PrCard';

export type CheckOutcome = 'failed' | 'pending' | 'passed';

export function checkOutcome(run: CiCheckRun): CheckOutcome {
  if (run.status !== 'completed') return 'pending';
  if (run.conclusion === 'success' || run.conclusion === 'skipped' || run.conclusion === 'neutral') return 'passed';
  return 'failed';
}

const ORDER: Record<CheckOutcome, number> = { failed: 0, pending: 1, passed: 2 };

/** Failed first, then running, then passed; stable within each. */
export function sortRuns(runs: readonly CiCheckRun[]): CiCheckRun[] {
  return runs
    .map((run, i) => ({ run, i }))
    .sort((a, b) => ORDER[checkOutcome(a.run)] - ORDER[checkOutcome(b.run)] || a.i - b.i)
    .map(x => x.run);
}

export interface AttemptChecksView {
  key: string;
  /** "Attempt 1 · 69786bc" */
  heading: string;
  attempt: number;
  sha: string;
  runs: CiCheckRun[];
  failed: number;
  pending: number;
  passed: number;
  /** The one-line summary the collapsed attempt shows. */
  summary: string;
  tone: 'success' | 'error' | 'running' | 'muted';
  defaultOpen: boolean;
}

function summaryOf(failed: number, pending: number, passed: number, state: PrCommitChecks['state']): Pick<AttemptChecksView, 'summary' | 'tone'> {
  const total = failed + pending + passed;
  if (total === 0) {
    if (state === 'failed') return { summary: '✗ Checks failed', tone: 'error' };
    if (state === 'passed') return { summary: '✓ Checks passed', tone: 'success' };
    if (state === 'running') return { summary: '… Checks running', tone: 'running' };
    return { summary: 'No checks reported', tone: 'muted' };
  }
  const parts = (lead: string) => [
    lead,
    failed > 0 && !lead.includes('failed') ? `${failed} failed` : null,
    pending > 0 && !lead.includes('running') ? `${pending} running` : null,
    passed > 0 ? `${passed} passed` : null,
  ].filter(Boolean).join(' · ');
  if (failed > 0) return { summary: parts(`✗ ${failed} failed`), tone: 'error' };
  if (pending > 0) return { summary: parts(`… ${pending} running`), tone: 'running' };
  return { summary: `✓ ${passed} ${passed === 1 ? 'check' : 'checks'} passed`, tone: 'success' };
}

export function buildCommitChecksView(commits: readonly PrCommitChecks[]): AttemptChecksView[] {
  const latest = commits.length > 0 ? commits[commits.length - 1] : null;
  return commits.map(c => {
    const own = c.runs ?? [];
    // Without GitHub, the failing job is still known from the retry task.
    const fallback: CiCheckRun[] = own.length === 0 && c.failure?.job
      ? [{ name: c.failure.job, status: 'completed', conclusion: 'failure', detailsUrl: null }]
      : [];
    const runs = sortRuns([...own, ...fallback]);
    const failed = runs.filter(r => checkOutcome(r) === 'failed').length;
    const pending = runs.filter(r => checkOutcome(r) === 'pending').length;
    const passed = runs.length - failed - pending;
    const { summary, tone } = summaryOf(failed, pending, passed, c.state);
    const hasFailures = failed > 0 || c.state === 'failed';
    return {
      key: `${c.attempt}-${c.sha}`,
      heading: `Attempt ${c.attempt} · ${c.sha}`,
      attempt: c.attempt,
      sha: c.sha,
      runs,
      failed,
      pending,
      passed,
      summary,
      tone,
      defaultOpen: c === latest && hasFailures,
    };
  });
}
