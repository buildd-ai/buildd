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
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import WorkerRespondInput from '@/components/WorkerRespondInput';
import AnswerRecorded from '@/components/AnswerRecorded';
import { useAnswerSubmit } from '@/app/app/(protected)/tasks/[id]/respond/use-answer-submit';
import Spinner from '@/components/Spinner';
import ClaimTaskHint from '@/components/tasks/ClaimTaskHint';
import RunnerPicker from '@/components/tasks/RunnerPicker';
import Disclosure from '@/components/ui/Disclosure';
import type { TaskFailureKind } from '@/lib/task-failure-kind';
import { verificationFailedCopy } from '@/lib/task-failure-kind';
import { explainProviderAuthFailure } from '@/lib/provider-auth-failure';
import EntitlementBlockedNotice from '@/components/entitlements/EntitlementBlockedNotice';
import { parseEntitlementBlock, type EntitlementBlock } from '@buildd/shared';
import { useTaskStart } from '@/components/tasks/useTaskStart';
import { useDisplayTimezone } from '@/components/DisplayTimezone';
import { formatInZone } from '@/lib/zoned-time';
import type { TaskPhase } from '@/lib/task-presentation';
import {
  type MissionExecutor,
  canOfferForce,
  formatFleetStatus,
  getGateReasonSubtitle,
  getGateReasonTitle,
  otherBackendOf,
  backendDisplayName,
  requestTaskRetry,
  taskActionSet,
} from '@/lib/task-actions';
import type { WaitingFor } from '@buildd/shared';

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
  worker: { id: string; waitingFor: Pick<WaitingFor, 'prompt' | 'options' | 'context'> | null } | null;
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
  onChanged?: () => void | Promise<void>;
}

const SECONDARY_BTN = 'inline-flex min-h-11 items-center justify-center gap-1.5 border-2 border-border-strong px-3 font-mono text-meta font-medium text-text-primary hover:bg-surface-3 disabled:opacity-50';
const QUIET_BTN = 'inline-flex min-h-11 items-center px-3 font-mono text-meta text-text-secondary hover:bg-surface-3 hover:text-text-primary disabled:opacity-50';

