'use client';

/**
 * TaskActionZone: the one decision a task's phase needs, done in place
 * (knowledge-base: buildd/design/mission-feed-mobile-continuity.md W4/W6). Answer when it asks,
 * retry (or switch backend) when it failed, run now when it is queued, say why
 * when it is blocked, and give a local mission's task its `claim_task` command.
 *
 * The ONE renderer for task actions: the task sheet, the full task page and
 * the mission page's Landed drawer all mount it, and it draws exactly
 * `taskActionSet` (lib/task-actions.ts) — so no two surfaces can offer
 * different things for one task. Starting goes through `useTaskStart`
 * (refusals, Force start, switch backend, the claim that follows), retrying
 * through `requestTaskRetry`.
 *
 * Self-contained: it owns the in-flight action and its error, and calls
 * `onChanged` after a successful action so the host can refetch.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import TaskQuestion from '@/components/tasks/TaskQuestion';
import type { QuestionNoteLike } from '@/app/app/(protected)/tasks/[id]/question-hero';
import AnswerRecorded from '@/components/AnswerRecorded';
import { useAnswerSubmit } from '@/app/app/(protected)/tasks/[id]/respond/use-answer-submit';
import Spinner from '@/components/Spinner';
import ClaimTaskHint, { CLAIM_ROW_BTN } from '@/components/tasks/ClaimTaskHint';
import RunnerPicker from '@/components/tasks/RunnerPicker';
import Disclosure from '@/components/ui/Disclosure';
import type { TaskFailureKind, TaskTrouble } from '@/lib/task-failure-kind';
import { troubleLine, verificationFailedCopy, waitingOnFailedCopy } from '@/lib/task-failure-kind';
import { isSurfaceAuditTask } from '@buildd/core/surface-audit';
import { explainProviderAuthFailure } from '@/lib/provider-auth-failure';
import EntitlementBlockedNotice from '@/components/entitlements/EntitlementBlockedNotice';
import CredentialBlockedNotice from '@/components/credentials/CredentialBlockedNotice';
import type { CredentialBlock } from '@/lib/credential-block-copy';
import { parseEntitlementBlock, type EntitlementBlock } from '@buildd/shared';
import { useTaskStart } from '@/components/tasks/useTaskStart';
import WaitingLine from '@/components/tasks/WaitingLine';
import { useDisplayTimezone } from '@/components/DisplayTimezone';
import { formatInZone } from '@/lib/zoned-time';
import type { TaskPhase } from '@/lib/task-presentation';
import {
  type MissionExecutor,
  canOfferForce,
  fetchTaskWaiting,
  formatFleetStatus,
  refusalFromWaiting,
  type GateRefusal,
  type TaskWaiting,
  getGateReasonSubtitle,
  getGateBypassLabel,
  getGateReasonTitle,
  otherBackendOf,
  backendDisplayName,
  requestRetryNow,
  requestTaskCancel,
  requestTaskRetry,
  taskActionSet,
} from '@/lib/task-actions';
import type { WaitingFor } from '@buildd/shared';
import type { WaitingKind } from '@buildd/core/waiting-reason';

/** Phases that mean the agent took the answer and moved on: the confirmation stands down. */
const MOVED_ON: ReadonlySet<TaskPhase> = new Set<TaskPhase>(['running', 'completed', 'failed', 'plan_review']);

/**
 * What clears an answer's confirmation: another worker, or the agent moving
 * on. Not the question disappearing: the refetch after an answer drops it
 * (the resume path keeps the worker `waiting_input`, so the phase holds).
 */
export function answerResetKey(workerId: string | null | undefined, phase: TaskPhase): string {
  return `${workerId ?? ''}:${MOVED_ON.has(phase) ? phase : ''}`;
}

