/**
 * The task page's checks list (docs/specs/task-page.md): Code review, Tests
 * and Merge on the delivery's current head, each one row with its state and a
 * short result, opening in place (native <details>) to the reviewer's
 * findings, the PR's checks, or the repair attached to it. Earlier rounds sit
 * behind one disclosure, oldest first. Rows come from `deriveTaskChecks`;
 * this file only draws them.
 */
import type { ReactNode } from 'react';
import Link from 'next/link';
import MarkdownContent from '@/components/MarkdownContent';
import { reviewDetailOf, type CheckRepair, type CheckRow, type CheckState, type ReviewDetail, type ReviewFindings, type TaskChecks as TaskChecksModel } from '@/lib/task-checks';

const GLYPH: Record<CheckState, { glyph: string; cls: string; label: string }> = {
  passed: { glyph: '✓', cls: 'text-status-success', label: 'passed' },
  failed: { glyph: '✗', cls: 'text-status-error', label: 'failed' },
  running: { glyph: '◐', cls: 'text-status-info', label: 'in progress' },
  pending: { glyph: '○', cls: 'text-text-muted', label: 'waiting' },
  blocked: { glyph: '!', cls: 'text-status-warning', label: 'needs a person' },
  closed: { glyph: '✕', cls: 'text-status-error', label: 'closed' },
  skipped: { glyph: '–', cls: 'text-text-muted', label: 'not required' },
};

const taskPageHref = ({ taskId }: { taskId: string }) => `/app/tasks/${encodeURIComponent(taskId)}`;

const REPAIR_WORD: Record<CheckRepair['status'], string> = {
  queued: 'queued', running: 'fixing', completed: 'completed', failed: 'failed', ended: 'ended', cancelled: 'cancelled',
};

type Findings = Map<string, ReviewFindings>;

function RepairLine({ repair, currentTaskId }: { repair: CheckRepair; currentTaskId: string }) {
  const text = `${repair.label} · ${REPAIR_WORD[repair.status]}`;
  return (
    <p data-testid="task-check-repair" className="text-meta text-text-secondary">
      {repair.taskId && repair.taskId !== currentTaskId
        ? <Link href={taskPageHref({ taskId: repair.taskId })} className="text-accent-text hover:underline">{text} ›</Link>
        : <>{text}{repair.taskId === currentTaskId ? ' · this run' : ''}</>}
    </p>
  );
}

/**
 * The opened Code review row: which round and head the review read, then its
 * findings or a plain account of why there are none. Never a bare pointer at
 * this page ("This review run"); another task's review keeps its link.
 */
function ReviewDetailBody({ d, currentTaskId }: { d: ReviewDetail; currentTaskId: string }) {
  const { round } = d;
  return (
    <>
      <p data-testid="task-check-review-round" className="font-mono text-meta text-text-muted">
        Round {round.round} · head {round.headSha}{round.carried ? ' · carried to the current head after a branch update' : ''}
      </p>
      {d.kind === 'findings'
        ? <div data-testid="task-check-findings" className="text-body [overflow-wrap:anywhere]"><MarkdownContent content={d.prose} /></div>
        : (
          <p data-testid="task-check-review-state" data-kind={d.kind} className={`text-body ${d.kind === 'unavailable' || d.kind === 'run-failed' ? 'text-status-error' : 'text-text-secondary'}`}>
            {d.text}
          </p>
        )}
      {d.kind === 'unavailable' && (
        // A full reload re-reads the findings; the page has no client fetch of its own.
        <a href={taskPageHref({ taskId: currentTaskId })} data-testid="task-check-review-retry" className="inline-flex min-h-11 items-center text-meta text-accent-text hover:underline">Try again</a>
      )}
      {d.linkTaskId && (
        <Link href={taskPageHref({ taskId: d.linkTaskId })} className="inline-flex min-h-11 items-center text-meta text-accent-text hover:underline">Open review run ›</Link>
      )}
    </>
  );
}

function RowHead({ row }: { row: Pick<CheckRow, 'name' | 'state' | 'result'> }) {
  const g = GLYPH[row.state];
  return (
    <>
      <span aria-hidden="true" className={`w-4 shrink-0 text-center ${g.cls}`}>{g.glyph}</span>
      <span className="w-28 shrink-0 font-medium text-text-primary">{row.name}</span>
      <span className="min-w-0 flex-1 text-text-secondary [overflow-wrap:anywhere]">
        <span className="sr-only">{g.label}: </span>{row.result}
      </span>
    </>
  );
}

