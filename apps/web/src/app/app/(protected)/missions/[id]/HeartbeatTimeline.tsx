'use client';

import { isOpenTaskStatus } from '@buildd/shared';
import { useState } from 'react';
import { timeAgo } from '@/lib/mission-helpers';
import type { OrganizerRun } from '@/lib/mission-checkins';
import AiFeedback from '@/components/AiFeedback';

/**
 * Organizer runs: every time the organizer planned the next step, labelled by
 * what started it (`tasks.context.triggerSource`, lib/mission-checkins.ts).
 * The file keeps its old name; users read "Organizer runs".
 */
interface HeartbeatTimelineProps {
  runs: Array<OrganizerRun & { result: any }>;
  /** Open on first render (the dev fixture); the mission page starts collapsed. */
  defaultExpanded?: boolean;
}

type RunOutcome = 'ok' | 'action_taken' | 'error';

function getRunOutcome(run: HeartbeatTimelineProps['runs'][0]): RunOutcome | null {
  if (run.status === 'failed') return 'error';
  const status = run.result?.structuredOutput?.status;
  if (status === 'ok' || status === 'action_taken' || status === 'error') return status;
  return null;
}

function getSummary(run: HeartbeatTimelineProps['runs'][0]): string {
  const summary = run.result?.structuredOutput?.summary || run.result?.summary;
  if (summary) return summary;
  if (isOpenTaskStatus(run.status)) return 'Running';
  const outcome = getRunOutcome(run);
  if (outcome === 'ok') return 'Nothing to do';
  if (outcome === 'action_taken') return 'Planned the next step';
  if (outcome === 'error') return 'Failed';
  return run.status === 'completed' ? 'Completed' : run.status;
}

export default function HeartbeatTimeline({ runs, defaultExpanded = false }: HeartbeatTimelineProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  if (runs.length === 0) return null;

  return (
    <div className="card p-4" data-testid="organizer-runs">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 w-full text-left"
        aria-expanded={expanded}
      >
        <span className="flex items-center gap-1.5 flex-1 min-w-0">
          {/* Pulse wave icon, distinct from task icons */}
          <svg className="w-3.5 h-3.5 text-status-success shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 12h3l2-7 4 14 3-10 2 3h4" />
          </svg>
          <h2 className="section-label">Organizer runs</h2>
          <span className="text-[11px] text-text-muted shrink-0">({runs.length})</span>
        </span>
        <svg
          className={`w-4 h-4 text-text-muted shrink-0 transition-transform duration-200 ${expanded ? 'rotate-180' : ''}`}
          fill="none" viewBox="0 0 24 24" stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      <p className="text-[11px] text-text-muted mt-0.5">
        Each time the organizer planned the next step, and what started it.
      </p>

      {expanded && (
        <div className="space-y-1 mt-3 border-t border-border-default pt-3">
          {runs.map(run => {
            const outcome = getRunOutcome(run);
            const summary = getSummary(run);
            const rowClass = outcome === 'error' ? 'bg-status-error/5' : '';

            return (
              <button
                key={run.id}
                data-task-id={run.id}
                data-trigger-source={run.triggerSource ?? ''}
                className={`w-full flex items-center gap-3 px-2.5 py-1.5 hover:bg-card-hover transition-colors text-[12px] text-left ${rowClass}`}
              >
                {/* Run marker: square, distinct from worker dots */}
                <span className={`w-2 h-2 shrink-0 ${
                  outcome === 'ok' ? 'bg-status-success/60' :
                  outcome === 'action_taken' ? 'bg-status-warning/60' :
                  outcome === 'error' ? 'bg-status-error/60' :
                  'bg-border-default'
                }`} />
                <span className="text-[11px] text-text-muted shrink-0 w-16 whitespace-nowrap tabular-nums">{timeAgo(run.createdAt)}</span>
                {/* Phone: trigger over summary, so neither truncates to nothing. */}
                <span className="flex-1 min-w-0 flex flex-col md:flex-row md:items-center md:gap-3">
                  <span className="min-w-0 truncate font-medium text-text-primary md:shrink-0 md:max-w-[45%]">{run.triggerLabel}</span>
                  <span className="min-w-0 truncate text-text-secondary md:flex-1">{summary}</span>
                </span>
                <span onClick={(e) => e.stopPropagation()}>
                  <AiFeedback entityType="heartbeat" entityId={run.id} showDismiss compact />
                </span>
                <svg className="w-3 h-3 text-text-muted shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
