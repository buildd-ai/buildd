'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { subscribeToChannel, unsubscribeFromChannel, CHANNEL_PREFIX } from '@/lib/pusher-client';
import WorkerActivityTimeline, { collapseWorkspacePath, ageLabel } from './WorkerActivityTimeline';
import ModelUsagePanel from './ModelUsagePanel';
import NowStrip, { PausedBar } from './NowStrip';
import StatRow, { formatTokens } from './StatRow';
import QuestionHero from './QuestionHero';
import { buildAgentTree, flattenAgentTree, type AgentProgressEntry } from '@/lib/agent-tree';
import { requestRefresh, flushRefresh } from './coalesced-refresh';
import { formatElapsed } from './format-elapsed';
import { deriveNow, touchedFiles, countToolCalls, formatOffset } from './task-activity';
import { unifyWorkerQuestion, type QuestionNoteLike } from './question-hero';
import type { WorkerMilestone, WorkerWaitingFor } from '@buildd/core/db/schema';

// Exported for testing: whether a worker-channel event should bypass the
// debounce. A status change (e.g. running -> waiting_input) is a one-off
// transition and must be seen right away; a same-status progress tick is the
// steady ~10s heartbeat and should coalesce with TaskAutoRefresh's own
// refresh for the same PATCH instead of doubling it.
export function shouldFlushImmediately(previousStatus: string, nextStatus: string | undefined): boolean {
  return typeof nextStatus === 'string' && nextStatus !== previousStatus;
}

// Exported for testing: extracts a server error message from a fetch
// Response, tolerating a non-JSON or empty body instead of throwing past the
// caller's own error handling.
export async function parseErrorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const data = await res.json();
    if (data && typeof data.error === 'string') return data.error;
  } catch {
    // non-JSON body — fall back
  }
  return fallback;
}

/** Elapsed as a clock (`4:21`) under ten hours, compact units beyond. */
export function elapsedLabel(ms: number): string {
  return ms < 10 * 3_600_000 ? formatOffset(ms) : formatElapsed(ms);
}

interface Worker {
  id: string;
  name: string;
  branch: string;
  status: string;
  currentAction: string | null;
  milestones: WorkerMilestone[];
  turns: number;
  costUsd: string | null;
  inputTokens: number;
  outputTokens: number;
  startedAt: string | null;
  prUrl: string | null;
  prNumber: number | null;
  prLifecycleStatus?: string | null;
  localUiUrl: string | null;
  commitCount: number | null;
  filesChanged: number | null;
  linesAdded: number | null;
  linesRemoved: number | null;
  lastCommitSha: string | null;
  waitingFor: WorkerWaitingFor | null;
  instructionHistory: Array<{ message: string; timestamp: number; type: 'instruction' | 'response'; deliveryState?: 'pending' | 'delivered' }>;
  pendingInstructions: string | null;
  updatedAt: string | null;
  account?: { authType: string } | null;
  resultMeta?: {
    stopReason: string | null;
    terminalReason?: string | null;
    durationMs: number;
    durationApiMs: number;
    numTurns: number;
    modelUsage: Record<string, { inputTokens: number; outputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number; costUSD: number }>;
    permissionDenials?: Array<{ tool: string; reason: string }>;
  } | null;
}

interface Props {
  initialWorker: Worker;
  /**
   * Keys the coalesced-refresh debounce — must match the taskId TaskAutoRefresh
   * uses on the same page so their refreshes for the same PATCH collapse into
   * one instead of two.
   */
  taskId: string;
  statusColors?: Record<string, string>;
  /**
   * The tier this task was assigned (`Premium` / `Standard` / `Budget`, or
   * `Pinned`). Prefixes the Model Usage panel so the model that was *asked for*
   * and the models that actually *ran* can be read in one glance.
   */
  modelTier?: string | null;
  /**
   * The open question note recording the same ask as `waitingFor`, if any. It
   * supplies the short headline, the explanation and the recommended choice,
   * and is marked answered alongside the worker — one question, one surface.
   */
  questionNote?: (QuestionNoteLike & { createdAt?: string | Date | null }) | null;
  /** Role name of the asking agent ("Builder"), for "The builder asks". */
  roleName?: string | null;
  /** Injectable clock for deterministic renders (tests). */
  nowMs?: number;
}

// Entries carry optional agentId/parentAgentId (SDK v0.3.202+) so nested agent
// trees can be reconstructed; see @/lib/agent-tree.
type TaskProgressEntry = AgentProgressEntry;