export interface TaskActionZoneProps {
  taskId: string;
  workspaceId: string;
  /** Canonical phase from `deriveTaskPhase`. */
  phase: TaskPhase;
  isBlocked: boolean;
  blockedByCount: number;
  backend: 'claude' | 'codex' | null;
  /** `excerpt` is the line shown; `raw`, when given, is the full text it is classified from. */
  lastError: { excerpt: string; raw?: string | null } | null;
  /** `classifyTaskFailure`: `verification` means the work landed and its audit failed. */
  failureKind?: TaskFailureKind | null;
  /** Set when this task IS the surface audit: a verification failure then offers "Retry the audit". */
  auditTaskId?: string | null;
  /** `classifyTaskTrouble`: waiting on a task (Start now anyway, Cancel) or buildd retrying (Retry now). */
  trouble?: TaskTrouble | null;
  /** For a `dependency` failure: the failed task it waits on (`failedDependencyOf`). */
  waitingOn?: { taskId: string; title: string | null } | null;
  worker: {
    id: string;
    waitingFor: Pick<WaitingFor, 'prompt' | 'options' | 'context' | 'recommended' | 'where'> | null;
    /** The open question note recording the same ask: its headline leads, and an answer marks it. */
    questionNote?: QuestionNoteLike | null;
  } | null;
  /** "View history" target on failure; omitted on the full page itself. */
  historyHref?: string | null;
  roleSlug?: string | null;
  /** The task's mission executor: `local` adds the `claim_task` command. */
  missionExecutor?: MissionExecutor | null;
  /** Offer runner targeting before a start (the full page only: it polls runner health). */
  runnerPicker?: boolean;
  /** The host already says why the task is waiting (the mission drawer's reason line). */
  hideQueuedNote?: boolean;
  /**
   * The plan limit a managed runner deferred this task on (task context
   * `entitlementBlock`). A queued task with one shows the entitlement state in
   * place of "Run now": it starts by itself when the limit lifts.
   */
  entitlementBlock?: EntitlementBlock | null;
  /** Why a queued task cannot be claimed: its backend has no key (task context `credentialBlock`). */
  credentialBlock?: CredentialBlock | null;
  /**
   * What the task's delivery is doing while this task row waits (the kernel's
   * reading, "Approved · checking"). The queued line then names its subject, the
   * task's next run, so it never reads as the whole delivery being unclaimed.
   */
  deliveryReading?: string | null;
  /** The task's title, named in the Force start confirmation. */
  taskTitle?: string | null;
  onChanged?: () => void | Promise<void>;
  /**
   * False inside a card that already frames the task (the mission Overview's
   * focus card, the strip drawer): the Blocked notice and the Run now group
   * drop their own boxes.
   */
  framed?: boolean;
  /**
   * The host already draws this task's question (the mission Ask banner), so
   * the zone draws none: two cards for one question each keep their own
   * answer state, and an answer in one leaves the other open to tap.
   */
  questionShownAbove?: boolean;
  /**
   * A way into the task (the strip's Task link). It joins the Run now row, at
   * that row's button size, so a local task's actions read as one row (R-39);
   * with no Run now row it closes the zone on its own row.
   */
  trailing?: ReactNode;
}

const SECONDARY_BTN = 'inline-flex min-h-11 items-center justify-center gap-1.5 border-2 border-border-strong px-3 font-mono text-meta font-medium text-text-primary hover:bg-surface-3 disabled:opacity-50';
const QUIET_BTN = 'inline-flex min-h-11 items-center px-3 font-mono text-meta text-text-secondary hover:bg-surface-3 hover:text-text-primary disabled:opacity-50';

