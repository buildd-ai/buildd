'use client';

import { useState } from 'react';
import Link from 'next/link';
import TaskCard from '@/components/TaskCard';
import ExternalLink from '@/components/ExternalLink';
import MergeConfirmButton from '@/components/MergeConfirmButton';
import InlineTaskRetry from './InlineTaskRetry';
import WorkerRespondInput from '@/components/WorkerRespondInput';
import { MissionProgressBar } from '@/components/MissionProgressBar';
import { GroupSection } from '@/components/GroupSection';
import { SwipeableRow, type SwipeCardType } from '@/components/SwipeableRow';
import { deriveBandKey } from '@/lib/condensed-timeline';
import type { MergePolicyTier } from '@buildd/shared';
import type { ChainPositionResult } from '@/lib/task-presentation';
import type { CondensedTaskWorker } from '@/lib/condensed-timeline';
import type { MissionSegment, TaskType } from '@buildd/core/mission-helpers';
import { stripTaskTypePrefix } from '@buildd/core/mission-helpers';

// ─── Types ────────────────────────────────────────────────────────────────────

/** Alias for the shared worker type — same shape as CondensedTaskWorker. */
export type CondensedTimelineWorker = CondensedTaskWorker;

export type CondensedTimelineTask = {
  id: string;
  title: string;
  status: string;
  taskCreatedAt: string;
  taskUpdatedAt: string;
  roleColor: string;
  chain: ChainPositionResult | null;
  latestWorker: CondensedTimelineWorker | null;
  taskType: TaskType | null;
  reviewerNote: {
    type: string;
    title: string;
    body: string | null;
    status: string;
    supersededByPrNumber: number | null;
  } | null;
  reviewerTaskHref: string | null;
};

/** Minimal bookkeeping task row for the expandable footer (§3.6). */
export type BookkeepingTask = {
  id: string;
  title: string;
  taskUpdatedAt: string;
  latestWorker: { prUrl: string | null; mergedAt: string | null } | null;
};

export type CondensedTimelineGroups = {
  waitingOnYou: CondensedTimelineTask[];
  running: CondensedTimelineTask[];
  nextQueued: CondensedTimelineTask[];
  blocked: CondensedTimelineTask[];
  done: CondensedTimelineTask[];
  failed: CondensedTimelineTask[];
};

export type CondensedTimelineProps = {
  groups: CondensedTimelineGroups;
  /** Server-computed segments from computeMissionProgress — sliced per group for disclosure strips. */
  segments: MissionSegment[];
  effectivePolicyTier: MergePolicyTier;
  policyLabel: string;
  missionId: string;
  allTasksCount: number;
  missionCompleted: boolean;
  /** Bookkeeping tasks (retry, review, planning) collapsed to footer (§3.6). */
  bookkeepingTasks: BookkeepingTask[];
  /** Summary default for missions > N_small (§3.5). */
  defaultView: 'summary' | 'timeline';
  /** Merged PR count for Summary view roll-up (§3.5). */
  prsMerged: number;
  /** Open (not yet merged) PR count for Summary view roll-up (§3.5). */
  prsOpen: number;
  /** Non-cancelled deliverable task counts for Summary MissionProgressBar (§3.5). */
  completedTasks: number;
  totalTasks: number;
};

// ─── PR status line — single PR reference for open-PR rows ──────────────────

const PR_STATUS: Record<string, { label: string; cls: string }> = {
  ci_running: { label: 'CI…',       cls: 'text-status-info' },
  ci_failed:  { label: 'CI ✗',      cls: 'text-status-error' },
  conflict:   { label: 'conflict',  cls: 'text-status-warning' },
  pr_open:    { label: 'open',      cls: 'text-accent-text' },
};

