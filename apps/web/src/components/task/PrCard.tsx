import { derivePrLifecycle, isPrMerged } from '@/lib/pr-presentation';
import { countOf } from '@/lib/plural';

const ExternalIcon = () => (
  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
    <path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
  </svg>
);

export interface CiCheckRun {
  name: string;
  conclusion: string | null;
  status: string;
  detailsUrl: string | null;
}

/** One step of "How it landed" (see tasks/[id]/pr-lineage.ts). */
export interface PrLineageStep {
  kind: 'attempt' | 'ci_failed' | 'retry' | 'ci_running' | 'ci_green' | 'merged';
  n?: number;
  title: string;
  sub: string;
  at: string | null;
}

/** One commit's CI outcome, with the failure the retry was handed. */
export interface PrCommitChecks {
  attempt: number;
  sha: string;
  /** Full ref, for fetching this commit's check runs. */
  ref?: string;
  state: 'failed' | 'passed' | 'running' | 'unknown';
  failure: { job?: string; test?: string; excerpt?: string } | null;
  /** What the next attempt did about it, in its own words. */
  fix?: string | null;
  /** Check runs on this commit, when GitHub answered. */
  runs?: CiCheckRun[] | null;
}

export interface PrOutcome {
  repoLabel?: string | null;
  summary?: string | null;
  totals: { add: number; rem: number; files: number; commits: number; attempts: number; claimToMerge: string | null };
  attempts: Array<{ add: number; rem: number; files: number; running?: boolean }>;
  lineage: PrLineageStep[];
  commits: PrCommitChecks[];
}

export interface PrCardProps {
  prUrl: string;
  prNumber: number | null;
  prLifecycleStatus?: string | null;
  linesAdded?: number | null;
  linesRemoved?: number | null;
  filesChanged?: number | null;
  /** Detailed CI check runs — shown on task detail page (AC-4). */
  ciChecks?: {
    total: number;
    passed: number;
    failed: number;
    pending: number;
    runs: CiCheckRun[];
  } | null;
  /** Review summary — shown on task detail page (AC-4). */
  reviews?: {
    approved: number;
    changesRequested: number;
    pending: number;
  } | null;
  /** Mergeable state from GitHub — shown on task detail page (AC-4). */
  mergeable?: boolean | null;
  mergeableState?: string | null;
  /**
   * Task page only: the outcome view — big numbers, the diff split by attempt,
   * "How it landed" and checks per commit. Absent everywhere else (the
   * mission drawer keeps the compact card).
   */
  outcome?: PrOutcome | null;
}

const isFailingRun = (r: CiCheckRun) =>
  r.status === 'completed' && (r.conclusion === 'failure' || r.conclusion === 'timed_out' || r.conclusion === 'cancelled' || r.conclusion === 'action_required');
const isPassingRun = (r: CiCheckRun) =>
  r.status === 'completed' && (r.conclusion === 'success' || r.conclusion === 'skipped' || r.conclusion === 'neutral');

/**
 * Canonical pull-request card. One renderer for every surface that shows a
 * worker's PR — task detail page, mission task drawer, timeline. Lifecycle
 * label/colour and the "View PR" vs "Review & merge" verb come from the shared
 * pr-presentation layer so the PR reads identically everywhere.
 *
 * When `ciChecks` is provided (task detail page), the card also shows individual
 * failing check names linked to their GitHub run pages (AC-4).
 */