export default function TaskActionZone({
  deliveryReading = null,
  taskId,
  workspaceId,
  phase,
  isBlocked,
  blockedByCount,
  backend,
  lastError,
  failureKind = null,
  auditTaskId = null,
  waitingOn = null,
  trouble = null,
  worker,
  historyHref,
  roleSlug,
  missionExecutor = null,
  runnerPicker = false,
  hideQueuedNote = false,
  entitlementBlock = null,
  credentialBlock = null,
  taskTitle = null,
  onChanged,
  framed = true,
  questionShownAbove = false,
  trailing = null,
}: TaskActionZoneProps) {
  const displayTz = useDisplayTimezone();
  const [retrying, setRetrying] = useState<'same' | 'switch' | null>(null);
  const [retryError, setRetryError] = useState<string | null>(null);
  const [target, setTarget] = useState('');
  const start = useTaskStart({ taskId, workspaceId, onStarted: onChanged });

  // A failed task may offer the other backend, but only one that can run it:
  // the same availability check the start gate uses. Unknown until it answers,
  // and unknown never offers the switch.
  const otherBackend = otherBackendOf(backend);
  const [otherBackendAvailable, setOtherBackendAvailable] = useState(false);
  useEffect(() => {
    // A task that never ran has no backend switch to offer (`dependency`).
    if (phase !== 'failed' || failureKind === 'dependency' || !otherBackend || !workspaceId) return;
    let cancelled = false;
    fetch(`/api/workspaces/${workspaceId}/backends`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { backends?: Array<{ id: string; available: boolean }> } | null) => {
        if (cancelled) return;
        setOtherBackendAvailable(!!d?.backends?.some((b) => b.id === otherBackend && b.available));
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [phase, failureKind, otherBackend, workspaceId]);

  const actions = taskActionSet({
    phase,
    isBlocked,
    backend,
    hasQuestion: !!worker?.waitingFor,
    hasHistory: !!historyHref,
    missionExecutor,
    otherBackendAvailable,
    failureKind,
    trouble,
  });
  const has = (id: (typeof actions)[number]) => actions.includes(id);
  // "Not logged in · Please run /login" and kin: say what to do instead.
  const authFailure = lastError ? explainProviderAuthFailure(lastError.raw ?? lastError.excerpt, backend) : null;
  const local = missionExecutor === 'local';

  // Owned here, not by the input: the refetch below drops the question, and
  // with it the input, but the answer stays on screen until the agent moves.
  const answer = useAnswerSubmit({
    workerId: worker?.id ?? null,
    taskId,
    resetKey: answerResetKey(worker?.id, phase),
    onAnswered: onChanged,
  });

  const isWaiting = phase === 'waiting_input';
  // Server-derived: answered (the question is gone) but the worker has not
  // resumed yet. Covers an answer sent from another surface too.
  const answeredAwaitingAgent = isWaiting && !!worker && !worker.waitingFor;

  const retry = useCallback(async (which: 'same' | 'switch') => {
    setRetrying(which);
    setRetryError(null);
    const out = await requestTaskRetry(taskId, which === 'switch' && otherBackend ? { backend: otherBackend } : {});
    if (out.ok) await onChanged?.();
    else setRetryError(out.error);
    setRetrying(null);
  }, [taskId, otherBackend, onChanged]);

  // Start now anyway, Cancel, Retry now: one request each, then the host refetches.
  const [acting, setActing] = useState<'cancel' | 'retry_now' | null>(null);
  const [actError, setActError] = useState<string | null>(null);
  const act = useCallback(async (which: 'cancel' | 'retry_now') => {
    setActing(which);
    setActError(null);
    const out = which === 'cancel' ? await requestTaskCancel(taskId) : await requestRetryNow(taskId);
    if (out.ok) await onChanged?.();
    else setActError(out.error);
    setActing(null);
  }, [taskId, onChanged]);

  // What holds a queued or blocked task, from the same probe /start refuses
  // on: a local mission's hand-over, coordination holds, and which
  // dependencies are declared vs incidental file-overlap ordering.
  const [waiting, setWaiting] = useState<TaskWaiting | null>(null);
  const probeWaiting = (has('run_now') || has('blocked')) && phase === 'pending';
  useEffect(() => {
    if (!probeWaiting || start.status !== 'idle') return;
    let cancelled = false;
    void fetchTaskWaiting(taskId).then(w => { if (!cancelled) setWaiting(w); });
    return () => { cancelled = true; };
  }, [probeWaiting, taskId, start.status]);
  const probed = waiting ? refusalFromWaiting(waiting) : null;
  // A local mission's task held by nothing else is just "claim it from a
  // local session": the one-line note says that, not a Held line beside it.
  const localOnly = !!probed?.waitingReasons?.length && probed.waitingReasons.every(r => r.kind === 'mission_local');
  const held = localOnly && local ? null : probed;
  const queuedHeld = start.status === 'queued' && start.waiting ? refusalFromWaiting(start.waiting) : null;

  const refusal = start.refusal;
  const starting = start.pending !== null;
  // A start refused on a plan limit is the same entitlement state, not a gate warning.
  const refusalEntitlement = refusal?.gateReason === 'entitlement_blocked' ? parseEntitlementBlock(refusal.entitlement) : null;
  const waitingOnPlan = has('run_now') && phase === 'pending' && !!entitlementBlock && start.status === 'idle';
  const showRunNow = has('run_now') && !waitingOnPlan && (start.status === 'idle' || start.status === 'starting');
  const deferredLabel = refusal?.startAt
    ? displayTz ? formatInZone(refusal.startAt, displayTz, 'time') : '…'
    : null;

  return (
    <div
      data-testid="task-action-zone"
      data-phase={phase}
      data-actions={actions.join(' ')}
      className="space-y-3 empty:hidden"
    >
      {/* A question → the task page's own question card, compact: the same
          question (its note's headline too), options, recommendation and
          own-words field, answered in place. */}
      {questionShownAbove ? null : answer.outcome || answeredAwaitingAgent ? (
        <AnswerRecorded outcome={answer.outcome} awaitingAgent={!MOVED_ON.has(phase)} />
      ) : has('answer') && worker?.waitingFor && (
        <TaskQuestion
          testId="task-sheet-question"
          variant="compact"
          taskId={taskId}
          workerId={worker.id}
          waitingFor={worker.waitingFor}
          questionNote={worker.questionNote ?? null}
          role={roleSlug}
          answer={answer}
        />
      )}

      {/* Work landed, audit failed → say so; the audit's own surface retries the audit */}
      {has('verification_failed') && (
        <div data-testid="task-verification-failed" className="space-y-3 border-2 border-status-warning p-4">
          <p className="font-mono text-meta font-semibold text-status-warning">{verificationFailedCopy().state}</p>
          <p className="font-mono text-meta text-text-secondary">{verificationFailedCopy().cause}</p>
          {retryError && <p className="font-mono text-meta text-status-error">{retryError}</p>}
          <div className="flex flex-wrap items-center gap-2">
            {auditTaskId && (
              <button
                type="button"
                data-action="retry-audit"
                disabled={retrying !== null}
                onClick={() => retry('same')}
                className={SECONDARY_BTN}
              >
                {retrying ? 'Retrying…' : 'Retry the audit'}
              </button>
            )}
            {has('history') && historyHref && (
              <Link href={historyHref} data-action="history" className={QUIET_BTN}>
                View history
              </Link>
            )}
          </div>
        </div>
      )}

      {/* Never ran: a task it depends on failed → name it, nothing of its own to retry (spec 072de598 I-14) */}
      {has('waiting_on_failed') && (() => {
        const copy = waitingOnFailedCopy(waitingOn, { requeuesItself: isSurfaceAuditTask(taskTitle ?? '') });
        return (
          <div data-testid="task-waiting-on-failed" className="space-y-3 border-2 border-status-warning p-4">
            <p className="font-mono text-meta font-semibold text-status-warning">{copy.state}</p>
            <p className="font-mono text-meta text-text-secondary [overflow-wrap:anywhere]">{copy.cause}</p>
            <div className="flex flex-wrap items-center gap-2">
              {waitingOn && (
                <Link href={`/app/tasks/${encodeURIComponent(waitingOn.taskId)}`} data-action="open_failed_dependency" className={SECONDARY_BTN}>
                  Open the failed task
                </Link>
              )}
              {has('history') && historyHref && (
                <Link href={historyHref} data-action="history" className={QUIET_BTN}>
                  View history
                </Link>
              )}
            </div>
          </div>
        );
      })()}

      {/* Failed → why + retry */}
      {has('retry') && (
        <div className="space-y-3 border-2 border-status-error p-4">
          <p className="font-mono text-meta font-semibold text-status-error">Agent failed</p>
          {authFailure && lastError ? (
            <div className="space-y-2" data-testid="task-auth-failure">
              <p className="text-body text-text-primary">{authFailure.message}</p>
              <Link href={authFailure.href} data-action="fix_credential" className="inline-flex min-h-11 md:min-h-9 items-center font-mono text-body font-medium text-accent-text hover:underline">
                {authFailure.linkLabel}
              </Link>
              <Disclosure summary="Show raw output">
                <pre className="max-h-60 overflow-auto whitespace-pre-wrap [overflow-wrap:anywhere] bg-surface-2 p-3 font-mono text-meta text-text-secondary">{lastError.raw?.trim() || lastError.excerpt}</pre>
              </Disclosure>
            </div>
          ) : lastError ? (
            <p className="break-words font-mono text-[12px] leading-relaxed text-status-error">{lastError.excerpt}</p>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            {/* Single click retries on the backend it already ran on — the
                common case. The switch is one extra click, never a menu. */}
            <button
              type="button"
              data-action="retry"
              onClick={() => retry('same')}
              disabled={retrying !== null}
              className={SECONDARY_BTN}
            >
              {retrying === 'same' ? 'Retrying…' : `Retry${backend ? ` on ${backendDisplayName(backend)}` : ''}`}
            </button>
            {has('switch_backend') && otherBackend && (
              <button
                type="button"
                data-action="switch_backend"
                onClick={() => retry('switch')}
                disabled={retrying !== null}
                className={QUIET_BTN}
                title={`Retry this task on ${backendDisplayName(otherBackend)} instead`}
              >
                {retrying === 'switch' ? 'Switching…' : `Switch to ${backendDisplayName(otherBackend)}`}
              </button>
            )}
            {has('history') && historyHref && (
              <Link href={historyHref} data-action="history" className={QUIET_BTN}>
                View history
              </Link>
            )}
          </div>
          {retryError && <p className="font-mono text-meta text-status-error">{retryError}</p>}
        </div>
      )}

      {/* Start anyway: the observed phase of an accepted request (requested / blocked on its prerequisite) */}
      {waiting?.startAnyway && start.status === 'idle' && (
        <p data-testid="task-start-anyway-status" data-phase={waiting.startAnyway.phase} role="status" className="font-mono text-eyebrow text-text-secondary [overflow-wrap:anywhere]">
          {waiting.startAnyway.label}
        </p>
      )}

      {/* Blocked — what holds it: declared dependencies vs coordination-only ordering */}
      {has('blocked') && start.status === 'idle' && held?.waitingReasons && (
        <div data-testid="task-blocked-waiting">
          <WaitingLine reasons={held.waitingReasons}>
            {waiting?.forceStart ? (
              <ForcePending />
            ) : held.canForce && (
              <button type="button" data-action="force_start_offer" onClick={() => start.present(held)} disabled={starting} className={QUIET_BTN}>
                {startsAnyway(held) ? 'Start anyway…' : 'Force start…'}
              </button>
            )}
          </WaitingLine>
        </div>
      )}
      {has('blocked') && start.status === 'idle' && !held?.waitingReasons && (
        <div data-testid="task-blocked" className={framed ? 'border border-status-warning p-4' : undefined}>
          <p className="font-mono text-[12px] font-medium text-status-warning">
            Blocked · waiting on {blockedByCount} {blockedByCount === 1 ? 'dependency' : 'dependencies'}
          </p>
          <p className="mt-1 font-mono text-[11px] text-text-muted">
            Starts when its dependencies complete.
          </p>
        </div>
      )}

      {/* What holds it and, for a buildd retry, when it resumes (R-20) */}
      {(has('start_anyway') || has('retry_now')) && (() => {
        const line = troubleLine(trouble);
        if (!line) return null;
        return (
          <p data-testid="task-trouble-line" className="text-body text-text-secondary [overflow-wrap:anywhere]">
            {line.text}
            {line.resumesAt && (
              <>
                {' '}
                <time data-testid="task-resumes-at" dateTime={line.resumesAt} suppressHydrationWarning>
                  {new Date(line.resumesAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                </time>
                .
              </>
            )}
          </p>
        );
      })()}

      {/* Waiting on another task (R-20): it starts by itself when that merges; a person may start it past the wait or drop it */}
      {has('start_anyway') && start.status === 'idle' && (
        <div data-testid="task-waiting-on-task" className="flex flex-wrap items-center gap-2">
          <button type="button" data-action="start_anyway" onClick={() => start.start({ forceOverride: true })} disabled={starting || acting !== null} className={SECONDARY_BTN}>
            {start.pending === 'start' ? 'Starting…' : 'Start now anyway'}
          </button>
          {has('cancel') && (
            <button type="button" data-action="cancel" onClick={() => act('cancel')} disabled={starting || acting !== null} className={QUIET_BTN}>
              {acting === 'cancel' ? 'Cancelling…' : 'Cancel'}
            </button>
          )}
          {actError && <p className="w-full font-mono text-meta text-status-error">{actError}</p>}
        </div>
      )}

      {/* buildd is retrying it by itself: Retry now only brings the retry forward */}
      {has('retry_now') && (
        <div data-testid="task-retry-now" className="flex flex-wrap items-center gap-2">
          <button type="button" data-action="retry_now" onClick={() => act('retry_now')} disabled={acting !== null} className={SECONDARY_BTN}>
            {acting === 'retry_now' ? 'Retrying…' : 'Retry now'}
          </button>
          {actError && <p className="w-full font-mono text-meta text-status-error">{actError}</p>}
        </div>
      )}

      {/* Queued on a plan limit → the entitlement state; it starts by itself */}
      {waitingOnPlan && entitlementBlock && <EntitlementBlockedNotice block={entitlementBlock} />}

      {/* Queued with no key for its backend → say so, with the way to add one */}
      {has('run_now') && phase === 'pending' && !waitingOnPlan && credentialBlock && <CredentialBlockedNotice block={credentialBlock} />}

      {/* Queued → run now (a local mission's task: claim it from a session first) */}
      {showRunNow && (
        <div data-testid="task-run-now" className={framed ? 'space-y-3 border border-border-default p-4' : 'space-y-2'}>
          {held?.waitingReasons ? (
            <WaitingLine reasons={held.waitingReasons}>
              {waiting?.forceStart ? (
                <ForcePending />
              ) : held.canForce && (
                <button type="button" data-action="force_start_offer" onClick={() => start.present(held)} disabled={starting} className={QUIET_BTN}>
                  {startsAnyway(held) ? 'Start anyway…' : 'Force start…'}
                </button>
              )}
            </WaitingLine>
          ) : !hideQueuedNote && <p className="font-mono text-meta text-text-secondary">
            {local
              ? 'Ready to start. Claim it from your session.'
              : deliveryReading
                ? `${deliveryReading}. The next run is waiting for a runner to claim it.`
                : 'Waiting for a runner to claim it.'}
          </p>}
          {runnerPicker && workspaceId && (
            <RunnerPicker workspaceId={workspaceId} value={target} onChange={setTarget} disabled={starting} />
          )}
          {(() => {
            const runNow = (
              <button
                type="button"
                data-action="run_now"
                onClick={() => start.start({ targetLocalUiUrl: target || undefined })}
                disabled={starting}
                className={local ? CLAIM_ROW_BTN : 'btn btn-primary min-h-11 shrink-0 md:min-h-9'}
              >
                {start.pending === 'start' ? 'Starting…' : 'Run now'}
              </button>
            );
            // A local task: Copy, Run now and Task are one row at one size (R-39).
            return has('claim_hint')
              ? <ClaimTaskHint taskId={taskId} actions={<>{runNow}{trailing}</>} />
              : <div className="flex flex-wrap items-center gap-2">{runNow}{trailing}</div>;
          })()}
        </div>
      )}

      {/* After a start the server accepted: claimed, or first in the queue. */}
      {queuedHeld?.waitingReasons && (
        <WaitingLine reasons={queuedHeld.waitingReasons}>
          {queuedHeld.canForce && !start.forced && (
            <button type="button" data-action="force_start_offer" onClick={() => start.present(queuedHeld)} disabled={starting} className={QUIET_BTN}>
              {startsAnyway(queuedHeld) ? 'Start anyway…' : 'Force start…'}
            </button>
          )}
        </WaitingLine>
      )}

      {(start.status === 'waiting' || (start.status === 'queued' && !queuedHeld) || start.status === 'accepted') && (
        <div data-testid="task-start-status" data-status={start.status} role="status" className="flex flex-col gap-2 border border-border-default p-4">
          <div className="flex items-center gap-3">
            {start.status === 'accepted'
              ? <span aria-hidden="true" className="font-mono text-status-success">✓</span>
              : <Spinner size="sm" className={start.status === 'queued' ? 'text-status-warning' : 'text-status-success'} aria-label="Start requested" />}
            <div className="font-mono">
              <p className="text-meta font-medium text-text-primary">
                {start.status === 'accepted' ? 'Task started' : start.forced ? (start.forced.gates.includes('Declared dependency') ? 'Start anyway requested' : 'Force start requested') : start.status === 'queued' ? 'Queued at front' : 'Start requested'}
              </p>
              <p className="text-eyebrow text-text-secondary">
                {start.status === 'accepted'
                  ? 'A runner picked it up.'
                  : start.forced
                    ? (start.forced.gates.includes('Declared dependency')
                      ? 'The agent assesses what can proceed before building. The dependency stays in place.'
                      : `Skipping: ${start.forced.gates.join(', ')}. Starts next.`)
                    : start.status === 'queued'
                      ? 'No runner has responded. It’s next in the queue.'
                      : 'Waiting for a runner.'}
              </p>
            </div>
          </div>
          {start.forced && start.status !== 'accepted' && <RailsRemaining rails={start.forced.railsRemaining} />}
          {start.status === 'queued' && formatFleetStatus(start.fleet, roleSlug) && (
            <p className="font-mono text-eyebrow text-status-warning">
              {formatFleetStatus(start.fleet, roleSlug)}
            </p>
          )}
        </div>
      )}

      {/* A refused start: why, and what a person may do about it, in place. */}
      {start.status === 'gated' && refusalEntitlement && (
        <EntitlementBlockedNotice block={refusalEntitlement} onLeaveQueued={start.dismiss} />
      )}
      {start.status === 'gated' && refusal?.gateReason === 'coordination_hold' && (
        <CoordinationRefusal
          refusal={refusal}
          pending={start.pending}
          taskTitle={taskTitle}
          onForce={(kinds) => refusal.reasonsDigest && start.start({ force: { kinds, reasonsDigest: refusal.reasonsDigest, ...seenDeclared(refusal) }, targetLocalUiUrl: target || undefined })}
          onCancel={start.dismiss}
        />
      )}
      {start.status === 'gated' && refusal && !refusalEntitlement && refusal.gateReason !== 'coordination_hold' && (
        <div data-testid="task-start-refusal" data-gate={refusal.gateReason} className="space-y-3 border border-status-warning p-4">
          <div>
            <p className="mb-1 font-mono text-meta font-medium text-status-warning">
              {getGateReasonTitle(refusal, { deferredStartLabel: deferredLabel })}
            </p>
            <p className="font-mono text-eyebrow text-text-muted">
              {getGateReasonSubtitle(refusal, { blockingCount: refusal.blockingDeps?.length })}
            </p>
            {refusal.gateReason === 'unmerged_dep_pr' && (refusal.blockingDeps?.length ?? 0) > 0 && (
              <ul className="mt-2 space-y-1">
                {refusal.blockingDeps!.map((dep, i) => (
                  <li key={i} className="font-mono text-eyebrow">
                    {dep.taskTitle && <span className="mr-1.5 text-text-secondary">{dep.taskTitle}</span>}
                    {dep.prUrl
                      ? <a href={dep.prUrl} target="_blank" rel="noopener noreferrer" className="text-accent-text hover:underline">PR #{dep.prNumber ?? '?'} ↗</a>
                      : <span className="text-text-muted">No PR URL</span>}
                  </li>
                ))}
              </ul>
            )}
            {canOfferForce(refusal) && formatFleetStatus(start.fleet, roleSlug) && (
              <p className="mt-2 font-mono text-eyebrow text-text-muted">
                {formatFleetStatus(start.fleet, roleSlug)}
              </p>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {refusal.gateReason === 'capability_mismatch' && (refusal.availableBackends ?? []).map(b => (
              <button key={b} type="button" data-action="switch_and_start" onClick={() => start.switchBackendAndStart(b)} disabled={starting} className={SECONDARY_BTN}>
                {start.pending === 'switch' ? 'Switching…' : `Switch to ${b === 'claude' ? 'Claude (default)' : backendDisplayName(b)} and start`}
              </button>
            ))}
            {canOfferForce(refusal) && (
              <button
                type="button"
                data-action="force_start"
                onClick={() => start.start({ forceOverride: true, targetLocalUiUrl: target || undefined })}
                disabled={starting}
                className="min-h-11 border-2 border-status-warning bg-status-warning px-3 font-mono text-meta font-medium text-white hover:opacity-90 disabled:opacity-50"
              >
                {start.pending === 'force' ? 'Starting…' : getGateBypassLabel(refusal)}
              </button>
            )}
            <button type="button" onClick={start.dismiss} disabled={starting} className={QUIET_BTN}>
              {canOfferForce(refusal) ? 'Cancel' : 'Close'}
            </button>
          </div>
        </div>
      )}

      {!showRunNow && trailing && <div className="flex flex-wrap items-center gap-2">{trailing}</div>}

      {start.status === 'failed' && start.error && (
        <div className="flex flex-wrap items-center gap-2">
          <p role="alert" className="font-mono text-meta text-status-error">{start.error}</p>
          <button type="button" onClick={start.dismiss} className={QUIET_BTN}>Try again</button>
        </div>
      )}
    </div>
  );
}

/** The refusal's forceable set includes a declared dependency: the action is Start anyway (spec 36df686b). */
function startsAnyway(refusal: GateRefusal | null | undefined): boolean {
  return !!refusal?.force?.kinds?.includes('dep_declared');
}

/** The declared blockers the person saw: a prerequisite that clears meanwhile is not a reason to confirm again. */
function seenDeclared(refusal: GateRefusal): { seenBlockers?: string[] } {
  const ids = (refusal.waitingReasons ?? []).filter(r => r.kind === 'dep_declared' && r.blocker).map(r => r.blocker!.id);
  return ids.length > 0 ? { seenBlockers: ids } : {};
}

/** An unexpired Force start awaiting its runner claim. */
function ForcePending() {
  return (
    <p data-testid="task-force-pending" className="font-mono text-eyebrow text-text-secondary">
      Force start requested. Starts next.
    </p>
  );
}

function RailsRemaining({ rails }: { rails: string[] }) {
  if (rails.length === 0) return null;
  return (
    <div className="font-mono text-eyebrow text-text-muted">
      <p className="text-text-secondary">Still enforced:</p>
      <ul className="list-disc space-y-0.5 pl-4">
        {rails.map(r => <li key={r}>{r}</li>)}
      </ul>
    </div>
  );
}

/**
 * A start a coordination gate holds: the canonical waiting line, then the
 * Force start confirmation in the exact §7.3 shape (docs/specs/force-start.md):
 * a pre-checked checklist naming each gate it skips, what stays enforced, the
 * overlap risk, any red line (migration numbering), and that the override is
 * recorded. One press lifts every ticked gate. A wait no force can lift says
 * so and offers nothing.
 */
export function CoordinationRefusal({ refusal, pending, onForce, onCancel, taskTitle = null }: {
  refusal: GateRefusal;
  pending: string | null;
  onForce: (kinds: WaitingKind[]) => void;
  onCancel: () => void;
  taskTitle?: string | null;
}) {
  const busy = pending !== null;
  const offer = refusal.force ?? null;
  const items = offer?.checklist ?? [];
  const [unticked, setUnticked] = useState<ReadonlySet<number>>(new Set());
  const kinds = items.length > 0
    ? [...new Set(items.filter((_, i) => !unticked.has(i)).map(c => c.kind))]
    : (offer?.kinds ?? []);
  const anyway = startsAnyway(refusal);
  return (
    <div data-testid="task-start-refusal" data-gate="coordination_hold" className="space-y-3">
      {refusal.reasonsChanged && (
        <p role="status" className="font-mono text-eyebrow text-status-warning">What holds this task changed since you looked. Review it again.</p>
      )}
      {refusal.waitingReasons && <WaitingLine reasons={refusal.waitingReasons} />}
      {canOfferForce(refusal) && offer ? (
        <div data-testid="task-force-confirm" className="space-y-2 border border-status-warning p-3 font-mono text-eyebrow">
          <p className="text-meta font-medium text-text-primary [overflow-wrap:anywhere]">
            {anyway ? `Start${taskTitle ? ` “${taskTitle}”` : ''} anyway?` : `Force start${taskTitle ? ` “${taskTitle}”` : ''}?`}
          </p>
          {items.length > 1 ? (
            <fieldset className="space-y-1">
              <legend className="text-text-secondary">Skips:</legend>
              {items.map((c, i) => (
                <label key={`${c.kind}-${i}`} data-testid="task-force-skip" data-kind={c.kind} className="flex min-h-11 items-start gap-2 text-text-secondary md:min-h-0">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={!unticked.has(i)}
                    onChange={() => setUnticked(prev => {
                      const next = new Set(prev);
                      if (next.has(i)) next.delete(i); else next.add(i);
                      return next;
                    })}
                  />
                  <span className="[overflow-wrap:anywhere]"><span className="text-text-primary">{c.gate}</span>: {c.sentence}.</span>
                </label>
              ))}
            </fieldset>
          ) : (
            <p data-testid="task-force-skip" data-kind={items[0]?.kind} className="text-text-secondary [overflow-wrap:anywhere]">
              <span className="text-text-primary">Skips:</span> {items[0] ? `${items[0].gate}: ${items[0].sentence}.` : offer.gates.join(', ')}
            </p>
          )}
          <RailsRemaining rails={offer.railsRemaining} />
          {offer.risk && <p className="text-text-secondary"><span className="text-text-primary">Risk:</span> {offer.risk}.</p>}
          {(offer.redLines ?? []).map(line => (
            <p key={line} data-testid="task-force-red-line" className="text-status-error [overflow-wrap:anywhere]">{line}</p>
          ))}
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              data-action="force_start"
              onClick={() => onForce(kinds)}
              disabled={busy || !refusal.reasonsDigest || kinds.length === 0}
              className="min-h-11 border-2 border-status-warning bg-status-warning px-3 font-mono text-meta font-medium text-white hover:opacity-90 disabled:opacity-50"
            >
              {anyway ? (pending === 'force' ? 'Starting…' : 'Start anyway') : (pending === 'force' ? 'Force starting…' : 'Force start')}
            </button>
            <button type="button" onClick={onCancel} disabled={busy} className={QUIET_BTN}>Keep waiting</button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          {refusal.notForceable && refusal.notForceable.length > 0 && (
            <p className="font-mono text-eyebrow text-text-muted">Can&apos;t be forced: {refusal.notForceable.join(', ')}.</p>
          )}
          <button type="button" onClick={onCancel} disabled={busy} className={QUIET_BTN}>Close</button>
        </div>
      )}
    </div>
  );
}