function PrStatusLine({
  task,
  effectivePolicyTier,
}: {
  task: CondensedTimelineTask;
  effectivePolicyTier: MergePolicyTier;
}) {
  const lw = task.latestWorker;
  if (!lw?.prUrl || !lw.prNumber) return null;

  const isMerged = !!lw.mergedAt || lw.prLifecycleStatus === 'merged';
  const isClosed = lw.prLifecycleStatus === 'closed';
  if (isMerged || isClosed) return null;

  const isWaitingMerge = task.status === 'completed';
  const statusEntry = lw.prLifecycleStatus ? PR_STATUS[lw.prLifecycleStatus] : null;
  const statusWord = isWaitingMerge && !statusEntry ? 'ready to merge' : (statusEntry?.label ?? 'open');
  const statusCls  = isWaitingMerge && !statusEntry ? 'text-accent-text' : (statusEntry?.cls ?? 'text-accent-text');

  return (
    <div className="pl-7 pb-0.5 flex items-center gap-2 flex-wrap">
      <a
        href={lw.prUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="font-mono text-[10px] text-accent-text hover:underline"
      >
        #{lw.prNumber}
      </a>
      <span className="text-[10px] text-text-muted">·</span>
      <span className={`text-[10px] ${statusCls}`}>{statusWord}</span>
      {isWaitingMerge && (
        <MergeConfirmButton
          prNumber={lw.prNumber}
          prUrl={lw.prUrl}
          disabled={effectivePolicyTier === 'agent-review' && !task.reviewerNote}
          disabledReason="Awaiting agent review"
        />
      )}
    </div>
  );
}

// ─── Section label ────────────────────────────────────────────────────────────

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[10px] font-semibold tracking-wider text-text-muted uppercase mb-2">
      {children}
    </div>
  );
}

// ─── Verdict chip — collapsed approved verdict (§3.7) ────────────────────────

function ApprovedVerdictChip({
  task,
  note,
}: {
  task: CondensedTimelineTask;
  note: NonNullable<CondensedTimelineTask['reviewerNote']>;
}) {
  const [expanded, setExpanded] = useState(false);
  const lw = task.latestWorker;
  const confidence = note.title.match(/\(confidence ([\d.]+)\)/)?.[1];
  const { reviewerTaskHref } = task;
  const isMerged = !!lw?.mergedAt || lw?.prLifecycleStatus === 'merged';

  if (!expanded) {
    return (
      <div className="pl-7 pb-0.5 mt-0.5">
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="inline-flex items-center gap-1 text-[10px] text-status-success font-mono hover:underline"
          title="Tap to expand approved verdict"
        >
          <span>✓</span>
          {confidence && <span>{confidence}</span>}
        </button>
      </div>
    );
  }

  return (
    <div className="pl-7 pb-1 mt-1">
      <div className="bg-status-success/5 border border-status-success/20 rounded px-2.5 py-1.5">
        <div className="flex items-center gap-1.5 mb-0.5">
          {reviewerTaskHref ? (
            <Link href={reviewerTaskHref} className="text-status-success text-[11px] font-semibold hover:underline">🤖 Approved</Link>
          ) : (
            <span className="text-status-success text-[11px] font-semibold">🤖 Approved</span>
          )}
          {confidence && <span className="text-[10px] text-status-success/70">(confidence {confidence})</span>}
          <button
            type="button"
            onClick={() => setExpanded(false)}
            className="ml-auto text-[10px] text-text-muted hover:text-text-secondary"
          >
            ✕
          </button>
        </div>
        <p className="text-[11px] text-text-secondary leading-relaxed line-clamp-2" title={note.body ?? note.title}>{note.body ?? note.title}</p>
        <p className="text-[10px] text-text-muted mt-0.5">{isMerged ? '→ Merged' : '→ Merging automatically…'}</p>
      </div>
    </div>
  );
}

// ─── Task row ─────────────────────────────────────────────────────────────────

