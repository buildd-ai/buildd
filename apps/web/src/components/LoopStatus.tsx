import type { LoopHistoryEntry, LoopState } from '@buildd/shared';

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
}: {
  loopIteration: number;
  maxLoops: number;
  loopState: LoopState | null;
  startAt?: string | null;
}) {
  const attempt = Math.min(loopIteration + 1, maxLoops);
  const deferred = loopState === 'condition_unmet'
    && !!startAt
    && new Date(startAt).getTime() > Date.now();
  const terminal = loopState === 'satisfied' || loopState === 'exhausted';
  const color = loopState === 'exhausted'
    ? 'text-status-error border-status-error bg-status-error/8'
    : loopState === 'satisfied'
      ? 'text-status-success border-status-success bg-status-success/8'
      : 'text-purple-400 border-purple-400 bg-purple-500/8';

  return (
    <span
      data-loop-status={deferred ? 'deferred' : terminal ? loopState : 'active'}
      className={`inline-flex items-center gap-1.5 px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wide border ${color} shrink-0`}
    >
      {!terminal && <span className="w-1.5 h-1.5 rounded-full bg-current animate-status-pulse" />}
      {loopState === 'exhausted'
        ? `LOOP EXHAUSTED · ${attempt}/${maxLoops}`
        : loopState === 'satisfied'
          ? `LOOP SATISFIED · ${attempt}/${maxLoops}`
          : `LOOPING · attempt ${attempt}/${maxLoops}`}
      {deferred && (
        <span className="normal-case font-normal opacity-80">
          · resumes {new Date(startAt!).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
        </span>
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
  return (
    <section className="mb-6" data-testid="loop-history">
      <div className="font-mono text-[10px] uppercase tracking-[2.5px] text-text-muted pb-2 border-b border-border-default mb-4">
        Loop history
      </div>
      {loopState === 'exhausted' && (
        <div className="mb-3 rounded-[8px] border border-status-error/30 bg-status-error/10 p-3 text-sm text-status-error">
          <span className="font-semibold">Condition unmet after {entries.length || maxLoops} attempts.</span>
          {' '}The task failed after exhausting its verification loop; the evidence from every attempt is preserved below.
        </div>
      )}
      {entries.length === 0 ? (
        <div className="card p-4 text-sm text-text-muted">No iterations evaluated yet.</div>
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
                        {entry.satisfied ? 'Condition met' : 'Condition unmet'}
                      </span>
                      <span className="font-mono text-[10px] uppercase text-text-muted">{entry.conditionType}</span>
                    </div>
                    <p className="mt-1 text-sm text-text-secondary">{entry.summary}</p>
                  </div>
                  <div className="text-right text-[11px] text-text-muted shrink-0">
                    <div>{new Date(entry.evaluatedAt).toLocaleString()}</div>
                    {duration && <div>{duration}</div>}
                  </div>
                </div>
                <div className="mt-2 text-[11px] text-text-muted">Worker {entry.workerId}</div>
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