export default function TaskActionZone({
  taskId,
  workspaceId,
  phase,
  isBlocked,
  blockedByCount,
  backend,
  lastError,
  failureKind = null,
  auditTaskId = null,
  worker,
  historyHref,
  roleSlug,
  missionExecutor = null,
  runnerPicker = false,
  hideQueuedNote = false,
  entitlementBlock = null,
  onChanged,
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
    if (phase !== 'failed' || !otherBackend || !workspaceId) return;
    let cancelled = false;
    fetch(`/api/workspaces/${workspaceId}/backends`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { backends?: Array<{ id: string; available: boolean }> } | null) => {
        if (cancelled) return;
        setOtherBackendAvailable(!!d?.backends?.some((b) => b.id === otherBackend && b.available));
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [phase, otherBackend, workspaceId]);

  const actions = taskActionSet({
    phase,
    isBlocked,
    backend,
    hasQuestion: !!worker?.waitingFor,
    hasHistory: !!historyHref,
    missionExecutor,
    otherBackendAvailable,
    failureKind,
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

  const refusal = start.refusal;
  const starting = start.pending !== null;
  // A start refused on a plan limit is the same entitlement state, not a gate warning.
  const refusalEntitlement = refusal?.gateReason === 'entitlement_blocked' ? parseEntitlementBlock(refusal.entitlement) : null;
  const waitingOnPlan = has('run_now') && phase === 'pending' && !!entitlementBlock && start.status === 'idle';
  const showRunNow = has('run_now') && !waitingOnPlan && (start.status === 'idle' || start.status === 'starting');
  const cap = refusal?.cap ?? 3;
  const [capTarget, setCapTarget] = useState<number | null>(null);
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
      {/* Needs input → respond inline */}
      {answer.outcome || answeredAwaitingAgent ? (
        <AnswerRecorded outcome={answer.outcome} awaitingAgent={!MOVED_ON.has(phase)} />
      ) : has('answer') && worker?.waitingFor && (
        <div className="border-2 border-status-warning p-4">
          <span className="font-mono text-[11px] font-semibold uppercase tracking-wider text-status-warning">Needs input</span>
          <WorkerRespondInput
            workerId={worker.id}
            taskId={taskId}
            question={worker.waitingFor.prompt}
            options={worker.waitingFor.options}
            context={worker.waitingFor.context}
            answer={answer}
          />
        </div>
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

      {/* Failed → why + retry */}
      {has('retry') && (
        <div className="space-y-3 border-2 border-status-error p-4">
          <p className="font-mono text-meta font-semibold text-status-error">Worker failed</p>
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

      {/* Blocked — dep gate not satisfied */}
      {has('blocked') && (
        <div className="border border-status-warning p-4">
          <p className="font-mono text-[12px] font-medium text-status-warning">
            Blocked · waiting on {blockedByCount} {blockedByCount === 1 ? 'dependency' : 'dependencies'}
          </p>
          <p className="mt-1 font-mono text-[11px] text-text-muted">
            Starts when its dependencies complete.
          </p>
        </div>
      )}

      {/* Queued on a plan limit → the entitlement state; it starts by itself */}
      {waitingOnPlan && entitlementBlock && <EntitlementBlockedNotice block={entitlementBlock} />}

      {/* Queued → run now (a local mission's task: claim it from a session first) */}
      {showRunNow && (
        <div className="space-y-3 border border-border-default p-4">
          {!hideQueuedNote && <p className="font-mono text-meta text-text-secondary">
            {local
              ? "Waiting for a local session to claim it. Runners never pick up this mission's tasks."
              : 'Waiting for a runner to claim it.'}
          </p>}
          {has('claim_hint') && <ClaimTaskHint taskId={taskId} />}
          {runnerPicker && workspaceId && (
            <RunnerPicker workspaceId={workspaceId} value={target} onChange={setTarget} disabled={starting} />
          )}
          <button
            type="button"
            data-action="run_now"
            onClick={() => start.start({ targetLocalUiUrl: target || undefined })}
            disabled={starting}
            className={local ? SECONDARY_BTN : 'btn btn-primary min-h-11 shrink-0'}
          >
            {start.pending === 'start' ? 'Starting…' : 'Run now'}
          </button>
        </div>
      )}

      {/* After a start the server accepted: claimed, or first in the queue. */}
      {(start.status === 'waiting' || start.status === 'queued' || start.status === 'accepted') && (
        <div data-testid="task-start-status" data-status={start.status} role="status" className="flex flex-col gap-2 border border-border-default p-4">
          <div className="flex items-center gap-3">
            {start.status === 'accepted'
              ? <span aria-hidden="true" className="font-mono text-status-success">✓</span>
              : <Spinner size="sm" className={start.status === 'queued' ? 'text-status-warning' : 'text-status-success'} aria-label="Start requested" />}
            <div className="font-mono">
              <p className="text-meta font-medium text-text-primary">
                {start.status === 'accepted' ? 'Task started' : start.status === 'queued' ? 'Queued at front' : 'Start requested'}
              </p>
              <p className="text-eyebrow text-text-secondary">
                {start.status === 'accepted'
                  ? 'A worker claimed the task.'
                  : start.status === 'queued'
                    ? 'No runner has responded. The task is first in the queue and starts on the next claim cycle.'
                    : 'Waiting for a worker to claim it.'}
              </p>
            </div>
          </div>
          {start.status === 'queued' && start.fleet && (
            <p className={`border border-border-default bg-surface-3 p-2 font-mono text-eyebrow ${start.fleet.count === 0 ? 'text-status-warning' : 'text-text-secondary'}`}>
              {formatFleetStatus(start.fleet, roleSlug)}
            </p>
          )}
        </div>
      )}

      {/* A refused start: why, and what a person may do about it, in place. */}
      {start.status === 'gated' && refusalEntitlement && (
        <EntitlementBlockedNotice block={refusalEntitlement} onLeaveQueued={start.dismiss} />
      )}
      {start.status === 'gated' && refusal && !refusalEntitlement && (
        <div data-testid="task-start-refusal" data-gate={refusal.gateReason} className="space-y-3 border border-status-warning p-4">
          <div>
            <p className="mb-1 font-mono text-meta font-medium text-status-warning">
              {getGateReasonTitle(refusal, { deferredStartLabel: deferredLabel })}
            </p>
            <p className="font-mono text-eyebrow text-text-muted">
              {getGateReasonSubtitle(refusal, { blockingCount: refusal.blockingDeps?.length })}
            </p>
            {refusal.error && refusal.error !== getGateReasonSubtitle(refusal) && (
              <p className="mt-1 font-mono text-eyebrow text-text-secondary">{refusal.error}</p>
            )}
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
            {canOfferForce(refusal) && start.fleet && (
              <p className="mt-2 border border-border-default bg-surface-3 p-2 font-mono text-eyebrow text-text-muted">
                {formatFleetStatus(start.fleet, roleSlug)}
              </p>
            )}
          </div>
          {refusal.gateReason === 'workspace_cap_reached' && (
            <div className="flex flex-wrap items-center gap-2 font-mono text-meta">
              <span className="text-text-secondary">Raise the workspace limit to</span>
              <div className="inline-flex shrink-0 items-center gap-2">
                <button type="button" aria-label="Lower" onClick={() => setCapTarget(t => Math.max(cap + 1, (t ?? cap + 1) - 1))} disabled={starting} className="min-h-11 min-w-11 border border-border-default disabled:opacity-40">−</button>
                <span className="w-8 text-center tabular-nums text-text-primary">{capTarget ?? cap + 1}</span>
                <button type="button" aria-label="Raise" onClick={() => setCapTarget(t => Math.min(20, (t ?? cap + 1) + 1))} disabled={starting} className="min-h-11 min-w-11 border border-border-default disabled:opacity-40">+</button>
              </div>
              <button type="button" data-action="raise_cap" onClick={() => start.raiseCapAndStart(capTarget ?? cap + 1)} disabled={starting} className={SECONDARY_BTN}>
                {start.pending === 'cap' ? 'Updating…' : 'Save & start'}
              </button>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            {refusal.gateReason === 'capability_mismatch' && (refusal.availableBackends ?? []).map(b => (
              <button key={b} type="button" data-action="switch_and_start" onClick={() => start.switchBackendAndStart(b)} disabled={starting} className={SECONDARY_BTN}>
                {start.pending === 'switch' ? 'Switching…' : `Switch to ${b === 'claude' ? 'Claude (default)' : backendDisplayName(b)} and start`}
              </button>
            ))}
            {refusal.gateReason === 'workspace_cap_reached' && refusal.canExempt && (
              <button type="button" data-action="cap_exempt" onClick={() => start.start({ capExempt: true })} disabled={starting} className={SECONDARY_BTN}>
                {start.pending === 'exempt' ? 'Starting…' : 'Start anyway (this once)'}
              </button>
            )}
            {canOfferForce(refusal) && (
              <button
                type="button"
                data-action="force_start"
                onClick={() => start.start({ forceOverride: true, targetLocalUiUrl: target || undefined })}
                disabled={starting}
                className="min-h-11 border-2 border-status-warning bg-status-warning px-3 font-mono text-meta font-medium text-white hover:opacity-90 disabled:opacity-50"
              >
                {start.pending === 'force' ? 'Force starting…' : refusal.gateReason === 'deferred_start' ? 'Start now anyway' : 'Force start'}
              </button>
            )}
            <button type="button" onClick={start.dismiss} disabled={starting} className={QUIET_BTN}>
              {refusal.gateReason === 'workspace_cap_reached' ? 'Leave queued' : canOfferForce(refusal) ? 'Cancel' : 'Close'}
            </button>
          </div>
        </div>
      )}

      {start.status === 'failed' && start.error && (
        <div className="flex flex-wrap items-center gap-2">
          <p role="alert" className="font-mono text-meta text-status-error">{start.error}</p>
          <button type="button" onClick={start.dismiss} className={QUIET_BTN}>Try again</button>
        </div>
      )}
    </div>
  );
}
