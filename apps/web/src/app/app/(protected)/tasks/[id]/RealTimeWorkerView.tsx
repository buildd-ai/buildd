'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { subscribeToChannel, unsubscribeFromChannel, CHANNEL_PREFIX } from '@/lib/pusher-client';
import Spinner from '@/components/Spinner';
import WorkerActivityTimeline, { collapseWorkspacePath } from './WorkerActivityTimeline';
import InstructionHistory from './InstructionHistory';
import InstructWorkerForm from './InstructWorkerForm';
import ModelUsagePanel from './ModelUsagePanel';
import NeedsInputAnswerBox from './NeedsInputAnswerBox';
import StatusBadge from '@/components/StatusBadge';
import { buildAgentTree, flattenAgentTree, type AgentProgressEntry } from '@/lib/agent-tree';
import { requestRefresh, flushRefresh } from './coalesced-refresh';
import { useDisplayTimezone } from '@/components/DisplayTimezone';
import { formatInZone } from '@/lib/zoned-time';
import { formatElapsed } from './format-elapsed';

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


type Milestone =
  | { type: 'phase'; label: string; toolCount: number; ts: number; pending?: boolean }
  | { type: 'status'; label: string; progress?: number; ts: number }
  | { type: 'checkpoint'; event: string; label: string; ts: number }
  | { type: 'action'; label: string; ts: number };

interface Worker {
  id: string;
  name: string;
  branch: string;
  status: string;
  currentAction: string | null;
  milestones: Milestone[];
  turns: number;
  costUsd: string | null;
  inputTokens: number;
  outputTokens: number;
  startedAt: string | null;
  prUrl: string | null;
  prNumber: number | null;
  localUiUrl: string | null;
  commitCount: number | null;
  filesChanged: number | null;
  linesAdded: number | null;
  linesRemoved: number | null;
  lastCommitSha: string | null;
  waitingFor: { type: string; prompt: string; options?: (string | { label: string; description?: string; recommended?: boolean })[] } | null;
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
}


// Entries carry optional agentId/parentAgentId (SDK v0.3.202+) so nested agent
// trees can be reconstructed; see @/lib/agent-tree.
type TaskProgressEntry = AgentProgressEntry;