export default function PrCard(props: PrCardProps) {
  if (props.outcome) return <PrOutcomeCard {...props} outcome={props.outcome} />;
  const {
    prUrl,
    prNumber,
    prLifecycleStatus,
    linesAdded,
    linesRemoved,
    filesChanged,
    ciChecks,
    reviews,
    mergeable,
    mergeableState,
  } = props;
  const lifecycle = derivePrLifecycle(prLifecycleStatus, true);
  const hasDiff = linesAdded != null || linesRemoved != null || (filesChanged != null && filesChanged > 0);

  const isMerged = isPrMerged(prLifecycleStatus);
  const failingRuns = ciChecks?.runs.filter(isFailingRun) ?? [];

  const reviewLine = reviews && (reviews.approved + reviews.changesRequested + reviews.pending > 0)
    ? [
        reviews.approved > 0 ? `${reviews.approved} approved` : null,
        reviews.changesRequested > 0 ? `${countOf(reviews.changesRequested, 'change')} requested` : null,
        reviews.pending > 0 ? `${reviews.pending} pending` : null,
      ].filter(Boolean).join(' · ')
    : 'no reviews';

  return (
    <div className="border border-border-default p-4 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[12px] font-semibold text-text-primary">Pull request</span>
        {lifecycle && (
          <span className={`inline-flex items-center px-1.5 py-0.5 text-[11px] md:text-[10px] font-medium ${lifecycle.cls}`}>
            {lifecycle.label}
          </span>
        )}
      </div>

      {hasDiff && (
        <div className="flex items-center gap-3 text-[12px] tabular-nums">
          {linesAdded != null && <span className="text-status-success">+{linesAdded}</span>}
          {linesRemoved != null && <span className="text-status-error">&minus;{linesRemoved}</span>}
          {filesChanged != null && filesChanged > 0 && (
            <span className="text-text-muted">{filesChanged} file{filesChanged !== 1 ? 's' : ''}</span>
          )}
        </div>
      )}

      {/* CI check summary — shown when detailed check data is available */}
      {ciChecks && ciChecks.total > 0 && (
        <div className="space-y-1.5">
          <div className="flex items-center gap-2 text-[12px]">
            <span className="text-text-muted">CI:</span>
            {ciChecks.failed > 0 && (
              <span className="text-status-error font-medium">{ciChecks.failed} failed</span>
            )}
            {ciChecks.pending > 0 && (
              <span className="text-status-info">{ciChecks.pending} running</span>
            )}
            {ciChecks.passed > 0 && (
              <span className="text-text-muted">{ciChecks.passed} passed</span>
            )}
            <span className="text-text-muted">/ {ciChecks.total} total</span>
          </div>

          {/* Failing check names with links (AC-4) */}
          {failingRuns.length > 0 && (
            <div className="space-y-1 pl-2 border-l-2 border-status-error/30">
              {failingRuns.map((run, i) => (
                <div key={i} className="flex items-center gap-1.5 text-[11px]">
                  <span className="text-status-error">✗</span>
                  {run.detailsUrl ? (
                    <a
                      href={run.detailsUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-status-error font-mono hover:underline"
                    >
                      {run.name}
                    </a>
                  ) : (
                    <span className="text-status-error font-mono">{run.name}</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Mergeable state */}
      {!isMerged && mergeable !== undefined && mergeable !== null && (
        <div className="text-[12px] text-text-muted">
          {mergeable
            ? <span className="text-status-success">Mergeable</span>
            : <span className="text-status-warning">
                {mergeableState === 'dirty' ? 'Merge conflicts' : 'Not mergeable'}
              </span>
          }
        </div>
      )}

      {/* Review state */}
      {ciChecks && (
        <div className="text-[12px] text-text-muted">
          Reviews: {reviewLine}
        </div>
      )}

      <a
        href={prUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-medium bg-surface-3 text-text-primary hover:bg-card-hover transition-colors"
      >
        {isMerged ? 'View PR' : 'Review & merge'} #{prNumber} on GitHub
        <ExternalIcon />
      </a>
    </div>
  );
}

function BigNumber({ value, label, tone }: { value: React.ReactNode; label: string; tone?: 'add' | 'rem' }) {
  return (
    <div className="min-w-0">
      <div className={`font-mono text-[28px] md:text-[40px] font-semibold leading-none tracking-[-1px] tabular-nums ${tone === 'add' ? 'text-status-success' : tone === 'rem' ? 'text-status-error' : 'text-text-primary'}`}>
        {value}
      </div>
      <div className="mt-2 font-mono text-[11px] uppercase tracking-[2px] text-text-muted">{label}</div>
    </div>
  );
}

const STEP_STYLE: Record<PrLineageStep['kind'], { box: string; glyph: (n?: number) => string; title: string }> = {
  attempt: { box: 'bg-text-primary text-surface-1 border-text-primary', glyph: n => String(n ?? ''), title: 'text-text-primary' },
  ci_failed: { box: 'bg-status-error text-surface-1 border-status-error', glyph: () => '✗', title: 'text-status-error' },
  retry: { box: 'bg-card text-text-primary border-dashed border-text-secondary', glyph: () => '↻', title: 'text-text-primary' },
  ci_running: { box: 'bg-status-info text-surface-1 border-status-info animate-status-pulse', glyph: () => '…', title: 'text-status-info' },
  ci_green: { box: 'bg-status-success text-surface-1 border-status-success', glyph: () => '✓', title: 'text-status-success' },
  merged: { box: 'bg-status-success text-surface-1 border-status-success', glyph: () => '↳', title: 'text-status-success' },
};

export function LineageChain({ steps }: { steps: PrLineageStep[] }) {
  return (
    <ol data-testid="pr-lineage" className="grid gap-y-5 grid-cols-2 sm:grid-cols-3 md:[grid-template-columns:repeat(var(--steps),minmax(0,1fr))]" style={{ ['--steps' as string]: steps.length }}>
      {steps.map((s, i) => {
        const st = STEP_STYLE[s.kind];
        return (
          <li key={`${s.kind}-${i}`} data-kind={s.kind} className="relative pr-4">
            {i < steps.length - 1 && <span aria-hidden="true" className="hidden md:block absolute top-[11px] left-[26px] right-0 h-[2px] bg-border-strong" />}
            <span className={`relative grid place-items-center w-6 h-6 border-2 font-mono text-[12px] font-bold ${st.box}`}>{st.glyph(s.n)}</span>
            <div className={`mt-3 font-mono text-[11px] uppercase tracking-[2px] font-semibold ${st.title}`}>{s.title}</div>
            <div className="mt-1 text-[13px] leading-snug text-text-secondary [overflow-wrap:anywhere]">{s.sub}</div>
            {s.at && <div className="mt-1 font-mono text-[12px] text-text-muted tabular-nums">{s.at}</div>}
          </li>
        );
      })}
    </ol>
  );
}

function CheckPill({ run }: { run: CiCheckRun }) {
  const fail = isFailingRun(run);
  const pass = isPassingRun(run);
  const cls = fail
    ? 'border-status-error text-status-error bg-status-error/10 font-semibold'
    : pass
      ? 'border-status-success text-status-success'
      : 'border-status-info text-status-info';
  const body = (
    <>
      <span aria-hidden="true">{fail ? '✗' : pass ? '✓' : '…'}</span> {run.name}
    </>
  );
  return run.detailsUrl ? (
    <a href={run.detailsUrl} target="_blank" rel="noopener noreferrer" className={`inline-flex items-center gap-1 px-2.5 min-h-8 border font-mono text-[12px] hover:underline ${cls}`}>{body}</a>
  ) : (
    <span className={`inline-flex items-center gap-1 px-2.5 min-h-8 border font-mono text-[12px] ${cls}`}>{body}</span>
  );
}

export function CommitChecksList({ commits }: { commits: PrCommitChecks[] }) {
  return (
    <div data-testid="pr-commit-checks">
      {commits.map(c => {
        const runs = c.runs ?? [];
        const failed = runs.filter(isFailingRun).length;
        const verdict = c.state === 'failed'
          ? (failed > 0 ? `${failed} failed` : 'failed')
          : c.state === 'passed' ? 'all passed' : c.state === 'running' ? 'running' : '';
        // Without GitHub, the failing job is still known from the retry task.
        const fallback: CiCheckRun[] = runs.length === 0 && c.failure?.job
          ? [{ name: c.failure.job, status: 'completed', conclusion: 'failure', detailsUrl: null }]
          : [];
        return (
          <div key={`${c.attempt}-${c.sha}`} data-testid="pr-commit-row" data-state={c.state} className="border-b border-border-default last:border-b-0 py-4">
            <div className="flex flex-wrap md:flex-nowrap items-start gap-x-6 gap-y-2">
              <div className="w-40 shrink-0">
                <div className="font-mono text-[11px] uppercase tracking-[2px] text-text-muted">Attempt {c.attempt}</div>
                <code className="font-mono text-[14px] text-text-primary">{c.sha}</code>
              </div>
              <div className="flex-1 min-w-0 flex flex-wrap gap-2">
                {[...runs, ...fallback].map((r, i) => <CheckPill key={`${r.name}-${i}`} run={r} />)}
              </div>
              <span className={`shrink-0 font-mono text-[13px] ${c.state === 'failed' ? 'text-status-error' : c.state === 'passed' ? 'text-status-success' : 'text-text-muted'}`}>{verdict}</span>
            </div>
            {(c.failure?.excerpt || c.fix) && (
              <div className="mt-3 md:ml-[184px] border-l-4 border-status-error bg-surface-2 px-4 py-3 font-mono text-[12px] md:text-[13px] leading-relaxed">
                {(c.failure?.job || c.failure?.test) && (
                  <div className="text-text-muted">{[c.failure.job, c.failure.test].filter(Boolean).join(' · ')}</div>
                )}
                {c.failure?.excerpt && <div className="mt-1 text-text-primary [overflow-wrap:anywhere]">{c.failure.excerpt}</div>}
                {c.fix && <div className="mt-2 text-text-secondary [overflow-wrap:anywhere]">Fix: {c.fix}</div>}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function PrOutcomeCard({ prUrl, prNumber, prLifecycleStatus, ciChecks, mergeable, mergeableState, reviews, outcome }: PrCardProps & { outcome: PrOutcome }) {
  const lifecycle = derivePrLifecycle(prLifecycleStatus, true);
  const merged = isPrMerged(prLifecycleStatus);
  const { totals, attempts } = outcome;
  const total = attempts.reduce((s, a) => s + a.add + a.rem, 0);
  const last = attempts.length - 1;
  const reviewLine = reviews && reviews.approved + reviews.changesRequested + reviews.pending > 0
    ? [
        reviews.approved > 0 ? `${reviews.approved} approved` : null,
        reviews.changesRequested > 0 ? `${countOf(reviews.changesRequested, 'change')} requested` : null,
        reviews.pending > 0 ? `${reviews.pending} pending` : null,
      ].filter(Boolean).join(' · ')
    : null;

  return (
    <div data-testid="pr-outcome" className="space-y-8">
      <section className="bg-card border-2 border-border-strong shadow-[var(--card-shadow)] p-5 md:p-8">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <p className="font-mono text-[12px] md:text-[13px] text-text-muted [overflow-wrap:anywhere]">
              <a href={prUrl} target="_blank" rel="noopener noreferrer" data-testid="pr-outcome-number" className="text-accent-text font-semibold hover:underline">#{prNumber}</a>
              {outcome.repoLabel && <> · {outcome.repoLabel}</>}
              {lifecycle && <> · <span className={merged ? 'text-status-success' : ''}>{lifecycle.label.toLowerCase()}</span></>}
              {!merged && mergeable === false && <> · <span className="text-status-warning">{mergeableState === 'dirty' ? 'merge conflicts' : 'not mergeable'}</span></>}
              {reviewLine && <> · {reviewLine}</>}
            </p>
            {outcome.summary && <p className="mt-2 text-[14px] md:text-[16px] text-text-primary leading-relaxed [overflow-wrap:anywhere]">{outcome.summary}</p>}
          </div>
          <a
            href={prUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="shrink-0 inline-flex items-center gap-1.5 min-h-11 px-4 border-2 border-border-strong text-[13px] font-medium text-text-primary hover:bg-surface-3"
          >
            {merged ? 'Open PR' : 'Review & merge'} <ExternalIcon />
          </a>
        </div>

        <div className="mt-6 flex flex-wrap items-end gap-x-8 md:gap-x-12 gap-y-5">
          <BigNumber value={`+${totals.add}`} label="Added" tone="add" />
          <BigNumber value={`−${totals.rem}`} label="Removed" tone="rem" />
          <BigNumber value={totals.files} label="Files" />
          <BigNumber value={totals.commits} label={totals.commits === 1 ? 'Commit' : 'Commits'} />
          {totals.attempts > 1 && <BigNumber value={totals.attempts} label="Attempts" />}
          {totals.claimToMerge && (
            <div className="ml-auto text-right">
              <BigNumber value={totals.claimToMerge} label="Claim → merge" />
            </div>
          )}
        </div>

        {total > 0 && (
          <div className="mt-6">
            <div data-testid="pr-diff-bar" className="flex h-[18px] gap-[3px]">
              {attempts.flatMap((a, i) => [
                a.add > 0 && <span key={`a${i}`} className={`bg-status-success ${i > 0 ? 'opacity-70' : ''}`} style={{ flexGrow: a.add, flexBasis: 0 }} title={`Attempt ${i + 1}: +${a.add}`} />,
                a.rem > 0 && <span key={`r${i}`} className={`bg-status-error ${i > 0 ? 'opacity-70' : ''}`} style={{ flexGrow: a.rem, flexBasis: 0, minWidth: 4 }} title={`Attempt ${i + 1}: −${a.rem}`} />,
              ])}
            </div>
            <div className="mt-2 flex flex-wrap justify-between gap-2 font-mono text-[12px] text-text-muted tabular-nums">
              {attempts.map((a, i) => (
                <span key={i} className={i === last && i > 0 ? 'text-right' : ''}>
                  Attempt {i + 1}{i > 0 ? ' (fix)' : ''} · {a.running && a.add + a.rem === 0 ? 'in progress' : `+${a.add} −${a.rem} · ${a.files} file${a.files === 1 ? '' : 's'}`}
                </span>
              ))}
            </div>
          </div>
        )}
      </section>

      {outcome.lineage.length > 0 && (
        <section>
          <div className="flex items-baseline justify-between border-b border-border-default pb-2 mb-5">
            <span className="section-label">How it landed</span>
          </div>
          <LineageChain steps={outcome.lineage} />
        </section>
      )}

      {outcome.commits.length > 0 && (
        <section>
          <div className="flex items-baseline justify-between border-b border-border-default pb-2 mb-1">
            <span className="section-label">Checks by commit</span>
            <span className="hidden sm:flex items-center gap-3 font-mono text-[11px] text-text-muted">
              <span className="inline-flex items-center gap-1.5"><span className="w-[9px] h-[9px] bg-status-success" />pass</span>
              <span className="inline-flex items-center gap-1.5"><span className="w-[9px] h-[9px] bg-status-error" />fail</span>
            </span>
          </div>
          <CommitChecksList
            commits={outcome.commits.map(c => (c.runs || !ciChecks || c.attempt !== outcome.commits[outcome.commits.length - 1].attempt ? c : { ...c, runs: ciChecks.runs }))}
          />
        </section>
      )}
    </div>
  );
}
