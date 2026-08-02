'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import TaskCard from '@/components/TaskCard';
import ExternalLink from '@/components/ExternalLink';
import MergeConfirmButton from '@/components/MergeConfirmButton';
import InlineTaskRetry from './InlineTaskRetry';
import WorkerRespondInput from '@/components/WorkerRespondInput';
import { StatusChip } from '@/components/StatusChip';
import { SegmentStrip } from '@/components/SegmentStrip';
import { SwipeableRow, type SwipeCardType } from '@/components/SwipeableRow';
import type { MergePolicyTier } from '@buildd/shared';
import type { ChainPositionResult } from '@/lib/task-presentation';
import type { CondensedTaskWorker } from '@/lib/condensed-timeline';
import type { MissionSegment } from '@buildd/core/mission-helpers';

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
  reviewerNote: {
    type: string;
    title: string;
    body: string | null;
    status: string;
    supersededByPrNumber: number | null;
  } | null;
  reviewerTaskHref: string | null;
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
};

// ─── Gate chip — I-11: animate-collapse when mergedAt is stamped ─────────────

function GateChip({
  mergedAt,
  policyTier,
  waitingMinutes,
}: {
  mergedAt: string | null;
  policyTier: MergePolicyTier;
  waitingMinutes: number;
}) {
  const [visible, setVisible] = useState(!mergedAt);
  const [collapsing, setCollapsing] = useState(false);

  useEffect(() => {
    if (!mergedAt || !visible || collapsing) return;
    setCollapsing(true);
    const t = setTimeout(() => setVisible(false), 200);
    return () => clearTimeout(t);
  }, [mergedAt, visible, collapsing]);

  if (!visible) return null;

  return (
    <div
      className="overflow-hidden transition-all duration-200 ease-out"
      style={{ maxHeight: collapsing ? '0' : '40px', opacity: collapsing ? 0 : 1 }}
    >
      <div className="px-2 pb-1">
        <StatusChip
          policyTier={policyTier}
          waitingMinutes={waitingMinutes}
          className="hidden sm:inline-flex"
        />
      </div>
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
        <div>
          <TaskCard
            density="inline"
            id={task.id}
            title={task.title}
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
          {/* BT-14 / I-11: awaiting-merge gate chip — collapses (200ms) when mergedAt is stamped */}
          {task.status === 'completed' &&
            latestWorker?.prUrl &&
            latestWorker.prLifecycleStatus !== 'closed' && (
              <GateChip
                mergedAt={latestWorker.mergedAt ?? null}
                policyTier={effectivePolicyTier}
                waitingMinutes={
                  latestWorker.completedAt
                    ? Math.floor((Date.now() - new Date(latestWorker.completedAt).getTime()) / 60000)
                    : 0
                }
              />
            )}
        </div>
        </SwipeableRow>
      </div>

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

      {/* Reviewer verdict chip */}
      {task.reviewerNote && (() => {
        const note = task.reviewerNote!;
        const { reviewerTaskHref } = task;
        const lw = latestWorker;

        if (note.type === 'reviewer_approved') {
          const confidence = note.title.match(/\(confidence ([\d.]+)\)/)?.[1];
          const isMerged = !!lw?.mergedAt;
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
                </div>
                <p className="text-[11px] text-text-secondary leading-relaxed line-clamp-2" title={note.body ?? note.title}>{note.body ?? note.title}</p>
                <p className="text-[10px] text-text-muted mt-0.5">{isMerged ? '→ Merged' : '→ Merging automatically…'}</p>
              </div>
            </div>
          );
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
                  {lw?.prNumber && !lw.mergedAt && lw.prLifecycleStatus !== 'closed' && (
                    <MergeConfirmButton prNumber={lw.prNumber} prUrl={lw.prUrl ?? ''} />
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

// ─── Merge CTA for waiting-on-you tasks ───────────────────────────────────────

function WaitingOnYouMergeCTA({
  task,
  effectivePolicyTier,
}: {
  task: CondensedTimelineTask;
  effectivePolicyTier: string;
}) {
  const lw = task.latestWorker;
  if (!lw?.prUrl || lw.mergedAt || lw.prLifecycleStatus === 'closed') return null;
  return (
    <div className="pl-5 pb-1 flex items-center gap-2">
      <ExternalLink href={lw.prUrl} className="text-[11px] text-accent-text hover:underline">
        PR #{lw.prNumber} ↗
      </ExternalLink>
      {lw.prNumber && (
        <MergeConfirmButton
          prNumber={lw.prNumber}
          prUrl={lw.prUrl}
          className="shrink-0"
          disabled={effectivePolicyTier === 'agent-review' && !task.reviewerNote}
          disabledReason="Awaiting agent review"
        />
      )}
    </div>
  );
}

// ─── Task list within a section ───────────────────────────────────────────────

function TaskList({
  tasks,
  effectivePolicyTier,
  policyLabel,
  showMergeCta = false,
}: {
  tasks: CondensedTimelineTask[];
  effectivePolicyTier: MergePolicyTier;
  policyLabel: string;
  showMergeCta?: boolean;
}) {
  return (
    <div className="space-y-0.5">
      {tasks.map(task => (
        <div key={task.id}>
          <TaskRow task={task} effectivePolicyTier={effectivePolicyTier} policyLabel={policyLabel} />
          {showMergeCta && <WaitingOnYouMergeCTA task={task} effectivePolicyTier={effectivePolicyTier} />}
        </div>
      ))}
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
}: CondensedTimelineProps) {
  const [doneExpanded, setDoneExpanded] = useState(false);
  const [moreQueuedExpanded, setMoreQueuedExpanded] = useState(false);
  const [blockedExpanded, setBlockedExpanded] = useState(false);

  const { waitingOnYou, running, nextQueued, blocked, done, failed } = groups;

  // Build O(1) segment lookup — used to slice segments for each disclosure strip
  const segmentMap = new Map(segments.map(s => [s.taskId, s]));
  const getGroupSegments = (tasks: CondensedTimelineTask[]): MissionSegment[] =>
    tasks.flatMap(t => { const s = segmentMap.get(t.id); return s ? [s] : []; });

  // Spec §3.2: ≤2 blocked → always expanded; ≥3 → collapsed disclosure
  const showBlockedInline = blocked.length <= 2;
  const doneCount = done.length;
  const failedCount = failed.length;
  const hasTerminal = doneCount > 0 || failedCount > 0;

  // Running sorted longest-running first (startedAt ASC) per spec §3.1
  const runningSorted = [...running].sort((a, b) => {
    const aMs = a.latestWorker?.startedAt ? new Date(a.latestWorker.startedAt).getTime() : 0;
    const bMs = b.latestWorker?.startedAt ? new Date(b.latestWorker.startedAt).getTime() : 0;
    return aMs - bMs;
  });

  // Next queued: first 3 shown, rest behind disclosure
  const QUEUED_VISIBLE = 3;
  const queuedVisible = nextQueued.slice(0, QUEUED_VISIBLE);
  const queuedOverflow = nextQueued.slice(QUEUED_VISIBLE);

  const hasSections = waitingOnYou.length > 0 || running.length > 0 || nextQueued.length > 0 ||
    blocked.length > 0 || hasTerminal;

  if (!hasSections) {
    return <p className="text-[13px] text-text-muted italic mb-6">No tasks yet</p>;
  }

  return (
    <div className="mb-6">
      <div className="flex items-center justify-between mb-3">
        <h2 className="section-label">Timeline</h2>
        {missionCompleted && allTasksCount > 0 && (
          <Link
            href={`/app/tasks?mission=${missionId}`}
            className="text-[12px] text-accent-text hover:underline"
          >
            View all {allTasksCount} tasks &rarr;
          </Link>
        )}
      </div>

      <div className="space-y-4">

        {/* ── WAITING ON YOU ─────────────────────────────────────────── */}
        {waitingOnYou.length > 0 && (
          <div>
            <SectionLabel>Waiting on you</SectionLabel>
            <TaskList
              tasks={waitingOnYou}
              effectivePolicyTier={effectivePolicyTier}
              policyLabel={policyLabel}
              showMergeCta
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

            {/* ▶ N more queued disclosure */}
            {queuedOverflow.length > 0 && (
              <>
                {moreQueuedExpanded && (
                  <div
                    className="overflow-hidden transition-all duration-200 ease-out"
                    style={{ maxHeight: moreQueuedExpanded ? '9999px' : '0px' }}
                  >
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
                      <SegmentStrip continuous height={4} maxWidth={80} segments={getGroupSegments(queuedOverflow)} />
                    </span>
                  )}
                </button>
              </>
            )}
          </div>
        )}

        {/* ── BLOCKED (≤2: always expanded; ≥3: collapsed disclosure) ─ */}
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
                      <SegmentStrip continuous height={4} maxWidth={80} segments={getGroupSegments(blocked)} />
                    </span>
                  )}
                </button>
              </>
            )}
          </div>
        )}

        {/* ── DONE / FAILED (collapsed by default) ─────────────────── */}
        {hasTerminal && (
          <div>
            {doneExpanded && (
              <div
                className="overflow-hidden transition-all duration-200 ease-out"
              >
                {done.length > 0 && (
                  <>
                    <SectionLabel>Completed</SectionLabel>
                    <TaskList
                      tasks={done}
                      effectivePolicyTier={effectivePolicyTier}
                      policyLabel={policyLabel}
                    />
                  </>
                )}
                {failed.length > 0 && (
                  <>
                    <SectionLabel>Failed</SectionLabel>
                    <TaskList
                      tasks={failed}
                      effectivePolicyTier={effectivePolicyTier}
                      policyLabel={policyLabel}
                    />
                  </>
                )}
              </div>
            )}
            <button
              type="button"
              onClick={() => setDoneExpanded(v => !v)}
              className="flex items-center gap-2 w-full text-left px-2 py-1.5 text-[12px] text-text-muted hover:text-text-secondary transition-colors rounded"
            >
              <span
                className="text-[10px] transition-transform duration-200"
                style={{ transform: doneExpanded ? 'rotate(90deg)' : 'none' }}
              >
                ▶
              </span>
              <span>
                {[
                  doneCount > 0 ? `${doneCount} done` : null,
                  failedCount > 0 ? `${failedCount} failed` : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
              {!doneExpanded && (
                <span className="ml-auto flex-shrink-0">
                  <SegmentStrip continuous height={4} maxWidth={80} segments={getGroupSegments([...done, ...failed])} />
                </span>
              )}
            </button>
          </div>
        )}

      </div>

      {/* View all tasks link for active missions */}
      {allTasksCount > 0 && !missionCompleted && (
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