function TaskRow({
  task,
  effectivePolicyTier,
  policyLabel,
}: {
  task: CondensedTimelineTask;
  effectivePolicyTier: MergePolicyTier;
  policyLabel: string;
}) {
  const { latestWorker } = task;
  const isFailed = task.status === 'failed';
  const isDone = task.status === 'completed';
  const waitingFor =
    latestWorker?.status === 'waiting_input' && latestWorker.waitingFor
      ? latestWorker.waitingFor
      : null;
  const swipeCardType: SwipeCardType = isDone
    ? 'completed-task'
    : (task.chain?.blockedBy?.length ?? 0) > 0
      ? 'blocked-task'
      : 'running-task';

  const showPrLine = !!latestWorker?.prUrl &&
    !!latestWorker.prNumber &&
    latestWorker.prLifecycleStatus !== 'merged' &&
    !latestWorker.mergedAt &&
    latestWorker.prLifecycleStatus !== 'closed' &&
    task.reviewerNote?.type !== 'reviewer_escalated' &&
    task.reviewerNote?.type !== 'reviewer_approved';

  return (
    <div className="animate-timeline-enter">
      <div
        data-task-id={task.id}
        data-task-actionable={
          task.status !== 'completed' || !!latestWorker?.prUrl ? 'true' : 'false'
        }
        className="flex items-center gap-0"
      >
        <span className="flex items-center gap-1.5 shrink-0 w-5 pointer-events-none" aria-hidden="true">
          <span className="w-2 h-px bg-border-default" />
          <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: task.roleColor }} />
        </span>
        <SwipeableRow
          cardType={swipeCardType}
          taskTitle={task.title}
          taskId={task.id}
          prUrl={latestWorker?.prUrl ?? null}
          className="flex-1 min-w-0"
        >
          <TaskCard
            density="inline"
            id={task.id}
            title={task.taskType ? stripTaskTypePrefix(task.title) : task.title}
            taskStatus={task.status}
            workerStatus={latestWorker?.status ?? null}
            chain={task.chain ?? null}
            taskCreatedAt={task.taskCreatedAt}
            taskUpdatedAt={task.taskUpdatedAt}
            workerStartedAt={latestWorker?.startedAt ?? null}
            workerUpdatedAt={null}
            prUrl={latestWorker?.prUrl ?? null}
            prNumber={latestWorker?.prNumber ?? null}
            prLifecycleStatus={latestWorker?.prLifecycleStatus ?? null}
            currentAction={latestWorker?.currentAction ?? null}
          />
        </SwipeableRow>
      </div>

      {/* Blocked-by line */}
      {task.chain && task.chain.blockedBy.length > 0 && (
        <div className="pl-7 text-[10px] text-status-warning mt-0.5 mb-0.5">
          {'← blocked on '}
          {task.chain.blockedBy.map((b, i) => (
            <span key={b.id}>
              {i > 0 && ', '}
              {b.prNumber ? `#${b.prNumber}` : b.title}
              {b.prUrl ? ' (open)' : ''}
            </span>
          ))}
        </div>
      )}

      {/* PR status line */}
      {showPrLine && (
        <PrStatusLine task={task} effectivePolicyTier={effectivePolicyTier} />
      )}

      {/* Failed task retry */}
      {isFailed && (
        <div className="pl-5 pb-1">
          <InlineTaskRetry taskId={task.id} />
        </div>
      )}

      {/* Waiting input form */}
      {waitingFor && latestWorker && (
        <div className="pl-7 pb-1">
          <span className="section-label text-status-warning">Needs your input</span>
          <WorkerRespondInput
            workerId={latestWorker.id}
            question={waitingFor.prompt}
            options={waitingFor.options}
          />
        </div>
      )}

      {/* Reviewer verdict — §3.7: approved collapses to chip; others always expanded */}
      {task.reviewerNote && (() => {
        const note = task.reviewerNote!;
        const { reviewerTaskHref } = task;
        const lw = latestWorker;

        if (note.type === 'reviewer_approved') {
          return <ApprovedVerdictChip task={task} note={note} />;
        }

        if (note.type === 'reviewer_request_changes') {
          const iteration = note.title.match(/\(iteration (\d+\/\d+)\)/)?.[1];
          return (
            <div className="pl-7 pb-1 mt-1">
              <div className="bg-[#D97706]/5 border border-[#D97706]/20 rounded px-2.5 py-1.5">
                <div className="flex items-center gap-1.5 mb-0.5">
                  {reviewerTaskHref ? (
                    <Link href={reviewerTaskHref} className="text-[#D97706] text-[11px] font-semibold hover:underline">🤖 Changes Requested</Link>
                  ) : (
                    <span className="text-[#D97706] text-[11px] font-semibold">🤖 Changes Requested</span>
                  )}
                  {iteration && <span className="text-[10px] text-[#D97706]/70">(iteration {iteration})</span>}
                </div>
                <p className="text-[11px] text-text-secondary leading-relaxed line-clamp-2" title={note.body ?? note.title}>{note.body ?? note.title}</p>
                {lw?.branch && (
                  <p className="text-[10px] text-text-muted mt-0.5">→ Retry queued on same branch ({lw.branch})</p>
                )}
              </div>
            </div>
          );
        }

        if (note.type === 'reviewer_escalated') {
          const successorPrNumber = note.supersededByPrNumber;
          const successorUrl = successorPrNumber && lw?.prUrl
            ? lw.prUrl.replace(/\/pull\/\d+$/, `/pull/${successorPrNumber}`)
            : null;
          return (
            <div className="pl-7 pb-1 mt-1">
              <div className="bg-status-error/5 border border-status-error/20 rounded px-2.5 py-2">
                <div className="flex items-center gap-1.5 mb-1">
                  {reviewerTaskHref ? (
                    <Link href={reviewerTaskHref} className="text-status-error text-[11px] font-semibold hover:underline">🤖 Escalated to you</Link>
                  ) : (
                    <span className="text-status-error text-[11px] font-semibold">🤖 Escalated to you</span>
                  )}
                </div>
                <p className="text-[11px] text-text-secondary leading-relaxed mb-2 line-clamp-2" title={note.body ?? note.title}>{note.body ?? note.title}</p>
                <div className="flex items-center gap-2 flex-wrap">
                  {lw?.prUrl && (
                    <ExternalLink href={lw.prUrl} className="text-[11px] text-accent-text hover:underline">
                      PR #{lw.prNumber} ↗
                    </ExternalLink>
                  )}
                  {lw?.prNumber && !lw.mergedAt && lw.prLifecycleStatus !== 'closed' && lw.prLifecycleStatus !== 'merged' && (
                    <MergeConfirmButton prNumber={lw.prNumber} prUrl={lw.prUrl ?? ''} />
                  )}
                  {(lw?.mergedAt || lw?.prLifecycleStatus === 'merged') && (
                    <span className="text-[11px] text-status-success">merged</span>
                  )}
                  {lw?.prLifecycleStatus === 'closed' && (
                    <span className="text-[11px] text-text-muted">
                      closed
                      {note.status === 'superseded' && successorPrNumber && (
                        <>
                          {' — superseded by '}
                          {successorUrl ? (
                            <ExternalLink href={successorUrl} className="text-accent-text hover:underline">
                              #{successorPrNumber} →
                            </ExternalLink>
                          ) : `#${successorPrNumber} →`}
                        </>
                      )}
                    </span>
                  )}
                </div>
              </div>
            </div>
          );
        }

        return null;
      })()}
    </div>
  );
}

