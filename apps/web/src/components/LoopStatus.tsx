import type { LoopExitCondition, LoopHistoryEntry, LoopState } from '@buildd/shared';
import { ZonedTime } from './DisplayTimezone';

type ConditionType = LoopExitCondition['type'];

/** The exit condition in words, for the history heading ("until CI passes"). */
const CONDITION_GOAL: Record<ConditionType, string> = {
  command: 'until the check passes',
  pr_checks_green: 'until CI passes',
  pr_merged: 'until the PR merges',
  structured_predicate: 'until the result matches',
};

/** One evaluation's outcome in words: [met, unmet]. */
const CONDITION_OUTCOME: Record<ConditionType, [string, string]> = {
  command: ['Check passed', 'Check failed'],
  pr_checks_green: ['CI passed', 'CI not passing'],
  pr_merged: ['PR merged', 'PR not merged'],
  structured_predicate: ['Result matched', 'Result did not match'],
};

function outcomeLabel(type: string, satisfied: boolean): string {
  const pair = CONDITION_OUTCOME[type as ConditionType];
  if (pair) return satisfied ? pair[0] : pair[1];
  return satisfied ? 'Condition met' : 'Condition unmet';
}

/**
 * The attempt number the loop chip shows. `loopIteration` counts evaluations
 * already completed (it advances once per evaluated run, the same moment a
 * Loop history row is written). While the loop is still going, the chip names
 * the attempt in progress, one past that. Once it has stopped (satisfied or
 * exhausted) there is no attempt in progress, so it is the count itself and
 * matches the number of history rows.
 */
export function loopAttemptShown(
  loopIteration: number,
  maxLoops: number,
  loopState: LoopState | null,
): number {
  const terminal = loopState === 'satisfied' || loopState === 'exhausted';
  const attempt = terminal ? Math.max(loopIteration, 1) : loopIteration + 1;
  return Math.min(attempt, maxLoops);
}

function formatDuration(evidence?: Record<string, unknown>): string | null {
  const durationMs = evidence?.durationMs;
  if (typeof durationMs !== 'number' || !Number.isFinite(durationMs)) return null;
  return durationMs < 1000 ? `${Math.round(durationMs)}ms` : `${(durationMs / 1000).toFixed(2)}s`;
}

function evidenceExcerpt(evidence?: Record<string, unknown>): string | null {
  if (!evidence) return null;
  const preferred = evidence.output ?? evidence.stderr ?? evidence.stdout;
  const raw = typeof preferred === 'string' ? preferred : JSON.stringify(evidence);
  if (!raw || raw === '{}') return null;
  return raw.length > 240 ? `${raw.slice(0, 240)}…` : raw;
}

