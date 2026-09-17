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
import { deriveBandKey, buildRail, railOutcome, rollupRailOutcome } from '@/lib/condensed-timeline';
import type { ChainUnit, RailGoal, RailNode, RailOutcome } from '@/lib/condensed-timeline';
import { DependencyRail, type RailEdgeKind } from '@/components/DependencyRail';
import { RailNodeGlyph, type RailGlyphState } from '@/components/SegmentStrip';
import { deriveStage } from '@/lib/stage';
import { isStrandedTask } from '@/lib/structure-layout';
import type { CondensedTask } from '@/lib/condensed-timeline';
import type { MergePolicyTier } from '@buildd/shared';
import type { ChainPositionResult } from '@/lib/task-presentation';
import type { CondensedTaskWorker } from '@/lib/condensed-timeline';
import type { MissionSegment, TaskType, CriteriaGatePresentation } from '@buildd/core/mission-helpers';
import { stripTaskTypePrefix } from '@buildd/core/mission-helpers';
import AttemptStrip from './AttemptStrip';
import type { AttemptStrip as AttemptStripData } from '@/lib/attempt-strip';

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
  /**
   * Stored dependency edges, needed by the mobile rail to class the segment
   * entering each node (timeline-mobile-rail.md Rule D3-1). Same column the
   * grouping pass already reads — no new query.
   */
  dependsOn?: string[] | null;
  /**
   * Declared file scope. Read only to decide whether two Lane-2 siblings would
   * be advisory-serialized (Rule D3-2/D3-3); never a hard blocker.
   */
  pathManifest?: string[] | null;
  chain: ChainPositionResult | null;
  latestWorker: CondensedTimelineWorker | null;
  taskType: TaskType | null;
  loopState?: string | null;
  loopMaxLoops?: number | null;
  loopIteration?: number | null;
  startAt?: string | null;
  loopExitConditionType?: string | null;
  reviewerNote: {
    type: string;
    title: string;
    body: string | null;
    status: string;
    supersededByPrNumber: number | null;
  } | null;
  reviewerTaskHref: string | null;
  /** The most-recent fix task dispatched when a reviewer requested changes. */
  reviewerRetryTask: {
    id: string;
    status: string;
    title: string;
    prNumber: number | null;
  } | null;
  /**
   * True when the parent mission is `budget_exhausted`. Every pending task in
   * such a mission is unclaimable until a human raises the budget, so rendering
   * it as QUEUED repeats the silent-stall bug (docs/specs/mission-task-lifecycle.md,
   * rule CG-2). Mission-level state, so the page sets it on every row — the
   * mission row is already fetched in full and it costs no extra columns.
   */
  missionBudgetExhausted?: boolean;
  /**
   * Attempts and reviewer runs belonging to this task, pre-assembled by
   * `buildAttemptStrips` (U8). They used to collapse into the bookkeeping
   * footer, which published neither the reason for the attempt nor how many
   * remained. Absent/empty renders no strip.
   */
  attempts?: AttemptStripData | null;
};

/** Minimal bookkeeping task row for the expandable footer (§3.6). */
export type BookkeepingTask = {
  id: string;
  title: string;
  taskUpdatedAt: string;
  latestWorker: { prUrl: string | null; mergedAt: string | null } | null;
};