// ─── Task list within a section ───────────────────────────────────────────────

function TaskList({
  tasks,
  effectivePolicyTier,
  policyLabel,
}: {
  tasks: CondensedTimelineTask[];
  effectivePolicyTier: MergePolicyTier;
  policyLabel: string;
}) {
  return (
    <div className="space-y-0.5">
      {tasks.map(task => (
        <TaskRow key={task.id} task={task} effectivePolicyTier={effectivePolicyTier} policyLabel={policyLabel} />
      ))}
    </div>
  );
}

// ─── Relative time helper ────────────────────────────────────────────────────

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// ─── Bookkeeping footer — §3.6 ────────────────────────────────────────────────

function BookkeepingFooter({ tasks }: { tasks: BookkeepingTask[] }) {
  const [expanded, setExpanded] = useState(false);
  if (tasks.length === 0) return null;

  const sortedDesc = [...tasks].sort(
    (a, b) => new Date(b.taskUpdatedAt).getTime() - new Date(a.taskUpdatedAt).getTime()
  );
  const lastAgo = timeAgo(sortedDesc[0].taskUpdatedAt);

  return (
    <div className="mt-3">
      <div className="flex items-center gap-2">
        <span className="flex-1 h-px bg-border-default opacity-50" />
        <button
          type="button"
          onClick={() => setExpanded(v => !v)}
          className="flex items-center gap-1.5 text-[10px] text-text-muted hover:text-text-secondary transition-colors font-mono shrink-0"
        >
          <span
            className="text-[9px] transition-transform duration-200"
            style={{ transform: expanded ? 'rotate(90deg)' : 'none' }}
          >
            ▶
          </span>
          {tasks.length} orchestrator {tasks.length === 1 ? 'run' : 'runs'} · last {lastAgo}
        </button>
        <span className="flex-1 h-px bg-border-default opacity-50" />
      </div>

      {expanded && (
        <div className="mt-2 space-y-0.5 pl-2">
          {sortedDesc.map(task => (
            <div key={task.id} className="flex items-center gap-2 text-[11px] text-text-muted py-0.5">
              <span className="flex-1 min-w-0 truncate">{task.title}</span>
              <span className="shrink-0 text-[10px]">{timeAgo(task.taskUpdatedAt)}</span>
              {task.latestWorker?.prUrl && (
                <a
                  href={task.latestWorker.prUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="shrink-0 text-accent-text hover:underline text-[10px]"
                  aria-label="PR"
                >
                  ↗
                </a>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Summary view — §3.5 ──────────────────────────────────────────────────────

function SummaryView({
  groups,
  segments,
  effectivePolicyTier,
  policyLabel,
  prsMerged,
  prsOpen,
  missionId,
  completedTasks,
  totalTasks,
}: {
  groups: CondensedTimelineGroups;
  segments: MissionSegment[];
  effectivePolicyTier: MergePolicyTier;
  policyLabel: string;
  prsMerged: number;
  prsOpen: number;
  missionId: string;
  completedTasks: number;
  totalTasks: number;
}) {
  const { waitingOnYou } = groups;

  return (
    <div className="space-y-4">
      {/* Progress bar — §3.5 spec: MissionProgressBar density="full" with labels */}
      {totalTasks > 0 && (
        <MissionProgressBar
          density="full"
          missionId={missionId}
          segments={segments}
          completedTasks={completedTasks}
          totalTasks={totalTasks}
        />
      )}

      {/* PR roll-up */}
      {(prsMerged > 0 || prsOpen > 0) && (
        <div className="text-[12px] text-text-muted font-mono">
          {[
            prsMerged > 0 ? `${prsMerged} PR${prsMerged !== 1 ? 's' : ''} merged` : null,
            prsOpen > 0 ? `${prsOpen} open` : null,
          ].filter(Boolean).join(' · ')}
        </div>
      )}

      {/* Waiting-on-you band — always visible in Summary (above fold) */}
      {waitingOnYou.length > 0 && (
        <div>
          <SectionLabel>Waiting on you</SectionLabel>
          <TaskList
            tasks={waitingOnYou}
            effectivePolicyTier={effectivePolicyTier}
            policyLabel={policyLabel}
          />
        </div>
      )}

      {waitingOnYou.length === 0 && (
        <p className="text-[13px] text-text-muted italic">
          No actions needed — switch to Timeline for full history.
        </p>
      )}
    </div>
  );
}

// ─── Wave-banded done section — §3.8 ─────────────────────────────────────────

function WaveBandedDone({
  done,
  failed,
  segments,
  effectivePolicyTier,
  policyLabel,
  missionCompleted,
}: {
  done: CondensedTimelineTask[];
  failed: CondensedTimelineTask[];
  segments: MissionSegment[];
  effectivePolicyTier: MergePolicyTier;
  policyLabel: string;
  missionCompleted: boolean;
}) {
  const [expandedBands, setExpandedBands] = useState<Record<string, boolean>>(
    () => (missionCompleted ? { _all: true } : {}) as Record<string, boolean>,
  );
  const [failedExpanded, setFailedExpanded] = useState(false);

  // Build O(1) segment lookup
  const segmentMap = new Map(segments.map(s => [s.taskId, s]));
  const getSegments = (tasks: CondensedTimelineTask[]): MissionSegment[] =>
    tasks.flatMap(t => { const s = segmentMap.get(t.id); return s ? [s] : []; });

  // Wave-band the done tasks by completion timestamp
  const doneWithTs = done.map(t => ({
    ...t,
    completionTs: t.latestWorker?.mergedAt
      ? new Date(t.latestWorker.mergedAt).getTime()
      : new Date(t.taskUpdatedAt).getTime(),
  }));
  const bands = deriveBandKey(doneWithTs, new Date());

  const toggleBand = (key: string) =>
    setExpandedBands(prev => ({ ...prev, [key]: !prev[key] }));

  const isBandExpanded = (key: string) =>
    expandedBands['_all'] || !!expandedBands[key];

  return (
    <div>
      {/* Wave bands — newest first */}
      {bands.map(band => {
        const isOpen = isBandExpanded(band.label);
        const bandSegs = getSegments(band.items);
        const prCount = band.items.filter(t =>
          t.latestWorker?.prUrl && (t.latestWorker.mergedAt || t.latestWorker.prLifecycleStatus === 'merged')
        ).length;

        return (
          <div key={band.label}>
            {isOpen ? (
              <div className="overflow-hidden">
                <GroupSection title={band.label} taskCount={band.items.length} />
                <TaskList
                  tasks={band.items}
                  effectivePolicyTier={effectivePolicyTier}
                  policyLabel={policyLabel}
                />
                <button
                  type="button"
                  onClick={() => toggleBand(band.label)}
                  className="flex items-center gap-2 w-full text-left px-2 py-1 text-[11px] text-text-muted hover:text-text-secondary transition-colors rounded mt-0.5"
                >
                  <span className="text-[9px] rotate-90 inline-block">▶</span>
                  <span>Collapse</span>
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => toggleBand(band.label)}
                className="flex items-center gap-2 w-full text-left px-2 py-1.5 mt-0.5 text-[12px] text-text-muted hover:text-text-secondary transition-colors rounded"
              >
                <span className="text-[10px]">▶</span>
                <span>{band.label}</span>
                <span className="text-[10px]">· {band.items.length} {band.items.length === 1 ? 'task' : 'tasks'}</span>
                {prCount > 0 && <span className="text-[10px]">· {prCount} PR{prCount !== 1 ? 's' : ''}</span>}
                {bandSegs.length > 0 && (
                  <span className="ml-auto flex-shrink-0">
                    <MissionProgressBar density="mini" segments={bandSegs} maxWidth={80} />
                  </span>
                )}
              </button>
            )}
          </div>
        );
      })}

      {/* Failed section */}
      {failed.length > 0 && (
        <div>
          {failedExpanded && (
            <div className="overflow-hidden">
              <SectionLabel>Failed</SectionLabel>
              <TaskList
                tasks={failed}
                effectivePolicyTier={effectivePolicyTier}
                policyLabel={policyLabel}
              />
            </div>
          )}
          <button
            type="button"
            onClick={() => setFailedExpanded(v => !v)}
            className="flex items-center gap-2 w-full text-left px-2 py-1.5 mt-0.5 text-[12px] text-text-muted hover:text-text-secondary transition-colors rounded"
          >
            <span
              className="text-[10px] transition-transform duration-200"
              style={{ transform: failedExpanded ? 'rotate(90deg)' : 'none' }}
            >
              ▶
            </span>
            <span>{failed.length} failed</span>
            {!failedExpanded && (
              <span className="ml-auto flex-shrink-0">
                <MissionProgressBar density="mini" segments={getSegments(failed)} maxWidth={80} />
              </span>
            )}
          </button>
        </div>
      )}

      {/* Legacy collapsed done/failed row for when no bands (all done tasks have no timestamp) */}
      {bands.length === 0 && done.length > 0 && (
        <button
          type="button"
          onClick={() => toggleBand('_legacy')}
          className="flex items-center gap-2 w-full text-left px-2 py-1.5 text-[12px] text-text-muted hover:text-text-secondary transition-colors rounded"
        >
          <span
            className="text-[10px] transition-transform duration-200"
            style={{ transform: isBandExpanded('_legacy') ? 'rotate(90deg)' : 'none' }}
          >
            ▶
          </span>
          <span>{done.length} done</span>
          {!isBandExpanded('_legacy') && (
            <span className="ml-auto flex-shrink-0">
              <MissionProgressBar density="mini" segments={getSegments(done)} maxWidth={80} />
            </span>
          )}
        </button>
      )}
    </div>
  );
}

// ─── Timeline view — full hierarchy ──────────────────────────────────────────

function TimelineView({
  groups,
  segments,
  effectivePolicyTier,
  policyLabel,
  missionId,
  allTasksCount,
  missionCompleted,
  bookkeepingTasks,
}: {
  groups: CondensedTimelineGroups;
  segments: MissionSegment[];
  effectivePolicyTier: MergePolicyTier;
  policyLabel: string;
  missionId: string;
  allTasksCount: number;
  missionCompleted: boolean;
  bookkeepingTasks: BookkeepingTask[];
}) {
  const [moreQueuedExpanded, setMoreQueuedExpanded] = useState(false);
  const [blockedExpanded, setBlockedExpanded] = useState(false);

  const { waitingOnYou, running, nextQueued, blocked, done, failed } = groups;

  const segmentMap = new Map(segments.map(s => [s.taskId, s]));
  const getGroupSegments = (tasks: CondensedTimelineTask[]): MissionSegment[] =>
    tasks.flatMap(t => { const s = segmentMap.get(t.id); return s ? [s] : []; });

  const showBlockedInline = blocked.length <= 2;
  const hasTerminal = done.length > 0 || failed.length > 0;

  const runningSorted = [...running].sort((a, b) => {
    const aMs = a.latestWorker?.startedAt ? new Date(a.latestWorker.startedAt).getTime() : 0;
    const bMs = b.latestWorker?.startedAt ? new Date(b.latestWorker.startedAt).getTime() : 0;
    return aMs - bMs;
  });

  const QUEUED_VISIBLE = 3;
  const queuedVisible = nextQueued.slice(0, QUEUED_VISIBLE);
  const queuedOverflow = nextQueued.slice(QUEUED_VISIBLE);

  const hasSections = waitingOnYou.length > 0 || running.length > 0 || nextQueued.length > 0 ||
    blocked.length > 0 || hasTerminal;

  if (!hasSections) {
    return (
      <>
        <p className="text-[13px] text-text-muted italic mb-6">No tasks yet</p>
        <BookkeepingFooter tasks={bookkeepingTasks} />
      </>
    );
  }

  return (
    <div className="space-y-4">

      {/* ── WAITING ON YOU ─────────────────────────────────────────── */}
      {waitingOnYou.length > 0 && (
        <div>
          <SectionLabel>Waiting on you</SectionLabel>
          <TaskList
            tasks={waitingOnYou}
            effectivePolicyTier={effectivePolicyTier}
            policyLabel={policyLabel}
          />
        </div>
      )}

      {/* ── RUNNING / NEEDS INPUT ──────────────────────────────────── */}
      {runningSorted.length > 0 && (
        <div>
          <SectionLabel>
            Running{runningSorted.some(t => t.latestWorker?.status === 'waiting_input') ? ' · Needs Input' : ''}
          </SectionLabel>
          <TaskList
            tasks={runningSorted}
            effectivePolicyTier={effectivePolicyTier}
            policyLabel={policyLabel}
          />
        </div>
      )}

      {/* ── NEXT QUEUED ───────────────────────────────────────────── */}
      {nextQueued.length > 0 && (
        <div>
          <SectionLabel>Next queued</SectionLabel>
          <TaskList
            tasks={queuedVisible}
            effectivePolicyTier={effectivePolicyTier}
            policyLabel={policyLabel}
          />

          {queuedOverflow.length > 0 && (
            <>
              {moreQueuedExpanded && (
                <div className="overflow-hidden transition-all duration-200 ease-out">
                  <TaskList
                    tasks={queuedOverflow}
                    effectivePolicyTier={effectivePolicyTier}
                    policyLabel={policyLabel}
                  />
                </div>
              )}
              <button
                type="button"
                onClick={() => setMoreQueuedExpanded(v => !v)}
                className="flex items-center gap-2 w-full text-left px-2 py-1.5 mt-0.5 text-[12px] text-text-muted hover:text-text-secondary transition-colors rounded"
              >
                <span
                  className="text-[10px] transition-transform duration-200"
                  style={{ transform: moreQueuedExpanded ? 'rotate(90deg)' : 'none' }}
                >
                  ▶
                </span>
                {moreQueuedExpanded ? 'Show less' : `${queuedOverflow.length} more queued`}
                {!moreQueuedExpanded && (
                  <span className="ml-auto flex-shrink-0">
                    <MissionProgressBar density="mini" segments={getGroupSegments(queuedOverflow)} maxWidth={80} />
                  </span>
                )}
              </button>
            </>
          )}
        </div>
      )}

      {/* ── BLOCKED ─────────────────────────────────────────────── */}
      {blocked.length > 0 && (
        <div>
          {showBlockedInline ? (
            <>
              <SectionLabel>Waiting on dependencies</SectionLabel>
              <TaskList
                tasks={blocked}
                effectivePolicyTier={effectivePolicyTier}
                policyLabel={policyLabel}
              />
            </>
          ) : (
            <>
              {blockedExpanded && (
                <div className="overflow-hidden transition-all duration-200 ease-out">
                  <SectionLabel>Waiting on dependencies</SectionLabel>
                  <TaskList
                    tasks={blocked}
                    effectivePolicyTier={effectivePolicyTier}
                    policyLabel={policyLabel}
                  />
                </div>
              )}
              <button
                type="button"
                onClick={() => setBlockedExpanded(v => !v)}
                className="flex items-center gap-2 w-full text-left px-2 py-1.5 text-[12px] text-text-muted hover:text-text-secondary transition-colors rounded"
              >
                <span
                  className="text-[10px] transition-transform duration-200"
                  style={{ transform: blockedExpanded ? 'rotate(90deg)' : 'none' }}
                >
                  ▶
                </span>
                {blockedExpanded ? 'Hide blocked' : `${blocked.length} waiting on dependencies`}
                {!blockedExpanded && (
                  <span className="ml-auto flex-shrink-0">
                    <MissionProgressBar density="mini" segments={getGroupSegments(blocked)} maxWidth={80} />
                  </span>
                )}
              </button>
            </>
          )}
        </div>
      )}

      {/* ── DONE / FAILED — wave banded (§3.8) ───────────────────── */}
      {hasTerminal && (
        <WaveBandedDone
          done={done}
          failed={failed}
          segments={segments}
          effectivePolicyTier={effectivePolicyTier}
          policyLabel={policyLabel}
          missionCompleted={missionCompleted}
        />
      )}

      {/* ── BOOKKEEPING FOOTER (§3.6) ─────────────────────────────── */}
      <BookkeepingFooter tasks={bookkeepingTasks} />
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function CondensedTimeline({
  groups,
  segments,
  effectivePolicyTier,
  policyLabel,
  missionId,
  allTasksCount,
  missionCompleted,
  bookkeepingTasks,
  defaultView,
  prsMerged,
  prsOpen,
  completedTasks,
  totalTasks,
}: CondensedTimelineProps) {
  const [view, setView] = useState<'summary' | 'timeline'>(defaultView);

  const isLarge = defaultView === 'summary';

  return (
    <div className="mb-6">
      {/* Header row: title + optional Summary/Timeline sub-tabs (§3.5) */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-1">
          {isLarge ? (
            <>
              <button
                type="button"
                onClick={() => setView('summary')}
                className={`px-2.5 py-1 rounded text-[12px] font-medium transition-colors ${
                  view === 'summary'
                    ? 'bg-surface-3 text-text-primary'
                    : 'text-text-muted hover:text-text-secondary hover:bg-surface-2'
                }`}
              >
                Summary
              </button>
              <button
                type="button"
                onClick={() => setView('timeline')}
                className={`px-2.5 py-1 rounded text-[12px] font-medium transition-colors ${
                  view === 'timeline'
                    ? 'bg-surface-3 text-text-primary'
                    : 'text-text-muted hover:text-text-secondary hover:bg-surface-2'
                }`}
              >
                Timeline
              </button>
            </>
          ) : (
            <h2 className="section-label">Timeline</h2>
          )}
        </div>
        {missionCompleted && allTasksCount > 0 && (
          <Link
            href={`/app/tasks?mission=${missionId}`}
            className="text-[12px] text-accent-text hover:underline"
          >
            View all {allTasksCount} tasks &rarr;
          </Link>
        )}
      </div>

      {/* Content: Summary or Timeline view */}
      {view === 'summary' ? (
        <SummaryView
          groups={groups}
          segments={segments}
          effectivePolicyTier={effectivePolicyTier}
          policyLabel={policyLabel}
          prsMerged={prsMerged}
          prsOpen={prsOpen}
          missionId={missionId}
          completedTasks={completedTasks}
          totalTasks={totalTasks}
        />
      ) : (
        <TimelineView
          groups={groups}
          segments={segments}
          effectivePolicyTier={effectivePolicyTier}
          policyLabel={policyLabel}
          missionId={missionId}
          allTasksCount={allTasksCount}
          missionCompleted={missionCompleted}
          bookkeepingTasks={bookkeepingTasks}
        />
      )}

      {/* View all tasks link for active missions */}
      {allTasksCount > 0 && !missionCompleted && view === 'timeline' && (
        <div className="mt-4">
          <Link
            href={`/app/tasks?mission=${missionId}`}
            className="flex items-center gap-2 px-3 py-2.5 rounded-lg hover:bg-card-hover transition-colors group text-[13px] text-text-secondary hover:text-accent-text"
          >
            <svg className="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 6.75h12M8.25 12h12m-12 5.25h12M3.75 6.75h.007v.008H3.75V6.75zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zM3.75 12h.007v.008H3.75V12zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm-.375 5.25h.007v.008H3.75v-.008zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0z" />
            </svg>
            <span>View all {allTasksCount} tasks</span>
            <svg className="w-3.5 h-3.5 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
            </svg>
          </Link>
        </div>
      )}
    </div>
  );
}