export function LoopStatusChip({
  loopIteration,
  maxLoops,
  loopState,
  startAt,
  exitConditionType,
}: {
  loopIteration: number;
  maxLoops: number;
  loopState: LoopState | null;
  startAt?: string | null;
  exitConditionType?: string | null;
}) {
  const attempt = loopAttemptShown(loopIteration, maxLoops, loopState);
  const deferred = loopState === 'condition_unmet'
    && !!startAt
    && new Date(startAt).getTime() > Date.now();
  const terminal = loopState === 'satisfied' || loopState === 'exhausted';

  // pr_merged + condition_unmet: task is waiting for a webhook, not actively looping.
  // Show a distinct "WAITING · MERGE" chip so the task never looks stalled or dead.
  if (exitConditionType === 'pr_merged' && loopState === 'condition_unmet') {
    return (
      <span
        data-loop-status="waiting-merge"
        className="inline-flex items-center gap-1.5 px-2 py-0.5 font-mono text-[11px] md:text-[10px] font-semibold uppercase tracking-wide border text-status-info border-status-info shrink-0"
      >
        <span className="w-1.5 h-1.5 rounded-full bg-current animate-status-pulse" />
        Waiting · merge
      </span>
    );
  }

  const color = loopState === 'exhausted'
    ? 'text-status-error border-status-error bg-status-error/8'
    : loopState === 'satisfied'
      ? 'text-status-success border-status-success bg-status-success/8'
      : 'text-purple-400 border-purple-400 bg-purple-500/8';

  const fullLabel = loopState === 'exhausted'
    ? `LOOP EXHAUSTED · ${attempt}/${maxLoops}`
    : loopState === 'satisfied'
      ? `LOOP SATISFIED · ${attempt}/${maxLoops}`
      : `LOOPING · attempt ${attempt}/${maxLoops}`;

  return (
    <span
      data-loop-status={deferred ? 'deferred' : terminal ? loopState : 'active'}
      className={`inline-flex items-center gap-1.5 px-2 py-0.5 font-mono text-[11px] md:text-[10px] font-semibold uppercase tracking-wide border ${color} shrink-0`}
    >
      {!terminal && <span className="w-1.5 h-1.5 rounded-full bg-current animate-status-pulse" />}
      {loopState === 'exhausted' || loopState === 'satisfied' ? (
        fullLabel
      ) : (
        <>
          {/* Below md the chip sits shrink-0 beside the task title, so it must stay short. */}
          <span className="md:hidden" aria-hidden="true">{`LOOP ${attempt}/${maxLoops}`}</span>
          <span className="hidden md:inline" aria-hidden="true">
            {fullLabel}
            {deferred && (
              <span className="normal-case font-normal opacity-80">
                {' '}· resumes <ZonedTime value={startAt!} format="datetime-short" />
              </span>
            )}
          </span>
          <span className="sr-only">
            {fullLabel}
            {deferred && <> · resumes <ZonedTime value={startAt!} format="datetime-short" /></>}
          </span>
        </>
      )}
    </span>
  );
}

export function LoopHistory({
  entries,
  loopState,
  maxLoops,
}: {
  entries: LoopHistoryEntry[];
  loopState: LoopState | null;
  maxLoops: number;
}) {
  const latestType = entries.length > 0 ? entries[entries.length - 1].conditionType : null;
  const goal = latestType ? CONDITION_GOAL[latestType as ConditionType] ?? null : null;
  return (
    <section className="mb-6" data-testid="loop-history">
      <div className="font-mono text-[11px] md:text-[10px] uppercase tracking-[2.5px] text-text-muted pb-2 border-b border-border-default mb-4">
        Loop history
        {goal && <span className="normal-case tracking-normal"> · {goal}</span>}
      </div>
      {loopState === 'exhausted' && (
        <div className="mb-3 border border-status-error/30 bg-status-error/10 p-3 text-sm text-status-error">
          <span className="font-semibold">Condition unmet after {entries.length || maxLoops} attempts.</span>
          {' '}The task failed. Evidence from each attempt is below.
        </div>
      )}
      {entries.length === 0 ? (
        <div className="card p-4 text-sm text-text-muted">No iterations evaluated.</div>
      ) : (
        <div className="card divide-y divide-border-default">
          {entries.map((entry) => {
            const duration = formatDuration(entry.evidence);
            const excerpt = evidenceExcerpt(entry.evidence);
            return (
              <div key={`${entry.iteration}-${entry.workerId}-${entry.evaluatedAt}`} className="p-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-sm text-text-primary">Iteration {entry.iteration + 1}</span>
                      <span className={`text-xs font-medium ${entry.satisfied ? 'text-status-success' : 'text-status-error'}`}>
                        {outcomeLabel(entry.conditionType, entry.satisfied)}
                      </span>
                    </div>
                    <p className="mt-1 text-sm text-text-secondary">{entry.summary}</p>
                  </div>
                  <div className="text-right text-[11px] text-text-muted shrink-0">
                    <div><ZonedTime value={entry.evaluatedAt} /></div>
                    {duration && <div>{duration}</div>}
                  </div>
                </div>
                {excerpt && (
                  <details className="mt-2">
                    <summary className="cursor-pointer text-xs text-accent-text">Evidence excerpt</summary>
                    <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-words rounded bg-surface-3 p-2 font-mono text-[11px] text-text-secondary">
                      {excerpt}
                    </pre>
                  </details>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