export type CondensedTimelineGroups = {
  waitingOnYou: ChainUnit<CondensedTimelineTask>[];
  running: ChainUnit<CondensedTimelineTask>[];
  nextQueued: ChainUnit<CondensedTimelineTask>[];
  blocked: ChainUnit<CondensedTimelineTask>[];
  done: ChainUnit<CondensedTimelineTask>[];
  failed: ChainUnit<CondensedTimelineTask>[];
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
  /** Which view this instance renders. Controlled by the parent (MissionTabs). */
  view: 'summary' | 'timeline';
  /** Merged PR count for Summary view roll-up (§3.5). */
  prsMerged: number;
  /** Open (not yet merged) PR count for Summary view roll-up (§3.5). */
  prsOpen: number;
  completedTasks: number;
  totalTasks: number;
  /**
   * Shared criteria-gate presentation (see `deriveCriteriaGatePresentation`).
   * 'unverified' replaces "No actions needed" with a quiet gated-completion
   * line; 'failing'/'refused' replace it with a named reason. Never renders
   * the word BLOCKED — that vocabulary is reserved for actual work-stopping
   * states, not an unresolved completion gate.
   */
  criteriaGate?: CriteriaGatePresentation | null;
  /**
   * Mobile rail inputs (docs/specs/timeline-mobile-rail.md). All optional: an
   * absent map degrades the rail's STRANDED detail, never its structure.
   */
  taskMap?: Map<string, CondensedTask>;
  /** Goal-criteria pass count for the rail's root node; null renders no root. */
  railGoal?: RailGoal | null;
  /**
   * Fixture/test seams for the rail's two client-state disclosures, mirroring
   * `AttemptStrip.defaultExpanded`. The live page passes neither, so every rail
   * row renders collapsed on the server exactly as it hydrates. They exist
   * because `renderToStaticMarkup` cannot deliver a click, and expansion
   * behaviour (§13) still has to be pinned by a test.
   */
  disclosedTaskIds?: ReadonlySet<string>;
  expandedChainIds?: ReadonlySet<string>;
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
  if (isMerged) return null;

  // Closed without merging is its own terminal state — render it distinctly
  // rather than hiding the line (which reads as "nothing to see here" and
  // used to let the row pass as done, AC-4).
  if (lw.prLifecycleStatus === 'closed') {
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
        <span className="text-[10px] text-status-error">closed — not merged</span>
      </div>
    );
  }

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
            missionBudgetExhausted={task.missionBudgetExhausted ?? false}
            taskCreatedAt={task.taskCreatedAt}
            taskUpdatedAt={task.taskUpdatedAt}
            startAt={task.startAt ?? null}
            loopState={task.loopState as any ?? null}
            loopMaxLoops={task.loopMaxLoops ?? null}
            loopIteration={task.loopIteration ?? null}
            loopExitConditionType={task.loopExitConditionType ?? null}
            workerStartedAt={latestWorker?.startedAt ?? null}
            workerUpdatedAt={null}
            prUrl={latestWorker?.prUrl ?? null}
            prNumber={latestWorker?.prNumber ?? null}
            prLifecycleStatus={latestWorker?.prLifecycleStatus ?? null}
            currentAction={latestWorker?.currentAction ?? null}
          />
        </SwipeableRow>
      </div>

      {/* PR status line */}
      {showPrLine && (
        <PrStatusLine task={task} effectivePolicyTier={effectivePolicyTier} />
      )}

      {/* Attempt strip — the agent chain, rendered where the work is (U8) */}
      <AttemptStrip strip={task.attempts ?? null} />

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
          const retryTask = task.reviewerRetryTask;
          let retryLine: React.ReactNode = null;
          if (retryTask) {
            const attempt = retryTask.title.match(/\[reviewer retry #(\d+)\]/i)?.[1] ?? '1';
            const taskLink = (
              <Link href={`/app/tasks/${retryTask.id}`} className="underline hover:text-text-primary">
                retry #{attempt}
              </Link>
            );
            if (retryTask.status === 'completed') {
              retryLine = (
                <p className="text-[10px] text-status-success mt-0.5">
                  → {taskLink} done{retryTask.prNumber ? ` — pushed to #${retryTask.prNumber}` : ''}
                </p>
              );
            } else if (retryTask.status === 'failed') {
              retryLine = (
                <p className="text-[10px] text-status-error mt-0.5">
                  → {taskLink} failed
                </p>
              );
            } else if (retryTask.status === 'running' || retryTask.status === 'waiting_input') {
              retryLine = (
                <p className="text-[10px] text-text-muted mt-0.5">
                  → {taskLink} running
                </p>
              );
            } else {
              retryLine = (
                <p className="text-[10px] text-text-muted mt-0.5">
                  → {taskLink} queued{lw?.branch ? ` on same branch (${lw.branch})` : ''}
                </p>
              );
            }
          } else if (lw?.branch) {
            retryLine = (
              <p className="text-[10px] text-text-muted mt-0.5">→ Retry queued on same branch ({lw.branch})</p>
            );
          }
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
                {retryLine}
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

// ─── Chain block — head + tail within one ChainUnit ──────────────────────────

function ChainBlock({
  chain,
  effectivePolicyTier,
  policyLabel,
}: {
  chain: ChainUnit<CondensedTimelineTask>;
  effectivePolicyTier: MergePolicyTier;
  policyLabel: string;
}) {
  return (
    <div>
      <TaskRow task={chain.head} effectivePolicyTier={effectivePolicyTier} policyLabel={policyLabel} />
      {chain.tail.map(task => (
        <TaskRow key={task.id} task={task} effectivePolicyTier={effectivePolicyTier} policyLabel={policyLabel} />
      ))}
    </div>
  );
}

// ─── Chain list within a section ─────────────────────────────────────────────

function ChainList({
  chains,
  effectivePolicyTier,
  policyLabel,
}: {
  chains: ChainUnit<CondensedTimelineTask>[];
  effectivePolicyTier: MergePolicyTier;
  policyLabel: string;
}) {
  return (
    <div className="space-y-0.5">
      {chains.map(chain => (
        <ChainBlock key={chain.head.id} chain={chain} effectivePolicyTier={effectivePolicyTier} policyLabel={policyLabel} />
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
  effectivePolicyTier,
  policyLabel,
  prsMerged,
  prsOpen,
  criteriaGate,
}: {
  groups: CondensedTimelineGroups;
  effectivePolicyTier: MergePolicyTier;
  policyLabel: string;
  prsMerged: number;
  prsOpen: number;
  criteriaGate?: CriteriaGatePresentation | null;
}) {
  const { waitingOnYou, running, nextQueued, blocked } = groups;

  // Count tasks across all non-terminal groups (head + tail of each chain)
  const countChains = (chains: ChainUnit<CondensedTimelineTask>[]) =>
    chains.reduce((n, c) => n + 1 + c.tail.length, 0);
  const runningCount = countChains(running);
  const queuedCount = countChains(nextQueued);
  const blockedOnDepsCount = countChains(blocked);

  // Build "Waiting on" parts for the in-flight status line
  const statusParts: string[] = [];
  if (runningCount > 0) statusParts.push(`${runningCount} task${runningCount !== 1 ? 's' : ''} running`);
  if (queuedCount > 0) statusParts.push(`${queuedCount} queued`);
  if (blockedOnDepsCount > 0) statusParts.push(`${blockedOnDepsCount} blocked on deps`);
  const hasTasks = statusParts.length > 0 || waitingOnYou.length > 0;

  return (
    <div className="space-y-4">
      {/* PR roll-up */}
      {(prsMerged > 0 || prsOpen > 0) && (
        <div className="text-[12px] text-text-muted font-mono">
          {[
            prsMerged > 0 ? `${prsMerged} PR${prsMerged !== 1 ? 's' : ''} merged` : null,
            prsOpen > 0 ? `${prsOpen} open` : null,
          ].filter(Boolean).join(' · ')}
        </div>
      )}

      {/* In-flight status line — what the mission is currently waiting on */}
      {statusParts.length > 0 && (
        <p className="text-[12px] text-text-muted">
          <span className="text-text-secondary">Waiting on:</span>{' '}
          {statusParts.join(' · ')}
        </p>
      )}

      {/* Waiting-on-you band — always visible in Summary (above fold) */}
      {waitingOnYou.length > 0 && (
        <div>
          <SectionLabel>Waiting on you</SectionLabel>
          <ChainList
            chains={waitingOnYou}
            effectivePolicyTier={effectivePolicyTier}
            policyLabel={policyLabel}
          />
        </div>
      )}

      {/* Idle state — criteria clear or never evaluated, nothing in flight. A
          young/active mission with unevaluated criteria is normal, not an
          alarm, so this stays quiet rather than reusing "blocked". */}
      {(!criteriaGate || criteriaGate.state === 'unverified') && !hasTasks && (
        <p className="text-[13px] text-text-muted italic">
          {criteriaGate?.state === 'unverified'
            ? 'Completion gated by goal criteria, not yet verified. Switch to Timeline for full history.'
            : 'No actions needed. Switch to Timeline for full history.'}
        </p>
      )}

      {/* Criteria failing, or completion was attempted and refused — idle otherwise */}
      {criteriaGate && (criteriaGate.state === 'failing' || criteriaGate.state === 'refused') && !hasTasks && (
        <p className="text-[13px] text-text-secondary">
          {criteriaGate.label}{criteriaGate.detail ? ` — ${criteriaGate.detail}` : ''}.
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
  done: ChainUnit<CondensedTimelineTask>[];
  failed: ChainUnit<CondensedTimelineTask>[];
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
  const getSegments = (chains: ChainUnit<CondensedTimelineTask>[]): MissionSegment[] =>
    chains.flatMap(c => [c.head, ...c.tail]).flatMap(t => { const s = segmentMap.get(t.id); return s ? [s] : []; });

  // Wave-band the done chains by head's completion timestamp
  const doneWithTs = done.map(chain => ({
    id: chain.head.id,
    chain,
    completionTs: chain.head.latestWorker?.mergedAt
      ? new Date(chain.head.latestWorker.mergedAt).getTime()
      : new Date(chain.head.taskUpdatedAt).getTime(),
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
        const bandChains = band.items.map(item => item.chain);
        const bandSegs = getSegments(bandChains);
        const prCount = bandChains.filter(c =>
          c.head.latestWorker?.prUrl && (c.head.latestWorker.mergedAt || c.head.latestWorker.prLifecycleStatus === 'merged')
        ).length;

        return (
          <div key={band.label}>
            {isOpen ? (
              <div className="overflow-hidden">
                <GroupSection title={band.label} taskCount={band.items.length} />
                <ChainList
                  chains={bandChains}
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
              <ChainList
                chains={failed}
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

// ─── Mobile rail — docs/specs/timeline-mobile-rail.md ────────────────────────

/**
 * Below `md`, the Timeline is one continuous vertical rail: chain heads at the
 * top, the mission's goal root at the bottom, day boundaries as ticks rather
 * than collapsible sections, and landed work collapsed to one row per chain.
 *
 * Everything structural comes from `buildRail()` — this tree only paints it.
 * Nothing here reaches for `deriveBandKey`/`WaveBandedDone`, which is what makes
 * the duplicate-day-header defect unreachable on a phone (Rule D4-1/D4-2).
 */

/** Reviewer confidence is noise above this; below it, it is the point (Rule D6-2). */
const RAIL_CONFIDENCE_FLOOR = 0.85;

const RAIL_TITLE_CHARS = 32;
const railTruncate = (text: string, limit = RAIL_TITLE_CHARS) =>
  text.length <= limit ? text : `${text.slice(0, limit - 1).trimEnd()}…`;

/** `[spec] Draft the …` → `SPEC`. Falls back to the stripped title. */
function ordinalLabel(task: CondensedTimelineTask): string {
  const prefix = task.title.match(/^\[([^\]]+)\]/)?.[1];
  if (prefix) return prefix.trim().toUpperCase();
  return railTruncate(stripTaskTypePrefix(task.title), 24);
}

type RailGlyphSpec = { state: RailGlyphState; tone?: string; pulse?: boolean; title: string };

/**
 * Node fill, derived from `deriveStage()` and nothing else (Rule D7-1). The two
 * additions the table allows are structural, not a second stage vocabulary:
 * STRANDED (Rule D7-2) and the advisory pathManifest dash (Rule D3-3).
 */
function railGlyph(
  task: CondensedTimelineTask,
  opts: { stranded?: boolean; soft?: boolean } = {},
): RailGlyphSpec {
  if (opts.stranded) return { state: 'notch', tone: 'text-status-error', title: 'stranded — its dependency died' };
  if (opts.soft) return { state: 'dashed', tone: 'text-text-muted', title: 'ordered behind a lane sibling by file scope' };

  const lw = task.latestWorker;
  const stage = deriveStage({
    taskStatus: task.status,
    workerStatus: lw?.status ?? null,
    prUrl: lw?.prUrl ?? null,
    prLifecycleStatus: lw?.prLifecycleStatus ?? null,
    mergedAt: lw?.mergedAt ?? null,
    isBlocked: (task.chain?.blockedBy?.length ?? 0) > 0,
    isMissionBudgetExhausted: task.missionBudgetExhausted ?? false,
  });

  switch (stage) {
    case 'FAILED':        return { state: 'solid', tone: 'text-status-error', title: 'failed' };
    case 'CANCELLED':     return { state: 'skipped', title: 'cancelled' };
    case 'DONE':          return { state: 'solid', title: 'done' };
    case 'RUNNING':       return { state: 'ring', tone: 'text-text-primary', pulse: true, title: 'running' };
    case 'WAITING_INPUT': return { state: 'ring', tone: 'text-status-warning', title: 'needs your input' };
    // Completed with a PR still open: a human must act, same amber ring.
    case 'OPEN':
    case 'CI':
    case 'CI_FAILING':
    case 'MERGE':
    case 'REVIEWING':
    case 'VERIFY':        return { state: 'ring', tone: 'text-status-warning', title: 'waiting on you' };
    default:              return { state: 'empty', title: stage.toLowerCase().replace('_', ' ') };
  }
}

/**
 * A row's disclosure control, when it has attempt history to disclose.
 * `panelId` is what the button's `aria-controls` names (Rule D13-5).
 */
type RailDisclosure = { expanded: boolean; onToggle: () => void; panelId: string };

/**
 * The right column — and, when the row has attempt history, the disclosure
 * control itself (Rule D13-1).
 *
 * Render order is fixed left to right: PR number → PR lifecycle word → reviewer
 * confidence → outcome mark → chevron (Rule D6-12). The mark sits inboard of the
 * chevron so the chevron holds one rightmost column across every row, which is
 * what makes the hit box predictable at thumb reach.
 *
 * The PR-number `<a>` stays OUTSIDE the button: a link nested in a button is not
 * a valid target and taps resolve unpredictably (Rule D13-4).
 */
function RailRightColumn({
  task,
  prTask,
  outcome,
  disclosure,
}: {
  task: CondensedTimelineTask;
  /** Source of the PR number/word, when it differs from `task` — a collapsed
   * chain's confidence flag still belongs to the head, only the PR is the
   * terminal member's (§1.3). */
  prTask?: CondensedTimelineTask;
  outcome: RailOutcome;
  disclosure: RailDisclosure | null;
}) {
  const lw = (prTask ?? task).latestWorker;
  const note = task.reviewerNote;
  const confidenceRaw = note?.title.match(/\(confidence ([\d.]+)\)/)?.[1];
  const confidence = confidenceRaw != null ? Number(confidenceRaw) : null;
  const showConfidence =
    note != null &&
    confidence != null &&
    (note.type !== 'reviewer_approved' || confidence < RAIL_CONFIDENCE_FLOOR);

  let prWord: { text: string; cls: string } | null = null;
  if (lw?.prNumber) {
    if (lw.mergedAt || lw.prLifecycleStatus === 'merged') prWord = { text: 'merged', cls: 'text-status-success' };
    else if (lw.prLifecycleStatus === 'closed') prWord = { text: 'closed', cls: 'text-text-muted' };
    else {
      const entry = lw.prLifecycleStatus ? PR_STATUS[lw.prLifecycleStatus] : null;
      prWord = entry ? { text: entry.label, cls: entry.cls } : { text: 'open', cls: 'text-accent-text' };
    }
  }

  // Four signals, not two (Rule D6-13). A retry dispatched before `create_pr`
  // ran leaves its parent with attempt history and no PR number; that row still
  // earns its mark and its chevron.
  if (!prWord && !showConfidence && !outcome.mark && !disclosure) return null;

  const mark = outcome.mark && (
    <span data-testid="rail-outcome-mark" className={outcome.tone ?? 'text-text-muted'}>{outcome.mark}</span>
  );

  return (
    <span className="ml-auto flex shrink-0 self-stretch items-center gap-1 font-mono text-[10px]">
      {prWord && lw?.prUrl && (
        <a
          href={lw.prUrl}
          target="_blank"
          rel="noopener noreferrer"
          onClick={e => e.stopPropagation()}
          className="text-accent-text hover:underline"
        >
          #{lw.prNumber}
        </a>
      )}
      {prWord && <span className={prWord.cls}>{prWord.text}</span>}
      {showConfidence && <span className="text-status-warning">{confidenceRaw}</span>}
      {disclosure ? (
        <button
          type="button"
          onClick={e => { e.stopPropagation(); disclosure.onToggle(); }}
          aria-expanded={disclosure.expanded}
          aria-controls={disclosure.panelId}
          data-testid="rail-attempt-toggle"
          title="Attempt history"
          className="-mr-2 flex min-w-[44px] shrink-0 items-center justify-end gap-1 self-stretch px-2 hover:text-text-secondary"
        >
          {mark}
          <span className="text-text-muted" aria-hidden="true">{disclosure.expanded ? '⌄' : '⌃'}</span>
          <span className="sr-only">{disclosure.expanded ? 'Hide' : 'Show'} attempt history</span>
        </button>
      ) : mark}
    </span>
  );
}

/** The 22px day / `now` tick (Rule D4-3). No count, no collapse, no histogram. */
function RailTickRow({ label, isNow }: { label: string; isNow: boolean }) {
  const stroke = isNow ? 'border-text-muted/60 border-dashed' : 'border-border-default';
  return (
    <div className="flex h-[22px] items-center gap-2" data-testid="rail-tick">
      <span className="flex h-full w-4 shrink-0 justify-center">
        <span className={`w-0 border-l ${stroke}`} />
      </span>
      <span className="shrink-0 font-mono text-[10px] text-text-muted">{label}</span>
      <span className={`h-px flex-1 border-t ${stroke}`} />
    </div>
  );
}

/** Gutter column: incoming edge segment, the node glyph, then the rail below. */
function RailGutter({
  edge,
  glyph,
  shape = 'circle',
  continues = true,
}: {
  edge: RailEdgeKind;
  glyph: RailGlyphSpec;
  shape?: 'circle' | 'square';
  continues?: boolean;
}) {
  return (
    <span className="flex w-4 shrink-0 flex-col items-center">
      <span className="flex h-2 items-stretch">
        <DependencyRail mode="line" edge={edge} />
      </span>
      <RailNodeGlyph state={glyph.state} shape={shape} tone={glyph.tone} pulse={glyph.pulse} title={glyph.title} />
      <span className={`w-0 flex-1 ${continues ? 'border-l border-border-default' : ''}`} />
    </span>
  );
}

/**
 * A chain row's disclosure control — the `▣N`/`▼N` badge and the title text as
 * ONE button (Rule D13-17). `membersId` is what its `aria-controls` names.
 */
type RailChainToggle = { count: number; expanded: boolean; onToggle: () => void; membersId: string };

/**
 * One rail line: optional leading chrome, the title, the right column.
 *
 * The title is a `<Link>` on a row that stands for exactly one task, and the
 * inside of a `<button>` on a chain row that stands for N (Rule D13-12/D13-17).
 * A chain row has no task link at all: it could only pick one of the N, and
 * picking the head is the defect v3 exists to remove.
 *
 * When the row carries a control — the right-column disclosure, the chain
 * toggle, or both — it grows to a 24px minimum and centre-aligns, so the
 * control can be `self-stretch` and meet WCAG 2.2 §2.5.8 without changing the
 * rhythm of rows that have no control (Rule D13-3). The title stays `flex-1`
 * and the right column stays `shrink-0` with its own padding, so the boundary
 * between them is a real gap rather than a shared pixel column (Rule D13-4).
 */
function RailTaskLine({
  task,
  prTask,
  label,
  outcome,
  disclosure,
  chain,
  lead,
  trail,
}: {
  task: CondensedTimelineTask;
  /** Source of the right column's PR number/word, when it differs from `task` — a
   * collapsed chain names the head's title but the terminal member's PR (§1.3). */
  prTask?: CondensedTimelineTask;
  label?: string;
  outcome: RailOutcome;
  disclosure: RailDisclosure | null;
  /** Set on a row with `count > 1`: badge + title become the disclosure (§13.4). */
  chain?: RailChainToggle | null;
  /** Leading chrome — an ordinal number, a `├` fork arm. Inert, never a control. */
  lead?: React.ReactNode;
  /** Trailing text that is not the right column, e.g. `after ↑ paths`. */
  trail?: React.ReactNode;
}) {
  const roomy = disclosure != null || chain != null;
  const title = railTruncate(stripTaskTypePrefix(task.title));
  return (
    <div className={`flex gap-1.5 ${roomy ? 'min-h-[24px] items-center' : 'min-h-[18px] items-baseline'}`}>
      {chain ? (
        <button
          type="button"
          onClick={e => { e.stopPropagation(); chain.onToggle(); }}
          aria-expanded={chain.expanded}
          aria-controls={chain.membersId}
          data-testid="rail-chain-toggle"
          title={`${chain.count} tasks in this chain`}
          className="flex min-w-[44px] flex-1 items-center gap-1.5 self-stretch text-left hover:text-accent-text"
        >
          <span className="shrink-0 font-mono text-[10px] text-text-muted">
            {`${chain.expanded ? '▼' : '▣'}${chain.count}`}
          </span>
          <span className="min-w-0 flex-1 truncate text-[12px] text-text-secondary">{title}</span>
          <span className="sr-only">{chain.expanded ? 'Hide' : 'Show'} the tasks in this chain</span>
        </button>
      ) : (
        <>
          {lead}
          <Link
            href={`/app/tasks/${task.id}`}
            className="min-w-0 flex-1 truncate text-[12px] text-text-secondary hover:text-accent-text"
          >
            {label ? <span className="font-mono text-text-muted">{label} </span> : null}
            {title}
          </Link>
        </>
      )}
      {trail}
      <RailRightColumn task={task} prTask={prTask} outcome={outcome} disclosure={disclosure} />
    </div>
  );
}

/**
 * The expanded attempt panel (Rule D13-7/D13-9/D13-11).
 *
 * It renders INSIDE the expanded node's own `data-rail-node` element, so the
 * gutter stroke — already `flex-1` — stretches past it and everything below
 * moves down as one block. Tick positions come from each node's server-derived
 * `ts` inside `buildRail` and cannot be touched by client expansion state
 * (Rule D13-6).
 */
function RailAttemptPanel({ id, strips }: { id: string; strips: (AttemptStripData | null)[] }) {
  return (
    <div id={id} data-testid="rail-attempt-disclosure" className="mt-0.5 pl-3 text-[10px]">
      {strips.map((strip, i) => (
        <AttemptStrip key={strip?.parentTaskId ?? i} strip={strip} hideToggle />
      ))}
    </div>
  );
}

/** A row with attempts to disclose gets a control; one with none gets no chrome. */
const railHasAttempts = (task: CondensedTimelineTask) => (task.attempts?.total ?? 0) > 0;

/**
 * The attributes `TaskPanelWrapper`'s delegated handler reads, on the smallest
 * element that stands for exactly one task (Rule D13-13/D13-16).
 *
 * The actionable predicate is `TaskRow`'s, reused rather than re-derived: a rail
 * row and a desktop row are answering the identical question,
 * and a completed task with no PR must fall through to its `<Link>` and open the
 * full page instead of an empty drawer.
 */
const railTaskAttrs = (task: CondensedTimelineTask) => ({
  'data-task-id': task.id,
  'data-task-actionable':
    task.status !== 'completed' || !!task.latestWorker?.prUrl ? 'true' : 'false',
});

/**
 * The peek scope for one rail row: its line plus its own attempt panel, and
 * nothing belonging to another task.
 *
 * `task` is null on a chain row, which stands for N tasks and therefore names
 * none — there is no single id it could offer the delegated handler, so a tap
 * inside it resolves to nothing and cannot open a sheet (Rule D1-7, D13-13).
 */
function RailRowScope({ task, children }: { task: CondensedTimelineTask | null; children: React.ReactNode }) {
  return <div {...(task ? railTaskAttrs(task) : {})}>{children}</div>;
}

/** One Lane-1 rail node — a collapsed chain, or a single task. */
function RailNodeRow({
  node,
  isLast,
  stranded,
  disclosedTaskIds,
  expandedChainIds,
}: {
  node: RailNode<CondensedTimelineTask>;
  isLast: boolean;
  stranded: (id: string) => boolean;
  disclosedTaskIds?: ReadonlySet<string>;
  expandedChainIds?: ReadonlySet<string>;
}) {
  const laneTwoTasks = [...node.siblings.map(s => s.task), ...node.hiddenSiblings];

  // Disclosure state is per row and never shared: the rail is a list, not a
  // wizard, and comparing two rows' attempt histories is a real reason to open
  // both (Rule D13-8). Row keys are prefixed because a chain's head is also its
  // own first ordinal member, and those are two independent controls (D13-10).
  const [openRows, setOpenRows] = useState<ReadonlySet<string>>(() => {
    const seeded = new Set<string>();
    if (!disclosedTaskIds?.size) return seeded;
    if (disclosedTaskIds.has(node.head.id)) seeded.add(`chain:${node.id}`);
    for (const m of node.members) if (disclosedTaskIds.has(m.id)) seeded.add(`member:${m.id}`);
    for (const t of laneTwoTasks) if (disclosedTaskIds.has(t.id)) seeded.add(`sib:${t.id}`);
    return seeded;
  });
  // Rule D13-18: the chain toggle's own onClick is the ONLY writer of this.
  // Nothing here subscribes to the address or fires on mount, so the
  // `router.replace` the task sheet performs re-renders the row without
  // touching its expansion — opening and closing a sheet from an ordinal
  // sub-row leaves the chain exactly as it was. `expandedChainIds` seeds the
  // initial value and is a fixture seam only, never a controlled prop.
  const [chainExpanded, setChainExpanded] = useState(() => expandedChainIds?.has(node.id) ?? false);
  const [forkOpen, setForkOpen] = useState(false);

  const toggleRow = (key: string) =>
    setOpenRows(prev => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  const disclosureFor = (key: string, has: boolean): RailDisclosure | null =>
    has ? { expanded: openRows.has(key), onToggle: () => toggleRow(key), panelId: `rail-attempts-${key}` } : null;

  const collapsible = node.count > 1;
  const glyph = railGlyph(node.head, { stranded: stranded(node.head.id) });
  const visibleSiblings = forkOpen
    ? [...node.siblings, ...node.hiddenSiblings.map(task => ({ task, soft: false }))]
    : node.siblings;
  const hasLaneTwo = visibleSiblings.length > 0 || node.forkHidden > 0;

  // A collapsed chain wears ONE mark: the highest-precedence outcome across its
  // members, so a reader who never expands still sees the worst thing in it
  // (Rule D7-5). Expanding moves each member's own mark onto its ordinal sub-row
  // and the chain row keeps the rollup.
  const memberOutcomes = node.members.map(railOutcome);
  const headOutcome = collapsible ? rollupRailOutcome(memberOutcomes) : (memberOutcomes[0] ?? railOutcome(node.head));
  const headKey = `chain:${node.id}`;
  // While the chain is open its members are on screen, each owning its own
  // history control; a second aggregate control re-printing exactly those panels
  // is duplicate chrome on a 360px row, so the chain row's own control folds
  // away and its rolled-up mark stays as static text (Rule D13-17). Collapsing
  // restores the control with whatever it had open (Rule D13-19).
  const chainOpen = collapsible && chainExpanded;
  const headDisclosure = chainOpen ? null : disclosureFor(headKey, headOutcome.hasAttempts);
  const headStrips = node.members.filter(railHasAttempts).map(m => m.attempts ?? null);
  const membersId = `rail-chain-${node.id}`;

  // The collapsed row names the head's title but the terminal member's PR
  // (§1.3): the last member with a PR is the one the reader would follow to
  // see the chain's outcome. Expanded ordinal sub-rows keep each member's own.
  const terminalPrTask = collapsible
    ? ([...node.members].reverse().find(m => m.latestWorker?.prNumber) ?? node.head)
    : node.head;

  return (
    // No `data-task-id` here (Rule D13-13): the delegated handler resolves
    // `closest('[data-task-id]')`, so an attribute on the unit wrapper makes
    // every tap inside it — badge, ordinal sub-row, Lane-2 sibling, panel text —
    // peek the head. It belongs on the smallest element standing for one task.
    <div className="flex items-stretch gap-2" data-rail-node="">
      <RailGutter edge={node.edge} glyph={glyph} continues={!isLast || hasLaneTwo} />

      <div className="min-w-0 flex-1 pb-1">
        <RailRowScope task={collapsible ? null : node.head}>
          <RailTaskLine
            task={node.head}
            prTask={terminalPrTask}
            outcome={headOutcome}
            disclosure={headDisclosure}
            chain={collapsible ? {
              count: node.count,
              expanded: chainExpanded,
              onToggle: () => setChainExpanded(v => !v),
              membersId,
            } : null}
          />
          {headDisclosure?.expanded && (
            <RailAttemptPanel id={headDisclosure.panelId} strips={headStrips} />
          )}
        </RailRowScope>

        {/* Ordinal sub-rows — the chain, once you ask for it (Rule D1-3). They,
            not the row above them, are this unit's navigation targets (D13-16). */}
        {chainOpen && (
          <div
            id={membersId}
            data-testid="rail-chain-members"
            className="mt-0.5 space-y-0.5 border-l border-border-default pl-3"
          >
            {node.members.map((member, i) => {
              const key = `member:${member.id}`;
              const disclosure = disclosureFor(key, railHasAttempts(member));
              return (
                <RailRowScope key={member.id} task={member}>
                  <RailTaskLine
                    task={member}
                    label={ordinalLabel(member)}
                    outcome={memberOutcomes[i]}
                    disclosure={disclosure}
                    lead={<span className="shrink-0 font-mono text-[10px] text-text-muted">{i + 1}</span>}
                  />
                  {disclosure?.expanded && (
                    <RailAttemptPanel id={disclosure.panelId} strips={[member.attempts ?? null]} />
                  )}
                </RailRowScope>
              );
            })}
          </div>
        )}

        {/* Lane 2 — fan-out siblings and the fork glyph. Retry lineage is NOT
            here: an edge answers "what had to happen before this could start",
            and a retry answers "this ran more than once" (Rule D3-5). */}
        {hasLaneTwo && (
          <div className="mt-0.5 space-y-0.5 pl-1">
            {visibleSiblings.map(({ task, soft }) => {
              const key = `sib:${task.id}`;
              const disclosure = disclosureFor(key, railHasAttempts(task));
              return (
                <RailRowScope key={task.id} task={task}>
                  <RailTaskLine
                    task={task}
                    outcome={railOutcome(task)}
                    disclosure={disclosure}
                    lead={
                      <>
                        <span className="shrink-0 font-mono text-[10px] text-text-muted" aria-hidden="true">├</span>
                        <RailNodeGlyph {...railGlyph(task, { stranded: stranded(task.id), soft })} shape="circle" />
                      </>
                    }
                    trail={soft && <span className="shrink-0 font-mono text-[10px] text-text-muted">after ↑ paths</span>}
                  />
                  {disclosure?.expanded && (
                    <RailAttemptPanel id={disclosure.panelId} strips={[task.attempts ?? null]} />
                  )}
                </RailRowScope>
              );
            })}

            {/* The fork glyph discloses in place and never opens a sheet: without
                stopPropagation the bubbled click reaches the delegated handler
                (Rule D13-14). It sits outside every row scope, so there is no
                task for that handler to resolve either. */}
            {node.forkHidden > 0 && (
              <button
                type="button"
                onClick={e => { e.stopPropagation(); setForkOpen(v => !v); }}
                aria-expanded={forkOpen}
                className="flex items-baseline gap-1.5 font-mono text-[10px] text-text-muted hover:text-text-secondary"
              >
                <span aria-hidden="true">├╮</span>
                <span>{forkOpen ? 'less' : `+${node.forkHidden}`}</span>
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** The goal root — the one square in a rail of circles (Rule D5-1). */
function RailGoalRoot({ goal }: { goal: RailGoal }) {
  const allPassed = goal.passed != null && goal.passed >= goal.total;
  return (
    <div className="flex items-stretch gap-2" data-testid="rail-goal-root">
      <span className="flex w-4 shrink-0 flex-col items-center">
        <span className="flex h-2 items-stretch">
          <DependencyRail mode="line" edge="none" />
        </span>
        <RailNodeGlyph
          state={allPassed ? 'solid' : 'empty'}
          shape="square"
          tone={allPassed ? 'text-status-success' : 'text-text-muted'}
          title="mission goal criteria"
        />
      </span>
      <span className="font-mono text-[11px] text-text-secondary">
        goal <span className="text-text-muted">{goal.passed ?? '?'} / {goal.total}</span>
      </span>
    </div>
  );
}

function MobileRail({
  groups,
  taskMap,
  goal,
  bookkeepingTasks,
  disclosedTaskIds,
  expandedChainIds,
}: {
  groups: CondensedTimelineGroups;
  taskMap?: Map<string, CondensedTask>;
  goal?: RailGoal | null;
  bookkeepingTasks: BookkeepingTask[];
  disclosedTaskIds?: ReadonlySet<string>;
  expandedChainIds?: ReadonlySet<string>;
}) {
  const model = buildRail<CondensedTimelineTask>(groups, { goal });
  const stranded = (id: string) => (taskMap ? isStrandedTask(id, taskMap) : false);

  if (model.rows.length === 0) {
    return (
      <>
        <p className="mb-6 text-[13px] italic text-text-muted">No tasks yet</p>
        <BookkeepingFooter tasks={bookkeepingTasks} />
      </>
    );
  }

  const lastNodeIndex = model.rows.map(r => r.kind).lastIndexOf('node');

  return (
    <div data-testid="mission-rail">
      {model.rows.map((row, i) => {
        if (row.kind === 'tick') return <RailTickRow key={row.id} label={row.label} isNow={row.now} />;
        if (row.kind === 'label') {
          return (
            <div key={row.id} className="pl-6 pt-2">
              <SectionLabel>{row.text}</SectionLabel>
            </div>
          );
        }
        return (
          <RailNodeRow
            key={row.id}
            node={row}
            isLast={i === lastNodeIndex && !model.goal}
            stranded={stranded}
            disclosedTaskIds={disclosedTaskIds}
            expandedChainIds={expandedChainIds}
          />
        );
      })}
      {model.goal && <RailGoalRoot goal={model.goal} />}
      <BookkeepingFooter tasks={bookkeepingTasks} />
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

  const { waitingOnYou, running, nextQueued, blocked, done, failed } = groups;

  const segmentMap = new Map(segments.map(s => [s.taskId, s]));
  const getGroupSegments = (chains: ChainUnit<CondensedTimelineTask>[]): MissionSegment[] =>
    chains.flatMap(c => [c.head, ...c.tail]).flatMap(t => { const s = segmentMap.get(t.id); return s ? [s] : []; });

  const hasTerminal = done.length > 0 || failed.length > 0;

  const runningSorted = [...running].sort((a, b) => {
    const aMs = a.head.latestWorker?.startedAt ? new Date(a.head.latestWorker.startedAt).getTime() : 0;
    const bMs = b.head.latestWorker?.startedAt ? new Date(b.head.latestWorker.startedAt).getTime() : 0;
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
          <ChainList
            chains={waitingOnYou}
            effectivePolicyTier={effectivePolicyTier}
            policyLabel={policyLabel}
          />
        </div>
      )}

      {/* ── RUNNING / NEEDS INPUT ──────────────────────────────────── */}
      {runningSorted.length > 0 && (
        <div>
          <SectionLabel>
            Running{runningSorted.some(c => c.head.latestWorker?.status === 'waiting_input') ? ' · Needs Input' : ''}
          </SectionLabel>
          <ChainList
            chains={runningSorted}
            effectivePolicyTier={effectivePolicyTier}
            policyLabel={policyLabel}
          />
        </div>
      )}

      {/* ── NEXT QUEUED ───────────────────────────────────────────── */}
      {nextQueued.length > 0 && (
        <div>
          <SectionLabel>Next queued</SectionLabel>
          <ChainList
            chains={queuedVisible}
            effectivePolicyTier={effectivePolicyTier}
            policyLabel={policyLabel}
          />

          {queuedOverflow.length > 0 && (
            <>
              {moreQueuedExpanded && (
                <div className="overflow-hidden transition-all duration-200 ease-out">
                  <ChainList
                    chains={queuedOverflow}
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
          <SectionLabel>Waiting on dependencies</SectionLabel>
          <ChainList
            chains={blocked}
            effectivePolicyTier={effectivePolicyTier}
            policyLabel={policyLabel}
          />
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
  view,
  prsMerged,
  prsOpen,
  completedTasks,
  totalTasks,
  criteriaGate,
  taskMap,
  railGoal,
  disclosedTaskIds,
  expandedChainIds,
}: CondensedTimelineProps) {
  return (
    <div className="mb-6">
      {/* Header: "View all tasks" link for completed missions */}
      {missionCompleted && allTasksCount > 0 && (
        <div className="flex items-center justify-end mb-3">
          <Link
            href={`/app/tasks?mission=${missionId}`}
            className="text-[12px] text-accent-text hover:underline"
          >
            View all tasks &rarr;
          </Link>
        </div>
      )}

      {/* Content */}
      {view === 'summary' ? (
        <SummaryView
          groups={groups}
          effectivePolicyTier={effectivePolicyTier}
          policyLabel={policyLabel}
          prsMerged={prsMerged}
          prsOpen={prsOpen}
          criteriaGate={criteriaGate}
        />
      ) : (
        <>
          {/* Below md: the rail (timeline-mobile-rail.md §10.1). Both trees are
              in the DOM and CSS picks one — the same technique the Structure tab
              uses, and the only one here that cannot hydrate differently than it
              rendered on the server. */}
          <div className="md:hidden">
            <MobileRail
              groups={groups}
              taskMap={taskMap}
              goal={railGoal}
              bookkeepingTasks={bookkeepingTasks}
              disclosedTaskIds={disclosedTaskIds}
              expandedChainIds={expandedChainIds}
            />
          </div>
          <div className="hidden md:block">
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
          </div>
        </>
      )}

      {/* View all tasks link for active missions in timeline view */}
      {allTasksCount > 0 && !missionCompleted && view === 'timeline' && (
        <div className="mt-4">
          <Link
            href={`/app/tasks?mission=${missionId}`}
            className="flex items-center gap-2 px-3 py-2.5 rounded-lg hover:bg-card-hover transition-colors group text-[13px] text-text-secondary hover:text-accent-text"
          >
            <svg className="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 6.75h12M8.25 12h12m-12 5.25h12M3.75 6.75h.007v.008H3.75V6.75zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zM3.75 12h.007v.008H3.75V12zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm-.375 5.25h.007v.008H3.75v-.008zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0z" />
            </svg>
            <span>View all tasks</span>
            <svg className="w-3.5 h-3.5 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
            </svg>
          </Link>
        </div>
      )}
    </div>
  );
}