export default function RealTimeWorkerView({ initialWorker, taskId, modelTier, questionNote = null, roleName = null, nowMs: nowProp }: Props) {
  const router = useRouter();
  const [worker, setWorker] = useState<Worker>(initialWorker);
  const lastStatusRef = useRef(initialWorker.status);
  const [answerSending, setAnswerSending] = useState<string | null>(null);
  const [answerSent, setAnswerSent] = useState(false);
  // Set only when the answer became a COLD continuation — a new task to link
  // to. A resume returns the same task the reader is already on, so there is
  // no second task to point at and this stays null.
  const [continuationTaskId, setContinuationTaskId] = useState<string | null>(null);
  const [answerError, setAnswerError] = useState<{ message: string; credentialRevoked?: boolean } | null>(null);
  // What the server said it did with the answer — resumed the parked session,
  // or fell back to a continuation and why. Never invent this client-side: the
  // path is the server's decision, and a wrong caption is the silent
  // degradation this whole flow exists to avoid.
  const [answerOutcome, setAnswerOutcome] = useState<string | null>(null);
  const answeredPromptRef = useRef<string | null>(null);
  const [showMetricsDetail, setShowMetricsDetail] = useState(false);
  const [taskProgress, setTaskProgress] = useState<TaskProgressEntry[]>([]);

  // When the server component re-renders (via router.refresh()), pick up fresh
  // worker data from the updated initialWorker prop.
  useEffect(() => {
    const newPrompt = initialWorker.waitingFor?.prompt ?? null;
    if (answeredPromptRef.current && newPrompt !== answeredPromptRef.current) {
      answeredPromptRef.current = null;
      setAnswerSent(false);
    }
    setWorker(initialWorker);
    lastStatusRef.current = initialWorker.status;
  // updatedAt changes on every PATCH — use it as the dep to avoid stale closures
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialWorker.id, initialWorker.updatedAt]);

  // Subscribe to real-time updates
  useEffect(() => {
    const channelName = `${CHANNEL_PREFIX}worker-${worker.id}`;
    const channel = subscribeToChannel(channelName);

    if (channel) {
      // Thin-event handler: events now carry only {workerId, taskId, status,
      // updatedAt, taskProgress?}. The full worker row is fetched by the server
      // component when router.refresh() re-renders the page.
      const handleUpdate = (data: { workerId?: string; taskId?: string; status?: string; updatedAt?: string; taskProgress?: TaskProgressEntry[] }) => {
        // taskProgress is transient (not persisted) — consume it directly from event
        if (Array.isArray(data.taskProgress)) {
          setTaskProgress(data.taskProgress);
        } else {
          setTaskProgress([]);
        }
        // A status change (e.g. running -> waiting_input) must be seen right
        // away; a same-status progress tick coalesces with TaskAutoRefresh's
        // own refresh for the same PATCH instead of doubling it.
        const immediate = shouldFlushImmediately(lastStatusRef.current, data.status);
        if (typeof data.status === 'string') lastStatusRef.current = data.status;
        if (immediate) {
          flushRefresh(router, taskId);
        } else {
          requestRefresh(router, taskId);
        }
      };
      // worker:completed/failed are always terminal — refresh immediately.
      const handleTerminal = (data: { workerId?: string; taskId?: string; status?: string; updatedAt?: string; taskProgress?: TaskProgressEntry[] }) => {
        if (Array.isArray(data.taskProgress)) {
          setTaskProgress(data.taskProgress);
        } else {
          setTaskProgress([]);
        }
        if (typeof data.status === 'string') lastStatusRef.current = data.status;
        flushRefresh(router, taskId);
      };

      channel.bind('worker:progress', handleUpdate);
      channel.bind('worker:completed', handleTerminal);
      channel.bind('worker:failed', handleTerminal);

      return () => {
        channel.unbind('worker:progress', handleUpdate);
        channel.unbind('worker:completed', handleTerminal);
        channel.unbind('worker:failed', handleTerminal);
        unsubscribeFromChannel(channelName);
      };
    } else {
      console.warn('[RealTimeWorkerView] No channel returned - Pusher not configured?');
    }
  }, [worker.id, taskId, router]);

  const noteId = questionNote?.id ?? null;

  // Send the answer via the respond endpoint, which decides between resuming
  // this worker's own parked session and starting a cold continuation — and
  // says which it did. The runner aborts the session when a question is asked,
  // but the transcript and the worktree survive, so a resume is possible
  // whenever the runner holding them is still reporting. See
  // docs/specs/answered-question-resume.md. The response's `message` is the
  // owner-facing sentence for whichever path ran.
  const handleAnswer = useCallback(async (option: string) => {
    setAnswerSending(option);
    setAnswerError(null);
    try {
      const res = await fetch(`/api/workers/${worker.id}/respond`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: option }),
      });
      const data = await res.json();
      if (!res.ok) {
        // A known-revoked backend credential is refused here rather than
        // silently dispatched into a continuation that would just fail again
        // — the question stays open (waitingFor is untouched server-side) so
        // this can be retried once the credential is reconnected.
        setAnswerError({
          message: data.error || 'Failed to send answer',
          credentialRevoked: data.credentialRevoked === true,
        });
        return;
      }
      // The same ask recorded as a question note is answered too, so the task
      // stops reading "Waiting on you". The worker already has the answer via
      // /respond, so this is bookkeeping only — never a second delivery.
      if (noteId) {
        await fetch(`/api/tasks/${taskId}/notes/${noteId}/reply`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: option }),
        }).catch(() => {});
      }
      setAnswerOutcome(typeof data?.message === 'string' ? data.message : 'Answer sent.');
      answeredPromptRef.current = worker.waitingFor?.prompt ?? null;
      // Only a cold continuation has a SEPARATE task worth linking to.
      setContinuationTaskId(
        data?.path === 'cold_continuation' && typeof data.taskId === 'string' ? data.taskId : null,
      );
      setAnswerSent(true);
    } catch (err) {
      console.error('Failed to send answer:', err);
      setAnswerError({ message: err instanceof Error ? err.message : 'Failed to send answer' });
    } finally {
      setAnswerSending(null);
    }
  }, [worker.id, worker.waitingFor?.prompt, noteId, taskId]);

  const nowMs = nowProp ?? Date.now();
  const isActive = ['running', 'starting', 'waiting_input'].includes(worker.status);
  const milestones = worker.milestones || [];
  const startMs = worker.startedAt ? new Date(worker.startedAt).getTime() : null;
  const now = deriveNow(milestones, {
    status: worker.status,
    currentAction: worker.currentAction,
    prUrl: worker.prUrl,
    startMs,
    nowMs,
  });
  const elapsed = startMs != null ? elapsedLabel(nowMs - startMs) : null;
  const tokens = (worker.inputTokens || 0) + (worker.outputTokens || 0);
  const touched = touchedFiles(milestones);
  const touchedAdd = touched.rows.reduce((s, r) => s + (r.add ?? 0), 0);
  const touchedRem = touched.rows.reduce((s, r) => s + (r.rem ?? 0), 0);
  const gitKnown = (worker.linesAdded ?? 0) > 0 || (worker.linesRemoved ?? 0) > 0;
  const added = gitKnown ? worker.linesAdded : touchedAdd || null;
  const removed = gitKnown ? worker.linesRemoved : touchedRem || null;
  const filesEdited = touched.rows.filter(r => r.kind !== 'run').length;
  const commands = touched.rows.filter(r => r.kind === 'run').length;
  const asker = `The ${(roleName || 'agent').toLowerCase()} asks`;

  const activity = (
    <WorkerActivityTimeline
      milestones={milestones}
      currentAction={isActive ? worker.currentAction : undefined}
      startedAt={worker.startedAt}
      nowMs={nowMs}
      live={isActive && !worker.waitingFor}
    />
  );

  // Waiting for input — render whenever waitingFor is set, even if the worker
  // was marked failed/error (inputAsRetry mode aborts the session after
  // AskUserQuestion, leaving waitingFor populated). The question is the hero;
  // everything else about the run folds away beneath it.
  if (worker.waitingFor) {
    const question = unifyWorkerQuestion(worker.waitingFor, questionNote);
    const askedTs = questionNote?.createdAt ? new Date(questionNote.createdAt).getTime() : now.updatedTs;
    return (
      <div data-testid="worker-view" data-state="waiting" className="space-y-5">
        <div data-testid="worker-needs-input-banner">
          <QuestionHero
            testId="worker-question-hero"
            question={question}
            askerLabel={asker}
            askedAgo={askedTs != null ? `${ageLabel(nowMs - askedTs)} ago` : null}
            stateNote="paused"
            onAnswer={handleAnswer}
            sending={answerSending}
            enableKeys
            error={answerError && (
              <>
                {answerError.message}
                {answerError.credentialRevoked && ' Your answer is saved. Reconnect the credential, then retry.'}
              </>
            )}
            sent={answerSent ? (
              <>
                {answerOutcome ?? 'Answer sent.'}
                {continuationTaskId && (
                  <>
                    {' '}<a href={`/app/tasks/${continuationTaskId}`} className="underline hover:no-underline">View continuation task →</a>
                  </>
                )}
              </>
            ) : null}
          />
        </div>

        <PausedBar pct={now.pct} elapsed={elapsed} turns={worker.turns} tokens={formatTokens(tokens)} />

        <div data-testid="worker-paused-context" className="border-t border-border-default">
          {now.headline && now.headline !== question.headline && (
            <ContextRow label="Why it stopped" summary={collapseWorkspacePath(now.headline)} meta={now.pct != null ? `${now.pct}%` : null} />
          )}
          <ContextRow
            label="Activity"
            summary={[
              `${countToolCalls(milestones)} tool calls`,
              filesEdited > 0 && `${filesEdited} file${filesEdited === 1 ? '' : 's'} edited`,
              commands > 0 && `${commands} command${commands === 1 ? '' : 's'}`,
            ].filter(Boolean).join(' · ')}
            meta={added || removed ? `+${added ?? 0} −${removed ?? 0}` : null}
          >
            {activity}
          </ContextRow>
        </div>
      </div>
    );
  }

  return (
    <div data-testid="worker-view" data-state="running">
      {isActive ? (
        <NowStrip now={now} nowMs={nowMs} />
      ) : (
        worker.currentAction && (
          <p data-testid="worker-current-action" className="text-sm text-text-secondary truncate">{collapseWorkspacePath(worker.currentAction)}</p>
        )
      )}

      {/* Subagent progress indicator — nested by parentAgentId into an agent tree */}
      {taskProgress.length > 0 && isActive && (
        <div className="mt-4 p-3 bg-surface-2 border border-border-default">
          <div className="section-label mb-1.5">Background agents</div>
          <div className="space-y-1">
            {flattenAgentTree(buildAgentTree(taskProgress)).map((tp) => (
              <div key={tp.taskId} className="flex items-center justify-between font-mono text-[11px]">
                <div
                  className="flex items-center gap-2 min-w-0"
                  style={{ paddingLeft: tp.depth > 0 ? `${tp.depth * 14}px` : undefined }}
                >
                  {tp.depth > 0 && <span className="text-text-muted select-none" aria-hidden>└</span>}
                  <span className="w-1.5 h-1.5 bg-status-running animate-status-pulse shrink-0" />
                  <span className="text-text-secondary truncate">{tp.agentName || tp.taskId.slice(0, 8)}</span>
                </div>
                <div className="flex items-center gap-3 text-text-muted shrink-0">
                  <span>{tp.toolCount} tool{tp.toolCount !== 1 ? 's' : ''}</span>
                  <span>{Math.round(tp.durationMs / 1000)}s</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <StatRow
        elapsed={elapsed}
        turns={worker.turns}
        tokens={tokens}
        pr={worker.prUrl ? { url: worker.prUrl, number: worker.prNumber, lifecycle: worker.prLifecycleStatus ?? null } : null}
        filesTouched={Math.max(filesEdited, worker.filesChanged ?? 0)}
        added={added}
        removed={removed}
      />

      {activity}

      {/* Model usage — collapsible, the run's accounting rather than its story */}
      {worker.resultMeta?.modelUsage && Object.keys(worker.resultMeta.modelUsage).length > 0 && (
        <div className="mt-4">
          <button
            onClick={() => setShowMetricsDetail(!showMetricsDetail)}
            className="flex items-center gap-1.5 min-h-11 md:min-h-0 font-mono text-[11px] uppercase tracking-[2px] text-text-muted hover:text-text-secondary"
          >
            <span className={`transition-transform ${showMetricsDetail ? 'rotate-90' : ''}`} aria-hidden="true">▸</span>
            Model usage
          </button>
          {showMetricsDetail && (
            <ModelUsagePanel
              modelUsage={worker.resultMeta?.modelUsage}
              tierLabel={modelTier}
              durationMs={worker.resultMeta?.durationMs}
              durationApiMs={worker.resultMeta?.durationApiMs}
              terminalReason={worker.resultMeta?.terminalReason}
              stopReason={worker.resultMeta?.stopReason}
            />
          )}
        </div>
      )}
    </div>
  );
}

function ContextRow({ label, summary, meta, children }: { label: string; summary: string; meta?: string | null; children?: React.ReactNode }) {
  const body = (
    <>
      <span className="w-4 shrink-0 text-text-muted group-open:rotate-90 transition-transform" aria-hidden="true">{children ? '▸' : ''}</span>
      <span className="w-24 md:w-36 shrink-0 font-mono text-[11px] uppercase tracking-[1.5px] md:tracking-[2px] text-text-muted">{label}</span>
      <span className="flex-1 min-w-0 truncate text-[13px] md:text-[14px] text-text-primary">{summary}</span>
      {meta && <span className="shrink-0 font-mono text-[12px] text-text-muted tabular-nums">{meta}</span>}
    </>
  );
  if (!children) {
    return <div className="flex items-center gap-2 min-h-12 border-b border-border-default">{body}</div>;
  }
  return (
    <details className="group border-b border-border-default">
      <summary className="flex items-center gap-2 min-h-12 cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden">{body}</summary>
      <div className="pb-4">{children}</div>
    </details>
  );
}