function rowDetail(row: CheckRow, p: { findings: Findings; findingsUnavailable: boolean; prUrl: string | null; currentTaskId: string }) {
  const parts: ReactNode[] = [];
  const review = reviewDetailOf(row, p);
  if (review) parts.push(<ReviewDetailBody key="review" d={review} currentTaskId={p.currentTaskId} />);
  if (row.key === 'tests' && p.prUrl) {
    parts.push(<a key="checks" href={`${p.prUrl.replace(/\/+$/, '')}/checks`} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center text-meta text-accent-text hover:underline">View checks on GitHub ↗</a>);
  }
  if (row.repair) parts.push(<RepairLine key="repair" repair={row.repair} currentTaskId={p.currentTaskId} />);
  return parts.length ? parts : null;
}

const ROW_CLS = 'flex min-h-11 items-center gap-3 py-2 text-body';

export default function TaskChecks({
  checks,
  prNumber,
  prUrl,
  headSha,
  findings,
  findingsUnavailable = false,
  currentTaskId,
}: {
  checks: TaskChecksModel;
  prNumber: number | null;
  prUrl: string | null;
  headSha: string | null;
  findings: Findings;
  /** The reviewer rows could not be read (lib/task-delivery-context.ts). */
  findingsUnavailable?: boolean;
  currentTaskId: string;
}) {
  if (checks.current.length === 0 && checks.history.length === 0) return null;
  return (
    <section aria-label="Checks" data-testid="task-checks" className="mb-6">
      <div className="section-label flex flex-wrap items-baseline gap-x-2 border-b border-border-default pb-2">
        <span>Checks</span>
        {prNumber != null && (
          <span className="font-mono normal-case tracking-normal text-text-muted">
            {prUrl ? <a href={prUrl} target="_blank" rel="noopener noreferrer" className="hover:underline">PR #{prNumber} ↗</a> : `PR #${prNumber}`}
            {headSha ? ` · ${headSha.slice(0, 7)}` : ''}
          </span>
        )}
      </div>
      <ul className="flex flex-col">
        {checks.current.map(row => {
          const detail = rowDetail(row, { findings, findingsUnavailable, prUrl, currentTaskId });
          return (
            <li key={row.key} data-testid="task-check" data-check={row.key} data-state={row.state} className="border-b border-border-default">
              {detail ? (
                <details className="group">
                  <summary className={`${ROW_CLS} cursor-pointer list-none [&::-webkit-details-marker]:hidden`}>
                    <RowHead row={row} />
                    <span aria-hidden="true" className="shrink-0 text-text-muted transition-transform group-open:rotate-90">›</span>
                  </summary>
                  <div className="flex flex-col gap-2 pb-3 pl-7">{detail}</div>
                </details>
              ) : (
                <div className={ROW_CLS}><RowHead row={row} /></div>
              )}
            </li>
          );
        })}
      </ul>
      {checks.history.length > 0 && (
        <details data-testid="task-checks-history" className="group border-b border-border-default">
          <summary className={`${ROW_CLS} cursor-pointer list-none text-meta text-text-secondary [&::-webkit-details-marker]:hidden`}>
            <span aria-hidden="true" className="w-4 shrink-0 text-center text-text-muted transition-transform group-open:rotate-90">›</span>
            Earlier rounds ({checks.history.length})
          </summary>
          <ol className="flex flex-col gap-2 pb-3 pl-7">
            {checks.history.map(h => (
              <li key={h.round} data-testid="task-checks-round" className="text-meta">
                <span className={GLYPH[h.state].cls} aria-hidden="true">{GLYPH[h.state].glyph} </span>
                <span className="text-text-primary">Round {h.round}</span>
                <span className="text-text-secondary"> · {h.result} · <span className="font-mono">{h.headSha}</span></span>
                {h.reviewTaskId && h.reviewTaskId !== currentTaskId && (
                  <> · <Link href={taskPageHref({ taskId: h.reviewTaskId })} className="text-accent-text hover:underline">review ›</Link></>
                )}
                {h.reviewTaskId === currentTaskId && <span className="text-text-muted"> · this run</span>}
                {h.repairs.map(r => <RepairLine key={`${r.label}`} repair={r} currentTaskId={currentTaskId} />)}
              </li>
            ))}
          </ol>
        </details>
      )}
    </section>
  );
}