export default function RealTimeWorkerView({ initialWorker, taskId, statusColors, modelTier }: Props) {
  const displayTz = useDisplayTimezone();
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
  const [showAbortConfirm, setShowAbortConfirm] = useState(false);
  const [abortLoading, setAbortLoading] = useState(false);
  const [abortError, setAbortError] = useState<string | null>(null);
  const [interruptMode, setInterruptMode] = useState(false);
  const [interruptError, setInterruptError] = useState<string | null>(null);
  const [showMetricsDetail, setShowMetricsDetail] = useState(false);
  const [currentActionExpanded, setCurrentActionExpanded] = useState(false);
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

  // Send the answer via the respond endpoint, which decides between resuming
  // this worker's own parked session and starting a cold continuation — and
  // says which it did. The runner aborts the session when a question is asked,
  // but the transcript and the worktree survive, so a resume is possible
  // whenever the runner holding them is still reporting. See
  // docs/specs/answered-question-resume.md. The response's `message` is the
  // owner-facing sentence for whichever path ran.
  async function handleAnswer(option: string) {
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
  }

  async function handleAbort() {
    setAbortLoading(true);
    setAbortError(null);
    try {
      const res = await fetch(`/api/workers/${worker.id}/cmd`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'abort' }),
      });
      if (!res.ok) {
        throw new Error(await parseErrorMessage(res, 'Failed to abort'));
      }
      setShowAbortConfirm(false);
      router.refresh();
    } catch (err) {
      setAbortError(err instanceof Error ? err.message : 'Failed to abort worker');
    } finally {
      setAbortLoading(false);
    }
  }

  async function handleInterruptSend(message: string) {
    setInterruptError(null);
    try {
      const res = await fetch(`/api/workers/${worker.id}/instruct`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, priority: 'urgent' }),
      });
      if (!res.ok) {
        throw new Error(await parseErrorMessage(res, 'Failed to send interrupt'));
      }
      setInterruptMode(false);
    } catch (err) {
      setInterruptError(err instanceof Error ? err.message : 'Failed to send interrupt');
    }
  }

  const isActive = ['running', 'starting', 'waiting_input'].includes(worker.status);
  // Instructing while a question is unanswered is the wrong tool — /instruct
  // queues an instruction for a running session; the answer path is /respond.
  const hasUnansweredQuestion = !!worker.waitingFor && !answerSent;

  return (
    <div className="border border-border-default bg-surface-2 rounded-md p-4">
      <div className="mb-3">
        <div className="flex items-center justify-between gap-2 mb-0.5">
          <h3 className="font-medium text-lg truncate">{worker.name}</h3>
          <StatusBadge status={worker.status} />
        </div>
        <p className="text-sm text-text-secondary font-mono truncate">Branch: {worker.branch}</p>
        {isActive && worker.status !== 'starting' && (
          <div className="flex items-center gap-1.5 mt-2 flex-wrap">
            <button
              data-testid="worker-interrupt-btn"
              onClick={() => setInterruptMode(!interruptMode)}
              className="min-h-11 md:min-h-0 px-3 md:px-2.5 py-1.5 text-[11px] font-medium border border-status-warning/30 text-status-warning rounded hover:bg-status-warning/10 transition-colors"
              title="Send an urgent message to interrupt the agent"
            >
              Interrupt
            </button>
            {showAbortConfirm ? (
              <>
                <button
                  onClick={handleAbort}
                  disabled={abortLoading}
                  className="min-h-11 md:min-h-0 px-3 md:px-2.5 py-1.5 text-[11px] font-medium bg-status-error text-white rounded hover:opacity-90 disabled:opacity-50"
                >
                  {abortLoading ? '...' : 'Confirm abort'}
                </button>
                <button
                  onClick={() => setShowAbortConfirm(false)}
                  className="min-h-11 md:min-h-0 px-3 md:px-2 py-1.5 text-[11px] text-text-muted hover:text-text-primary"
                >
                  Cancel
                </button>
              </>
            ) : (
              <button
                data-testid="worker-abort-btn"
                onClick={() => setShowAbortConfirm(true)}
                className="min-h-11 md:min-h-0 px-3 md:px-2.5 py-1.5 text-[11px] font-medium border border-status-error/30 text-status-error rounded hover:bg-status-error/10 transition-colors"
                title="Stop the worker immediately"
              >
                Abort
              </button>
            )}
          </div>
        )}
        {abortError && (
          <p data-testid="worker-abort-error" className="mt-2 text-sm text-status-error">
            {abortError}
          </p>
        )}
      </div>

      {/* Current action */}
      {worker.currentAction && (
        <div
          className="mb-3 flex items-center gap-2 min-w-0 cursor-pointer"
          onClick={() => setCurrentActionExpanded(!currentActionExpanded)}
        >
          <Spinner size="xs" className="text-status-running flex-shrink-0" aria-label="Working" />
          <p
            className={`text-sm text-text-secondary ${currentActionExpanded ? 'break-words' : 'truncate'}`}
            title={worker.currentAction}
          >
            {collapseWorkspacePath(worker.currentAction)}
          </p>
        </div>
      )}

      {/* Subagent progress indicator — nested by parentAgentId into an agent tree */}
      {taskProgress.length > 0 && isActive && (
        <div className="mb-3 p-2.5 bg-surface-3 rounded-md border border-border-default/50">
          <div className="font-mono text-[11px] md:text-[10px] uppercase tracking-[1.5px] text-text-muted mb-1.5">Background Agents</div>
          <div className="space-y-1">
            {flattenAgentTree(buildAgentTree(taskProgress)).map((tp) => (
              <div key={tp.taskId} className="flex items-center justify-between font-mono text-[11px]">
                <div
                  className="flex items-center gap-2 min-w-0"
                  style={{ paddingLeft: tp.depth > 0 ? `${tp.depth * 14}px` : undefined }}
                >
                  {tp.depth > 0 && <span className="text-text-muted select-none" aria-hidden>└</span>}
                  <span className="w-1.5 h-1.5 rounded-full bg-status-running animate-pulse shrink-0" />
                  <span className="text-text-secondary truncate">{tp.agentName || tp.taskId.slice(0, 8)}</span>
                </div>
                <div className="flex items-center gap-3 text-text-muted shrink-0">
                  <span>{tp.toolCount} tool{tp.toolCount !== 1 ? 's' : ''}</span>
                  <span>{Math.round(tp.durationMs / 1000)}s</span>
                  {tp.cumulativeUsage?.costUsd != null && tp.cumulativeUsage.costUsd > 0 && (
                    <span>${tp.cumulativeUsage.costUsd.toFixed(4)}</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Interrupt input form */}
      {interruptMode && (
        <div className="mb-3 border border-status-warning/30 bg-status-warning/5 rounded-md p-3">
          <div className="flex items-center gap-2 mb-2">
            <span className="font-mono text-[11px] md:text-[10px] font-medium text-status-warning uppercase tracking-[2.5px]">Interrupt</span>
            <span className="text-[11px] md:text-[10px] text-text-muted">Sent over Pusher, then confirmed by the runner</span>
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const form = e.target as HTMLFormElement;
              const input = form.elements.namedItem('interruptMsg') as HTMLInputElement;
              if (input.value.trim()) handleInterruptSend(input.value.trim());
            }}
            className="flex flex-col sm:flex-row gap-2"
          >
            <input
              name="interruptMsg"
              type="text"
              autoFocus
              placeholder="e.g., Stop what you're doing and focus on..."
              className="flex-1 px-3 py-2 text-base md:text-sm border border-border-default rounded-md bg-surface-1 focus:ring-2 focus:ring-status-warning/50 focus:border-status-warning"
            />
            <div className="flex gap-2">
              <button
                type="submit"
                className="flex-1 sm:flex-none px-4 py-2 text-sm bg-status-warning text-white rounded-md hover:opacity-90"
              >
                Send
              </button>
              <button
                type="button"
                onClick={() => setInterruptMode(false)}
                className="px-3 py-2 text-sm text-text-muted hover:text-text-primary"
              >
                Cancel
              </button>
            </div>
          </form>
          {interruptError && (
            <p data-testid="worker-interrupt-error" className="mt-2 text-sm text-status-error">
              {interruptError}
            </p>
          )}
        </div>
      )}

      {/* Waiting for input banner — render whenever waitingFor is set, even
          if the worker was marked failed/error (inputAsRetry mode aborts the
          session after AskUserQuestion, leaving waitingFor populated). The
          inner answerSent branch renders a success message until the server
          clears waitingFor on the next poll. */}
      {worker.waitingFor && (
        <div
          data-testid="worker-needs-input-banner"
          className="mb-3 border border-status-warning/30 bg-status-warning/5 rounded-md p-3"
        >
          <div className="flex items-center gap-2 mb-2">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-status-warning opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-status-warning" />
            </span>
            <span data-testid="worker-needs-input-label" className="font-mono text-[11px] md:text-[10px] font-medium text-status-warning uppercase tracking-[2.5px]">Needs input</span>
          </div>
          <p data-testid="worker-needs-input-prompt" className="text-sm text-text-primary [overflow-wrap:anywhere]">{worker.waitingFor.prompt}</p>
          {answerError && (
            <p data-testid="worker-answer-error" className="mt-2 text-sm text-status-error">
              {answerError.message}
              {answerError.credentialRevoked && ' Your answer was not lost — retry once the credential is reconnected.'}
            </p>
          )}
          {answerSent ? (
            <p data-testid="worker-answer-sent" className="mt-2 text-sm text-status-success">
              {answerOutcome ?? 'Answer sent.'}
              {continuationTaskId && (
                <>
                  {' '}<a href={`/app/tasks/${continuationTaskId}`} className="underline hover:no-underline">View continuation task →</a>
                </>
              )}
            </p>
          ) : (
            <div className="flex flex-col gap-2 mt-3">
              {worker.waitingFor.options && worker.waitingFor.options.length > 0 && (
                <div data-testid="worker-needs-input-options" className="flex flex-col gap-2">
                  {worker.waitingFor.options.map((opt, i) => {
                    const label = typeof opt === 'string' ? opt : opt.label;
                    const description = typeof opt === 'string' ? undefined : opt.description;
                    const recommended = typeof opt === 'string' ? false : opt.recommended;
                    return (
                      <button
                        key={i}
                        onClick={() => handleAnswer(label)}
                        disabled={answerSending !== null}
                        className="text-left px-3 py-2 text-sm bg-surface-3 text-text-primary rounded border border-border-default hover:bg-surface-4 hover:border-text-muted transition-colors disabled:opacity-50 cursor-pointer"
                      >
                        <span className="flex items-center gap-2 min-w-0">
                          <span className="font-medium min-w-0 [overflow-wrap:anywhere]">{answerSending === label ? 'Sending…' : label}</span>
                          {recommended && (
                            <span className="text-[11px] md:text-[10px] font-mono uppercase tracking-wider text-status-success bg-status-success/10 px-1.5 py-0.5 rounded">Recommended</span>
                          )}
                        </span>
                        {description && (
                          <span className="block mt-0.5 text-xs text-text-muted [overflow-wrap:anywhere]">{description}</span>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
              {/* Always available — the only way to answer an open-ended
                  question (no options), and an escape hatch alongside them. */}
              <NeedsInputAnswerBox onSubmit={handleAnswer} sending={answerSending !== null} />
            </div>
          )}
        </div>
      )}


      {/* Activity Timeline */}
      <WorkerActivityTimeline
        milestones={worker.milestones || []}
        currentAction={isActive ? worker.currentAction : undefined}
      />


      {/* Stats row */}
      <div className="flex items-center gap-3 mt-3 font-mono text-xs text-text-muted flex-wrap">
        <span>Turns: {worker.turns}</span>
        {worker.account?.authType === 'oauth'
          ? ((worker.inputTokens || 0) + (worker.outputTokens || 0)) > 0 && (
              <span>
                {((worker.inputTokens || 0) + (worker.outputTokens || 0)).toLocaleString()} tokens
              </span>
            )
          : parseFloat(worker.costUsd || '0') > 0 && (
              <span>Cost: ${parseFloat(worker.costUsd || '0').toFixed(4)}</span>
            )
        }
        {worker.startedAt && (
          <span title={displayTz ? `Started: ${formatInZone(worker.startedAt, displayTz)}` : undefined}>
            {formatElapsed(Date.now() - new Date(worker.startedAt).getTime())} elapsed
          </span>
        )}
        {worker.prUrl && (
          <a
            href={worker.prUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-status-success hover:underline"
          >
            PR #{worker.prNumber}
          </a>
        )}
      </div>

      {/* Git stats & model usage — always visible on desktop, collapsible on mobile */}
      {(((worker.commitCount ?? 0) > 0 || (worker.filesChanged ?? 0) > 0) ||
        (worker.resultMeta?.modelUsage && Object.keys(worker.resultMeta.modelUsage).length > 0)) && (
        <>
          {/* Mobile: collapsible toggle */}
          <button
            onClick={() => setShowMetricsDetail(!showMetricsDetail)}
            className="md:hidden flex items-center gap-1.5 mt-1 min-h-11 text-xs text-text-muted hover:text-text-secondary transition-colors"
          >
            <svg
              className={`w-3 h-3 transition-transform ${showMetricsDetail ? 'rotate-90' : ''}`}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
            Details
          </button>

          <div className={`${showMetricsDetail ? '' : 'hidden'} md:block`}>
            {/* Git stats */}
            {((worker.commitCount ?? 0) > 0 || (worker.filesChanged ?? 0) > 0) && (
              <div className="flex items-center gap-4 mt-2 font-mono text-xs">
                {(worker.commitCount ?? 0) > 0 && (
                  <span className="text-text-muted">
                    {worker.commitCount} commit{worker.commitCount !== 1 ? 's' : ''}
                  </span>
                )}
                {(worker.filesChanged ?? 0) > 0 && (
                  <span className="text-text-muted">
                    {worker.filesChanged} file{worker.filesChanged !== 1 ? 's' : ''}
                  </span>
                )}
                {((worker.linesAdded ?? 0) > 0 || (worker.linesRemoved ?? 0) > 0) && (
                  <span>
                    <span className="text-status-success">+{worker.linesAdded ?? 0}</span>
                    {' / '}
                    <span className="text-status-error">-{worker.linesRemoved ?? 0}</span>
                  </span>
                )}
                {worker.lastCommitSha && (
                  <span className="text-text-muted">
                    {worker.lastCommitSha.slice(0, 7)}
                  </span>
                )}
              </div>
            )}

            <ModelUsagePanel
              modelUsage={worker.resultMeta?.modelUsage}
              tierLabel={modelTier}
              durationMs={worker.resultMeta?.durationMs}
              durationApiMs={worker.resultMeta?.durationApiMs}
              terminalReason={worker.resultMeta?.terminalReason}
              stopReason={worker.resultMeta?.stopReason}
            />
          </div>
        </>
      )}

      {/* Instruction history and input — hidden while a question is
          unanswered, since /instruct is the wrong path for an answer. */}
      {isActive && !hasUnansweredQuestion && (
        <>
          <InstructionHistory
            history={worker.instructionHistory || []}
          />
          <InstructWorkerForm
            workerId={worker.id}
            pendingInstructions={null}
          />
        </>
      )}
    </div>
  );
}
